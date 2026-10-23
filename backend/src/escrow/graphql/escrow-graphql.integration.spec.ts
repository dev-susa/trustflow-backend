import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Global, INestApplication, Module } from '@nestjs/common';
import { validateEnv } from '../../config/env.config';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { EscrowService } from '../escrow.service';
import { MilestoneLoader } from './dataloader/milestone.loader';
import { DeliverableLoader } from './dataloader/deliverable.loader';
import { JurorVoteLoader } from './dataloader/juror-vote.loader';
import { UserProfileLoader } from './dataloader/user-profile.loader';

// The GraphQL module reads `config` while its decorator is evaluated, so config must be
// validated before the module is required (see env-config-import-order.spec.ts).
validateEnv();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EscrowGraphQLModule } = require('./escrow-graphql.module') as typeof import('./escrow-graphql.module');

// ─── Mocks ────────────────────────────────────────────────────────────────────

// EscrowModule (now imported by the GraphQL module) pulls in WebhookModule, which injects
// REDIS_CLIENT from a global module. Provide the in-memory fallback (null) for these tests.
@Global()
@Module({
  providers: [{ provide: REDIS_CLIENT, useValue: null }],
  exports: [REDIS_CLIENT],
})
class TestRedisModule {}

const mockEscrowService = {
  findAll: jest.fn(),
  findById: jest.fn(),
};

const mockMilestoneLoader = {
  byEscrowId: { load: jest.fn() },
};

const mockDeliverableLoader = {
  byMilestoneId: { load: jest.fn() },
};

const mockJurorVoteLoader = {
  byDeliverableId: { load: jest.fn() },
};

