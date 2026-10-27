import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPermissionClient } from '../rbac/client.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return handler(url, calls.length);
  };
  return { calls, fetchImpl };
}

test('can() reports the server decision', async () => {
  const { fetchImpl } = recordingFetch(() => response(200, { data: { allowed: true } }));
  const client = createPermissionClient({ fetchImpl });
  assert.equal(await client.can('facility.read'), true);

  const denied = createPermissionClient({ fetchImpl: async () => response(200, { data: { allowed: false } }) });
  assert.equal(await denied.can('facility.publish'), false);
});

test('a non-OK response fails closed and reports "could not determine"', async () => {
  const client = createPermissionClient({ fetchImpl: async () => response(500, {}) });
  const result = await client.check('facility.read');
  assert.equal(result.allowed, false);
  assert.equal(result.determined, false);
});

test('a transport failure fails closed and reports "could not determine"', async () => {
  const client = createPermissionClient({
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  const result = await client.check('facility.read');
  assert.equal(result.allowed, false);
  assert.equal(result.determined, false);
});

test('the local key set proves unscoped positives without a request', async () => {
  const { calls, fetchImpl } = recordingFetch(() => response(200, { data: { allowed: false } }));
  const client = createPermissionClient({ fetchImpl });
  client.setUnscopedKeys(['facility.read']);

  assert.equal(await client.can('facility.read'), true);
  assert.equal(calls.length, 0, 'a positive from the key set must not hit the network');
});

test('a key-set miss falls through to the server rather than denying', async () => {
  const { calls, fetchImpl } = recordingFetch(() => response(200, { data: { allowed: true } }));
  const client = createPermissionClient({ fetchImpl });
  client.setUnscopedKeys(['facility.read']);

  assert.equal(await client.can('facility.publish'), true);
  assert.equal(calls.length, 1, 'a miss must be asked, not assumed false');
});

test('a scoped call never uses the unscoped fast path', async () => {
  const { calls, fetchImpl } = recordingFetch(() => response(200, { data: { allowed: true } }));
  const client = createPermissionClient({ fetchImpl });
  client.setUnscopedKeys(['facility.read']);

  await client.can('facility.read', { projectId: 'p-1' });
  assert.equal(calls.length, 1, 'a scoped question is a different question');
  assert.ok(calls[0].includes('project_id=p-1'));
});

test('decisions are cached by full identity, including scope', async () => {
  const { calls, fetchImpl } = recordingFetch(() => response(200, { data: { allowed: true } }));
  const client = createPermissionClient({ fetchImpl });

  await client.can('facility.read', { projectId: 'p-1' });
  await client.can('facility.read', { projectId: 'p-1' });
  assert.equal(calls.length, 1);

  await client.can('facility.read', { projectId: 'p-2' });
  assert.equal(calls.length, 2);
  await client.can('facility.read');
  assert.equal(calls.length, 3, 'an unscoped question is a distinct identity');
});

test('an undetermined result is not cached', async () => {
  let failing = true;
  const client = createPermissionClient({
    fetchImpl: async () => {
      if (failing) throw new Error('network down');
      return response(200, { data: { allowed: true } });
    },
  });

  assert.equal((await client.check('facility.read')).determined, false);
  failing = false;
  assert.equal((await client.check('facility.read')).allowed, true, 'a transient outage must not stick');
});

test('concurrent identical checks share one request', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { calls, fetchImpl } = recordingFetch(async () => {
    await gate;
    return response(200, { data: { allowed: true } });
  });
  const client = createPermissionClient({ fetchImpl });

  const pending = Promise.all([client.can('facility.read'), client.can('facility.read'), client.can('facility.read')]);
  release();
  assert.deepEqual(await pending, [true, true, true]);
  assert.equal(calls.length, 1);
});

test('invalidate clears cached decisions and the key set', async () => {
  const { calls, fetchImpl } = recordingFetch(() => response(200, { data: { allowed: true } }));
  const client = createPermissionClient({ fetchImpl });
  client.setUnscopedKeys(['facility.read']);

  await client.can('facility.publish');
  assert.equal(client.cacheSize, 1);
  assert.equal(client.invalidate(), 1);

  assert.equal(await client.can('facility.read'), true, 'the fast path is gone but the server still answers');
  assert.equal(calls.length, 2);
});

test('the key set answers an unscoped positive synchronously', () => {
  const client = createPermissionClient({
    fetchImpl: async () => {
      throw new Error('the fast path must not fetch');
    },
  });
  client.setUnscopedKeys(['facility.read']);

  assert.equal(client.hasUnscopedKey('facility.read'), true);
  assert.equal(client.hasUnscopedKey('facility.publish'), false, 'a miss is not a denial, it is an unknown');
  client.invalidate();
  assert.equal(client.hasUnscopedKey('facility.read'), false, 'a demotion clears the fast path');
});

test('loadUnscopedKeys seeds the fast path from the server', async () => {
  const { fetchImpl } = recordingFetch((url) =>
    url.includes('/me/permissions?') || url.endsWith('/me/permissions')
      ? response(200, { data: { keys: ['facility.read', 'asset.read'] } })
      : response(200, { data: { allowed: false } }),
  );
  const client = createPermissionClient({ fetchImpl });
  const keys = await client.loadUnscopedKeys();
  assert.deepEqual([...keys].sort(), ['asset.read', 'facility.read']);
  assert.equal(await client.can('facility.read'), true);
});

test('loadUnscopedKeys returns null when the server cannot answer', async () => {
  const client = createPermissionClient({ fetchImpl: async () => response(503, {}) });
  assert.equal(await client.loadUnscopedKeys(), null);
});
