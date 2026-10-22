import { Inject, Injectable, OnModuleDestroy, OnModuleInit, BeforeApplicationShutdown, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { getStellarConfig } from '../stellar/stellar.config';
import { config } from '../config/env.config';
import { buildSorobanServer } from '../stellar/soroban.helper';
import { SorobanMetricsService } from '../monitoring/soroban-metrics.service';
import { wrapSorobanRpc } from '../monitoring/soroban-rpc-metrics.interceptor';

export interface IndexedSorobanEvent {
  eventId: string;
  ledger: number;
  contractId: string;
  eventType: string;
  topic: string[];
  value: unknown;
  xdr: string;
  indexedAt: string;
}

const EVENT_KEY_PREFIX = 'soroban:event:';
const EVENTS_INDEX_KEY = 'soroban:events:index';
const CURSOR_KEY = 'soroban:event-indexer:cursor';
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;

@Injectable()
export class SorobanEventIndexerService implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new SanitizedLogger(SorobanEventIndexerService.name);
  private rpcServer!: SorobanRpc.Server;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private currentPoll: Promise<IndexedSorobanEvent[]> | null = null;

  private readonly POLL_INTERVAL_MS = 10_000;
  private readonly MAX_LEDGER_RANGE = 100;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Optional() private readonly sorobanMetrics?: SorobanMetricsService,
  ) {}

  onModuleInit() {
    this.rpcServer = buildSorobanServer(getStellarConfig().sorobanRpcUrl);
  }

  onModuleDestroy() {
    this.stop();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const run = async () => {
      // Skip this tick if a previous poll is still in flight, so slow RPC calls
      // never let two polls race on the same cursor.
      if (this.currentPoll) {
        this.logger.warn('Skipping Soroban poll: previous poll still in flight');
        return;
      }
      try {
        this.currentPoll = this.poll();
        await this.currentPoll;
      } catch (err) {
        this.logger.error('Soroban event poll failed', err);
      } finally {
        this.currentPoll = null;
      }
    };

    void run();
    this.pollingInterval = setInterval(() => void run(), this.POLL_INTERVAL_MS);
    this.logger.log('Soroban event indexer started');
  }

  stop() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isRunning = false;
  }

  async poll(): Promise<IndexedSorobanEvent[]> {
    const contractId = getStellarConfig().contractId;
    if (!contractId) {
      this.logger.warn('No TRUSTFLOW_CONTRACT_ID configured, skipping poll');
      return [];
    }

    const cursor = await this.getCursor();
    const bounds = await this.getLedgerBounds();
    const currentLedger = bounds.latestLedger;
    const oldestLedger = bounds.oldestLedger;

    let startLedger = cursor > 0 ? cursor + 1 : undefined;

    if (!startLedger) {
      if (config.SOROBAN_START_LEDGER !== undefined) {
        startLedger = Math.max(config.SOROBAN_START_LEDGER, oldestLedger);
        this.logger.log(
          `No checkpoint found, starting from configured SOROBAN_START_LEDGER clamped to oldest: ${startLedger}`,
        );
      } else {
        startLedger = Math.max(currentLedger - 1000, oldestLedger);
        this.logger.log(
          `No checkpoint found and no config, starting from latest - 1000: ${startLedger}`,
        );
      }
    } else if (startLedger < oldestLedger) {
      this.logger.warn(
        `Cursor ${startLedger} is behind oldest available ledger ${oldestLedger}. Fast-forwarding.`,
      );
      startLedger = oldestLedger;
    }

    // Gap detection: Check if we're significantly behind the current ledger height
    // A gap > 1 ledger indicates potential missed events due to timeouts or failures
    const gapSize = currentLedger - cursor;
    if (cursor > 0 && gapSize > 1) {
      this.logger.warn(
        `Detected ledger gap: cursor at ${cursor}, latest ledger at ${currentLedger} (gap: ${gapSize} ledgers)`,
      );
    }

    const endLedger = Math.min(currentLedger, startLedger + this.MAX_LEDGER_RANGE - 1);

    if (startLedger > endLedger) return [];

    const getEventsParams: any = {
      startLedger,
      filters: [{ type: 'contract', contractIds: [contractId] }],
      limit: 100,
    };

    const response = (await (this.sorobanMetrics
      ? wrapSorobanRpc(this.sorobanMetrics, 'getEvents', () =>
          this.rpcServer.getEvents(getEventsParams),
        )
      : this.rpcServer.getEvents(getEventsParams))) as any;

    const events: IndexedSorobanEvent[] = [];
    for (const raw of response.events) {
      const event: IndexedSorobanEvent = {
        eventId: raw.id,
        ledger: raw.ledger,
        contractId: raw.contractId?.toString() || contractId,
        eventType: this.parseTopic(raw.topic[0]),
        topic: raw.topic.map((topic: unknown) => this.parseTopic(topic)),
        value: this.parseValue(raw.value),
        xdr: raw.value.toXDR().toString(),
        indexedAt: new Date().toISOString(),
      };
      events.push(event);
      await this.storeEvent(event);
    }

    // Only update cursor after ALL events in the batch are successfully stored
    // This ensures atomicity: if storage fails mid-batch, we'll re-process on next poll
    await this.setCursor(endLedger);

    // Update the ledger lag gauge so Prometheus can alert when the indexer
    // falls behind the chain tip.
    if (this.sorobanMetrics) {
      this.sorobanMetrics.setIndexerLedgerLag(currentLedger - endLedger);
    }

    if (events.length > 0) {
      this.logger.log(`Indexed ${events.length} events from ledgers ${startLedger}-${endLedger}`);
    }

    return events;
  }

  async getEvents(limit = DEFAULT_EVENT_LIMIT): Promise<IndexedSorobanEvent[]> {
    const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_EVENT_LIMIT;
    const boundedLimit = Math.min(Math.max(safeLimit, 1), MAX_EVENT_LIMIT);

    if (this.redis) {
      try {
        const ids = await this.redis.zrevrange(EVENTS_INDEX_KEY, 0, boundedLimit - 1);
        if (ids.length === 0) return [];
        const raw = await this.redis.mget(...ids.map(id => `${EVENT_KEY_PREFIX}${id}`));
        return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r));
      } catch (error) {
        this.logger.error('Failed to read Soroban events from Redis', error);
      }
    }
    return [];
  }

  private async storeEvent(event: IndexedSorobanEvent): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis
        .multi()
        .set(`${EVENT_KEY_PREFIX}${event.eventId}`, JSON.stringify(event))
        .zadd(EVENTS_INDEX_KEY, event.ledger, event.eventId)
        .exec();
    } catch (err) {
      this.logger.warn('Failed to store event in Redis', err);
    }
  }

  private async getCursor(): Promise<number> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(CURSOR_KEY);
        return raw ? parseInt(raw, 10) : 0;
      } catch {
        // fall through
      }
    }
    return 0;
  }

  private async setCursor(ledger: number): Promise<void> {
    if (!this.redis) return;
    try {
      // Only ever advance the cursor. A stale write must never move it backward.
      const raw = await this.redis.get(CURSOR_KEY);
      const current = raw ? parseInt(raw, 10) : 0;
      if (ledger <= current) return;
      await this.redis.set(CURSOR_KEY, ledger.toString());
    } catch {
      // best effort
    }
  }

  private async getLedgerBounds(): Promise<{ latestLedger: number; oldestLedger: number }> {
    try {
      const response = await (this.sorobanMetrics
        ? wrapSorobanRpc(this.sorobanMetrics, 'getHealth', () => this.rpcServer.getHealth())
        : this.rpcServer.getHealth());
      if (response && typeof response === 'object') {
        const anyResp = response as any;
        return {
          latestLedger: anyResp.latestLedger ?? anyResp.latest_ledger ?? 0,
          oldestLedger: anyResp.oldestLedger ?? anyResp.oldest_ledger ?? 0,
        };
      }
      return { latestLedger: 0, oldestLedger: 0 };
    } catch (error) {
      this.logger.error('Failed to get ledger bounds:', error);
      return { latestLedger: 0, oldestLedger: 0 };
    }
  }

  private parseTopic(topic: unknown): string {
    try {
      const t = topic as {
        switch?: () => { name: string };
        sym?: () => { toString(): string };
        bytes?: () => Uint8Array;
      };
      if ((t?.switch?.().name as string) === 'scvSymbol') return t.sym!().toString();
      if ((t?.switch?.().name as string) === 'scvBytes') return Buffer.from(t.bytes!()).toString();
      return String(topic);
    } catch {
      return 'unknown';
    }
  }

  private parseValue(value: unknown): unknown {
    try {
      const v = value as { switch?: () => { name: string }; bytes?: () => Uint8Array };
      if ((v?.switch?.().name as string) === 'scvBytes') {
        return JSON.parse(Buffer.from(v.bytes!()).toString());
      }
      return String(value);
    } catch {
      return String(value);
    }
  }

  /**
   * Gracefully handles shutdown by waiting for the current poll to complete.
   * Called automatically by NestJS when SIGTERM/SIGINT is received.
   * Waits up to 15 seconds for the active poll before allowing termination.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Soroban indexer received shutdown signal: ${signal || 'unknown'}`);
    
    // Stop accepting new polls
    this.stop();

    if (!this.currentPoll) {
      this.logger.log('Soroban indexer shutdown - no active poll');
      return;
    }

    this.logger.log('Soroban indexer waiting for current poll to complete');
    
    const shutdownTimeout = 15000; // 15 seconds
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.logger.warn('Soroban indexer shutdown timeout reached - current poll may be incomplete');
        resolve();
      }, shutdownTimeout);
    });

    try {
      await Promise.race([this.currentPoll, timeoutPromise]);
      this.logger.log('Soroban indexer shutdown complete');
    } catch (error) {
      this.logger.error('Error during Soroban indexer shutdown', error);
    }
  }
}
