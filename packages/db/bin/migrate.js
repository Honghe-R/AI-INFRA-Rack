#!/usr/bin/env node
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, createLogger } from '@ai-infra/core';
import { createPool, migrate } from '../src/index.js';

// The CLI runs from wherever npm invokes it (a workspace directory in this
// monorepo), so a relative migration directory is resolved against the
// repository root rather than the current working directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVICE = process.env.SERVICE_NAME ?? 'ai-infra-migrate';

const config = loadConfig();
const logger = createLogger({
  service: SERVICE,
  version: config.serviceVersion,
  level: config.logLevel,
});

const migrationDir = isAbsolute(config.migrationDir)
  ? config.migrationDir
  : resolve(REPO_ROOT, config.migrationDir);

if (!config.databaseUrl) {
  logger.error('migration.configuration_error', { reason: 'DATABASE_URL is not set.' });
  process.exit(2);
}

// Migrations are DDL and may legitimately run long, so the statement timeout is
// disabled for this process only.
const pool = createPool({
  connectionString: config.databaseUrl,
  max: 2,
  statementTimeoutMs: 0,
  applicationName: SERVICE,
});

try {
  const outcome = await migrate({
    pool,
    dir: migrationDir,
    logger,
    appliedBy: process.env.APPLIED_BY ?? process.env.USER ?? 'unknown',
  });

  if (outcome.applied.length === 0) {
    logger.info('migration.up_to_date', { skipped: outcome.skipped.length });
  } else {
    logger.info('migration.complete', {
      applied: outcome.applied,
      skipped: outcome.skipped.length,
    });
  }
} catch (error) {
  logger.error('migration.failed', { error: error.message });
  process.exitCode = 1;
} finally {
  await pool.end();
}
