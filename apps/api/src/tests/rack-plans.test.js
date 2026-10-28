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
import { createRackLayoutService } from '../services/rack-layout.js';

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
      for (const table of ['rack_plans', 'geometry_records', 'facility_containers', 'design_scopes', 'facility_envelopes', 'entity_registry']) {
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
  const evaluator = createEvaluator({ repository });
  const guard = createPermissionGuard({ evaluator, repository });
  registerRackRoutes(router, { pool, guard });
  const authenticator = { async authenticate(ctx) {
    const person = people[ctx.headers['x-test-user']];
    if (!person) throw errors.unauthorized();
    ctx.user = { userId: person.userId, status: 'ACTIVE' };
  } };
  const logger = createLogger({ sink: { log() {}, warn() {}, error() {} }, level: 'error' });
  const app = createServer(createApp({ router, pool, guard, authenticator, logger }));
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = async (path, { user = 'admin', body, key = randomUUID(), method, version } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'connection': 'close', 'x-test-user': user, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === null ? {} : { 'idempotency-key': key }), ...(version === undefined ? {} : {'if-match':`"${version}"`}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), location: response.headers.get('location') };
  };
  try { await fn(request); } finally { await new Promise(resolve => app.close(resolve)); }
}

const path = p => `/api/v1/projects/${p.projectId}/rack/plans`;

const roomOuter = [[500000,4400000],[500010,4400000],[500010,4400004],[500004,4400004],[500004,4400010],[500000,4400010],[500000,4400000]];
const roomHole = [[500001,4400001],[500002,4400001],[500002,4400002],[500001,4400002],[500001,4400001]];
async function addBoundary(p, { coordinates = [roomOuter, roomHole], crs = 'EPSG:32618', role = 'FLOOR_BOUNDARY' } = {}) {
  const id = randomUUID();
  await pool.query(`INSERT INTO geometry_records
    (geometry_id,project_id,scenario_id,revision_id,entity_id,entity_type,role,ordinal,geometry_type,
     geojson_4326,projected_geometry,projected_crs,provenance)
    VALUES ($1,$2,$3,$4,$5,'HALL',$6,0,'POLYGON',
      ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($7),32618),4326),
      ST_SetSRID(ST_GeomFromGeoJSON($7),32618),$8,'{"source_ref":"rack-room-test"}')`,
  [id,p.projectId,p.scenarioId,p.revisionId,p.hallId,role,JSON.stringify({type:'Polygon',coordinates}),crs]);
  return id;
}

test('Rack room view reads a bound projected polygon with concavity and holes without changing the plan', {skip}, async () => fixture(async f => server(f.people, async request => {
  const created = await request(path(f.a),{body:f.input()});
  const url = `${created.location}/room-view`;
  assert.equal((await request(url)).body.data.reason,'BOUNDARY_MISSING');
  const geometryId = await addBoundary(f.a);
  const response = await request(url,{user:'viewer'});
  assert.equal(response.status,200);
  assert.ok(response.body.meta.correlation_id);
  const data = response.body.data;
  assert.equal(data.status,'AVAILABLE');
  assert.equal(data.planId,created.body.data.planId);
  assert.deepEqual(data.facilityInput,created.body.data.facilityInput);
  assert.equal(data.sourceGeometry.geometryId,geometryId);
  assert.equal(data.sourceGeometry.transformReviewState,'NOT_RECORDED');
  assert.equal(data.sourceGeometry.provenanceReference,'rack-room-test');
  assert.equal(data.view.boundaryLocalM.coordinates[0].length,7);
  assert.equal(data.view.boundaryLocalM.coordinates.length,2);
  const area = (await pool.query('SELECT ST_Area(projected_geometry) AS area FROM geometry_records WHERE geometry_id=$1',[geometryId])).rows[0].area;
  assert.equal(data.view.areaM2,area);
  assert.equal(area,63);
  assert.equal(data.view.obstacleCoverage,'UNKNOWN');
  assert.deepEqual((await request(created.location)).body.data,created.body.data,'read does not bind a snapshot or advance Rack state');
  assert.equal((await request(`${path(f.b)}/${created.body.data.planId}/room-view`)).status,404);
  assert.equal((await request(url,{user:'outsider'})).status,403);
  assert.equal((await request(url,{user:'unknown'})).status,401);
  assert.equal((await request(`${path(f.a)}/not-a-uuid/room-view`)).status,404);
})));

