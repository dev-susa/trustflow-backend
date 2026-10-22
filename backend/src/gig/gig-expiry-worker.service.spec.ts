import { GigExpiryWorkerService } from './gig-expiry-worker.service';
import { GigService } from './gig.service';
import { Gig, GigStatus } from './gig.entity';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { MetricsService } from '../monitoring/metrics.service';
import { SentryService } from '../sentry/sentry.service';
import { resetEnvConfig, setTestEnv } from '../config/env.config';

/** Flushes the microtask queue so chained awaits inside a fake-timer tick settle. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** Always grants the lock — the distributed-lock mechanics themselves are covered by distributed-lock.service.spec.ts. */
function fakeLock(): jest.Mocked<Pick<DistributedLockService, 'tryAcquire' | 'release' | 'renewIfOwned'>> {
  return {
    tryAcquire: jest.fn().mockResolvedValue('fake-token'),
    release: jest.fn().mockResolvedValue(undefined),
    renewIfOwned: jest.fn().mockResolvedValue(true),
  };
}

function fakeMetrics(): jest.Mocked<MetricsService> {
  return {
    increment: jest.fn(),
    getAll: jest.fn().mockReturnValue([]),
    toPrometheus: jest.fn().mockReturnValue(''),
  } as unknown as jest.Mocked<MetricsService>;
}

function fakeSentry(): jest.Mocked<SentryService> {
  return {
    captureException: jest.fn().mockReturnValue(''),
    captureMessage: jest.fn().mockReturnValue(''),
    isInitialized: jest.fn().mockReturnValue(false),
    init: jest.fn(),
  } as unknown as jest.Mocked<SentryService>;
}

function makeGig(id: string, status: GigStatus): Gig {
  return {
    id,
    creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    title: 'Test gig',
    budgetXLM: '100',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    respondBy: '2026-01-01T01:00:00.000Z',
    version: 1,
  };
}

describe('GigExpiryWorkerService', () => {
  const originalInterval = process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;
  let gigService: jest.Mocked<Pick<GigService, 'findExpirable' | 'expire'>>;
  let metrics: jest.Mocked<MetricsService>;
  let sentry: jest.Mocked<SentryService>;
  let worker: GigExpiryWorkerService;

  beforeEach(() => {
    resetEnvConfig();
    setTestEnv({ GIG_EXPIRY_SWEEP_CONCURRENCY: '8' });
    gigService = {
      findExpirable: jest.fn().mockResolvedValue([]),
      expire: jest.fn(),
    };
    metrics = fakeMetrics();
    sentry = fakeSentry();
    worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      fakeLock() as unknown as DistributedLockService,
      metrics,
      sentry,
    );
  });

  afterEach(() => {
    worker.onModuleDestroy();
    jest.useRealTimers();
    resetEnvConfig();
    if (originalInterval === undefined) delete process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;
    else process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = originalInterval;
  });

  describe('runOnce', () => {
    it('expires every gig returned by findExpirable; GigService persists the outbox event', async () => {
      const expiredGig = {
        ...makeGig('gig-a', GigStatus.EXPIRED),
        expiredAt: '2026-01-01T02:00:00.000Z',
      };
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(expiredGig);

      await worker.runOnce();

      expect(gigService.expire).toHaveBeenCalledWith('gig-a');
    });

    it('skips already-resolved gigs', async () => {
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(undefined);

      await worker.runOnce();

      expect(gigService.expire).toHaveBeenCalledWith('gig-a');
    });

    it('processes every expirable gig even when the list has multiple entries', async () => {
      gigService.findExpirable.mockResolvedValue([
        makeGig('gig-a', GigStatus.OPEN),
        makeGig('gig-b', GigStatus.OPEN),
      ]);
      gigService.expire.mockImplementation(async id => makeGig(id, GigStatus.EXPIRED));

      await worker.runOnce();

      expect(gigService.expire).toHaveBeenCalledTimes(2);
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('schedules periodic sweeps at the default interval', () => {
      jest.useFakeTimers();
      delete process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(makeGig('gig-a', GigStatus.EXPIRED));

      worker.onModuleInit();
      expect(gigService.expire).not.toHaveBeenCalled();

      jest.advanceTimersByTime(5 * 60 * 1000);
      return flushPromises().then(() => {
        expect(gigService.expire).toHaveBeenCalledWith('gig-a');
      });
    });

    it('honors a custom GIG_EXPIRY_SWEEP_INTERVAL_MS', () => {
      jest.useFakeTimers();
      process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = '1000';
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(makeGig('gig-a', GigStatus.EXPIRED));

      worker.onModuleInit();
      jest.advanceTimersByTime(999);
      expect(gigService.expire).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      return flushPromises().then(() => {
        expect(gigService.expire).toHaveBeenCalledWith('gig-a');
      });
    });

    it('does not schedule a sweep when the interval is disabled', () => {
      jest.useFakeTimers();
      process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = '0';

      worker.onModuleInit();
      jest.advanceTimersByTime(60 * 60 * 1000);

      expect(gigService.findExpirable).not.toHaveBeenCalled();
    });

    it('stops sweeping once destroyed', () => {
      jest.useFakeTimers();
      process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = '1000';
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);

      worker.onModuleInit();
      worker.onModuleDestroy();
      jest.advanceTimersByTime(10000);

      expect(gigService.findExpirable).not.toHaveBeenCalled();
    });
  });
});

