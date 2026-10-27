import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLogger } from '@ai-infra/core';
import { createAuthenticator } from '@ai-infra/identity';
import {
  FACILITY_KEYS as F,
  PLATFORM_KEYS as P,
  createEvaluator,
  createPermissionGuard,
  getCatalogEntry,
  isKnownKey,
} from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerAdminRoutes } from '../routes/admin.js';
import { registerSelfRoutes } from '../routes/me.js';

const USER = 'u-1';
const OTHER = 'u-2';
const PROJECT = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const MISSING_ORG = '99999999-9999-9999-9999-999999999999';

function build({ grants = [] } = {}) {
  const repository = {
    async resolveKey(key) {
      return isKnownKey(key) ? { id: key, key, scope: getCatalogEntry(key).scope } : null;
    },
    async grantedKeys({ userId, scopeKind, scopeId }) {
      return new Set(
        grants
          .filter((g) => g.userId === userId && g.scopeKind === scopeKind && (g.scopeId ?? null) === (scopeId ?? null))
          .flatMap((g) => g.keys),
      );
    },
    async getProject(projectId) {
      return projectId === PROJECT ? { projectId: PROJECT, organisationId: ORG, showcase: false } : null;
    },
    async getOrganization(organisationId) {
      return organisationId === ORG ? { organisationId: ORG } : null;
    },
    async countMemberships() {
      return 1;
    },
    async effectiveKeys() {
      return { keys: [F.READ], organisationId: ORG };
    },
    async listCatalog() {
      return { permissions: [], roles: [{ roleKey: 'project-viewer', keys: [F.READ] }] };
    },
    async replaceRolePermissions() {
      return { roleKey: 'project-viewer', keys: [F.READ] };
    },
    async assignRole(args) {
      assignments.push(args);
      return { assignmentId: 'a-1', ...args };
    },
    async revokeAssignment() {
      return { revoked: 1 };
    },
    async listUserAssignments() {
      return [];
    },
    async listMemberships() {
      return [];
    },
    async createOrganization({ name }) {
      return { organizationId: ORG, name };
    },
  };

  const assignments = [];
  const evaluator = createEvaluator({ repository });
  const guard = createPermissionGuard({ evaluator, repository });
  const verifier = {
    async verify(token) {
      if (token === 'good') return { subject: 's-1', mfa: false, authenticatedAt: null };
      throw Object.assign(new Error('bad token'), { code: 'ERR_JWT_INVALID' });
    },
  };
  const directory = {
    async resolveUser() {
      return { user: { userId: USER, status: 'ACTIVE' } };
    },
  };
  const authenticator = createAuthenticator({ verifier, directory });

  const router = createRouter();
  registerSelfRoutes(router, { repository, guard });
  registerAdminRoutes(router, { repository, evaluator });

  return { router, authenticator, guard, assignments, repository };
}

async function withServer(fn, options = {}) {
  const built = build(options);
  const logger = createLogger({ service: 'test', sink: { log() {}, warn() {}, error() {} }, level: 'error' });
  const app = createApp({ config: {}, logger, router: built.router, authenticator: built.authenticator, guard: built.guard });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, ...built });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a protected route without a token is 401', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/v1/me/permissions`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
  });
});

test('an invalid token is 403, not 401', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/v1/me/permissions`, { headers: { authorization: 'Bearer bad' } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'INVALID_TOKEN');
  });
});

test('the self endpoint returns the effective keys', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/v1/me/permissions`, { headers: { authorization: 'Bearer good' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.keys, [F.READ]);
    assert.equal(body.data.organisation_id, ORG);
  });
});

test('the check endpoint answers 200 for an allowed key', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/v1/me/permissions/check?function_key=${F.READ}&project_id=${PROJECT}`, {
      headers: { authorization: 'Bearer good' },
    });
    assert.equal(response.status, 200);
  }, { grants: [{ userId: USER, scopeKind: 'project', scopeId: PROJECT, keys: [F.READ] }] });
});

test('the check endpoint answers 200 with allowed:false for a denial', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/v1/me/permissions/check?function_key=${F.PUBLISH}&project_id=${PROJECT}`, {
      headers: { authorization: 'Bearer good' },
    });
    assert.equal(response.status, 200, 'a denial is a decision, not a transport failure');
    const body = await response.json();
    assert.equal(body.data.allowed, false);
    assert.equal(body.data.reason, 'INSUFFICIENT_PERMISSION');
    assert.equal(body.data.functionKey, F.PUBLISH);
    assert.equal(body.data.determined, true);
  });
});

test('the check endpoint reports an unknown key without a transport error', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/v1/me/permissions/check?function_key=facility.nope`, {
      headers: { authorization: 'Bearer good' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.reason, 'UNKNOWN_FUNCTION');
  });
});

test('an unresolvable scope is still a protocol error on the check endpoint', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/v1/me/permissions/check?function_key=${F.READ}&project_id=${MISSING_ORG}`, {
      headers: { authorization: 'Bearer good' },
    });
    assert.equal(response.status, 404, 'non-200 is reserved for protocol errors');
  });
});

test('a system administration route refuses a caller without the system key', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/v1/admin/catalog`, { headers: { authorization: 'Bearer good' } });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, 'INSUFFICIENT_PERMISSION');
    assert.deepEqual(body.error.details, [{ allowed: false, function_key: P.SYSTEM_ADMIN }]);
  });
});

test('a system administration route allows a caller holding the system key', async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/api/v1/admin/catalog`, { headers: { authorization: 'Bearer good' } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.roles[0].roleKey, 'project-viewer');
    },
    { grants: [{ userId: USER, scopeKind: 'global', keys: [P.SYSTEM_ADMIN] }] },
  );
});

test('a scoped role cannot reach a scope-nulled system route', async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/api/v1/admin/catalog`, { headers: { authorization: 'Bearer good' } });
      assert.equal(response.status, 403, 'a project role must never grant a system key');
    },
    { grants: [{ userId: USER, scopeKind: 'project', scopeId: PROJECT, keys: [P.SYSTEM_ADMIN] }] },
  );
});

test('the organisation route takes its scope from the request body', async () => {
  await withServer(
    async ({ base, assignments }) => {
      const response = await fetch(`${base}/api/v1/organisations/members/role`, {
        method: 'POST',
        headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: OTHER, role_key: 'project-viewer', organisation_id: ORG }),
      });
      assert.equal(response.status, 201);
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0].scopeKind, 'organisation');
      assert.equal(assignments[0].scopeId, ORG);
    },
    { grants: [{ userId: USER, scopeKind: 'organisation', scopeId: ORG, keys: [P.ORG_ADMIN] }] },
  );
});

test('the organisation route rejects a scope the caller cannot resolve', async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/api/v1/organisations/members/role`, {
        method: 'POST',
        headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: OTHER, role_key: 'project-viewer', organisation_id: MISSING_ORG }),
      });
      assert.equal(response.status, 404);
    },
    { grants: [{ userId: USER, scopeKind: 'organisation', scopeId: ORG, keys: ['org.admin'] }] },
  );
});
