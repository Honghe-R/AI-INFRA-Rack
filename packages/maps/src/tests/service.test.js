import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@ai-infra/db';
import { createRateLimiter, createTileCache } from '../cache.js';
import { createProviderRegistry, defineProvider } from '../providers.js';
import { createMapTileService } from '../service.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;

before(() => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
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
  maxZoom: 19,
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
  cacheTtlSeconds: 60,
});
const NO_CACHE = defineProvider({
  providerId: 'nocache',
  label: 'No cache provider',
  tileUrlTemplate: 'https://nocache.test/{z}/{x}/{y}.png',
  attributionText: '© NoCache',
  cachePermitted: false,
});
/** A provider whose policy is satisfied by identifying headers, not a credential. */
const IDENTIFIED = defineProvider({
  providerId: 'identified',
  label: 'Identified provider',
  tileUrlTemplate: 'https://identified.test/{z}/{x}/{y}.png',
  attributionText: '© Identified',
  requestHeaders: { 'user-agent': 'test-planner/1.0 (+https://test.test)', referer: 'https://test.test' },
  cacheTtlSeconds: 604_800,
});
const registry = createProviderRegistry({ providers: [PLAIN, SECURE, NO_CACHE, IDENTIFIED] });

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

function secrets(available = { MAP_TEST_KEY: 'secret-value' }) {
  return { async get(name) { return available[name]; } };
}

function serviceWith({ fetchImpl, secretsImpl = secrets(), rateLimiter, now = () => new Date() } = {}) {
  return createMapTileService({
    pool,
    secrets: secretsImpl,
    registry,
    fetchImpl,
    cache: createTileCache(),
    ...(rateLimiter ? { rateLimiter } : {}),
    now,
  });
}

async function fixture() {
  const { createRbacRepository } = await import('@ai-infra/rbac');
  const repository = createRbacRepository({ pool });
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `maps-member-${suffix}` });
  const organization = await repository.createOrganization({ name: `Maps Org ${suffix}`, ownerUserId: member.userId });
  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Maps Project',
  ]);
  return {
    member,
    organizationId: organization.organizationId,
    projectId,
    async cleanup() {
      await pool.query('DELETE FROM map_tile_usage WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id = $1', [member.userId]);
    },
  };
}

test('a tile is proxied, attributed, metered once, and then served from cache', { skip }, async () => {
  const f = await fixture();
  try {
    const calls = [];
    const service = serviceWith({ fetchImpl: async (url) => { calls.push(url); return imageResponse(); } });
    const args = { projectId: f.projectId, userId: f.member.userId, providerId: 'test', z: 1, x: 0, y: 0 };

    const first = await service.fetchTile(args);
    assert.equal(first.cache, 'miss');
    assert.equal(first.bytes.length, 3);
    assert.equal(first.attribution.text, '© Test');
    assert.equal(calls.length, 1);

    const second = await service.fetchTile(args);
    assert.equal(second.cache, 'hit');
    assert.equal(calls.length, 1, 'a cache hit never reaches the provider');

    const usage = await service.getUsage({ projectId: f.projectId });
    assert.equal(usage.counters.length, 1);
    assert.equal(usage.counters[0].tileCount, 1, 'a cache hit is not billed');
  } finally {
    await f.cleanup();
  }
});

test('the provider credential is sent upstream and never returned to the caller', { skip }, async () => {
  const f = await fixture();
  try {
    let seenUrl = null;
    const service = serviceWith({ fetchImpl: async (url) => { seenUrl = url; return imageResponse(); } });
    const result = await service.fetchTile({ projectId: f.projectId, providerId: 'secure', z: 1, x: 0, y: 0 });

    assert.match(seenUrl, /key=secret-value/);
    assert.ok(!JSON.stringify(result).includes('secret-value'), 'the credential never reaches a client');
    assert.equal(result.attribution.text, '© Secure');
  } finally {
    await f.cleanup();
  }
});

test('a provider identified by headers sends them upstream and never to the caller', { skip }, async () => {
  const f = await fixture();
  try {
    let seen = null;
    const service = serviceWith({ fetchImpl: async (url, options) => { seen = { url, headers: options.headers }; return imageResponse(); } });
    const result = await service.fetchTile({ projectId: f.projectId, providerId: 'identified', z: 1, x: 0, y: 0 });

    assert.equal(seen.headers['user-agent'], 'test-planner/1.0 (+https://test.test)', 'the policy requires identification');
    assert.equal(seen.headers.referer, 'https://test.test');
    assert.equal(seen.headers.accept, 'image/*', 'the proxy still asks for an image');
    const clientPayload = JSON.stringify(result, (key, value) => (key === 'bytes' ? undefined : value));
    assert.ok(!clientPayload.includes('test-planner'), 'request headers are transport detail, not a client contract');
    assert.equal(result.attribution.text, '© Identified');
  } finally {
    await f.cleanup();
  }
});

test('a provider without a configured credential is not licensed', { skip }, async () => {
  const f = await fixture();
  try {
    const service = serviceWith({ fetchImpl: async () => imageResponse(), secretsImpl: secrets({}) });
    const providers = await service.listProviders();
    const secure = providers.find((provider) => provider.providerId === 'secure');
    assert.equal(secure.available, false);

    await assert.rejects(
      service.fetchTile({ projectId: f.projectId, providerId: 'secure', z: 1, x: 0, y: 0 }),
      (error) => error.code === 'MAP_PROVIDER_NOT_LICENSED',
    );
  } finally {
    await f.cleanup();
  }
});

