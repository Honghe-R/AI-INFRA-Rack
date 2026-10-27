import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createFacilityToolSurface } from '@ai-infra/facility';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerFacilityImportRoutes } from '../routes/facility-imports.js';

/**
 * The import path over HTTP.
 *
 * What these tests are for: the routes are adapters, so the questions worth asking
 * are the transport ones — does the permission gate match the operation, does a
 * domain refusal arrive as the status the contract documents, and does what the
 * command wrote come back from the read that a UI would use.
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

// Bindings first: `asset_bindings.asset_version_id` is deliberately not a foreign key,
// so nothing cascades it away. Then the asset, whose delete cascades to its versions and
// their representations — `asset_versions` cannot be deleted directly while
// `project_assets.current_version_id` still points at it.
const TABLES = ['asset_bindings', 'asset_representations', 'project_assets'];

const checksum = (seed) => seed.replace(/-/g, '').padEnd(64, '0').slice(0, 64);

async function fixture({ assetStatus = 'ACTIVE' } = {}) {
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `import-member-${suffix}` });
  const viewer = await repository.createUser({ subject: `import-viewer-${suffix}` });
  const organization = await repository.createOrganization({ name: `Import Org ${suffix}`, ownerUserId: member.userId });

  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Import project',
  ]);
  // `facility.import.initiate` is project-scoped: organisation administration does
  // not imply it, so the member takes the project admin role and the viewer does not.
  await repository.assignRole({ userId: member.userId, roleKey: 'project-admin', scopeKind: 'project', scopeId: projectId });
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

  const assetId = randomUUID();
  const assetVersionId = randomUUID();
  const representationId = randomUUID();
  // `project_assets.current_version_id` is a DEFERRABLE INITIALLY DEFERRED foreign key:
  // intake creates the asset and its pending version in one transaction, so the check
  // runs at commit. Outside a transaction it would fire on the asset insert itself.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO project_assets
         (asset_id, project_id, name, kind, media_type, status, access_classification,
          current_version_id, version_count, owner)
       VALUES ($1, $2, 'Campus survey', 'GIS', 'application/geo+json', $3, 'PROJECT', $4, 1, 'ada')`,
      [assetId, projectId, assetStatus, assetVersionId],
    );
    await client.query(
      `INSERT INTO asset_versions
         (asset_version_id, project_id, asset_id, version_number, intake_state, content_checksum,
          size_bytes, storage_key, filename, media_type, malware_scan_state, status, source_ref)
       VALUES ($1, $2, $3, 1, 'COMPLETE', $4, 2048, 'key/original', 'campus.geojson',
               'application/geo+json', 'CLEAN', 'CURRENT', 'user-upload')`,
      [assetVersionId, projectId, assetId, checksum(assetVersionId)],
    );
    await client.query(
      `INSERT INTO asset_representations
         (representation_id, project_id, asset_version_id, kind, media_type, content_checksum, storage_key,
          producer_id, producer_version, status)
       VALUES ($1, $2, $3, 'FEATURES', 'application/geo+json', $4, NULL, 'geojson', '1.0', 'READY')`,
      [representationId, projectId, assetVersionId, checksum(representationId)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    member,
    viewer,
    projectId,
    scenarioId,
    revisionId,
    assetId,
    assetVersionId,
    representationId,
    async cleanup() {
      for (const table of TABLES) await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]);
      await pool.query(
        `DELETE FROM role_assignments
          WHERE user_id = ANY($1) OR created_by = ANY($1)
             OR (scope_kind = 'organisation' AND scope_id = $2)
             OR (scope_kind = 'project' AND scope_id = $3)`,
        [[member.userId, viewer.userId], organization.organizationId, projectId],
      );
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id IN ($1, $2)', [member.userId, viewer.userId]);
    },
  };
}

async function withServer(userId, fn) {
  const router = createRouter();
  const guard = createPermissionGuard({ evaluator, repository });
  // Built the way the server builds it: the surface's authorizer re-asks this guard,
  // so a test can tell a transport denial from a tool-level one.
  const toolSurface = createFacilityToolSurface({
    pool,
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
  registerFacilityImportRoutes(router, { toolSurface });

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

const bindingsUrl = (base, f) =>
  `${base}/api/v1/projects/${f.projectId}/facility/revisions/${f.revisionId}/asset-bindings`;

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test('a binding is created, then listed and read back', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const url = bindingsUrl(base, f);

      const empty = await json(await fetch(url));
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body.data.asset_bindings, []);
      assert.equal(empty.body.data.total, 0);

      const created = await json(
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ asset_version_id: f.assetVersionId, representation_id: f.representationId, role: 'SOURCE' }),
        }),
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.assetVersionId, f.assetVersionId);
      assert.equal(created.body.data.representationId, f.representationId);
      assert.equal(created.body.data.role, 'SOURCE');
      assert.equal(created.body.data.status, 'UNREVIEWED');
      assert.equal(created.body.data.authoritative, false);
      assert.equal(created.body.data.filename, 'campus.geojson');
      assert.match(created.body.data.next, /preview the merge/, 'the adapter passes on what happens next');

      const listed = await json(await fetch(url));
      assert.equal(listed.body.data.asset_bindings.length, 1);
      assert.equal(listed.body.data.asset_bindings[0].bindingId, created.body.data.bindingId);

      const filtered = await json(await fetch(`${url}?role=ATTACHMENT`));
      assert.equal(filtered.body.data.asset_bindings.length, 0);
    });
  } finally {
    await f.cleanup();
  }
});

test('a role the asset model does not declare is refused, naming the field', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await json(
        await fetch(bindingsUrl(base, f), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ asset_version_id: f.assetVersionId, role: 'OWNER' }),
        }),
      );
      // A role outside the enum is an invalid *argument*, so the surface's validator
      // refuses it with 400 before the handler runs. The command keeps its own 422
      // check as well, for callers that are not the surface.
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'VALIDATION_FAILED');
      assert.ok(
        response.body.error.details.some((detail) => detail.field === 'role'),
        'the refusal names the offending field',
      );
    });
  } finally {
    await f.cleanup();
  }
});

test('a quarantined version is refused with the reason, not a generic failure', { skip }, async () => {
  const f = await fixture({ assetStatus: 'QUARANTINED' });
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await json(
        await fetch(bindingsUrl(base, f), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ asset_version_id: f.assetVersionId, role: 'SOURCE' }),
        }),
      );
      assert.equal(response.status, 422);
      assert.equal(response.body.error.details[0].reason, 'quarantined');
    });
  } finally {
    await f.cleanup();
  }
});

test('binding the same version twice in one role is a 409, not a second row', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const url = bindingsUrl(base, f);
      const body = JSON.stringify({ asset_version_id: f.assetVersionId, role: 'SOURCE' });
      const headers = { 'content-type': 'application/json' };

      const first = await json(await fetch(url, { method: 'POST', headers, body }));
      const second = await json(await fetch(url, { method: 'POST', headers, body }));

      assert.equal(first.status, 201);
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, 'CONFLICT');
      assert.equal(second.body.error.details[0].binding_id, first.body.data.bindingId);

      const listed = await json(await fetch(url));
      assert.equal(listed.body.data.asset_bindings.length, 1, 'the refused retry wrote nothing');
    });
  } finally {
    await f.cleanup();
  }
});

test('a caller without the import key is refused at the transport', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.viewer.userId, async (base) => {
      const url = bindingsUrl(base, f);

      const read = await fetch(url);
      assert.equal(read.status, 200, 'a project viewer may read which assets the revision consumes');

      const write = await json(
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ asset_version_id: f.assetVersionId, role: 'SOURCE' }),
        }),
      );
      assert.equal(write.status, 403);
      assert.equal(write.body.error.code, 'INSUFFICIENT_PERMISSION');
    });
  } finally {
    await f.cleanup();
  }
});

test('an unknown asset version is a 422 and leaves no binding behind', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const url = bindingsUrl(base, f);
      const response = await json(
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ asset_version_id: randomUUID(), role: 'SOURCE' }),
        }),
      );
      assert.equal(response.status, 422);
      assert.equal(response.body.error.details[0].reason, 'no_such_version');

      const listed = await json(await fetch(url));
      assert.equal(listed.body.data.total, 0);
    });
  } finally {
    await f.cleanup();
  }
});
