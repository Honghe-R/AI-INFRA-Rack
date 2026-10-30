import test from 'node:test';
import assert from 'node:assert/strict';
import { FACILITY_KEYS as F, PLATFORM_KEYS as P, createPermissionGuard } from '../index.js';

const PROJECT = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const USER = { userId: 'u-1' };

function evaluatorReturning(map = {}) {
  return {
    calls: [],
    async evaluate(args) {
      this.calls.push(args);
      const entry = map[args.key];
      if (entry === 'throw') throw new Error('evaluator exploded');
      if (entry === 'evaluation-error') {
        return { allowed: false, grant: null, functionId: null, reason: 'INSUFFICIENT_PERMISSION', evaluationError: true };
      }
      if (entry === true) return { allowed: true, grant: 'project', functionId: 'id', projectId: args.projectId ?? null, organisationId: args.organisationId ?? null };
      return {
        allowed: false,
        grant: null,
        functionId: 'id',
        reason: entry ?? 'INSUFFICIENT_PERMISSION',
        projectId: args.projectId ?? null,
        organisationId: args.organisationId ?? null,
      };
    },
  };
}

const repository = {
  async getProject(id) {
    return id === PROJECT ? { projectId: PROJECT, organisationId: ORG, showcase: false } : null;
  },
  async getOrganization(id) {
    return id === ORG ? { organisationId: ORG } : null;
  },
};

async function expectError(fn) {
  try {
    await fn();
    assert.fail('expected an error');
  } catch (error) {
    return error;
  }
}

function guardFor(map) {
  const evaluator = evaluatorReturning(map);
  return { evaluator, guard: createPermissionGuard({ evaluator, repository }) };
}

test('a missing user is 401, not 403', async () => {
  const { guard } = guardFor();
  const error = await expectError(() => guard.check(F.READ, {}));
  assert.equal(error.status, 401);
  assert.equal(error.code, 'UNAUTHENTICATED');
});

test('a missing permission key is refused', async () => {
  const { guard } = guardFor();
  const error = await expectError(() => guard.check(null, { user: USER }));
  assert.equal(error.status, 403);
  assert.equal(error.code, 'FUNCTION_REQUIRED');
  assert.equal(error.details[0].allowed, false);
});

test('an allowed check returns the decision with the grant reason', async () => {
  const { guard } = guardFor({ [F.READ]: true });
  const result = await guard.check(F.READ, { user: USER, params: { projectId: PROJECT } });
  assert.equal(result.allowed, true);
  assert.equal(result.grant, 'project');
  assert.equal(result.functionKey, F.READ);
});

test('body/query organisation identifiers cannot redirect a project authorization scope', async () => {
  const other = '33333333-3333-3333-3333-333333333333';
  for (const source of ['body', 'query']) {
    const { guard, evaluator } = guardFor({ [F.READ]: true });
    await assert.rejects(() => guard.check(F.READ, { user: USER, params: { projectId: PROJECT }, [source]: { organisationId: other } }), { status: 404 });
    assert.equal(evaluator.calls.length, 0);
  }
});

test('a denial is 403 with a machine-readable body', async () => {
  const { guard } = guardFor();
  const error = await expectError(() => guard.check(F.PUBLISH, { user: USER, params: { projectId: PROJECT } }));
  assert.equal(error.status, 403);
  assert.equal(error.code, 'INSUFFICIENT_PERMISSION');
  assert.deepEqual(error.details, [{ allowed: false, function_key: F.PUBLISH }]);
});

test('an unknown key is reported as such, not as insufficient permission', async () => {
  const { guard } = guardFor({ [F.READ]: 'UNKNOWN_FUNCTION' });
  const error = await expectError(() => guard.check(F.READ, { user: USER, params: { projectId: PROJECT } }));
  assert.equal(error.status, 403);
  assert.equal(error.code, 'UNKNOWN_FUNCTION');
});

