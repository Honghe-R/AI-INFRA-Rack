import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createLogger, errors } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createRbacRepository, createEvaluator, createPermissionGuard, RACK_KEYS } from '@ai-infra/rbac';
import { createRouter } from '../router.js';
import { createApp } from '../app.js';
import { registerProjectAccessRoutes } from '../routes/project-access.js';
import { createProjectAccessService, normalizeProjectAccess } from '../services/project-access.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
let pool, repository;
before(() => { if (!skip) { pool = createPool({ connectionString: process.env.DATABASE_URL, max: 8 }); repository = createRbacRepository({ pool }); } });
after(async () => { await pool?.end(); });

test('member mutation rejects arbitrary roles, statuses, versions and server-owned scope fields', () => {
  const valid = { role_key: 'project-editor', status: 'ACTIVE', expected_version: null };
  assert.deepEqual(normalizeProjectAccess(valid), { roleKey: 'project-editor', status: 'ACTIVE', expectedVersion: null });
  for (const body of [null, [], { ...valid, role_key: 'system-admin' }, { ...valid, role_key: 'organisation-admin' },
    { ...valid, project_id: randomUUID() }, { ...valid, actor_id: randomUUID() }, { ...valid, status: 'DELETED' },
    { role_key: 'project-editor', status: 'ACTIVE' }, { ...valid, expected_version: 0 }, { ...valid, expected_version: '3' }]) {
    assert.throws(() => normalizeProjectAccess(body), { code: 'VALIDATION_FAILED' });
  }
});

async function fixture(fn) {
  const people = {}, projects = [], orgs = [];
  const suffix = randomUUID();
  let server;
  try {
    for (const key of ['owner', 'admin', 'admin2', 'editor', 'viewer', 'candidate', 'foreign', 'inactive']) {
      people[key] = await repository.createUser({ subject: `access-test-${key}-${suffix}`, email: `${key}-${suffix}@example.test`, displayName: `Access ${key}` });
    }
    const org = await repository.createOrganization({ name: `Access org ${suffix}`, ownerUserId: people.owner.userId }); orgs.push(org.organizationId);
    const other = await repository.createOrganization({ name: `Foreign org ${suffix}`, ownerUserId: people.foreign.userId }); orgs.push(other.organizationId);
    for (const [key, person] of Object.entries(people)) {
      if (key === 'foreign') continue;
      await pool.query(`INSERT INTO organization_memberships(organization_id,user_id,status) VALUES ($1,$2,'ACTIVE') ON CONFLICT DO NOTHING`, [org.organizationId, person.userId]);
    }
    for (const organizationId of orgs) {
      const projectId = randomUUID(); projects.push(projectId);
      await pool.query('INSERT INTO projects(project_id,organization_id,name) VALUES($1,$2,$3)', [projectId, organizationId, `Access project ${suffix}`]);
    }
    const projectId = projects[0];
    for (const [person, roleKey] of [['admin','project-admin'],['admin2','project-admin'],['editor','project-editor'],['viewer','project-viewer']]) {
      await repository.assignRole({ userId: people[person].userId, roleKey, scopeKind: 'project', scopeId: projectId });
    }
    await repository.assignRole({ userId: people.foreign.userId, roleKey: 'project-admin', scopeKind: 'project', scopeId: projects[1] });
    await repository.setUserStatus(people.inactive.userId, 'SUSPENDED');
    const evaluator = createEvaluator({ repository }), guard = createPermissionGuard({ evaluator, repository });
    const router = createRouter(); registerProjectAccessRoutes(router, { pool, evaluator });
    router.get('/api/v1/projects/:projectId/probe-write', () => ({ data: true }), { permission: RACK_KEYS.WRITE, projectParam: 'projectId' });
    router.get('/api/v1/projects/:projectId/probe-read', () => ({ data: true }), { permission: RACK_KEYS.READ, projectParam: 'projectId' });
    const authenticator = { async authenticate(ctx) {
      const person = people[ctx.headers['x-test-user']]; if (!person) throw errors.unauthorized(); ctx.user = { userId: person.userId };
    } };
    server = createServer(createApp({ router, pool, guard, authenticator, logger: createLogger({ level: 'error', sink: { log() {}, warn() {}, error() {} } }) }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, { user = 'admin', body } = {}) => {
      const response = await fetch(`${base}/api/v1/projects/${path}`, { method: body ? 'PUT' : 'GET',
        headers: { 'x-test-user': user, 'connection': 'close', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, payload: await response.json(), cache: response.headers.get('cache-control') };
    };
    const list = async () => (await request(`${projectId}/members`)).payload.data;
    const member = async key => (await list()).items.find(m => m.userId === people[key].userId);
    const update = async (key, role, status = 'ACTIVE', user = 'admin', version) => {
      const current = await member(key);
      return request(`${projectId}/members/${people[key].userId}`, { user, body: { role_key: role, status,
        expected_version: version === undefined ? current?.version ?? null : version } });
    };
    await fn({ projectId, foreignProject: projects[1], orgId: org.organizationId, people, request, member, list, update, evaluator });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const projectId of projects) {
      await pool.query("DELETE FROM role_assignments WHERE scope_kind='project' AND scope_id=$1", [projectId]);
      await pool.query('DELETE FROM projects WHERE project_id=$1', [projectId]);
    }
    for (const orgId of orgs) {
      await pool.query("DELETE FROM role_assignments WHERE scope_kind='organisation' AND scope_id=$1", [orgId]);
      await pool.query('DELETE FROM organizations WHERE organization_id=$1', [orgId]);
    }
    if (Object.keys(people).length) await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])', [Object.values(people).map(p => p.userId)]);
  }
}

