import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { EscrowDisputeController } from './escrow-dispute.controller';
import { DisputeSagaService } from './dispute-saga.service';
import { ArweaveArchiveService } from './arweave-archive.service';
import { DisputeStep } from './dispute.types';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Escrow, EscrowService, EscrowStatus } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { NotificationService } from '../notification/notification.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';

const DEPOSITOR = 'GDEPOSITOR111111111111111111111111111111111111111111111';
const BENEFICIARY = 'GBENEFICIARY1111111111111111111111111111111111111111111';
const req = (address: string) => ({ user: { address, sub: address } });

/**
 * `POST /escrows/:id/dispute` (#633, #636), exercised against the real
 * DisputeSagaService so the authorization, state and notification rules are
 * the saga's own — only persistence and delivery are mocked.
 */
describe('EscrowDisputeController', () => {
  let controller: EscrowDisputeController;
  let sagaService: DisputeSagaService;
  let escrow: Escrow;
  let escrowService: Record<string, jest.Mock>;
  let webhookService: { dispatch: jest.Mock };
  let discordService: { notifyDisputeNeedsJurors: jest.Mock };
  let notificationService: { notifyDisputeEscalated: jest.Mock };

  beforeEach(async () => {
    escrow = {
      id: 'esc-001',
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM: '100',
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    escrowService = {
      findById: jest.fn(() => Promise.resolve({ ...escrow })),
      raiseDispute: jest.fn((_id: string, reason: string) => {
        Object.assign(escrow, {
          status: 'disputed',
          disputeReason: reason,
          disputedAt: new Date().toISOString(),
        });
        return Promise.resolve({ ...escrow });
      }),
      correctStatus: jest.fn(),
    };
    webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    discordService = { notifyDisputeNeedsJurors: jest.fn().mockResolvedValue(undefined) };
    notificationService = { notifyDisputeEscalation: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      controllers: [EscrowDisputeController],
      providers: [
        DisputeSagaService,
        { provide: EscrowService, useValue: escrowService },
        { provide: WebhookService, useValue: webhookService },
        { provide: DiscordService, useValue: discordService },
        { provide: NotificationService, useValue: notificationService },
        { provide: REDIS_CLIENT, useValue: null },
        { provide: MetricsService, useValue: { increment: jest.fn() } },
        { provide: ArweaveArchiveService, useValue: { archive: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(EscrowDisputeController);
    sagaService = module.get(DisputeSagaService);
  });

  it('requires authentication (JwtAuthGuard on the controller)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, EscrowDisputeController) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
  });

  it.each([
    ['depositor', DEPOSITOR],
    ['beneficiary', BENEFICIARY],
  ])('lets the %s raise a dispute through the saga', async (_role, address) => {
    const res = await controller.raiseDispute('esc-001', { reason: 'Not delivered' }, req(address));

    expect(res).toMatchObject({ id: 'esc-001', status: 'disputed' });
    expect(res.sagaId).toMatch(/^saga-/);
    expect(escrowService.raiseDispute).toHaveBeenCalledTimes(1);
    expect(escrowService.raiseDispute).toHaveBeenCalledWith('esc-001', 'Not delivered', address);
  });

  it('records the authenticated wallet as the initiator, ignoring any body field', async () => {
    const body = { reason: 'Not delivered', initiator: BENEFICIARY } as { reason: string };
    const res = await controller.raiseDispute('esc-001', body, req(DEPOSITOR));
    const saga = await sagaService.findById(res.sagaId);
    expect(saga.initiator).toBe(DEPOSITOR);
  });

  it('rejects a caller who is not a party to the escrow with 403, leaving it untouched', async () => {
    await expect(
      controller.raiseDispute('esc-001', { reason: 'Work not delivered' }, req('GSTRANGER')),
    ).rejects.toThrow(ForbiddenException);
    expect(escrowService.raiseDispute).not.toHaveBeenCalled();
    expect(escrow.status).toBe('active');
  });

  it.each(['pending', 'released', 'cancelled'] as EscrowStatus[])(
    'rejects a %s escrow with 400',
    async status => {
      escrow.status = status;
      await expect(
        controller.raiseDispute('esc-001', { reason: 'Work not delivered' }, req(DEPOSITOR)),
      ).rejects.toThrow(BadRequestException);
      expect(escrowService.raiseDispute).not.toHaveBeenCalled();
    },
  );

  it('sends dispute.raised, Discord and in-app notifications exactly once (#636)', async () => {
    const res = await controller.raiseDispute(
      'esc-001',
      { reason: 'Not delivered' },
      req(DEPOSITOR),
    );
    const raised = (webhookService.dispatch.mock.calls as Array<[string, unknown]>).filter(
      ([e]) => e === 'dispute.raised',
    );
    expect(raised).toHaveLength(1);
    expect(raised[0][1]).toMatchObject({
      escrowId: 'esc-001',
      sagaId: res.sagaId,
      amountXLM: '100',
    });
    expect(discordService.notifyDisputeNeedsJurors).toHaveBeenCalledTimes(1);
    expect(notificationService.notifyDisputeEscalation).toHaveBeenCalledTimes(1);
  });

  it('a second dispute on the same escrow is rejected (active saga exists)', async () => {
    const first = await controller.raiseDispute(
      'esc-001',
      { reason: 'Depositor dispute' },
      req(DEPOSITOR),
    );
    const saga = await sagaService.findById(first.sagaId);
    expect(saga.currentStep).toBe(DisputeStep.JUROR_ASSIGNMENT);
    await expect(
      controller.raiseDispute('esc-001', { reason: 'Beneficiary dispute' }, req(BENEFICIARY)),
    ).rejects.toThrow('An active dispute saga already exists');
  });
});
