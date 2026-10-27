import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@ai-infra/db';
import {
  CATALOG,
  PLATFORM_KEYS as P,
  FACILITY_KEYS as F,
  ROLE_PRESETS,
  catalogKeys,
  createEvaluator,
  createRbacRepository,
} from '../index.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;
let repository;

before(() => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
  repository = createRbacRepository({ pool });
});

after(async () => {
  if (pool) await pool.end();
});

/** Creates an isolated user, organisation, and project, and returns a cleanup. */
async function fixture({ withMembership = false } = {}) {
  const subject = `test-${randomUUID()}`;
  const user = await repository.createUser({ subject, email: `${subject}@example.test`, displayName: 'Test User' });
  const organization = await repository.createOrganization({ name: `Org ${subject}`, ownerUserId: user.userId });
  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Test project',
  ]);

  return {
    user,
    organizationId: organization.organizationId,
    projectId,
    async cleanup() {
      // `role_assignments` is the one scoped table that is not cleaned by cascade:
      // `user_id` cascades, but `created_by` is NO ACTION, and `scope_kind`/`scope_id` are
      // not foreign keys at all. Deleting the organisation therefore leaves the grants
      // behind, and deleting the user who made them is then refused — which is how a shared
      // development database accumulates residue until unrelated tests start failing.
      await pool.query(
        `DELETE FROM role_assignments
          WHERE user_id = $1 OR created_by = $1
             OR (scope_kind = 'organisation' AND scope_id = $2)
             OR (scope_kind = 'project' AND scope_id = $3)`,
        [user.userId, organization.organizationId, projectId],
      );
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id = $1', [user.userId]);
    },
  };
}

test('the seeded catalog matches the code catalog exactly', { skip }, async () => {
  const { permissions } = await repository.listCatalog();
  assert.deepEqual(
    permissions.map((permission) => permission.key).sort(),
    catalogKeys(),
    'the permissions table has drifted from packages/rbac/src/catalog.js',
  );
  for (const permission of permissions) {
    const code = CATALOG.find((item) => item.key === permission.key);
    assert.equal(permission.scope, code.scope, `${permission.key} scope drifted`);
    assert.equal(permission.name, code.name, `${permission.key} name drifted`);
    assert.equal(permission.description, code.description, `${permission.key} description drifted`);
  }
});

test('the seeded roles match the role presets exactly', { skip }, async () => {
  const { roles } = await repository.listCatalog();
  const byKey = Object.fromEntries(roles.map((role) => [role.roleKey, role]));
  for (const [roleKey, preset] of Object.entries(ROLE_PRESETS)) {
    const seeded = byKey[roleKey];
    assert.ok(seeded, `role "${roleKey}" is not seeded`);
    assert.equal(seeded.scopeHint, preset.scopeHint);
    assert.equal(seeded.name, preset.name);
    assert.deepEqual(seeded.keys, [...preset.keys].sort(), `role "${roleKey}" key set drifted`);
  }
  assert.deepEqual(Object.keys(byKey).sort(), Object.keys(ROLE_PRESETS).sort());
});

test('re-declaring a user converges its name and never erases one', { skip }, async () => {
  const subject = `test-${randomUUID()}`;
  const created = await repository.createUser({ subject, email: `${subject}@example.test`, displayName: 'First Name' });
  try {
    // The seed re-runs against users that already exist, so a name it declares now has to
    // replace whatever a previous run wrote; a name that is only ever set on the insert
    // leaves the development identities named by a list that no longer exists.
    const renamed = await repository.createUser({ subject, displayName: 'Second Name' });
    assert.equal(renamed.userId, created.userId, 'the same user, not a second one');
    assert.equal(renamed.displayName, 'Second Name');
    assert.equal(renamed.email, `${subject}@example.test`, 'an omitted email is left alone');

    const unnamed = await repository.createUser({ subject });
    assert.equal(unnamed.displayName, 'Second Name', 'and an omitted name is left alone rather than nulled');
  } finally {
    await pool.query('DELETE FROM users WHERE user_id = $1', [created.userId]);
  }
});

