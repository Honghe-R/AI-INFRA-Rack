import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerFacilityRoutes } from '../routes/facility.js';

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

const CAMPUS_RING = [
  [-77.4925, 39.0425],
  [-77.4866, 39.0425],
  [-77.4874, 39.0455],
  [-77.4925, 39.0443],
];
const polygon = JSON.stringify({ type: 'Polygon', coordinates: [[...CAMPUS_RING, CAMPUS_RING[0]]] });

/**
 * A user, an organisation, a project, a scenario, a draft revision, and a
 * minimal facility graph (one envelope, one SITE scope, one building container,
 * one footprint). The graph is inserted as the pool's own role, which owns the
 * tables; the read under test still runs through row-level security in the app.
 */
async function fixture({ withFacility = true } = {}) {
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `facility-member-${suffix}` });
  const viewer = await repository.createUser({ subject: `facility-viewer-${suffix}` });
  const outsider = await repository.createUser({ subject: `facility-outsider-${suffix}` });
  const organization = await repository.createOrganization({ name: `Facility Org ${suffix}`, ownerUserId: member.userId });

  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Facility Project',
  ]);
  await repository.assignRole({ userId: viewer.userId, roleKey: 'project-viewer', scopeKind: 'project', scopeId: projectId });
  const scenarioId = randomUUID();
  await pool.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
    scenarioId,
    projectId,
    'Baseline',
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
  if (withFacility) {
    await pool.query(
      `INSERT INTO entity_registry (entity_id, revision_id, project_id, scenario_id, entity_type, display_name)
       VALUES ($1, $2, $3, $4, 'SITE', $5), ($6, $2, $3, $4, 'BUILDING', $7)`,
      [scopeId, revisionId, projectId, scenarioId, 'Northern DC Campus', buildingId, 'Data Centre A'],
    );
    await pool.query(
      `INSERT INTO facility_envelopes (envelope_id, project_id, scenario_id, revision_id, lifecycle_state)
       VALUES ($1, $2, $3, $4, 'DRAFT')`,
      [envelopeId, projectId, scenarioId, revisionId],
    );
    await pool.query(
      `INSERT INTO design_scopes (scope_id, project_id, scenario_id, revision_id, envelope_id, scope_kind, name)
       VALUES ($1, $2, $3, $4, $5, 'CAMPUS', $6)`,
      [scopeId, projectId, scenarioId, revisionId, envelopeId, 'Northern DC Campus'],
    );
    await pool.query(
      `INSERT INTO facility_containers
         (container_id, project_id, scenario_id, revision_id, envelope_id, scope_id, kind, entity_type, name,
          elevation_base_m, elevation_top_m)
       VALUES ($1, $2, $3, $4, $5, $6, 'BUILDING', 'BUILDING', $7, 0, 12)`,
      [buildingId, projectId, scenarioId, revisionId, envelopeId, scopeId, 'Data Centre A'],
    );
    await pool.query(
      `INSERT INTO geometry_records
         (geometry_id, project_id, scenario_id, revision_id, entity_id, entity_type, role, geometry_type,
          geojson_4326, projected_geometry, projected_crs, elevation_base_m, elevation_top_m, height_m)
       VALUES ($1, $2, $3, $4, $5, 'BUILDING', 'FOOTPRINT', 'POLYGON',
               ST_SetSRID(ST_GeomFromGeoJSON($6), 4326),
               ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326), 32618),
               'EPSG:32618', 0, 12, 12)`,
      [randomUUID(), projectId, scenarioId, revisionId, buildingId, polygon],
    );
  }

  return {
    member,
    viewer,
    outsider,
    organizationId: organization.organizationId,
    projectId,
    scenarioId,
    revisionId,
    scopeId,
    buildingId,
    async cleanup() {
      // Facility rows reference the revision with NO ACTION, so deleting the
      // project cascades the revision away but is then refused by the graph.
      // Children go first, then the project cascades the rest.
      for (const table of ['geometry_records', 'facility_containers', 'design_scopes', 'facility_envelopes', 'entity_registry']) {
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
  registerFacilityRoutes(router, { pool });

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

test('a member reads the draft revision as a normalized design context', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}`);
      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(body.data.revisionId, f.revisionId);
      assert.equal(body.data.lifecycleState, 'DRAFT');
      assert.equal(body.data.contentChecksum, null, 'a draft has no immutable content to checksum');
      // The draft concurrency token is a different fact from the checksum, and it is
      // what a write must present. This fixture creates no token row, so the read
      // reports absence rather than inventing one.
      assert.equal(body.data.etag, null);
      assert.equal(body.data.etagVersion, null);

      assert.equal(body.data.designContext.scopes.length, 1);
      assert.equal(body.data.designContext.scopes[0].scopeKind, 'CAMPUS');
      assert.equal(body.data.designContext.containers.length, 1);
      assert.equal(body.data.designContext.containers[0].kind, 'BUILDING');
      assert.equal(body.data.designContext.containers[0].elevationTopM, 12);

      assert.equal(body.data.geometryRecords.length, 1);
      const geometry = body.data.geometryRecords[0];
      assert.equal(geometry.role, 'FOOTPRINT');
      assert.equal(geometry.entityType, 'BUILDING');
      assert.equal(geometry.displayName, 'Data Centre A');
      // The boundary carries GeoJSON as an object, not a string the client has to
      // parse, and it is WGS 84 as the contract requires.
      assert.equal(geometry.geojson4326.type, 'Polygon');
      assert.equal(Array.isArray(geometry.geojson4326.coordinates[0]), true);
      assert.equal(geometry.projectedCrs, 'EPSG:32618');

      // T4 derives coverage; an unvalidated draft returns none rather than a
      // fabricated NOT_PROVIDED verdict.
      assert.deepEqual(body.data.capabilityCoverage, []);
      assert.equal(body.meta.correlation_id !== undefined, true);
    });
  } finally {
    await f.cleanup();
  }
});

test('a viewer holding facility.read reads the same graph', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.viewer.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.designContext.containers.length, 1);
    });
  } finally {
    await f.cleanup();
  }
});

test('a revision with no envelope is a 404, never an empty graph', { skip }, async () => {
  const f = await fixture({ withFacility: false });
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}`);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, 'NOT_FOUND');
    });
  } finally {
    await f.cleanup();
  }
});

test('a caller outside the project cannot read its graph', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.outsider.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}`);
      // The outsider holds no facility.read at that project, so the guard refuses
      // before the handler reads anything.
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'INSUFFICIENT_PERMISSION');
    });
  } finally {
    await f.cleanup();
  }
});
