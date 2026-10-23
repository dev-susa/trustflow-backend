import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { CircuitBreakerService } from '../common/circuit-breaker';
import { MetricsService } from '../monitoring/metrics.service';
import { ProviderHealthService } from './provider-health.service';
import { config } from '../config/env.config';
import { computeCidV1Raw } from './cid.util';
import { PinContentDto } from './ipfs-pinning.dto';
import {
  DEFAULT_REPLICATION_FACTOR,
  IPFS_EVENTS,
  PinRecord,
  PinStatus,
  ProviderPinRecord,
  ProviderPinStatus,
} from './ipfs-pinning.types';
import {
  IpfsPinProvider,
  PIN_PROVIDERS,
  PinProviderName,
} from './providers/ipfs-provider.interface';
import { WebhookService } from '../webhook/webhook.service';

const PIN_KEY_PREFIX = 'pin:';
const PINS_INDEX_KEY = 'pins:index';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const IPFS_PINNING_PERSISTENCE_FALLBACK_METRIC = 'ipfs_pinning_persistence_fallback_total';

/** Emitted every time a provider fails to release a pin during `unpin()`. */
export const IPFS_UNPIN_FAILURE_METRIC = 'ipfs_unpin_failure_total';

/**
 * Sequential provider priority order: Pinata → Infura → Web3.Storage.
 * Order matches PinProviderName enum values: 'pinata', 'infura', 'web3.storage'.
 * Providers are tried in this exact order until replicationFactor successes are achieved.
 */
export const PIN_PROVIDER_PRIORITY = ['pinata', 'infura', 'web3.storage'] as const;

/**
 * Pin registry. Backed by Redis so pin metadata survives restarts and is shared across
 * instances — see PERSISTENT_STORAGE_SPIKE.md and its "Follow-up decisions" addendum (#189).
 *
 * Decision: enforce strict sequential failover across providers. After a successful
 * pin to the first provider, a background job cross-pins to remaining providers
 * for redundancy. Falls back to a process-local Map for pin metadata when Redis is
 * unavailable, logged at `error` level and counted via `IPFS_PINNING_PERSISTENCE_FALLBACK_METRIC`.
 */
 @Injectable()
