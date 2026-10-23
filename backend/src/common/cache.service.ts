import { Injectable, Logger } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { config } from '../config/env.config';

export interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttlSeconds: number;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private client: RedisClientType | null = null;
  private readonly defaultTTL = 60; // 60 seconds
  private localCache = new Map<string, CacheEntry<unknown>>();
  private redisAvailable = false;

  constructor() {
    this.connect();
  }

  /**
   * Connect to Redis — falls back to in-memory cache if unavailable or unset
   */
  private async connect(): Promise<void> {
    const redisUrl = config?.REDIS_URL;
    if (!redisUrl) {
      this.logger.log('REDIS_URL unset, using in-memory cache fallback');
      this.redisAvailable = false;
      return;
    }
    try {
      this.client = createClient({ url: redisUrl });
      this.client.on('error', err => {
        if (this.redisAvailable) {
          this.logger.warn(`Redis error, falling back to in-memory cache: ${err.message}`);
          this.redisAvailable = false;
        }
      });
      await this.client.connect();
      this.redisAvailable = true;
      this.logger.log('Connected to Redis');
    } catch {
      this.logger.warn('Redis unavailable, using in-memory cache fallback');
      this.redisAvailable = false;
    }
  }

  /**
   * Cache-Aside pattern: get from cache, or fetch from DB and cache it
   */
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T | undefined>,
    ttlSeconds?: number,
  ): Promise<T | undefined> {
    // Try cache first
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    // Cache miss — fetch from data source
    const data = await fetchFn();
    if (data !== undefined) {
      await this.set(key, data, ttlSeconds);
    }
    return data;
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | undefined> {
    if (this.redisAvailable && this.client) {
      try {
        const raw = await this.client.get(key);
        if (raw) {
          const entry: CacheEntry<T> = JSON.parse(raw);
          this.logger.debug(`Cache HIT (Redis): ${key}`);
          return entry.data;
        }
      } catch {
        this.redisAvailable = false;
      }
    }

    // Fallback to local cache
    const entry = this.localCache.get(key) as CacheEntry<T> | undefined;
    if (entry) {
      // Check TTL
      const ttlMs = entry.ttlSeconds * 1000;
      if (Date.now() - entry.cachedAt < ttlMs) {
        this.logger.debug(`Cache HIT (local): ${key}`);
        return entry.data;
      }
      this.localCache.delete(key);
    }

    this.logger.debug(`Cache MISS: ${key}`);
    return undefined;
  }

  /**
   * Set value in cache with TTL
   */
  async set<T>(key: string, data: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds || this.defaultTTL;

    if (this.redisAvailable && this.client) {
      try {
        const entry: CacheEntry<T> = { data, cachedAt: Date.now(), ttlSeconds: ttl };
        await this.client.set(key, JSON.stringify(entry), { EX: ttl });
        this.logger.debug(`Cache SET (Redis): ${key} TTL=${ttl}s`);
        return;
      } catch {
        this.redisAvailable = false;
      }
    }

    // Fallback to local cache
    this.localCache.set(key, { data, cachedAt: Date.now(), ttlSeconds: ttl });
    this.logger.debug(`Cache SET (local): ${key} TTL=${ttl}s`);
  }

  /**
   * Invalidate a cache key
   */
  async invalidate(key: string): Promise<void> {
    if (this.redisAvailable && this.client) {
      try {
        await this.client.del(key);
        this.logger.debug(`Cache INVALIDATE (Redis): ${key}`);
      } catch {
        this.redisAvailable = false;
      }
    }
    this.localCache.delete(key);
    this.logger.debug(`Cache INVALIDATE: ${key}`);
  }

  /**
   * Invalidate multiple keys by pattern
   */
  async invalidatePattern(pattern: string): Promise<void> {
    if (this.redisAvailable && this.client) {
      try {
        const keys = await this.client.keys(pattern);
        if (keys.length > 0) {
          await this.client.del(keys);
          this.logger.debug(`Cache INVALIDATE pattern (Redis): ${pattern} (${keys.length} keys)`);
        }
      } catch {
        this.redisAvailable = false;
      }
    }

    // Local cache pattern matching
    const regex = new RegExp(pattern.replace('*', '.*'));
    for (const key of this.localCache.keys()) {
      if (regex.test(key)) {
        this.localCache.delete(key);
      }
    }
    this.logger.debug(`Cache INVALIDATE pattern: ${pattern}`);
  }

  /**
   * Get cache stats for monitoring
   */
  getStats() {
    return {
      redisAvailable: this.redisAvailable,
      localCacheSize: this.localCache.size,
    };
  }
}
