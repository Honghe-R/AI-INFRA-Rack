import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAssetService } from '@ai-infra/assets';
import { createLogger, loadConfig } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createDefaultRegistry, createImportPipeline, createSandbox } from '@ai-infra/imports';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createStorage } from '@ai-infra/storage';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerAssetRoutes } from '../routes/assets.js';

const databaseUrl = process.env.DATABASE_URL;
const config = loadConfig();
const skip = databaseUrl && config.storageBucket ? false : 'DATABASE_URL or STORAGE_BUCKET is not set';

let pool;
let repository;
let evaluator;
let storage;

before(() => {
  if (skip) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
  repository = createRbacRepository({ pool });
  evaluator = createEvaluator({ repository });
  storage = createStorage(config);
});

after(async () => {
  if (pool) await pool.end();
});

async function fixture() {
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `asset-api-member-${suffix}` });
  const outsider = await repository.createUser({ subject: `asset-api-outsider-${suffix}` });
  const viewer = await repository.createUser({ subject: `asset-api-viewer-${suffix}` });
  const organization = await repository.createOrganization({
    name: `Asset API Org ${suffix}`,
    ownerUserId: member.userId,
  });
  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Asset API Project',
  ]);
  // A project member who holds asset.read but is not an administrator: the
  // caller a RESTRICTED asset must refuse until it is granted.
  await repository.assignRole({
    userId: viewer.userId,
    roleKey: 'project-viewer',
    scopeKind: 'project',
    scopeId: projectId,
  });

  return {
    member,
    outsider,
    viewer,
    organizationId: organization.organizationId,
    projectId,
    async cleanup() {
      await pool.query(
        `DELETE FROM role_assignments
          WHERE user_id = ANY($1) OR created_by = ANY($1)
             OR (scope_kind = 'project' AND scope_id = $2)`,
        [[member.userId, outsider.userId, viewer.userId], projectId],
      );
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id IN ($1, $2, $3)', [member.userId, outsider.userId, viewer.userId]);
    },
  };
}

async function withServer(userId, fn, { limits, processor } = {}) {
  const assetService = createAssetService({ pool, storage, ...(limits ? { limits } : {}), ...(processor ? { processor } : {}) });
  const router = createRouter();
  registerAssetRoutes(router, { assetService });

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
    return await fn(`http://127.0.0.1:${port}`, assetService);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function createAsset(base, projectId, body = {}) {
  return fetch(`${base}/api/v1/projects/${projectId}/assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'site-plan.dxf',
      kind: 'CAD',
      media_type: 'image/vnd.dxf',
      size_bytes: 11,
      ...body,
    }),
  });
}

test('a caller without asset.write is refused before any row is read', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.outsider.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/assets`);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'INSUFFICIENT_PERMISSION');
    });
  } finally {
    await f.cleanup();
  }
});

