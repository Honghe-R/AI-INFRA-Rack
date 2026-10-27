import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createFacilityToolSurface, createFacilityValidationService, createValidationWorker } from '@ai-infra/facility';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerFacilityRoutes } from '../routes/facility.js';
import { registerFacilityValidationRoutes } from '../routes/facility-validation.js';

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

const FACILITY_TABLES = [
  'outbox_events', 'capacity_allocations', 'capacity_demand_requests', 'capacity_budgets', 'storage_reserves',
  'utility_interfaces', 'utility_sources', 'resilience_requirements', 'spatial_constraints',
  'environmental_constraints', 'environmental_profiles', 'facility_containers', 'design_scopes',
  'phase_capability_availability', 'phase_dependencies', 'facility_phases', 'failure_domains', 'geometry_records',
  'import_features', 'import_mappings', 'spatial_transforms', 'asset_bindings', 'assumptions', 'documents',
  'waivers', 'approval_attestations', 'facility_diagnostics', 'capability_coverage', 'validation_runs',
  'entity_registry', 'facility_envelopes', 'jobs', 'revision_etags', 'idempotency_records',
];

/**
 * A revision whose building has no footprint, so a local run has exactly one
 * ERROR to report and one diagnostic to waive.
 */
async function fixture() {
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `validation-member-${suffix}` });
  const viewer = await repository.createUser({ subject: `validation-viewer-${suffix}` });
  const outsider = await repository.createUser({ subject: `validation-outsider-${suffix}` });
  const organization = await repository.createOrganization({ name: `Validation Org ${suffix}`, ownerUserId: member.userId });

  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId, organization.organizationId, 'Validation project',
  ]);
  await repository.assignRole({ userId: viewer.userId, roleKey: 'project-viewer', scopeKind: 'project', scopeId: projectId });
  // `facility.validate.run` is a project-scoped key: organisation administration
  // does not imply it, so the member takes the project admin role.
  await repository.assignRole({ userId: member.userId, roleKey: 'project-admin', scopeKind: 'project', scopeId: projectId });

  const scenarioId = randomUUID();
  await pool.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
    scenarioId, projectId, 'Baseline',
  ]);
  const revisionId = randomUUID();
  await pool.query(
    `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
     VALUES ($1, $2, $3, 'DRAFT', 'Draft 1')`,
    [revisionId, projectId, scenarioId],
  );

  const envelopeId = randomUUID();
  const scopeId = randomUUID();
  const buildingId = randomUUID();
  await pool.query(
    `INSERT INTO entity_registry (entity_id, revision_id, project_id, scenario_id, entity_type, display_name)
     VALUES ($1, $2, $3, $4, 'SITE', 'Validation campus'), ($5, $2, $3, $4, 'BUILDING', 'Building with no footprint')`,
    [scopeId, revisionId, projectId, scenarioId, buildingId],
  );
  await pool.query(
    `INSERT INTO facility_envelopes (envelope_id, project_id, scenario_id, revision_id, lifecycle_state)
     VALUES ($1, $2, $3, $4, 'DRAFT')`,
    [envelopeId, projectId, scenarioId, revisionId],
  );
  await pool.query(
    `INSERT INTO design_scopes (scope_id, project_id, scenario_id, revision_id, envelope_id, scope_kind, name, provenance)
     VALUES ($1, $2, $3, $4, $5, 'CAMPUS', 'Validation campus', '{"source_ref":"fixture"}'::jsonb)`,
    [scopeId, projectId, scenarioId, revisionId, envelopeId],
  );
  await pool.query(
    `INSERT INTO facility_containers
       (container_id, project_id, scenario_id, revision_id, envelope_id, scope_id, kind, entity_type, name, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, 'BUILDING', 'BUILDING', 'Building with no footprint', '{"source_ref":"fixture"}'::jsonb)`,
    [buildingId, projectId, scenarioId, revisionId, envelopeId, scopeId],
  );
  await pool.query(
    `INSERT INTO geometry_records
       (geometry_id, project_id, scenario_id, revision_id, entity_id, entity_type, role, geometry_type,
        geojson_4326, projected_geometry, projected_crs, provenance)
     VALUES ($1, $2, $3, $4, $5, 'SITE', 'BOUNDARY', 'POLYGON',
             ST_Transform(ST_GeomFromText('POLYGON((0 0, 600 0, 600 400, 0 400, 0 0))', 32618), 4326),
             ST_GeomFromText('POLYGON((0 0, 600 0, 600 400, 0 400, 0 0))', 32618), 'EPSG:32618',
             '{"source_ref":"fixture"}'::jsonb)`,
    [randomUUID(), projectId, scenarioId, revisionId, scopeId],
  );

  return {
    member, viewer, outsider, organizationId: organization.organizationId, projectId, scenarioId, revisionId, envelopeId,
    scopeId, buildingId,
    async cleanup() {
      await pool.query('UPDATE asset_bindings SET transform_id = NULL WHERE project_id = $1', [projectId]);
      await pool.query('UPDATE facility_envelopes SET validation_run_id = NULL WHERE project_id = $1', [projectId]);
      for (const table of FACILITY_TABLES) {
        await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]);
      }
      await pool.query(
        `DELETE FROM role_assignments
          WHERE user_id = ANY($1) OR created_by = ANY($1)
             OR (scope_kind = 'organisation' AND scope_id = $2)
             OR (scope_kind = 'project' AND scope_id = $3)`,
        [[member.userId, viewer.userId, outsider.userId], organization.organizationId, projectId],
      );
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id IN ($1, $2, $3)', [member.userId, viewer.userId, outsider.userId]);
    },
  };
}

