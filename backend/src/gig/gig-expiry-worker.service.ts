import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { GigService } from './gig.service';
import { DEFAULT_GIG_EXPIRY_SWEEP_INTERVAL_MS } from './gig.entity';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { mapWithConcurrency, countRejected } from '../common/concurrency';
import { config } from '../config/env.config';
import { MetricsService } from '../monitoring/metrics.service';
import { SentryService } from '../sentry/sentry.service';

const LOCK_KEY = 'lock:gig-expiry-sweep';
const LOCK_RENEWAL_INTERVAL_MS = 10_000;

/**
 * Periodically sweeps the DB for open gig solicitations whose response deadline has
 * passed and marks them expired. GigService appends the corresponding durable
 * outbox row in the same state transaction; the outbox relay notifies subscribers.
 * This ensures stale solicitations don't sit open forever waiting for a response.
 *
 * Interval is configurable via GIG_EXPIRY_SWEEP_INTERVAL_MS (milliseconds); set to 0 or
 * negative to disable the background sweep entirely (e.g. in tests).
 *
 * Runs behind a Redis distributed lock (see `DistributedLockService`) so only one
 * instance's tick actually executes a sweep when multiple instances are deployed.
 * Lock is renewed periodically during long sweeps to prevent overlapping sweeps.
 * On lock loss or Redis failure, the sweep is aborted and recorded.
 *
 * Emits metrics for sweep duration, gigs expired, gigs failed, and skipped ticks.
 * Per-gig failures are logged with id and reason, and batch failures are captured to Sentry.
 * Max gigs per sweep is configurable via GIG_EXPIRY_SWEEP_MAX_GIGS to prevent monopolising a tick.
 */
