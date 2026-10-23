import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import {
  assertTransactionApplied,
  isTransactionIntegrityError,
} from '../common/redis/redis-transaction';
import { MetricsService } from '../monitoring/metrics.service';
import { CreateGigDto, SearchGigsQuery, UpdateGigDto } from './gig.dto';
import {
  DEFAULT_GIG_SEARCH_CACHE_TTL_SECONDS,
  DEFAULT_RESPONSE_WINDOW_HOURS,
  GIG_EVENTS,
  Gig,
  GigStatus,
  PaginatedGigs,
} from './gig.entity';
import { OutboxService } from '../outbox/outbox.service';
import { config } from '../config/env.config';
import { amountGreaterThanOrEqual, amountLessThanOrEqual } from '../common/amount';
import { normalizePagination, paginate } from '../common/pagination';

const GIG_KEY_PREFIX = 'gig:';
const GIGS_INDEX_KEY = 'gigs:index';
const GIGS_OPEN_BY_RESPOND_BY_KEY = 'gigs:open:respondBy';
const GIGS_BY_CREATOR_PREFIX = 'gigs:by-creator:';
const GIGS_SEARCH_CACHE_PREFIX = 'gigs:search:';
/** Tracks every currently-cached search page so invalidation doesn't need a Redis KEYS scan. */
const GIGS_SEARCH_CACHE_KEYS_SET = 'gigs:search:cache-keys';

/** Emitted (see `/metrics`) every time a call falls back to the in-memory store. */
export const GIG_PERSISTENCE_FALLBACK_METRIC = 'gig_persistence_fallback_total';

/**
 * Gig solicitation store. Backed by Redis so gig state survives restarts and is shared
 * across instances behind a load balancer — see PERSISTENT_STORAGE_SPIKE.md. Falls back to
 * a process-local Map when Redis is unavailable, matching the degrade-gracefully pattern
 * already used by NonceStoreService/RateLimitGuard elsewhere in this codebase. That fallback
 * reintroduces per-instance divergence for as long as it's active, so it's logged at error
 * level, counted via `GIG_PERSISTENCE_FALLBACK_METRIC`, and — in production — refused outright
 * at startup rather than silently engaged (see `onModuleInit`).
 */
