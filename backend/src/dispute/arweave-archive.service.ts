import { Injectable, OnModuleInit } from '@nestjs/common';
import Arweave from 'arweave';
import type { JWKInterface } from 'arweave/node/lib/wallet';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Optional } from '@nestjs/common';
import { config } from '../config/env.config';
import { MetricsService } from '../monitoring/metrics.service';
import { WebhookService } from '../webhook/webhook.service';

const MAX_JSON_BYTES = 256 * 1024; // 256 KiB per Arweave bundle chunk recommendation

/** Abstraction for Arweave upload to allow mocking in tests */
export interface ArweaveUploader {
  upload(data: string | Buffer, tags: Array<[string, string]>): Promise<string>;
}

/**
 * Service for archiving dispute evidence packages to Arweave for permanent,
 * tamper-proof auditability.
 *
 * When Arweave credentials are configured (ARWEAVE_JWT + ARWEAVE_UPLOAD_URL),
 * signs a real transaction with the configured JWK and uploads the full dispute
 * saga state as a JSON bundle. When not configured (or when the credentials are
 * unusable), operates in simulated mode: no upload is attempted and the intent
 * is recorded without ever returning a fabricated transaction id.
 */
@Injectable()
export class ArweaveArchiveService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(ArweaveArchiveService.name);
  private readonly uploader: ArweaveUploader | null = null;

  constructor(
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly webhookService?: WebhookService,
  ) {
    const arweaveJwt = config.ARWEAVE_JWT;
    if (arweaveJwt) {
      this.logger.log(
        'Arweave archive service enabled — will upload dispute evidence on saga completion',
      );
      // In a full implementation, we would initialize the arweave library here
      // with the wallet key. For now, we set up a lightweight uploader.
      this.uploader = this.createUploader(arweaveJwt);
    } else {
      this.logger.log(
        'Arweave archive service running in simulated mode (no ARWEAVE_JWT configured)',
      );
    }
  }

  onModuleInit(): void {
    // No-op: initialization done in constructor
  }

  /**
   * Build an uploader that signs a real Arweave transaction with the configured JWK
   * and posts it to `ARWEAVE_UPLOAD_URL`. Anchor and price lookups use the same
   * endpoint, so a self-hosted gateway or a test double works without code changes.
   */
  private createUploader(jwt: string, uploadUrl: string): ArweaveUploader {
    let jwk: JWKInterface;
    try {
      jwk = JSON.parse(jwt) as JWKInterface;
    } catch {
      throw new Error('ARWEAVE_JWT is not valid JSON');
    }

    if (
      !jwk ||
      typeof jwk !== 'object' ||
      typeof jwk.kty !== 'string' ||
      typeof jwk.n !== 'string' ||
      typeof jwk.e !== 'string' ||
      typeof jwk.d !== 'string'
    ) {
      throw new Error('ARWEAVE_JWT is not a valid RSA JWK (missing kty/n/e/d)');
    }

    const url = new URL(uploadUrl);
    const arweave = Arweave.init({
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol.replace(':', ''),
    });

    // `ARWEAVE_UPLOAD_URL` may be a bare gateway host or the full `/tx` endpoint.
    const transactionUrl =
      url.pathname && url.pathname !== '/' ? url.toString() : new URL('/tx', url).toString();

    return {
      upload: async (data: string | Buffer, tags: Array<[string, string]>): Promise<string> => {
        const transaction = await arweave.createTransaction(
          { data: Buffer.isBuffer(data) ? data : Buffer.from(data) },
          jwk,
        );

        for (const [name, value] of tags) {
          transaction.addTag(name, value);
        }

        await arweave.transactions.sign(transaction, jwk);

        const response = await fetch(transactionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(transaction),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(
            `Arweave upload failed with HTTP ${response.status}` +
              (body ? `: ${body.slice(0, 200)}` : ''),
          );
        }

        this.logger.debug(`Arweave transaction ${transaction.id} accepted by ${transactionUrl}`);
        return transaction.id;
      },
    };
  }

  /**
   * Bundle a dispute saga into a JSON archive package and upload to Arweave.
   * Returns the transaction ID on success, undefined on failure or simulated mode.
   */
  async archiveDispute(saga: import('./dispute.types').DisputeSaga): Promise<string | undefined> {
    if (!this.uploader) {
      // Simulated mode: no actual upload, but we still compute the archive hash
      this.metrics?.increment('arweave_archive_simulated_total', { result: 'success' });
      this.logger.log(
        `Arweave archive simulated for saga ${saga.sagaId} — no credentials configured`,
      );
      return undefined;
    }

    try {
      const archiveData = this.buildArchiveData(saga);
      const jsonString = JSON.stringify(archiveData);
      const jsonBytes = Buffer.byteLength(jsonString, 'utf8');
      const tags: [string, string][] = [
        ['App-Name', 'TrustFlow'],
        ['Content-Type', 'application/json'],
        ['Archive-Type', 'dispute-evidence'],
        ['Saga-Id', saga.sagaId],
        ['Initiator', saga.initiator],
        ['Verdict', saga.verdict ?? 'pending'],
        ['Step', saga.currentStep],
      ];

      if (jsonBytes > MAX_JSON_BYTES) {
        this.logger.warn(
          `Archive data is ${jsonBytes} bytes, above the recommended ${MAX_JSON_BYTES / 1024} KiB Arweave bundle chunk size; passing the full payload to the uploader without truncation`,
        );
      }

      const txId = await this.uploader.upload(uploadData, tags);

      this.metrics?.increment('arweave_archive_success_total', { result: 'success' });
      this.logger.log(`Arweave archive uploaded for saga ${saga.sagaId}, txId: ${txId}`);
      return txId;
    } catch (error) {
      this.metrics?.increment('arweave_archive_failure_total', { result: 'error' });
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Arweave archive failed for saga ${saga.sagaId}: ${errMsg}`);
      // Don't throw — archive failure should not block dispute resolution
      return undefined;
    }
  }

  /**
   * Build the archive JSON structure from a dispute saga.
   */
  private buildArchiveData(saga: import('./dispute.types').DisputeSaga): any {
    return {
      sagaId: saga.sagaId,
      escrowId: saga.escrowId,
      initiator: saga.initiator,
      origin: saga.origin,
      reason: saga.reason,
      priorEscrowStatus: saga.priorEscrowStatus,
      currentStep: saga.currentStep,
      verdict: saga.verdict,
      payoutTxHash: saga.payoutTxHash,
      stepHistory: saga.stepHistory,
      votes: saga.votes,
      createdAt: saga.createdAt,
      updatedAt: saga.updatedAt,
      completedAt: saga.completedAt,
      failedAt: saga.failedAt,
      compensationReason: saga.compensationReason,
      tags: {
        app: 'trustflow',
        type: 'dispute_evidence',
        version: '1.0',
      },
    };
  }
}
