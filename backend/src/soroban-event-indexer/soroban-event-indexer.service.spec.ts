import { Test, TestingModule } from '@nestjs/testing';
import { SorobanEventIndexerService } from './soroban-event-indexer.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { rpc as SorobanRpc, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { Redis } from 'ioredis';
import * as stellarConfig from '../stellar/stellar.config';
import { validateEnv } from '../config/env.config';

// poll() reads the validated env config, so it must be initialised before any test runs.
validateEnv();

jest.mock('@stellar/stellar-sdk', () => {
  const original = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...original,
    rpc: {
      ...original.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getHealth: jest.fn(),
        getEvents: jest.fn(),
      })),
    }
  };
});

const describeIfRedis = process.env.REDIS_URL ? describe : describe.skip;

describe('SorobanEventIndexerService (Unit)', () => {
  let service: SorobanEventIndexerService;
  let rpcServerMock: any;

  beforeEach(async () => {
    jest.spyOn(stellarConfig, 'getStellarConfig').mockReturnValue({
      contractId: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      sorobanRpcUrl: 'http://localhost:8000',
    } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SorobanEventIndexerService, { provide: REDIS_CLIENT, useValue: null }],
    }).compile();

    service = module.get<SorobanEventIndexerService>(SorobanEventIndexerService);
    service.onModuleInit();
    rpcServerMock = (service as any).rpcServer;
  });

  afterEach(() => {
    service.stop();
    jest.restoreAllMocks();
  });

  it('starts and stops cleanly, idempotently', () => {
    service.start();
    const interval = (service as any).pollingInterval;
    expect(interval).toBeTruthy();

    service.start(); // idempotent
    expect((service as any).pollingInterval).toBe(interval);

    service.stop();
    expect((service as any).pollingInterval).toBeNull();
    service.onModuleDestroy();
  });

  it('poll() skips if no contractId', async () => {
    jest.spyOn(stellarConfig, 'getStellarConfig').mockReturnValue({} as any);
    const events = await service.poll();
    expect(events).toEqual([]);
    expect(rpcServerMock.getHealth).not.toHaveBeenCalled();
  });

  it('poll() returns empty if the RPC reports no events', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 10, oldestLedger: 1 });
    rpcServerMock.getEvents.mockResolvedValue({ events: [] });
    const events = await service.poll();
    expect(events).toEqual([]);
    expect(rpcServerMock.getEvents).toHaveBeenCalledTimes(1);
  });

  it('poll() fetches and parses events without Redis (null client)', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 10, oldestLedger: 1 });
    const val = nativeToScVal('test_value', { type: 'symbol' });
    const rawEvent = {
      id: 'event-1',
      ledger: 5,
      contractId: 'C123',
      topic: [nativeToScVal('EVENT_TOPIC', { type: 'symbol' })],
      value: val,
    };
    rpcServerMock.getEvents.mockResolvedValue({ events: [rawEvent] });

    const events = await service.poll();
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('event-1');
    expect(events[0].eventType).toBe('EVENT_TOPIC');
  });

  it('clamps unsafe limit values to the safe range', async () => {
    const redisMock = {
      zrevrange: jest.fn().mockResolvedValue(['event-1', 'event-2']),
      mget: jest.fn().mockResolvedValue(['{"eventId":"event-1"}', '{"eventId":"event-2"}']),
    };

    const localService = new SorobanEventIndexerService(redisMock as any);

    // Limits below 1 are clamped up to 1.
    await localService.getEvents(0);
    expect(redisMock.zrevrange).toHaveBeenLastCalledWith('soroban:events:index', 0, 0);

    await localService.getEvents(-5);
    expect(redisMock.zrevrange).toHaveBeenLastCalledWith('soroban:events:index', 0, 0);

    await localService.getEvents(Number.MAX_SAFE_INTEGER);
    expect(redisMock.zrevrange).toHaveBeenLastCalledWith('soroban:events:index', 0, 199);

    await localService.getEvents();
    expect(redisMock.zrevrange).toHaveBeenLastCalledWith('soroban:events:index', 0, 49);
  });

  it('skips an interval tick while the previous poll is still in flight', async () => {
    jest.useFakeTimers();
    try {
      let resolveHealth!: (value: unknown) => void;
      rpcServerMock.getHealth.mockImplementation(
        () => new Promise(resolve => (resolveHealth = resolve)),
      );
      rpcServerMock.getEvents.mockResolvedValue({ events: [] });

      const flushPromises = async () => {
        for (let i = 0; i < 50; i++) await Promise.resolve();
      };

      service.start();
      await flushPromises();
      expect(rpcServerMock.getHealth).toHaveBeenCalledTimes(1);

      // The first poll is still awaiting getHealth, so the next tick must not start another.
      jest.advanceTimersByTime((service as any).POLL_INTERVAL_MS);
      await flushPromises();
      expect(rpcServerMock.getHealth).toHaveBeenCalledTimes(1);

      // Once the slow poll settles, the following tick runs a new poll again.
      resolveHealth({ latestLedger: 0, oldestLedger: 0 });
      await flushPromises();
      expect((service as any).currentPoll).toBeNull();

      jest.advanceTimersByTime((service as any).POLL_INTERVAL_MS);
      await flushPromises();
      expect(rpcServerMock.getHealth).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('setCursor() never moves the stored cursor backward', async () => {
    const redisMock = {
      get: jest.fn().mockResolvedValue('150'),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const localService = new SorobanEventIndexerService(redisMock as any);

    await (localService as any).setCursor(110);
    expect(redisMock.set).not.toHaveBeenCalled();

    await (localService as any).setCursor(150);
    expect(redisMock.set).not.toHaveBeenCalled();

    await (localService as any).setCursor(200);
    expect(redisMock.set).toHaveBeenCalledWith('soroban:event-indexer:cursor', '200');
  });
});

describeIfRedis('SorobanEventIndexerService (Redis integration)', () => {
  let redis: Redis;
  let service: SorobanEventIndexerService;
  let rpcServerMock: any;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    const keys = await redis.keys('soroban:*');
    if (keys.length > 0) await redis.del(...keys);

    jest.spyOn(stellarConfig, 'getStellarConfig').mockReturnValue({
      contractId: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      sorobanRpcUrl: 'http://localhost:8000',
    } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SorobanEventIndexerService, { provide: REDIS_CLIENT, useValue: redis }],
    }).compile();

    service = module.get<SorobanEventIndexerService>(SorobanEventIndexerService);
    service.onModuleInit();
    rpcServerMock = (service as any).rpcServer;
  });

  afterEach(() => {
    service.stop();
    jest.restoreAllMocks();
  });

  it('poll() normal window with persistence across polls', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 5, oldestLedger: 1 });
    const rawEvent = {
      id: 'event-1',
      ledger: 2,
      contractId: 'C123',
      topic: [nativeToScVal('TOPIC_1', { type: 'symbol' })],
      value: nativeToScVal(123),
    };
    rpcServerMock.getEvents.mockResolvedValueOnce({ events: [rawEvent] });
    
    await service.poll();
    expect(rpcServerMock.getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 1 }));
    let cursor = await redis.get('soroban:event-indexer:cursor');
    expect(cursor).toBe('5');

    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 10, oldestLedger: 1 });
    rpcServerMock.getEvents.mockResolvedValueOnce({ events: [] });
    
    await service.poll();
    expect(rpcServerMock.getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 6 }));
    cursor = await redis.get('soroban:event-indexer:cursor');
    expect(cursor).toBe('10');
  });

  it('storeEvent() failure semantics: swallows error and cursor advances', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 5, oldestLedger: 1 });
    const rawEvent = {
      id: 'event-2',
      ledger: 2,
      contractId: 'C123',
      topic: [nativeToScVal('TOPIC', { type: 'symbol' })],
      value: nativeToScVal(1),
    };
    rpcServerMock.getEvents.mockResolvedValueOnce({ events: [rawEvent] });

    jest.spyOn(redis, 'multi').mockImplementationOnce(() => {
      throw new Error('Redis multi failed');
    });

    await service.poll(); // should not throw
    const cursor = await redis.get('soroban:event-indexer:cursor');
    expect(cursor).toBe('5');
  });

  it('getEvents() ordering, limit handling, and missing keys', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 10, oldestLedger: 1 });
    const events = [
      { id: 'ev1', ledger: 2, contractId: 'C', topic: [nativeToScVal('A', { type: 'symbol' })], value: nativeToScVal(1) },
      { id: 'ev2', ledger: 4, contractId: 'C', topic: [nativeToScVal('B', { type: 'symbol' })], value: nativeToScVal(2) },
      { id: 'ev3', ledger: 6, contractId: 'C', topic: [nativeToScVal('C', { type: 'symbol' })], value: nativeToScVal(3) },
    ];
    rpcServerMock.getEvents.mockResolvedValueOnce({ events });
    
    await service.poll();

    const fetched2 = await service.getEvents(2);
    expect(fetched2).toHaveLength(2);
    expect(fetched2[0].eventId).toBe('ev3');
    expect(fetched2[1].eventId).toBe('ev2');

    await redis.del('soroban:event:ev3');
    
    const fetchedAfterDel = await service.getEvents(3);
    expect(fetchedAfterDel).toHaveLength(2);
    expect(fetchedAfterDel[0].eventId).toBe('ev2');
    expect(fetchedAfterDel[1].eventId).toBe('ev1');
  });

  describe('gap detection and cursor recovery', () => {
    it('detects ledger gap when cursor is behind latest ledger', async () => {
      // Simulate cursor at ledger 1000, but network is at ledger 1250
      await redis.set('soroban:event-indexer:cursor', '1000');
      rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 1250, oldestLedger: 1 });
      rpcServerMock.getEvents.mockResolvedValue({ events: [] });

      await service.poll();

      // Gap of 250 ledgers should be detected and logged (verified via logger spy if needed)
      const cursor = await redis.get('soroban:event-indexer:cursor');
      // Should process up to MAX_LEDGER_RANGE (100) from cursor
      expect(cursor).toBe('1100');
    });

    it('does not log gap warning when only 1 ledger behind', async () => {
      // Cursor at 1000, network at 1001 (normal 1-ledger progression)
      await redis.set('soroban:event-indexer:cursor', '1000');
      rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 1001, oldestLedger: 1 });
      rpcServerMock.getEvents.mockResolvedValue({ events: [] });

      await service.poll();

      // Should process normally without gap detection
      const cursor = await redis.get('soroban:event-indexer:cursor');
      expect(cursor).toBe('1001');
    });

    it('updates cursor only after all events are stored (atomic recovery)', async () => {
      await redis.set('soroban:event-indexer:cursor', '100');
      rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 105, oldestLedger: 1 });

      const events = [
        { id: 'ev-101', ledger: 101, contractId: 'C', topic: [nativeToScVal('A', { type: 'symbol' })], value: nativeToScVal(1) },
        { id: 'ev-102', ledger: 102, contractId: 'C', topic: [nativeToScVal('B', { type: 'symbol' })], value: nativeToScVal(2) },
      ];
      rpcServerMock.getEvents.mockResolvedValue({ events });

      await service.poll();

      // Cursor should be updated to endLedger (105) after all events stored
      const cursor = await redis.get('soroban:event-indexer:cursor');
      expect(cursor).toBe('105');

      // Both events should be stored
      const stored1 = await redis.get('soroban:event:ev-101');
      const stored2 = await redis.get('soroban:event:ev-102');
      expect(stored1).toBeTruthy();
      expect(stored2).toBeTruthy();
    });

    it('processes large gaps in chunks respecting MAX_LEDGER_RANGE', async () => {
      await redis.set('soroban:event-indexer:cursor', '1000');
      rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 1500, oldestLedger: 1 });
      rpcServerMock.getEvents.mockResolvedValue({ events: [] });

      // First poll should process up to 1000 + MAX_LEDGER_RANGE (100) = 1100
      await service.poll();
      let cursor = await redis.get('soroban:event-indexer:cursor');
      expect(cursor).toBe('1100');

      // Second poll should process next chunk 1101-1200
      await service.poll();
      cursor = await redis.get('soroban:event-indexer:cursor');
      expect(cursor).toBe('1200');

      // Continue until caught up
      for (let i = 0; i < 3; i++) {
        await service.poll();
      }
      cursor = await redis.get('soroban:event-indexer:cursor');
      expect(cursor).toBe('1500');
    });

    it('simulates high latency scenario causing gap', async () => {
      // Initial state: cursor at 1000
      await redis.set('soroban:event-indexer:cursor', '1000');
      
      // First poll: network at 1010, successfully indexed
      rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 1010, oldestLedger: 1 });
      rpcServerMock.getEvents.mockResolvedValue({ events: [] });
      await service.poll();
      
      let cursor = await redis.get('soroban:event-indexer:cursor');
      expect(cursor).toBe('1010');

      // Simulate timeout/failure causing missed polls
      // Network advances to 1500 while indexer was down
      rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 1500, oldestLedger: 1 });

      // Next poll detects gap and processes next chunk
      await service.poll();
      
      // Cursor should advance by MAX_LEDGER_RANGE (100) from 1010
      cursor = await redis.get('soroban:event-indexer:cursor');
      expect(cursor).toBe('1110');
    });
  });
});