@Injectable()
export class GigService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(GigService.name);

  /** Fallback store, only used while Redis is unavailable. */
  private readonly gigs = new Map<string, Gig>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly metrics: MetricsService,
    @Optional() private readonly outbox?: OutboxService,
  ) {}

  /**
   * In production, a missing Redis client means every gig write would silently start
   * diverging per-instance — exactly the failure mode this store exists to eliminate. Fail
   * app startup instead of degrading quietly. Non-production environments (dev/test) keep the
   * in-memory fallback so the app still runs without a local Redis.
   */
  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'GigService requires REDIS_URL to be configured in production — refusing to start ' +
          'with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  async create(dto: CreateGigDto): Promise<Gig> {
    const id = `gig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const windowHours = dto.responseWindowHours ?? DEFAULT_RESPONSE_WINDOW_HOURS;

    const gig: Gig = {
      id,
      creator: dto.creator,
      title: dto.title,
      budgetXLM: dto.budgetXLM,
      status: GigStatus.OPEN,
      createdAt: now.toISOString(),
      respondBy: new Date(now.getTime() + windowHours * 60 * 60 * 1000).toISOString(),
      version: 1,
    };

    const event = this.outbox?.create(GIG_EVENTS.GIG_CREATED, 'gig', id, gig);

    if (this.redis) {
      try {
        const transaction = this.redis
          .multi()
          .set(this.gigKey(id), JSON.stringify(gig))
          .zadd(GIGS_INDEX_KEY, now.getTime(), id)
          .zadd(GIGS_OPEN_BY_RESPOND_BY_KEY, new Date(gig.respondBy).getTime(), id)
          .sadd(this.creatorKey(gig.creator), id);
        if (event) this.outbox!.appendToTransaction(transaction, event);
        const results = await transaction.exec();
        assertTransactionApplied(results);
        await this.invalidateSearchCache();
        return gig;
      } catch (err) {
        this.logFallback('create', err);
      }
    }

    this.gigs.set(id, gig);
    if (event) await this.outbox!.append(event);
    await this.invalidateSearchCache();
    return gig;
  }

  async findAll(): Promise<Gig[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.zrange(GIGS_INDEX_KEY, 0, -1);
        return await this.fetchMany(ids);
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }

    return [...this.gigs.values()];
  }

  async findById(id: string): Promise<Gig> {
    const gig = await this.tryFindById(id);
    if (!gig) throw new NotFoundException(`Gig ${id} not found`);
    return gig;
  }

  async findByCreator(
    address: string,
    options?: {
      status?: GigStatus;
      minBudgetXLM?: string;
      maxBudgetXLM?: string;
      offset?: number;
      limit?: number;
    },
  ): Promise<{ data: Gig[]; total: number }> {
    let gigs: Gig[];
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(this.creatorKey(address));
        gigs = await this.fetchMany(ids);
      } catch (err) {
        this.logFallback('findByCreator', err);
        gigs = [...this.gigs.values()].filter(g => g.creator === address);
      }
    } else {
      gigs = [...this.gigs.values()].filter(g => g.creator === address);
    }

    if (options?.status) {
      gigs = gigs.filter(g => g.status === options.status);
    }
    if (options?.minBudgetXLM !== undefined) {
      gigs = gigs.filter(g => amountGreaterThanOrEqual(g.budgetXLM, options.minBudgetXLM));
    }
    if (options?.maxBudgetXLM !== undefined) {
      gigs = gigs.filter(g => amountLessThanOrEqual(g.budgetXLM, options.maxBudgetXLM));
    }

    const total = gigs.length;
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 20;
    const data = gigs.slice(offset, offset + limit);
    return { data, total };
  }

  /**
   * Return all gigs with the given status.
   * Used by the milestone expiry scheduler to find open gigs nearing deadline.
   */
  async findByStatus(status: GigStatus): Promise<Gig[]> {
    const all = await this.findAll();
    return all.filter(g => g.status === status);
  }

  /** Open gig solicitations whose response deadline has passed as of `now`. */
  async findExpirable(now: Date = new Date()): Promise<Gig[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.zrangebyscore(GIGS_OPEN_BY_RESPOND_BY_KEY, 0, now.getTime());
        const gigs = await this.fetchMany(ids);
        return gigs.filter(g => g.status === GigStatus.OPEN);
      } catch (err) {
        this.logFallback('findExpirable', err);
      }
    }

    return [...this.gigs.values()].filter(
      g => g.status === GigStatus.OPEN && new Date(g.respondBy) <= now,
    );
  }

  /**
   * Paginated search over gig solicitations, defaulting to open gigs sorted newest first.
   * Results are cached in Redis for `GIG_SEARCH_CACHE_TTL_SECONDS` (default 30s) to reduce
   * load on `findAll()` for repeated queries; any mutation invalidates every cached page.
   */
  async search(query: SearchGigsQuery = {}): Promise<PaginatedGigs> {
    const status = query.status ?? GigStatus.OPEN;
    const { page, limit } = normalizePagination(query);
    const cacheKey = this.searchCacheKey(
      status,
      page,
      limit,
      query.minBudgetXLM,
      query.maxBudgetXLM,
    );

    const cached = await this.readSearchCache(cacheKey);
    if (cached) return cached;

    const all = await this.findAll();
    let filtered = all
      .filter(g => g.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (query.minBudgetXLM !== undefined) {
      filtered = filtered.filter(g => amountGreaterThanOrEqual(g.budgetXLM, query.minBudgetXLM));
    }
    if (query.maxBudgetXLM !== undefined) {
      filtered = filtered.filter(g => amountLessThanOrEqual(g.budgetXLM, query.maxBudgetXLM));
    }

    const result: PaginatedGigs = paginate(filtered, { page, limit });

    await this.writeSearchCache(cacheKey, result);
    return result;
  }

  private async mutateWithRetry<T>(id: string, operation: (gig: Gig) => Promise<T>): Promise<T> {
    const maxRetries = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (this.redis) {
        try {
          await this.redis.watch(this.gigKey(id));
        } catch (err) {
          this.logFallback('watch', err);
        }
      }

      const gig = await this.tryFindById(id);
      if (!gig) {
        if (this.redis) {
          try {
            await this.redis.unwatch();
          } catch (err) {
            /* ignore */
          }
        }
        throw new NotFoundException(`Gig ${id} not found`);
      }

      const currentVersion = gig.version || 1;
      try {
        const result = await operation(gig);
        // Ensure in-memory fallback behaves like compare-and-set
        if (!this.redis) {
          const inMem = this.gigs.get(id);
          if (inMem && inMem.version !== currentVersion + 1) {
            throw new Error('In-memory transaction aborted');
          }
        }
        return result;
      } catch (err: any) {
        if (this.redis) {
          try {
            await this.redis.unwatch();
          } catch (e) {
            /* ignore */
          }
        }
        if (
          isTransactionIntegrityError(err) ||
          err.message?.includes('In-memory transaction aborted')
        ) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw new ConflictException(`Failed to modify gig ${id} due to concurrent modifications`);
  }

  async accept(id: string, responder: string): Promise<Gig> {
    return this.mutateWithRetry(id, async gig => {
      if (gig.status !== GigStatus.OPEN) {
        throw new BadRequestException(`Cannot accept a gig with status "${gig.status}"`);
      }
      gig.status = GigStatus.ACCEPTED;
      gig.acceptedBy = responder;
      gig.acceptedAt = new Date().toISOString();
      gig.version = (gig.version || 1) + 1;
      await this.persistResolved(gig, GIG_EVENTS.GIG_ACCEPTED);
      return gig;
    });
  }

  async cancel(id: string): Promise<Gig> {
    return this.mutateWithRetry(id, async gig => {
      if (gig.status !== GigStatus.OPEN) {
        throw new BadRequestException(`Cannot cancel a gig with status "${gig.status}"`);
      }
      gig.status = GigStatus.CANCELLED;
      gig.cancelledAt = new Date().toISOString();
      gig.version = (gig.version || 1) + 1;
      await this.persistResolved(gig, GIG_EVENTS.GIG_CANCELLED);
      return gig;
    });
  }

  async update(id: string, dto: UpdateGigDto): Promise<Gig> {
    return this.mutateWithRetry(id, async gig => {
      if (gig.status !== GigStatus.OPEN) {
        throw new BadRequestException(`Cannot update a gig with status "${gig.status}"`);
      }
      if (dto.title !== undefined) gig.title = dto.title;
      if (dto.budgetXLM !== undefined) gig.budgetXLM = dto.budgetXLM;
      if (dto.responseWindowHours !== undefined) {
        gig.respondBy = new Date(
          Date.now() + dto.responseWindowHours * 60 * 60 * 1000,
        ).toISOString();
      }
      gig.version = (gig.version || 1) + 1;
      await this.persistGig(gig);
      return gig;
    });
  }

  async remove(id: string): Promise<void> {
    return this.mutateWithRetry(id, async gig => {
      if (gig.status === GigStatus.ACCEPTED) {
        throw new BadRequestException('Cannot delete an accepted gig');
      }
      if (this.redis) {
        try {
          const transaction = this.redis
            .multi()
            .del(this.gigKey(id))
            .zrem(GIGS_INDEX_KEY, id)
            .zrem(GIGS_OPEN_BY_RESPOND_BY_KEY, id)
            .srem(this.creatorKey(gig.creator), id);
          const results = await transaction.exec();
          assertTransactionApplied(results);
          await this.invalidateSearchCache();
          return;
        } catch (err: any) {
          if (isTransactionIntegrityError(err)) {
            throw err;
          }
          this.logFallback('remove', err);
        }
      }
      this.gigs.delete(id);
      await this.invalidateSearchCache();
    });
  }

  /**
   * Marks a still-open gig as expired. Returns `undefined` (no-op) if it was already
   * resolved by the time the sweep reached it. Used by the expiry sweep worker.
   */
  async expire(id: string): Promise<Gig | undefined> {
    return this.mutateWithRetry(id, async gig => {
      if (gig.status !== GigStatus.OPEN) return undefined;
      gig.status = GigStatus.EXPIRED;
      gig.expiredAt = new Date().toISOString();
      gig.version = (gig.version || 1) + 1;
      await this.persistResolved(gig, GIG_EVENTS.GIG_EXPIRED);
      return gig;
    });
  }

  /** Writes a gig that just left OPEN status, dropping it from the open-expiry index. */
  private async persistResolved(gig: Gig, eventType: string): Promise<void> {
    const event = this.outbox?.create(eventType, 'gig', gig.id, gig);
    if (this.redis) {
      try {
        const transaction = this.redis
          .multi()
          .set(this.gigKey(gig.id), JSON.stringify(gig))
          .zrem(GIGS_OPEN_BY_RESPOND_BY_KEY, gig.id);
        if (event) this.outbox!.appendToTransaction(transaction, event);
        const results = await transaction.exec();
        assertTransactionApplied(results);
        await this.invalidateSearchCache();
        return;
      } catch (err: any) {
        if (isTransactionIntegrityError(err)) {
          throw err;
        }
        this.logFallback('persistResolved', err);
      }
    }

    this.gigs.set(gig.id, gig);
    if (event) await this.outbox!.append(event);
    await this.invalidateSearchCache();
  }

  /**
   * Writes a gig while keeping the open-expiry index (`GIGS_OPEN_BY_RESPOND_BY_KEY`) in sync
   * with its (possibly just-changed) `respondBy` deadline — otherwise `findExpirable()`'s
   * sweep would keep using a stale deadline after `update()` extends/shortens the response
   * window (#432).
   */
  private async persistGig(gig: Gig): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.gigKey(gig.id), JSON.stringify(gig))
          .zadd(GIGS_OPEN_BY_RESPOND_BY_KEY, new Date(gig.respondBy).getTime(), gig.id)
          .exec();
        assertTransactionApplied(results);
        await this.invalidateSearchCache();
        return;
      } catch (err: any) {
        if (isTransactionIntegrityError(err)) {
          throw err;
        }
        this.logFallback('persistGig', err);
      }
    }
    this.gigs.set(gig.id, gig);
    await this.invalidateSearchCache();
  }

  private async tryFindById(id: string): Promise<Gig | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.gigKey(id));
        return raw ? (JSON.parse(raw) as Gig) : undefined;
      } catch (err) {
        this.logFallback('findById', err);
      }
    }

    return this.gigs.get(id);
  }

  private async fetchMany(ids: string[]): Promise<Gig[]> {
    if (ids.length === 0) return [];
    const raw = await this.redis!.mget(...ids.map(id => this.gigKey(id)));
    return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as Gig);
  }

  private gigKey(id: string): string {
    return `${GIG_KEY_PREFIX}${id}`;
  }

  private creatorKey(address: string): string {
    return `${GIGS_BY_CREATOR_PREFIX}${address}`;
  }

  /**
   * Budget filters are hashed rather than interpolated raw so that arbitrary/malformed
   * `minBudgetXLM`/`maxBudgetXLM` query values can't grow the cache key space unboundedly.
   * Both bounds are normalized (parsed and re-stringified) first so that equivalent values
   * (e.g. "500" vs "500.0") share a cache entry instead of needlessly fragmenting it.
   */
  private searchCacheKey(
    status: GigStatus,
    page: number,
    limit: number,
    minBudgetXLM?: string,
    maxBudgetXLM?: string,
  ): string {
    const filterHash = this.budgetFilterHash(minBudgetXLM, maxBudgetXLM);
    return `${GIGS_SEARCH_CACHE_PREFIX}${status}:${page}:${limit}:${filterHash}`;
  }

  private budgetFilterHash(minBudgetXLM?: string, maxBudgetXLM?: string): string {
    const min = minBudgetXLM !== undefined ? parseFloat(minBudgetXLM) : undefined;
    const max = maxBudgetXLM !== undefined ? parseFloat(maxBudgetXLM) : undefined;
    const normalized = `${min ?? ''}:${max ?? ''}`;
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  private getSearchCacheTtlSeconds(): number {
    return config.GIG_SEARCH_CACHE_TTL_SECONDS ?? DEFAULT_GIG_SEARCH_CACHE_TTL_SECONDS;
  }

  private async readSearchCache(key: string): Promise<PaginatedGigs | undefined> {
    if (!this.redis) return undefined;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as PaginatedGigs) : undefined;
    } catch (err) {
      this.logFallback('search:cache-read', err);
      return undefined;
    }
  }

  private async writeSearchCache(key: string, result: PaginatedGigs): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(result), 'EX', this.getSearchCacheTtlSeconds());
      await this.redis.sadd(GIGS_SEARCH_CACHE_KEYS_SET, key);
    } catch (err) {
      this.logFallback('search:cache-write', err);
    }
  }

  /** Drops every cached search page. Called after any mutation that could change a search result. */
  private async invalidateSearchCache(): Promise<void> {
    if (!this.redis) return;
    try {
      const keys = await this.redis.smembers(GIGS_SEARCH_CACHE_KEYS_SET);
      if (keys.length === 0) return;
      await this.redis.del(...keys, GIGS_SEARCH_CACHE_KEYS_SET);
    } catch (err) {
      this.logFallback('search:cache-invalidate', err);
    }
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics.increment(GIG_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for gig.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
