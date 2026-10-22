import './config/load-dotenv.bootstrap';
import { initTracing } from './monitoring/tracing';
import { NestFactory } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { validateEnv, config } from './config/env.config';
import { ShutdownService } from './common/shutdown/shutdown.service';
import { SanitizedLogger } from './common/logging/sanitized-logger';
import { SentryService } from './sentry/sentry.service';
import { SentryExceptionFilter } from './common/filters/sentry-exception.filter';
import {
  enableRequestContextLogging,
  requestIdMiddleware,
} from './common/logging/request-context';
import { SorobanEventIndexerService } from './soroban-event-indexer/soroban-event-indexer.service';
import { MetricsHttpInterceptor } from './monitoring/metrics-http.interceptor';

const logger = new SanitizedLogger('Bootstrap');

// Validate environment variables at startup before anything else runs.
// This fails fast with a clear error if required variables are missing or malformed,
// rather than allowing the app to start with invalid config that only surfaces as
// runtime errors later.
try {
  validateEnv();
  logger.log('✓ Environment variables validated successfully');
} catch (error) {
  logger.error('Environment variable validation failed:');
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Initialize OpenTelemetry tracing early so all subsequent operations are traced
initTracing();

// Capture unhandled promise rejections before the app is ready
process.on('unhandledRejection', (reason: unknown) => {
  Sentry.captureException(reason);
  logger.error(
    'Unhandled Promise Rejection',
    reason instanceof Error ? reason.stack : String(reason),
  );
  process.exit(1);
});

// Capture uncaught synchronous exceptions and exit
process.on('uncaughtException', (error: Error) => {
  Sentry.captureException(error);
  logger.error('Uncaught Exception — shutting down', error.stack);
  process.exit(1);
});

async function bootstrap() {
  enableRequestContextLogging();

  const app = await NestFactory.create(AppModule);
  app.use(requestIdMiddleware);

  // Enable shutdown hooks so lifecycle hooks (beforeApplicationShutdown, onApplicationShutdown)
  // are triggered when the app receives SIGTERM/SIGINT. This ensures BullMQ workers, Redis
  // subscribers, and the Soroban indexer can complete in-flight operations cleanly during
  // rolling deployments or pod terminations.
  app.enableShutdownHooks();

  // The whole HTTP-level stack — security headers, body limits, Sentry, the exception
  // filter, request timeouts, metrics, CORS, validation, API versioning, Swagger, and the
  // Soroban indexer — is applied by `configureApp`. This used to be duplicated inline here
  // and the copy had drifted badly: it referenced eight identifiers it never imported
  // (including `express`, so the server died with `ReferenceError: express is not defined`
  // on startup) and had silently dropped API versioning and the global request timeout.
  // Sharing one implementation is what keeps production and the test suites in agreement.
  const docsAuth = createDocsBasicAuth(config.SWAGGER_USER, config.SWAGGER_PASSWORD);
  configureApp(app, {
    skipSwagger: !isSwaggerEnabled(config),
    ...(docsAuth ? { docsAuth } : {}),
  });

  const swaggerEnabled = isSwaggerEnabled(config);
  const port = config.PORT;
  await app.listen(port);

  // Hand the app to the shutdown coordinator *after* it is listening, so a SIGTERM arriving
  // during boot cannot race a half-initialised server. ShutdownService owns the SIGTERM and
  // SIGINT handlers: it flips readiness to failing, drains in-flight requests within
  // SHUTDOWN_TIMEOUT_MS, runs Nest's lifecycle hooks (ending the PostgreSQL pool), then exits.
  app.get(ShutdownService).registerApp(app);

  // Shut down the OTel SDK after the HTTP server has drained so all in-flight
  // spans are flushed before the process exits.
  if (otelSdk) {
    process.once('beforeExit', () => otelSdk.shutdown());
  }

  logger.log(`🚀 TrustFlow API running on: http://localhost:${port}`);
  if (swaggerEnabled) {
    logger.log(`📚 API Documentation: http://localhost:${port}/api/docs`);
    logger.log(`📄 OpenAPI JSON: http://localhost:${port}/api/docs-json`);
  }
  if (app.get(SentryService).isInitialized()) {
    logger.log('🔍 Sentry error monitoring active');
  }
}

bootstrap().catch(error => {
  Sentry.captureException(error);
  logger.error(
    'Bootstrap failed — shutting down',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