export class IpfsPinningService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(IpfsPinningService.name);

  /** Fallback pin-record store, only used while Redis is unavailable. */
  private readonly pins = new Map<string, PinRecord>();

  constructor(
    @Inject(PIN_PROVIDERS) private readonly providers: IpfsPinProvider[],
    private readonly webhookService: WebhookService,
    private readonly circuitBreakerService: CircuitBreakerService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly providerHealth?: ProviderHealthService,
  ) {
    if (this.providers.length === 0) {
      throw new Error('IpfsPinningService requires at least one registered pin provider');
    }
  }

  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'IpfsPinningService requires REDIS_URL to be configured in production — refusing to ' +
          'start with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }

    // Guard against production deployments with unconfigured providers running in simulated mode (#409).
    // This prevents POST /ipfs/pins from returning 201 with HEALTHY status while nothing is actually pinned.
    if (process.env.NODE_ENV === 'production') {
      const simulatedProviders = this.providers.filter(p => !p.isConfigured).map(p => p.name);
      if (simulatedProviders.length > 0) {
        throw new Error(
          `IpfsPinningService: providers running in simulated mode in production: ${simulatedProviders.join(', ')}. ` +
            'Set the required credentials (IPFS_PINATA_JWT, IPFS_WEB3_STORAGE_TOKEN, IPFS_INFURA_*) before deploying.',
        );
      }
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────

  async findAll(): Promise<PinRecord[]> {
    if (this.redis) {
      try {
        const cids = await this.redis.smembers(PINS_INDEX_KEY);
        if (cids.length === 0) return [];
        const raw = await this.redis.mget(...cids.map(cid => this.pinKey(cid)));
        return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as PinRecord);
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }

    return [...this.pins.values()];
  }

  async findByCid(cid: string): Promise<PinRecord> {
    const record = await this.tryFindByCid(cid);
    if (!record) throw new NotFoundException(`Pin record for CID ${cid} not found`);
    return record;
  }

  // ─── Pinning ──────────────────────────────────────────────────────

  /**
   * Computes the content hash, verifies it against `expectedCid` (if supplied), then pins
   * across providers sequentially in priority order (Pinata → Infura → Web3.Storage) until
   * `replicationFactor` providers succeed. After a successful pin, dispatches a background
   * job to cross-pin to remaining providers for redundancy.
   *
   * The upload itself blocks until enough providers have confirmed, but the cross-pinning
   * is fire-and-forge and does not delay the response.
   */
  async pinContent(dto: PinContentDto): Promise<PinRecord> {
    const buffer = Buffer.from(dto.content, 'base64');

    // Explicit size guard (belt-and-suspenders alongside the DTO @MaxLength check and
    // the Express body-size limit configured in main.ts).
    const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
    if (buffer.length > MAX_BYTES) {
      throw new BadRequestException(
        `Decoded content size (${buffer.length} bytes) exceeds the maximum allowed size of 10 MB`,
      );
    }

    const cid = computeCidV1Raw(buffer);

    if (dto.expectedCid && dto.expectedCid !== cid) {
      throw new BadRequestException(
        `Content hash mismatch: expected ${dto.expectedCid}, computed ${cid} from the supplied bytes`,
      );
    }

    const replicationFactor = Math.min(
      dto.replicationFactor ?? DEFAULT_REPLICATION_FACTOR,
      this.providers.length,
    );

    const existing = await this.tryFindByCid(cid);
    const isNew = !existing;
    const now = new Date().toISOString();
    const record: PinRecord = existing ?? {
      cid,
      size: buffer.length,
      filename: dto.filename,
      replicationFactor,
      status: PinStatus.FAILED,
      providers: [],
      createdAt: now,
      updatedAt: now,
    };
    // A fresh pin request supersedes a half-finished unpin; let replicate() recompute the status.
    if (record.status === PinStatus.UNPINNING) record.status = PinStatus.FAILED;
    record.replicationFactor = Math.max(record.replicationFactor, replicationFactor);
    await this.persist(record);

    // Sequential failover: try providers in priority order until we have enough successes
    const successfulProviders: PinProviderName[] = [];
    const failedProviders: { name: PinProviderName; error: string }[] = [];

    // Get the ordered list of provider names from PIN_PROVIDER_PRIORITY
    const providerNameOrder = PIN_PROVIDER_PRIORITY.filter(name => {
      return this.providers.some(p => p.name === name);
    });

    for (const providerName of providerNameOrder as PinProviderName[]) {
      const provider = this.providers.find(p => p.name === providerName);
      if (!provider) continue;

      // Health latency is the real time this provider took, success or failure (#801).
      const startedAt = Date.now();
      try {
        // Execute pin with circuit breaker
        const entry = this.upsertProviderEntry(record, providerName);
        entry.attempts += 1;

        const pinResult = await this.circuitBreakerService.execute(
          `ipfs-pin-${providerName}`,
          async () => provider.pin(record.cid, buffer),
          {
            name: `ipfs-pin-${providerName}`,
            timeout: 60000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
          },
        );

        // Verify the pin was successful
        const verified = await this.circuitBreakerService.execute(
          `ipfs-verify-${providerName}`,
          async () => provider.verify(record.cid),
          {
            name: `ipfs-verify-${providerName}`,
            timeout: 30000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
          },
        );

        if (!verified) throw new Error('Provider did not confirm the pin after upload');

        entry.status = ProviderPinStatus.PINNED;
        entry.pinnedAt = new Date().toISOString();
        entry.lastVerifiedAt = entry.pinnedAt;
        entry.lastError = undefined;
        successfulProviders.push(providerName);

        // Record health success
        if (this.providerHealth) {
          await this.providerHealth.recordPinSuccess(providerName, Date.now() - startedAt);
        }

        // Check if we've reached the replication factor
        if (successfulProviders.length >= replicationFactor) {
          break;
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        failedProviders.push({ name: providerName, error: errMsg });

        // Record health failure
        if (this.providerHealth) {
          await this.providerHealth.recordPinFailure(
            providerName,
            Date.now() - startedAt,
            error as Error,
          );
        }

        this.logger.warn(
          `Provider ${providerName} failed to pin ${record.cid}: ${errMsg} — failing over`,
        );

        // Continue to next provider in sequence
        continue;
      }
    }

    // Update record with successful providers
    record.providers = successfulProviders.map(name => {
      const entry = this.upsertProviderEntry(record, name);
      // Re-fetch the entry we just created
      const existingEntry = record.providers.find(e => e.provider === name);
      return existingEntry ?? { provider: name, status: ProviderPinStatus.PINNED, attempts: 1 };
    });

    // Finalize status based on how many providers succeeded
    this.finalizeStatus(record);

    await this.persist(record);

    // Fire-and-forge background cross-pinning to remaining providers
    // This does not block the response but ensures redundancy
    if (isNew && successfulProviders.length > 0 && successfulProviders.length < this.providers.length) {
      void this.crossPinRemainingProviders(record, buffer, successfulProviders);
    }

    if (isNew && this.countHealthy(record) > 0) {
      await this.webhookService.dispatch(IPFS_EVENTS.PIN_CREATED, {
        cid: record.cid,
        replicationFactor: record.replicationFactor,
        pinnedProviders: this.healthyProviders(record),
      });
    }

    return record;
  }

  /**
   * Fire-and-forge background cross-pinning to providers not yet attempted.
   * Dispatches a NestJS background pattern via async void to not block the response.
   */
  private async crossPinRemainingProviders(
    record: PinRecord,
    content: Buffer,
    alreadySuccessful: PinProviderName[],
  ): Promise<void> {
    const candidates = this.providers.filter(p => !alreadySuccessful.includes(p.name));

    if (candidates.length === 0) return;

    this.logger.log(`Starting background cross-pin to ${candidates.length} remaining providers for CID ${record.cid}`);

    for (const provider of candidates) {
      const startedAt = Date.now();
      try {
        await this.pinWithProvider(record, provider, content);
        // Record health success for the cross-pin
        if (this.providerHealth) {
          await this.providerHealth.recordPinSuccess(provider.name, Date.now() - startedAt);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Background cross-pin failed for provider ${provider.name}: ${errMsg}`,
        );
        // Record health failure for the cross-pin
        if (this.providerHealth) {
          await this.providerHealth.recordPinFailure(
            provider.name,
            Date.now() - startedAt,
            error as Error,
          );
        }
        // Non-fatal — cross-pin best-effort only
      }
    }

    // Re-finalize status after cross-pin attempts
    this.finalizeStatus(record);
    await this.persist(record);
  }

  /**
   * Re-verifies every provider currently believed to hold the pin, and — if the pin has
   * dropped below its replication factor — attempts to top it up via any remaining
   * providers. Used both for the on-demand verify endpoint and the re-pin worker sweep.
   */
  async reconcile(cid: string): Promise<PinRecord> {
    const record = await this.findByCid(cid);
    const before = this.countHealthy(record);
    let lostDuringThisPass = false;

    for (const entry of record.providers) {
      if (entry.status !== ProviderPinStatus.PINNED) continue;
      const provider = this.providers.find(p => p.name === entry.provider);
      if (!provider) continue;

      try {
        const stillPinned = await provider.verify(cid);
        if (!stillPinned) throw new Error('Provider reports the pin is no longer present');
        entry.lastVerifiedAt = new Date().toISOString();
      } catch (error) {
        entry.status = ProviderPinStatus.FAILED;
        entry.lastError = error instanceof Error ? error.message : String(error);
        lostDuringThisPass = true;
        this.logger.warn(`Pin ${cid} lost on provider ${entry.provider}: ${entry.lastError}`);
        await this.webhookService.dispatch(IPFS_EVENTS.PIN_LOST, { cid, provider: entry.provider });
      }
    }

    // Content is not retained after initial pin, so top-up replication is not possible
    // from reconcile(). When the healthy count falls below the replication factor, surface
    // this explicitly instead of silently re-persisting the same DEGRADED status.
    if (this.countHealthy(record) < record.replicationFactor) {
      this.finalizeStatus(record);
      record.updatedAt = new Date().toISOString();
      await this.persist(record);

      this.logger.warn(
        `Reconcile: ${cid} is below replication factor ` +
          `(${this.countHealthy(record)}/${record.replicationFactor} healthy) ` +
          `and original content is not retained — re-upload required to restore full replication.`,
      );

      await this.webhookService.dispatch(IPFS_EVENTS.PIN_DEGRADED, {
        cid,
        healthyProviders: this.countHealthy(record),
        replicationFactor: record.replicationFactor,
        reason: 'content-not-retained',
      });
    } else {
      this.finalizeStatus(record);
      await this.persist(record);
    }

    // Fires when this pass brought replication back up to full health — either by
    // topping up a pin that entered this call already degraded, or by recovering
    // from a loss detected during this same pass (net count unchanged but a
    // different provider now holds it).
    const after = this.countHealthy(record);
    if (after >= record.replicationFactor && (after > before || lostDuringThisPass)) {
      await this.webhookService.dispatch(IPFS_EVENTS.PIN_RESTORED, {
        cid,
        healthyProviders: after,
      });
    }

    return record;
  }

  /**
   * Unpins the CID from every provider currently holding it.
   *
   * A provider entry only becomes `UNPINNED` once its `unpin()` succeeded (or the provider
   * confirms the pin is already absent). If any provider fails, the record moves to
   * `UNPINNING`, the retained content is kept, `ipfs.pin.removed` is NOT dispatched and a
   * 502 carrying the per-provider results is thrown. Calling `unpin()` again retries only
   * the providers that still hold the pin; once all have released it the removal completes.
   */
  async unpin(cid: string): Promise<PinRecord> {
    const record = await this.findByCid(cid);
    if (record.status === PinStatus.UNPINNED) return record;

    await Promise.all(
      record.providers
        .filter(entry => entry.status === ProviderPinStatus.PINNED)
        .map(async entry => {
          try {
            await this.releasePin(cid, entry.provider);
            entry.status = ProviderPinStatus.UNPINNED;
            entry.lastError = undefined;
          } catch (error) {
            entry.lastError = error instanceof Error ? error.message : String(error);
            this.metrics?.increment(IPFS_UNPIN_FAILURE_METRIC, { provider: entry.provider });
            this.logger.warn(`Failed to unpin ${cid} from ${entry.provider}: ${entry.lastError}`);
          }
        }),
    );

    record.updatedAt = new Date().toISOString();

    const stillHolding = record.providers.filter(e => e.status === ProviderPinStatus.PINNED);
    if (stillHolding.length > 0) {
      record.status = PinStatus.UNPINNING;
      await this.persist(record);

      const failedProviders = stillHolding.map(entry => entry.provider);
      throw new BadGatewayException({
        statusCode: 502,
        message:
          `Failed to unpin ${cid} from ${failedProviders.join(', ')}; the pin is still held ` +
          'there. Retry DELETE to release the remaining provider(s).',
        error: 'Bad Gateway',
        cid,
        status: record.status,
        failedProviders,
        providers: record.providers,
      });
    }

    record.status = PinStatus.UNPINNED;
    await this.persist(record);

    await this.webhookService.dispatch(IPFS_EVENTS.PIN_REMOVED, { cid });
    return record;
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  /** Attempts to pin `content` to enough not-yet-healthy providers to reach the replication factor. */
  private async replicate(record: PinRecord, content?: Buffer): Promise<void> {
    if (!content) {
      const message =
        `Cannot retry replication for ${record.cid}: original content is no longer retained. ` +
        'The caller must re-upload the content to retry this pin.';
      record.status = PinStatus.DEGRADED;
      record.updatedAt = new Date().toISOString();
      await this.persist(record);
      throw new ServiceUnavailableException(message);
    }

    const healthyNames = new Set(this.healthyProviders(record));
    const candidates = this.providers.filter(p => !healthyNames.has(p.name));

    for (const provider of candidates) {
      if (this.countHealthy(record) >= record.replicationFactor) break;
      await this.pinWithProvider(record, provider, content);
    }

    this.finalizeStatus(record);
    await this.persist(record);

    if (record.status === PinStatus.DEGRADED) {
      await this.webhookService.dispatch(IPFS_EVENTS.PIN_DEGRADED, {
        cid: record.cid,
        healthyProviders: this.countHealthy(record),
        replicationFactor: record.replicationFactor,
      });
    }

    if (this.countHealthy(record) === 0) {
      await this.webhookService.dispatch(IPFS_EVENTS.PIN_FAILED, { cid: record.cid });
      throw new ServiceUnavailableException(
        `Failed to pin ${record.cid} to any of the ${this.providers.length} registered provider(s)`,
      );
    }
  }

  private async pinWithProvider(
    record: PinRecord,
    provider: IpfsPinProvider,
    content: Buffer,
  ): Promise<void> {
    const entry = this.upsertProviderEntry(record, provider.name);
    entry.attempts += 1;

    try {
      await this.circuitBreakerService.execute(
        `ipfs-pin-${provider.name}`,
        async () => provider.pin(record.cid, content),
        {
          name: `ipfs-pin-${provider.name}`,
          timeout: 60000,
          errorThresholdPercentage: 50,
          resetTimeout: 30000,
        },
      );

      const verified = await this.circuitBreakerService.execute(
        `ipfs-verify-${provider.name}`,
        async () => provider.verify(record.cid),
        {
          name: `ipfs-verify-${provider.name}`,
          timeout: 30000,
          errorThresholdPercentage: 50,
          resetTimeout: 30000,
        },
      );

      if (!verified) throw new Error('Provider did not confirm the pin after upload');

      entry.status = ProviderPinStatus.PINNED;
      entry.pinnedAt = new Date().toISOString();
      entry.lastVerifiedAt = entry.pinnedAt;
      entry.lastError = undefined;
    } catch (error) {
      entry.status = ProviderPinStatus.FAILED;
      entry.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Provider ${provider.name} failed to pin ${record.cid} — failing over: ${entry.lastError}`,
      );
    }
  }

  /**
   * Asks a provider to drop the pin. An unregistered provider name is an error, not a
   * success. When `unpin()` throws, the pin still counts as released if the provider
   * reports it as absent (e.g. it was already removed out of band).
   */
  private async releasePin(cid: string, name: PinProviderName): Promise<void> {
    const provider = this.providers.find(p => p.name === name);
    if (!provider) throw new Error(`Provider ${name} is not registered`);

    try {
      await this.circuitBreakerService.execute(
        `ipfs-unpin-${name}`,
        async () => provider.unpin(cid),
        {
          name: `ipfs-unpin-${name}`,
          timeout: 60000,
          errorThresholdPercentage: 50,
          resetTimeout: 30000,
        },
      );
    } catch (unpinError) {
      const stillPinned = await this.circuitBreakerService
        .execute(`ipfs-verify-${name}`, async () => provider.verify(cid), {
          name: `ipfs-verify-${name}`,
          timeout: 30000,
          errorThresholdPercentage: 50,
          resetTimeout: 30000,
        })
        .catch(() => true);

      if (stillPinned) throw unpinError;
    }
  }

  private upsertProviderEntry(record: PinRecord, name: PinProviderName): ProviderPinRecord {
    let entry = record.providers.find(p => p.provider === name);
    if (!entry) {
      entry = { provider: name, status: ProviderPinStatus.FAILED, attempts: 0 };
      record.providers.push(entry);
    }
    return entry;
  }

  private healthyProviders(record: PinRecord): PinProviderName[] {
    return record.providers.filter(p => p.status === ProviderPinStatus.PINNED).map(p => p.provider);
  }

  private countHealthy(record: PinRecord): number {
    return this.healthyProviders(record).length;
  }

  private finalizeStatus(record: PinRecord): void {
    const healthy = this.countHealthy(record);
    // An in-progress unpin is only finished by a successful `unpin()`, never by health checks.
    if (record.status === PinStatus.UNPINNING) {
      record.updatedAt = new Date().toISOString();
      return;
    }
    if (healthy === 0) record.status = PinStatus.FAILED;
    else if (healthy < record.replicationFactor) record.status = PinStatus.DEGRADED;
    else record.status = PinStatus.HEALTHY;
    record.updatedAt = new Date().toISOString();
  }

  private async tryFindByCid(cid: string): Promise<PinRecord | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.pinKey(cid));
        return raw ? (JSON.parse(raw) as PinRecord) : undefined;
      } catch (err) {
        this.logFallback('findByCid', err);
      }
    }

    return this.pins.get(cid);
  }

  private async persist(record: PinRecord): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.pinKey(record.cid), JSON.stringify(record))
          .sadd(PINS_INDEX_KEY, record.cid)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('persist', err);
      }
    }

    this.pins.set(record.cid, record);
  }

  private assertTransactionOk(results: Array<[Error | null, unknown]> | null): void {
    if (!results) {
      throw new Error('Redis transaction aborted (exec() returned null, e.g. a WATCH conflict)');
    }
    const failed = results.find(([err]) => err);
    if (failed) {
      throw new Error(`Redis transaction command failed: ${failed[0]!.message}`);
    }
  }

  private pinKey(cid: string): string {
    return `${PIN_KEY_PREFIX}${cid}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics?.increment(IPFS_PINNING_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for ipfsPinning.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}