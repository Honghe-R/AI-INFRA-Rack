import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FACILITY_KEYS as F,
  PLATFORM_KEYS as P,
  REASON,
  catalogKeys,
  createEvaluator,
  getCatalogEntry,
} from '../index.js';

/**
 * A fake repository implementing the evaluator's port. Assignments carry an
 * `active` flag standing in for membership status: `grantedKeys` must exclude
 * inactive ones, which is how suspension removes permission (porting decision R2).
 */
function fakeRepository({ projects = {}, memberships = {}, keys = null, gate = null } = {}) {
  const assignments = [];
  const known = new Set(keys ?? catalogKeys());
  const calls = { resolveKey: 0, grantedKeys: 0, getProject: 0, countMemberships: 0 };
  let release = null;
  const gatePromise = gate ? new Promise((resolve) => { release = resolve; }) : null;

  return {
    calls,
    release: () => release?.(),
    assign(assignment) {
      assignments.push({ scopeId: null, active: true, ...assignment });
      return this;
    },
    register(key) {
      known.add(key);
      return this;
    },
    async resolveKey(key) {
      calls.resolveKey += 1;
      if (!known.has(key)) return null;
      return { id: `id:${key}`, key, scope: getCatalogEntry(key)?.scope ?? 'project' };
    },
    async grantedKeys({ userId, scopeKind, scopeId }) {
      calls.grantedKeys += 1;
      if (gatePromise) await gatePromise;
      const rows = assignments.filter(
        (a) => a.userId === userId && a.scopeKind === scopeKind && (a.scopeId ?? null) === (scopeId ?? null) && a.active !== false,
      );
      return new Set(rows.flatMap((row) => row.keys));
    },
    async getProject(projectId) {
      calls.getProject += 1;
      if (projectId === 'explodes') throw new Error('database unavailable');
      return projects[projectId] ?? null;
    },
    async countMemberships(userId) {
      calls.countMemberships += 1;
      return memberships[userId] ?? 0;
    },
  };
}

const PROJECT = 'p-1';
const ORG = 'o-1';
const USER = 'u-1';

function setup(overrides = {}) {
  const repository = fakeRepository({
    projects: { [PROJECT]: { projectId: PROJECT, organisationId: ORG, showcase: false } },
    ...overrides,
  });
  return { repository, evaluator: createEvaluator({ repository }) };
}

test('rejects an empty user or key', async () => {
  const { evaluator } = setup();
  assert.equal((await evaluator.evaluate({ key: F.READ })).reason, REASON.UNAUTHENTICATED);
  assert.equal((await evaluator.evaluate({ userId: USER })).reason, REASON.FUNCTION_REQUIRED);
});

test('denies an unregistered key rather than allowing it', async () => {
  const { evaluator } = setup();
  const decision = await evaluator.evaluate({ userId: USER, key: 'facility.read.typo', projectId: PROJECT });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, REASON.UNKNOWN_FUNCTION);
});

test('a project role grants at project scope', async () => {
  const { repository, evaluator } = setup();
  repository.assign({ userId: USER, scopeKind: 'project', scopeId: PROJECT, keys: [F.READ] });
  const decision = await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  assert.equal(decision.allowed, true);
  assert.equal(decision.grant, 'project');
  assert.equal(decision.projectId, PROJECT);
});

test('an organisation role satisfies a project check through the owning organisation', async () => {
  const { repository, evaluator } = setup();
  repository.assign({ userId: USER, scopeKind: 'organisation', scopeId: ORG, keys: [F.READ] });
  const decision = await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  assert.equal(decision.allowed, true);
  assert.equal(decision.grant, 'organisation');
  assert.equal(decision.organisationId, ORG, 'the owning organisation is derived from the project');
});

test('a global role satisfies a scoped check', async () => {
  const { repository, evaluator } = setup();
  repository.assign({ userId: USER, scopeKind: 'global', keys: [F.READ] });
  const decision = await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  assert.equal(decision.allowed, true);
  assert.equal(decision.grant, 'global');
});

test('a scoped role never satisfies an unscoped check', async () => {
  const { repository, evaluator } = setup();
  repository.assign({ userId: USER, scopeKind: 'project', scopeId: PROJECT, keys: [F.READ] });
  const decision = await evaluator.evaluate({ userId: USER, key: F.READ });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, REASON.INSUFFICIENT_PERMISSION);
});

test('system keys ignore scope, so no scoped role can grant them', async () => {
  const { repository, evaluator } = setup();
  repository.assign({ userId: USER, scopeKind: 'project', scopeId: PROJECT, keys: [P.SYSTEM_ADMIN] });
  repository.assign({ userId: USER, scopeKind: 'organisation', scopeId: ORG, keys: [P.SYSTEM_ADMIN] });

  const scoped = await evaluator.evaluate({ userId: USER, key: P.SYSTEM_ADMIN, projectId: PROJECT, organisationId: ORG });
  assert.equal(scoped.allowed, false, 'a scoped role must not grant a system key');
  assert.equal(scoped.projectId, null);
  assert.equal(scoped.organisationId, null);

  repository.assign({ userId: USER, scopeKind: 'global', keys: [P.SYSTEM_ADMIN] });
  // Granting requires a matching invalidation, or the cached denial stands.
  evaluator.invalidate({ userId: USER });
  const global = await evaluator.evaluate({ userId: USER, key: P.SYSTEM_ADMIN, projectId: PROJECT, organisationId: ORG });
  assert.equal(global.allowed, true);
  assert.equal(global.grant, 'global');
});

