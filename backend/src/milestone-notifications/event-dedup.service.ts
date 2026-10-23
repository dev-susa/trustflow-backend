import { Inject, Injectable, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';

/**
 * How long a broadcast is remembered as already sent.
 *
 * Short by design: the window only has to span the fan-out of a single outbox event to every
 * replica, which is sub-second in practice. A long window would suppress genuinely new events
 * that happen to reuse a key, and the outbox already guarantees at-least-once rather than
 * exactly-once delivery, so the memory only needs to cover one delivery burst.
 */
export const GATEWAY_DEDUP_TTL_SECONDS = 10;

const KEY_PREFIX = 'dedup:gateway:';

/**
 * Upper bound on the in-process fallback cache. Redis handles expiry and eviction in the
 * normal case; this only matters when Redis is absent, where a long-running process with a
 * high event rate would otherwise accumulate entries indefinitely.
 */
const LOCAL_MAX_ENTRIES = 1000;

export const GATEWAY_DEDUP_CLAIMED_METRIC = 'gateway_event_dedup_claimed_total';
export const GATEWAY_DEDUP_DUPLICATE_METRIC = 'gateway_event_dedup_duplicate_total';
export const GATEWAY_DEDUP_REDIS_ERROR_METRIC = 'gateway_event_dedup_redis_error_total';

/**
 * Decides whether this replica is the one that should broadcast an outbox event.
 *
 * #646: the outbox relays each event to a Redis pub/sub channel that *every* replica
 * subscribes to, and each replica then calls `server.to(room).emit()`. That is correct with
 * per-replica sockets but multiplies delivery once a Socket.IO adapter is in play, because an
 * adapter makes `server.to(...).emit()` cluster-wide — so with N replicas every client
 * receives N copies of the same milestone event.
 *
 * A per-process cache cannot fix that on its own, because each replica has its own. The
 * authoritative claim is therefore a Redis `SET NX EX`, which resolves the race across
 * replicas: the first replica to claim the event broadcasts it, the rest observe the existing
 * key and drop it. An in-process TTL cache sits in front as a fast path and as the sole source
 * of truth when Redis is unavailable.
 *
 * Degradation is deliberate: a Redis failure falls back to the local cache rather than
 * dropping the event. A duplicated notification is an annoyance; a silently dropped milestone
 * or deliverable event is a missed update, so a Redis outage must not suppress broadcasts.
 */
@Injectable()
export class EventDedupService {
  private readonly logger = new SanitizedLogger(EventDedupService.name);
  /** eventId → epoch ms at which the claim expires. Insertion order is expiry order. */
  private readonly local = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Attempts to claim `eventId` for broadcast.
   *
   * @returns `true` if the caller is the first to claim it and should emit; `false` if the
   *          event was already claimed (a duplicate) and must be dropped.
   */
  async claim(eventId: string): Promise<boolean> {
    if (!eventId) {
      // Nothing to key on. Emitting is safer than dropping a real event.
      return true;
    }

    const now = Date.now();
    this.pruneLocal(now);

    // Fast path: this replica already broadcast it.
    const localExpiry = this.local.get(eventId);
    if (localExpiry !== undefined && localExpiry > now) {
      this.metrics?.increment(GATEWAY_DEDUP_DUPLICATE_METRIC, { source: 'local' });
      return false;
    }

    if (this.redis) {
      try {
        const result = await this.redis.set(
          `${KEY_PREFIX}${eventId}`,
          '1',
          'EX',
          GATEWAY_DEDUP_TTL_SECONDS,
          'NX',
        );
        if (result !== 'OK') {
          // Another replica holds the claim and is the one that will emit.
          this.metrics?.increment(GATEWAY_DEDUP_DUPLICATE_METRIC, { source: 'redis' });
          return false;
        }
      } catch (err) {
        // Fall through to the local cache rather than suppressing the broadcast: a duplicate
        // notification is recoverable, a dropped milestone update is not.
        this.logger.warn(
          `Dedup claim failed for event ${eventId}; falling back to per-replica dedup`,
          err,
        );
        this.metrics?.increment(GATEWAY_DEDUP_REDIS_ERROR_METRIC);
      }
    }

    // Make room for the entry about to be inserted, so the cache never exceeds its cap (#732).
    this.evictOldest(LOCAL_MAX_ENTRIES - 1);
    this.local.set(eventId, now + GATEWAY_DEDUP_TTL_SECONDS * 1000);
    this.metrics?.increment(GATEWAY_DEDUP_CLAIMED_METRIC);
    return true;
  }

  /** Drops expired entries, and the oldest ones if the cache is still at its cap. */
  private pruneLocal(now: number): void {
    for (const [key, expiry] of this.local) {
      if (expiry <= now) this.local.delete(key);
    }
    this.evictOldest(LOCAL_MAX_ENTRIES);
  }

  /**
   * Deletes the oldest entries until at most `limit` remain. Every entry shares one TTL, so
   * insertion order is expiry order and the first keys are the oldest. Deleting from the
   * front of a Map preserves the rest.
   */
  private evictOldest(limit: number): void {
    while (this.local.size > limit) {
      const oldest = this.local.keys().next();
      if (oldest.done) break;
      this.local.delete(oldest.value);
    }
  }
}
