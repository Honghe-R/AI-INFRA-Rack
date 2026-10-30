import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '@ai-infra/db';
import { fileURLToPath } from 'node:url';

const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55532'); assert.equal(url.pathname, '/rack_facility');
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
assert.equal(process.env.AI_INFRA_COMPOSE_FILE, 'compose.rack.yaml');
const pool = createPool({ connectionString: url.toString(), statementTimeoutMs: 0 });
const dir = fileURLToPath(new URL('../../data-scripts/', import.meta.url));
const probeName = `rack_access_probe_${randomUUID().replaceAll('-', '')}`;
let probe, created = false;
try {
  await pool.query(`CREATE DATABASE ${probeName}`); created = true;
  const probeUrl = new URL(url); probeUrl.pathname = `/${probeName}`;
  probe = createPool({ connectionString: probeUrl.toString(), statementTimeoutMs: 0 });
  const fresh = await migrate({ pool: probe, dir }); assert.equal(fresh.applied.length, 12);
  const repeated = await migrate({ pool: probe, dir }); assert.equal(repeated.applied.length, 0); assert.equal(repeated.skipped.length, 12);
  console.log('PASS: fresh isolated database applies all 12 migrations; repeat has no changes/drift.');
  const pending = await migrate({ pool, dir, dryRun: true });
  assert.deepEqual(pending.pending, ['012_rack_project_access.sql']);
  const applied = await migrate({ pool, dir }); assert.deepEqual(applied.applied, pending.pending);
  const flags = (await pool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='project_access_events'")).rows[0];
  assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
  console.log('PASS: applied only migration 012 to isolated Rack development DB; access events have forced project RLS. No plan data changed.');
} finally {
  await probe?.end();
  if (created) { await pool.query(`DROP DATABASE ${probeName}`); console.log('Dropped only the uniquely named probe database created by this check.'); }
  await pool.end();
}
