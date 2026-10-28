import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createLogger, errors } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerRackRoutes } from '../routes/rack.js';
import { createRackPlanService } from '../services/rack-plans.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
let pool, repository;
before(() => {
  if (skip) return;
  pool = createPool({ connectionString: process.env.DATABASE_URL, max: 6 });
  repository = createRbacRepository({ pool });
});
after(async () => { await pool?.end(); });

async function fixture(fn, { state = 'DRAFT' } = {}) {
  const suffix = randomUUID();
  const people = {};
  const projects = [];
  let organization;
  try {
    for (const name of ['admin', 'editor', 'viewer', 'outsider']) {
      people[name] = await repository.createUser({ subject: `rack-test-${name}-${suffix}` });
    }
    organization = await repository.createOrganization({ name: `Rack test ${suffix}`, ownerUserId: people.admin.userId });
    for (let index = 0; index < 2; index++) {
      const p = Object.fromEntries(['projectId', 'scenarioId', 'revisionId', 'envelopeId', 'scopeId', 'hallId', 'buildingId', 'etag'].map(key => [key, randomUUID()]));
      projects.push(p);
      await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1,$2,$3)', [p.projectId, organization.organizationId, `Rack test project ${index}`]);
      await pool.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1,$2,$3)', [p.scenarioId, p.projectId, 'Test scenario']);
      await pool.query(`INSERT INTO revisions (revision_id,project_id,scenario_id,lifecycle_state,content_checksum)
        VALUES ($1,$2,$3,$4,$5)`, [p.revisionId, p.projectId, p.scenarioId, state, state === 'DRAFT' ? null : 'test-frozen-checksum']);
      await pool.query(`INSERT INTO revision_etags (revision_id, project_id, scenario_id, etag) VALUES ($1,$2,$3,$4)`, [p.revisionId, p.projectId, p.scenarioId, p.etag]);
      await pool.query(`INSERT INTO entity_registry (entity_id,revision_id,project_id,scenario_id,entity_type,display_name)
        VALUES ($1,$2,$3,$4,'SITE','Test site'),($5,$2,$3,$4,'HALL','Test hall'),($6,$2,$3,$4,'BUILDING','Test building')`,
      [p.scopeId, p.revisionId, p.projectId, p.scenarioId, p.hallId, p.buildingId]);
      await pool.query(`INSERT INTO facility_envelopes (envelope_id,project_id,scenario_id,revision_id)
        VALUES ($1,$2,$3,$4)`, [p.envelopeId, p.projectId, p.scenarioId, p.revisionId]);
      await pool.query(`INSERT INTO design_scopes (scope_id,project_id,scenario_id,revision_id,envelope_id,scope_kind,name)
        VALUES ($1,$2,$3,$4,$5,'CAMPUS','Test site')`, [p.scopeId, p.projectId, p.scenarioId, p.revisionId, p.envelopeId]);
      await pool.query(`INSERT INTO facility_containers
        (container_id,project_id,scenario_id,revision_id,envelope_id,scope_id,kind,entity_type,name,level_number)
        VALUES ($1,$2,$3,$4,$5,$6,'HALL','HALL','Test hall',1),
               ($7,$2,$3,$4,$5,$6,'BUILDING','BUILDING','Test building',NULL)`,
      [p.hallId, p.projectId, p.scenarioId, p.revisionId, p.envelopeId, p.scopeId, p.buildingId]);
      await repository.assignRole({ userId: people.admin.userId, roleKey: 'project-admin', scopeKind: 'project', scopeId: p.projectId });
    }
    for (const [person, role] of [['editor', 'project-editor'], ['viewer', 'project-viewer']]) {
      await repository.assignRole({ userId: people[person].userId, roleKey: role, scopeKind: 'project', scopeId: projects[0].projectId });
    }
    await repository.assignRole({ userId: people.outsider.userId, roleKey: 'project-admin', scopeKind: 'project', scopeId: projects[1].projectId });
    const a = projects[0], b = projects[1];
    const input = (p = a) => ({ contract_version: 1, name: '  Rack draft  ', scenario_id: p.scenarioId,
      facility_input: { revision_id: p.revisionId, container_id: p.hallId, revision_etag: p.etag } });
    await fn({ a, b, people, input });
  } finally {
    const userIds = Object.values(people).map(person => person.userId);
    for (const p of projects) {
      for (const table of ['rack_plans', 'facility_containers', 'design_scopes', 'facility_envelopes', 'entity_registry']) {
        await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [p.projectId]);
      }
      await pool.query("DELETE FROM role_assignments WHERE scope_kind = 'project' AND scope_id = $1", [p.projectId]);
      await pool.query('DELETE FROM projects WHERE project_id = $1', [p.projectId]);
    }
    if (organization) {
      await pool.query("DELETE FROM role_assignments WHERE scope_kind = 'organisation' AND scope_id = $1", [organization.organizationId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
    }
    if (userIds.length) {
      await pool.query('DELETE FROM role_assignments WHERE user_id = ANY($1::uuid[]) OR created_by = ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM users WHERE user_id = ANY($1::uuid[])', [userIds]);
    }
  }
}

