import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, migrate, withOrganisation, withTenant } from '../index.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;
before(() => {
  if (databaseUrl) pool = createPool({ connectionString: databaseUrl, max: 4 });
});
after(async () => {
  if (pool) await pool.end();
});

const PROJECT_A = '11111111-1111-1111-1111-111111111111';
const PROJECT_B = '22222222-2222-2222-2222-222222222222';

test('withTenant sets the tenant GUC inside the transaction only', { skip }, async () => {
  const inside = await withTenant(pool, PROJECT_A, (client) =>
    client.query("SELECT current_setting('app.project_id', true) AS value"),
  );
  assert.equal(inside.rows[0].value, PROJECT_A);

  const outside = await pool.query("SELECT current_setting('app.project_id', true) AS value");
  assert.notEqual(outside.rows[0].value, PROJECT_A, 'the tenant setting must not leak past the transaction');
});

test('withOrganisation sets the organisation GUC inside the transaction only', { skip }, async () => {
  const inside = await withOrganisation(pool, PROJECT_A, (client) =>
    client.query("SELECT current_setting('app.organization_id', true) AS value"),
  );
  assert.equal(inside.rows[0].value, PROJECT_A);

  const outside = await pool.query("SELECT current_setting('app.organization_id', true) AS value");
  assert.notEqual(outside.rows[0].value, PROJECT_A, 'the organisation setting must not leak');

  await assert.rejects(() => withOrganisation(pool, 'not-a-uuid', async () => {}), /must be a UUID/);
});

test('withTenant rejects a non-UUID tenant', { skip }, async () => {
  await assert.rejects(() => withTenant(pool, 'not-a-uuid', async () => {}), /must be a UUID/);
});

/**
 * Removes the probe table, the schema privileges, and the role.
 *
 * `DROP ROLE` fails while the role still holds a privilege on any object, and a
 * `USAGE ON SCHEMA` grant outlives the table it was paired with — so a cleanup
 * that only dropped the table left the role behind and broke the next run.
 */
async function dropProbeRole(client) {
  await client.query('DROP TABLE IF EXISTS rls_probe').catch(() => {});
  await client.query('REVOKE ALL ON SCHEMA public FROM rls_probe_role').catch(() => {});
  await client.query('DROP ROLE IF EXISTS rls_probe_role').catch(() => {});
}

test('row-level security filters rows by tenant and fails closed when unset', { skip }, async () => {
  const client = await pool.connect();
  try {
    await dropProbeRole(client);
    await client.query('CREATE TABLE rls_probe (project_id uuid NOT NULL, id integer PRIMARY KEY)');
    await client.query('ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY');
    await client.query(
      `CREATE POLICY probe_isolation ON rls_probe
         USING (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
         WITH CHECK (project_id = nullif(current_setting('app.project_id', true), '')::uuid)`,
    );
    await client.query('CREATE ROLE rls_probe_role NOSUPERUSER NOLOGIN');
    await client.query('GRANT USAGE ON SCHEMA public TO rls_probe_role');
    await client.query('GRANT SELECT, INSERT ON rls_probe TO rls_probe_role');
    await client.query('INSERT INTO rls_probe (project_id, id) VALUES ($1, 1), ($2, 2)', [PROJECT_A, PROJECT_B]);

    await client.query('SET ROLE rls_probe_role');
    await client.query("SELECT set_config('app.project_id', $1, false)", [PROJECT_A]);
    const scoped = await client.query('SELECT count(*)::int AS count FROM rls_probe');
    assert.equal(scoped.rows[0].count, 1);

    await assert.rejects(
      () => client.query('INSERT INTO rls_probe (project_id, id) VALUES ($1, 3)', [PROJECT_B]),
      /row-level security/,
      'a write for another tenant must be rejected',
    );

    await client.query("SELECT set_config('app.project_id', '', false)");
    const unset = await client.query('SELECT count(*)::int AS count FROM rls_probe');
    assert.equal(unset.rows[0].count, 0, 'an unset tenant must see nothing');
    await client.query('RESET ROLE');
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    await dropProbeRole(client);
    client.release();
  }
});

test('migrate applies pending files once, is idempotent, and detects drift', { skip }, async () => {
  const ledger = 'schema_migrations_probe';
  const dir = await mkdtemp(join(tmpdir(), 'ai-infra-migrate-'));
  try {
    await writeFile(join(dir, '001_probe.sql'), 'CREATE TABLE IF NOT EXISTS migrate_probe (id integer PRIMARY KEY)');

    const first = await migrate({ pool, dir, table: ledger, appliedBy: 'test' });
    assert.deepEqual(first.applied, ['001_probe.sql']);

    const second = await migrate({ pool, dir, table: ledger, appliedBy: 'test' });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ['001_probe.sql']);

    await writeFile(
      join(dir, '001_probe.sql'),
      'CREATE TABLE IF NOT EXISTS migrate_probe (id integer PRIMARY KEY, extra text)',
    );
    await assert.rejects(() => migrate({ pool, dir, table: ledger, appliedBy: 'test' }), /changed on disk/);
  } finally {
    const client = await pool.connect();
    await client.query(`DROP TABLE IF EXISTS ${ledger}`).catch(() => {});
    await client.query('DROP TABLE IF EXISTS migrate_probe').catch(() => {});
    client.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrate dryRun reports pending work without applying it', { skip }, async () => {
  const ledger = 'schema_migrations_probe_dry';
  const dir = await mkdtemp(join(tmpdir(), 'ai-infra-migrate-dry-'));
  try {
    await writeFile(join(dir, '001_dry.sql'), 'CREATE TABLE IF NOT EXISTS dry_probe (id integer)');
    const outcome = await migrate({ pool, dir, table: ledger, appliedBy: 'test', dryRun: true });
    assert.deepEqual(outcome.pending, ['001_dry.sql']);
    assert.deepEqual(outcome.applied, []);

    const exists = await pool.query("SELECT to_regclass('public.dry_probe') AS relation");
    assert.equal(exists.rows[0].relation, null, 'dryRun must not create objects');
  } finally {
    const client = await pool.connect();
    await client.query(`DROP TABLE IF EXISTS ${ledger}`).catch(() => {});
    await client.query('DROP TABLE IF EXISTS dry_probe').catch(() => {});
    client.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrate rejects an unsafe ledger name', { skip }, async () => {
  await assert.rejects(
    () => migrate({ pool, dir: tmpdir(), table: 'schema_migrations; DROP TABLE x' }),
    /Invalid migration ledger name/,
  );
});