test('an unknown permission key is denied, and a known one is not', { skip }, async () => {
  const f = await fixture();
  try {
    const evaluator = createEvaluator({ repository });
    assert.equal(await repository.resolveKey('facility.not.a.key'), null);
    assert.equal(await repository.resolveKey(F.READ).then((r) => r.key), F.READ);
    assert.equal((await evaluator.evaluate({ userId: f.user.userId, key: 'facility.not.a.key', projectId: f.projectId })).allowed, false);
  } finally {
    await f.cleanup();
  }
});

test('a project assignment grants at project scope and refuses beyond it', { skip }, async () => {
  const f = await fixture();
  try {
    await repository.assignRole({ userId: f.user.userId, roleKey: 'project-viewer', scopeKind: 'project', scopeId: f.projectId });
    const evaluator = createEvaluator({ repository });

    const read = await evaluator.evaluate({ userId: f.user.userId, key: F.READ, projectId: f.projectId });
    assert.equal(read.allowed, true);
    assert.equal(read.grant, 'project');

    const publish = await evaluator.evaluate({ userId: f.user.userId, key: F.PUBLISH, projectId: f.projectId });
    assert.equal(publish.allowed, false, 'a viewer must not publish');

    const unscoped = await evaluator.evaluate({ userId: f.user.userId, key: F.READ });
    assert.equal(unscoped.allowed, false, 'a scoped role must not satisfy an unscoped check');
  } finally {
    await f.cleanup();
  }
});

test('assignment replaces within a scope rather than stacking', { skip }, async () => {
  const f = await fixture();
  try {
    await repository.assignRole({ userId: f.user.userId, roleKey: 'project-viewer', scopeKind: 'project', scopeId: f.projectId });
    await repository.assignRole({ userId: f.user.userId, roleKey: 'project-editor', scopeKind: 'project', scopeId: f.projectId });

    const assignments = await repository.listUserAssignments(f.user.userId);
    const forProject = assignments.filter((a) => a.scopeKind === 'project' && a.scopeId === f.projectId);
    assert.equal(forProject.length, 1, 'one role per user per concrete scope');
    assert.equal(forProject[0].roleKey, 'project-editor');

    const evaluator = createEvaluator({ repository });
    const publish = await evaluator.evaluate({ userId: f.user.userId, key: F.PUBLISH, projectId: f.projectId });
    assert.equal(publish.allowed, false, 'an editor still cannot publish');
  } finally {
    await f.cleanup();
  }
});

test('suspending a membership subtracts permission without deleting the assignment', { skip }, async () => {
  const f = await fixture();
  try {
    await repository.assignRole({ userId: f.user.userId, roleKey: 'project-admin', scopeKind: 'project', scopeId: f.projectId });
    const evaluator = createEvaluator({ repository });
    assert.equal((await evaluator.evaluate({ userId: f.user.userId, key: F.PUBLISH, projectId: f.projectId })).allowed, true);

    await repository.setMembershipStatus({ scopeKind: 'project', scopeId: f.projectId, userId: f.user.userId, status: 'SUSPENDED' });
    evaluator.invalidate({ userId: f.user.userId, projectId: f.projectId });

    assert.equal((await evaluator.evaluate({ userId: f.user.userId, key: F.PUBLISH, projectId: f.projectId })).allowed, false);

    const assignments = await repository.listUserAssignments(f.user.userId);
    const projectAssignments = assignments.filter((a) => a.scopeKind === 'project' && a.scopeId === f.projectId);
    assert.equal(projectAssignments.length, 1, 'the assignment is retained so suspension is reversible');
  } finally {
    await f.cleanup();
  }
});

test('a suspended user account grants nothing even with an active membership', { skip }, async () => {
  const f = await fixture();
  try {
    await repository.assignRole({ userId: f.user.userId, roleKey: 'project-admin', scopeKind: 'project', scopeId: f.projectId });
    await repository.setUserStatus(f.user.userId, 'SUSPENDED');
    const evaluator = createEvaluator({ repository });
    const decision = await evaluator.evaluate({ userId: f.user.userId, key: F.PUBLISH, projectId: f.projectId });
    assert.equal(decision.allowed, false);
  } finally {
    await f.cleanup();
  }
});

