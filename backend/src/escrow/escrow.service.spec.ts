import { Test, TestingModule } from '@nestjs/testing';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  EscrowService,
  ESCROW_PERSISTENCE_FALLBACK_METRIC,
  ESCROW_TRANSACTION_INCONSISTENT_METRIC,
} from './escrow.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { makeFakeRedisClient } from '../testing/fake-redis-client';

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('EscrowService', () => {
  let service: EscrowService;
  let metrics: jest.Mocked<Pick<MetricsService, 'increment'>>;

  const DEPOSITOR = 'GDEPOSITOR111111111111111111111111111111111111111111111';
  const BENEFICIARY = 'GBENEFICIARY1111111111111111111111111111111111111111111';
  const AMOUNT = '100';

  async function buildService(redis: unknown): Promise<EscrowService> {
    metrics = { increment: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EscrowService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    return module.get<EscrowService>(EscrowService);
  }

  describe.each([
    ['with Redis', () => makeFakeRedisClient()],
    ['without Redis (fallback to memory)', () => null],
  ])('%s', (_label, makeRedis) => {
    beforeEach(async () => {
      service = await buildService(makeRedis());
    });

    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    // ─── create() ─────────────────────────────────────────────────────────────

    describe('create()', () => {
      it('returns a new escrow with status "pending"', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);

        expect(escrow.id).toBeDefined();
        expect(escrow.depositor).toBe(DEPOSITOR);
        expect(escrow.beneficiary).toBe(BENEFICIARY);
        expect(escrow.amountXLM).toBe(AMOUNT);
        expect(escrow.status).toBe('pending');
        expect(escrow.createdAt).toBeDefined();
      });

      it('generates a unique id for each escrow', async () => {
        const a = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        const b = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        expect(a.id).not.toBe(b.id);
      });

      it('persists the escrow so it can be retrieved by findById()', async () => {
        const created = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        const found = await service.findById(created.id);
        expect(found).toEqual(created);
      });

      it('does not set disputeReason or disputedAt on creation', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        expect(escrow.disputeReason).toBeUndefined();
        expect(escrow.disputedAt).toBeUndefined();
      });

      it('still stores a self-dealing escrow (depositor === beneficiary) but logs a warning (#437)', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        const escrow = await service.create(DEPOSITOR, DEPOSITOR, AMOUNT);

        expect(escrow.depositor).toBe(DEPOSITOR);
        expect(escrow.beneficiary).toBe(DEPOSITOR);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('self-dealing'));

        warnSpy.mockRestore();
      });

      it('generates unique IDs even when called concurrently in a tight loop', async () => {
        const numEscrows = 200;
        const promises: Promise<import('./escrow.service').Escrow>[] = [];
        for (let i = 0; i < numEscrows; i++) {
          promises.push(service.create(`GDEP${i}`, `GBEN${i}`, '100'));
        }

        const escrows = await Promise.all(promises);
        const ids = new Set(escrows.map(e => e.id));

        expect(ids.size).toBe(numEscrows);

        const sampleId = escrows[0].id;
        expect(sampleId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      });
    });

    // ─── findById() ───────────────────────────────────────────────────────────

    describe('findById()', () => {
      it('returns undefined for an unknown id (does not throw)', async () => {
        const result = await service.findById('esc-unknown');
        expect(result).toBeUndefined();
      });

      it('returns the escrow after it has been created', async () => {
        const created = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        expect(await service.findById(created.id)).toEqual(created);
      });
    });

    // ─── findByDepositor() ────────────────────────────────────────────────────

    describe('findByDepositor()', () => {
      it('returns an empty array when no escrows exist for that depositor', async () => {
        expect((await service.findByDepositor(DEPOSITOR)).data).toEqual([]);
      });

      it('returns only escrows belonging to the given depositor', async () => {
        const OTHER = 'GOTHER111111111111111111111111111111111111111111111111111';
        const mine = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        await service.create(OTHER, BENEFICIARY, AMOUNT);

        const results = await service.findByDepositor(DEPOSITOR);
        expect(results.data).toHaveLength(1);
        expect(results.data[0].id).toBe(mine.id);
      });

      it('returns multiple escrows for the same depositor', async () => {
        await service.create(DEPOSITOR, BENEFICIARY, '50');
        await service.create(DEPOSITOR, BENEFICIARY, '75');

        const results = await service.findByDepositor(DEPOSITOR);
        expect(results.data).toHaveLength(2);
      });

      it('returns paginated results for a depositor', async () => {
        for (let i = 0; i < 5; i++) {
          await service.create('GDEP', 'GBEN', '100');
        }
        await service.create('GOTHER', 'GBEN', '200');

        const result = await service.findByDepositor('GDEP', 0, 3);

        expect(result.total).toBe(5);
        expect(result.data).toHaveLength(3);
      });

      it('returns empty data when offset exceeds total', async () => {
        await service.create('GDEP', 'GBEN', '100');

        const result = await service.findByDepositor('GDEP', 10, 20);

        expect(result.total).toBe(1);
        expect(result.data).toHaveLength(0);
      });

      it('returns empty data for unknown depositor', async () => {
        await service.create('GDEP', 'GBEN', '100');

        const result = await service.findByDepositor('GUNKNOWN', 0, 20);

        expect(result.total).toBe(0);
        expect(result.data).toHaveLength(0);
      });
    });

    // ─── fund() ───────────────────────────────────────────────────────────────

    describe('fund()', () => {
      it('transitions a "pending" escrow to "active"', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        const funded = await service.fund(escrow.id);
        expect(funded.status).toBe('active');
      });

      it('throws when trying to fund a non-pending escrow', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        await service.fund(escrow.id); // now active

        await expect(service.fund(escrow.id)).rejects.toThrow('Cannot fund escrow in status');
      });

      it('throws when the escrow id is unknown', async () => {
        await expect(service.fund('esc-unknown')).rejects.toThrow('Escrow not found');
      });
    });

    // ─── release() ────────────────────────────────────────────────────────────

    describe('release()', () => {
      it('sets status to "released"', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        const released = await service.release(escrow.id);
        expect(released.status).toBe('released');
      });

      it('releases an escrow regardless of its current status', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        await service.fund(escrow.id);
        const released = await service.release(escrow.id);
        expect(released.status).toBe('released');
      });

      it('throws when the escrow id is unknown', async () => {
        await expect(service.release('esc-unknown')).rejects.toThrow('Escrow not found');
      });
    });

    // ─── cancel() ─────────────────────────────────────────────────────────────

    describe('cancel()', () => {
      it('sets status to "cancelled"', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        const cancelled = await service.cancel(escrow.id);
        expect(cancelled.status).toBe('cancelled');
      });

      it('throws when the escrow id is unknown', async () => {
        await expect(service.cancel('esc-unknown')).rejects.toThrow('Escrow not found');
      });
    });

    // ─── split() ──────────────────────────────────────────────────────────────

    describe('split()', () => {
      it('sets status to "released" and records the splitPercentage', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        const result = await service.split(escrow.id, 60);

        expect(result.status).toBe('released');
        expect(result.splitPercentage).toBe(60);
      });

      it('throws when the escrow id is unknown', async () => {
        await expect(service.split('esc-unknown', 50)).rejects.toThrow('Escrow not found');
      });
    });

    // ─── raiseDispute() ───────────────────────────────────────────────────────

    describe('raiseDispute()', () => {
      const activeEscrow = async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        return service.fund(escrow.id);
      };

      it('transitions an "active" escrow to "disputed" and records reason + timestamp', async () => {
        const escrow = await activeEscrow();
        const disputed = await service.raiseDispute(escrow.id, 'Work not delivered');

        expect(disputed.status).toBe('disputed');
        expect(disputed.disputeReason).toBe('Work not delivered');
        expect(disputed.disputedAt).toBeDefined();
        expect(new Date(disputed.disputedAt!).toISOString()).toBe(disputed.disputedAt);
      });

      it('works without a reason argument', async () => {
        const escrow = await activeEscrow();
        const disputed = await service.raiseDispute(escrow.id);

        expect(disputed.status).toBe('disputed');
        expect(disputed.disputeReason).toBeUndefined();
      });

      it.each(['pending', 'cancelled'] as const)(
        'rejects a %s escrow — only active escrows can start a dispute (#633)',
        async status => {
          const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
          await service.correctStatus(escrow.id, { status });

          await expect(service.raiseDispute(escrow.id, 'x')).rejects.toThrow(
            `Cannot dispute a ${status} escrow`,
          );
          expect((await service.findById(escrow.id))?.status).toBe(status);
        },
      );

      it('throws when the escrow is already released (guard: cannot dispute released)', async () => {
        const escrow = await activeEscrow();
        await service.correctStatus(escrow.id, { status: 'released' });

        await expect(service.raiseDispute(escrow.id, 'too late')).rejects.toThrow(
          'Cannot dispute a released escrow',
        );
      });

      it('throws when the escrow is already disputed (guard: cannot double-dispute)', async () => {
        const escrow = await activeEscrow();
        await service.raiseDispute(escrow.id, 'first dispute');

        await expect(service.raiseDispute(escrow.id, 'second dispute')).rejects.toThrow(
          'Escrow is already disputed',
        );
      });

      it('throws when the escrow id is unknown', async () => {
        await expect(service.raiseDispute('esc-unknown', 'reason')).rejects.toThrow(
          'Escrow not found',
        );
      });

      it('does not change status when raiseDispute throws', async () => {
        const escrow = await activeEscrow();
        await service.correctStatus(escrow.id, { status: 'released' });

        try {
          await service.raiseDispute(escrow.id, 'after release');
        } catch {
          // expected
        }

        const reloaded = await service.findById(escrow.id);
        expect(reloaded?.status).toBe('released');
      });
    });

    describe('correctStatus({ clearDispute })', () => {
      it('restores the prior status and clears the dispute fields (#635)', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        await service.fund(escrow.id);
        await service.raiseDispute(escrow.id, 'undo me');

        const restored = await service.correctStatus(escrow.id, {
          status: 'active',
          clearDispute: true,
        });

        expect(restored.status).toBe('active');
        expect(restored.disputeReason).toBeUndefined();
        expect(restored.disputedAt).toBeUndefined();
        expect((await service.findById(escrow.id))?.disputedAt).toBeUndefined();
      });
    });

    // ─── applyChainState() ────────────────────────────────────────────────────

    describe('applyChainState()', () => {
      it('overwrites status regardless of guard rules', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        await service.release(escrow.id); // status = released

        const patched = await service.applyChainState(escrow.id, { status: 'disputed' });
        expect(patched.status).toBe('disputed');
      });

      it('rejects a status outside EscrowStatus and leaves the escrow untouched', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        await expect(
          service.applyChainState(escrow.id, { status: 'Bogus' as never }),
        ).rejects.toThrow('Invalid escrow status');
        expect((await service.findById(escrow.id))?.status).toBe('pending');
      });

      it('updates amountXLM when provided', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, '100');
        const patched = await service.applyChainState(escrow.id, { amountXLM: '200' });
        expect(patched.amountXLM).toBe('200');
      });

      it('only applies the fields present in the patch', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, '100');
        await service.applyChainState(escrow.id, { amountXLM: '150' });

        const reloaded = await service.findById(escrow.id);
        expect(reloaded?.status).toBe('pending'); // unchanged
        expect(reloaded?.amountXLM).toBe('150');
      });

      it('throws when the escrow id is unknown', async () => {
        await expect(service.applyChainState('esc-unknown', { status: 'active' })).rejects.toThrow(
          'Escrow not found',
        );
      });
    });

    // ─── correctStatus() ──────────────────────────────────────────────────────

    describe('correctStatus()', () => {
      it('overwrites status regardless of guard rules', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        await service.release(escrow.id);

        const corrected = await service.correctStatus(escrow.id, { status: 'disputed' });
        expect(corrected.status).toBe('disputed');
      });

      it('sets requiresManualReview', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        const corrected = await service.correctStatus(escrow.id, {
          status: 'disputed',
          requiresManualReview: true,
        });

        expect(corrected.requiresManualReview).toBe(true);
        const reloaded = await service.findById(escrow.id);
        expect(reloaded?.requiresManualReview).toBe(true);
      });

      it('throws when the escrow id is unknown', async () => {
        await expect(service.correctStatus('esc-unknown', { status: 'active' })).rejects.toThrow(
          'Escrow not found',
        );
      });
    });

    // ─── findAll() ────────────────────────────────────────────────────────────

    describe('findAll()', () => {
      it('returns an empty array when no escrows exist', async () => {
        expect(await service.findAll()).toEqual([]);
      });

      it('returns all created escrows', async () => {
        await service.create(DEPOSITOR, BENEFICIARY, '50');
        await service.create(DEPOSITOR, BENEFICIARY, '75');

        const all = await service.findAll();
        expect(all).toHaveLength(2);
      });
    });

    // ─── findByContractEscrowId() / linkContractEscrowId() ─────────────────────

    describe('linkContractEscrowId() / findByContractEscrowId()', () => {
      it('links an escrow to a contract id and makes it findable by that id', async () => {
        const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
        await service.linkContractEscrowId(escrow.id, 'contract-abc');

        const found = await service.findByContractEscrowId('contract-abc');
        expect(found?.id).toBe(escrow.id);
        expect(found?.contractEscrowId).toBe('contract-abc');
      });

      it('returns undefined for an unknown contract id', async () => {
        expect(await service.findByContractEscrowId('contract-unknown')).toBeUndefined();
      });

      it('throws when the escrow id is unknown', async () => {
        await expect(service.linkContractEscrowId('esc-unknown', 'contract-abc')).rejects.toThrow(
          'Escrow not found',
        );
      });
    });

    // ─── createFromChainState() ─────────────────────────────────────────────

    describe('createFromChainState()', () => {
      it('creates a row directly findable by both id and contractEscrowId', async () => {
        const created = await service.createFromChainState({
          contractEscrowId: 'contract-xyz',
          depositor: DEPOSITOR,
          beneficiary: BENEFICIARY,
          amountXLM: AMOUNT,
          status: 'active',
        });

        expect(created.status).toBe('active');
        expect(await service.findById(created.id)).toEqual(created);
        expect((await service.findByContractEscrowId('contract-xyz'))?.id).toBe(created.id);
      });

      it('still stores a self-dealing escrow found on-chain but logs a warning (#437)', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        const escrow = await service.createFromChainState({
          contractEscrowId: 'chain-esc-2',
          depositor: DEPOSITOR,
          beneficiary: DEPOSITOR,
          amountXLM: AMOUNT,
          status: 'active',
        });

        expect(escrow.depositor).toBe(escrow.beneficiary);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('self-dealing'));

        warnSpy.mockRestore();
      });
    });
  });

  // ─── Redis failure fallback ───────────────────────────────────────────────

  describe('Redis failure', () => {
    it('falls back to memory and records the fallback metric when Redis throws', async () => {
      const redis = makeFakeRedisClient();
      redis.get.mockRejectedValue(new Error('Redis down'));
      redis.multi.mockImplementation(() => {
        throw new Error('Redis down');
      });
      service = await buildService(redis);

      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);

      expect(escrow.status).toBe('pending');
      expect(metrics.increment).toHaveBeenCalledWith(ESCROW_PERSISTENCE_FALLBACK_METRIC, {
        operation: 'create',
      });
    });

    it('refuses to report success when a queued MULTI command fails', async () => {
      // Redis does NOT roll back the commands that already ran, so a per-command failure
      // means part of the write is already durable. Reporting success here (and falling back
      // to memory) is what produced inconsistent state.
      const redis = makeFakeRedisClient();
      redis.mockNextExecResult(() =>
        Promise.resolve([
          [null, 'OK'],
          [new Error('WRONGTYPE'), null],
        ]),
      );
      service = await buildService(redis);

      await expect(service.create(DEPOSITOR, BENEFICIARY, AMOUNT)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(metrics.increment).toHaveBeenCalledWith(ESCROW_TRANSACTION_INCONSISTENT_METRIC, {
        operation: 'create',
        reason: 'command-failed',
      });
      // The in-memory fallback must NOT have been used for an integrity failure.
      expect(metrics.increment).not.toHaveBeenCalledWith(
        ESCROW_PERSISTENCE_FALLBACK_METRIC,
        expect.anything(),
      );
    });

    it('refuses to report success when exec() resolves null (an aborted transaction)', async () => {
      const redis = makeFakeRedisClient();
      redis.mockNextExecResult(() => Promise.resolve(null));
      service = await buildService(redis);

      await expect(service.create(DEPOSITOR, BENEFICIARY, AMOUNT)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(metrics.increment).toHaveBeenCalledWith(ESCROW_TRANSACTION_INCONSISTENT_METRIC, {
        operation: 'create',
        reason: 'aborted',
      });
      expect(metrics.increment).not.toHaveBeenCalledWith(
        ESCROW_PERSISTENCE_FALLBACK_METRIC,
        expect.anything(),
      );
    });

    it('still falls back to memory for a genuine connectivity failure', async () => {
      // A connection error means nothing was applied, so degrading is safe and keeps the
      // app available. This is deliberately different from the two cases above.
      const redis = makeFakeRedisClient();
      redis.get.mockRejectedValue(new Error('Redis down'));
      redis.multi.mockImplementation(() => {
        throw new Error('Redis down');
      });
      service = await buildService(redis);

      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);

      expect(escrow.status).toBe('pending');
      expect(metrics.increment).toHaveBeenCalledWith(ESCROW_PERSISTENCE_FALLBACK_METRIC, {
        operation: 'create',
      });
    });
  });

  describe('onModuleInit', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('throws in production when Redis is not configured', async () => {
      process.env.NODE_ENV = 'production';
      service = await buildService(null);

      expect(() => service.onModuleInit()).toThrow(/requires REDIS_URL/);
    });

    it('does not throw in production when Redis is configured', async () => {
      process.env.NODE_ENV = 'production';
      service = await buildService(makeFakeRedisClient());

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('does not throw outside production even without Redis', async () => {
      process.env.NODE_ENV = 'test';
      service = await buildService(null);

      expect(() => service.onModuleInit()).not.toThrow();
    });
  });
});
