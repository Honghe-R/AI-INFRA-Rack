#!/usr/bin/env node
/**
 * Standalone validation worker.
 *
 * The API starts the same loop inside its own process by default, because a
 * development stack should not need a third terminal. This entry exists for a
 * deployment that runs job execution separately from request serving — one
 * process per queue consumer, scaled on its own — and it is the same code path
 * either way, because the queue is the `jobs` table and not an in-process
 * channel.
 *
 * It claims jobs across every project, so it must connect as a role that owns the
 * tables or holds `BYPASSRLS`; the execution itself still runs under the tenant
 * GUC.
 */
import { createLogger, loadConfig } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createValidationWorker } from '@ai-infra/facility';

const config = loadConfig();
const logger = createLogger({ service: 'ai-infra-worker', version: config.serviceVersion, level: config.logLevel });

if (!config.databaseUrl) {
  logger.error('startup.no_database', { reason: 'DATABASE_URL is not set.' });
  process.exit(2);
}

const pool = createPool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  statementTimeoutMs: config.databaseStatementTimeoutMs,
  applicationName: 'ai-infra-worker',
});

const worker = createValidationWorker({
  pool,
  logger,
  pollIntervalMs: config.validationWorkerIntervalMs,
  maxDiagnostics: config.validationMaxDiagnostics,
});

worker.start();
logger.info('worker.listening', { intervalMs: config.validationWorkerIntervalMs });

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('worker.shutdown', { signal });
  worker.stop();
  pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