async function server(people, fn) {
  const router = createRouter();
  registerRackRoutes(router, { pool });
  const evaluator = createEvaluator({ repository });
  const guard = createPermissionGuard({ evaluator, repository });
  const authenticator = { async authenticate(ctx) {
    const person = people[ctx.headers['x-test-user']];
    if (!person) throw errors.unauthorized();
    ctx.user = { userId: person.userId, status: 'ACTIVE' };
  } };
  const logger = createLogger({ sink: { log() {}, warn() {}, error() {} }, level: 'error' });
  const app = createServer(createApp({ router, pool, guard, authenticator, logger }));
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = async (path, { user = 'admin', body, key = randomUUID() } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-test-user': user, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === null ? {} : { 'idempotency-key': key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), location: response.headers.get('location') };
  };
  try { await fn(request); } finally { await new Promise(resolve => app.close(resolve)); }
}

const path = p => `/api/v1/projects/${p.projectId}/rack/plans`;

test('Rack list paginates tied timestamps, filters scope and reports current source status', { skip }, async () => fixture(async f => server(f.people, async request => {
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const result = await request(path(f.a), { body: { ...f.input(), name: `Plan ${i}` } });
    assert.equal(result.status, 201);
    ids.push(result.body.data.planId);
  }
  await request(path(f.b), { body: f.input(f.b) });
  await pool.query("UPDATE rack_plans SET created_at='2026-10-28T00:00:00.123456Z' WHERE project_id=$1", [f.a.projectId]);
  const query = `?scenario_id=${f.a.scenarioId}&revision_id=${f.a.revisionId}&limit=2`;
  const first = await request(`${path(f.a)}${query}`, { user: 'viewer' });
  assert.equal(first.status, 200);
  assert.ok(first.body.meta.correlation_id);
  assert.equal(first.body.data.items.length, 2);
  const second = await request(`${path(f.a)}${query}&cursor=${first.body.data.nextCursor}`);
  assert.equal(second.body.data.items.length, 2);
  const third = await request(`${path(f.a)}${query}&cursor=${second.body.data.nextCursor}`);
  assert.equal(third.body.data.items.length, 1);
  assert.equal(third.body.data.nextCursor, null);
  const actual = [first, second, third].flatMap(result => result.body.data.items.map(plan => plan.planId));
  assert.deepEqual(actual, ids.sort().reverse(), 'keyset pagination retains SQL microsecond precision and a deterministic tie break');
  const foreign = await request(path(f.b));
  assert.equal(foreign.body.data.items.length, 1);
  assert.equal((await request(`${path(f.a)}?cursor=${foreign.body.data.items[0].planId}`)).body.data.items.length, 0);
  assert.equal((await request(`${path(f.a)}?scenario_id=${f.b.scenarioId}`)).body.data.items.length, 0);
  assert.equal((await request(`${path(f.a)}?revision_id=${f.b.revisionId}`)).body.data.items.length, 0);
  assert.equal((await request(`${path(f.a)}?scenario_id=${randomUUID()}`)).body.data.items.length, 0);
  const newer = await request(path(f.a), { body: { ...f.input(), name: 'Newer plan' } });
  const continuation = await request(`${path(f.a)}${query}&cursor=${first.body.data.nextCursor}`);
  assert.deepEqual(continuation.body.data.items.map(plan => plan.planId), second.body.data.items.map(plan => plan.planId));
  assert.ok(!continuation.body.data.items.some(plan => plan.planId === newer.body.data.planId));
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2', [randomUUID(), f.a.projectId]);
  const stale = await request(path(f.a));
  assert.ok(stale.body.data.items.every(plan => plan.facilityInputStatus.status === 'STALE'));
  assert.equal(stale.body.data.items[0].validationState, 'NOT_RUN');
})));

