import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DisputeSagaService } from './dispute-saga.service';
import { DisputeSaga, DisputeStep, DisputeVerdict } from './dispute.types';
import { Escrow, EscrowService, EscrowStatus } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { NotificationService } from '../notification/notification.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { EscrowChainStateClient } from '../escrow-reconciliation/escrow-chain-state.client';
import { ArweaveArchiveService } from './arweave-archive.service';

// ─── Shared mock factories ────────────────────────────────────────────────────

function makeEscrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    id: 'esc-001',
    depositor: 'GDEPOSITOR111111111111111111111111111111111111111111111',
    beneficiary: 'GBENEFICIARY1111111111111111111111111111111111111111111',
    amountXLM: '100',
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildMocks() {
  const escrow = makeEscrow();

  const escrowService = {
    findById: jest.fn().mockResolvedValue(escrow),
    findAll: jest.fn().mockResolvedValue([escrow]),
    raiseDispute: jest.fn().mockImplementation((_id: string, reason: string) => {
      escrow.status = 'disputed';
      escrow.disputeReason = reason;
      escrow.disputedAt = new Date().toISOString();
      return Promise.resolve({ ...escrow });
    }),
    release: jest.fn().mockImplementation(() => {
      escrow.status = 'released';
      return Promise.resolve(escrow);
    }),
    cancel: jest.fn().mockImplementation(() => {
      escrow.status = 'cancelled';
      return Promise.resolve(escrow);
    }),
    split: jest.fn().mockImplementation((_id: string, splitPercentage: number) => {
      escrow.status = 'released';
      escrow.splitPercentage = splitPercentage;
      return Promise.resolve(escrow);
    }),
    correctStatus: jest.fn().mockImplementation((_id: string, patch: Record<string, unknown>) => {
      Object.assign(escrow, patch);
      return Promise.resolve(escrow);
    }),
    applyChainState: jest.fn().mockImplementation((_id: string, patch: Record<string, unknown>) => {
      Object.assign(escrow, patch);
      return Promise.resolve(escrow);
    }),
  };

  const webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const discordService = { notifyDisputeNeedsJurors: jest.fn().mockResolvedValue(undefined) };
  const notificationService = {
    notifyDisputeEscalated: jest.fn().mockResolvedValue(undefined),
    notifyJurorsAssigned: jest.fn().mockResolvedValue(undefined),
    notifyVerdictReached: jest.fn().mockResolvedValue(undefined),
    notifyPayoutExecuted: jest.fn().mockResolvedValue(undefined),
  };

  return {
    escrow,
    escrowService,
    webhookService,
    notificationService,
    discordService,
  };
}

const JURORS = [
  'GJUROR1111111111111111111111111111111111111111111111111111',
  'GJUROR2222222222222222222222222222222222222222222222222222',
  'GJUROR3333333333333333333333333333333333333333333333333333',
];

const ESCALATE_DTO = {
  initiator: 'GDEPOSITOR111111111111111111111111111111111111111111111',
  reason: 'Work was not delivered as agreed in the contract',
};