test('an asset is created, streamed, and read back complete', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const created = await createAsset(base, f.projectId);
      assert.equal(created.status, 201);
      const reserved = await created.json();
      assert.equal(reserved.data.version.intakeState, 'PENDING', 'nothing is stored at reserve time');
      assert.equal(reserved.data.limits.maxBytes, config.assetMaxBytes);

      const bytes = Buffer.from('DXF-CONTENT');
      const uploaded = await fetch(
        `${base}/api/v1/projects/${f.projectId}/assets/${reserved.data.asset.assetId}/versions/${reserved.data.version.assetVersionId}/content`,
        { method: 'PUT', headers: { 'content-type': 'image/vnd.dxf' }, body: bytes },
      );
      assert.equal(uploaded.status, 201);
      const intake = await uploaded.json();
      assert.equal(intake.data.version.intakeState, 'COMPLETE');
      assert.equal(intake.data.version.sizeBytes, bytes.length);
      assert.equal(intake.data.scan.verdict, 'CLEAN');

      const fetched = await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${reserved.data.asset.assetId}`);
      assert.equal(fetched.status, 200);
      const asset = (await fetched.json()).data;
      assert.equal(asset.currentVersionId, reserved.data.version.assetVersionId);
      assert.equal(asset.versions.length, 1);
      assert.equal(asset.representations[0].kind, 'ORIGINAL');

      const listed = await fetch(`${base}/api/v1/projects/${f.projectId}/assets?kind=CAD`);
      const list = (await listed.json()).data;
      assert.equal(list.length, 1);
      assert.equal(list[0].assetId, reserved.data.asset.assetId);
      assert.equal(list[0].scanState, 'CLEAN');
    });
  } finally {
    await f.cleanup();
  }
});

test('an upload declared over the configured limit is refused before any bytes', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(
      f.member.userId,
      async (base) => {
        const response = await createAsset(base, f.projectId, { size_bytes: 64 });
        assert.equal(response.status, 413);
        assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');

        const listed = await fetch(`${base}/api/v1/projects/${f.projectId}/assets`);
        assert.deepEqual((await listed.json()).data, [], 'no asset row is left behind');
      },
      { limits: { maxBytes: 8 } },
    );
  } finally {
    await f.cleanup();
  }
});

test('a malformed media type is refused at reserve time', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await createAsset(base, f.projectId, { media_type: 'not-a-media-type' });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'VALIDATION_FAILED');
    });
  } finally {
    await f.cleanup();
  }
});

test('deletion is refused while a hold is active and permitted after release', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base, assetService) => {
      const reserved = (await (await createAsset(base, f.projectId)).json()).data;
      await fetch(
        `${base}/api/v1/projects/${f.projectId}/assets/${reserved.asset.assetId}/versions/${reserved.version.assetVersionId}/content`,
        { method: 'PUT', headers: { 'content-type': 'image/vnd.dxf' }, body: Buffer.from('HELD') },
      );

      const hold = await assetService.createHold({
        projectId: f.projectId,
        assetId: reserved.asset.assetId,
        reason: 'audit',
        authority: 'legal',
      });

      const blocked = await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${reserved.asset.assetId}`, {
        method: 'DELETE',
      });
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).error.code, 'ASSET_REFERENCED');

      await assetService.releaseHold({
        projectId: f.projectId,
        holdId: hold.holdId,
        reason: 'done',
        actorId: f.member.userId,
      });
      const deleted = await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${reserved.asset.assetId}`, {
        method: 'DELETE',
      });
      assert.equal(deleted.status, 200);
      assert.equal((await deleted.json()).data.deleted, true);
    });
  } finally {
    await f.cleanup();
  }
});

test('a download is a signed URL for a read, and no storage credential reaches the client', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const reserved = (await (await createAsset(base, f.projectId)).json()).data;
      await fetch(
        `${base}/api/v1/projects/${f.projectId}/assets/${reserved.asset.assetId}/versions/${reserved.version.assetVersionId}/content`,
        { method: 'PUT', headers: { 'content-type': 'image/vnd.dxf' }, body: Buffer.from('DOWNLOAD') },
      );

      const response = await fetch(
        `${base}/api/v1/projects/${f.projectId}/assets/${reserved.asset.assetId}/versions/${reserved.version.assetVersionId}/download`,
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.match(body.data.url, /^https?:\/\//, 'the client receives a URL, not bytes');
      if (config.storageSecretAccessKey) {
        assert.equal(body.data.url.includes(config.storageSecretAccessKey), false, 'the secret never reaches a client');
      }
      assert.equal(body.data.assetVersionId, reserved.version.assetVersionId);
    });
  } finally {
    await f.cleanup();
  }
});

test('a RESTRICTED asset is refused without a grant and allowed after one', { skip }, async () => {  const f = await fixture();
  try {
    let assetId;
    await withServer(f.member.userId, async (base) => {
      const reserved = (await (await createAsset(base, f.projectId, { access_classification: 'RESTRICTED' })).json()).data;
      assetId = reserved.asset.assetId;
      await fetch(
        `${base}/api/v1/projects/${f.projectId}/assets/${assetId}/versions/${reserved.version.assetVersionId}/content`,
        { method: 'PUT', headers: { 'content-type': 'image/vnd.dxf' }, body: Buffer.from('SECRET') },
      );
      // The uploader is granted on creation.
      assert.equal((await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${assetId}`)).status, 200);
    });

    await withServer(f.viewer.userId, async (base) => {
      const denied = await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${assetId}`);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.code, 'ASSET_ACCESS_DENIED');

      const listed = await (await fetch(`${base}/api/v1/projects/${f.projectId}/assets`)).json();
      assert.equal(listed.data[0].authorized, false, 'the blocked asset stays visible');
    });

    await withServer(f.member.userId, async (base) => {
      const granted = await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${assetId}/grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grantee_id: f.viewer.userId }),
      });
      assert.equal(granted.status, 201);
    });

    await withServer(f.viewer.userId, async (base) => {
      assert.equal((await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${assetId}`)).status, 200);
    });

    await withServer(f.member.userId, async (base) => {
      const revoked = await fetch(
        `${base}/api/v1/projects/${f.projectId}/assets/${assetId}/grants/${f.viewer.userId}`,
        { method: 'DELETE' },
      );
      assert.equal(revoked.status, 200);
    });

    await withServer(f.viewer.userId, async (base) => {
      assert.equal((await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${assetId}`)).status, 403);
    });
  } finally {
    await f.cleanup();
  }
});

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'p1', properties: { use: 'utility' }, geometry: { type: 'Point', coordinates: [121.47, 31.23] } },
  ],
});

test('the process route runs the import framework and returns its report', { skip }, async () => {
  const f = await fixture();
  try {
    const processor = createImportPipeline({
      pool,
      storage,
      registry: createDefaultRegistry(),
      sandbox: createSandbox({ timeoutMs: 30_000 }),
    });

    await withServer(
      f.member.userId,
      async (base) => {
        const reserved = (
          await (
            await createAsset(base, f.projectId, { name: 'points.geojson', kind: 'GIS', media_type: 'application/geo+json' })
          ).json()
        ).data;

        // Intake runs the producer inline, so the representations exist already.
        await fetch(
          `${base}/api/v1/projects/${f.projectId}/assets/${reserved.asset.assetId}/versions/${reserved.version.assetVersionId}/content`,
          { method: 'PUT', headers: { 'content-type': 'application/geo+json' }, body: Buffer.from(GEOJSON) },
        );

        const processed = await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${reserved.asset.assetId}/process`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: true }),
        });
        assert.equal(processed.status, 200);
        const report = (await processed.json()).data;
        assert.equal(report.adapter.adapterId, 'geojson');
        assert.equal(report.counts.mapped, 1);

        const asset = (await (await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${reserved.asset.assetId}`)).json()).data;
        const kinds = asset.representations.map((representation) => representation.kind);
        assert.ok(kinds.includes('FEATURES'));
        assert.ok(kinds.includes('GEOREFERENCE'));
      },
      { processor },
    );
  } finally {
    await f.cleanup();
  }
});

test('the process route reports 503 when no representation producer is registered', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const reserved = (await (await createAsset(base, f.projectId)).json()).data;
      const response = await fetch(`${base}/api/v1/projects/${f.projectId}/assets/${reserved.asset.assetId}/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'SERVICE_UNAVAILABLE');
    });
  } finally {
    await f.cleanup();
  }
});
