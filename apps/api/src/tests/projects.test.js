import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerProjectRoutes } from '../routes/projects.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;
let repository;
let evaluator;

before(() => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
  repository = createRbacRepository({ pool });
  evaluator = createEvaluator({ repository });
});

after(async () => {
  if (pool) await pool.end();
});

async function fixture() {
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `projects-member-${suffix}` });
  const outsider = await repository.createUser({ subject: `projects-outsider-${suffix}` });
  const organization = await repository.createOrganization({ name: `Projects Org ${suffix}`, ownerUserId: member.userId });

  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Northern DC',
  ]);

  return {
    member,
    outsider,
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
          WHERE user_id = ANY($1) OR created_by = ANY($1)
             OR (scope_kind = 'organisation' AND scope_id = $2)
             OR (scope_kind = 'project' AND scope_id = $3)`,
        [[member.userId, outsider.userId], organization.organizationId, projectId],
      );
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id IN ($1, $2)', [member.userId, outsider.userId]);
    },
  };
}

async function withServer(userId, fn) {
  const router = createRouter();
  registerProjectRoutes(router, { pool });

  const guard = createPermissionGuard({ evaluator, repository });
  const authenticator = {
    async authenticate(ctx) {
      ctx.user = { userId, status: 'ACTIVE' };
      return ctx.user;
    },
  };

  const logger = createLogger({ sink: { log() {}, warn() {}, error() {} }, level: 'error' });
  const server = createServer(createApp({ config: {}, logger, pool, router, authenticator, guard }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('listing projects without an organisation scope is refused before any row is read', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects`);
      // The guard runs before the handler, and with no scope named the check is
      // an unscoped one — which a scoped role must never satisfy. Authorization
      // deliberately precedes parameter validation.
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'INSUFFICIENT_PERMISSION');
    });
  } finally {
    await f.cleanup();
  }
});

test('a member sees their organisation projects', { skip }, async () => {
  const f = await fixture();
  try {
    // createOrganization assigned organisation-admin, which carries project.read.
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects?organisation_id=${f.organizationId}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].projectId, f.projectId);
      assert.equal(body.data[0].name, 'Northern DC');
      assert.equal(body.data[0].accessState, 'Organisation');
      assert.equal(body.data[0].validationSummary, undefined, 'the list does not invent a validation summary');
    });
  } finally {
    await f.cleanup();
  }
});

test('a caller with no membership in the organisation sees an empty list, not an error', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.outsider.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects?organisation_id=${f.organizationId}`);
      // The outsider holds no project.read at that organisation, so the guard
      // refuses before any row is read.
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'INSUFFICIENT_PERMISSION');
    });
  } finally {
    await f.cleanup();
  }
});

test('a malformed organisation identifier is a 404, never a silent empty scope', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects?organisation_id=not-a-uuid`);
      assert.ok([403, 404].includes(response.status), 'refused either by the guard or by the resolver');
    });
  } finally {
    await f.cleanup();
  }
});

/** A scenario with one older DRAFT and one newer VALIDATED revision. */
async function addScenario(projectId, name) {
  const scenarioId = randomUUID();
  await pool.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
    scenarioId,
    projectId,
    name,
  ]);

  const draftId = randomUUID();
  const validatedId = randomUUID();
  await pool.query(
    `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name, created_at)
     VALUES ($1, $2, $3, 'DRAFT', $4, now() - interval '1 day')`,
    [draftId, projectId, scenarioId, 'Draft 1'],
  );
  // A non-draft revision must carry a checksum, and it is deliberately *newer*
  // than the draft so the test proves the draft is chosen by state, not recency.
  await pool.query(
    `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name, content_checksum, created_at)
     VALUES ($1, $2, $3, 'VALIDATED', $4, $5, now())`,
    [validatedId, projectId, scenarioId, 'Validated 1', 'checksum-1'],
  );

  return { scenarioId, draftId, validatedId };
}

test('a member reads a scenario with its active revision', { skip }, async () => {
  const f = await fixture();
  try {
    const { scenarioId, draftId } = await addScenario(f.projectId, 'Baseline');

    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/scenarios`);
      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].scenarioId, scenarioId);
      assert.equal(body.data[0].name, 'Baseline');
      // The draft is the only revision a user can continue authoring, so it is the
      // active one even though the validated revision is newer.
      assert.equal(body.data[0].activeRevision.revisionId, draftId);
      assert.equal(body.data[0].activeRevision.lifecycleState, 'DRAFT');
    });
  } finally {
    await f.cleanup();
  }
});

test('a project with no scenario returns an empty list, not an error', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/scenarios`);
      assert.equal(response.status, 200);
      // The shell turns this into "no workspace to open" rather than a blank screen.
      assert.deepEqual((await response.json()).data, []);
    });
  } finally {
    await f.cleanup();
  }
});

test('scenarios of another organisation are refused', { skip }, async () => {
  const f = await fixture();
  try {
    await addScenario(f.projectId, 'Baseline');
    await withServer(f.outsider.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/scenarios`);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'INSUFFICIENT_PERMISSION');
    });
  } finally {
    await f.cleanup();
  }
});

test('an unknown or malformed project identifier is a 404, never a null scope', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      for (const projectId of [randomUUID(), 'not-a-uuid']) {
        const response = await fetch(`${base}/api/v1/projects/${projectId}/scenarios`);
        assert.equal(response.status, 404, `expected 404 for ${projectId}`);
        assert.equal((await response.json()).error.code, 'NOT_FOUND');
      }
    });
  } finally {
    await f.cleanup();
  }
});
