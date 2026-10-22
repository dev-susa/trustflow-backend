import { Module } from '@nestjs/common';
import { EscrowModule } from '../../escrow.module';
import { DeliverableLoader } from './deliverable.loader';
import { JurorVoteLoader } from './juror-vote.loader';
import { MilestoneLoader } from './milestone.loader';
import { UserProfileLoader } from './user-profile.loader';

@Module({
  imports: [EscrowModule],
  providers: [DeliverableLoader, JurorVoteLoader, MilestoneLoader, UserProfileLoader],
  exports: [DeliverableLoader, JurorVoteLoader, MilestoneLoader, UserProfileLoader],
})
export class DataLoaderModule {}