test('an exhausted quota is refused before the provider is called', { skip }, async () => {
  const f = await fixture();
  try {
    const calls = [];
    const service = serviceWith({ fetchImpl: async (url) => { calls.push(url); return imageResponse(); } });
    await service.setProjectSettings({ projectId: f.projectId, providerId: 'test', tileQuota: 1, actorId: f.member.userId });

    await service.fetchTile({ projectId: f.projectId, providerId: 'test', z: 1, x: 0, y: 0 });
    await assert.rejects(
      service.fetchTile({ projectId: f.projectId, providerId: 'test', z: 1, x: 1, y: 0 }),
      (error) => {
        assert.equal(error.code, 'MAP_QUOTA_EXCEEDED');
        assert.equal(error.status, 429);
        return true;
      },
    );
    assert.equal(calls.length, 1, 'the second request never reached the provider');
  } finally {
    await f.cleanup();
  }
});

test('a provider failure or a non-image response degrades to service unavailable', { skip }, async () => {
  const f = await fixture();
  try {
    const failing = serviceWith({ fetchImpl: async () => ({ ok: false, status: 502, headers: { get: () => null } }) });
    await assert.rejects(
      failing.fetchTile({ projectId: f.projectId, providerId: 'test', z: 1, x: 0, y: 0 }),
      (error) => error.code === 'MAP_PROVIDER_UNAVAILABLE' && error.status === 503,
    );

    const notImage = serviceWith({
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: (name) => (name === 'content-type' ? 'text/html' : null) }, async arrayBuffer() { return new ArrayBuffer(1); } }),
    });
    await assert.rejects(
      notImage.fetchTile({ projectId: f.projectId, providerId: 'test', z: 1, x: 0, y: 0 }),
      (error) => error.code === 'MAP_PROVIDER_UNAVAILABLE',
    );
  } finally {
    await f.cleanup();
  }
});

test('a provider that forbids caching is fetched every time', { skip }, async () => {
  const f = await fixture();
  try {
    const calls = [];
    const service = serviceWith({ fetchImpl: async (url) => { calls.push(url); return imageResponse(); } });
    const args = { projectId: f.projectId, providerId: 'nocache', z: 1, x: 0, y: 0 };
    assert.equal((await service.fetchTile(args)).cache, 'miss');
    assert.equal((await service.fetchTile(args)).cache, 'miss');
    assert.equal(calls.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('invalid tile coordinates and zoom are refused', { skip }, async () => {
  const f = await fixture();
  try {
    const service = serviceWith({ fetchImpl: async () => imageResponse() });
    await assert.rejects(service.fetchTile({ projectId: f.projectId, providerId: 'test', z: 1, x: -1, y: 0 }), (error) => error.code === 'VALIDATION_FAILED');
    await assert.rejects(service.fetchTile({ projectId: f.projectId, providerId: 'test', z: 99, x: 0, y: 0 }), (error) => error.code === 'VALIDATION_FAILED');
    await assert.rejects(service.fetchTile({ projectId: f.projectId, providerId: 'nope', z: 1, x: 0, y: 0 }), (error) => error.code === 'NOT_FOUND');
  } finally {
    await f.cleanup();
  }
});

test('a burst over the rate limit is refused with a retry delay', { skip }, async () => {
  const f = await fixture();
  try {
    const service = serviceWith({
      fetchImpl: async () => imageResponse(),
      rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }),
    });
    const args = { projectId: f.projectId, userId: f.member.userId, providerId: 'test', z: 2, x: 0, y: 0 };
    await service.fetchTile(args);
    await service.fetchTile({ ...args, x: 1 });
    await assert.rejects(
      service.fetchTile({ ...args, x: 2 }),
      (error) => {
        assert.equal(error.code, 'RATE_LIMITED');
        assert.ok(error.details[0].retry_after_ms > 0);
        return true;
      },
    );
  } finally {
    await f.cleanup();
  }
});

test('project settings round-trip and usage reports the period', { skip }, async () => {
  const f = await fixture();
  try {
    const service = serviceWith({ fetchImpl: async () => imageResponse() });
    assert.equal(await service.getProjectSettings({ projectId: f.projectId }), null);

    const saved = await service.setProjectSettings({
      projectId: f.projectId,
      providerId: 'test',
      style: 'standard',
      tileQuota: 1000,
      actorId: f.member.userId,
    });
    assert.equal(saved.providerId, 'test');
    assert.equal(saved.tileQuota, 1000);
    assert.equal(saved.attributionText, '© Test');

    const reloaded = await service.getProjectSettings({ projectId: f.projectId });
    assert.equal(reloaded.providerId, 'test');

    const usage = await service.getUsage({ projectId: f.projectId });
    assert.ok(usage.periodStart instanceof Date && usage.periodEnd > usage.periodStart);
    assert.deepEqual(usage.counters, []);

    await assert.rejects(
      service.setProjectSettings({ projectId: f.projectId, providerId: 'test', style: 'nope' }),
      (error) => error.code === 'VALIDATION_FAILED',
    );
  } finally {
    await f.cleanup();
  }
});