test('Rack list authorizes reads and rejects malformed or unbounded queries', { skip }, async () => fixture(async f => server(f.people, async request => {
  assert.equal((await request(path(f.a), { user: 'unknown' })).status, 401);
  assert.equal((await request(path(f.a), { user: 'outsider' })).status, 403);
  assert.deepEqual((await request(path(f.a), { user: 'viewer' })).body.data, { items: [], nextCursor: null });
  for (const query of ['limit=0', 'limit=51', 'limit=-1', 'limit=1.5', 'limit=02', 'limit=abc', 'scenario_id=bad', 'revision_id=bad', 'cursor=bad', 'unknown=x']) {
    const result = await request(`${path(f.a)}?${query}`);
    assert.equal(result.status, 400, query);
    assert.equal(result.body.error.code, 'RACK_INPUT_INVALID');
  }
  assert.equal((await request(`${path(f.a)}?limit=50`)).status, 200);
})));

test('Rack create/read persists a server-owned empty draft without changing Facility', { skip }, async () => fixture(async f => server(f.people, async request => {
  const created = await request(path(f.a), { user: 'editor', body: f.input() });
  assert.equal(created.status, 201);
  assert.equal(created.body.meta.replayed, false);
  const plan = created.body.data;
  assert.equal(plan.name, 'Rack draft');
  assert.equal(plan.version, 1);
  assert.equal(plan.state, 'DRAFT');
  assert.equal(plan.validationState, 'NOT_RUN');
  assert.deepEqual(plan.placements, []);
  assert.equal(plan.facilityInputStatus.status, 'UNCHANGED');
  assert.equal(plan.createdBy, f.people.editor.userId);
  assert.ok(plan.createdAt && plan.planId && created.body.meta.correlation_id);
  assert.equal(created.location, `${path(f.a)}/${plan.planId}`);
  const read = await request(created.location, { user: 'viewer' });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, plan);
  assert.equal((await pool.query('SELECT etag FROM revision_etags WHERE project_id = $1', [f.a.projectId])).rows[0].etag, f.a.etag);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM rack_plans WHERE project_id=$1', [f.a.projectId])).rows[0].n, 1);
})));