test('Rack room view blocks changed, frozen and unavailable sources without returning replacement geometry', {skip}, async () => fixture(async f => server(f.people, async request => {
  const created = await request(path(f.a),{body:f.input()});
  await addBoundary(f.a);
  const url = `${created.location}/room-view`;
  assert.equal((await request(url)).body.data.status,'AVAILABLE');
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  const stale = (await request(url)).body.data;
  assert.equal(stale.status,'BLOCKED');
  assert.equal(stale.view,null);
  assert.equal(stale.sourceGeometry,null);
  assert.equal(stale.facilityInput.revisionEtag,f.a.etag);
  assert.equal(stale.facilityInputStatus.status,'STALE');
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[f.a.etag,f.a.projectId]);
  await pool.query("UPDATE revisions SET lifecycle_state='VALIDATED', content_checksum='test' WHERE project_id=$1",[f.a.projectId]);
  const frozen = (await request(url)).body.data;
  assert.equal(frozen.status,'BLOCKED');
  assert.equal(frozen.view,null);
  assert.deepEqual(frozen.facilityInputStatus.reasons,['SOURCE_NOT_DRAFT']);
  await pool.query('DELETE FROM revision_etags WHERE project_id=$1',[f.a.projectId]);
  const missing = (await request(url)).body.data;
  assert.equal(missing.status,'BLOCKED');
  assert.equal(missing.facilityInputStatus.status,'UNAVAILABLE');
})));

test('Rack room view refuses ambiguous, invalid, unsupported-CRS and oversized boundaries', {skip}, async () => fixture(async f => server(f.people, async request => {
  const created = await request(path(f.a),{body:f.input()});
  const url = `${created.location}/room-view`;
  await addBoundary(f.a);
  await addBoundary(f.a,{role:'ROOM_BOUNDARY'});
  assert.equal((await request(url)).body.data.reason,'BOUNDARY_AMBIGUOUS');
  await pool.query('DELETE FROM geometry_records WHERE project_id=$1',[f.a.projectId]);
  await addBoundary(f.a,{crs:'EPSG:4326'});
  assert.equal((await request(url)).body.data.reason,'CRS_UNSUPPORTED');
  await pool.query('DELETE FROM geometry_records WHERE project_id=$1',[f.a.projectId]);
  await addBoundary(f.a,{coordinates:[[[500000,4400000],[500010,4400010],[500000,4400010],[500010,4400000],[500000,4400000]]]});
  assert.equal((await request(url)).body.data.reason,'INVALID_BOUNDARY');
  await pool.query('DELETE FROM geometry_records WHERE project_id=$1',[f.a.projectId]);
  const ring = Array.from({length:4100},(_,i)=>[500000+10*Math.cos(i*2*Math.PI/4100),4400000+10*Math.sin(i*2*Math.PI/4100)]);
  ring.push(ring[0]);
  await addBoundary(f.a,{coordinates:[ring]});
  const large = (await request(url)).body.data;
  assert.equal(large.reason,'GEOMETRY_TOO_COMPLEX');
  assert.equal(large.view,null);
})));

