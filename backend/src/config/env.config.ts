import { z } from 'zod';

/**
 * Centralized environment variable validation using Zod.
 *
 * Every environment variable read by the application is declared here with its type,
 * format constraints, and required-vs-optional-with-default semantics. Validation
 * runs once at startup (see validateEnv() in main.ts) and fails fast with a readable
 * error listing every invalid/missing variable, rather than silently falling through
 * to defaults or unusable values scattered across the codebase.
 *
 * After validation, typed config values are exported via the `config` object for use
 * throughout the application, replacing inline `process.env.X || fallback` reads.
 */

/** `.env.example` ships blank values (`DB_HOST=`); treat them as unset. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalPositiveInt = () =>
  z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional());
const optionalNonnegativeInt = () =>
  z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().optional());
const optionalString = () => z.preprocess(blankToUndefined, z.string().optional());
const optionalBool = () => z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional());

const PLACEHOLDER_JWT_SECRETS = new Set([
  'change-me-in-production',
  'change-me-before-production',
  'your-secret',
  'secret',
]);

const EnvSchema = z
  .object({
    // Node environment
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Server configuration
    PORT: z.coerce.number().int().positive().default(3001),
    CORS_ORIGIN: z.preprocess(
      val => {
        if (typeof val !== 'string') return undefined;
        if (!val.trim()) return undefined;
        const origins = Array.from(
          new Set(
            val
              .split(',')
              .map(s => s.trim())
              .filter(Boolean),
          ),
        );
        return origins.length > 0 ? origins : undefined;
      },
      z.array(z.string().url().or(z.literal('*'))).optional(),
    ),
    API_URL: z.string().url().optional().default('http://localhost:3001'),
    BODY_LIMIT_MB: z.coerce.number().int().positive().default(15),
    ALLOW_NO_REDIS: optionalBool(),

    // Authentication & Security
    // JWT_SECRET is required in production but may fall back to a clearly-marked
    // test-only default in non-production environments so local dev/test can boot
    // without a real secret. Production without a secret must fail fast.
    JWT_SECRET: z.string().optional(),
    JWT_SECRET_PREVIOUS: z
      .string()
      .optional()
      .describe('Previous JWT signing secret kept active during a rotation overlap window'),
    ADMIN_ADDRESSES: z
      .string()
      .optional()
      .describe('Comma-separated list of Stellar addresses with admin access'),

    // Stellar Network Configuration
    STELLAR_NETWORK: z.enum(['TESTNET', 'PUBLIC', 'MAINNET']).default('TESTNET'),
    STELLAR_HORIZON_URL: z.string().url().optional(),
    SOROBAN_RPC_URL: z.string().url().optional(),
    TRUSTFLOW_CONTRACT_ID: z
      .string()
      .regex(/^C[A-Z2-7]{55}$/, 'TRUSTFLOW_CONTRACT_ID must be a valid Stellar contract address')
      .optional()
      .describe('Required for on-chain operations; optional for off-chain-only deployments'),

    // Stellar failover endpoints (comma-separated URLs)
    STELLAR_HORIZON_ENDPOINTS: z.string().optional(),
    SOROBAN_RPC_ENDPOINTS: z.string().optional(),
    SOROBAN_START_LEDGER: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Contract deployment ledger to start ingestion from'),

    // Stellar timeout configuration
    STELLAR_TX_VALIDITY_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60)
      .describe('Validity window (in seconds) for release transactions handed to the wallet'),
    STELLAR_RPC_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10000)
      .describe('Request timeout (ms) for Horizon/Soroban RPC client operations'),
    STELLAR_HEALTH_CHECK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5000)
      .describe('Timeout (ms) for Stellar endpoint health checks'),

    // Redis Configuration
    REDIS_URL: z
      .string()
      .url()
      .optional()
      .describe('Required for rate limiting, outbox relay, and distributed caches'),
    REDIS_COMMAND_TIMEOUT_MS: z.preprocess(
      blankToUndefined,
      z.coerce
        .number()
        .int()
        .positive()
        .default(1000)
        .describe(
          'Max time a single Redis command may wait for a reply before it is rejected, so a stalled Redis costs milliseconds instead of seconds of retries',
        ),
    ),

    // Database Configuration (PostgreSQL)
    DATABASE_URL: z
      .preprocess(blankToUndefined, z.string().url().optional())
      .describe('PostgreSQL connection string; currently optional infrastructure'),
    DATABASE_READ_REPLICAS: z
      .string()
      .optional()
      .describe(
        'Comma-separated list of read-replica connection strings. ' +
          'When set, DatabaseService routes read-only queries (queryRead) to replicas ' +
          'in a round-robin fashion and all writes to the primary pool.',
      ),

    // Monitoring & Observability
    DB_HOST: optionalString(),
    DB_PORT: optionalPositiveInt(),
    DB_NAME: optionalString(),
    DB_USER: optionalString(),
    DB_PASSWORD: optionalString(),
    DB_SSL: optionalBool(),
    DB_SSL_CA: optionalString(),
    DB_SSL_CERT: optionalString(),
    DB_SSL_KEY: optionalString(),
    DB_SSL_REJECT_UNAUTHORIZED: optionalBool(),
    DB_POOL_MAX: optionalPositiveInt(),
    DB_POOL_IDLE_TIMEOUT_MS: optionalPositiveInt(),
    DB_POOL_CONNECTION_TIMEOUT_MS: optionalPositiveInt(),
    DB_RETRY_ATTEMPTS: z.coerce
      .number()
      .int()
      .positive()
      .default(5)
      .describe(
        'Maximum number of connection retry attempts during pool initialization. Default 5.',
      ),
    DB_RETRY_BACKOFF_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(1000)
      .describe(
        'Base delay in milliseconds for exponential backoff between connection retries. Default 1000ms.',
      ),

    SWAGGER_ENABLED: optionalBool().describe(
      'Serve Swagger UI and the OpenAPI JSON; defaults to true outside production, false in production',
    ),
    SWAGGER_USER: optionalString(),
    SWAGGER_PASSWORD: optionalString(),

    SENTRY_DSN: z
      .preprocess(blankToUndefined, z.string().url().optional())
      .describe('Sentry error tracking DSN; errors are logged but not reported when unset'),
    APP_RELEASE: optionalString(),

    // OpenTelemetry Configuration
    OTEL_ENABLED: optionalBool().describe(
      'Set to "true" to enable OpenTelemetry auto-instrumentation. Defaults to false.',
    ),
    OTEL_SERVICE_NAME: optionalString().describe(
      'Service name reported in traces. Defaults to "trustflow-backend".',
    ),
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .preprocess(blankToUndefined, z.string().url().optional())
      .describe(
        'OTLP gRPC/HTTP endpoint for the trace exporter ' +
          '(e.g. http://otel-collector:4318). Required when OTEL_ENABLED=true.',
      ),
    OTEL_TRACES_SAMPLER_RATIO: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe(
        'Fraction of traces to sample (0.0–1.0). ' +
          '1.0 = sample everything (default), 0.1 = 10 % of traces.',
      ),

    // Discord Integration
    DISCORD_WEBHOOK_URL: z
      .preprocess(blankToUndefined, z.string().url().optional())
      .describe('Discord webhook for dispute notifications'),
    DISCORD_NOTIFICATION_MAX_RETRIES: z.coerce
      .number()
      .int()
      .positive()
      .default(3)
      .describe('Max retry attempts for failed Discord dispute notifications (#394). Default 3.'),
    DISCORD_NOTIFICATION_RETRY_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(1000)
      .describe('Base delay (ms) for exponential backoff in Discord retry logic. Default 1s.'),

    // Platform Balance Monitoring (#730)
    STELLAR_PLATFORM_ADDRESS: z
      .preprocess(
        blankToUndefined,
        z
          .string()
          .regex(/^G[A-Z2-7]{55}$/)
          .optional(),
      )
      .describe('Platform Stellar account address to monitor balance (G... format)'),
    STELLAR_LOW_BALANCE_THRESHOLD: z.coerce
      .number()
      .positive()
      .default(1)
      .describe(
        'Balance threshold (XLM) below which a low-balance warning is triggered. Default 1 XLM.',
      ),
    STELLAR_CRITICAL_BALANCE_THRESHOLD: z.coerce
      .number()
      .positive()
      .default(0.5)
      .describe(
        'Balance threshold (XLM) below which a critical alert is triggered. Default 0.5 XLM.',
      ),

    // Rate Limiting Configuration
    RATE_LIMIT_ABUSE_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_ABUSE_THRESHOLD: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(900),
    // Auth-route limits (#369): stricter than the global 100/60s default, per IP.
    AUTH_CHALLENGE_RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(10),
    AUTH_CHALLENGE_RATE_LIMIT_DURATION: z.coerce.number().int().positive().default(60),
    AUTH_VERIFY_RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(10),
    AUTH_VERIFY_RATE_LIMIT_DURATION: z.coerce.number().int().positive().default(60),
    TRUST_PROXY: z.preprocess(
      blankToUndefined,
      z
        .string()
        .default('false')
        .describe(
          "Express 'trust proxy' setting: 'false' (direct exposure), 'true', a hop count such as '1' (one load balancer), or a comma-separated list of proxy IPs/CIDRs. Needed behind a load balancer so request.ip is the client, not the proxy.",
        ),
    ),

    // WebSocket gateway (#393)
    WS_MAX_ROOMS_PER_CLIENT: z.coerce.number().int().positive().default(50),

    RATE_LIMIT_ON_REDIS_ERROR: z.preprocess(
      blankToUndefined,
      z
        .enum(['allow', 'deny'])
        .default('allow')
        .describe(
          'Default rate limiter behaviour when Redis is unreachable: allow (fail open) or deny (503 + Retry-After). Routes can override it with @RateLimitOnRedisError()',
        ),
    ),

    // Event Processing Configuration
    EVENT_PROCESSING_CONCURRENCY: z.coerce.number().int().positive().default(8),
    ESCROW_RECONCILIATION_SWEEP_CONCURRENCY: optionalPositiveInt(),
    ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS: optionalNonnegativeInt(),
    RUN_MIGRATIONS_ON_STARTUP: optionalBool(),
    MIGRATION_RUN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 24 * 60 * 60)
      .describe(
        'TTL (time-to-live) for completed/failed migration run records in Redis. Default 30 days.',
      ),
    MIGRATION_MAX_RUNS_PER_NAME: z.coerce
      .number()
      .int()
      .positive()
      .default(50)
      .describe(
        'Maximum number of run records to retain per migration name, even within the TTL window. Default 50.',
      ),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    WEBHOOK_RELAY_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    WEBHOOK_RELAY_LEASE_MS: z.coerce.number().int().positive().default(30_000),
    WEBHOOK_PROCESSOR_CONCURRENCY: z.coerce.number().int().positive().default(10),
    OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1000),
    OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().positive().default(100),
    OUTBOX_RELAY_LEASE_MS: z.coerce.number().int().positive().default(30_000),
    OUTBOX_DELIVERED_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60 * 60),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    OUTBOX_QUEUE_MAX_LENGTH: z.coerce.number().int().positive().default(1000),
    IDEMPOTENCY_KEY_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60),
    GIG_SEARCH_CACHE_TTL_SECONDS: optionalPositiveInt(),

    // IPFS Pinning Configuration
    PINATA_JWT: z.string().optional().describe('Pinata API JWT token'),
    WEB3_STORAGE_TOKEN: z.string().optional().describe('Web3.Storage API token'),
    INFURA_IPFS_PROJECT_ID: z.string().optional().describe('Infura IPFS project ID'),
    INFURA_IPFS_PROJECT_SECRET: z.string().optional().describe('Infura IPFS project secret'),
    IPFS_REPIN_SWEEP_CONCURRENCY: z.coerce.number().int().positive().default(8),
    IPFS_REPIN_INTERVAL_MS: optionalNonnegativeInt(),
    IPFS_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

    // S3-compatible Storage Configuration (avatar uploads)
    S3_BUCKET: z
      .preprocess(blankToUndefined, z.string().optional())
      .describe('S3 bucket name for avatar uploads. Required in production.'),
    S3_REGION: z
      .preprocess(blankToUndefined, z.string().optional())
      .describe('AWS region (or equivalent) for the S3 bucket.'),
    S3_ACCESS_KEY_ID: z
      .preprocess(blankToUndefined, z.string().optional())
      .describe('AWS / S3-compatible access key ID.'),
    S3_SECRET_ACCESS_KEY: z
      .preprocess(blankToUndefined, z.string().optional())
      .describe('AWS / S3-compatible secret access key.'),
    S3_ENDPOINT: z
      .preprocess(blankToUndefined, z.string().url().optional())
      .describe(
        'Custom S3-compatible endpoint URL (e.g. MinIO, Cloudflare R2). ' +
          'Leave unset to use the standard AWS endpoint.',
      ),
    S3_PUBLIC_URL_BASE: z
      .preprocess(blankToUndefined, z.string().url().optional())
      .describe(
        'Base URL for public object access (e.g. CDN prefix). ' +
          'When set, returned avatar URLs use this prefix instead of the signed URL.',
      ),

    // Arweave Configuration
    ARWEAVE_JWT: z.string().optional().describe('Arweave wallet key in JWK format'),
    ARWEAVE_UPLOAD_URL: z.string().url().optional().describe('Arweave upload endpoint URL'),

    // Reputation System Configuration
    REPUTATION_DECAY_HALF_LIFE_MS: z.coerce.number().int().positive().optional(),

    // Inbound Request Timeout Configuration
    REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30000)
      .describe(
        'Global inbound request timeout in milliseconds (408 Request Timeout returned on timeout). Default 30s.',
      ),

    // Graceful Shutdown Configuration
    SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30_000)
      .describe(
        'How long to wait for in-flight requests to complete after SIGTERM before forcing exit',
      ),
    SHUTDOWN_FORCE_EXIT: optionalBool().describe(
      'Set to false to skip the process.exit() after a clean shutdown (e.g. under a test runner that owns the event loop)',
    ),

    // Gig Expiry Worker Configuration
    GIG_EXPIRY_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .optional()
      .describe('Gig expiry sweep interval in milliseconds. 0 or negative disables the sweep.'),
    GIG_EXPIRY_SWEEP_CONCURRENCY: optionalPositiveInt().describe(
      'Max concurrent gig expirations per sweep. Default 8.',
    ),
    GIG_EXPIRY_SWEEP_MAX_GIGS: optionalPositiveInt().describe(
      'Cap on gigs to expire per sweep; continuing on next tick if more remain. Prevents monopolising a tick. Default unlimited.',
    ),
  })
  .superRefine((data, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const isProduction = data.NODE_ENV === 'production';
    const isPublicNetwork = data.STELLAR_NETWORK === 'PUBLIC' || data.STELLAR_NETWORK === 'MAINNET';

    if (Boolean(data.DB_HOST) !== Boolean(data.DB_NAME)) {
      issue('DB_HOST', 'DB_HOST and DB_NAME must be set together');
    }
    if (data.DATABASE_URL && (data.DB_HOST || data.DB_NAME)) {
      issue('DATABASE_URL', 'set either DATABASE_URL or DB_HOST/DB_NAME, not both');
    }
    if (data.DB_SSL_REJECT_UNAUTHORIZED === 'false' && isProduction) {
      issue(
        'DB_SSL_REJECT_UNAUTHORIZED',
        'disabling PostgreSQL certificate verification is not allowed in production',
      );
    }
    if (Boolean(data.SWAGGER_USER) !== Boolean(data.SWAGGER_PASSWORD)) {
      issue('SWAGGER_USER', 'SWAGGER_USER and SWAGGER_PASSWORD must be set together');
    }
    const swaggerEnabled = data.SWAGGER_ENABLED
      ? data.SWAGGER_ENABLED === 'true'
      : data.NODE_ENV !== 'production';
    if (isProduction && swaggerEnabled && !data.SWAGGER_USER) {
      issue('SWAGGER_USER', 'protect production Swagger with SWAGGER_USER and SWAGGER_PASSWORD');
    }

    if (
      isProduction &&
      (!data.REDIS_URL || data.REDIS_URL.trim() === '') &&
      data.ALLOW_NO_REDIS !== 'true'
    ) {
      issue(
        'REDIS_URL',
        'REDIS_URL is required in production unless ALLOW_NO_REDIS=true is set for a deliberate single-node opt-out',
      );
    }

    if (isProduction) {
      const corsOrigins = data.CORS_ORIGIN || [];

      if (corsOrigins.length === 0 || corsOrigins.includes('*')) {
        issue(
          'CORS_ORIGIN',
          'CORS_ORIGIN must be explicitly set to a comma-separated list of allowed origins in production; wildcard is not allowed',
        );
      }
    }

    const secret = data.JWT_SECRET;
    const previousSecret = data.JWT_SECRET_PREVIOUS;

    if (isProduction) {
      if (!secret || secret.trim() === '') {
        issue('JWT_SECRET', 'JWT_SECRET is required in production');
      } else if (PLACEHOLDER_JWT_SECRETS.has(secret.trim().toLowerCase())) {
        issue('JWT_SECRET', 'JWT_SECRET must not be a placeholder value in production');
      } else if (secret.length < 32) {
        issue('JWT_SECRET', 'JWT_SECRET must be at least 32 characters in production');
      }
    } else {
      // Development/test: if a value is explicitly provided it must still meet minimum length
      if (secret !== undefined && secret !== '' && secret.length < 16) {
        issue('JWT_SECRET', 'JWT_SECRET must be at least 16 characters for security');
      }
    }

    if (previousSecret !== undefined && previousSecret !== '' && previousSecret.length < 16) {
      issue(
        'JWT_SECRET_PREVIOUS',
        'JWT_SECRET_PREVIOUS must be at least 16 characters for security',
      );
    }

    if (secret && previousSecret && secret === previousSecret) {
      issue('JWT_SECRET_PREVIOUS', 'JWT_SECRET_PREVIOUS must differ from JWT_SECRET');
    }

    // Apply network-appropriate defaults for Stellar RPC URLs if not explicitly provided
    if (!data.STELLAR_HORIZON_URL) {
      data.STELLAR_HORIZON_URL = isPublicNetwork
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org';
    }
    if (!data.SOROBAN_RPC_URL) {
      data.SOROBAN_RPC_URL = isPublicNetwork
        ? 'https://soroban-mainnet.stellar.org'
        : 'https://soroban-testnet.stellar.org';
    }

    // Validate that URLs match the selected network after defaults are applied
    if (isPublicNetwork) {
      if (/testnet/i.test(data.STELLAR_HORIZON_URL)) {
        issue(
          'STELLAR_HORIZON_URL',
          'STELLAR_HORIZON_URL must point to the PUBLIC network when STELLAR_NETWORK is PUBLIC or MAINNET',
        );
      }
      if (/testnet/i.test(data.SOROBAN_RPC_URL)) {
        issue(
          'SOROBAN_RPC_URL',
          'SOROBAN_RPC_URL must point to the PUBLIC network when STELLAR_NETWORK is PUBLIC or MAINNET',
        );
      }
    } else {
      if (/mainnet|public/i.test(data.STELLAR_HORIZON_URL)) {
        issue(
          'STELLAR_HORIZON_URL',
          'STELLAR_HORIZON_URL must point to the TESTNET when STELLAR_NETWORK is TESTNET',
        );
      }
      if (/mainnet|public/i.test(data.SOROBAN_RPC_URL)) {
        issue(
          'SOROBAN_RPC_URL',
          'SOROBAN_RPC_URL must point to the TESTNET when STELLAR_NETWORK is TESTNET',
        );
      }
    }
  });

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * Fallback used only when NODE_ENV !== 'production' and no JWT_SECRET is provided.
 * Clearly marked as test-only so it cannot be mistaken for a production secret.
 */