test('Rack simultaneous creation retries converge; key reuse with different input conflicts', { skip }, async () => fixture(async f => server(f.people, async request => {
  const key = randomUUID();
  const results = await Promise.all([request(path(f.a), { body: f.input(), key }), request(path(f.a), { body: f.input(), key: key.toUpperCase() })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal(results[0].body.data.planId, results[1].body.data.planId);
  const conflict = await request(path(f.a), { body: { ...f.input(), name: 'Another draft' }, key });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  const canonical = await request(path(f.a), { body: { ...f.input(), name: 'Rack draft' }, key });
  assert.equal(canonical.status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM rack_plans WHERE project_id=$1', [f.a.projectId])).rows[0].n, 1);
  const otherProject = await request(path(f.b), { body: f.input(f.b), key });
  assert.equal(otherProject.status, 201, 'idempotency keys are project-scoped');
})));

test('Rack enforces authentication, role permissions and plan project scope', { skip }, async () => fixture(async f => server(f.people, async request => {
  assert.equal((await request(path(f.a), { user: 'unknown', body: f.input() })).status, 401);
  assert.equal((await request(path(f.a), { user: 'viewer', body: f.input() })).status, 403);
  assert.equal((await request(path(f.a), { user: 'outsider', body: f.input() })).status, 403);
  const created = await request(path(f.a), { body: f.input() });
  assert.equal(created.status, 201);
  const id = created.body.data.planId;
  assert.equal((await request(`${path(f.b)}/${id}`)).status, 404, 'admin of both projects cannot change a plan tenant via URL');
  assert.equal((await request(`${path(f.a)}/${id}`, { user: 'outsider' })).status, 403);
  assert.equal((await request(`${path(f.a)}/not-a-uuid`)).status, 404);
  assert.equal((await request(`${path(f.a)}/${randomUUID()}`)).status, 404);
})));

test('Rack rejects invalid input, forged server fields and missing retry keys without inserting', { skip }, async () => fixture(async f => server(f.people, async request => {
  const cases = [
    [{ ...f.input(), contract_version: 2 }, 400, 'UNSUPPORTED_CONTRACT_VERSION'],
    [{ ...f.input(), version: 42 }, 400, 'RACK_INPUT_INVALID'],
    [{ ...f.input(), placements: [] }, 400, 'RACK_INPUT_INVALID'],
    [{ ...f.input(), project_id: f.b.projectId }, 400, 'RACK_INPUT_INVALID'],
    [{ ...f.input(), name: ' ' }, 400, 'RACK_INPUT_INVALID'],
    [{ ...f.input(), scenario_id: 'bad' }, 400, 'RACK_INPUT_INVALID'],
    [{ ...f.input(), facility_input: { ...f.input().facility_input, revision_etag: '\n' } }, 400, 'RACK_INPUT_INVALID'],
    [[], 400, 'RACK_INPUT_INVALID'],
  ];
  for (const [body, status, code] of cases) {
    const result = await request(path(f.a), { body });
    assert.equal(result.status, status);
    assert.equal(result.body.error.code, code);
    assert.ok(result.body.meta.correlation_id);
  }
  assert.equal((await request(path(f.a), { body: f.input(), key: null })).status, 428);
  assert.equal((await request(path(f.a), { body: f.input(), key: 'invalid' })).status, 400);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM rack_plans WHERE project_id=$1', [f.a.projectId])).rows[0].n, 0);
})));

test('Rack verifies the real room, revision, scenario and current token before creation', { skip }, async () => fixture(async f => server(f.people, async request => {
  const cases = [
    [{ ...f.input(), scenario_id: f.b.scenarioId }, 404, 'NOT_FOUND'],
    [{ ...f.input(), facility_input: { ...f.input().facility_input, container_id: f.b.hallId } }, 404, 'NOT_FOUND'],
    [{ ...f.input(), facility_input: { ...f.input().facility_input, container_id: f.a.buildingId } }, 409, 'RACK_ROOM_REQUIRED'],
    [{ ...f.input(), facility_input: { ...f.input().facility_input, revision_etag: 'old-token' } }, 409, 'RACK_SOURCE_STALE'],
  ];
  for (const [body, status, code] of cases) {
    const result = await request(path(f.a), { body });
    assert.equal(result.status, status);
    assert.equal(result.body.error.code, code);
  }
  await pool.query('DELETE FROM revision_etags WHERE project_id=$1', [f.a.projectId]);
  const missing = await request(path(f.a), { body: f.input() });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error.code, 'RACK_SOURCE_ETAG_MISSING');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM rack_plans WHERE project_id=$1', [f.a.projectId])).rows[0].n, 0);
})));

test('Rack cannot create from frozen Facility input in this first slice', { skip }, async () => fixture(async f => server(f.people, async request => {
  const response = await request(path(f.a), { body: f.input() });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'RACK_SOURCE_STATE_UNSUPPORTED');
}), { state: 'VALIDATED' }));

test('Rack read and replay expose changed upstream input without rebinding the plan', { skip }, async () => fixture(async f => server(f.people, async request => {
  const key = randomUUID();
  const created = await request(path(f.a), { body: f.input(), key });
  const next = randomUUID();
  await pool.query('UPDATE revision_etags SET etag=$1,etag_version=etag_version+1 WHERE project_id=$2', [next, f.a.projectId]);
  for (const result of [await request(created.location), await request(path(f.a), { body: f.input(), key })]) {
    assert.equal(result.status, 200);
    assert.equal(result.body.data.facilityInputStatus.status, 'STALE');
    assert.deepEqual(result.body.data.facilityInputStatus.reasons, ['ETAG_CHANGED']);
    assert.equal(result.body.data.facilityInput.revisionEtag, f.a.etag);
    assert.equal(result.body.data.version, 1);
    assert.equal(result.body.data.validationState, 'NOT_RUN');
  }
  await pool.query("UPDATE revisions SET lifecycle_state='VALIDATED',content_checksum='test-frozen-checksum' WHERE project_id=$1", [f.a.projectId]);
  const frozen = await request(created.location);
  assert.equal(frozen.body.data.facilityInputStatus.status, 'STALE');
  assert.deepEqual(frozen.body.data.facilityInputStatus.reasons, ['SOURCE_NOT_DRAFT', 'ETAG_CHANGED']);
  assert.equal(frozen.body.data.state, 'DRAFT', 'Facility freezing must not freeze a Rack plan');
  await pool.query('DELETE FROM revision_etags WHERE project_id=$1', [f.a.projectId]);
  const missing = await request(created.location);
  assert.equal(missing.body.data.facilityInputStatus.status, 'UNAVAILABLE');
  assert.deepEqual(missing.body.data.facilityInputStatus.reasons, ['SOURCE_NOT_DRAFT', 'ETAG_MISSING']);
})));

test('Rack database composite foreign keys reject a cross-project room even for an owner connection', { skip }, async () => fixture(async f => {
  const service = createRackPlanService({ pool });
  const { plan } = await service.create({ projectId: f.a.projectId, actorId: f.people.admin.userId, body: f.input(), creationKey: randomUUID() });
  await assert.rejects(pool.query(`UPDATE rack_plans SET source_container_id=$1 WHERE plan_id=$2 AND project_id=$3`,
    [f.b.hallId, plan.planId, f.a.projectId]), error => error.code === '23503');
  await assert.rejects(pool.query(`UPDATE rack_plans SET scenario_id=$1 WHERE plan_id=$2 AND project_id=$3`,
    [f.b.scenarioId, plan.planId, f.a.projectId]), error => error.code === '23503');
}));

test('Rack RLS isolates reads and writes under a real non-owner non-superuser role', { skip }, async () => fixture(async f => {
  const service = createRackPlanService({ pool });
  for (const p of [f.a, f.b]) await service.create({ projectId: p.projectId, actorId: f.people.admin.userId, body: f.input(p), creationKey: randomUUID() });
  const client = await pool.connect();
  const role = `rack_probe_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT ON rack_plans TO ${role}`);
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.project_id','',true)");
    assert.equal((await client.query('SELECT * FROM rack_plans')).rowCount, 0);
    await client.query("SELECT set_config('app.project_id',$1,true)", [f.a.projectId]);
    const rows = await client.query('SELECT project_id FROM rack_plans');
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].project_id, f.a.projectId);
    assert.equal((await client.query('SELECT * FROM rack_plans WHERE project_id=$1', [f.b.projectId])).rowCount, 0);
    await assert.rejects(client.query(`INSERT INTO rack_plans
      (project_id,scenario_id,source_revision_id,source_container_id,source_revision_etag,name,creation_key,creation_hash,created_by)
      VALUES ($1,$2,$3,$4,$5,'RLS probe',$6,$7,$8)`,
    [f.b.projectId, f.b.scenarioId, f.b.revisionId, f.b.hallId, f.b.etag, randomUUID(), '0'.repeat(64), f.people.admin.userId]),
    error => error.code === '42501' && /row-level security/i.test(error.message));
  } finally {
    // Role and grants were created in this transaction, so rollback removes both.
    await client.query('ROLLBACK');
    client.release();
  }
}));

test('a concurrent Facility token update completes before Rack accepts the expected source version', { skip }, async () => fixture(async f => {
  const name = `rack-concurrency-${randomUUID()}`;
  const otherPool = createPool({ connectionString: process.env.DATABASE_URL, max: 1, applicationName: name });
  const blocker = await pool.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2', [randomUUID(), f.a.projectId]);
    pending = createRackPlanService({ pool: otherPool }).create({
      projectId: f.a.projectId, actorId: f.people.admin.userId, body: f.input(), creationKey: randomUUID(),
    }).then(result => ({ result }), error => ({ error }));
    let waiting = false;
    const deadline = Date.now() + 3000;
    while (!waiting && Date.now() < deadline) {
      const activity = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1', [name]);
      waiting = activity.rows.some(row => row.wait_event_type === 'Lock');
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(waiting, 'Rack must wait on the changing source token, not read its obsolete value');
    await blocker.query('COMMIT');
    const outcome = await pending;
    assert.equal(outcome.error?.code, 'RACK_SOURCE_STALE');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM rack_plans WHERE project_id=$1', [f.a.projectId])).rows[0].n, 0);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await pending;
    await otherPool.end();
  }
}));