test('Rack room view separately requires Facility read access for a custom Rack-only role', {skip}, async () => fixture(async f => server(f.people, async request => {
  const created = await request(path(f.a),{body:f.input()});
  const roleId = randomUUID(), roleKey = `rack-only-${roleId}`;
  try {
    await pool.query("INSERT INTO roles (role_id,role_key,name,description,scope_hint) VALUES ($1,$2,'Rack only','Test only','project')",[roleId,roleKey]);
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,permission_id FROM permissions WHERE key='rack.read'",[roleId]);
    await repository.assignRole({userId:f.people.viewer.userId,roleKey,scopeKind:'project',scopeId:f.a.projectId});
    assert.equal((await request(created.location,{user:'viewer'})).status,200);
    const denied = await request(`${created.location}/room-view`,{user:'viewer'});
    assert.equal(denied.status,403);
    assert.equal(denied.body.error.details[0].function_key,'facility.read');
    for(const suffix of ['/layout','/layout/check']) {
      const result=await request(`${created.location}${suffix}`,{user:'viewer',...(suffix.endsWith('/check')?{body:{contract_version:1}}:{})});
      assert.equal(result.status,403);assert.equal(result.body.error.details[0].function_key,'facility.read');
    }
  } finally {
    await repository.revokeAssignment({userId:f.people.viewer.userId,scopeKind:'project',scopeId:f.a.projectId});
    await pool.query('DELETE FROM roles WHERE role_id=$1',[roleId]);
  }
})));

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

const demoModel = '10000000-0000-4000-8000-000000000002';
const rack = (xM=3,yM=3,extra={}) => ({rackId:randomUUID(),modelId:demoModel,name:'Rack',xM,yM,rotationDeg:0,locked:false,...extra});
const layoutBody = (layout,placements) => ({contract_version:1,snapshot_id:layout.snapshot.snapshotId,placements});
async function prepared(f,request,coordinates) {
  await addBoundary(f.a,coordinates?{coordinates}:{});
  const created=await request(path(f.a),{body:f.input()});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const url=`${created.location}/layout`;
  const response=await request(url);
  assert.equal(response.status,200,JSON.stringify(response.body));
  return {url,planUrl:created.location,layout:response.body.data};
}

test('Rack layout captures geometry at creation and atomically persists/reloads versioned placements', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,planUrl,layout}=await prepared(f,request);
  assert.equal(layout.version,1);assert.ok(layout.snapshot.snapshotId);assert.equal(layout.models.length,2);
  assert.equal(layout.models[0].maxPowerKw,null);
  const placements=[rack(3,3),rack(6,2,{rotationDeg:90})];
  const body=layoutBody(layout,placements),key=randomUUID();
  const responses=await Promise.all([request(url,{body,key,method:'PUT',version:1}),request(url,{body,key,method:'PUT',version:1})]);
  assert.deepEqual(responses.map(r=>r.status),[200,200],JSON.stringify(responses));
  assert.equal(responses.filter(r=>r.body.meta.replayed).length,1);
  const saved=(await request(url,{user:'viewer'})).body.data;
  assert.equal(saved.version,2);assert.equal(saved.placements.length,2);assert.equal(saved.validationState,'NOT_RUN');
  assert.deepEqual(saved.snapshot,layout.snapshot);
  assert.deepEqual(saved.placements.toSorted((a,b)=>a.rackId.localeCompare(b.rackId)),placements.toSorted((a,b)=>a.rackId.localeCompare(b.rackId)));
  const detail=(await request(planUrl)).body.data;assert.equal(detail.version,2);assert.equal(detail.placements.length,2);
  assert.equal((await request(path(f.a))).body.data.items[0].version,2);
  assert.equal((await request(url,{body,key,method:'PUT',version:1})).body.meta.applied_version,2);
  const reused=await request(url,{body:{...body,placements:[]},key,method:'PUT',version:1});
  assert.equal(reused.status,409);assert.equal(reused.body.error.code,'IDEMPOTENCY_KEY_REUSED');
  const conflict=await request(url,{body,method:'PUT',version:1});assert.equal(conflict.status,412);
  const bad=await request(url,{body:layoutBody(saved,[rack(50,50)]),method:'PUT',version:2});
  assert.equal(bad.status,422,JSON.stringify(bad));assert.equal(bad.body.error.code,'RACK_LAYOUT_CONFLICT');
  assert.deepEqual((await request(url)).body.data,saved,'failed save is atomic');
  const later=await request(url,{body:layoutBody(saved,placements.map(p=>({...p,name:'Revised'}))),version:2,method:'PUT'});
  assert.equal(later.status,200);assert.equal(later.body.data.version,3);
  const replayAfterAdvance=await request(url,{body,key,method:'PUT',version:1});
  assert.equal(replayAfterAdvance.body.data.version,3);assert.equal(replayAfterAdvance.body.meta.applied_version,2);
})));

