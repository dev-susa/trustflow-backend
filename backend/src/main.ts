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
import { getCorsOrigin } from './cors.util';

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

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'https:'],
        },
      },
    }),
  );

  // Initialize Sentry via the injectable service so it shares the same instance
  const sentryService = app.get(SentryService);
  sentryService.init();

  // Register global exception filter — captures 5xx errors to Sentry
  app.useGlobalFilters(new SentryExceptionFilter(sentryService));

  // Enable CORS
  app.enableCors({
    origin: getCorsOrigin(),
    credentials: true,
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
