import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createLogger, errors, loadConfig } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerRackRoutes } from '../routes/rack.js';
import { createRackPlanService } from '../services/rack-plans.js';
import { createRackLayoutService } from '../services/rack-layout.js';
import { createRackAssistantEdits } from '../services/rack-assistant-edits.js';
import { createExecutionContext } from '@ai-infra/assistant';
import { getRackCatalog, MAX_EQUIPMENT_DEVICES } from '@ai-infra/rack';
import { plannerGeometry, normalizeEditableLayout } from '@ai-infra/rack';
import { pickRackPosition } from '../services/rack-planner-geometry.js';
import { createRackAssistantSurface } from '../services/rack-assistant.js';
import { createAssistantHostFor, createAssistantScopeResolver, createPermissionAuthorizer } from '../assistant-host.js';
import { createAssistantConnections } from '../services/assistant-connections.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createAssistantHost } from '@ai-infra/assistant';
import { registerAssistantRoutes } from '../routes/assistant.js';

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

async function server(people, fn, { assistant = null } = {}) {
  const router = createRouter();
  const evaluator = createEvaluator({ repository });
  const guard = createPermissionGuard({ evaluator, repository });
  registerRackRoutes(router, { pool, guard });
  if (assistant) registerAssistantRoutes(router, assistant);
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
    return { status: response.status, body: await response.json(), location: response.headers.get('location'), cacheControl: response.headers.get('cache-control') };
  };
  try { await fn(request); } finally { await new Promise(resolve => app.close(resolve)); }
}

const path = p => `/api/v1/projects/${p.projectId}/rack/plans`;

test('new-user lifecycle retains layout, equipment and constraints across rename/delete/restore and blocks deleted writes', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  await addBoundary(f.a);
  const creationKey=randomUUID(),created=await request(path(f.a),{body:f.input(),key:creationKey});
  assert.equal(created.status,201); assert.equal(created.cacheControl,'no-store');
  const url=created.location,layout=(await request(`${url}/layout`)).body.data;
  const rackId=randomUUID(),placement={rackId,modelId:layout.models[0].modelId,name:'First rack',xM:3,yM:7,rotationDeg:0,locked:false};
  const body={contract_version:1,snapshot_id:layout.snapshot.snapshotId,placements:[placement],
    constraints:{...layout.constraints,clearance:{frontM:1,rearM:.6},obstacles:[{obstacleId:randomUUID(),name:'Reserved',xM:8,yM:2,widthM:1,depthM:1}]},
    equipment:{...layout.equipment,devices:[{deviceId:randomUUID(),name:'Server',heightU:2,weightKg:10,powerKw:1,coolingKw:1,rackId,startU:1}],
      rackLimits:[{rackId,maxWeightKg:100,maxPowerKw:3,maxCoolingKw:3}]}};
  const saved=await request(`${url}/layout`,{method:'PUT',body,version:1});assert.equal(saved.status,200);
  const renameKey=randomUUID(),rename={method:'PATCH',body:{contract_version:1,name:'New user plan'},version:2,key:renameKey};
  const named=await request(url,rename);assert.equal(named.status,200);assert.equal(named.body.data.name,'New user plan');assert.equal(named.body.data.version,3);
  assert.equal((await request(url,rename)).body.meta.replayed,true);
  assert.equal((await request(url,{...rename,body:{...rename.body,name:'Different'}})).status,409);
  const remove={method:'DELETE',body:{contract_version:1},version:3,key:randomUUID()};
  const deleted=await request(url,remove);assert.equal(deleted.status,200);assert.ok(deleted.body.data.deletedAt);assert.equal(deleted.body.data.version,4);
  assert.equal((await request(url,remove)).body.meta.replayed,true);
  assert.equal((await request(path(f.a))).body.data.items.length,0);
  const trash=(await request(`${path(f.a)}?deleted=true`)).body.data.items;assert.equal(trash.length,1);assert.equal(trash[0].planId,created.body.data.planId);
  assert.equal((await request(`${path(f.a)}?cursor=${trash[0].planId}`)).body.data.items.length,0);
  for(const suffix of ['/layout','/room-view']) {
    const removed=await request(url+suffix);
    assert.equal(removed.status,410);assert.equal(removed.cacheControl,'no-store');
  }
  assert.equal((await request(`${url}/layout/check`,{body})).status,410);
  assert.equal((await request(`${url}/layout`,{method:'PUT',body,version:2})).status,410);
  assert.equal((await request(path(f.a),{body:f.input(),key:creationKey})).status,409,'creation replay cannot recreate a deleted plan');
  const restore={body:{contract_version:1},version:4,key:randomUUID()};
  const restored=await request(`${url}/restore`,restore);assert.equal(restored.status,200);assert.equal(restored.body.data.deletedAt,null);assert.equal(restored.body.data.version,5);
  assert.equal((await request(`${url}/restore`,restore)).body.meta.replayed,true);
  const reopened=(await request(`${url}/layout`)).body.data;
  for(const key of ['snapshot','placements','constraints','equipment'])assert.deepEqual(reopened[key],saved.body.data[key]);
  assert.equal((await request(url,{method:'DELETE',body:{contract_version:1},version:3})).status,412);
  assert.equal((await request(path(f.a))).body.data.items.length,1);
})));

test('lifecycle enforces tenant, permission, preconditions and atomic command rollback', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const created=await request(path(f.a),{body:f.input()}),url=created.location;
  assert.equal((await request(url,{method:'PATCH',body:{contract_version:1,name:'Editor renamed'},version:1,user:'editor'})).status,200);
  for (const operation of [{method:'DELETE',suffix:''},{method:'POST',suffix:'/restore'}]) {
    assert.equal((await request(url+operation.suffix,{method:operation.method,body:{contract_version:1},version:2,user:'editor'})).status,403);
  }
  for(const operation of [{method:'DELETE',body:{contract_version:1}},{method:'PATCH',body:{contract_version:1,name:'Renamed'}},{method:'POST',suffix:'/restore',body:{contract_version:1}}]) {
    const {suffix='',...opts}=operation;
    assert.equal((await request(url+suffix,{...opts,version:1,user:'viewer'})).status,403);
    assert.equal((await request(url+suffix,{...opts,version:1,user:'outsider'})).status,403);
    assert.equal((await request(`${path(f.b)}/${created.body.data.planId}${suffix}`,{...opts,version:1})).status,404);
  }
  assert.equal((await request(url,{method:'DELETE',body:{contract_version:1}})).status,428);
  assert.equal((await request(url,{method:'DELETE',body:{contract_version:1},version:1,key:null})).status,428);
  assert.equal((await request(url,{method:'DELETE',body:{contract_version:1,extra:true},version:1})).status,400);
  assert.equal((await request(url,{method:'PATCH',body:{contract_version:1,name:' '},version:1})).status,400);
  assert.equal((await request(`${path(f.a)}?deleted=maybe`)).status,400);
  const count=(await pool.query('SELECT count(*)::int AS n FROM rack_layout_commands WHERE project_id=$1',[f.a.projectId])).rows[0].n;
  assert.equal(count,1,'Only the successful editor rename persists a command; rejected operations add nothing.');
  // Cleanup and rename stay possible when Facility changed; restoring never bypasses the layout source lock.
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  assert.equal((await request(url,{method:'DELETE',body:{contract_version:1},version:2})).status,200);
  assert.equal((await request(`${url}/restore`,{body:{contract_version:1},version:3})).status,200);
  assert.equal((await request(url)).body.data.facilityInputStatus.status,'STALE');
})));

test('editor can create and save an empty layout while viewer mutation is refused', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  await addBoundary(f.a);
  const created=await request(path(f.a),{body:f.input(),user:'editor'});assert.equal(created.status,201);
  const layout=(await request(`${created.location}/layout`,{user:'editor'})).body.data;
  const body={contract_version:1,snapshot_id:layout.snapshot.snapshotId,placements:[],constraints:layout.constraints,equipment:layout.equipment};
  assert.equal((await request(`${created.location}/layout`,{method:'PUT',body,version:1,user:'viewer'})).status,403);
  assert.equal((await request(`${created.location}/layout`,{method:'PUT',body,version:1,user:'editor'})).status,200);
  assert.equal((await request(`${created.location}/layout`,{user:'viewer'})).body.data.version,2);
})));