/** The saga's private persistence steps, for failure injection at each boundary. */
interface SagaPersistence {
  createSaga(saga: DisputeSaga): Promise<void>;
  persistSaga(saga: DisputeSaga): Promise<void>;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('DisputeSagaService', () => {
  let service: DisputeSagaService;
  let escrowService: ReturnType<typeof buildMocks>['escrowService'];
  let webhookService: ReturnType<typeof buildMocks>['webhookService'];
  let notificationService: ReturnType<typeof buildMocks>['notificationService'];
  let escrow: ReturnType<typeof buildMocks>['escrow'];
  let discordService: ReturnType<typeof buildMocks>['discordService'];

  beforeEach(async () => {
    const mocks = buildMocks();
    escrowService = mocks.escrowService;
    webhookService = mocks.webhookService;
    notificationService = mocks.notificationService;
    escrow = mocks.escrow;
    discordService = mocks.discordService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeSagaService,
        { provide: EscrowService, useValue: escrowService },
        { provide: WebhookService, useValue: webhookService },
        { provide: NotificationService, useValue: notificationService },
        {
          provide: ArweaveArchiveService,
          useValue: { archiveDispute: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: REDIS_CLIENT, useValue: null },
        { provide: MetricsService, useValue: { increment: jest.fn() } },
        { provide: DiscordService, useValue: discordService },
      ],
    }).compile();

    service = module.get<DisputeSagaService>(DisputeSagaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── escalate ─────────────────────────────────────────────────────

  describe('escalate()', () => {
    it('creates a saga and advances to JUROR_ASSIGNMENT', async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);

      expect(saga.sagaId).toMatch(/^saga-/);
      expect(saga.escrowId).toBe('esc-001');
      expect(saga.currentStep).toBe(DisputeStep.JUROR_ASSIGNMENT);
      expect(saga.escalationTxHash).toBeDefined();
      expect(escrowService.raiseDispute).toHaveBeenCalledWith(
        'esc-001',
        ESCALATE_DTO.reason,
        ESCALATE_DTO.initiator,
      );
    });

    it('allows re-escalation if the previous saga is COMPLETED', async () => {
      const firstSaga = await service.escalate('esc-001', ESCALATE_DTO);
      // Simulate completion
      firstSaga.currentStep = DisputeStep.COMPLETED;
      escrow.status = 'active';

      const secondSaga = await service.escalate('esc-001', ESCALATE_DTO);
      expect(secondSaga.sagaId).not.toBe(firstSaga.sagaId);
      expect(secondSaga.escrowId).toBe('esc-001');

      // Verify old saga is still tracked
      const retrievedFirst = await service.findById(firstSaga.sagaId);
      expect(retrievedFirst.currentStep).toBe(DisputeStep.COMPLETED);
    });

    it('allows re-escalation if the previous saga is FAILED', async () => {
      const firstSaga = await service.escalate('esc-001', ESCALATE_DTO);
      // Simulate failure
      firstSaga.currentStep = DisputeStep.FAILED;
      escrow.status = 'active';

      const secondSaga = await service.escalate('esc-001', ESCALATE_DTO);
      expect(secondSaga.sagaId).not.toBe(firstSaga.sagaId);
      expect(secondSaga.escrowId).toBe('esc-001');
    });

    it('records ESCALATION in stepHistory as completed', async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      const record = saga.stepHistory.find(r => r.step === DisputeStep.ESCALATION);
      expect(record?.completedAt).toBeDefined();
      expect(record?.failedAt).toBeUndefined();
    });

    it('dispatches escalation webhook', async () => {
      await service.escalate('esc-001', ESCALATE_DTO);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.escalated',
        expect.objectContaining({ escrowId: 'esc-001' }),
      );
    });

    it('sends dispute escalation notifications to both parties', async () => {
      await service.escalate('esc-001', ESCALATE_DTO);
      expect(notificationService.notifyDisputeEscalated).toHaveBeenCalledWith(
        expect.objectContaining({
          escrowId: 'esc-001',
          depositor: escrow.depositor,
          beneficiary: escrow.beneficiary,
        }),
      );
    });

    it('throws NotFoundException when escrow does not exist', async () => {
      escrowService.findById.mockResolvedValueOnce(undefined);
      await expect(service.escalate('esc-999', ESCALATE_DTO)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when escrow is already released', async () => {
      escrowService.findById.mockResolvedValueOnce(makeEscrow({ status: 'released' }));
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow(BadRequestException);
    });

    it.each(['pending', 'disputed', 'cancelled'] as const)(
      'rejects API escalation when escrow status is %s',
      async status => {
        escrowService.findById.mockResolvedValueOnce(makeEscrow({ status }));
        await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow(
          BadRequestException,
        );
        expect(escrowService.raiseDispute).not.toHaveBeenCalled();
      },
    );

    it('rejects an initiator who is not a party to the escrow', async () => {
      await expect(
        service.escalate('esc-001', {
          ...ESCALATE_DTO,
          initiator: 'GOTHERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(escrowService.raiseDispute).not.toHaveBeenCalled();
    });

    it('throws ConflictException when an active saga already exists', async () => {
      await service.escalate('esc-001', ESCALATE_DTO);
      // Reset the mock so raiseDispute doesn't double-throw
      escrowService.raiseDispute.mockResolvedValue(escrow);
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow(ConflictException);
    });

    it('compensates and marks FAILED when raiseDispute throws', async () => {
      escrowService.raiseDispute.mockRejectedValueOnce(new Error('on-chain error'));
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow('on-chain error');
      // No saga stored — compensation cleaned up
      const all = await service.findAll();
      expect(all.filter(s => s.currentStep !== DisputeStep.FAILED).length).toBe(0);
    });
  });

  // ─── escalate: entry-point rules (#633) ──────────────────────────

  describe('escalate() — who and what may start a dispute (#633)', () => {
    it.each(['pending', 'cancelled', 'released'] as EscrowStatus[])(
      'rejects a %s escrow with BadRequestException, before recording a saga',
      async status => {
        escrow.status = status;
        await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow(
          BadRequestException,
        );
        expect(escrowService.raiseDispute).not.toHaveBeenCalled();
        expect(await service.findAll()).toHaveLength(0);
      },
    );

    it('rejects an initiator who is not a party to the escrow, before recording a saga', async () => {
      await expect(
        service.escalate('esc-001', { ...ESCALATE_DTO, initiator: 'GSTRANGER' }),
      ).rejects.toThrow(ForbiddenException);
      expect(escrowService.raiseDispute).not.toHaveBeenCalled();
      expect(await service.findAll()).toHaveLength(0);
    });

    it('adopts an already-disputed escrow with no active saga, without re-raising it', async () => {
      escrow.status = 'disputed';
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      expect(saga.currentStep).toBe(DisputeStep.JUROR_ASSIGNMENT);
      expect(escrowService.raiseDispute).not.toHaveBeenCalled();
    });
  });

  // ─── escalate: saga/escrow consistency (#634, #635) ──────────────

  describe('escalate() — failure at each boundary (#634, #635)', () => {
    it('saga creation fails → escrow is never frozen', async () => {
      jest
        .spyOn(service as unknown as SagaPersistence, 'createSaga')
        .mockRejectedValueOnce(new Error('redis down'));
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow('redis down');
      expect(escrowService.raiseDispute).not.toHaveBeenCalled();
      expect(escrowService.correctStatus).not.toHaveBeenCalled();
      expect(escrow.status).toBe('active');
    });

    it('saga is recorded before the escrow is frozen', async () => {
      const order: string[] = [];
      jest.spyOn(service as unknown as SagaPersistence, 'createSaga').mockImplementationOnce(() => {
        order.push('createSaga');
        return Promise.resolve();
      });
      escrowService.raiseDispute.mockImplementationOnce(() => {
        order.push('raiseDispute');
        escrow.status = 'disputed';
        return Promise.resolve({ ...escrow });
      });
      await service.escalate('esc-001', ESCALATE_DTO);
      expect(order).toEqual(['createSaga', 'raiseDispute']);
    });

    it('freezing fails (before this saga changed the escrow) → nothing is reverted, saga FAILED', async () => {
      escrowService.raiseDispute.mockRejectedValueOnce(new Error('on-chain error'));
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow('on-chain error');
      expect(escrowService.correctStatus).not.toHaveBeenCalled();
      const [saga] = await service.findAll();
      expect(saga.currentStep).toBe(DisputeStep.FAILED);
    });

    it('freezing fails because another path disputed it first → that dispute is left alone', async () => {
      escrowService.raiseDispute.mockImplementationOnce(() => {
        // Another path won the race: the escrow is disputed, but not by us.
        escrow.status = 'disputed';
        escrow.disputedAt = '2026-01-01T00:00:00.000Z';
        return Promise.reject(new ConflictException('Escrow is already disputed'));
      });
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow(ConflictException);
      expect(escrowService.correctStatus).not.toHaveBeenCalled();
      expect(escrow.status).toBe('disputed');
    });

    it('committing the saga fails after this saga froze the escrow → restores the recorded prior status', async () => {
      const persist = jest.spyOn(service as unknown as SagaPersistence, 'persistSaga');
      persist.mockRejectedValueOnce(new Error('redis write failed'));
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow('redis write failed');
      expect(escrowService.correctStatus).toHaveBeenCalledWith('esc-001', {
        status: 'active',
        clearDispute: true,
      });
      expect(escrow.status).toBe('active');
      const [saga] = await service.findAll();
      expect(saga.priorEscrowStatus).toBe('active');
      expect(saga.currentStep).toBe(DisputeStep.FAILED);
    });

    it('does not revert when the escrow changed hands between freezing and compensation', async () => {
      const persist = jest.spyOn(service as unknown as SagaPersistence, 'persistSaga');
      persist.mockImplementationOnce(() => {
        // Someone else re-disputed the escrow after us (different disputedAt).
        escrow.disputedAt = '2099-01-01T00:00:00.000Z';
        return Promise.reject(new Error('redis write failed'));
      });
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow();
      expect(escrowService.correctStatus).not.toHaveBeenCalled();
      expect(escrow.status).toBe('disputed');
    });

    it('a failed escalation never leaves the escrow disputed without an active saga', async () => {
      for (const fail of ['createSaga', 'raiseDispute', 'persistSaga'] as const) {
        escrow.status = 'active';
        escrowService.correctStatus.mockClear();
        if (fail === 'raiseDispute') {
          escrowService.raiseDispute.mockRejectedValueOnce(new Error(fail));
        } else {
          jest
            .spyOn(service as unknown as SagaPersistence, fail)
            .mockRejectedValueOnce(new Error(fail));
        }
        await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow(fail);
        const active = (await service.findAll()).filter(
          s => s.currentStep !== DisputeStep.FAILED && s.currentStep !== DisputeStep.COMPLETED,
        );
        expect({ fail, status: escrow.status, active: active.length }).toEqual({
          fail,
          status: 'active',
          active: 0,
        });
      }
    });

    it('a notification failure after commit does not undo the dispute', async () => {
      notificationService.notifyDisputeEscalated.mockRejectedValueOnce(new Error('smtp down'));
      webhookService.dispatch.mockRejectedValueOnce(new Error('queue full'));
      discordService.notifyDisputeNeedsJurors.mockRejectedValueOnce(new Error('discord down'));
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      expect(saga.currentStep).toBe(DisputeStep.JUROR_ASSIGNMENT);
      expect(escrowService.correctStatus).not.toHaveBeenCalled();
      expect(escrow.status).toBe('disputed');
    });
  });

  // ─── escalate: notifications (#636) ──────────────────────────────

  describe('escalate() — notifications are sent once (#636)', () => {
    const count = (event: string) =>
      webhookService.dispatch.mock.calls.filter(([e]: [string]) => e === event).length;

    it.each([
      ['api', () => service.escalate('esc-001', ESCALATE_DTO)],
      ['chain', () => service.escalateFromChain('esc-001', 'Dispute raised on-chain')],
    ])(
      '%s entry point: one dispute.raised, one dispute.escalated, one Discord, one in-app',
      async (_origin, run) => {
        const saga = await run();
        expect(count('dispute.raised')).toBe(1);
        expect(count('dispute.escalated')).toBe(1);
        expect(discordService.notifyDisputeNeedsJurors).toHaveBeenCalledTimes(1);
        expect(notificationService.notifyDisputeEscalated).toHaveBeenCalledTimes(1);
        expect(webhookService.dispatch).toHaveBeenCalledWith('dispute.raised', {
          escrowId: 'esc-001',
          depositor: escrow.depositor,
          beneficiary: escrow.beneficiary,
          amountXLM: escrow.amountXLM,
          reason: saga.reason,
          disputedAt: escrow.disputedAt,
          sagaId: saga.sagaId,
        });
      },
    );

    it('a failed escalation sends no dispute notifications', async () => {
      escrowService.raiseDispute.mockRejectedValueOnce(new Error('boom'));
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow();
      expect(count('dispute.raised')).toBe(0);
      expect(discordService.notifyDisputeNeedsJurors).not.toHaveBeenCalled();
      expect(notificationService.notifyDisputeEscalated).not.toHaveBeenCalled();
    });
  });

  // ─── assignJurors ─────────────────────────────────────────────────

  describe('assignJurors()', () => {
    let sagaId: string;

    beforeEach(async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      sagaId = saga.sagaId;
    });

    it('assigns jurors and advances to VOTING', async () => {
      const saga = await service.assignJurors(sagaId, { jurors: JURORS });
      expect(saga.currentStep).toBe(DisputeStep.VOTING);
      expect(saga.assignedJurors).toEqual(JURORS);
    });

    it('deduplicates juror addresses', async () => {
      const saga = await service.assignJurors(sagaId, {
        jurors: [JURORS[0], JURORS[0], JURORS[1], JURORS[2]],
      });
      expect(saga.assignedJurors?.length).toBe(3);
    });

    it('throws BadRequestException when fewer than 3 distinct jurors provided', async () => {
      await expect(
        service.assignJurors(sagaId, { jurors: [JURORS[0], JURORS[0], JURORS[0]] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when saga is at wrong step', async () => {
      // Move past JUROR_ASSIGNMENT
      await service.assignJurors(sagaId, { jurors: JURORS });
      await expect(service.assignJurors(sagaId, { jurors: JURORS })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('dispatches jurors_assigned webhook', async () => {
      await service.assignJurors(sagaId, { jurors: JURORS });
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.jurors_assigned',
        expect.objectContaining({ jurors: JURORS }),
      );
    });

    it('sends juror assignment notifications', async () => {
      await service.assignJurors(sagaId, { jurors: JURORS });
      expect(notificationService.notifyJurorsAssigned).toHaveBeenCalledWith(
        expect.objectContaining({
          disputeId: sagaId,
          jurors: JURORS,
        }),
      );
    });
  });

  // ─── castVote ─────────────────────────────────────────────────────

  describe('castVote()', () => {
    let sagaId: string;

    beforeEach(async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      sagaId = saga.sagaId;
      await service.assignJurors(sagaId, { jurors: JURORS });
    });

    it('records a vote', async () => {
      const saga = await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
      expect(saga.votes?.length).toBe(1);
    });

    it('computes DEPOSITOR_WINS verdict when majority votes depositor', async () => {
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
      await service.castVote(sagaId, { jurorAddress: JURORS[1], vote: 'depositor' });
      const saga = await service.castVote(sagaId, {
        jurorAddress: JURORS[2],
        vote: 'beneficiary',
      });
      expect(saga.verdict).toBe(DisputeVerdict.DEPOSITOR_WINS);
      expect(saga.currentStep).toBe(DisputeStep.PAYOUT);
    });

    it('computes BENEFICIARY_WINS verdict', async () => {
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'beneficiary' });
      await service.castVote(sagaId, { jurorAddress: JURORS[1], vote: 'beneficiary' });
      const saga = await service.castVote(sagaId, { jurorAddress: JURORS[2], vote: 'depositor' });
      expect(saga.verdict).toBe(DisputeVerdict.BENEFICIARY_WINS);
    });

    it('computes SPLIT verdict when no majority', async () => {
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
      await service.castVote(sagaId, { jurorAddress: JURORS[1], vote: 'beneficiary' });
      const saga = await service.castVote(sagaId, { jurorAddress: JURORS[2], vote: 'split' });
      expect(saga.verdict).toBe(DisputeVerdict.SPLIT);
    });

    it('throws BadRequestException when address is not an assigned juror', async () => {
      await expect(
        service.castVote(sagaId, {
          jurorAddress: 'GNOTAJUROR11111111111111111111111111111111111111111111111',
          vote: 'depositor',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when caller wallet does not match jurorAddress', async () => {
      await expect(
        service.castVote(
          sagaId,
          { jurorAddress: JURORS[0], vote: 'depositor' },
          'GDIFFERENTWALLET111111111111111111111111111111111111111111',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows vote when caller wallet matches jurorAddress', async () => {
      const saga = await service.castVote(
        sagaId,
        { jurorAddress: JURORS[0], vote: 'depositor' },
        JURORS[0],
      );
      expect(saga.votes).toHaveLength(1);
      expect(saga.votes![0].jurorAddress).toBe(JURORS[0]);
    });

    it('throws ConflictException on duplicate vote', async () => {
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
      await expect(
        service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'beneficiary' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── executePayout ────────────────────────────────────────────────

  describe('executePayout()', () => {
    let sagaId: string;

    async function runToPayoutStep(verdict: 'depositor' | 'beneficiary' | 'split') {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      sagaId = saga.sagaId;
      await service.assignJurors(sagaId, { jurors: JURORS });
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: verdict });
      await service.castVote(sagaId, { jurorAddress: JURORS[1], vote: verdict });
      await service.castVote(sagaId, { jurorAddress: JURORS[2], vote: 'depositor' });
    }

    it('completes saga and calls escrowService.cancel for DEPOSITOR_WINS', async () => {
      await runToPayoutStep('depositor');
      const saga = await service.executePayout(sagaId, {});
      expect(saga.currentStep).toBe(DisputeStep.COMPLETED);
      expect(saga.payoutTxHash).toBeDefined();
      expect(saga.completedAt).toBeDefined();
      expect(escrowService.cancel).toHaveBeenCalledWith('esc-001');
    });

    it('releases escrow for BENEFICIARY_WINS', async () => {
      await runToPayoutStep('beneficiary');
      await service.executePayout(sagaId, {});
      expect(escrowService.release).toHaveBeenCalledWith('esc-001');
    });

    it('calls escrowService.split with correct percentage for SPLIT', async () => {
      await runToPayoutStep('split');
      await service.executePayout(sagaId, { splitPercentage: 70 });
      expect(escrowService.split).toHaveBeenCalledWith('esc-001', 70);
    });

    it('dispatches payout_executed and saga_completed webhooks', async () => {
      await runToPayoutStep('depositor');
      await service.executePayout(sagaId, {});
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.payout_executed',
        expect.objectContaining({ sagaId }),
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.saga_completed',
        expect.objectContaining({ sagaId }),
      );
    });

    it('sends payout executed notifications to both parties', async () => {
      await runToPayoutStep('depositor');
      await service.executePayout(sagaId, {});
      expect(notificationService.notifyPayoutExecuted).toHaveBeenCalledWith(
        expect.objectContaining({
          disputeId: sagaId,
          depositor: escrow.depositor,
          beneficiary: escrow.beneficiary,
        }),
      );
    });

    it('throws BadRequestException when called before PAYOUT step', async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      await expect(service.executePayout(saga.sagaId, {})).rejects.toThrow(BadRequestException);
    });

    it('compensates on release failure and flags escrow for manual review', async () => {
      await runToPayoutStep('beneficiary');
      escrowService.release.mockRejectedValueOnce(new Error('on-chain payout failed'));
      escrowService.findById.mockResolvedValue({ ...escrow, status: 'disputed' });

      await expect(service.executePayout(sagaId, {})).rejects.toThrow('on-chain payout failed');

      const failed = await service.findById(sagaId);
      expect(failed.currentStep).toBe(DisputeStep.FAILED);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.saga_failed',
        expect.objectContaining({ step: DisputeStep.PAYOUT }),
      );
    });
  });

  // ─── findById / findByEscrowId ────────────────────────────────────

  describe('findById()', () => {
    it('throws NotFoundException for unknown sagaId', async () => {
      await expect(service.findById('saga-unknown')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByEscrowId()', () => {
    it('returns undefined when no saga exists for escrow', async () => {
      expect(await service.findByEscrowId('esc-999')).toBeUndefined();
    });

    it('returns the saga when one exists', async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      expect((await service.findByEscrowId('esc-001'))?.sagaId).toBe(saga.sagaId);
    });
  });

  // ─── compensateEscalation: chain state sync (#647) ────────────────

  describe('compensateEscalation() — re-read chain state and sync DB (#647)', () => {
    it('re-syncs escrow from chain when DB write fails after on-chain transaction', async () => {
      // Simulate an escrow that has a contract ID (linked to chain)
      const chainEscrow = makeEscrow({ contractEscrowId: 'contract-123' });
      escrowService.findById.mockResolvedValue(chainEscrow);

      // Mock chain client that returns disputed state
      const chainClient = {
        getEscrow: jest.fn().mockResolvedValue({
          status: 'disputed',
          depositor: chainEscrow.depositor,
          beneficiary: chainEscrow.beneficiary,
          amountXLM: chainEscrow.amountXLM,
        }),
      };

      // Mock applyChainState method
      const applyChainState = jest.fn().mockResolvedValue(chainEscrow);
      escrowService.applyChainState = applyChainState;
      escrowService.findAll = jest.fn().mockResolvedValue([chainEscrow]);

      // Rebuild service with chain client
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DisputeSagaService,
          { provide: EscrowService, useValue: escrowService },
          { provide: WebhookService, useValue: webhookService },
          { provide: NotificationService, useValue: notificationService },
          { provide: REDIS_CLIENT, useValue: null },
          { provide: MetricsService, useValue: { increment: jest.fn() } },
          { provide: DiscordService, useValue: discordService },
          { provide: EscrowChainStateClient, useValue: chainClient },
        ],
      }).compile();

      service = module.get<DisputeSagaService>(DisputeSagaService);

      // Make the persist step fail after raiseDispute succeeds
      jest
        .spyOn(service as unknown as SagaPersistence, 'persistSaga')
        .mockRejectedValueOnce(new Error('DB connection lost'));

      escrowService.raiseDispute.mockResolvedValueOnce({
        ...chainEscrow,
        status: 'disputed',
        disputedAt: new Date().toISOString(),
      });

      // Attempt escalation - should fail at persist step but compensate by syncing from chain
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow('DB connection lost');

      // Verify chain state was queried during compensation
      expect(chainClient.getEscrow).toHaveBeenCalledWith('contract-123');

      // Verify the saga failed
      const [saga] = await service.findAll();
      expect(saga.currentStep).toBe(DisputeStep.FAILED);
      expect(saga.compensationReason).toContain('DB connection lost');
    });

    it('logs warning and continues when chain client is unavailable', async () => {
      const chainEscrow = makeEscrow({ contractEscrowId: 'contract-456' });
      escrowService.findById.mockResolvedValue(chainEscrow);

      // No chain client provided (simulates optional dependency not available)
      const logSpy = jest.spyOn(
        (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
        'warn',
      );

      jest
        .spyOn(service as unknown as SagaPersistence, 'persistSaga')
        .mockRejectedValueOnce(new Error('DB failure'));

      escrowService.raiseDispute.mockResolvedValueOnce({
        ...chainEscrow,
        status: 'disputed',
        disputedAt: new Date().toISOString(),
      });

      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow('DB failure');

      // Compensation should still complete even without chain sync capability
      const [saga] = await service.findAll();
      expect(saga.currentStep).toBe(DisputeStep.FAILED);

      // Verify no crash occurred - service handled missing chain client gracefully
      expect(logSpy).toHaveBeenCalled();
    });

    it('continues compensation even if chain sync itself fails', async () => {
      const chainEscrow = makeEscrow({ contractEscrowId: 'contract-789' });
      escrowService.findById.mockResolvedValue(chainEscrow);

      const chainClient = {
        getEscrow: jest.fn().mockRejectedValue(new Error('Chain RPC timeout')),
      };

      escrowService.findAll = jest.fn().mockResolvedValue([chainEscrow]);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DisputeSagaService,
          { provide: EscrowService, useValue: escrowService },
          { provide: WebhookService, useValue: webhookService },
          { provide: NotificationService, useValue: notificationService },
          { provide: REDIS_CLIENT, useValue: null },
          { provide: MetricsService, useValue: { increment: jest.fn() } },
          { provide: DiscordService, useValue: discordService },
          { provide: EscrowChainStateClient, useValue: chainClient },
        ],
      }).compile();

      service = module.get<DisputeSagaService>(DisputeSagaService);

      jest
        .spyOn(service as unknown as SagaPersistence, 'persistSaga')
        .mockRejectedValueOnce(new Error('DB failure'));

      escrowService.raiseDispute.mockResolvedValueOnce({
        ...chainEscrow,
        status: 'disputed',
        disputedAt: new Date().toISOString(),
      });

      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow('DB failure');

      // Compensation should mark saga as failed even if chain sync errored
      const [saga] = await service.findAll();
      expect(saga.currentStep).toBe(DisputeStep.FAILED);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.saga_failed',
        expect.objectContaining({ reason: 'DB failure' }),
      );
    });
  });
});
