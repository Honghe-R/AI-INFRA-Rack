import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@ai-infra/db';

const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.pathname, '/rack_facility');
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
const admin = createPool({ connectionString: url.toString() });
const name = `rack_migration_probe_${randomUUID().replaceAll('-', '')}`;
let isolated;
let created = false;
try {
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  url.pathname = `/${name}`;
  isolated = createPool({ connectionString: url.toString(), statementTimeoutMs: 0 });
  const dir = fileURLToPath(new URL('../../data-scripts/', import.meta.url));
  const first = await migrate({ pool: isolated, dir });
  assert.equal(first.applied.length, 9);
  assert.equal(first.applied.at(-1), '009_rack_spatial_constraints.sql');
  const second = await migrate({ pool: isolated, dir });
  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, 9);
  const flags = (await isolated.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='rack_plans'")).rows[0];
  assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
  console.log('Fresh isolated database: all 9 migrations applied; repeated run skips all 9 with no drift.');
  console.log('rack_plans: RLS enabled and forced. No changes to seeded development project data.');
} finally {
  await isolated?.end();
  if (created) {
    await admin.query(`DROP DATABASE ${name}`);
    console.log('Dropped only the uniquely named migration probe database created by this check.');
  }
  await admin.end();
}