test('delete and layout save serialize on the same version without resurrecting a plan', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  await addBoundary(f.a);const created=await request(path(f.a),{body:f.input()}),url=created.location;
  const layout=(await request(`${url}/layout`)).body.data;
  const body={contract_version:1,snapshot_id:layout.snapshot.snapshotId,placements:[],constraints:layout.constraints,equipment:layout.equipment};
  const results=await Promise.all([request(url,{method:'DELETE',body:{contract_version:1},version:1}),request(`${url}/layout`,{method:'PUT',body,version:1})]);
  assert.equal(results.filter(r=>r.status===200).length,1);
  assert.ok(results.some(r=>[410,412].includes(r.status)));
  assert.equal((await request(url)).body.data.version,2);
})));

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
    for(const suffix of ['/layout','/layout/check','/layout/options']) {
      const result=await request(`${created.location}${suffix}`,{user:'viewer',...(suffix==='/layout'?{}:{body:{contract_version:1}})});
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

test('Rack catalog is a guarded read-only project endpoint with versioned composition and real rule examples', {skip}, async () => fixture(async f => server(f.people, async request => {
  const url = `/api/v1/projects/${f.a.projectId}/rack/catalog`;
  const before = (await pool.query('SELECT count(*)::int AS n FROM rack_plans WHERE project_id=$1', [f.a.projectId])).rows[0].n;
  for (const user of ['admin', 'editor', 'viewer']) {
    const response = await request(url, { user });
    assert.equal(response.status, 200); assert.equal(response.body.data.projectId, f.a.projectId);
    assert.ok(response.body.meta.correlation_id);
    assert.deepEqual(response.body.data.models, getRackCatalog().models);
    assert.equal(response.body.data.examples[1].equipmentReport.status, 'ISSUES_FOUND');
  }
  assert.equal((await request(url, { user: 'outsider' })).status, 403);
  assert.equal((await request(url, { user: 'unknown' })).status, 401);
  const post = await request(url, { body: { models: [] } });
  assert.ok([404, 405].includes(post.status));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM rack_plans WHERE project_id=$1', [f.a.projectId])).rows[0].n, before);
})));

test('Rack pinned catalog equipment persists atomically, replays exactly and rejects forged specifications and versions', {skip}, async () => fixture(async f => server(f.people, async request => {
  const { url, layout } = await prepared(f, request), r = rack();
  const m = getRackCatalog().models[0];
  const d = { deviceId: randomUUID(), name: 'Catalog GPU', ...m.specification,
    catalogRef: { modelId: m.modelId, version: m.version }, rackId: r.rackId, startU: 1 };
  const body = { ...layoutBody(layout, [r]), equipment: equipmentInput([d]) }, key = randomUUID();
  const saved = await request(url, { method: 'PUT', body, key, version: 1 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.data.version, 2);
  assert.deepEqual(saved.body.data.equipment.devices[0], d);
  assert.deepEqual((await pool.query('SELECT equipment FROM rack_plans WHERE plan_id=$1', [layout.planId])).rows[0].equipment.devices[0], d);
  const replayed = await request(url, { method: 'PUT', body, key, version: 1 });
  assert.equal(replayed.body.meta.replayed, true); assert.equal(replayed.body.data.version, 2);
  for (const patch of [{ powerKw: 0 }, { heightU: 1 }, { catalogRef: { ...d.catalogRef, version: 999 } }, { catalogRef: null }]) {
    const bad = { ...body, equipment: equipmentInput([{ ...d, ...patch }]) };
    assert.equal((await request(`${url}/check`, { body: bad })).status, 400);
    const failed = await request(url, { method: 'PUT', body: bad, version: 2 });
    assert.equal(failed.status, 400); assert.equal(failed.body.error.code, 'RACK_INPUT_INVALID');
  }
  assert.deepEqual((await request(url, { user: 'viewer' })).body.data, saved.body.data);
  assert.equal((await request(url, { method: 'PUT', body, version: 2, user: 'viewer' })).status, 403);
  assert.equal((await request(`${url}/check`, { body, user: 'outsider' })).status, 403);
  assert.equal((await request(url, { method: 'PUT', body, version: 1 })).status, 412);
  const { catalogRef, ...custom } = d;
  const changed = { ...body, equipment: equipmentInput([{ ...custom, powerKw: 1 }]) };
  const detached = await request(url, { method: 'PUT', body: changed, version: 2 });
  assert.equal(detached.status, 200); assert.equal(detached.body.data.version, 3);
  assert.equal(Object.hasOwn(detached.body.data.equipment.devices[0], 'catalogRef'), false);
  assert.equal(detached.body.data.equipment.devices[0].deviceId, d.deviceId);
})));

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

test('saved check evidence is idempotent, scoped, non-mutating and historical after plan changes', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {url,planUrl,layout}=await prepared(f,request);
  const runUrl=`${planUrl}/check-runs`, body={contract_version:1,base_version:layout.version,snapshot_id:layout.snapshot.snapshotId},key=randomUUID();
  assert.equal((await request(`${planUrl}/report`,{user:'viewer'})).body.data.checkRun,null);
  const created=await request(runUrl,{body,key,user:'editor'});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const run=created.body.data;
  assert.equal(run.planVersion,layout.version);assert.equal(run.createdBy,f.people.editor.userId);
  assert.equal(run.freshness.status,'CURRENT');assert.equal(run.ruleset,'rack-scoped-checks/v1');
  assert.equal(run.report.status,'NOT_CHECKED');assert.ok(run.equipmentReport.uncheckedRules.includes('ENGINEERING_ACCURACY'));
  assert.equal(run.inputHash.length,64);
  const replay=await request(runUrl,{body,key,user:'editor'});
  assert.equal(replay.status,200);assert.equal(replay.body.meta.replayed,true);assert.deepEqual(replay.body.data,run);
  assert.equal((await request(runUrl,{body,key})).status,409,'another actor cannot reuse recording identity');
  assert.equal((await request(runUrl,{body:{...body,base_version:9},key,user:'editor'})).status,409);
  const listed=(await request(runUrl,{user:'viewer'})).body.data;
  assert.equal(listed.items.length,1);assert.equal(listed.items[0].runId,run.runId);assert.equal(listed.items[0].report,undefined);
  const detail=await request(`${runUrl}/${run.runId}`,{user:'viewer'});assert.equal(detail.status,200);assert.deepEqual(detail.body.data,run);
  const exported=(await request(`${planUrl}/report`,{user:'viewer'})).body.data;
  assert.equal(exported.kind,'RACK_PLANNING_REPORT');assert.deepEqual(exported.layout,layout);assert.deepEqual(exported.checkRun,run);
  assert.equal(exported.validationState,'NOT_RUN');
  assert.deepEqual((await request(url)).body.data,layout,'recording checks does not change any layout fields');
  assert.equal((await pool.query('SELECT count(*)::int n FROM rack_layout_commands WHERE project_id=$1',[f.a.projectId])).rows[0].n,0);
  assert.equal((await request(planUrl,{method:'PATCH',body:{contract_version:1,name:'Renamed'},version:layout.version})).status,200);
  const old=(await request(`${runUrl}/${run.runId}`)).body.data;
  assert.equal(old.freshness.status,'HISTORICAL');assert.ok(old.freshness.reasons.includes('PLAN_VERSION_CHANGED'));
  assert.equal((await request(`${planUrl}/report`)).body.data.checkRun,null);
  assert.equal((await request(runUrl,{body})).status,412);
  assert.equal((await request(runUrl,{body,key,user:'editor'})).body.data.runId,run.runId,'exact retry still finds the old run');
  const current=(await request(url)).body.data;
  const saved=await request(url,{method:'PUT',version:current.version,body:layoutBody(current,[rack()])});assert.equal(saved.status,200);
  const newRun=await request(runUrl,{body:{...body,base_version:saved.body.data.version}});assert.equal(newRun.status,201,JSON.stringify(newRun.body));
  assert.equal(newRun.body.data.report.racksChecked,1);assert.notEqual(newRun.body.data.inputHash,run.inputHash);
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  assert.equal((await request(`${planUrl}/report`)).body.data.checkRun,null);
  assert.ok((await request(`${runUrl}/${newRun.body.data.runId}`)).body.data.freshness.reasons.includes('SOURCE_CHANGED'));
  assert.equal((await request(runUrl,{body:{...body,base_version:saved.body.data.version}})).status,409);
})));

test('check records reject malformed input, forbidden and foreign scopes, retain history across soft deletion', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {planUrl,layout}=await prepared(f,request),url=`${planUrl}/check-runs`;
  const body={contract_version:1,base_version:layout.version,snapshot_id:layout.snapshot.snapshotId};
  for (const user of ['viewer','outsider']) assert.equal((await request(url,{body,user})).status,403);
  for (const patch of [{base_version:0},{snapshot_id:'bad'},{placements:[]},{contract_version:2}])
    assert.equal((await request(url,{body:{...body,...patch}})).status,400);
  assert.equal((await request(url,{body,key:null})).status,428);
  assert.equal((await request(url,{body,key:'bad'})).status,400);
  assert.equal((await request(url,{body:{...body,snapshot_id:randomUUID()}})).status,409);
  const created=await request(url,{body});assert.equal(created.status,201);
  const runId=created.body.data.runId;
  for(const suffix of ['/check-runs',`/check-runs/${runId}`,'/report']){
    assert.equal((await request(`${path(f.b)}/${layout.planId}${suffix}`)).status,404);
    assert.equal((await request(`${planUrl}${suffix}`,{user:'outsider'})).status,403);
    assert.equal((await request(`${planUrl}${suffix}?extra=1`)).status,400);
  }
  assert.equal((await request(`${url}/${randomUUID()}`)).status,404);
  assert.equal((await request(`${url}/bad`)).status,404);
  assert.equal((await request(planUrl,{method:'DELETE',body:{contract_version:1},version:layout.version})).status,200);
  assert.equal((await request(url)).status,410);assert.equal((await request(url,{body})).status,410);
  assert.equal((await request(`${planUrl}/restore`,{body:{contract_version:1},version:layout.version+1})).status,200);
  const restored=(await request(url)).body.data.items;
  assert.equal(restored.length,1);assert.equal(restored[0].runId,runId);assert.equal(restored[0].freshness.status,'HISTORICAL');
})));

