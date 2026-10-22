import { forwardRef, Module } from '@nestjs/common';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { EscrowEventsConsumer } from './escrow-events.consumer';
import { WebhookModule } from '../webhook/webhook.module';
import { ReputationModule } from '../reputation/reputation.module';
import { EscrowWriteModule } from '../escrow-write/escrow-write.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DisputeModule } from '../dispute/dispute.module';

@Module({
  imports: [
    WebhookModule,
    ReputationModule,
    EscrowWriteModule,
    MonitoringModule,
    OutboxModule,
    forwardRef(() => DisputeModule),
  ],
  controllers: [EscrowController],
  providers: [EscrowService, EscrowEventsConsumer],
  exports: [EscrowService],
})
export class EscrowModule {}