@Injectable()
export class GigExpiryWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new SanitizedLogger(GigExpiryWorkerService.name);
  private timer?: NodeJS.Timeout;
  private currentLockToken?: string;
  private lockRenewalTimer?: NodeJS.Timeout;
  /** Guards against a slow sweep still running when the next tick fires (#236). */
  private sweeping = false;
  /** Tracks consecutive failed batches to apply rate limiting to logs. */
  private failedBatchCount = 0;

  constructor(
    private readonly gigService: GigService,
    private readonly lock: DistributedLockService,
    private readonly metrics: MetricsService,
    private readonly sentry: SentryService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.getIntervalMs();
    if (intervalMs <= 0) {
      this.logger.log('Gig expiry sweep disabled (GIG_EXPIRY_SWEEP_INTERVAL_MS <= 0)');
      return;
    }

    this.timer = setInterval(() => {
      this.tick(intervalMs).catch(error =>
        this.logger.error('Gig expiry sweep tick failed', error),
      );
    }, intervalMs);
    this.timer.unref?.();

    this.logger.log(`Gig expiry worker started — sweeping every ${intervalMs}ms`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.lockRenewalTimer) clearInterval(this.lockRenewalTimer);
    if (this.currentLockToken) {
      try {
        await this.lock.release(LOCK_KEY, this.currentLockToken);
      } catch (err) {
        this.logger.error('Failed to release lock on shutdown', err);
      }
      this.currentLockToken = undefined;
    }
  }

  private async tick(intervalMs: number): Promise<void> {
    if (this.sweeping) {
      this.metrics.increment('gig_expiry_sweep_skipped_total');
      this.logger.debug('Previous gig expiry sweep still in flight — skipping this tick');
      return;
    }

    const token = await this.lock.tryAcquire(LOCK_KEY, Math.ceil(intervalMs * 1.5));
    if (!token) {
      this.logger.debug('Another instance holds the gig expiry sweep lock');
      return;
    }

    this.currentLockToken = token;
    this.sweeping = true;

    // Set up lock renewal timer: renew the lock every LOCK_RENEWAL_INTERVAL_MS
    // so if a sweep runs longer than the original TTL, we maintain ownership.
    this.lockRenewalTimer = setInterval(async () => {
      if (!this.currentLockToken) {
        if (this.lockRenewalTimer) clearInterval(this.lockRenewalTimer);
        return;
      }
      try {
        const renewed = await this.lock.renewIfOwned(
          LOCK_KEY,
          this.currentLockToken,
          Math.ceil(intervalMs * 1.5),
        );
        if (!renewed) {
          this.logger.warn('Lost lock ownership during gig expiry sweep — aborting');
          this.currentLockToken = undefined;
        }
      } catch (err) {
        this.logger.error('Error renewing gig expiry sweep lock', err);
      }
    }, LOCK_RENEWAL_INTERVAL_MS);

    try {
      await this.runOnce();
    } finally {
      if (this.lockRenewalTimer) clearInterval(this.lockRenewalTimer);
      this.lockRenewalTimer = undefined;
      this.sweeping = false;
      if (this.currentLockToken) {
        try {
          await this.lock.release(LOCK_KEY, this.currentLockToken);
        } catch (err) {
          this.logger.error('Failed to release gig expiry sweep lock', err);
        }
        this.currentLockToken = undefined;
      }
    }
  }

  /**
   * Runs a single sweep, capping the number of gigs if configured.
   * Exposed so it can be triggered manually (e.g. from tests or an admin endpoint).
   */
  async runOnce(): Promise<void> {
    const startMs = Date.now();
    let expirable = await this.gigService.findExpirable();

    // Apply the max gigs per sweep cap if configured (#790)
    const maxGigs = this.getMaxGigsPerSweep();
    if (maxGigs !== undefined && expirable.length > maxGigs) {
      this.logger.debug(
        `Capping gig expiry sweep to ${maxGigs} gigs (${expirable.length} expirable)`,
      );
      expirable = expirable.slice(0, maxGigs);
    }

    // Expire gigs with bounded concurrency instead of one-at-a-time: each
    // `expire()` appends an outbox row the relay then delivers with retries,
    // so a fully sequential loop over a big batch serialised all of that
    // latency and could outrun the sweep interval (#236). A failed `expire`
    // no longer aborts the rest of the sweep — it is counted and logged.
    const concurrency = this.getSweepConcurrency();
    const results = await mapWithConcurrency(expirable, concurrency, gig =>
      this.gigService.expire(gig.id),
    );
    const failed = countRejected(results);
    const succeeded = expirable.length - failed;

    const durationMs = Date.now() - startMs;
    this.metrics.increment('gig_expiry_sweep_duration_ms', { status: 'success' });
    this.metrics.increment('gig_expiry_sweep_gigs_expired_total', {}, succeeded);
    this.metrics.increment('gig_expiry_sweep_gigs_failed_total', {}, failed);

    if (failed > 0) {
      this.logger.warn(`Gig expiry sweep: ${failed}/${expirable.length} gigs failed to expire`);
      // Capture per-gig failures to Sentry for diagnosis
      const failedGigs = results
        .map((r, i) => ({ result: r, gig: expirable[i] }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ result, gig }) => ({
          id: gig.id,
          error: (result as PromiseRejectedResult).reason?.message ?? String((result as PromiseRejectedResult).reason),
        }));
      const batchError = new Error(
        `Gig expiry sweep: ${failed} gigs failed`,
      ) as Error & { failedGigs?: Array<{ id: string; error: string }> };
      batchError.failedGigs = failedGigs;
      this.sentry.captureException(batchError, GigExpiryWorkerService.name);
      this.failedBatchCount++;
    } else {
      this.failedBatchCount = 0;
    }

    this.logger.log(
      `Gig expiry sweep completed in ${durationMs}ms — ${succeeded} expired, ${failed} failed`,
    );
  }

  private getSweepConcurrency(): number {
    return config.GIG_EXPIRY_SWEEP_CONCURRENCY || 8;
  }

  private getMaxGigsPerSweep(): number | undefined {
    return config.GIG_EXPIRY_SWEEP_MAX_GIGS;
  }

  private getIntervalMs(): number {
    return config.GIG_EXPIRY_SWEEP_INTERVAL_MS ?? DEFAULT_GIG_EXPIRY_SWEEP_INTERVAL_MS;
  }
}
