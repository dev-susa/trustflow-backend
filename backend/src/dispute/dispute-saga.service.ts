import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  OnModuleInit,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { AuditService } from '../audit/audit.service';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import {
  DisputeSaga,
  DisputeStep,
  DisputeVerdict,
  JurorVote,
  SagaStepRecord,
} from './dispute.types';
import { EscalateDisputeDto, AssignJurorsDto, CastVoteDto, ExecutePayoutDto } from './dispute.dto';
import { Escrow, EscrowService } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { NotificationService } from '../notification/notification.service';
import { ArweaveArchiveService } from './arweave-archive.service';
import { config } from '../config/env.config';
import { getCurrentUtcDate, toUtcIsoString } from '../common/dates';
import { EscrowChainStateClient } from '../escrow-reconciliation/escrow-chain-state.client';

/** Simple keyed mutex for serializing concurrent operations. */
class KeyedMutex {
  private locks: Map<string, Promise<void>> = new Map();

  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = this.locks.get(key) ?? Promise.resolve();
    const next = current.then(fn);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

/** Webhook event names emitted by the saga */
export const SAGA_EVENTS = {
  /** Public event (#636): one per dispute, full escrow payload plus `sagaId`. */
  RAISED: 'dispute.raised',
  ESCALATED: 'dispute.escalated',
  JURORS_ASSIGNED: 'dispute.jurors_assigned',
  VOTE_CAST: 'dispute.vote_cast',
  VERDICT_REACHED: 'dispute.verdict_reached',
  PAYOUT_EXECUTED: 'dispute.payout_executed',
  SAGA_COMPLETED: 'dispute.saga_completed',
  SAGA_COMPENSATING: 'dispute.saga_compensating',
  SAGA_FAILED: 'dispute.saga_failed',
} as const;

const SAGA_KEY_PREFIX = 'saga:';
const SAGAS_INDEX_KEY = 'sagas:index';
const SAGAS_BY_ESCROW_PREFIX = 'sagas:by-escrow:';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const DISPUTE_SAGA_PERSISTENCE_FALLBACK_METRIC = 'dispute_saga_persistence_fallback_total';

/**
 * Sentinel initiator for chain-originated disputes.
 *
 * Per #463 (docs/soroban-event-spec.md), `escrow_disputed` events carry only an
 * escrow id and an optional `reason` — no initiator/discriminator field. This
 * sentinel marks that absence explicitly instead of fabricating a party.
 */
export const CHAIN_DISPUTE_INITIATOR = 'chain:unknown';

export interface EscalateOptions {
  /** Defaults to 'api'. Chain path passes 'chain'. */
  origin?: 'api' | 'chain';
}

/**
 * Orchestrates the dispute resolution saga (escalation → juror assignment → voting → payout),
 * with a compensating action for every step. Backed by Redis so saga progress survives restarts
 * and is shared across instances — see PERSISTENT_STORAGE_SPIKE.md and its "Follow-up decisions"
 * addendum (#190): losing saga state mid-flight on restart would otherwise leave a dispute stuck
 * between steps with no record of what was already done.
 *
 * Every method that reads a saga then mutates it (`saga.currentStep = ...`, etc.) explicitly
 * persists the change afterward — unlike the original in-memory `Map`, a Redis-backed read
 * returns a freshly deserialized copy, not a live reference, so relying on reference semantics
 * to make a mutation "stick" would silently no-op once the store is Redis-backed.
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `DISPUTE_SAGA_PERSISTENCE_FALLBACK_METRIC`.
 *
 * Concurrency strategy: Transitions within a single saga and escalations within a single escrow
 * are serialized using in-process keyed mutexes. This ensures atomicity at the single-instance
 * level. Cross-instance coordination is out of scope — once saga state is persisted in a shared
 * backend (e.g. a database), add distributed locking via DistributedLockService or database
 * row-level locking to coordinate across instances.
 */
@Injectable()
export class DisputeSagaService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(DisputeSagaService.name);
  /** Fallback saga store, only used while Redis is unavailable. */
  private readonly sagas: Map<string, DisputeSaga> = new Map();
  /** Fallback secondary index: escrowId → sagaId (one active saga per escrow). */
  private readonly escrowIndex: Map<string, string> = new Map();
  /** Mutex for serializing escalations per escrow (and saga transitions per saga). */
  private readonly escalateMutex = new KeyedMutex();
  private readonly sagaMutex = new KeyedMutex();