test('scope precedence is params, then body, then query', async () => {
  const { evaluator, guard } = guardFor({ [F.READ]: true });
  const otherProject = '33333333-3333-3333-3333-333333333333';

  await expectError(() =>
    guard.check(F.READ, { user: USER, params: { projectId: PROJECT }, body: { projectId: otherProject }, query: { projectId: otherProject } }),
  ).catch(() => {});
  assert.equal(evaluator.calls.at(-1).projectId, PROJECT, 'params win');

  await guard.check(F.READ, { user: USER, body: { projectId: PROJECT }, query: { projectId: otherProject } });
  assert.equal(evaluator.calls.at(-1).projectId, PROJECT, 'body beats query');

  await guard.check(F.READ, { user: USER, query: { projectId: PROJECT } });
  assert.equal(evaluator.calls.at(-1).projectId, PROJECT, 'query is last');
});

test('an unresolvable project is 404, never a silent null scope', async () => {
  const { evaluator, guard } = guardFor({ [F.READ]: true });
  const error = await expectError(() => guard.check(F.READ, { user: USER, params: { projectId: '99999999-9999-9999-9999-999999999999' } }));
  assert.equal(error.status, 404);
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(evaluator.calls.length, 0, 'evaluation must not run on an unresolved scope');
});

test('a malformed project identifier is 404', async () => {
  const { guard } = guardFor({ [F.READ]: true });
  const error = await expectError(() => guard.check(F.READ, { user: USER, params: { projectId: 'not-a-uuid' } }));
  assert.equal(error.status, 404);
});

test('an unresolvable organisation is 404', async () => {
  const { guard } = guardFor({ [F.READ]: true });
  const error = await expectError(() => guard.check(F.READ, { user: USER, params: { organisationId: '99999999-9999-9999-9999-999999999999' } }));
  assert.equal(error.status, 404);
});

test('the owning organisation is derived from the project', async () => {
  const { evaluator, guard } = guardFor({ [F.READ]: true });
  await guard.check(F.READ, { user: USER, params: { projectId: PROJECT } });
  assert.equal(evaluator.calls.at(-1).organisationId, ORG);
});

test('a system key ignores scope and does not resolve it', async () => {
  const { evaluator, guard } = guardFor({ [P.SYSTEM_ADMIN]: true });
  const result = await guard.check(P.SYSTEM_ADMIN, {
    user: USER,
    params: { projectId: '99999999-9999-9999-9999-999999999999' },
  });
  assert.equal(result.allowed, true, 'a bogus scope must not break a system-key check');
  assert.equal(evaluator.calls.at(-1).projectId, null);
  assert.equal(evaluator.calls.at(-1).organisationId, null);
});

test('an evaluator exception becomes 500, never an unhandled crash', async () => {
  const { guard } = guardFor({ [F.READ]: 'throw' });
  const error = await expectError(() => guard.check(F.READ, { user: USER, params: { projectId: PROJECT } }));
  assert.equal(error.status, 500);
  assert.equal(error.code, 'INTERNAL_ERROR');
});

test('a fail-closed evaluation failure is reported as 500, not as a denial', async () => {
  const { guard } = guardFor({ [F.READ]: 'evaluation-error' });
  const error = await expectError(() => guard.check(F.READ, { user: USER, params: { projectId: PROJECT } }));
  assert.equal(error.status, 500, 'an outage must not masquerade as a policy decision');
});

test('the guard works without a repository for unscoped checks', async () => {
  const evaluator = evaluatorReturning({ [P.ORGANISATION_CREATE]: true });
  const guard = createPermissionGuard({ evaluator });
  const result = await guard.check(P.ORGANISATION_CREATE, { user: USER });
  assert.equal(result.allowed, true);
});

test('require() returns a reusable middleware', async () => {
  const { guard } = guardFor({ [F.READ]: true });
  const middleware = guard.require(F.READ, { projectParam: 'id' });
  const result = await middleware({ user: USER, params: { id: PROJECT } });
  assert.equal(result.allowed, true);
  assert.equal(result.functionKey, F.READ);
});