test('member routes enforce authentication, manager role, foreign-project scope and no-store', { skip }, () => fixture(async f => {
  for (const user of ['viewer', 'editor', 'foreign', 'missing']) {
    for (const suffix of ['/members', '/member-candidates']) {
      const r = await f.request(`${f.projectId}${suffix}`, { user }); assert.equal(r.status, user === 'missing' ? 401 : 403); assert.equal(r.cache, 'no-store');
    }
    assert.equal((await f.update('candidate', 'project-viewer', 'ACTIVE', user)).status, user === 'missing' ? 401 : 403);
  }
  assert.equal((await f.request(`${f.foreignProject}/members`)).status, 403);
  for (const suffix of ['members','probe-read']) {
    assert.equal((await f.request(`${f.foreignProject}/${suffix}?organisationId=${f.orgId}`, { user: 'owner' })).status, 404);
  }
  assert.deepEqual((await repository.effectiveKeys({ userId: f.people.owner.userId, projectId: f.foreignProject, organisationId: f.orgId })).keys, []);
  const yes = await f.request(`${f.projectId}/members`); assert.equal(yes.status, 200); assert.equal(yes.cache, 'no-store');
  assert.equal(yes.payload.data.actorId, f.people.admin.userId);
}));

test('candidate search is organisation-scoped, active, bounded and literal', { skip }, () => fixture(async f => {
  const r = await f.request(`${f.projectId}/member-candidates`); assert.equal(r.status, 200);
  assert.ok(r.payload.data.items.some(m => m.userId === f.people.candidate.userId));
  for (const key of ['foreign','inactive','admin','viewer']) assert.ok(!r.payload.data.items.some(m => m.userId === f.people[key].userId));
  assert.equal((await f.request(`${f.projectId}/member-candidates?q=%25`)).payload.data.items.length, 0);
  for (const suffix of ['/members?limit=101','/members?offset=-1','/member-candidates?limit=21',`/member-candidates?q=${'a'.repeat(101)}`]) assert.equal((await f.request(f.projectId + suffix)).status, 400);
  const page = (await f.request(`${f.projectId}/members?limit=1`)).payload.data; assert.equal(page.items.length, 1); assert.equal(page.nextOffset, 1);
}));

