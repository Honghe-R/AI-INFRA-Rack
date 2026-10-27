import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createMapTileService, createProviderRegistry, defineProvider } from '@ai-infra/maps';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerMapRoutes } from '../routes/map.js';

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

const PLAIN = defineProvider({
  providerId: 'test',
  label: 'Test provider',
  tileUrlTemplate: 'https://tiles.test/{z}/{x}/{y}.png',
  attributionText: '© Test',
  cacheTtlSeconds: 60,
  styles: ['standard'],
});
const SECURE = defineProvider({
  providerId: 'secure',
  label: 'Secure provider',
  tileUrlTemplate: 'https://secure.test/{z}/{x}/{y}.png',
  attributionText: '© Secure',
  credentialSecretName: 'MAP_TEST_KEY',
  credentialPlacement: 'query',
  credentialParam: 'key',
});

function secrets(available = {}) {
  return { async get(name) { return available[name]; } };
}

async function fixture() {
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `map-member-${suffix}` });
  const viewer = await repository.createUser({ subject: `map-viewer-${suffix}` });
  const outsider = await repository.createUser({ subject: `map-outsider-${suffix}` });
  const organization = await repository.createOrganization({ name: `Map Org ${suffix}`, ownerUserId: member.userId });
  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Map Project',
  ]);
  await repository.assignRole({ userId: viewer.userId, roleKey: 'project-viewer', scopeKind: 'project', scopeId: projectId });

  return {
    member,
    viewer,
    outsider,
    organizationId: organization.organizationId,
    projectId,
    async cleanup() {
      await pool.query(
        `DELETE FROM role_assignments
          WHERE user_id = ANY($1) OR created_by = ANY($1)
             OR (scope_kind = 'project' AND scope_id = $2)`,
        [[member.userId, viewer.userId, outsider.userId], projectId],
      );
      await pool.query('DELETE FROM map_tile_usage WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id IN ($1, $2, $3)', [member.userId, viewer.userId, outsider.userId]);
    },
  };
}

function imageResponse(bytes = [1, 2, 3]) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-type' ? 'image/png' : name === 'content-length' ? String(bytes.length) : null) },
    async arrayBuffer() {
      return new Uint8Array(bytes).buffer;
    },
  };
}

async function withServer(userId, fn, { fetchImpl = async () => imageResponse(), secretsImpl = secrets({ MAP_TEST_KEY: 'secret-value' }) } = {}) {
  const mapService = createMapTileService({
    pool,
    secrets: secretsImpl,
    registry: createProviderRegistry({ providers: [PLAIN, SECURE] }),
    fetchImpl,
  });
  const router = createRouter();
  registerMapRoutes(router, { mapService });

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
    return await fn(`http://127.0.0.1:${port}`, mapService);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a caller without map.read is refused', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.outsider.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/map/providers?project_id=${f.projectId}`);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'INSUFFICIENT_PERMISSION');
    });
  } finally {
    await f.cleanup();
  }
});

test('provider metadata carries attribution and never the credential or template', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(
      f.member.userId,
      async (base) => {
        const response = await fetch(`${base}/api/v1/map/providers?project_id=${f.projectId}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        const ids = body.data.providers.map((provider) => provider.providerId).sort();
        assert.deepEqual(ids, ['secure', 'test']);
        for (const provider of body.data.providers) {
          assert.equal(provider.credentialSecretName, undefined);
          assert.equal(provider.tileUrlTemplate, undefined);
          assert.ok(provider.attributionText);
        }
        // No credential is configured in this process, so the secure provider is
        // listed but not selectable.
        assert.equal(body.data.providers.find((provider) => provider.providerId === 'secure').available, false);
      },
      { secretsImpl: secrets({}) },
    );
  } finally {
    await f.cleanup();
  }
});

test('a tile is proxied as bytes with attribution and cache headers', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const response = await fetch(`${base}/api/v1/map/tiles/test/1/0/0?project_id=${f.projectId}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('x-map-provider'), 'test');
      assert.equal(response.headers.get('x-map-cache'), 'miss');
      assert.equal(decodeURIComponent(response.headers.get('x-map-attribution')), '© Test');
      assert.match(response.headers.get('cache-control'), /max-age=60/);
      assert.equal((await response.arrayBuffer()).byteLength, 3);

      const cached = await fetch(`${base}/api/v1/map/tiles/test/1/0/0?project_id=${f.projectId}`);
      assert.equal(cached.status, 200, `second tile status was ${cached.status}`);
      assert.equal(cached.headers.get('x-map-cache'), 'hit');
    });
  } finally {
    await f.cleanup();
  }
});

test('the provider selection is manageable and viewers cannot manage it', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      const saved = await fetch(`${base}/api/v1/projects/${f.projectId}/map/provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider_id: 'test', style: 'standard', tile_quota: 10 }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).data.providerId, 'test');
    });

    await withServer(f.viewer.userId, async (base) => {
      const denied = await fetch(`${base}/api/v1/projects/${f.projectId}/map/provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider_id: 'test' }),
      });
      assert.equal(denied.status, 403);
    });
  } finally {
    await f.cleanup();
  }
});

test('an exhausted quota answers 429 and never reaches the provider', { skip }, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await withServer(
      f.member.userId,
      async (base) => {
        await fetch(`${base}/api/v1/projects/${f.projectId}/map/provider`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider_id: 'test', tile_quota: 1 }),
        });
        assert.equal((await fetch(`${base}/api/v1/map/tiles/test/2/0/0?project_id=${f.projectId}`)).status, 200);

        const limited = await fetch(`${base}/api/v1/map/tiles/test/2/1/0?project_id=${f.projectId}`);
        assert.equal(limited.status, 429);
        assert.equal((await limited.json()).error.code, 'MAP_QUOTA_EXCEEDED');
        assert.equal(calls, 1);
      },
      { fetchImpl: async () => { calls += 1; return imageResponse(); } },
    );
  } finally {
    await f.cleanup();
  }
});

test('usage is readable by the member and refused to a viewer without the key', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(f.member.userId, async (base) => {
      await fetch(`${base}/api/v1/map/tiles/test/3/0/0?project_id=${f.projectId}`);
      const usage = await fetch(`${base}/api/v1/projects/${f.projectId}/map/usage`);
      assert.equal(usage.status, 200);
      const body = await usage.json();
      assert.equal(body.data.counters.length, 1);
      assert.equal(body.data.counters[0].tileCount, 1);
    });

    await withServer(f.viewer.userId, async (base) => {
      const denied = await fetch(`${base}/api/v1/projects/${f.projectId}/map/usage`);
      assert.equal(denied.status, 403);
    });
  } finally {
    await f.cleanup();
  }
});

test('an unlicensed provider and an unknown provider are refused distinctly', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(
      f.member.userId,
      async (base) => {
        const unlicensed = await fetch(`${base}/api/v1/map/tiles/secure/1/0/0?project_id=${f.projectId}`);
        assert.equal(unlicensed.status, 403);
        assert.equal((await unlicensed.json()).error.code, 'MAP_PROVIDER_NOT_LICENSED');

        const unknown = await fetch(`${base}/api/v1/map/tiles/nope/1/0/0?project_id=${f.projectId}`);
        assert.equal(unknown.status, 404);
      },
      { secretsImpl: secrets({}) },
    );
  } finally {
    await f.cleanup();
  }
});
