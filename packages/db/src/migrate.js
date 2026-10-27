import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Stable advisory-lock key so two runners cannot apply migrations concurrently. */
export const MIGRATION_LOCK_KEY = 771_027_001;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function migrationTableSql(table = 'schema_migrations') {
  assertIdentifier(table);
  return `CREATE TABLE IF NOT EXISTS ${table} (
    filename   text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text
  )`;
}

/**
 * Applies every `*.sql` file in `dir` in lexical order, once each.
 *
 * Rules:
 *  * Applied migrations are immutable. The runner stores a SHA-256 of each file
 *    and fails if a file that is already recorded changes on disk. A correction
 *    is a new file, never an edit to an applied one.
 *  * Each migration runs in its own transaction, so a failure leaves no partial
 *    migration behind.
 *  * A session advisory lock serializes concurrent runners (a deploy racing a
 *    migration job).
 *
 * Pass `dryRun` to report what would be applied without applying it, and `table`
 * to relocate the ledger (tests use a private ledger).
 */
export async function migrate({
  pool,
  dir = 'data-scripts',
  logger = null,
  appliedBy = 'unknown',
  dryRun = false,
  table = 'schema_migrations',
} = {}) {
  assertIdentifier(table);
  let filenames;
  try {
    filenames = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  } catch (cause) {
    if (cause?.code === 'ENOENT') throw new Error(`Migration directory "${dir}" was not found.`);
    throw cause;
  }
  const client = await pool.connect();
  const outcome = { applied: [], skipped: [], drifted: [], pending: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(migrationTableSql(table));
    const { rows } = await client.query(`SELECT filename, checksum FROM ${table}`);
    const recorded = new Map(rows.map((row) => [row.filename, row.checksum]));

    for (const filename of filenames) {
      const sql = await readFile(join(dir, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const known = recorded.get(filename);

      if (known !== undefined) {
        if (known !== checksum) outcome.drifted.push(filename);
        else outcome.skipped.push(filename);
        continue;
      }

      outcome.pending.push(filename);
      if (dryRun) continue;

      await applyOne({ client, filename, sql, checksum, appliedBy, logger, table });
      outcome.applied.push(filename);
    }

    if (outcome.drifted.length > 0) {
      throw new Error(
        `Applied migration files changed on disk: ${outcome.drifted.join(', ')}. ` +
          'Migrations are immutable once applied; add a new file instead.',
      );
    }

    return outcome;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function applyOne({ client, filename, sql, checksum, appliedBy, logger, table }) {
  logger?.info('migration.applying', { filename });
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO ${table} (filename, checksum, applied_by) VALUES ($1, $2, $3)`,
      [filename, checksum, appliedBy],
    );
    await client.query('COMMIT');
    logger?.info('migration.applied', { filename, checksum });
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`Migration ${filename} failed: ${cause.message}`, { cause });
  }
}

function assertIdentifier(value) {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid migration ledger name "${value}".`);
}
