import pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value, label = 'project_id') {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return value;
}

export function createPool({
  connectionString,
  max = 10,
  statementTimeoutMs = 30_000,
  applicationName = 'ai-infra',
} = {}) {
  if (!connectionString) throw new Error('createPool requires a connection string.');
  return new pg.Pool({
    connectionString,
    max,
    application_name: applicationName,
    statement_timeout: statementTimeoutMs,
  });
}

/**
 * Runs `fn` inside a transaction with the **organisation** GUC set.
 *
 * Workspace-level reads that span projects — listing an organisation's projects,
 * for example — cannot be scoped to a single project. Migration 002 adds an
 * additive organisation policy on `projects` for exactly this case, so the read
 * sees one organisation's rows and nothing else. Transaction-local, so the
 * setting cannot leak to the next borrower of the connection.
 */
export async function withOrganisation(pool, organisationId, fn, { readOnly = false } = {}) {
  assertUuid(organisationId, 'organisation_id');
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', organisationId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already unusable; releasing it returns it to the pool.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a transaction with the tenant GUC set, so row-level security
 * resolves against exactly one project.
 *
 * `set_config(..., true)` is transaction-local, which is what makes this safe on
 * a pooled connection: the setting cannot leak to the next borrower. A missing or
 * empty setting fails closed (see the RLS policy in the initial migration), so a
 * caller that forgets to scope sees no rows rather than every row.
 */
export async function withTenant(pool, projectId, fn, { readOnly = false } = {}) {
  assertUuid(projectId);
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.project_id', projectId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already unusable; releasing it returns it to the pool
      // for pg to discard.
    }
    throw error;
  } finally {
    client.release();
  }
}
