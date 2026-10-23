import { z } from 'zod';
import { IsStellarPublicKey } from '../common/validators/is-stellar-public-key.validator';

/** Shared across every Stellar address field in this module so the format check can't drift. */
export const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export const CreateEscrowSchema = z
  .object({
    depositor: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address'),
    beneficiary: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address'),
    amountXLM: z.string().regex(/^\d+(\.\d{1,7})?$/, 'Invalid XLM amount'),
    deadlineBlocks: z.number().int().positive().optional(),
  })
  .refine(data => data.depositor !== data.beneficiary, {
    message: 'depositor and beneficiary must not be the same address',
    path: ['beneficiary'],
  });

export type CreateEscrowDto = z.infer<typeof CreateEscrowSchema>;

export const ReleaseEscrowSchema = z.object({
  escrowId: z.string().min(1),
  signerAddress: z.string().regex(STELLAR_ADDRESS_REGEX),
});

export type ReleaseEscrowDto = z.infer<typeof ReleaseEscrowSchema>;

// The request body carries only the dispute details. The escrow comes from the `:id` path
// parameter and the initiator from the authenticated JWT, so neither belongs in the body (#800).
export const RaiseDisputeSchema = z.object({
  // Optional: callers may omit it, and the controllers then record 'No reason provided'.
  reason: z.string().min(10).max(500).optional(),
  evidenceUrl: z.string().url().optional(),
});

export type RaiseDisputeDto = z.infer<typeof RaiseDisputeSchema>;

export const BatchApproveMilestoneSchema = z.object({
  milestoneIds: z.array(z.string().min(1)).min(1).max(100),
  signerAddress: z.string().regex(STELLAR_ADDRESS_REGEX),
});

export type BatchApproveMilestoneDto = z.infer<typeof BatchApproveMilestoneSchema>;

export interface BatchApproveResult {
  succeeded: Array<{ id: string; status: string }>;
  failed: Array<{ id: string; reason: string }>;
}
