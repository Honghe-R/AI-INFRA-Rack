import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectMemberList, RackAccessSummary, projectMemberIntent } from '../rack/ProjectAccess.jsx';
import { RackPlanActions } from '../rack/RackPlanActions.jsx';
import { createApiClient } from '../api/client.js';

test('editor can rename but cannot delete or restore plans; lifecycle grants are independent', () => {
  const plan = { name: 'Example', placements: [] };
  const editor = renderToStaticMarkup(<RackPlanActions plan={plan} canWrite />);
  assert.match(editor, /Rename plan/); assert.doesNotMatch(editor, /Delete plan|Restore plan/);
  assert.equal(renderToStaticMarkup(<RackPlanActions plan={plan} canWrite={false} />), '');
  const recovery = renderToStaticMarkup(<RackPlanActions plan={{ ...plan, deletedAt: 'today' }} canRestore />);
  assert.match(recovery, /Restore plan/); assert.doesNotMatch(recovery, /Delete plan|Rename plan/);
  const lost = renderToStaticMarkup(<RackPlanActions plan={plan} canWrite attempt={{ operation: 'delete' }} />);
  assert.match(lost, /access no longer permits/); assert.match(lost, /disabled=""[^>]*>Retry original operation/);
});

test('capability summary reflects keys without guessing a role or granting hidden privileges', () => {
  const pending = renderToStaticMarkup(<RackAccessSummary pending />);
  assert.match(pending, /Checking your project capabilities/); assert.doesNotMatch(pending, /Read only/);
  const viewer = renderToStaticMarkup(<RackAccessSummary />);
  assert.match(viewer, /Read only/); assert.doesNotMatch(viewer, /Edit and save|Delete plans|Manage project access/);
  const admin = renderToStaticMarkup(<RackAccessSummary canWrite canDelete canRestore canManage />);
  for (const text of ['Edit and save', 'Delete plans', 'Restore plans', 'Manage project access']) assert.ok(admin.includes(text));
});

test('member list prevents self and inactive-account edits and escapes account text', () => {
  const items = [
    { userId: 'self', displayName: 'Administrator', roleKey: 'project-admin', status: 'ACTIVE', version: 2, accountStatus: 'ACTIVE', organisationActive: true },
    { userId: 'other', displayName: '<script>bad</script>', roleKey: 'project-viewer', status: 'ACTIVE', version: 3, accountStatus: 'ACTIVE', organisationActive: true },
    { userId: 'inactive', roleKey: 'project-editor', status: 'SUSPENDED', version: 5, accountStatus: 'SUSPENDED', organisationActive: false },
  ];
  const html = renderToStaticMarkup(<ProjectMemberList data={{ actorId: 'self', items }} />);
  assert.match(html, /Ask another administrator/); assert.match(html, /&lt;script&gt;/);
  assert.equal((html.match(/ disabled=""/g) || []).length, 2);
  assert.match(html, /Organisation membership inactive/);
});

test('member commands carry exact versions and reject unsupported role/status choices', () => {
  assert.deepEqual(projectMemberIntent(null, 'project-viewer', 'ACTIVE'), { role_key: 'project-viewer', status: 'ACTIVE', expected_version: null });
  assert.equal(projectMemberIntent({ version: 7 }, 'project-editor', 'SUSPENDED').expected_version, 7);
  for (const role of ['system-admin', 'organisation-admin', '__proto__', 'unknown']) assert.throws(() => projectMemberIntent(null, role, 'ACTIVE'));
  assert.throws(() => projectMemberIntent(null, 'project-viewer', 'DELETED'));
});

test('project access HTTP client scopes paths, disables caching and carries the active identity', async () => {
  const calls = [];
  const client = createApiClient({ identity: () => 'dev-editor', fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return { ok: true, async json() { return { data: {} }; } };
  } });
  await client.listProjectMembers('p', { offset: 20 });
  await client.findProjectMemberCandidates('p', 'A & B');
  await client.setProjectMember('p', 'u', projectMemberIntent({ version: 3 }, 'project-editor', 'ACTIVE'));
  assert.equal(calls[0].url, '/api/v1/projects/p/members?offset=20&limit=20');
  assert.match(calls[1].url, /q=A%20%26%20B/);
  for (const c of calls) { assert.equal(c.cache, 'no-store'); assert.equal(c.headers['x-dev-subject'], 'dev-editor'); }
  assert.equal(calls[2].method, 'PUT'); assert.equal(JSON.parse(calls[2].body).expected_version, 3);
});