export const TEST_ONLY_JWT_SECRET =
  'test-only-jwt-secret-for-development-and-test-do-not-use-in-production';
export const JWT_ALGORITHM = 'HS256' as const;

let validatedConfig: EnvConfig | null = null;

/**
 * Validate environment variables against the schema and cache the result.
 *
 * This function is called once at startup (in main.ts). If validation fails,
 * it throws a ZodError with a readable message listing all invalid/missing
 * variables. The error includes paths and reasons for each failed field.
 *
 * @throws {z.ZodError} when required variables are missing or malformed
 */
export function validateEnv(): EnvConfig {
  if (validatedConfig) {
    return validatedConfig;
  }

  try {
    const parsed = EnvSchema.parse(process.env);
    // Inject clearly-marked test-only fallback for non-production when no secret is provided
    if (!parsed.JWT_SECRET || parsed.JWT_SECRET.trim() === '') {
      if (parsed.NODE_ENV !== 'production') {
        (parsed as Record<string, unknown>).JWT_SECRET = TEST_ONLY_JWT_SECRET;
      }
    }
    validatedConfig = parsed;
    return validatedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessage = error.errors
        .map(err => `  - ${err.path.join('.')}: ${err.message}`)
        .join('\n');

      throw new Error(
        `Environment variable validation failed:\n${errorMessage}\n\n` +
          `Fix the above issues in your .env file or environment configuration.`,
      );
    }
    throw error;
  }
}