test('an organisation role grants through the owning project', { skip }, async () => {
  const f = await fixture();
  try {
    await repository.assignRole({ userId: f.user.userId, roleKey: 'organisation-admin', scopeKind: 'organisation', scopeId: f.organizationId });
    const evaluator = createEvaluator({ repository });
    const decision = await evaluator.evaluate({ userId: f.user.userId, key: F.READ, projectId: f.projectId });
    assert.equal(decision.allowed, true);
    assert.equal(decision.grant, 'organisation');
    assert.equal(decision.organisationId, f.organizationId);
  } finally {
    await f.cleanup();
  }
});

test('a brand-new account can bootstrap an organisation and loses that key afterwards', { skip }, async () => {
  const subject = `test-${randomUUID()}`;
  const user = await repository.createUser({ subject });
  try {
    const evaluator = createEvaluator({ repository });
    assert.equal(await repository.countMemberships(user.userId), 0);
    const before = await evaluator.evaluate({ userId: user.userId, key: P.ORGANISATION_CREATE });
    assert.equal(before.allowed, true);
    assert.equal(before.grant, 'onboarding');

    const organization = await repository.createOrganization({ name: `Org ${subject}`, ownerUserId: user.userId });
    evaluator.invalidate({ userId: user.userId });

    const after = await evaluator.evaluate({ userId: user.userId, key: P.ORGANISATION_CREATE });
    assert.equal(after.allowed, false, 'onboarding applies only with zero memberships');

    await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
  } finally {
    await pool.query('DELETE FROM users WHERE user_id = $1', [user.userId]);
  }
});

test('replacing a role mapping refuses an unknown key and changes nothing', { skip }, async () => {
  const { roles } = await repository.listCatalog();
  const before = roles.find((role) => role.roleKey === 'project-viewer');

  await assert.rejects(
    () => repository.replaceRolePermissions({ roleKey: 'project-viewer', keys: [...before.keys, 'facility.not.a.key'] }),
    /Unknown permission keys/,
  );

  const after = (await repository.listCatalog()).roles.find((role) => role.roleKey === 'project-viewer');
  assert.deepEqual(after.keys, before.keys, 'a refused replacement must leave the mapping unchanged');
});

test('replacing a role mapping is transactional and takes effect', { skip }, async () => {
  const original = (await repository.listCatalog()).roles.find((role) => role.roleKey === 'project-viewer');
  try {
    await repository.replaceRolePermissions({ roleKey: 'project-viewer', keys: [F.READ] });
    const updated = (await repository.listCatalog()).roles.find((role) => role.roleKey === 'project-viewer');
    assert.deepEqual(updated.keys, [F.READ]);
  } finally {
    await repository.replaceRolePermissions({ roleKey: 'project-viewer', keys: original.keys });
  }
});

test('applying a preset is idempotent and never removes a key', { skip }, async () => {
  const first = await repository.applyPreset({ roleKey: 'project-viewer' });
  const second = await repository.applyPreset({ roleKey: 'project-viewer' });
  assert.equal(second.added, 0, 'a second application must add nothing');
  assert.ok(first.added >= 0);

  const role = (await repository.listCatalog()).roles.find((r) => r.roleKey === 'project-viewer');
  assert.deepEqual(role.keys, [...ROLE_PRESETS['project-viewer'].keys].sort());
});

test('effective keys union the matched scopes', { skip }, async () => {
  const f = await fixture();
  try {
    await repository.assignRole({ userId: f.user.userId, roleKey: 'project-viewer', scopeKind: 'project', scopeId: f.projectId });

    const effective = await repository.effectiveKeys({ userId: f.user.userId, projectId: f.projectId });
    assert.ok(effective.keys.includes(F.READ));
    assert.ok(!effective.keys.includes(F.PUBLISH));
    assert.equal(effective.organisationId, f.organizationId, 'the owning organisation is derived');
  } finally {
    await f.cleanup();
  }
});
