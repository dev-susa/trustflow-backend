import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { EscrowResolver, MilestoneResolver, DeliverableResolver, EscrowPage } from './escrow.resolver';
import { EscrowService } from '../escrow.service';
import { EscrowType } from './types/escrow.type';
import { MilestoneType } from './types/milestone.type';
import { DeliverableType } from './types/deliverable.type';
import { JurorVoteType } from './types/juror-vote.type';
import { UserProfileType } from './types/user-profile.type';
import { DataLoaderModule } from './dataloader/dataloader.module';
import { config } from '../../config/env.config';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/escrow/graphql/schema.gql'),
      sortSchema: true,
      playground: (() => {
        try {
          return config.NODE_ENV !== 'production';
        } catch {
          return true;
        }
      })(),
      context: ({ req, res }: { req?: unknown; res?: unknown }) => ({ req, res }),
    }),
    DataLoaderModule,
    EscrowModule,
  ],
  providers: [
    EscrowResolver,
    MilestoneResolver,
    DeliverableResolver,
    EscrowPage,
    EscrowService,
    EscrowType,
    MilestoneType,
    DeliverableType,
    JurorVoteType,
    UserProfileType,
  ],
  exports: [GraphQLModule],
})
export class EscrowGraphQLModule {}