/**
 * Get the validated config object. Must call validateEnv() first (typically in main.ts).
 *
 * Deliberately throws instead of lazily calling validateEnv() on first access (#428). The
 * alternative — having `getConfig()` self-initialize — would make every module-level
 * `config.*` read "work by accident" regardless of import order, which is exactly the kind
 * of ordering bug this project keeps hitting: it would silently mask a *new* module-level
 * read added later (no test would ever exercise the "config not initialized yet" path,
 * since it could no longer occur). Keeping the throw means that dependency is explicit and
 * testable: every read of `config`/`getConfig()` must happen inside a factory, constructor,
 * or method body — something Nest (or a test) controls the timing of — never at module
 * evaluation time. `main.ts` still validates first via the top-level `validateEnv()` call;
 * tests validate first via an explicit `validateEnv()` call before importing the module
 * under test (see e.g. `rate-limit.guard.spec.ts`, `stellar.service.spec.ts`). See
 * `env-config-import-order.spec.ts` for a regression test asserting that importing a module
 * which reads `config` does NOT throw, because it no longer reads `config` at import time.
 *
 * @throws {Error} if validateEnv() hasn't been called yet
 */
export function getConfig(): EnvConfig {
  if (!validatedConfig) {
    throw new Error('Config not initialized. Call validateEnv() first.');
  }
  return validatedConfig;
}