test('adding, changing, suspending and reactivating a member updates grants and durable events', { skip }, () => fixture(async f => {
  const added = await f.update('candidate', 'project-viewer'); assert.equal(added.status, 200); assert.ok(added.payload.data.member.version > 0);
  assert.equal((await f.request(`${f.projectId}/probe-read`, { user: 'candidate' })).status, 200);
  assert.equal((await f.request(`${f.projectId}/probe-write`, { user: 'candidate' })).status, 403);
  assert.equal((await f.update('candidate','project-editor')).status, 200);
  assert.equal((await f.request(`${f.projectId}/probe-write`, { user: 'candidate' })).status, 200);
  const current = await f.member('candidate');
  assert.equal((await f.request(`${f.projectId}/members/${f.people.candidate.userId.toUpperCase()}`, { body: {
    role_key: 'project-viewer', status: 'ACTIVE', expected_version: current.version,
  } })).status, 200);
  assert.equal((await f.request(`${f.projectId}/probe-write`, { user: 'candidate' })).status, 403, 'Uppercase UUID spelling must invalidate the canonical user cache.');
  assert.equal((await f.update('candidate','project-editor')).status, 200);
  assert.equal((await f.update('candidate','project-editor','SUSPENDED')).status, 200);
  assert.equal((await f.request(`${f.projectId}/probe-read`, { user: 'candidate' })).status, 403);
  assert.equal((await f.update('candidate','project-editor')).status, 200);
  assert.equal((await f.request(`${f.projectId}/probe-write`, { user: 'candidate' })).status, 200);
  const events = (await f.list()).events; assert.equal(events.length, 6); assert.equal(events.at(-1).action, 'ADD');
  for (const event of events) { assert.equal(event.actorUserId, f.people.admin.userId); assert.ok(event.correlationId); assert.equal(event.targetUserId, f.people.candidate.userId); }
  assert.equal((await f.update('candidate','project-editor')).payload.data.changed, false);
  assert.equal((await f.list()).events.length, 6);
}));

test('foreign/inactive users, scope injection, unsupported roles and self changes are rejected without events', { skip }, () => fixture(async f => {
  for (const key of ['foreign','inactive']) assert.equal((await f.update(key,'project-viewer')).status, 400);
  assert.equal((await f.update('admin','project-viewer')).payload.error.code, 'PROJECT_ACCESS_SELF_CHANGE');
  const self = await f.member('admin');
  assert.equal((await f.request(`${f.projectId}/members/${f.people.admin.userId.toUpperCase()}`, { body: {
    role_key: 'project-viewer', status: 'ACTIVE', expected_version: self.version,
  } })).payload.error.code, 'PROJECT_ACCESS_SELF_CHANGE');
  for (const extra of [{ role_key: 'system-admin' }, { project_id: f.foreignProject }, { actor_id: f.people.owner.userId }, { status: 'DELETED' }]) {
    const r = await f.request(`${f.projectId}/members/${f.people.candidate.userId}`, { body: { role_key: 'project-viewer', status: 'ACTIVE', expected_version: null, ...extra } });
    assert.equal(r.status, 400);
  }
  assert.equal((await f.list()).events.length, 0); assert.equal(await f.member('candidate'), undefined);
}));