  constructor(
    private readonly escrowService: EscrowService,
    private readonly webhookService: WebhookService,
    private readonly notificationService: NotificationService,
    private readonly arweaveArchiveService: ArweaveArchiveService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly metrics: MetricsService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly discordService?: DiscordService,
    @Optional() private readonly chainClient?: EscrowChainStateClient,
  ) {}

  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'DisputeSagaService requires REDIS_URL to be configured in production — refusing to ' +
          'start with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────

  async findById(sagaId: string): Promise<DisputeSaga> {
    const saga = await this.tryFindById(sagaId);
    if (!saga) throw new NotFoundException(`Dispute saga ${sagaId} not found`);
    return saga;
  }

  async findByEscrowId(escrowId: string): Promise<DisputeSaga | undefined> {
    if (this.redis) {
      try {
        const sagaId = await this.redis.get(this.escrowIndexKey(escrowId));
        return sagaId ? await this.tryFindById(sagaId) : undefined;
      } catch (err) {
        this.logFallback('findByEscrowId', err);
      }
    }

    const sagaId = this.escrowIndex.get(escrowId);
    return sagaId ? this.sagas.get(sagaId) : undefined;
  }

  async findAll(): Promise<DisputeSaga[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(SAGAS_INDEX_KEY);
        if (ids.length === 0) return [];
        const raw = await this.redis.mget(...ids.map(id => this.sagaKey(id)));
        return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as DisputeSaga);
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }

    return [...this.sagas.values()];
  }

  // ─── Step 1: Escalation ───────────────────────────────────────────

  /**
   * Opens a new dispute saga for an escrow — the single off-chain entry point
   * for disputes (#633): the direct `POST /escrows/:id/dispute` route, the
   * saga route and the chain handler all come through here.
   *
   * Ordering (#634): the saga is persisted *before* the escrow is frozen, so
   * there is never a `disputed` escrow without a saga recorded for it:
   *   1. persist the saga at ESCALATION (records `priorEscrowStatus`);
   *   2. `raiseDispute()` freezes the escrow;
   *   3. persist the saga at JUROR_ASSIGNMENT.
   * A failure at 1 changes nothing; at 2 or 3 the saga is marked FAILED and
   * only the change this call made is reverted (#635). A crash between 2 and 3
   * leaves the saga at ESCALATION — still an active saga for the escrow, so
   * the dispute is never orphaned.
   *
   * Notifications (#636) are sent once, after step 3 commits, and a delivery
   * failure never un-does a committed dispute.
   *
   * Serialized per escrow to prevent double escalation.
   */
  async escalate(
    escrowId: string,
    dto: EscalateDisputeDto,
    opts: EscalateOptions = {},
  ): Promise<DisputeSaga> {
    const origin = opts.origin ?? 'api';
    const { saga, escrow } = await this.escalateMutex.lock(escrowId, async () => {
      // Guard: only one active saga per escrow
      const existing = await this.findByEscrowId(escrowId);
      if (
        existing &&
        existing.currentStep !== DisputeStep.FAILED &&
        existing.currentStep !== DisputeStep.COMPLETED
      ) {
        throw new ConflictException(`An active dispute saga already exists for escrow ${escrowId}`);
      }

      const escrow = await this.escrowService.findById(escrowId);
      if (!escrow) throw new NotFoundException(`Escrow ${escrowId} not found`);
      // Only an active escrow can start a new dispute. An escrow that is already
      // `disputed` with no active saga (an orphan from before #633) is adopted
      // rather than rejected: that is not a new dispute, just a missing saga.
      if (escrow.status !== 'active' && escrow.status !== 'disputed') {
        throw new BadRequestException(`Cannot dispute a ${escrow.status} escrow`);
      }

      // Verify that initiator is either depositor or beneficiary, unless this is a
      // chain-originated dispute with no reliable initiator (#463): the sentinel
      // CHAIN_DISPUTE_INITIATOR is the only non-party value accepted.
      const isChainUnknown = origin === 'chain' && dto.initiator === CHAIN_DISPUTE_INITIATOR;
      if (!isChainUnknown) {
        if (dto.initiator !== escrow.depositor && dto.initiator !== escrow.beneficiary) {
          throw new ForbiddenException(
            'Only the depositor or beneficiary can escalate a dispute for this escrow',
          );
        }
      }

      const sagaId = `saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = toUtcIsoString(getCurrentUtcDate());

      const saga: DisputeSaga = {
        sagaId,
        escrowId,
        initiator: dto.initiator,
        origin,
        reason: dto.reason,
        priorEscrowStatus: escrow.status,
        currentStep: DisputeStep.ESCALATION,
        votes: [],
        stepHistory: [],
        createdAt: now,
        updatedAt: now,
      };

      this.recordStepStart(saga, DisputeStep.ESCALATION);

      // Step 1: record the saga before touching the escrow. Nothing to undo if
      // this fails — the escrow has not been changed.
      await this.createSaga(saga);

      // What this call changed, so compensation reverts only that (#635).
      let frozen: Escrow | undefined;
      try {
        // Step 2: freeze the escrow, unless adopting an already-disputed one.
        if (escrow.status !== 'disputed') {
          frozen = await this.escrowService.raiseDispute(escrowId, dto.reason, dto.initiator);
        }

        // Placeholder until the on-chain write path lands (#180) — not a chain reference.
        saga.escalationTxHash = `escalation-tx-${sagaId}`;
        this.recordStepComplete(saga, DisputeStep.ESCALATION);
        saga.currentStep = DisputeStep.JUROR_ASSIGNMENT;
        this.touch(saga);

        // Step 3: commit the saga's progress.
        await this.persistSaga(saga);
      } catch (error) {
        await this.compensateEscalation(saga, error, frozen);
        throw error;
      }

      this.logger.log(`Saga ${sagaId}: escalation complete for escrow ${escrowId}`);
      return { saga, escrow: frozen ?? escrow };
    });

    await this.afterEscalation(saga, escrow);
    return saga;
  }

  /**
   * Post-commit side effects of a successful escalation — sent exactly once
   * per dispute, whatever the entry point (#636). Each is log-and-continue:
   * the dispute is already committed, so a delivery failure must not undo it.
   */
  private async afterEscalation(saga: DisputeSaga, escrow: Escrow): Promise<void> {
    const { sagaId, escrowId } = saga;
    const bestEffort = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        this.logger.error(`Saga ${sagaId}: ${what} failed after escalation`, err);
      }
    };

    if (this.audit) {
      await bestEffort('audit log', () =>
        this.audit!.logOperation({
          operation: 'DISPUTE_ESCALATE',
          user: saga.initiator,
          entityId: sagaId,
          entityType: 'dispute_saga',
          beforeState: null,
          afterState: saga,
          metadata: { escrowId, reason: saga.reason },
        }),
      );
    }

    // Public event: the payload the direct route used to send, plus sagaId.
    await bestEffort(SAGA_EVENTS.RAISED, () =>
      this.webhookService.dispatch(SAGA_EVENTS.RAISED, {
        escrowId,
        depositor: escrow.depositor,
        beneficiary: escrow.beneficiary,
        amountXLM: escrow.amountXLM,
        reason: saga.reason,
        disputedAt: escrow.disputedAt,
        sagaId,
      }),
    );
    // Internal saga event.
    await bestEffort(SAGA_EVENTS.ESCALATED, () =>
      this.webhookService.dispatch(SAGA_EVENTS.ESCALATED, { sagaId, escrowId }),
    );
    if (this.discordService) {
      await bestEffort('Discord notification', () =>
        this.discordService!.notifyDisputeNeedsJurors({
          escrowId,
          depositor: escrow.depositor,
          beneficiary: escrow.beneficiary,
          amountXLM: escrow.amountXLM,
          reason: saga.reason,
        }),
      );
    }
    await bestEffort('in-app notification', () =>
      this.notificationService.notifyDisputeEscalation({
        escrowId,
        depositor: escrow.depositor,
        beneficiary: escrow.beneficiary,
        amountXLM: escrow.amountXLM,
        reason: saga.reason,
      }),
    );
  }

  /**
   * Chain entry point for `escrow_disputed` events. Per #463 the event cannot
   * reliably identify an initiator, so no party is fabricated: the saga is
   * recorded with the `chain:unknown` sentinel and `origin: 'chain'`.
   * Idempotent per escrow — returns the existing active saga on re-delivery.
   */
  async escalateFromChain(escrowId: string, reason: string): Promise<DisputeSaga> {
    const existing = await this.findByEscrowId(escrowId);
    if (
      existing &&
      existing.currentStep !== DisputeStep.FAILED &&
      existing.currentStep !== DisputeStep.COMPLETED
    ) {
      this.logger.warn(`Chain dispute for escrow ${escrowId} already has saga ${existing.sagaId}`);
      return existing;
    }
    return this.escalate(
      escrowId,
      { initiator: CHAIN_DISPUTE_INITIATOR, reason } as EscalateDisputeDto,
      { origin: 'chain' },
    );
  }

  // ─── Compensating action for Step 1 ──────────────────────────────

  /**
   * Reverts only what this saga's escalation changed (#635). `frozen` is the
   * escrow as this saga's own `raiseDispute()` left it, or undefined if that
   * call never succeeded (it threw, or the escrow was adopted already
   * disputed) — in which case the escrow is left exactly as it is, so a
   * dispute raised by another path or saga is never undone.
   *
   * #647: if an on-chain transaction succeeded but the DB write failed, this
   * compensation re-reads the chain state and syncs the DB to match. This
   * ensures the saga state reflects the canonical on-chain contract state even
   * when local persistence fails.
   */
  private async compensateEscalation(
    saga: DisputeSaga,
    error: unknown,
    frozen: Escrow | undefined,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Saga ${saga.sagaId}: compensating escalation — ${reason}`);
    this.recordStepFailed(saga, DisputeStep.ESCALATION, reason);
    saga.currentStep = DisputeStep.COMPENSATING;
    saga.compensationReason = reason;

    try {
      // #647: If the escalation reached the chain but the DB write failed, re-read the
      // canonical chain state and sync the DB to match. This prevents desynchronization
      // where the contract is disputed but off-chain records remain active.
      const escrow = await this.escrowService.findById(saga.escrowId);
      if (escrow?.contractEscrowId && this.chainClient) {
        try {
          await this.syncEscrowFromChain(escrow.contractEscrowId);
          this.logger.log(
            `Saga ${saga.sagaId}: re-synced escrow ${saga.escrowId} from chain state after escalation failure`,
          );
        } catch (syncErr) {
          this.logger.error(
            `Saga ${saga.sagaId}: failed to sync escrow from chain during compensation`,
            syncErr,
          );
          // Continue with the local revert — a failed sync is logged but shouldn't block compensation.
        }
      }

      if (frozen) {
        const currentEscrow = await this.escrowService.findById(saga.escrowId);
        // Still the dispute this saga raised (same disputedAt) — restore the
        // recorded prior status. Anything else means someone has changed the
        // escrow since, and it is theirs to keep.
        if (
          currentEscrow &&
          currentEscrow.status === 'disputed' &&
          currentEscrow.disputedAt === frozen.disputedAt &&
          saga.priorEscrowStatus
        ) {
          await this.escrowService.correctStatus(saga.escrowId, {
            status: saga.priorEscrowStatus as Escrow['status'],
            clearDispute: true,
          });
        }
      }
      this.recordStepCompensated(saga, DisputeStep.ESCALATION);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: escalation compensation itself failed`, compError);
    }

    this.markFailed(saga, reason);
    try {
      await this.persistSaga(saga);
    } catch (persistError) {
      this.logger.error(`Saga ${saga.sagaId}: could not record failed escalation`, persistError);
    }
    await this.webhookService.dispatch(SAGA_EVENTS.SAGA_FAILED, {
      sagaId: saga.sagaId,
      reason,
      step: DisputeStep.ESCALATION,
    });
  }

  /**
   * Re-reads the canonical on-chain state for an escrow and updates the DB to match.
   * Used by compensating actions when an on-chain write succeeded but the local DB
   * update failed, preventing desynchronization between chain and off-chain state.
   *
   * #647: This is the recovery mechanism that ensures dispute saga state always reflects
   * the true on-chain contract state, even when database failures occur mid-transaction.
   */
  private async syncEscrowFromChain(contractEscrowId: string): Promise<void> {
    if (!this.chainClient) {
      this.logger.warn(
        `Cannot sync escrow ${contractEscrowId} from chain: no chain client available`,
      );
      return;
    }

    const chainState = await this.chainClient.getEscrow(contractEscrowId);
    if (!chainState) {
      this.logger.warn(
        `Chain returned no state for escrow contract ${contractEscrowId} — may have been deleted on-chain`,
      );
      return;
    }

    // Find the off-chain escrow by its contract ID
    const escrows = await this.escrowService.findAll();
    const escrow = escrows.find(e => e.contractEscrowId === contractEscrowId);

    if (!escrow) {
      this.logger.warn(
        `No off-chain escrow found for contract ${contractEscrowId} — skipping sync`,
      );
      return;
    }

    // Sync the status if it differs
    if (escrow.status !== chainState.status) {
      this.logger.log(
        `Syncing escrow ${escrow.id} status from ${escrow.status} to ${chainState.status} (chain is authoritative)`,
      );
      await this.escrowService.applyChainState(escrow.id, { status: chainState.status });
    }

    // If the chain shows the escrow is disputed, ensure the off-chain record reflects that
    if (chainState.status === 'disputed' && escrow.status !== 'disputed') {
      await this.escrowService.applyChainState(escrow.id, { status: 'disputed' });
    }
  }

  // ─── Step 2: Juror Assignment ─────────────────────────────────────

  /**
   * Assigns jurors to review the dispute.
   * Compensating action: clear juror list and re-open for assignment.
   * Serialized per saga to prevent concurrent transitions.
   */
  async assignJurors(sagaId: string, dto: AssignJurorsDto): Promise<DisputeSaga> {
    return this.sagaMutex.lock(sagaId, async () => {
      const saga = await this.findById(sagaId);
      this.assertStep(saga, DisputeStep.JUROR_ASSIGNMENT);

      // Validate input before initializing the step to avoid treating input errors as infrastructure failures
      const unique = [...new Set(dto.jurors)];
      if (unique.length < 3) {
        throw new BadRequestException('At least 3 distinct juror addresses are required');
      }
      if (unique.length % 2 === 0) {
        throw new BadRequestException('Juror count must be odd to prevent vote ties');
      }

      // Prevent escrow parties from being assigned as jurors to avoid conflicts of interest
      const escrow = await this.escrowService.findById(saga.escrowId);
      if (escrow) {
        for (const juror of unique) {
          if (juror === escrow.depositor || juror === escrow.beneficiary) {
            throw new BadRequestException(
              'Escrow parties (depositor and beneficiary) cannot be assigned as jurors',
            );
          }
        }
      }

      this.recordStepStart(saga, DisputeStep.JUROR_ASSIGNMENT);

      try {
        saga.assignedJurors = unique;
        this.recordStepComplete(saga, DisputeStep.JUROR_ASSIGNMENT);
        saga.currentStep = DisputeStep.VOTING;
        this.touch(saga);
        await this.persistSaga(saga);

        await this.webhookService.dispatch(SAGA_EVENTS.JURORS_ASSIGNED, {
          sagaId,
          jurors: unique,
        });
        // TODO: Implement notifyJurorsAssigned notification
        // await this.notificationService.notifyJurorsAssigned({
        //   disputeId: sagaId,
        //   escrowId: saga.escrowId,
        //   jurors: unique,
        // });

        this.logger.log(`Saga ${sagaId}: ${unique.length} jurors assigned`);
        return saga;
      } catch (error) {
        await this.compensateJurorAssignment(saga, error);
        throw error;
      }
    });
  }

  // ─── Compensating action for Step 2 ──────────────────────────────

  private async compensateJurorAssignment(saga: DisputeSaga, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Saga ${saga.sagaId}: compensating juror assignment — ${reason}`);
    this.recordStepFailed(saga, DisputeStep.JUROR_ASSIGNMENT, reason);
    saga.currentStep = DisputeStep.COMPENSATING;
    saga.compensationReason = reason;

    try {
      // Compensating action: clear the assigned jurors, revert to prior step
      saga.assignedJurors = undefined;
      saga.currentStep = DisputeStep.JUROR_ASSIGNMENT;
      this.recordStepCompensated(saga, DisputeStep.JUROR_ASSIGNMENT);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: juror assignment compensation failed`, compError);
    }

    this.markFailed(saga, reason);
    await this.persistSaga(saga);
    await this.webhookService.dispatch(SAGA_EVENTS.SAGA_COMPENSATING, {
      sagaId: saga.sagaId,
      step: DisputeStep.JUROR_ASSIGNMENT,
      reason,
    });
  }

  // ─── Step 3: Voting ───────────────────────────────────────────────

  /**
   * Records a juror vote. When all assigned jurors have voted,
   * the verdict is computed automatically (exactly once, serialized per saga).
   * Compensating action: remove the vote and mark voting as incomplete.
   */
  async castVote(
    sagaId: string,
    dto: CastVoteDto,
    callerAddress?: string,
  ): Promise<DisputeSaga> {
    return this.sagaMutex.lock(sagaId, async () => {
      const saga = await this.findById(sagaId);
      this.assertStep(saga, DisputeStep.VOTING);

      if (callerAddress && callerAddress !== dto.jurorAddress) {
        throw new ForbiddenException(
          `Authenticated wallet ${callerAddress} does not match juror address ${dto.jurorAddress}`,
        );
      }

      if (!saga.assignedJurors?.includes(dto.jurorAddress)) {
        throw new BadRequestException(`${dto.jurorAddress} is not an assigned juror for this saga`);
      }

      if (saga.votes?.some(v => v.jurorAddress === dto.jurorAddress)) {
        throw new ConflictException(`Juror ${dto.jurorAddress} has already voted`);
      }

      this.recordStepStart(saga, DisputeStep.VOTING);

      try {
        const vote: JurorVote = {
          jurorAddress: dto.jurorAddress,
          vote: dto.vote,
          castAt: toUtcIsoString(getCurrentUtcDate()),
        };
        saga.votes = [...(saga.votes ?? []), vote];
        this.touch(saga);

        await this.webhookService.dispatch(SAGA_EVENTS.VOTE_CAST, {
          sagaId,
          jurorAddress: dto.jurorAddress,
          votesIn: saga.votes.length,
          votesNeeded: saga.assignedJurors.length,
        });

        // All jurors have voted — compute verdict (exactly once)
        if (saga.votes.length === saga.assignedJurors.length && !saga.verdict) {
          const verdict = this.computeVerdict(saga.votes);
          saga.verdict = verdict;
          this.recordStepComplete(saga, DisputeStep.VOTING);
          saga.currentStep = DisputeStep.PAYOUT;

          await this.webhookService.dispatch(SAGA_EVENTS.VERDICT_REACHED, { sagaId, verdict });
          this.logger.log(`Saga ${sagaId}: verdict reached — ${verdict}`);

          const escrow = await this.escrowService.findById(saga.escrowId);
          if (escrow) {
            // TODO: Implement notifyVerdictReached notification
            // await this.notificationService.notifyVerdictReached({
            //   disputeId: sagaId,
            //   escrowId: saga.escrowId,
            //   verdict,
            //   depositor: escrow.depositor,
            //   beneficiary: escrow.beneficiary,
            // });
          }
        }

        await this.persistSaga(saga);
        return saga;
      } catch (error) {
        await this.compensateVoting(saga, dto.jurorAddress, error);
        throw error;
      }
    });
  }

  /** Simple majority vote tally */
  private computeVerdict(votes: JurorVote[]): DisputeVerdict {
    const tally = { depositor: 0, beneficiary: 0, split: 0 };
    for (const v of votes) tally[v.vote]++;

    if (tally.depositor > tally.beneficiary && tally.depositor > tally.split) {
      return DisputeVerdict.DEPOSITOR_WINS;
    }
    if (tally.beneficiary > tally.depositor && tally.beneficiary > tally.split) {
      return DisputeVerdict.BENEFICIARY_WINS;
    }
    return DisputeVerdict.SPLIT;
  }

  // ─── Compensating action for Step 3 ──────────────────────────────

  private async compensateVoting(
    saga: DisputeSaga,
    jurorAddress: string,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Saga ${saga.sagaId}: compensating vote from ${jurorAddress} — ${reason}`);
    this.recordStepFailed(saga, DisputeStep.VOTING, reason);

    try {
      // Compensating action: remove the problematic vote
      saga.votes = saga.votes?.filter(v => v.jurorAddress !== jurorAddress);
      saga.verdict = undefined;
      this.recordStepCompensated(saga, DisputeStep.VOTING);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: voting compensation failed`, compError);
    }

    await this.persistSaga(saga);
    await this.webhookService.dispatch(SAGA_EVENTS.SAGA_COMPENSATING, {
      sagaId: saga.sagaId,
      step: DisputeStep.VOTING,
      reason,
    });
  }

  // ─── Step 4: Payout ───────────────────────────────────────────────

  /**
   * Executes the payout according to the verdict (exactly once, serialized per saga).
   * Returns 409 Conflict if another request already completed the payout.
   * Compensating action: reverse the release and flag the escrow for manual review.
   */
  async executePayout(sagaId: string, dto: ExecutePayoutDto): Promise<DisputeSaga> {
    return this.sagaMutex.lock(sagaId, async () => {
      const saga = await this.findById(sagaId);
      this.assertStep(saga, DisputeStep.PAYOUT);

      if (!saga.verdict) {
        throw new BadRequestException('Cannot execute payout: no verdict has been recorded');
      }

      // Check if payout was already executed (another request won the race)
      if (saga.payoutTxHash) {
        throw new ConflictException('Payout has already been executed for this saga');
      }

      this.recordStepStart(saga, DisputeStep.PAYOUT);

      try {
        const beforeState = { ...saga };
        await this.applyPayout(saga, dto.splitPercentage);

        saga.payoutTxHash = `payout-tx-${sagaId}-${Date.now()}`;
        this.recordStepComplete(saga, DisputeStep.PAYOUT);

        const now = toUtcIsoString(getCurrentUtcDate());
        saga.currentStep = DisputeStep.COMPLETED;
        saga.completedAt = now;
        this.touch(saga);
        await this.persistSaga(saga);

        if (this.audit) {
          await this.audit
            .logOperation({
              operation: 'DISPUTE_PAYOUT',
              user: 'admin',
              entityId: sagaId,
              entityType: 'dispute_saga',
              beforeState,
              afterState: saga,
              metadata: { verdict: saga.verdict, splitPercentage: dto.splitPercentage },
            })
            .catch(err => this.logger.error('Failed to write audit log', err));
        }

        await this.webhookService.dispatch(SAGA_EVENTS.PAYOUT_EXECUTED, {
          sagaId,
          verdict: saga.verdict,
          payoutTxHash: saga.payoutTxHash,
        });
        await this.webhookService.dispatch(SAGA_EVENTS.SAGA_COMPLETED, { sagaId });

        // ─── NEW: Archive dispute evidence to Arweave for permanent auditability ───
        try {
          const txId = await this.arweaveArchiveService.archiveDispute(saga);
          if (txId) {
            saga.arweaveTxId = txId;
            await this.persistSaga(saga);
            this.logger.log(
              `Arweave txId ${txId} recorded for completed saga ${saga.sagaId}`,
            );
          }
        } catch (err) {
          // Archive failure must not block dispute resolution
          this.logger.error(
            `Arweave archive failed for completed saga ${saga.sagaId} — continuing without archival`,
            err,
          );
        }
        // ──────────────────────────────────────────────────────────────

        const payoutEscrow = await this.escrowService.findById(saga.escrowId);
        if (payoutEscrow) {
          // TODO: Implement notifyPayoutExecuted notification
          // await this.notificationService.notifyPayoutExecuted({
          //   disputeId: sagaId,
          //   escrowId: saga.escrowId,
          //   verdict: saga.verdict,
          //   depositor: payoutEscrow.depositor,
          //   beneficiary: payoutEscrow.beneficiary,
          // });
        }

        this.logger.log(`Saga ${sagaId}: completed — payout executed for ${saga.verdict}`);
        return saga;
      } catch (error) {
        await this.compensatePayout(saga, error);
        throw error;
      }
    });
  }

  /** Apply the payout by releasing or marking the escrow based on the verdict */
  private async applyPayout(saga: DisputeSaga, splitPercentage?: number): Promise<void> {
    switch (saga.verdict) {
      case DisputeVerdict.BENEFICIARY_WINS:
        await this.escrowService.release(saga.escrowId);
        break;

      case DisputeVerdict.DEPOSITOR_WINS:
        await this.escrowService.cancel(saga.escrowId);
        break;

      case DisputeVerdict.SPLIT:
        await this.escrowService.split(saga.escrowId, splitPercentage ?? 50);
        break;
    }
  }

  // ─── Compensating action for Step 4 ──────────────────────────────

  private async compensatePayout(saga: DisputeSaga, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Saga ${saga.sagaId}: compensating payout — ${reason}`);
    this.recordStepFailed(saga, DisputeStep.PAYOUT, reason);
    saga.currentStep = DisputeStep.COMPENSATING;
    saga.compensationReason = reason;

    try {
      // Compensating action: flag escrow for manual admin review
      const escrow = await this.escrowService.findById(saga.escrowId);
      if (escrow) {
        // revert to disputed so it isn't lost, and flag for manual review
        await this.escrowService.correctStatus(saga.escrowId, {
          status: 'disputed',
          requiresManualReview: true,
        });
      }
      saga.currentStep = DisputeStep.PAYOUT; // allow retry
      this.recordStepCompensated(saga, DisputeStep.PAYOUT);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: payout compensation failed`, compError);
    }

    this.markFailed(saga, reason);
    await this.persistSaga(saga);
    await this.webhookService.dispatch(SAGA_EVENTS.SAGA_FAILED, {
      sagaId: saga.sagaId,
      step: DisputeStep.PAYOUT,
      reason,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private assertStep(saga: DisputeSaga, expected: DisputeStep): void {
    if (saga.currentStep === DisputeStep.FAILED) {
      throw new BadRequestException(`Saga ${saga.sagaId} has failed and cannot be advanced`);
    }
    if (saga.currentStep === DisputeStep.COMPLETED) {
      throw new BadRequestException(`Saga ${saga.sagaId} is already completed`);
    }
    if (saga.currentStep !== expected) {
      throw new BadRequestException(
        `Saga ${saga.sagaId} is at step ${saga.currentStep}, expected ${expected}`,
      );
    }
  }

  private touch(saga: DisputeSaga): void {
    saga.updatedAt = toUtcIsoString(getCurrentUtcDate());
  }

  private markFailed(saga: DisputeSaga, reason: string): void {
    saga.currentStep = DisputeStep.FAILED;
    saga.failedAt = toUtcIsoString(getCurrentUtcDate());
    saga.compensationReason = reason;
    this.touch(saga);
  }

  private recordStepStart(saga: DisputeSaga, step: DisputeStep): void {
    // Remove any prior incomplete record for the same step (idempotent retry)
    saga.stepHistory = saga.stepHistory.filter(r => !(r.step === step && !r.completedAt));
    saga.stepHistory.push({ step, startedAt: toUtcIsoString(getCurrentUtcDate()) });
  }

  private recordStepComplete(saga: DisputeSaga, step: DisputeStep): void {
    const record = this.lastRecord(saga, step);
    if (record) record.completedAt = toUtcIsoString(getCurrentUtcDate());
  }

  private recordStepFailed(saga: DisputeSaga, step: DisputeStep, error: string): void {
    const record = this.lastRecord(saga, step);
    if (record) {
      record.failedAt = toUtcIsoString(getCurrentUtcDate());
      record.error = error;
    }
  }

  private recordStepCompensated(saga: DisputeSaga, step: DisputeStep): void {
    const record = this.lastRecord(saga, step);
    if (record) record.compensatedAt = toUtcIsoString(getCurrentUtcDate());
  }

  private lastRecord(saga: DisputeSaga, step: DisputeStep): SagaStepRecord | undefined {
    return [...saga.stepHistory].reverse().find(r => r.step === step);
  }

  // ─── Persistence ──────────────────────────────────────────────────

  /** First write for a new saga: entity + index + by-escrow pointer, atomically. */
  private async createSaga(saga: DisputeSaga): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.sagaKey(saga.sagaId), JSON.stringify(saga))
          .sadd(SAGAS_INDEX_KEY, saga.sagaId)
          .set(this.escrowIndexKey(saga.escrowId), saga.sagaId)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('createSaga', err);
      }
    }

    this.sagas.set(saga.sagaId, saga);
    this.escrowIndex.set(saga.escrowId, saga.sagaId);
  }

  /** Writes a saga's current field values. Used after every mutation to an already-created saga. */
  private async persistSaga(saga: DisputeSaga): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.sagaKey(saga.sagaId), JSON.stringify(saga))
          .sadd(SAGAS_INDEX_KEY, saga.sagaId)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('persistSaga', err);
      }
    }

    this.sagas.set(saga.sagaId, saga);
  }

  private async tryFindById(sagaId: string): Promise<DisputeSaga | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.sagaKey(sagaId));
        return raw ? (JSON.parse(raw) as DisputeSaga) : undefined;
      } catch (err) {
        this.logFallback('findById', err);
      }
    }

    return this.sagas.get(sagaId);
  }

  private assertTransactionOk(results: Array<[Error | null, unknown]> | null): void {
    if (!results) {
      throw new Error('Redis transaction aborted (exec() returned null, e.g. a WATCH conflict)');
    }
    const failed = results.find(([err]) => err);
    if (failed) {
      throw new Error(`Redis transaction command failed: ${failed[0]!.message}`);
    }
  }

  private sagaKey(sagaId: string): string {
    return `${SAGA_KEY_PREFIX}${sagaId}`;
  }

  private escrowIndexKey(escrowId: string): string {
    return `${SAGAS_BY_ESCROW_PREFIX}${escrowId}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics.increment(DISPUTE_SAGA_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for disputeSaga.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