async function withServer(userId, fn) {
  const router = createRouter();
  const guard = createPermissionGuard({ evaluator, repository });
  const validationService = createFacilityValidationService({ pool });
  // The routes are adapters over the tool surface, so the harness builds one the
  // same way the server does: the surface's authorizer re-asks this guard.
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
  registerFacilityValidationRoutes(router, { toolSurface, validationService });
  // The envelope read is a separate route family, and the change-set tests need it:
  // the token a commit advances is served by that read, so exercising them apart
  // would prove nothing about what an editor actually sees.
  registerFacilityRoutes(router, { pool });
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

test('a local validation run answers inline with diagnostics and coverage', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'AFFECTED_SUBGRAPH' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.mode, 'sync');
      assert.equal(body.data.errorCount, 1);
      assert.ok(body.data.diagnostics.some((item) => item.constraintId === 'facility.data.geometry.role_missing'));
      assert.equal(body.data.coverage.GEOMETRY.status, 'PROVISIONAL');

      const diagnostics = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/diagnostics`);
      assert.equal(diagnostics.status, 200);
      const listed = (await diagnostics.json()).data.diagnostics;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].constraintId, 'facility.data.geometry.role_missing');

      const coverage = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/coverage`);
      assert.equal(coverage.status, 200);
      assert.equal((await coverage.json()).data.coverage.length, 8);
    });
  } finally {
    await f.cleanup();
  }
});

test('a full validation is a job that the worker completes', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'FULL' }),
      });
      assert.equal(response.status, 202);
      const { data } = await response.json();
      assert.equal(data.mode, 'job');

      const worker = createValidationWorker({ pool });
      const outcomes = await worker.runOnce();
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].state, 'SUCCEEDED');

      const job = await fetch(`${base}/api/v1/jobs/${data.jobId}?project_id=${f.projectId}`);
      assert.equal(job.status, 200);
      const jobBody = (await job.json()).data;
      assert.equal(jobBody.state, 'SUCCEEDED');
      assert.equal(jobBody.result.validation_run_id, data.runId);

      const run = await fetch(
        `${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/validation-runs/${data.runId}`,
      );
      assert.equal(run.status, 200);
      const runBody = (await run.json()).data;
      assert.equal(runBody.run.status, 'COMPLETED');
      assert.ok(runBody.run.notCheckedCapabilities.length > 0, 'strict applicability leaves checks unrun');
    });
  } finally {
    await f.cleanup();
  }
});

test('a waiver suppresses a diagnostic and is listed', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const run = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'AFFECTED_SUBGRAPH' }),
      });
      const diagnostic = (await run.json()).data.diagnostics[0];

      const granted = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/waivers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          diagnostic_ids: [diagnostic.diagnosticId],
          policy_id: 'coverage-promoting-waiver@1',
          reason: 'Accepted for the fixture.',
        }),
      });
      assert.equal(granted.status, 201);
      const waiver = (await granted.json()).data;
      assert.equal(waiver.status, 'GRANTED');

      const listed = (await (await fetch(
        `${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/waivers`,
      )).json()).data.waivers;
      assert.equal(listed.length, 1);

      const after = (await (await fetch(
        `${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/diagnostics`,
      )).json()).data.diagnostics;
      assert.equal(after[0].status, 'WAIVED');

      const revoked = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/waivers/${waiver.waiverId}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'No longer accepted.' }),
      });
      assert.equal(revoked.status, 200);
      const restored = (await (await fetch(
        `${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/diagnostics`,
      )).json()).data.diagnostics;
      assert.equal(restored[0].status, 'OPEN');
    });
  } finally {
    await f.cleanup();
  }
});

test('running a validation needs facility.validate.run', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.viewer.userId, async (base) => {
      const denied = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'FULL' }),
      });
      assert.equal(denied.status, 403);
      // But a viewer may read diagnostics and coverage.
      assert.equal((await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/diagnostics`)).status, 200);
    });
    await withServer(f.outsider.userId, async (base) => {
      const refused = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/diagnostics`);
      assert.equal(refused.status, 403);
    });
  } finally {
    await f.cleanup();
  }
});

/* --------------------------------------------------------- change-set commit */

/**
 * The draft token is created where a revision is created. No draft-creation command
 * exists yet (T5 owns branching), so this fixture inserts the row the way the seed
 * does, rather than inventing a second creation path inside the test.
 */