describe('GigExpiryWorkerService — concurrency & non-overlap (#236)', () => {
  const originalInterval = process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;

  afterEach(() => {
    if (originalInterval === undefined) delete process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;
    else process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = originalInterval;
    jest.useRealTimers();
    resetEnvConfig();
  });

  function slowGigService(
    perGigMs: number,
  ): jest.Mocked<Pick<GigService, 'findExpirable' | 'expire'>> {
    const gigs = Array.from({ length: 10 }, (_, i) => makeGig(`g${i}`, GigStatus.OPEN));
    return {
      findExpirable: jest.fn().mockResolvedValue(gigs),
      expire: jest
        .fn()
        .mockImplementation(() => new Promise(r => setTimeout(() => r(true), perGigMs))),
    };
  }

  it('expires gigs concurrently — a 10-gig sweep is far faster than 10x one gig', async () => {
    resetEnvConfig();
    setTestEnv({ GIG_EXPIRY_SWEEP_CONCURRENCY: '8' });
    const gigService = slowGigService(20);
    const worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      fakeLock() as unknown as DistributedLockService,
      fakeMetrics(),
      fakeSentry(),
    );

    const start = Date.now();
    await worker.runOnce();
    const elapsed = Date.now() - start;

    expect(gigService.expire).toHaveBeenCalledTimes(10);
    // Sequential would be ~200ms; bounded-concurrency finishes well under half.
    expect(elapsed).toBeLessThan(120);
  });

  it('skips a tick while a previous sweep is still running', async () => {
    jest.useFakeTimers();
    process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = '10';
    resetEnvConfig();
    setTestEnv({ GIG_EXPIRY_SWEEP_INTERVAL_MS: '10', GIG_EXPIRY_SWEEP_CONCURRENCY: '8' });

    let resolveSweep!: () => void;
    const gigService: jest.Mocked<Pick<GigService, 'findExpirable' | 'expire'>> = {
      findExpirable: jest.fn().mockReturnValue(new Promise<never>(() => {})),
      expire: jest.fn(),
    };
    // First sweep hangs until we release it.
    gigService.findExpirable.mockImplementationOnce(
      () =>
        new Promise(res => {
          resolveSweep = () => res([]);
        }),
    );

    const lock = fakeLock();
    const worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      lock as unknown as DistributedLockService,
      fakeMetrics(),
      fakeSentry(),
    );
    worker.onModuleInit();

    jest.advanceTimersByTime(35); // several ticks while the first sweep is stuck
    await flushPromises();

    // Only the first tick got past the in-flight guard.
    expect(gigService.findExpirable).toHaveBeenCalledTimes(1);

    resolveSweep();
    await flushPromises();
    worker.onModuleDestroy();
  });

  it('caps gigs per sweep and continues on next tick', async () => {
    resetEnvConfig();
    setTestEnv({ GIG_EXPIRY_SWEEP_CONCURRENCY: '8', GIG_EXPIRY_SWEEP_MAX_GIGS: '3' });
    const gigs = Array.from({ length: 10 }, (_, i) => makeGig(`g${i}`, GigStatus.OPEN));
    const gigService: jest.Mocked<Pick<GigService, 'findExpirable' | 'expire'>> = {
      findExpirable: jest.fn().mockResolvedValue(gigs),
      expire: jest
        .fn()
        .mockImplementation(async id => makeGig(id, GigStatus.EXPIRED)),
    };

    const worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      fakeLock() as unknown as DistributedLockService,
      fakeMetrics(),
      fakeSentry(),
    );

    await worker.runOnce();

    // Should only expire 3 gigs even though 10 are available
    expect(gigService.expire).toHaveBeenCalledTimes(3);
    expect(gigService.expire).toHaveBeenCalledWith('g0');
    expect(gigService.expire).toHaveBeenCalledWith('g1');
    expect(gigService.expire).toHaveBeenCalledWith('g2');
  });

  it('logs and captures per-gig failures with details', async () => {
    resetEnvConfig();
    setTestEnv({ GIG_EXPIRY_SWEEP_CONCURRENCY: '2' });
    const gigService: jest.Mocked<Pick<GigService, 'findExpirable' | 'expire'>> = {
      findExpirable: jest.fn().mockResolvedValue([
        makeGig('g1', GigStatus.OPEN),
        makeGig('g2', GigStatus.OPEN),
      ]),
      expire: jest.fn().mockImplementation(async id => {
        if (id === 'g1') throw new Error('Redis timeout');
        return makeGig(id, GigStatus.EXPIRED);
      }),
    };
    const sentry = fakeSentry();

    const worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      fakeLock() as unknown as DistributedLockService,
      fakeMetrics(),
      sentry,
    );

    await worker.runOnce();

    // Should capture the batch failure to Sentry
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), 'GigExpiryWorkerService');
    const error = (sentry.captureException as jest.Mock).mock.calls[0][0] as Error & {
      failedGigs?: Array<{ id: string; error: string }>;
    };
    expect(error.failedGigs).toEqual([{ id: 'g1', error: 'Redis timeout' }]);
  });

  it('emits metrics for sweep runs', async () => {
    resetEnvConfig();
    setTestEnv({ GIG_EXPIRY_SWEEP_CONCURRENCY: '2' });
    const gigService: jest.Mocked<Pick<GigService, 'findExpirable' | 'expire'>> = {
      findExpirable: jest.fn().mockResolvedValue([
        makeGig('g1', GigStatus.OPEN),
        makeGig('g2', GigStatus.OPEN),
      ]),
      expire: jest.fn().mockImplementation(async id => makeGig(id, GigStatus.EXPIRED)),
    };
    const metrics = fakeMetrics();

    const worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      fakeLock() as unknown as DistributedLockService,
      metrics,
      fakeSentry(),
    );

    await worker.runOnce();

    // Should emit metrics for successful sweep
    expect(metrics.increment).toHaveBeenCalledWith(
      'gig_expiry_sweep_duration_ms',
      expect.objectContaining({ status: 'success' }),
    );
    expect(metrics.increment).toHaveBeenCalledWith('gig_expiry_sweep_gigs_expired_total', {}, 2);
    expect(metrics.increment).toHaveBeenCalledWith('gig_expiry_sweep_gigs_failed_total', {}, 0);
  });
});