test('a suspended membership grants nothing', async () => {
  const { repository, evaluator } = setup();
  repository.assign({ userId: USER, scopeKind: 'project', scopeId: PROJECT, keys: [F.READ, F.PUBLISH], active: false });
  const read = await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  assert.equal(read.allowed, false, 'suspension must subtract permission');
});

test('an unknown project scope fails closed', async () => {
  const { evaluator } = setup();
  const decision = await evaluator.evaluate({ userId: USER, key: F.READ, projectId: 'missing' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, REASON.INSUFFICIENT_PERMISSION);
});

test('onboarding grants only with zero memberships', async () => {
  const fresh = setup({ memberships: { [USER]: 0 } });
  const granted = await fresh.evaluator.evaluate({ userId: USER, key: P.ORGANISATION_CREATE });
  assert.equal(granted.allowed, true);
  assert.equal(granted.grant, 'onboarding');

  const existing = setup({ memberships: { [USER]: 2 } });
  const denied = await existing.evaluator.evaluate({ userId: USER, key: P.ORGANISATION_CREATE });
  assert.equal(denied.allowed, false);
});

test('showcase allows the fixed read set read-only and nothing else', async () => {
  const { evaluator } = setup({
    projects: { [PROJECT]: { projectId: PROJECT, organisationId: ORG, showcase: true } },
  });

  const read = await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  assert.equal(read.allowed, true);
  assert.equal(read.grant, 'showcase');
  assert.equal(read.readOnly, true);
  assert.equal(read.showcase, true);

  const publish = await evaluator.evaluate({ userId: USER, key: F.PUBLISH, projectId: PROJECT });
  assert.equal(publish.allowed, false, 'showcase must never expose a write key');
});

test('an evaluator exception denies and is logged, never allowed', async () => {
  const logged = [];
  const repository = fakeRepository({});
  const evaluator = createEvaluator({ repository, logger: { error: (...args) => logged.push(args) } });
  const decision = await evaluator.evaluate({ userId: USER, key: F.READ, projectId: 'explodes' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.evaluationError, true, 'an infrastructure failure must be distinguishable from a denial');
  assert.equal(logged.length, 1, 'a fail-closed denial must be logged loudly');
});

test('decisions are cached and invalidated by tag', async () => {
  const { repository, evaluator } = setup();
  repository.assign({ userId: USER, scopeKind: 'project', scopeId: PROJECT, keys: [F.READ] });

  await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  const afterFirst = repository.calls.grantedKeys;
  await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  assert.equal(repository.calls.grantedKeys, afterFirst, 'a repeated decision must hit the cache');

  evaluator.invalidate({ userId: USER });
  await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  assert.ok(repository.calls.grantedKeys > afterFirst, 'invalidating by user must force a reload');
});

test('concurrent identical decisions share one load', async () => {
  const repository = fakeRepository({
    projects: { [PROJECT]: { projectId: PROJECT, organisationId: ORG, showcase: false } },
    gate: true,
  });
  const evaluator = createEvaluator({ repository });
  repository.assign({ userId: USER, scopeKind: 'project', scopeId: PROJECT, keys: [F.READ] });

  const pending = Promise.all([
    evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT }),
    evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT }),
    evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT }),
  ]);
  repository.release();
  const results = await pending;
  assert.ok(results.every((r) => r.allowed));
  assert.equal(repository.calls.grantedKeys, 1, 'in-flight decisions must be de-duplicated');
});

test('key resolution is not negatively cached', async () => {
  const { repository, evaluator } = setup();
  const before = await evaluator.evaluate({ userId: USER, key: 'facility.future.key', projectId: PROJECT });
  assert.equal(before.reason, REASON.UNKNOWN_FUNCTION);

  repository.register('facility.future.key');
  repository.assign({ userId: USER, scopeKind: 'project', scopeId: PROJECT, keys: ['facility.future.key'] });
  const after = await evaluator.evaluate({ userId: USER, key: 'facility.future.key', projectId: PROJECT });
  assert.equal(after.allowed, true, 'a newly registered key must not stay unknown');
});

test('invalidating the catalog clears resolved key ids', async () => {
  const { repository, evaluator } = setup();
  await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  const afterFirst = repository.calls.resolveKey;
  await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  assert.equal(repository.calls.resolveKey, afterFirst, 'key ids are cached');

  evaluator.invalidateCatalog();
  await evaluator.evaluate({ userId: USER, key: F.READ, projectId: PROJECT });
  assert.ok(repository.calls.resolveKey > afterFirst, 'a catalog change must re-resolve keys');
});