const mockUserProfileLoader = {
  byWalletAddress: { load: jest.fn() },
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('EscrowGraphQL Integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [TestRedisModule, EscrowGraphQLModule],
    })
      .overrideProvider(EscrowService)
      .useValue(mockEscrowService)
      .overrideProvider(MilestoneLoader)
      .useValue(mockMilestoneLoader)
      .overrideProvider(DeliverableLoader)
      .useValue(mockDeliverableLoader)
      .overrideProvider(JurorVoteLoader)
      .useValue(mockJurorVoteLoader)
      .overrideProvider(UserProfileLoader)
      .useValue(mockUserProfileLoader)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── escrows query ─────────────────────────────────────────────────────────

  describe('escrows query', () => {
    it('returns an empty page when no escrows exist', async () => {
      mockEscrowService.findAll.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrows { data { id status } total offset limit } }` });

      expect(res.status).toBe(200);
      expect(res.body.data.escrows.data).toEqual([]);
      expect(res.body.data.escrows.total).toBe(0);
    });

    it('returns escrows with scalar fields and pagination metadata', async () => {
      const escrows = [
        {
          id: 'esc-1',
          depositor: 'GABC',
          beneficiary: 'GDEF',
          amountXLM: '100',
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'esc-2',
          depositor: 'GGHI',
          beneficiary: 'GJKL',
          amountXLM: '200',
          status: 'pending',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ];
      mockEscrowService.findAll.mockResolvedValue(escrows);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrows { data { id depositor beneficiary amountXLM status createdAt } total offset limit } }` });

      expect(res.status).toBe(200);
      expect(res.body.data.escrows.data).toHaveLength(2);
      expect(res.body.data.escrows.data[0].id).toBe('esc-1');
      expect(res.body.data.escrows.data[1].status).toBe('pending');
      expect(res.body.data.escrows.total).toBe(2);
    });

    it('respects offset and limit args', async () => {
      const escrows = [
        { id: 'esc-1', depositor: 'GABC', beneficiary: 'GDEF', amountXLM: '100', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'esc-2', depositor: 'GGHI', beneficiary: 'GJKL', amountXLM: '200', status: 'pending', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'esc-3', depositor: 'GMNO', beneficiary: 'GPQR', amountXLM: '300', status: 'released', createdAt: '2026-01-03T00:00:00.000Z' },
      ];
      mockEscrowService.findAll.mockResolvedValue(escrows);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrows(offset: 1, limit: 1) { data { id } total offset limit } }` });

      expect(res.status).toBe(200);
      expect(res.body.data.escrows.data).toHaveLength(1);
      expect(res.body.data.escrows.data[0].id).toBe('esc-2');
      expect(res.body.data.escrows.total).toBe(3);
      expect(res.body.data.escrows.offset).toBe(1);
      expect(res.body.data.escrows.limit).toBe(1);
    });
  });

  // ─── escrow query ─────────────────────────────────────────────────────────

  describe('escrow query', () => {
    it('returns a single escrow by id', async () => {
      const escrow = {
        id: 'esc-1',
        depositor: 'GABC',
        beneficiary: 'GDEF',
        amountXLM: '100',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      mockEscrowService.findById.mockResolvedValue(escrow);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrow(id: "esc-1") { id status } }` });

      expect(res.status).toBe(200);
      expect(res.body.data.escrow.id).toBe('esc-1');
    });

    it('returns null for a non-existent escrow', async () => {
      mockEscrowService.findById.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrow(id: "nonexistent") { id } }` });

      expect(res.status).toBe(200);
      expect(res.body.data.escrow).toBeNull();
    });
  });

  // ─── Nested relations (Escrow → Milestones → Deliverables → JurorVotes) ──

  describe('nested relations', () => {
    it('resolves milestones for an escrow via DataLoader', async () => {
      const escrow = {
        id: 'esc-1',
        depositor: 'GABC',
        beneficiary: 'GDEF',
        amountXLM: '100',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      const milestones = [
        { id: 'ms-1', escrowId: 'esc-1', title: 'Design', amountXLM: '50', status: 'pending' },
        { id: 'ms-2', escrowId: 'esc-1', title: 'Development', amountXLM: '50', status: 'pending' },
      ];

      mockEscrowService.findById.mockResolvedValue(escrow);
      mockMilestoneLoader.byEscrowId.load.mockResolvedValue(milestones);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrow(id: "esc-1") { id milestones { id title status } } }` });

      expect(res.status).toBe(200);
      expect(res.body.data.escrow.milestones).toHaveLength(2);
      expect(res.body.data.escrow.milestones[0].title).toBe('Design');
    });

    it('resolves deliverables for a milestone via DataLoader', async () => {
      const escrow = {
        id: 'esc-1',
        depositor: 'GABC',
        beneficiary: 'GDEF',
        amountXLM: '100',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      const milestones = [
        { id: 'ms-1', escrowId: 'esc-1', title: 'Design', amountXLM: '50', status: 'pending' },
      ];
      const deliverables = [
        { id: 'del-1', milestoneId: 'ms-1', gigId: 'gig-1', cid: 'QmXyz', filename: 'design.pdf', size: 1024, status: 'pinned' },
      ];

      mockEscrowService.findById.mockResolvedValue(escrow);
      mockMilestoneLoader.byEscrowId.load.mockResolvedValue(milestones);
      mockDeliverableLoader.byMilestoneId.load.mockResolvedValue(deliverables);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrow(id: "esc-1") { milestones { deliverables { id filename status } } } }` });

      expect(res.status).toBe(200);
      expect(res.body.data.escrow.milestones[0].deliverables).toHaveLength(1);
      expect(res.body.data.escrow.milestones[0].deliverables[0].filename).toBe('design.pdf');
    });

    it('resolves juror votes for a deliverable via DataLoader', async () => {
      const escrow = {
        id: 'esc-1',
        depositor: 'GABC',
        beneficiary: 'GDEF',
        amountXLM: '100',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      const milestones = [
        { id: 'ms-1', escrowId: 'esc-1', title: 'Design', amountXLM: '50', status: 'pending' },
      ];
      const deliverables = [
        { id: 'del-1', milestoneId: 'ms-1', gigId: 'gig-1', cid: 'QmXyz', filename: 'design.pdf', size: 1024, status: 'pinned' },
      ];
      const jurorVotes = [
        { id: 'jv-1', deliverableId: 'del-1', juror: 'GJUROR1', vote: 'approve', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'jv-2', deliverableId: 'del-1', juror: 'GJUROR2', vote: 'reject', createdAt: '2026-01-01T00:00:00.000Z' },
      ];

      mockEscrowService.findById.mockResolvedValue(escrow);
      mockMilestoneLoader.byEscrowId.load.mockResolvedValue(milestones);
      mockDeliverableLoader.byMilestoneId.load.mockResolvedValue(deliverables);
      mockJurorVoteLoader.byDeliverableId.load.mockResolvedValue(jurorVotes);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrow(id: "esc-1") { milestones { deliverables { jurorVotes { id juror vote } } } } }` });

      expect(res.status).toBe(200);
      const votes = res.body.data.escrow.milestones[0].deliverables[0].jurorVotes;
      expect(votes).toHaveLength(2);
      expect(votes[0].juror).toBe('GJUROR1');
      expect(votes[1].vote).toBe('reject');
    });

    it('resolves depositor and beneficiary profiles via DataLoader', async () => {
      const escrow = {
        id: 'esc-1',
        depositor: 'GABC',
        beneficiary: 'GDEF',
        amountXLM: '100',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      const depositorProfile = { id: 'up-1', walletAddress: 'GABC', name: 'Alice', userType: 'client', status: 'active' };
      const beneficiaryProfile = { id: 'up-2', walletAddress: 'GDEF', name: 'Bob', userType: 'freelancer', status: 'active' };

      mockEscrowService.findById.mockResolvedValue(escrow);
      mockUserProfileLoader.byWalletAddress.load
        .mockResolvedValueOnce(depositorProfile)
        .mockResolvedValueOnce(beneficiaryProfile);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrow(id: "esc-1") { depositorProfile { name userType } beneficiaryProfile { name userType } } }` });

      expect(res.status).toBe(200);
      expect(res.body.data.escrow.depositorProfile.name).toBe('Alice');
      expect(res.body.data.escrow.beneficiaryProfile.name).toBe('Bob');
    });
  });

  // ─── DataLoader batching verification ─────────────────────────────────────

  describe('DataLoader batching', () => {
    it('batches milestone loads for multiple escrows in a single query', async () => {
      const escrows = [
        { id: 'esc-1', depositor: 'GABC', beneficiary: 'GDEF', amountXLM: '100', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'esc-2', depositor: 'GGHI', beneficiary: 'GJKL', amountXLM: '200', status: 'pending', createdAt: '2026-01-02T00:00:00.000Z' },
      ];
      mockEscrowService.findAll.mockResolvedValue(escrows);
      mockMilestoneLoader.byEscrowId.load.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: `{ escrows { data { id milestones { id } } } }` });

      expect(res.status).toBe(200);
      // DataLoader should have been called once per unique escrow ID
      expect(mockMilestoneLoader.byEscrowId.load).toHaveBeenCalledTimes(2);
    });
  });
});
