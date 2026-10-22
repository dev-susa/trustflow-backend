import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { validateEnv } from '../../config/env.config';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { EscrowService } from '../escrow.service';
import { EscrowController } from '../escrow.controller';
import { EscrowModule } from '../escrow.module';

// The GraphQL module reads `config` while its decorator is evaluated, so config must be
// validated before the module is required (see escrow-graphql.integration.spec.ts).
validateEnv();
type GraphQLModuleExports = typeof import('./escrow-graphql.module');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EscrowGraphQLModule } = require('./escrow-graphql.module') as GraphQLModuleExports;

// Without Redis configured, EscrowService falls back to an in-memory store per instance,
// so two instances silently diverge. Provide the fallback (null) to exercise that path.
@Global()
@Module({
  providers: [{ provide: REDIS_CLIENT, useValue: null }],
  exports: [REDIS_CLIENT],
})
class TestRedisModule {}

describe('EscrowService singleton across REST and GraphQL', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [TestRedisModule, EscrowModule, EscrowGraphQLModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('resolves the same EscrowService instance inside EscrowGraphQLModule as the REST controller', () => {
    const controller: { escrowService: EscrowService } = moduleRef.get(EscrowController);
    const restService = controller.escrowService;

    // Looked up from the GraphQL module's own scope, so this only passes when the GraphQL
    // module reuses the provider exported by EscrowModule instead of declaring its own.
    const graphqlScopedService = moduleRef
      .select(EscrowGraphQLModule)
      .get(EscrowService, { strict: false });

    expect(graphqlScopedService).toBe(restService);
  });

  it('does not declare a second EscrowService provider in the GraphQL module', () => {
    const declared = Reflect.getMetadata('providers', EscrowGraphQLModule) as unknown[] | undefined;
    expect(declared ?? []).not.toContain(EscrowService);
  });
});
