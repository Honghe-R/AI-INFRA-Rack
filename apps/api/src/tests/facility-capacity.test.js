import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createFacilityToolSurface, createFacilityValidationService, ensureEtag } from '@ai-infra/facility';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerFacilityCapacityRoutes } from '../routes/facility-capacity.js';

/**
 * The capacity routes are adapters over the tool surface, so this test drives them
 * through the real router, guard, and executor. The budget starts at 10 000 kW with
 * 1 000 kW reserved and nothing accepted, which is the D5 formula's simplest case:
 * a provisional request must not move availability and an accepted one must.
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
  'outbox_events', 'capacity_allocations', 'capacity_demand_requests', 'capacity_budgets',
  'utility_interfaces', 'utility_sources', 'facility_phases', 'entity_registry', 'facility_envelopes',
  'revision_etags', 'revisions', 'scenarios', 'projects',
];

async function fixture() {
  const suffix = randomUUID();
  const admin = await repository.createUser({ subject: `capacity-admin-${suffix}` });
  const viewer = await repository.createUser({ subject: `capacity-viewer-${suffix}` });
  const organization = await repository.createOrganization({ name: `Capacity Org ${suffix}`, ownerUserId: admin.userId });

  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organization.organizationId, 'Capacity project']);
  await repository.assignRole({ userId: admin.userId, roleKey: 'project-admin', scopeKind: 'project', scopeId: projectId });
  await repository.assignRole({ userId: viewer.userId, roleKey: 'project-viewer', scopeKind: 'project', scopeId: projectId });

  const scenarioId = randomUUID();
  await pool.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [scenarioId, projectId, 'Baseline']);
  const revisionId = randomUUID();
  await pool.query(
    `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
     VALUES ($1, $2, $3, 'DRAFT', 'Draft 1')`,
    [revisionId, projectId, scenarioId],
  );
  const envelopeId = randomUUID();
  await pool.query(
    `INSERT INTO facility_envelopes (envelope_id, project_id, scenario_id, revision_id, lifecycle_state)
     VALUES ($1, $2, $3, $4, 'DRAFT')`,
    [envelopeId, projectId, scenarioId, revisionId],
  );

  const buildingId = randomUUID();
  const phaseId = randomUUID();
  await pool.query(
    `INSERT INTO entity_registry (entity_id, revision_id, project_id, scenario_id, entity_type, display_name)
     VALUES ($1, $2, $3, $4, 'BUILDING', 'Building A'), ($5, $2, $3, $4, 'FACILITY_PHASE', 'Phase 1')`,
    [buildingId, revisionId, projectId, scenarioId, phaseId],
  );
  await pool.query(
    `INSERT INTO facility_phases (phase_id, project_id, scenario_id, revision_id, envelope_id, name, phase_order, status)
     VALUES ($1, $2, $3, $4, $5, 'Phase 1', 0, 'PLANNED')`,
    [phaseId, projectId, scenarioId, revisionId, envelopeId],
  );
  const budgetId = randomUUID();
  await pool.query(
    `INSERT INTO capacity_budgets
       (budget_id, project_id, scenario_id, revision_id, envelope_id, owner_entity_id, phase_id, resource_kind,
        basis, unit, commissioned_value, planned_value, reserved_value, allocated_value, available_value, derating_factor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'POWER', 'IT_LOAD', 'kW', 10000, 0, 1000, 0, 9000, 0)`,
    [budgetId, projectId, scenarioId, revisionId, envelopeId, buildingId, phaseId],
  );

  // The token row is created by the writer in production; the route test seeds it so
  // the first write's If-Match has something to match.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.project_id', projectId]);
    await ensureEtag({ client, projectId, revisionId, scenarioId, actorId: admin.userId });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const token = (await pool.query('SELECT etag FROM revision_etags WHERE project_id = $1 AND revision_id = $2', [projectId, revisionId])).rows[0].etag;

  return {
    admin, viewer, projectId, scenarioId, revisionId, envelopeId, buildingId, phaseId, budgetId, etag: token,
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
  registerFacilityCapacityRoutes(router, { toolSurface });
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

const requestBody = (f, overrides = {}) => ({
  base_revision_id: f.envelopeId,
  consumer_type: 'RACK',
  consumer_id: f.buildingId,
  phase_id: f.phaseId,
  resource_kind: 'POWER',
  requested_capacity: { value: 1000, unit: 'kW', basis: 'IT_LOAD', state: 'FIRM' },
  required_from: '2026-01-01T00:00:00Z',
  priority: 'NORMAL',
  ...overrides,
});

test('a capacity request returns a PROVISIONAL decision and leaves availability untouched', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.admin.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/capacity-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': f.etag },
        body: JSON.stringify(requestBody(f)),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.data.state, 'PROVISIONAL');
      assert.equal(body.data.allocations.length, 1);

      const capacity = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/capacity`);
      assert.equal(capacity.status, 200);
      const listed = await capacity.json();
      const budget = (listed.data.items ?? []).find((item) => item.budgetId === f.budgetId);
      assert.equal(Number(budget.availableValue), 9000);
    });
  } finally {
    await f.cleanup();
  }
});

test('accepting the allocation reduces availability by the accepted quantity', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.admin.userId, async (base) => {
      const created = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/capacity-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': f.etag },
        body: JSON.stringify(requestBody(f)),
      });
      const decision = (await created.json()).data;
      const allocationId = decision.allocations[0].allocationId;

      const accepted = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/allocations/${allocationId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': decision.etag },
        body: JSON.stringify({ base_revision_id: f.envelopeId, state: 'ACCEPTED' }),
      });
      assert.equal(accepted.status, 200);
      const body = await accepted.json();
      assert.equal(body.data.state, 'ACCEPTED');
      assert.equal(Number(body.data.budget.availableValue), 8000);
    });
  } finally {
    await f.cleanup();
  }
});

test('a viewer cannot request capacity, and a missing If-Match is refused', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.viewer.userId, async (base) => {
      const denied = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/capacity-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(f)),
      });
      assert.equal(denied.status, 403);
    });
    await withServer(f.admin.userId, async (base) => {
      const noToken = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/capacity-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(f)),
      });
      assert.equal(noToken.status, 428);
    });
  } finally {
    await f.cleanup();
  }
});