export function getJwtVerificationSecrets(): string[] {
  const secrets = [config.JWT_SECRET, config.JWT_SECRET_PREVIOUS].filter(
    (secret): secret is string => Boolean(secret && secret.trim()),
  );

  return [...new Set(secrets)];
}

/**
 * Exported config object for convenient access throughout the application.
 * Replaces scattered `process.env.X || fallback` reads with typed, validated values.
 *
 * Usage:
 *   import { config } from './config/env.config';
 *   const port = config.PORT;  // typed as number, guaranteed to be valid
 */
export const config = new Proxy({} as EnvConfig, {
  get(_target, prop: string) {
    return getConfig()[prop as keyof EnvConfig];
  },
});

/**
 * Test-only helper: clears the cached config so it can be re-initialized.
 * Used in Jest tests to reset state between test cases.
 *
 * @example
 *   afterEach(() => {
 *     resetEnvConfig();
 *   });
 */
export function resetEnvConfig(): void {
  validatedConfig = null;
}

/**
 * Test-only helper: merges overrides into process.env, resets the config cache,
 * and re-runs validation. Use in tests to set specific config values per test case.
 *
 * @param overrides - Environment variable overrides (e.g., { ADMIN_ADDRESSES: 'G...' })
 * @throws {Error} if validation fails after merging overrides
 *
 * @example
 *   beforeEach(() => {
 *     setTestEnv({ ADMIN_ADDRESSES: 'GXXXXX' });
 *   });
 *   afterEach(() => {
 *     resetEnvConfig();
 *   });
 */
export function setTestEnv(overrides: Record<string, string>): void {
  resetEnvConfig();
  Object.assign(process.env, overrides);
  validateEnv();
}