test('Rack real Polygon predicates distinguish walls, holes, rotations and rack edge contact', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  async function codes(placements) {
    const response=await request(`${url}/check`,{body:layoutBody(layout,placements),user:'viewer'});
    assert.equal(response.status,200,JSON.stringify(response.body));
    return response.body.data.report.diagnostics.map(d=>d.code);
  }
  assert.deepEqual(await codes([rack(.4,3)]),[],'outer wall contact allowed');
  assert.ok((await codes([rack(.399,3)])).includes('RACK_OUTSIDE_ROOM'));
  assert.deepEqual(await codes([rack(3,3)]),[]);
  assert.ok((await codes([rack(1.5,1.5)])).includes('RACK_HOLE_CONFLICT'));
  assert.ok((await codes([rack(2.4,1.5)])).includes('RACK_HOLE_CONFLICT'),'hole contact disallowed');
  assert.deepEqual(await codes([rack(3,3),rack(3.8,3)]),[],'rack edge contact allowed');
  assert.ok((await codes([rack(3,3),rack(3.799,3)])).includes('RACK_PAIR_OVERLAP'));
  assert.deepEqual(await codes([rack(.5,3)]),[]);
  assert.ok((await codes([rack(.5,3,{rotationDeg:90})])).includes('RACK_OUTSIDE_ROOM'));
  assert.ok((await codes([rack(6,6)])).includes('RACK_OUTSIDE_ROOM'),'bbox is not the L-shaped room');
})));

test('Rack rejects concave crossings with all corners inside and holes fully enclosed by a footprint', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const local=[[[0,0],[10,0],[10,10],[5.1,10],[5.1,5.1],[4.9,5.1],[4.9,10],[0,10],[0,0]],
    [[2.95,2.95],[3.05,2.95],[3.05,3.05],[2.95,3.05],[2.95,2.95]]];
  const projected=local.map(r=>r.map(([x,y])=>[500000+x,4400000+y]));
  const {url,layout}=await prepared(f,request,projected);
  const response=await request(`${url}/check`,{body:layoutBody(layout,[rack(5,5),rack(3,3)])});
  assert.equal(response.status,200,JSON.stringify(response));
  const codes=response.body.data.report.diagnostics.map(d=>d.code);
  assert.equal(codes.filter(code=>code==='RACK_OUTSIDE_ROOM').length,2);
  assert.ok(codes.includes('RACK_HOLE_CONFLICT'));
})));

test('Rack legacy capture is explicit, idempotent and does not replace a fixed snapshot', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const created=await request(path(f.a),{body:f.input()});const url=`${created.location}/layout`,capture=`${created.location}/room-snapshot`;
  assert.equal((await request(url)).body.data.snapshot,null);
  const absent=await request(capture,{body:{contract_version:1},version:1});assert.equal(absent.status,409);
  await addBoundary(f.a);
  const key=randomUUID();const opts={body:{contract_version:1},version:1,key};
  const first=await request(capture,opts);assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.data.version,2);
  const replay=await request(capture,opts);assert.equal(replay.body.meta.replayed,true);
  const twice=await request(capture,{body:{contract_version:1},version:2});assert.equal(twice.body.data.version,2);
  assert.deepEqual(twice.body.data.snapshot,first.body.data.snapshot);
  assert.equal((await pool.query('SELECT count(*)::int n FROM rack_room_snapshots WHERE project_id=$1',[f.a.projectId])).rows[0].n,1);
})));

test('Rack snapshot survives stale Facility source while fresh commands are blocked', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const body=layoutBody(layout,[rack()]);const key=randomUUID();
  const saved=await request(url,{body,version:1,key,method:'PUT'});assert.equal(saved.status,200);
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  await pool.query('DELETE FROM geometry_records WHERE project_id=$1',[f.a.projectId]);
  const stale=(await request(url)).body.data;assert.equal(stale.sourceStatus.status,'STALE');
  assert.deepEqual(stale.snapshot,layout.snapshot);assert.equal(stale.placements.length,1);
  const blocked=await request(url,{body,version:2,method:'PUT'});assert.equal(blocked.status,409);assert.equal(blocked.body.error.code,'RACK_SOURCE_STALE');
  const retry=await request(url,{body,version:1,key,method:'PUT'});assert.equal(retry.status,200);assert.equal(retry.body.meta.replayed,true);
  assert.equal((await request(`${url}/check`,{body})).status,200,'fixed geometry can be inspected when stale');
})));