test('concurrent check retries append once, history is bounded and forced RLS hides foreign evidence', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {planUrl,layout}=await prepared(f,request),url=`${planUrl}/check-runs`;
  const body={contract_version:1,base_version:layout.version,snapshot_id:layout.snapshot.snapshotId},key=randomUUID();
  const concurrent=await Promise.all([request(url,{body,key}),request(url,{body,key})]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,201]);
  assert.equal(concurrent[0].body.data.runId,concurrent[1].body.data.runId);
  const reordered={snapshot_id:body.snapshot_id,base_version:body.base_version,contract_version:1};
  assert.equal((await request(url,{body:reordered,key})).status,200,'canonical hashing tolerates object key order');
  const role=`rack_check_rls_${randomUUID().replaceAll('-','')}`,client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON rack_check_runs TO ${role}`);
    await client.query(`SET LOCAL ROLE ${role}`);
    for(const [scope,count] of [['',0],[f.b.projectId,0],[f.a.projectId,1]]) {
      await client.query("SELECT set_config('app.project_id',$1,true)",[scope]);
      assert.equal((await client.query('SELECT count(*)::int n FROM rack_check_runs')).rows[0].n,count);
    }
  } finally {await client.query('ROLLBACK');client.release();}
  for(let i=0;i<20;i++) assert.equal((await request(url,{body})).status,201);
  const page=(await request(url)).body.data;
  assert.equal(page.items.length,20);assert.equal(page.hasOlder,true);assert.equal(page.limit,20);
  assert.ok(!page.items.some(run=>run.runId===concurrent[0].body.data.runId));
  assert.equal((await request(`${url}/${concurrent[0].body.data.runId}`)).status,200,'older evidence remains addressable');
})));

function designRequest(layout, patch={}) {
  return {contract_version:1,base_version:layout.version,snapshot_id:layout.snapshot.snapshotId,
    demand:{groups:[{modelId:'demo-gpu-4u',version:1,quantity:8},{modelId:'demo-tor-1u',version:1,quantity:2}],
      rackModelId:layout.models[0].modelId,maxRacks:8,rackLimits:{maxWeightKg:800,maxPowerKw:12,maxCoolingKw:12},
      gapM:.2,sourceReference:'HTTP test assumptions',constraints:{...layout.constraints,clearance:{frontM:1,rearM:.6}},...patch}};
}

function assistantEditRig(f,layout,user='admin') {
  const guard=createPermissionGuard({evaluator:createEvaluator({repository}),repository});
  const authorize=createPermissionAuthorizer({guard}),layouts=createRackLayoutService({pool});
  const edits=createRackAssistantEdits({pool,layouts,authorize});
  const ctx=createExecutionContext({userId:f.people[user].userId,requestId:randomUUID(),workspaceId:layout.projectId,
    scenarioId:layout.scenarioId,revisionId:layout.facilityInput.revisionId,
    rackContext:{planId:layout.planId,version:layout.version,clientVersion:layout.version,hasUnsavedDraft:false}});
  return {edits,ctx,layouts,authorize};
}
test('Assistant edit preview, confirmation, atomic save and replay use real Rack services', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request),rig=assistantEditRig(f,layout);
  const args={base_version:layout.version,operations:[{type:'ADD_RACK',model_id:layout.models[0].modelId,name:'Assistant rack',x_m:3,y_m:3}]};
  const surface=createRackAssistantSurface({layouts:rig.layouts,plans:createRackPlanService({pool}),authorize:rig.authorize,edits:rig.edits});
  let step=0;
  const provider={name:'scripted-edit-test',async complete(input){
    let message;
    if(step++===0) message={role:'assistant',content:null,tool_calls:[{id:'preview',type:'function',function:{name:'rack_preview_changes',arguments:JSON.stringify(args)}}]};
    else if(step===2){const preview=JSON.parse(input.messages.at(-1).content);assert.equal(preview.canApply,true);
      message={role:'assistant',content:null,tool_calls:[{id:'apply',type:'function',function:{name:'rack_apply_changes',arguments:JSON.stringify({proposal_id:preview.proposalId})}}]};}
    else message={role:'assistant',content:'Saved the exact confirmed Rack proposal.'};
    return{choices:[{message}]};
  }};
  const host=createAssistantHost({provider,surfaces:[surface.surface],guides:[surface.guide],capabilities:surface.capabilities,
    authorize:rig.authorize,resolveScope:async()=>({surface:'rack',workspaceId:layout.projectId,scenarioId:layout.scenarioId,
      revisionId:layout.facilityInput.revisionId,rackContext:rig.ctx.rackContext})});
  const turn={messages:[{role:'user',content:'Add a rack at (3,3) metres.'}],contextKey:'test|rack|edit',context:{userId:f.people.admin.userId,surface:'rack'}};
  const preview=await host.orchestrator.runTurn(turn);
  assert.equal(preview.status,'confirmation_required');assert.notEqual(preview.draftChanged,true);
  assert.deepEqual((await request(url)).body.data,layout);
  const pending=preview.pendingConfirmations[0];assert.match(pending.summary,/Add rack.*Assistant rack/);
  const accepted=await host.orchestrator.runTurn({...turn,confirmedCalls:[{callId:pending.callId,name:pending.toolName,arguments:pending.arguments}]});
  assert.equal(accepted.status,'ok');assert.equal(accepted.draftChanged,true);
  const saved=(await request(url)).body.data;assert.equal(saved.version,layout.version+1);assert.equal(saved.placements.length,1);assert.equal(saved.placements[0].name,'Assistant rack');
  const replay=await rig.edits.apply(rig.ctx,pending.arguments);assert.equal(replay.replayed,true);assert.equal(replay.appliedVersion,saved.version);
  assert.equal((await request(url)).body.data.version,saved.version);
  await assert.rejects(rig.edits.confirmable(rig.ctx,pending.arguments),e=>e.code==='RACK_PROPOSAL_APPLIED');
})));

test('Assistant edits reject scope, permissions, dirty/stale inputs and conflicts; concurrent apply saves once', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request),{edits,ctx}=assistantEditRig(f,layout);
  const args={base_version:layout.version,operations:[{type:'ADD_RACK',model_id:layout.models[0].modelId,name:'New rack',x_m:3,y_m:3}]};
  const viewer=assistantEditRig(f,layout,'viewer');await assert.rejects(viewer.edits.preview(viewer.ctx,args),e=>e.status===403);
  await assert.rejects(edits.preview({...ctx,rackContext:{...ctx.rackContext,hasUnsavedDraft:true}},args),e=>e.code==='RACK_ASSISTANT_DIRTY_DRAFT');
  await assert.rejects(edits.preview(ctx,{...args,base_version:99}),e=>e.status===412);
  await assert.rejects(edits.preview(ctx,{...args,operations:[{type:'ADD_RACK',model_id:layout.models[0].modelId,name:'Bad',x_m:'3',y_m:3}]}),e=>e.status===400);
  const outside=await edits.preview(ctx,{...args,operations:[{...args.operations[0],x_m:500}]});assert.equal(outside.canApply,false);assert.equal(outside.proposalId,undefined);
  const p=await edits.preview(ctx,args),apply={proposal_id:p.proposalId};
  const editor=assistantEditRig(f,layout,'editor');await assert.rejects(editor.edits.apply(editor.ctx,apply),e=>e.status===404);
  const foreign={...ctx,rackContext:{...ctx.rackContext,planId:randomUUID()}};await assert.rejects(edits.apply(foreign,apply),e=>e.status===404);
  const results=await Promise.all([edits.apply(ctx,apply),edits.apply(ctx,apply)]);
  assert.equal(results.filter(r=>r.replayed).length,1);assert.equal((await request(url)).body.data.version,layout.version+1);
  const saved=(await request(url)).body.data,rig2=assistantEditRig(f,saved);
  const overlap=await rig2.edits.preview(rig2.ctx,{base_version:saved.version,operations:[{...args.operations[0],name:'Overlap'}]});assert.equal(overlap.canApply,false);
  const move=await rig2.edits.preview(rig2.ctx,{base_version:saved.version,operations:[{type:'MOVE_RACK',rack:'New rack',x_m:3,y_m:7}]});
  assert.equal(move.canApply,true);
  await pool.query("UPDATE rack_assistant_proposals SET expires_at=now()-interval '1 minute' WHERE proposal_id=$1",[move.proposalId]);
  await assert.rejects(rig2.edits.apply(rig2.ctx,{proposal_id:move.proposalId}),e=>e.code==='RACK_PROPOSAL_EXPIRED');
  const stale=await rig2.edits.preview(rig2.ctx,{base_version:saved.version,operations:[{type:'MOVE_RACK',rack:'New rack',x_m:3,y_m:7}]});
  assert.equal((await request(url.replace(/\/layout$/,''),{method:'PATCH',body:{contract_version:1,name:'Concurrent rename'},version:saved.version})).status,200);
  await assert.rejects(rig2.edits.apply(rig2.ctx,{proposal_id:stale.proposalId}),e=>e.status===412);
})));

test('Assistant device/clearance/budget edits preserve save rules and roll back proposal state on changed inputs', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request),r=rack(3,3),deviceId=randomUUID();
  const body={...layoutBody(layout,[r]),equipment:{...layout.equipment,devices:[{deviceId,name:'Server',heightU:2,weightKg:10,powerKw:1,coolingKw:1,rackId:null,startU:null}]}};
  const saved=(await request(url,{method:'PUT',body,version:layout.version})).body.data,{edits,ctx}=assistantEditRig(f,saved);
  const preview=await edits.preview(ctx,{base_version:saved.version,operations:[{type:'ASSIGN_DEVICE',device:'Server',rack:r.rackId,start_u:1},
    {type:'SET_CLEARANCE',front_m:.5,rear_m:.5},{type:'SET_ROOM_BUDGET',max_power_kw:3,max_cooling_kw:3,reference:'User planning assumption'}]});
  assert.equal(preview.canApply,true);
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  await assert.rejects(edits.apply(ctx,{proposal_id:preview.proposalId}),e=>e.code==='RACK_SOURCE_STALE');
  assert.deepEqual((await request(url)).body.data.equipment,saved.equipment);
  assert.equal((await pool.query('SELECT applied_version FROM rack_assistant_proposals WHERE proposal_id=$1',[preview.proposalId])).rows[0].applied_version,null);
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[f.a.etag,f.a.projectId]);
  await edits.apply(ctx,{proposal_id:preview.proposalId});
  const applied=(await request(url)).body.data;
  assert.equal(applied.equipment.devices[0].rackId,r.rackId);assert.equal(applied.constraints.clearance.frontM,.5);assert.equal(applied.equipment.roomBudget.maxPowerKw,3);
  const next=assistantEditRig(f,applied);
  const bad=await next.edits.preview(next.ctx,{base_version:applied.version,operations:[{type:'ASSIGN_DEVICE',device:'Server',rack:r.rackId,start_u:42}]});assert.equal(bad.canApply,false);
  const over=await next.edits.preview(next.ctx,{base_version:applied.version,operations:[{type:'SET_ROOM_BUDGET',max_power_kw:0,max_cooling_kw:3,reference:'Explicit zero'}]});assert.equal(over.canApply,false);
  await assert.rejects(next.edits.preview(next.ctx,{base_version:applied.version,operations:[{type:'REMOVE_RACK',rack:r.rackId}]}),/installed device/);
})));
test('demand design uses real concave Polygon/holes, is deterministic and read-only, then saves through the ordinary transaction', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request),body=designRequest(layout);
  const result=await request(`${url}/design-options`,{body,user:'viewer'});assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.data.persisted,false);assert.equal(result.body.data.validationState,'NOT_RUN');assert.equal(result.body.data.candidates.length,2);
  for(const c of result.body.data.candidates){assert.equal(c.canStage,true,JSON.stringify(c));assert.equal(c.body.equipment.devices.length,10);assert.equal(c.metrics.assignedDevices,10);assert.equal(c.report.diagnostics.length,0);assert.equal(c.equipmentReport.diagnostics.length,0);}
  assert.deepEqual((await request(`${url}/design-options`,{body})).body.data.candidates,result.body.data.candidates);
  const touching=await request(`${url}/design-options`,{body:designRequest(layout,{gapM:0})});
  assert.equal(touching.status,200,JSON.stringify(touching.body));
  assert.ok(touching.body.data.candidates.every(c=>c.canStage),'zero minimum gap is robust to floating point while preserving required front/rear clearance');
  const after=(await request(url)).body.data;assert.deepEqual(after,layout);
  assert.equal((await pool.query('SELECT count(*)::int n FROM rack_layout_commands WHERE project_id=$1',[f.a.projectId])).rows[0].n,0);
  const candidate=result.body.data.candidates[0];
  assert.equal((await request(url,{method:'PUT',body:candidate.body,version:1,user:'viewer'})).status,403);
  const saved=await request(url,{method:'PUT',body:candidate.body,version:1});assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal(saved.body.data.version,2);assert.deepEqual(saved.body.data.equipment,candidate.body.equipment);
  assert.equal((await request(`${url}/design-options`,{body})).status,412);
  assert.equal((await request(`${url}/design-options`,{body:{...body,base_version:2}})).status,409);
})));
test('demand planning blocks tenant, changed source, wrong snapshot and malformed catalog/limits without writing', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request),body=designRequest(layout);
  assert.equal((await request(`${url}/design-options`,{body,user:'outsider'})).status,403);
  assert.equal((await request(`${path(f.b)}/${layout.planId}/layout/design-options`,{body})).status,404);
  assert.equal((await request(`${url}/design-options`,{body:{...body,snapshot_id:randomUUID()}})).status,409);
  for(const demand of [{...body.demand,groups:[{modelId:'demo-gpu-4u',version:99,quantity:1}]},{...body.demand,maxRacks:33},{...body.demand,rackLimits:{...body.demand.rackLimits,maxPowerKw:null}}])
    assert.equal((await request(`${url}/design-options`,{body:{...body,demand}})).status,400);
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  assert.equal((await request(`${url}/design-options`,{body})).status,409);
  assert.equal((await request(url)).body.data.version,1);
})));
test('demand geometry failures and incomplete device/budget demands cannot stage, and never silently drop inventory', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  for(const patch of [{groups:[{modelId:'demo-optical-2u',version:1,quantity:2}]},
    {roomBudget:{source:{kind:'ASSUMED',reference:'test'},maxPowerKw:0,maxCoolingKw:100}},
    {constraints:{...layout.constraints,clearance:{frontM:10,rearM:10}}}]) {
    const result=await request(`${url}/design-options`,{body:designRequest(layout,patch)});assert.equal(result.status,200,JSON.stringify(result.body));
    for(const c of result.body.data.candidates){assert.equal(c.canStage,false);assert.ok(c.unplaced.length);assert.equal(c.body.equipment.devices.length,patch.groups?2:10);}
  }
  assert.deepEqual((await request(url)).body.data,layout);
})));

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
const equipmentInput=(devices=[],patch={})=>({coverage:'UNKNOWN',source:{kind:'ASSUMED',reference:'Test-only equipment and capacity assumptions'},devices,rackLimits:[],...patch});
const testDevice=(rackId,patch={})=>({deviceId:randomUUID(),name:'Test server',heightU:2,weightKg:20,powerKw:1,coolingKw:1,rackId,startU:rackId?1:null,...patch});

test('Rack larger inventory saves at the shared bound and rejects overflow without changes', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  const devices=Array.from({length:MAX_EQUIPMENT_DEVICES},()=>testDevice(null));
  const body={...layoutBody(layout,[]),equipment:equipmentInput(devices)};
  assert.ok(Buffer.byteLength(JSON.stringify(body))<1024*1024);
  const checked=await request(`${url}/check`,{body,user:'viewer'});
  assert.equal(checked.status,200,JSON.stringify(checked.body.error));
  assert.equal(checked.body.data.equipmentReport.devicesChecked,MAX_EQUIPMENT_DEVICES);
  const saved=await request(url,{method:'PUT',body,version:1,user:'editor'});
  assert.equal(saved.status,200,JSON.stringify(saved.body.error));
  const read=await request(url,{user:'viewer'});
  assert.deepEqual(read.body.data.equipment.devices,devices);
  const overflow={...body,equipment:equipmentInput([...devices,testDevice(null)])};
  assert.equal((await request(url,{method:'PUT',body:overflow,version:2,user:'editor'})).status,400);
  assert.deepEqual((await request(url)).body.data,saved.body.data);
})));

test('Rack equipment persists atomically, restores exact retries, preserves omitted equipment and rejects old versions', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);assert.equal(layout.equipment.coverage,'UNKNOWN');assert.deepEqual(layout.equipment.devices,[]);
  const r=rack(),devices=[testDevice(r.rackId)];
  const equipment=equipmentInput(devices,{coverage:'DECLARED_COMPLETE',rackLimits:[{rackId:r.rackId,maxWeightKg:100,maxPowerKw:10,maxCoolingKw:10}]});
  const body={...layoutBody(layout,[r]),equipment};const key=randomUUID();
  const first=await request(url,{method:'PUT',body,key,version:1,user:'editor'});assert.equal(first.status,200,JSON.stringify(first));
  assert.equal(first.body.data.version,2);assert.deepEqual(first.body.data.equipment,equipment);
  assert.deepEqual((await pool.query('SELECT equipment FROM rack_plans WHERE plan_id=$1',[layout.planId])).rows[0].equipment,equipment);
  const retry=await request(url,{method:'PUT',body,key,version:1});assert.equal(retry.body.meta.replayed,true);assert.equal(retry.body.data.version,2);
  assert.equal((await request(url,{method:'PUT',body:{...body,equipment:equipmentInput()},key,version:1})).body.error.code,'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await request(url,{method:'PUT',body,version:1})).status,412);
  assert.deepEqual((await request(url,{user:'viewer'})).body.data.equipment,equipment);
  const checked=await request(`${url}/check`,{body:layoutBody(layout,[r]),user:'viewer'});
  assert.equal(checked.status,200);assert.equal(checked.body.data.equipmentReport.status,'CHECKED_SCOPE_CLEAR');assert.equal(checked.body.data.equipmentReport.racks[0].occupiedU,2);
  const legacy=await request(url,{method:'PUT',body:layoutBody(layout,[{...r,name:'Renamed'}]),version:2});assert.equal(legacy.status,200);assert.deepEqual(legacy.body.data.equipment,equipment);
  assert.equal(legacy.body.data.validationState,'NOT_RUN');
})));

test('Rack equipment diagnoses U overlap, overflow and lower-bound overcapacity and rolls back every field on failure', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const r=rack();
  const body={...layoutBody(layout,[r]),equipment:equipmentInput([testDevice(r.rackId)])};
  const saved=await request(url,{method:'PUT',body,version:1});assert.equal(saved.status,200);
  const bad={...body,placements:[{...r,name:'Must not save'}],constraints:constraintsInput({source:{kind:'ASSUMED',reference:'Must not persist'}}),equipment:equipmentInput([testDevice(r.rackId,{startU:42,weightKg:120}),testDevice(r.rackId,{startU:42,weightKg:null})],{rackLimits:[{rackId:r.rackId,maxWeightKg:100,maxPowerKw:null,maxCoolingKw:null}]})};
  const checked=await request(`${url}/check`,{body:bad});assert.equal(checked.status,200);
  const report=checked.body.data.equipmentReport;assert.equal(report.status,'ISSUES_FOUND');
  for(const code of ['DEVICE_U_OUT_OF_BOUNDS','DEVICE_U_OVERLAP','RACK_CAPACITY_EXCEEDED']) assert.ok(report.diagnostics.some(d=>d.code===code),code);
  assert.equal(report.racks[0].capacities.weightKg.total,null);assert.equal(report.racks[0].capacities.weightKg.knownSubtotal,120);
  const failed=await request(url,{method:'PUT',body:bad,version:2});assert.equal(failed.status,422);assert.equal(failed.body.error.code,'RACK_EQUIPMENT_CONFLICT');
  assert.deepEqual((await request(url)).body.data,saved.body.data,'failure leaves racks, constraints, equipment, version and snapshot intact');
})));

test('Rack equipment moves between racks, unassigns without loss and protects rack deletion including legacy clients', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const a=rack(),b=rack(6,2);const device=testDevice(a.rackId);
  let body={...layoutBody(layout,[a,b]),equipment:equipmentInput([device])};
  assert.equal((await request(url,{method:'PUT',body,version:1})).status,200);
  const deleting=await request(url,{method:'PUT',body:layoutBody(layout,[b]),version:2});assert.equal(deleting.status,400,'omission cannot discard assignments to a deleted rack');
  body={...layoutBody(layout,[a,b]),equipment:equipmentInput([{...device,rackId:b.rackId,startU:41}])};
  const moved=await request(url,{method:'PUT',body,version:2});assert.equal(moved.status,200);assert.equal(moved.body.data.equipment.devices[0].deviceId,device.deviceId);
  body={...layoutBody(layout,[]),equipment:equipmentInput([{...device,rackId:null,startU:null}])};
  const unassigned=await request(url,{method:'PUT',body,version:3});assert.equal(unassigned.status,200);assert.equal(unassigned.body.data.equipment.devices[0].weightKg,20);
  const checked=await request(`${url}/check`,{body});assert.equal(checked.body.data.equipmentReport.installedDevices,0);assert.equal(checked.body.data.equipmentReport.status,'INCOMPLETE');
})));

test('Rack equipment rejects injected, foreign, duplicate and malformed inputs and retains project permissions', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const r=rack(),d=testDevice(r.rackId);
  const body={...layoutBody(layout,[r]),equipment:equipmentInput([d])};
  for(const equipment of [null,{},equipmentInput([],{projectId:f.b.projectId}),equipmentInput([{...d,rackId:randomUUID()}]),equipmentInput([d,{...d}]),equipmentInput([{...d,heightU:1.5}]),equipmentInput([{...d,weightKg:'20'}])]) {
    assert.equal((await request(`${url}/check`,{body:{...body,equipment}})).status,400);
  }
  assert.equal((await request(url,{method:'PUT',body,version:1,user:'viewer'})).status,403);
  assert.equal((await request(`${url}/check`,{body,user:'outsider'})).status,403);
  assert.equal((await request(url,{user:'outsider'})).status,403);
  assert.equal((await request(url.replace(f.a.projectId,f.b.projectId),{method:'PUT',body,version:1})).status,404);
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  assert.equal((await request(url,{method:'PUT',body,version:1})).body.error.code,'RACK_SOURCE_STALE');
  assert.deepEqual((await request(url)).body.data.equipment.devices,[]);
})));

test('Rack equipment explicit zero, partial unknown data and omission remain distinct; position lock permits equipment edits', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const r=rack(3,3,{locked:true});
  const first=await request(url,{method:'PUT',body:layoutBody(layout,[r]),version:1});assert.equal(first.status,200);
  const equipment=equipmentInput([testDevice(r.rackId,{weightKg:null,powerKw:0,coolingKw:0})],{coverage:'DECLARED_COMPLETE',rackLimits:[{rackId:r.rackId,maxWeightKg:100,maxPowerKw:0,maxCoolingKw:0}]});
  const body={...layoutBody(layout,[r]),equipment};const response=await request(url,{method:'PUT',body,version:2});assert.equal(response.status,200);
  const checked=await request(`${url}/check`,{body});const report=checked.body.data.equipmentReport;
  assert.equal(report.status,'INCOMPLETE');assert.equal(report.racks[0].capacities.weightKg.status,'UNKNOWN');assert.equal(report.racks[0].capacities.powerKw.status,'WITHIN_LIMIT');
  assert.equal(response.body.data.placements[0].locked,true);
})));
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

test('Rack options are read-only, deterministic and checked against actual concave geometry, holes, obstacles and clearance', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  const fixed=rack(3,3,{locked:true,name:'Fixed'}), moving=rack(6,2,{name:'Moving'});
  const equipment=equipmentInput([testDevice(moving.rackId)]);
  const constraints=constraintsInput({obstacleCoverage:'DECLARED_COMPLETE',clearance:{frontM:.5,rearM:.5},obstacles:[planningObstacle(7,2)]});
  const saved=await request(url,{method:'PUT',version:1,body:{...layoutBody(layout,[fixed,moving]),constraints,equipment}});
  assert.equal(saved.status,200,JSON.stringify(saved));
  const before=(await request(url)).body.data;
  const commands=(await pool.query('SELECT count(*) FROM rack_layout_commands WHERE plan_id=$1',[layout.planId])).rows[0].count;
  const body={contract_version:1,base_version:2,snapshot_id:layout.snapshot.snapshotId,options:{grid_step_m:.5,allow_rotation:true,strategy:'COMPARE'}};
  const response=await request(`${url}/options`,{body,user:'viewer'});
  assert.equal(response.status,200,JSON.stringify(response));
  const result=response.body.data;assert.equal(result.persisted,false);assert.equal(result.candidates.length,2);assert.equal(result.validationState,'NOT_RUN');
  for(const candidate of result.candidates){
    assert.equal(candidate.canStage,true,JSON.stringify(candidate));assert.equal(candidate.unplaced.length,0);
    assert.deepEqual(candidate.placements.find(p=>p.rackId===fixed.rackId),fixed);
    assert.deepEqual(candidate.body.equipment,equipment);
    const check=await request(`${url}/check`,{body:candidate.body});assert.equal(check.status,200);
    assert.deepEqual(check.body.data.report,candidate.report);assert.deepEqual(check.body.data.equipmentReport,candidate.equipmentReport);
  }
  const repeat=(await request(`${url}/options`,{body})).body.data;
  assert.deepEqual(repeat.candidates,result.candidates);assert.equal(repeat.inputFingerprint,result.inputFingerprint);
  assert.deepEqual((await request(url)).body.data,before);
  assert.equal((await pool.query('SELECT count(*) FROM rack_layout_commands WHERE plan_id=$1',[layout.planId])).rows[0].count,commands);
})));

test('Rack option application uses the existing atomic versioned save, replay protection, locks and source guard', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  const fixed=rack(3,3,{locked:true}), moving=rack(6,2);
  const saved=await request(url,{method:'PUT',version:1,body:layoutBody(layout,[fixed,moving])});assert.equal(saved.status,200);
  const body={contract_version:1,base_version:2,snapshot_id:layout.snapshot.snapshotId,options:{strategy:'INPUT_ORDER'}};
  const response=await request(`${url}/options`,{body});assert.equal(response.status,200,JSON.stringify(response));
  const candidate=response.body.data.candidates[0];assert.equal(candidate.canStage,true);
  const applied=await request(url,{method:'PUT',version:2,body:candidate.body,user:'viewer'});assert.equal(applied.status,403);
  const key=randomUUID();
  const first=await request(url,{method:'PUT',version:2,key,body:candidate.body,user:'editor'});assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.data.version,3);
  const replay=await request(url,{method:'PUT',version:2,key,body:candidate.body});assert.equal(replay.body.meta.replayed,true);assert.equal(replay.body.data.version,3);
  assert.equal((await request(url,{method:'PUT',version:2,body:candidate.body})).status,412);
  assert.equal((await request(`${url}/options`,{body})).status,412);
  const tampered=structuredClone(candidate.body);tampered.placements.find(p=>p.rackId===fixed.rackId).xM+=1;
  assert.equal((await request(url,{method:'PUT',version:3,body:tampered})).status,400);
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  assert.equal((await request(url,{method:'PUT',version:3,body:candidate.body})).body.error.code,'RACK_SOURCE_STALE');
  assert.equal((await request(`${url}/options`,{body:{...body,base_version:3}})).body.error.code,'RACK_SOURCE_STALE');
  assert.equal((await request(url)).body.data.version,3);
})));

test('Rack options enforce input, tenant and source boundaries and retain partial preview identities', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  const body={contract_version:1,base_version:1,snapshot_id:layout.snapshot.snapshotId,options:{}};
  assert.equal((await request(`${url}/options`,{body})).status,400,'empty inventory must not be successful');
  assert.equal((await request(`${url}/options`,{body,user:'outsider'})).status,403);
  assert.equal((await request(`${url.replace(f.a.projectId,f.b.projectId)}/options`,{body})).status,404);
  for(const patch of [{options:null},{options:{grid_step_m:0}},{options:{strategy:'OPTIMAL'}},{options:{allow_rotation:1}},{base_version:0},{snapshot_id:randomUUID()},{placements:[]}])
    assert.ok([400,409].includes((await request(`${url}/options`,{body:{...body,...patch}})).status));
  const item=rack(3,3);
  assert.equal((await request(url,{method:'PUT',version:1,body:layoutBody(layout,[item])})).status,200);
  // Simulate an authoritative room that is smaller than the existing rack; the
  // search must retain the rack identity in a blocked, fully checked preview.
  const tiny=structuredClone(layout.snapshot);tiny.view.boundaryLocalM={type:'Polygon',coordinates:[[[0,0],[.1,0],[.1,.1],[0,.1],[0,0]]]};
  const {snapshotId,...document}=tiny;
  await pool.query('UPDATE rack_room_snapshots SET document=$2 WHERE plan_id=$1',[layout.planId,JSON.stringify(document)]);
  const partial=await request(`${url}/options`,{body:{...body,base_version:2,options:{strategy:'INPUT_ORDER'}}});assert.equal(partial.status,200,JSON.stringify(partial));
  const candidate=partial.body.data.candidates[0];assert.equal(candidate.canStage,false);assert.equal(candidate.unplaced[0].code,'NO_GRID_POSITION');
  assert.deepEqual(candidate.placements,[item]);assert.ok(candidate.report.diagnostics.length>0);
})));

test('Rack planner batch geometry agrees with complete checks for every orientation, holes, notches, obstacles and two-way maintenance intrusion', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  const constraints=constraintsInput({obstacleCoverage:'DECLARED_COMPLETE',obstacles:[planningObstacle(6,2)],clearance:{frontM:1,rearM:.5}});
  const fixed=rack(3,3,{locked:true});
  const saved=await request(url,{method:'PUT',version:1,body:{...layoutBody(layout,[fixed]),constraints}});assert.equal(saved.status,200,JSON.stringify(saved));
  const current=(await request(url)).body.data;
  const catalog=current.models.find(m=>m.modelId===fixed.modelId);
  const fixedGeometry=plannerGeometry({...fixed,projectId:f.a.projectId,planId:layout.planId},catalog,constraints.clearance);
  const client=await pool.connect();
  try {
    for(const rotationDeg of [0,90,180,270]) for(const [xM,yM] of [[1.5,1.5],[6,6],[6,2],[3,4.2],[3,1.5],[.3,.6],[8,3],[2.2,3]]) {
      const p=rack(xM,yM,{rotationDeg});
      const entry=normalizeEditableLayout({placements:[p],models:current.models,projectId:f.a.projectId,planId:layout.planId})[0];
      const geometry=plannerGeometry(entry.placement,catalog,constraints.clearance);
      const pick=await pickRackPosition(client,current,constraints,[geometry],[fixedGeometry]);
      const checked=await request(`${url}/check`,{body:{...layoutBody(layout,[fixed,p]),constraints}});assert.equal(checked.status,200);
      assert.equal(pick===0,checked.body.data.report.diagnostics.length===0,JSON.stringify({rotationDeg,xM,yM,diagnostics:checked.body.data.report.diagnostics}));
    }
  }finally{client.release();}
})));

test('Rack equipment allocation is repeatable and read-only; partial results save atomically through the ordinary command', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);
  const fixed=rack(3,3,{locked:true}),target=rack(6,2);
  const installed=testDevice(fixed.rackId),small=testDevice(null,{heightU:4}),oversized=testDevice(null,{heightU:100}),unknown=testDevice(null,{weightKg:null});
  const equipment=equipmentInput([installed,small,oversized,unknown],{rackLimits:[{rackId:target.rackId,maxWeightKg:100,maxPowerKw:4,maxCoolingKw:4}]});
  const saved=(await request(url,{method:'PUT',version:1,body:{...layoutBody(layout,[fixed,target]),equipment}})).body.data;
  assert.equal(saved.version,2);
  const commands=async()=>(await pool.query('SELECT count(*)::int n FROM rack_layout_commands WHERE plan_id=$1',[saved.planId])).rows[0].n;
  const count=await commands();
  const body={contract_version:1,base_version:2,snapshot_id:saved.snapshot.snapshotId};
  const a=await request(`${url}/equipment-options`,{user:'viewer',body});
  const b=await request(`${url}/equipment-options`,{user:'viewer',body});
  assert.equal(a.status,200,JSON.stringify(a));assert.deepEqual(a.body.data,b.body.data);
  const option=a.body.data.candidates[0];
  assert.equal(option.assignments.length,1);assert.equal(option.unassigned.length,2);assert.equal(option.canStage,true);
  assert.equal(option.assignments[0].rackId,target.rackId);assert.equal(option.assignments[0].startU,1);
  assert.deepEqual(option.body.placements,saved.placements);assert.deepEqual(option.body.equipment.devices[0],installed);
  assert.equal(option.body.equipment.devices.length,4);assert.equal(option.equipmentReport.status,'INCOMPLETE');
  assert.equal(await commands(),count);assert.deepEqual((await request(url)).body.data,saved);
  assert.equal((await request(url,{user:'viewer',method:'PUT',version:2,body:option.body})).status,403);
  const applied=await request(url,{user:'editor',method:'PUT',version:2,body:option.body});assert.equal(applied.status,200,JSON.stringify(applied));
  assert.equal(applied.body.data.version,3);assert.deepEqual(applied.body.data.equipment,option.body.equipment);
  assert.deepEqual(applied.body.data.placements,saved.placements);
  assert.equal((await request(`${url}/equipment-options`,{body})).status,412);
})));

test('Rack equipment allocation rejects wrong scope/source/input and does not guess unknown capacities', {skip},async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request);const r=rack(),d=testDevice(null);
  const saved=(await request(url,{method:'PUT',version:1,body:{...layoutBody(layout,[r]),equipment:equipmentInput([d])}})).body.data;
  const body={contract_version:1,base_version:2,snapshot_id:saved.snapshot.snapshotId};
  const noCapacity=await request(`${url}/equipment-options`,{body});assert.equal(noCapacity.status,200);
  assert.equal(noCapacity.body.data.candidates[0].canStage,false);
  assert.equal(noCapacity.body.data.candidates[0].unassigned[0].rejectionCounts.UNKNOWN_RACK_CAPACITY,1);
  assert.equal((await request(`${url}/equipment-options`,{user:'outsider',body})).status,403);
  for(const patch of [{base_version:'2'},{equipment:{}},{placements:[]},{contract_version:9}])assert.equal((await request(`${url}/equipment-options`,{body:{...body,...patch}})).status,400);
  assert.equal((await request(`${url}/equipment-options`,{body:{...body,snapshot_id:randomUUID()}})).status,409);
  await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
  const stale=await request(`${url}/equipment-options`,{body});assert.equal(stale.status,409);assert.equal(stale.body.error.code,'RACK_SOURCE_STALE');
  assert.equal((await request(url)).body.data.version,2);
})));

function rackAssistantRig() {
  const guard = createPermissionGuard({ evaluator: createEvaluator({ repository }), repository });
  const authorize = createPermissionAuthorizer({ guard });
  const surface = createRackAssistantSurface({ layouts: createRackLayoutService({ pool }), plans: createRackPlanService({ pool }), authorize });
  const providerCalls = [];
  const provider = { name: 'scripted-integration', async complete(request) {
    providerCalls.push(request);
    const last = request.messages.at(-1);
    let message;
    if (last.role === 'tool') message = { role: 'assistant', content: JSON.stringify({ type: 'message', payload: last.content, uiActions: [] }) };
    else {
      const names = { list: 'rack_list_plans', read: 'rack_read_plan', capacity: 'rack_query_capacity', check: 'rack_check_saved_layout', generate: 'rack_generate_layout_options' };
      const name = names[last.content];
      message = { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: '{}' } }] };
    }
    return { choices: [{ message }] };
  } };
  const host = createAssistantHost({ provider, surfaces: [surface.surface], guides: [surface.guide], capabilities: surface.capabilities,
    resolveScope: createAssistantScopeResolver({ pool, authorize }), authorize });
  return { host, providerCalls, surface, authorize };
}

test('personal model connection drives the assembled Rack Host and real capacity tool with tenant checks', {skip}, async()=>fixture(async f=>{
  const base = resolve('.local-runtime');
  await mkdir(base,{recursive:true});
  const root = await mkdtemp(join(base,'rack-connection-test-'));
  let calls = 0;
  const connections = createAssistantConnections({directory:join(root,'connections'),keyDirectory:join(root,'keys'),fetchImpl:async (_url,options)=>{
    calls++;
    assert.equal(options.headers.authorization,'Bearer synthetic-rack-integration-key');
    const body=JSON.parse(options.body);
    assert.ok(body.tools.every(tool=>tool.function.name.startsWith('rack_')));
    const last=body.messages.at(-1);
    const message=last.role==='tool' ? {role:'assistant',content:JSON.stringify({type:'message',payload:last.content,uiActions:[]})}
      : {role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:'rack_query_capacity',arguments:'{}'}}]};
    return {ok:true,status:200,json:async()=>({choices:[{message}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})};
  }});
  try {
    const connection=await connections.save(f.people.viewer.userId,{name:'Viewer private connection',endpoint:'https://rack-fixture.invalid/v1',model:'synthetic',apiKey:'synthetic-rack-integration-key',version:null});
    const guard=createPermissionGuard({evaluator:createEvaluator({repository}),repository});
    const host=await createAssistantHostFor({config:loadConfig({}),pool,secrets:null,guard,connections});
    await server(f.people,async request=>{
      const {url,layout}=await prepared(f,request);
      assert.equal((await request(url,{method:'PUT',version:1,body:layoutBody(layout,[rack()])})).status,200);
      const wire={messages:[{role:'user',content:'查询容量'}],connection_id:connection.connectionId,connection_version:connection.version,
        context_key:`${f.a.projectId}|rack|${layout.planId}|connection:${connection.connectionId}:1|model:synthetic`,
        context:{surface:'rack',projectId:f.a.projectId,scenarioId:f.a.scenarioId,revisionId:f.a.revisionId,rack_context:{planId:layout.planId,clientVersion:2}}};
      const result=await request('/api/v1/assistant/chat',{user:'viewer',body:wire});
      assert.equal(result.status,200,JSON.stringify(result));
      assert.match(result.body.data.choices[0].message.content,/freeU/);
      assert.equal(calls,2);
      assert.equal((await request('/api/v1/assistant/chat',{user:'outsider',body:wire})).status,412);
      // A connection does not grant access to a foreign project.
      const foreign={...wire,context:{...wire.context,projectId:f.b.projectId,scenarioId:f.b.scenarioId,revisionId:f.b.revisionId}};
      assert.equal((await request('/api/v1/assistant/chat',{user:'viewer',body:foreign})).status,403);
      assert.equal(calls,2,'all scope refusals happen before provider requests');
      assert.equal((await request(url)).body.data.version,2,'chat does not save the plan');
    },{assistant:host});
  } finally {
    assert.ok(resolve(root).startsWith(`${base}${sep}rack-connection-test-`));
    await rm(root,{recursive:true,force:true});
  }
}));

const assumedRoomBudget = (patch = {}) => ({ maxPowerKw: 3, maxCoolingKw: 3,
  source: { kind: 'ASSUMED', reference: 'Synthetic HTTP fixture room budget' }, ...patch });

test('Rack room budgets persist atomically; legacy equipment edits retain them and oversubscription rolls back', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request), a=rack(3,3), b=rack(6,2);
  const equipment=equipmentInput([testDevice(a.rackId)],{
    coverage:'DECLARED_COMPLETE', roomBudget:assumedRoomBudget(),
    rackLimits:[a,b].map(r=>({rackId:r.rackId,maxWeightKg:100,maxPowerKw:10,maxCoolingKw:10})),
  });
  const body={...layoutBody(layout,[a,b]),equipment},key=randomUUID();
  const first=await request(url,{method:'PUT',body,version:1,key,user:'editor'});
  assert.equal(first.status,200,JSON.stringify(first));
  const saved=first.body.data;assert.equal(saved.version,2);
  assert.deepEqual(saved.equipment.roomBudget,equipment.roomBudget);
  assert.equal((await request(url,{method:'PUT',body,version:1,key})).body.meta.replayed,true);
  const commands=async()=>(await pool.query('SELECT count(*)::int n FROM rack_layout_commands WHERE plan_id=$1',[saved.planId])).rows[0].n;
  const count=await commands();
  const {roomBudget,...legacyEquipment}=equipment;
  const bad={...body,placements:[{...a,name:'Must roll back'},b],constraints:constraintsInput({source:{kind:'ASSUMED',reference:'Must roll back'}}),
    equipment:{...legacyEquipment,devices:[testDevice(a.rackId,{powerKw:2,coolingKw:2}),testDevice(b.rackId,{powerKw:2,coolingKw:2})]}};
  const checked=await request(`${url}/check`,{body:bad,user:'viewer'});
  assert.equal(checked.status,200,JSON.stringify(checked));
  const report=checked.body.data.equipmentReport;
  assert.ok(report.racks.every(r=>Object.values(r.capacities).every(c=>c.status==='WITHIN_LIMIT')));
  assert.equal(report.roomCapacity.resources.powerKw.limit,3);
  assert.equal(report.roomCapacity.resources.powerKw.total,4);
  assert.equal(report.diagnostics.filter(d=>d.code==='ROOM_BUDGET_EXCEEDED').length,2);
  const rejected=await request(url,{method:'PUT',body:bad,version:2});
  assert.equal(rejected.status,422);assert.equal(rejected.body.error.code,'RACK_EQUIPMENT_CONFLICT');
  assert.equal((await request(url,{method:'PUT',body,version:2,user:'viewer'})).status,403);
  assert.deepEqual((await request(url)).body.data,saved);assert.equal(await commands(),count);
  const legacySave=await request(url,{method:'PUT',version:2,body:{...body,equipment:legacyEquipment}});
  assert.equal(legacySave.status,200);assert.deepEqual(legacySave.body.data.equipment.roomBudget,roomBudget);
  const disabled=await request(url,{method:'PUT',version:3,body:{...bad,equipment:{...bad.equipment,roomBudget:null}}});
  assert.equal(disabled.status,200,JSON.stringify(disabled));assert.equal(disabled.body.data.equipment.roomBudget,null);
  assert.equal(disabled.body.data.version,4);assert.equal(disabled.body.data.validationState,'NOT_RUN');
  assert.equal((await request(url,{method:'PUT',version:2,body})).status,412);
})));

test('Rack allocation respects the remaining room budget and preserves it through preview and ordinary save', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request),fixed=rack(3,3,{locked:true}),target=rack(6,2);
  const equipment=equipmentInput([testDevice(fixed.rackId),testDevice(null,{heightU:4}),testDevice(null)],{
    roomBudget:assumedRoomBudget({maxPowerKw:2,maxCoolingKw:2}),
    rackLimits:[fixed,target].map(r=>({rackId:r.rackId,maxWeightKg:100,maxPowerKw:10,maxCoolingKw:10})),
  });
  const initial=await request(url,{method:'PUT',version:1,body:{...layoutBody(layout,[fixed,target]),equipment}});
  assert.equal(initial.status,200,JSON.stringify(initial));const saved=initial.body.data;
  const body={contract_version:1,base_version:2,snapshot_id:saved.snapshot.snapshotId};
  const generated=await request(`${url}/equipment-options`,{body,user:'viewer'});
  assert.equal(generated.status,200,JSON.stringify(generated));const c=generated.body.data.candidates[0];
  assert.equal(c.canStage,true);assert.equal(c.assignments.length,1);
  assert.equal(c.assignments[0].rackId,target.rackId);
  assert.equal(c.unassigned[0].code,'ROOM_BUDGET_EXCEEDED');
  assert.equal(c.equipmentReport.roomCapacity.resources.powerKw.total,2);
  assert.deepEqual(c.body.equipment.roomBudget,equipment.roomBudget);
  assert.deepEqual((await request(url)).body.data,saved);
  const applied=await request(url,{method:'PUT',version:2,body:c.body,user:'editor'});
  assert.equal(applied.status,200,JSON.stringify(applied));assert.deepEqual(applied.body.data.equipment,c.body.equipment);
  assert.equal((await request(`${url}/equipment-options`,{body})).status,412);
})));

test('Rack room budget input is strict and layout candidates cannot stage a saved room conflict', {skip}, async()=>fixture(async f=>server(f.people,async request=>{
  const {url,layout}=await prepared(f,request),r=rack(3,3,{locked:true});
  const equipment=equipmentInput([testDevice(r.rackId)],{roomBudget:assumedRoomBudget()});
  for(const roomBudget of [assumedRoomBudget({maxPowerKw:'3'}),assumedRoomBudget({maxCoolingKw:-1}),assumedRoomBudget({extra:true}),{maxPowerKw:3,maxCoolingKw:3,source:{kind:'FACILITY',reference:'Forged'}}]) {
    const body={...layoutBody(layout,[r]),equipment:{...equipment,roomBudget}};
    assert.equal((await request(`${url}/check`,{body})).status,400);
    assert.equal((await request(url,{method:'PUT',version:1,body})).status,400);
  }
  const initial=await request(url,{method:'PUT',version:1,body:{...layoutBody(layout,[r]),equipment}});
  assert.equal(initial.status,200);
  // Simulate incompatible persisted input, without relying on the normal save
  // command (which rejects this state). Candidates must still recheck it.
  const corrupt={...equipment,roomBudget:assumedRoomBudget({maxPowerKw:0})};
  await pool.query('UPDATE rack_plans SET equipment=$2 WHERE plan_id=$1',[layout.planId,JSON.stringify(corrupt)]);
  const options=await request(`${url}/options`,{user:'viewer',body:{contract_version:1,base_version:2,snapshot_id:layout.snapshot.snapshotId,options:{}}});
  assert.equal(options.status,200,JSON.stringify(options));
  assert.ok(options.body.data.candidates.length>0);
  for(const c of options.body.data.candidates) {
    assert.equal(c.canStage,false);
    assert.ok(c.equipmentReport.diagnostics.some(d=>d.code==='ROOM_BUDGET_EXCEEDED'));
  }
  assert.equal((await request(url)).body.data.version,2);
})));

test('Rack Assistant HTTP binds real plan scope and executes saved reads/checks/planner as a viewer without writing', {skip}, async()=>fixture(async f=>{
  const rig = rackAssistantRig();
  await server(f.people, async request => {
    const { url, layout } = await prepared(f, request);
    const r = rack(3,3,{name:'Assistant fixture rack'});
    const savedResponse = await request(url, { method:'PUT', version:1,
      body:{...layoutBody(layout,[r]),equipment:equipmentInput([testDevice(r.rackId,{weightKg:null})])} });
    assert.equal(savedResponse.status,200);
    const saved = savedResponse.body.data;
    const commands = async () => (await pool.query('SELECT count(*)::int n FROM rack_layout_commands WHERE plan_id=$1',[saved.planId])).rows[0].n;
    const before = await commands();
    const wire = (kind,patch={}) => ({ messages:[{role:'user',content:kind}], context_key:`${f.a.projectId}|rack|${saved.planId}`,
      context:{surface:'rack',projectId:f.a.projectId,scenarioId:f.a.scenarioId,revisionId:f.a.revisionId,
        rack_context:{planId:saved.planId,clientVersion:2,hasUnsavedDraft:false},...patch} });
    for (const kind of ['list','read','capacity','check','generate']) {
      const result = await request('/api/v1/assistant/chat',{user:'viewer',body:wire(kind)});
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal(result.body.data.status,'ok');
      const text = result.body.data.choices[0].message.content;
      if(kind==='capacity') { assert.match(text,/UNKNOWN/); assert.match(text,/freeU/); }
      if(kind==='check') { assert.match(text,/INCOMPLETE/); assert.match(text,/NOT_RUN/); }
      if(kind==='generate') { assert.match(text,/row-scan-v1/); assert.match(text,/inputFingerprint/); assert.doesNotMatch(text,/"body":/); }
    }
    assert.deepEqual((await request(url)).body.data,saved);
    assert.equal(await commands(),before);
    assert.ok(rig.providerCalls.every(q=>q.tools.every(t=>t.function.name.startsWith('rack_'))));
    const callsBefore=rig.providerCalls.length;
    assert.equal((await request('/api/v1/assistant/chat',{user:'outsider',body:wire('read')})).status,403);
    const foreign=await request(path(f.b),{user:'outsider',body:f.input(f.b)}); assert.equal(foreign.status,201);
    assert.equal((await request('/api/v1/assistant/chat',{user:'viewer',body:wire('read',{rack_context:{planId:foreign.body.data.planId}})})).status,404);
    assert.equal((await request('/api/v1/assistant/chat',{user:'viewer',body:wire('read',{rack_context:{planId:'bad'}})})).status,404);
    assert.equal(rig.providerCalls.length,callsBefore,'forbidden or foreign contexts never call the provider');
    const dirty=await request('/api/v1/assistant/chat',{user:'viewer',body:wire('generate',{rack_context:{planId:saved.planId,hasUnsavedDraft:true}})});
    assert.equal(dirty.status,200); assert.match(dirty.body.data.choices[0].message.content,/RACK_ASSISTANT_DIRTY_DRAFT/);
    await pool.query('UPDATE revision_etags SET etag=$1 WHERE project_id=$2',[randomUUID(),f.a.projectId]);
    const stale=await request('/api/v1/assistant/chat',{user:'viewer',body:wire('generate')});
    assert.equal(stale.status,200); assert.match(stale.body.data.choices[0].message.content,/RACK_SOURCE_STALE/);
    assert.equal(await commands(),before);
  },{assistant:rig.host});
}));

test('Rack Assistant canonical versions, missing selection and changed scope are refused before unsafe work', {skip}, async()=>fixture(async f=>{
  const rig=rackAssistantRig();
  await server(f.people,async request=>{
    const {url,layout}=await prepared(f,request);
    const context={surface:'rack',userId:f.people.viewer.userId,projectId:f.a.projectId,scenarioId:f.a.scenarioId,revisionId:f.a.revisionId,
      rackContext:{planId:layout.planId,clientVersion:1}};
    const resolved=await createAssistantScopeResolver({pool,authorize:rig.authorize})({context});
    assert.equal(resolved.rackContext.version,1); assert.equal(resolved.rackContext.clientVersion,1);
    const empty=await createAssistantScopeResolver({pool,authorize:rig.authorize})({context:{...context,rackContext:null}});
    assert.equal(empty.rackContext.planId,null);
    await assert.rejects(createAssistantScopeResolver({pool,authorize:rig.authorize})({context:{...context,rackContext:{planId:layout.planId,clientVersion:'1'}}}),e=>e.status===400);
    assert.equal((await request(url,{method:'PUT',version:1,body:layoutBody(layout,[rack()])})).status,200);
    const execution={workspaceId:f.a.projectId,scenarioId:f.a.scenarioId,revisionId:f.a.revisionId,
      initiatedBy:{userId:f.people.viewer.userId},requestId:randomUUID(),rackContext:resolved.rackContext};
    await assert.rejects(rig.surface.capabilities.find(c=>c.name==='rack_read_plan').handler(execution,{}),e=>e.status===412);
  });
}));