async function ensureDraftToken(f) {
  await pool.query(
    `INSERT INTO revision_etags (revision_id, project_id, scenario_id)
     VALUES ($1, $2, $3) ON CONFLICT (revision_id, project_id) DO NOTHING`,
    [f.revisionId, f.projectId, f.scenarioId],
  );
  const { rows } = await pool.query('SELECT etag, etag_version FROM revision_etags WHERE project_id = $1 AND revision_id = $2', [
    f.projectId,
    f.revisionId,
  ]);
  return { etag: rows[0].etag, etagVersion: Number(rows[0].etag_version) };
}

test('a change set commits against the draft token and previews its findings', { skip }, async () => {
  const f = await fixture();
  try {
    const token = await ensureDraftToken(f);
    await withServer(f.member.userId, async (base) => {
      const revisionPath = `/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}`;

      // The fixture's building has no footprint, so the run reports exactly that.
      const before = await (await fetch(`${base}${revisionPath}/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'AFFECTED_SUBGRAPH' }),
      })).json();
      assert.ok(
        before.data.diagnostics.some((entry) => entry.constraintId === 'facility.data.geometry.role_missing'),
        'the fixture starts with a missing footprint',
      );

      // Draw one, and let PostGIS produce its WGS 84 form so the write path's
      // transform is exercised rather than bypassed.
      const geometry = (
        await pool.query(
          `SELECT ST_AsGeoJSON(ST_Transform(ST_GeomFromText('POLYGON((50 50, 200 50, 200 150, 50 150, 50 50))', 32618), 4326))::json AS geojson`,
        )
      ).rows[0].geojson;

      const response = await fetch(`${base}${revisionPath}/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `api-${f.revisionId}` },
        body: JSON.stringify({
          base_revision_id: f.envelopeId,
          etag: token.etag,
          changes: [{ kind: 'set_geometry', entity_ref: { entity_id: f.buildingId }, payload: { role: 'FOOTPRINT', geojson_4326: geometry } }],
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.data.applied.length, 1);
      assert.equal(body.data.applied[0].role, 'FOOTPRINT');
      assert.notEqual(body.data.etag, token.etag, 'the token advanced');
      assert.equal(body.data.etagVersion, token.etagVersion + 1);
      assert.equal(
        body.data.diagnostics.some((entry) => entry.constraintId === 'facility.data.geometry.role_missing'),
        false,
        'the finding the edit was made to fix is gone from the preview',
      );
      assert.match(body.data.effect, /change set was applied/);

      // The envelope now serves the advanced token, so a second editor can see it.
      const envelope = await (await fetch(`${base}${revisionPath}`)).json();
      assert.equal(envelope.data.etag, body.data.etag);
      assert.equal(envelope.data.etagVersion, body.data.etagVersion);
    });
  } finally {
    await f.cleanup();
  }
});

test('a change set with a stale token is refused, and a viewer may not commit at all', { skip }, async () => {
  const f = await fixture();
  try {
    const token = await ensureDraftToken(f);
    await withServer(f.member.userId, async (base) => {
      const revisionPath = `/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}`;
      const change = {
        kind: 'update_entity',
        entity_ref: { entity_id: f.buildingId },
        payload: { patch: { name: 'Renamed by the first editor' } },
      };

      const first = await fetch(`${base}${revisionPath}/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base_revision_id: f.envelopeId, etag: token.etag, changes: [change] }),
      });
      assert.equal(first.status, 200);

      // The same token again: the loser of the race, not a silent overwrite.
      const second = await fetch(`${base}${revisionPath}/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base_revision_id: f.envelopeId, etag: token.etag, changes: [change] }),
      });
      assert.equal(second.status, 409);
      const conflict = await second.json();
      assert.equal(conflict.error.code, 'REVISION_ETAG_STALE');
      assert.equal(conflict.error.details[0].constraint_id, 'facility.revision.current');

      // An unconfirmed-looking write from a viewer is refused by the transport gate.
      const envelope = await (await fetch(`${base}${revisionPath}`)).json();
      return envelope;
    });

    await withServer(f.viewer.userId, async (base) => {
      const denied = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base_revision_id: f.envelopeId, etag: token.etag, changes: [{ kind: 'update_entity', entity_ref: { entity_id: f.buildingId }, payload: { patch: { name: 'Nope' } } }] }),
      });
      assert.equal(denied.status, 403);
    });
  } finally {
    await f.cleanup();
  }
});

test('an invalid change is refused with per-change diagnostics', { skip }, async () => {
  const f = await fixture();
  try {
    const token = await ensureDraftToken(f);
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          base_revision_id: f.envelopeId,
          etag: token.etag,
          changes: [
            { kind: 'update_entity', entity_ref: { entity_id: f.buildingId }, payload: { patch: { not_editable: 1 } } },
            { kind: 'not_a_kind', payload: {} },
          ],
        }),
      });
      assert.equal(response.status, 422);
      const body = await response.json();
      assert.equal(body.error.code, 'CHANGE_SET_REJECTED');
      assert.equal(body.error.details.length, 2, 'every change is checked, not only the first');
    });
  } finally {
    await f.cleanup();
  }
});
