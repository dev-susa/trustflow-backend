import { Module } from '@nestjs/common';
import { DisputeSagaService } from './dispute-saga.service';
import { DisputeSagaController } from './dispute-saga.controller';
import { EscrowDisputeController } from './escrow-dispute.controller';
import { ArweaveArchiveService } from './arweave-archive.service';
import { EscrowModule } from '../escrow/escrow.module';
import { WebhookModule } from '../webhook/webhook.module';
import { ReputationModule } from '../reputation/reputation.module';
import { NotificationModule } from '../notification/notification.module';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [EscrowModule, WebhookModule, ReputationModule, NotificationModule, MonitoringModule],
  controllers: [DisputeSagaController, EscrowDisputeController],
  providers: [DisputeSagaService, ArweaveArchiveService],
  exports: [DisputeSagaService, ArweaveArchiveService],
})
export class DisputeModule {}