test('Rack locked positions require a separately saved unlock before move/delete', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const original=rack(3,3,{locked:true});
  const save=(placements,version)=>request(url,{body:layoutBody(layout,placements),method:'PUT',version});
  assert.equal((await save([original],1)).status,200);
  for(const placements of [[],[{...original,xM:3.1}],[{...original,locked:false,rotationDeg:90}]]) {
    const rejected=await save(placements,2);assert.equal(rejected.status,400,JSON.stringify(rejected));
    assert.equal(rejected.body.error.code,'RACK_INPUT_INVALID');
  }
  assert.equal((await request(url)).body.data.version,2);
  assert.equal((await save([{...original,locked:false}],2)).status,200);
  assert.equal((await save([{...original,locked:false,xM:3.1,rotationDeg:90}],3)).status,200);
  assert.equal((await save([],4)).status,200);assert.equal((await request(url)).body.data.placements.length,0);
})));

test('Rack layout guards scope, versions, snapshot identity and strict requests', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const body=layoutBody(layout,[rack()]);
  assert.equal((await request(url,{user:'outsider'})).status,403);
  assert.equal((await request(url.replace(f.a.projectId,f.b.projectId))).status,404);
  assert.equal((await request(url,{method:'PUT',body,user:'viewer',version:1})).status,403);
  assert.equal((await request(url,{method:'PUT',body})).status,428);
  assert.equal((await request(url,{method:'PUT',body,version:1,key:null})).status,428);
  assert.equal((await request(url,{method:'PUT',body,version:0})).status,400);
  assert.equal((await request(url,{method:'PUT',body:{...body,snapshot_id:randomUUID()},version:1})).status,409);
  for(const changed of [{...body,unknown:1},{...body,placements:[{...rack(),projectId:f.b.projectId}]},
    {...body,placements:[rack(10001,2)]},{...body,placements:[rack(3,3,{modelId:randomUUID()})]}]) {
    assert.equal((await request(`${url}/check`,{body:changed})).status,400);
  }
  assert.equal((await request(url)).body.data.version,1);
})));

test('Rack competing writers cannot silently overwrite the same base version', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  const results=await Promise.all([request(url,{method:'PUT',body:layoutBody(layout,[rack(3,3)]),version:1}),
    request(url,{method:'PUT',body:layoutBody(layout,[rack(6,2)]),version:1,user:'editor'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);
  assert.equal((await request(url)).body.data.version,2);
  assert.equal((await request(url)).body.data.placements.length,1);
})));