test('optimistic versions reject stale and concurrent updates without duplicate events', { skip }, () => fixture(async f => {
  const original = await f.member('editor');
  const results = await Promise.all([f.update('editor','project-viewer','ACTIVE','admin',original.version), f.update('editor','project-editor','SUSPENDED','admin2',original.version)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
  assert.equal((await f.list()).events.length, 1);
  assert.equal((await f.update('editor','project-admin','ACTIVE','admin',original.version)).payload.error.code, 'PROJECT_ACCESS_CONFLICT');
}));

test('last-administrator guard serializes concurrent demotions even for an organisation manager', { skip }, () => fixture(async f => {
  const one = await f.member('admin'), two = await f.member('admin2');
  const results = await Promise.all([f.update('admin','project-viewer','ACTIVE','owner',one.version), f.update('admin2','project-viewer','ACTIVE','owner',two.version)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
  assert.equal(results.find(r => r.status === 409).payload.error.code, 'PROJECT_LAST_ADMIN');
  const members = (await f.request(`${f.projectId}/members`, { user: 'owner' })).payload.data;
  assert.equal(members.items.filter(m => m.roleKey === 'project-admin' && m.status === 'ACTIVE').length, 1);
}));

test('inherited repository mutations advance versions including change-back ABA', { skip }, () => fixture(async f => {
  const original = await f.member('editor');
  for (const roleKey of ['project-viewer','project-editor']) await repository.assignRole({ userId: f.people.editor.userId, roleKey, scopeKind: 'project', scopeId: f.projectId });
  const current = await f.member('editor'); assert.ok(current.version > original.version); assert.equal(current.roleKey, original.roleKey);
  assert.equal((await f.update('editor','project-viewer','ACTIVE','admin',original.version)).status, 409);
  await repository.revokeAssignment({ userId: f.people.editor.userId, scopeKind: 'project', scopeId: f.projectId });
  assert.ok((await f.member('editor')).version > current.version);
}));

test('project suspension leaves an independent organisation grant effective', { skip }, () => fixture(async f => {
  await repository.assignRole({ userId: f.people.viewer.userId, roleKey: 'project-viewer', scopeKind: 'organisation', scopeId: f.orgId });
  assert.equal((await f.update('viewer','project-viewer','SUSPENDED')).status, 200);
  assert.equal((await f.request(`${f.projectId}/probe-read`, { user: 'viewer' })).status, 200);
  assert.equal((await f.request(`${f.projectId}/probe-write`, { user: 'viewer' })).status, 403);
}));

test('service rechecks actual manager grants even if invoked after a stale gateway decision', { skip }, () => fixture(async f => {
  const service = createProjectAccessService({ pool });
  assert.equal((await f.request(`${f.projectId}/members`, { user: 'admin2' })).status, 200);
  assert.equal((await f.update('admin2','project-viewer')).status, 200);
  const recorded = (await f.list()).events.length;
  await assert.rejects(() => service.set({ projectId: f.projectId, actorId: f.people.admin2.userId, userId: f.people.candidate.userId,
    body: { role_key: 'project-admin', status: 'ACTIVE', expected_version: null }, correlationId: randomUUID() }), { code: 'INSUFFICIENT_PERMISSION' });
  assert.equal(await f.member('candidate'), undefined); assert.equal((await f.list()).events.length, recorded);
}));

test('restricted database role cannot read another project access event or an unscoped event', { skip }, () => fixture(async f => {
  assert.equal((await f.update('candidate','project-viewer')).status, 200);
  const role = `rack_access_rls_${randomUUID().replaceAll('-', '')}`, client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON project_access_events TO ${role}`);
    await client.query(`SET LOCAL ROLE ${role}`);
    for (const [scope, count] of [['',0], [f.foreignProject,0], [f.projectId,1]]) {
      await client.query("SELECT set_config('app.project_id',$1,true)", [scope]);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM project_access_events')).rows[0].n, count);
    }
  } finally {
    // The temporary role and grants were created inside this transaction.
    await client.query('ROLLBACK'); client.release();
  }
}));

test('event insertion failure rolls back membership and assignment together', { skip }, () => fixture(async f => {
  const service = createProjectAccessService({ pool });
  await assert.rejects(() => service.set({ projectId: f.projectId, actorId: f.people.admin.userId, userId: f.people.candidate.userId,
    body: { role_key: 'project-editor', status: 'ACTIVE', expected_version: null }, correlationId: null }));
  assert.equal(await f.member('candidate'), undefined);
  assert.equal((await pool.query("SELECT 1 FROM role_assignments WHERE user_id=$1 AND scope_kind='project' AND scope_id=$2", [f.people.candidate.userId, f.projectId])).rowCount, 0);
  assert.equal((await f.list()).events.length, 0);
}));
