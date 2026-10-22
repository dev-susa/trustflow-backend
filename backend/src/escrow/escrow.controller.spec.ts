import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EscrowController } from './escrow.controller';
import { EscrowService, Escrow } from './escrow.service';
import { EscrowReleaseTransactionBuilderService } from '../escrow-write/escrow-release-transaction-builder.service';
import { DisputeSagaService } from '../dispute/dispute-saga.service';
import { JwtAuthGuard } from '../auth/auth.guard';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DEPOSITOR = 'GDEPOSITORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BENEFICIARY = 'GBENEFICIARYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_WALLET = 'GOTHERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const AMOUNT = '100';

function makeEscrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    id: 'esc-001',
    depositor: DEPOSITOR,
    beneficiary: BENEFICIARY,
    amountXLM: AMOUNT,
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Mock factories ───────────────────────────────────────────────────────────

function buildMocks() {
  const escrow = makeEscrow();

  const escrowService = {
    create: jest.fn().mockResolvedValue(escrow),
    findById: jest.fn().mockResolvedValue(escrow),
    findByDepositor: jest.fn().mockResolvedValue([escrow]),
    release: jest.fn().mockResolvedValue({ ...escrow, status: 'released' }),
  };

  const disputeSagaService = {
    escalate: jest.fn().mockResolvedValue({ sagaId: 'saga-001', escrowId: escrow.id }),
  };

  const txBuilderService = {
    buildRelease: jest.fn().mockResolvedValue({
      xdr: 'AAAAAgAAAAA...',
      network: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractId: 'CXXX',
      sourceAccount: DEPOSITOR,
    }),
  };

  return {
    escrow,
    escrowService,
    disputeSagaService,
    txBuilderService,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('EscrowController', () => {
  let controller: EscrowController;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mocks = buildMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EscrowController],
      providers: [
        { provide: EscrowService, useValue: mocks.escrowService },
        {
          provide: EscrowReleaseTransactionBuilderService,
          useValue: mocks.txBuilderService,
        },
        { provide: DisputeSagaService, useValue: mocks.disputeSagaService },
      ],
    }).compile();

    controller = module.get<EscrowController>(EscrowController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ─── POST /escrows (create) ───────────────────────────────────────────────

  describe('create()', () => {
    it('delegates to EscrowService.create() and returns the new escrow', async () => {
      const dto = { depositor: DEPOSITOR, beneficiary: BENEFICIARY, amountXLM: AMOUNT };

      const result = await controller.create(dto);

      expect(mocks.escrowService.create).toHaveBeenCalledWith(DEPOSITOR, BENEFICIARY, AMOUNT);
      expect(result).toEqual(mocks.escrow);
    });

    it('rejects a self-dealing escrow (depositor === beneficiary) with 400', () => {
      const dto = { depositor: DEPOSITOR, beneficiary: DEPOSITOR, amountXLM: AMOUNT };

      expect(() => controller.create(dto)).toThrow(BadRequestException);
      expect(mocks.escrowService.create).not.toHaveBeenCalled();
    });

    it('rejects a malformed address with 400 (not 500)', () => {
      const dto = {
        depositor: 'not-a-stellar-address',
        beneficiary: BENEFICIARY,
        amountXLM: AMOUNT,
      };

      expect(() => controller.create(dto)).toThrow(BadRequestException);
    });
  });

  // ─── GET /escrows/:id (findOne) ───────────────────────────────────────────

  describe('findOne()', () => {
    it('delegates to EscrowService.findById() and returns the escrow', async () => {
      const result = await controller.findOne('esc-001');

      expect(mocks.escrowService.findById).toHaveBeenCalledWith('esc-001');
      expect(result).toEqual(mocks.escrow);
    });

    it('throws NotFoundException for an unknown escrow id', async () => {
      mocks.escrowService.findById.mockResolvedValue(undefined);

      await expect(controller.findOne('esc-unknown')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── GET /escrows/depositor/:address ──────────────────────────────────────

  describe('findByDepositor()', () => {
    it('delegates to EscrowService.findByDepositor() with the address and default pagination', async () => {
      const result = await controller.findByDepositor(DEPOSITOR);

      expect(mocks.escrowService.findByDepositor).toHaveBeenCalledWith(DEPOSITOR, 0, 20);
      expect(result).toEqual([mocks.escrow]);
    });

    it('returns an empty array when no escrows exist for the depositor', async () => {
      mocks.escrowService.findByDepositor.mockResolvedValue([]);

      expect(await controller.findByDepositor(DEPOSITOR)).toEqual([]);
    });
  });

  // ─── POST /escrows/:id/release ────────────────────────────────────────────

  describe('release()', () => {
    it('releases the escrow, records reputation, and returns the updated escrow', async () => {
      const released = { ...mocks.escrow, status: 'released' };
      mocks.escrowService.release.mockResolvedValue(released);

      const result = await controller.release('esc-001');

      expect(mocks.escrowService.release).toHaveBeenCalledWith('esc-001');
      expect(result).toEqual(released);
    });

    it('propagates errors thrown by EscrowService.release()', async () => {
      mocks.escrowService.release.mockRejectedValue(new Error('Escrow not found'));

      await expect(controller.release('esc-unknown')).rejects.toThrow('Escrow not found');
    });
  });

  // ─── POST /escrows/:id/dispute ────────────────────────────────────────────

  describe('raiseDispute()', () => {
    it('requires JWT authentication', () => {
      const guards = Reflect.getMetadata('__guards__', EscrowController.prototype.raiseDispute);
      expect(guards).toContain(JwtAuthGuard);
    });

    it('delegates to the saga with the authenticated wallet, ignoring a caller-supplied initiator', async () => {
      const saga = { sagaId: 'saga-001', escrowId: 'esc-001' };
      mocks.disputeSagaService.escalate.mockResolvedValue(saga);

      const result = await controller.raiseDispute(
        'esc-001',
        { reason: 'Work not delivered', initiator: OTHER_WALLET } as any,
        { user: { address: DEPOSITOR, sub: DEPOSITOR } },
      );

      expect(mocks.disputeSagaService.escalate).toHaveBeenCalledWith('esc-001', {
        initiator: DEPOSITOR,
        reason: 'Work not delivered',
      });
      expect(mocks.escrowService.raiseDispute).not.toHaveBeenCalled();
      expect(result).toEqual(saga);
    });

    it('supplies a default reason when none is provided', async () => {
      await controller.raiseDispute('esc-001', {}, {
        user: { address: DEPOSITOR, sub: DEPOSITOR },
      });

      expect(mocks.disputeSagaService.escalate).toHaveBeenCalledWith('esc-001', {
        initiator: DEPOSITOR,
        reason: 'No reason provided',
      });
    });

    it('propagates ForbiddenException for a caller who is not an escrow party', async () => {
      mocks.disputeSagaService.escalate.mockRejectedValue(
        new ForbiddenException('Only the depositor or beneficiary can escalate a dispute'),
      );

      await expect(
        controller.raiseDispute('esc-001', { reason: 'wrong party' }, {
          user: { address: OTHER_WALLET, sub: OTHER_WALLET },
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(mocks.disputeSagaService.escalate).toHaveBeenCalledWith('esc-001', {
        initiator: OTHER_WALLET,
        reason: 'wrong party',
      });
    });

    it('propagates BadRequestException when the escrow cannot start a dispute', async () => {
      mocks.disputeSagaService.escalate.mockRejectedValue(
        new BadRequestException('Only active escrows can start a dispute'),
      );

      await expect(controller.raiseDispute('esc-001', { reason: 'not active' }, {
        user: { address: DEPOSITOR, sub: DEPOSITOR },
      })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('propagates exception when service throws', async () => {
      mocks.disputeSagaService.escalate.mockRejectedValue(new Error('unexpected'));

      await expect(controller.raiseDispute('esc-001', {}, {
        user: { address: DEPOSITOR, sub: DEPOSITOR },
      })).rejects.toThrow();
    });
  });

  // ─── GET /escrows/:id/release/transaction ────────────────────────────────

  describe('buildReleaseTransaction()', () => {
    it('calls the tx builder with contractEscrowId and sourceAccount', async () => {
      const linked = makeEscrow({ contractEscrowId: 'on-chain-id-001' });
      mocks.escrowService.findById.mockResolvedValue(linked);

      const result = await controller.buildReleaseTransaction('esc-001', {
        sourceAccount: DEPOSITOR,
      } as BuildReleaseTransactionQueryDto);

      expect(mocks.txBuilderService.buildRelease).toHaveBeenCalledWith(
        'on-chain-id-001',
        DEPOSITOR,
      );
      expect(result).toHaveProperty('xdr');
    });

    it('throws NotFoundException when the escrow does not exist', async () => {
      mocks.escrowService.findById.mockResolvedValue(undefined);

      await expect(
        controller.buildReleaseTransaction('esc-ghost', {
          sourceAccount: DEPOSITOR,
        } as BuildReleaseTransactionQueryDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the escrow has no contractEscrowId', async () => {
      const unlinked = makeEscrow({ contractEscrowId: undefined });
      mocks.escrowService.findById.mockResolvedValue(unlinked);

      await expect(
        controller.buildReleaseTransaction('esc-001', {
          sourceAccount: DEPOSITOR,
        } as BuildReleaseTransactionQueryDto),
      ).rejects.toThrow(NotFoundException);
    });

    it.each([
      { status: 'pending', description: 'pending' },
      { status: 'released', description: 'released' },
      { status: 'disputed', description: 'disputed' },
      { status: 'cancelled', description: 'cancelled' },
    ])('throws BadRequestException when escrow status is $description', async ({ status }) => {
      const inactive = makeEscrow({
        contractEscrowId: 'on-chain-id-001',
        status: status as Escrow['status'],
      });
      mocks.escrowService.findById.mockResolvedValue(inactive);

      await expect(
        controller.buildReleaseTransaction('esc-001', {
          sourceAccount: DEPOSITOR,
        } as BuildReleaseTransactionQueryDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when sourceAccount is neither depositor nor beneficiary', async () => {
      const linked = makeEscrow({ contractEscrowId: 'on-chain-id-001' });
      mocks.escrowService.findById.mockResolvedValue(linked);

      const unauthorizedAccount = 'GUNAU5L7HWC5X7F5Z2L7ZJ2K3X5Y7Z2K3X5Y7Z2K3X5Y7Z';

      await expect(
        controller.buildReleaseTransaction('esc-001', {
          sourceAccount: unauthorizedAccount,
        } as BuildReleaseTransactionQueryDto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows depositor to request release transaction', async () => {
      const linked = makeEscrow({ contractEscrowId: 'on-chain-id-001' });
      mocks.escrowService.findById.mockResolvedValue(linked);

      const result = await controller.buildReleaseTransaction('esc-001', {
        sourceAccount: DEPOSITOR,
      } as BuildReleaseTransactionQueryDto);

      expect(mocks.txBuilderService.buildRelease).toHaveBeenCalled();
      expect(result).toHaveProperty('xdr');
    });

    it('allows beneficiary to request release transaction', async () => {
      const linked = makeEscrow({ contractEscrowId: 'on-chain-id-001' });
      mocks.escrowService.findById.mockResolvedValue(linked);

      const result = await controller.buildReleaseTransaction('esc-001', {
        sourceAccount: BENEFICIARY,
      } as BuildReleaseTransactionQueryDto);

      expect(mocks.txBuilderService.buildRelease).toHaveBeenCalled();
      expect(result).toHaveProperty('xdr');
    });
  });
});