test('Rack new persistence tables enforce project RLS for read, insert and update', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  assert.equal((await request(url,{method:'PUT',body:layoutBody(layout,[rack()]),version:1})).status,200);
  await addBoundary(f.b);
  const other=await request(path(f.b),{body:f.input(f.b)});
  const otherLayout=(await request(`${other.location}/layout`)).body.data;
  assert.equal((await request(`${other.location}/layout`,{method:'PUT',body:layoutBody(otherLayout,[rack()]),version:1})).status,200);
  const client=await pool.connect();const role=`rack_layout_probe_${randomUUID().replaceAll('-','')}`;
  const tables=['rack_room_snapshots','rack_placements','rack_layout_commands'];
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON ${tables.join(',')} TO ${role}`);
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.project_id','',true)");
    for(const table of tables) assert.equal((await client.query(`SELECT * FROM ${table}`)).rowCount,0);
    await client.query("SELECT set_config('app.project_id',$1,true)",[f.a.projectId]);
    for(const table of tables) {
      const rows=await client.query(`SELECT project_id FROM ${table}`);
      assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].project_id,f.a.projectId);
      assert.equal((await client.query(`UPDATE ${table} SET project_id=project_id WHERE project_id=$1`,[f.b.projectId])).rowCount,0);
      await client.query('SAVEPOINT violation');
      await assert.rejects(client.query(`INSERT INTO ${table}
        SELECT (jsonb_populate_record(NULL::${table},to_jsonb(t)||jsonb_build_object('project_id',$1::text))).*
        FROM ${table} t WHERE project_id=$2`,[f.b.projectId,f.a.projectId]),error=>error.code==='42501');
      await client.query('ROLLBACK TO SAVEPOINT violation');
      await client.query('SAVEPOINT violation');
      await assert.rejects(client.query(`UPDATE ${table} SET project_id=$1 WHERE project_id=$2`,[f.b.projectId,f.a.projectId]),error=>error.code==='42501');
      await client.query('ROLLBACK TO SAVEPOINT violation');
    }
  } finally {await client.query('ROLLBACK');client.release();}
})));

test('Rack save waits for a concurrent source update and rejects its obsolete input', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {layout}=await prepared(f,request);const name=`rack-save-source-${randomUUID()}`;
  const other=createPool({connectionString:process.env.DATABASE_URL,max:1,applicationName:name});
  const blocker=await pool.connect();let pending;
  try {
    await blocker.query('BEGIN');await blocker.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
    pending=createRackLayoutService({pool:other}).mutate({projectId:f.a.projectId,planId:layout.planId,actorId:f.people.editor.userId,
      body:layoutBody(layout,[rack()]),key:randomUUID(),ifMatch:'"1"',operation:'save'}).then(result=>({result}),error=>({error}));
    let waiting=false;const deadline=Date.now()+3000;
    while(!waiting && Date.now()<deadline) {
      waiting=(await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1',[name])).rows.some(row=>row.wait_event_type==='Lock');
      if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(waiting);await blocker.query('COMMIT');assert.equal((await pending).error?.code,'RACK_SOURCE_STALE');
    assert.equal((await pool.query('SELECT version FROM rack_plans WHERE plan_id=$1',[layout.planId])).rows[0].version,1);
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;await other.end();}
})));

const constraintsInput=(patch={})=>({obstacleCoverage:'UNKNOWN',source:{kind:'ASSUMED',reference:'Integration test planning assumption'},obstacles:[],clearance:null,...patch});
const planningObstacle=(xM=6,yM=2,patch={})=>({obstacleId:randomUUID(),name:'Test forbidden area',xM,yM,widthM:1,depthM:1,...patch});

test('Rack constraints persist atomically with racks, preserve omitted older-client values and reject stale updates', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);assert.equal(layout.constraints.obstacleCoverage,'UNKNOWN');assert.equal(layout.constraints.clearance,null);
  const placements=[rack(3,3)];const constraints=constraintsInput({obstacleCoverage:'DECLARED_COMPLETE',obstacles:[planningObstacle()],clearance:{frontM:1,rearM:.5}});
  const body={...layoutBody(layout,placements),constraints};const key=randomUUID();
  const first=await request(url,{body,key,version:1,method:'PUT'});assert.equal(first.status,200,JSON.stringify(first));
  const saved=first.body.data;assert.equal(saved.version,2);assert.deepEqual(saved.constraints,constraints);assert.deepEqual(saved.snapshot,layout.snapshot);
  const checked=await request(`${url}/check`,{body,user:'viewer'});assert.equal(checked.body.data.report.status,'CHECKED_SCOPE_CLEAR');
  assert.equal(checked.body.data.report.obstaclesChecked,1);assert.equal(checked.body.data.report.clearanceBandsChecked,2);
  assert.ok(!checked.body.data.report.uncheckedRules.includes('MAINTENANCE_CLEARANCE'));
  const retry=await request(url,{body,key,version:1,method:'PUT'});assert.equal(retry.body.meta.replayed,true);
  assert.deepEqual((await request(url,{user:'viewer'})).body.data.constraints,constraints);
  const failing=await request(url,{body:{...body,constraints:{...constraints,obstacles:[planningObstacle(3,3)]}},version:2,method:'PUT'});
  assert.equal(failing.status,422);assert.deepEqual((await request(url)).body.data,saved,'failed conditions do not leave partial racks or constraints');
  assert.equal((await request(url,{body:{...body,constraints:constraintsInput()},version:1,method:'PUT'})).status,412);
  const omitted=await request(url,{body:layoutBody(layout,placements),version:2,method:'PUT'});assert.equal(omitted.status,200);
  assert.deepEqual(omitted.body.data.constraints,constraints,'omitted constraints preserve saved values');
  const omittedCheck=await request(`${url}/check`,{body:layoutBody(layout,placements)});assert.equal(omittedCheck.body.data.report.obstaclesChecked,1);
})));

test('Rack checks declared rectangles even with unknown coverage and rejects obstacle contact and invalid room placement', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  async function report(obstacles,placements=[rack(3,3)],extra={}) {
    const response=await request(`${url}/check`,{body:{...layoutBody(layout,placements),constraints:constraintsInput({obstacles,...extra})}});
    assert.equal(response.status,200,JSON.stringify(response));return response.body.data.report;
  }
  const incomplete=await report([planningObstacle()]);assert.equal(incomplete.status,'INCOMPLETE');
  assert.ok(incomplete.uncheckedRules.includes('UNRECORDED_OBSTACLES'));assert.ok(incomplete.uncheckedRules.includes('MAINTENANCE_CLEARANCE'));
  const contact=await report([planningObstacle(3.9,3)]);assert.ok(contact.diagnostics.some(d=>d.code==='RACK_OBSTACLE_CONFLICT'));
  const hole=await report([planningObstacle(1.5,1.5,{widthM:.1,depthM:.1})],[]);assert.ok(hole.diagnostics.some(d=>d.code==='OBSTACLE_OUTSIDE_ROOM'&&d.rackIds.length===0&&d.obstacleIds.length===1));
  const notch=await report([planningObstacle(6,6)],[]);assert.ok(notch.diagnostics.some(d=>d.code==='OBSTACLE_OUTSIDE_ROOM'));
  const enclosed=await report([planningObstacle(3,3,{widthM:.1,depthM:.1})]);assert.ok(enclosed.diagnostics.some(d=>d.code==='RACK_OBSTACLE_CONFLICT'));
  const empty=await report([],[],{obstacleCoverage:'DECLARED_COMPLETE',clearance:{frontM:0,rearM:0}});assert.equal(empty.status,'NOT_CHECKED');
})));

test('Rack maintenance checks follow all four orientations and distinguish unset and explicit zero', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const coordinates=[[[500000,4400000],[500010,4400000],[500010,4400010],[500000,4400010],[500000,4400000]]];
  const {url,layout}=await prepared(f,request,coordinates);
  async function report(item,constraints) {
    const r=await request(`${url}/check`,{body:{...layoutBody(layout,[item]),constraints:constraintsInput(constraints)}});assert.equal(r.status,200,JSON.stringify(r));return r.body.data.report;
  }
  const cases=[[0,5,1],[90,9,5],[180,5,9],[270,1,5]];
  for(const [rotationDeg,xM,yM] of cases) {
    const result=await report(rack(xM,yM,{rotationDeg}),{clearance:{frontM:1,rearM:0}});
    assert.ok(result.diagnostics.some(d=>d.code==='CLEARANCE_OUTSIDE_ROOM'&&d.side==='FRONT'),String(rotationDeg));
  }
  const wall=await report(rack(5,1.6),{clearance:{frontM:1,rearM:0}});assert.equal(wall.diagnostics.length,0,'band may touch outer wall');
  const rear=await report(rack(5,9),{clearance:{frontM:0,rearM:1}});assert.ok(rear.diagnostics.some(d=>d.code==='CLEARANCE_OUTSIDE_ROOM'&&d.side==='REAR'));
  const zero=await report(rack(5,1),{clearance:{frontM:0,rearM:0},obstacleCoverage:'DECLARED_COMPLETE'});assert.equal(zero.status,'CHECKED_SCOPE_CLEAR');assert.equal(zero.clearanceBandsChecked,0);
  const unset=await report(rack(5,1),{});assert.equal(unset.status,'INCOMPLETE');assert.ok(unset.uncheckedRules.includes('MAINTENANCE_CLEARANCE'));
})));

test('Rack maintenance bands may overlap each other but rack bodies and obstacles cannot occupy them', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const clearance={frontM:1,rearM:1};
  async function report(placements,obstacles=[]) {
    const r=await request(`${url}/check`,{body:{...layoutBody(layout,placements),constraints:constraintsInput({clearance,obstacles})}});assert.equal(r.status,200,JSON.stringify(r));return r.body.data.report;
  }
  const shared=await report([rack(3,3),rack(3,5.5)]);assert.equal(shared.diagnostics.length,0,'shared maintenance band is allowed');
  const invaded=await report([rack(3,3),rack(3,4.5)]);assert.ok(invaded.diagnostics.some(d=>d.code==='CLEARANCE_RACK_CONFLICT'&&d.rackIds.length===2));
  const obstacles=await report([rack(3,3)],[planningObstacle(3,1.8,{widthM:.1,depthM:.1})]);assert.ok(obstacles.diagnostics.some(d=>d.code==='CLEARANCE_OBSTACLE_CONFLICT'&&d.side==='FRONT'));
  const edge=await report([rack(3,3)],[planningObstacle(3,1.35,{widthM:.1,depthM:.1})]);assert.ok(edge.diagnostics.some(d=>d.code==='CLEARANCE_OBSTACLE_CONFLICT'),'obstacle-band contact is rejected');
})));

test('Rack constraints reject malformed/injected inputs and reuse existing scope, read-only, freshness and version guards', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const body={...layoutBody(layout,[rack()]),constraints:constraintsInput()};
  for(const constraints of [null,{},constraintsInput({obstacleCoverage:'COMPLETE'}),constraintsInput({projectId:f.b.projectId}),
    constraintsInput({obstacles:Array.from({length:65},()=>planningObstacle())}),constraintsInput({clearance:{frontM:Infinity,rearM:1}}),
    constraintsInput({obstacles:[planningObstacle(6,2,{widthM:0})]})]) {
    assert.equal((await request(`${url}/check`,{body:{...body,constraints}})).status,400);
  }
  assert.equal((await request(url,{method:'PUT',body,version:1,user:'viewer'})).status,403);
  assert.equal((await request(`${url}/check`,{body,user:'outsider'})).status,403);
  assert.equal((await request(url.replace(f.a.projectId,f.b.projectId),{method:'PUT',body,version:1})).status,404);
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  assert.equal((await request(url,{method:'PUT',body,version:1})).body.error.code,'RACK_SOURCE_STALE');
  assert.equal((await request(url)).body.data.version,1);
})));

test('Rack maintenance bands respect interior holes, exact rack contact and partial source coverage', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  async function check(placements,constraints) {
    const result=await request(`${url}/check`,{body:{...layoutBody(layout,placements),constraints:constraintsInput(constraints)}});
    assert.equal(result.status,200,JSON.stringify(result));return result.body.data.report;
  }
  const hole=await check([rack(1.5,3)],{clearance:{frontM:1,rearM:0}});
  assert.ok(hole.diagnostics.some(d=>d.code==='CLEARANCE_OUTSIDE_ROOM'&&d.side==='FRONT'));
  const contact=await check([rack(3,3),rack(3,5.2)],{clearance:{frontM:1,rearM:1}});
  assert.equal(contact.diagnostics.length,0,'rack body may touch maintenance band outer edge without interior intrusion');
  const unknown=await check([rack(3,3)],{clearance:{frontM:0,rearM:0}});
  assert.equal(unknown.status,'INCOMPLETE');assert.deepEqual(unknown.uncheckedRules.slice(0,1),['UNRECORDED_OBSTACLES']);
  const unconfigured=await check([rack(3,3)],{obstacleCoverage:'DECLARED_COMPLETE'});
  assert.equal(unconfigured.status,'INCOMPLETE');assert.ok(unconfigured.uncheckedRules.includes('MAINTENANCE_CLEARANCE'));
})));
