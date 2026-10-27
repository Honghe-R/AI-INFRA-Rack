import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createFacilityToolSurface, createFacilityValidationService } from '@ai-infra/facility';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerFacilityLifecycleRoutes } from '../routes/facility-lifecycle.js';

/**
 * The lifecycle routes: create and branch a draft, and refuse to publish one that is
 * not VALIDATED. Publish and approval go through the facility tool surface, so this
 * test drives the real router, guard, executor, and command; create/branch call the
 * command directly under the route permission because the tool surface declares no
 * draft-creation operation.
 */
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

const TABLES = [
  'outbox_events', 'impact_notices', 'approval_attestations', 'facility_diagnostics', 'capability_coverage',
  'validation_runs', 'entity_registry', 'facility_envelopes', 'revision_etags', 'revision_lineage',
  'revisions', 'scenarios', 'projects',
];

async function fixture() {
  const suffix = randomUUID();
  const admin = await repository.createUser({ subject: `lifecycle-admin-${suffix}` });
  const viewer = await repository.createUser({ subject: `lifecycle-viewer-${suffix}` });
  const organization = await repository.createOrganization({ name: `Lifecycle Org ${suffix}`, ownerUserId: admin.userId });
  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organization.organizationId, 'Lifecycle project']);
  await repository.assignRole({ userId: admin.userId, roleKey: 'project-admin', scopeKind: 'project', scopeId: projectId });
  await repository.assignRole({ userId: viewer.userId, roleKey: 'project-viewer', scopeKind: 'project', scopeId: projectId });

  const scenarioId = randomUUID();
  await pool.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [scenarioId, projectId, 'Baseline']);
  const revisionId = randomUUID();
  await pool.query(
    `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name) VALUES ($1, $2, $3, 'DRAFT', 'Draft 1')`,
    [revisionId, projectId, scenarioId],
  );
  const envelopeId = randomUUID();
  await pool.query(
    `INSERT INTO facility_envelopes (envelope_id, project_id, scenario_id, revision_id, lifecycle_state) VALUES ($1, $2, $3, $4, 'DRAFT')`,
    [envelopeId, projectId, scenarioId, revisionId],
  );

  return {
    admin, viewer, projectId, scenarioId, revisionId, envelopeId,
    async cleanup() {
      await pool.query('UPDATE facility_envelopes SET validation_run_id = NULL WHERE project_id = $1', [projectId]);
      for (const table of TABLES) await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]);
      await pool.query('DELETE FROM role_assignments WHERE user_id = ANY($1)', [[admin.userId, viewer.userId]]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id IN ($1, $2)', [admin.userId, viewer.userId]);
    },
  };
}

async function withServer(userId, fn) {
  const router = createRouter();
  const guard = createPermissionGuard({ evaluator, repository });
  const validationService = createFacilityValidationService({ pool });
  const toolSurface = createFacilityToolSurface({
    pool,
    validationService,
    authorize: async ({ key, userId: principal, workspaceId }) => {
      if (!key) return true;
      try {
        await guard.check(key, { user: { userId: principal }, params: { projectId: workspaceId } }, { projectParam: 'projectId' });
        return true;
      } catch {
        return false;
      }
    },
  });
  registerFacilityLifecycleRoutes(router, { toolSurface, pool });
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

test('an administrator can create and branch a draft, and the branch records its base', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.admin.userId, async (base) => {
      const created = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario_id: f.scenarioId, name: 'Draft 2' }),
      });
      assert.equal(created.status, 201);
      const draft = (await created.json()).data;
      assert.ok(draft.revisionId);
      assert.ok(draft.etag);

      const branched = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${draft.revisionId}/branches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Correction', base_revision_id: draft.revisionId }),
      });
      assert.equal(branched.status, 201);
      const branch = (await branched.json()).data;
      assert.equal(branch.baseRevisionId, draft.revisionId);
      assert.equal(branch.scenarioId, f.scenarioId);

      const lineage = await pool.query(
        'SELECT parent_revision_id FROM revision_lineage WHERE project_id = $1 AND revision_id = $2',
        [f.projectId, branch.revisionId],
      );
      assert.equal(lineage.rows[0]?.parent_revision_id, draft.revisionId);
    });
  } finally {
    await f.cleanup();
  }
});

test('publishing a draft is refused with VALIDATION_REQUIRED, and a viewer cannot create', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.admin.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error.code, 'VALIDATION_REQUIRED');
    });
    await withServer(f.viewer.userId, async (base) => {
      const denied = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario_id: f.scenarioId, name: 'Viewer draft' }),
      });
      assert.equal(denied.status, 403);
    });
    // The refused create left no revision behind.
    const revisions = await pool.query('SELECT count(*)::int AS total FROM revisions WHERE project_id = $1', [f.projectId]);
    assert.equal(revisions.rows[0].total, 1);
  } finally {
    await f.cleanup();
  }
});
