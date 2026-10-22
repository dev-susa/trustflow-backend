import { HealthService } from './health.service';
import { DatabaseService } from '../common/database/database.service';
import { DrainStateService } from '../common/shutdown/drain-state.service';
import type { Redis } from 'ioredis';

describe('HealthService', () => {
  const originalFetch = global.fetch;
  const originalMemoryUsage = process.memoryUsage;

  beforeEach(() => {
    mockLowMemoryUsage();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.memoryUsage = originalMemoryUsage;
  });

  function mockFetchOk(ok = true) {
    global.fetch = jest.fn().mockResolvedValue({ ok }) as any;
  }

  /**
   * The `memory` check reads real process heap usage — deterministic on its own, but
   * this suite runs alongside hundreds of other test files in the same process, so the
   * actual heap size at this point isn't something these tests should depend on. Pin it
   * well under the 500MB threshold so `status` reflects only what each test is exercising.
   */
  function mockLowMemoryUsage() {
    process.memoryUsage = jest.fn().mockReturnValue({
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      rss: 100 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    }) as any;
  }

  it('reports database: true when no DatabaseService is available (unit test wiring)', async () => {
    mockFetchOk(true);
    const service = new HealthService();

    const status = await service.check();

    expect(status.checks.database).toBe(true);
  });

  it('reports redis: true when no Redis client is configured', async () => {
    mockFetchOk(true);

    const status = await new HealthService().check();

    expect(status.checks.redis).toBe(true);
  });

  it('reports redis: true when Redis responds to ping', async () => {
    mockFetchOk(true);
    const redis = { ping: jest.fn().mockResolvedValue('PONG') } as unknown as any;

    const status = await new HealthService(undefined, redis).check();

    expect(status.checks.redis).toBe(true);
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('reports degraded when Redis is unreachable', async () => {
    mockFetchOk(true);
    const redis = { ping: jest.fn().mockRejectedValue(new Error('Redis down')) } as unknown as any;

    const status = await new HealthService(undefined, redis).check();

    expect(status.checks.redis).toBe(false);
    expect(status.status).toBe('degraded');
  });

  it('reports database: true when Postgres is not configured, without pinging', async () => {
    mockFetchOk(true);
    const database = { isConfigured: false, ping: jest.fn() } as unknown as DatabaseService;
    const service = new HealthService(database);

    const status = await service.check();

    expect(status.checks.database).toBe(true);
    expect(database.ping).not.toHaveBeenCalled();
  });

  it('reports database: true when Postgres is configured and ping succeeds', async () => {
    mockFetchOk(true);
    const database = {
      isConfigured: true,
      ping: jest.fn().mockResolvedValue(true),
    } as unknown as DatabaseService;
    const service = new HealthService(database);

    const status = await service.check();

    expect(status.checks.database).toBe(true);
    expect(database.ping).toHaveBeenCalled();
  });

  it('reports database: false and status degraded when Postgres is configured but unreachable', async () => {
    mockFetchOk(true);
    const database = {
      isConfigured: true,
      ping: jest.fn().mockResolvedValue(false),
    } as unknown as DatabaseService;
    const service = new HealthService(database);

    const status = await service.check();

    expect(status.checks.database).toBe(false);
    expect(status.status).toBe('degraded');
  });

  it('reports overall status ok when every check passes', async () => {
    mockFetchOk(true);
    const database = {
      isConfigured: true,
      ping: jest.fn().mockResolvedValue(true),
    } as unknown as DatabaseService;
    const service = new HealthService(database);

    const status = await service.check();

    expect(status.status).toBe('ok');
    expect(status.checks).toEqual({
      api: true,
      stellar: true,
      database: true,
      redis: true,
      memory: true,
    });
  });
});
