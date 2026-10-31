import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { createAssistantHost, createDefaultCatalog } from '@ai-infra/assistant';
import { createLogger, errors } from '@ai-infra/core';
import { createAssistantConnections } from '../services/assistant-connections.js';
import { createAssistantFetch, normalizeAssistantEndpoint, publicAddress } from '../services/assistant-endpoint.js';
import { createAssistantHostFor } from '../assistant-host.js';
import { registerAssistantRoutes } from '../routes/assistant.js';
import { createRouter } from '../router.js';
import { createApp } from '../app.js';

const keyA = 'synthetic-key-A-not-a-real-credential';
const keyB = 'synthetic-key-B-not-a-real-credential';
const config = { name: 'Test connection', endpoint: 'https://models.example.com/v1', model: 'test-model', apiKey: keyA, version: null };
const reply = (content = 'OK', tool_calls = null) => ({ choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) } }], usage: { total_tokens: 1 } });
function fakeFetch(fn = async () => reply()) {
  return async (url, options) => ({ ok: true, status: 200, json: async () => fn(url, options), text: async () => '' });
}
async function fixture(t, options = {}) {
  const base = resolve('.local-runtime');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'assistant-test-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${base}${sep}assistant-test-`));
    await rm(root, { recursive: true, force: true });
  });
  const directories = { directory: join(root, 'connections'), keyDirectory: join(root, 'keys') };
  return { root, directories, service: createAssistantConnections({ ...directories, fetchImpl: fakeFetch(), ...options }) };
}

test('personal configuration survives a new service instance; no plaintext credential on disk or in metadata', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.service.get('alice'), null);
  const saved = await f.service.save('alice', config);
  assert.equal(saved.version, 1);
  assert.equal(saved.endpoint, 'https://models.example.com/v1/chat/completions');
  assert.equal(JSON.stringify(saved).includes(keyA), false);
  assert.equal(Object.hasOwn(saved, 'secretRef'), false);
  const restarted = createAssistantConnections({ ...f.directories, fetchImpl: fakeFetch(async (_url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${keyA}`); return reply();
  }) });
  assert.deepEqual(await restarted.get('alice'), saved);
  assert.equal(await restarted.get('bob'), null);
  await assert.rejects(restarted.open('bob', saved.connectionId, saved.version), (e) => e.status === 404);
  const opened = await restarted.open('alice', saved.connectionId, saved.version);
  await opened.provider.complete({ messages: [{ role: 'user', content: 'Hi' }] }); opened.release();
  for (const name of await readdir(f.directories.directory)) {
    if (name.endsWith('.json')) assert.ok(!(await readFile(join(f.directories.directory, name), 'utf8')).includes(keyA));
  }
  for (const name of await readdir(join(f.directories.directory, 'vault'))) {
    assert.ok(!(await readFile(join(f.directories.directory, 'vault', name), 'utf8')).includes(keyA));
  }
});

test('keeping a key, rotation, optimistic concurrency, cancellation and deletion do not cross users', async (t) => {
  const f = await fixture(t);
  const a = await f.service.save('alice', config);
  const b = await f.service.save('bob', { ...config, apiKey: keyB });
  const openA = await f.service.open('alice', a.connectionId, a.version);
  const openB = await f.service.open('bob', b.connectionId, b.version);
  const kept = await f.service.save('alice', { ...config, apiKey: '', version: 1 });
  assert.equal(openA.signal.aborted, true);
  assert.equal(openB.signal.aborted, false);
  await assert.rejects(openA.provider.complete({}), (e) => e.status === 412);
  await assert.rejects(f.service.save('alice', { ...config, version: 1 }), (e) => e.status === 412);
  const competing = await Promise.allSettled([f.service.save('alice', { ...config, version: kept.version }), f.service.save('alice', { ...config, version: kept.version })]);
  assert.equal(competing.filter((r) => r.status === 'fulfilled').length, 1);
  const current = await f.service.get('alice');
  await assert.rejects(f.service.remove('alice', 1), (e) => e.status === 412);
  await f.service.remove('alice', current.version);
  assert.equal(await f.service.get('alice'), null);
  assert.equal((await f.service.get('bob')).connectionId, b.connectionId);
  openA.release(); openB.release();
});

test('missing master key never regenerates over another user encrypted credentials', async (t) => {
  const f = await fixture(t);
  const saved = await f.service.save('alice', config);
  await unlink(join(f.directories.keyDirectory, 'master.key'));
  await assert.rejects(f.service.open('alice', saved.connectionId, saved.version), (e) => e.code === 'ASSISTANT_KEY_UNAVAILABLE');
  await assert.rejects(f.service.save('bob', config), (e) => e.code === 'ASSISTANT_KEY_UNAVAILABLE');
  await assert.rejects(readFile(join(f.directories.keyDirectory, 'master.key')), (e) => e.code === 'ENOENT');
  assert.equal(await f.service.get('bob'), null);
});

test('authenticated encryption rejects altered ciphertext without revealing provider details', async (t) => {
  const f = await fixture(t);
  const saved = await f.service.save('alice', config);
  const vault = join(f.directories.directory, 'vault');
  const path = join(vault, (await readdir(vault))[0]);
  const sealed = JSON.parse(await readFile(path, 'utf8'));
  sealed.tag = Buffer.alloc(16).toString('base64'); await writeFile(path, JSON.stringify(sealed));
  await assert.rejects(f.service.open('alice', saved.connectionId, 1), (e) => e.code === 'ASSISTANT_KEY_UNAVAILABLE' && !e.message.includes(keyA));
});

test('invalid input cannot save partial configuration or change provider implementation', async (t) => {
  const f = await fixture(t);
  for (const body of [{ ...config, apiKey: '' }, { ...config, apiKey: '********' }, { ...config, endpoint: 'http://localhost:1' }, { ...config, provider: 'custom-code' }, { ...config, model: '\ninvalid' }]) {
    await assert.rejects(f.service.save('alice', body), (e) => e.status === 400);
    assert.equal(await f.service.get('alice'), null);
  }
});

test('synthetic test proves tool-call round trip and preserves configured connection', async (t) => {
  const calls = [];
  const f = await fixture(t, { fetchImpl: fakeFetch(async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (calls.length === 1) return reply(null, [{ id: 'ping-1', type: 'function', function: { name: 'connection_ping', arguments: '{"token":"rack-test"}' } }]);
    assert.equal(body.messages.at(-1).role, 'tool'); return reply('OK');
  }) });
  const saved = await f.service.save('alice', config);
  const result = await f.service.test('alice', { connectionId: saved.connectionId, version: saved.version });
  assert.equal(result.toolRoundTrip, true);
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(calls).includes('projectId'));
  assert.deepEqual(await f.service.get('alice'), saved);
  await assert.rejects(f.service.test('alice', { connectionId: saved.connectionId, version: 1 }), (e) => e.status === 429);
});

test('ordinary chat response is not reported as successful agent tool compatibility', async (t) => {
  const f = await fixture(t);
  const saved = await f.service.save('alice', config);
  const result = await f.service.test('alice', { connectionId: saved.connectionId, version: 1 });
  assert.equal(result.chat, true); assert.equal(result.toolRoundTrip, false);
});

test('untrusted provider errors during testing never echo key or response body', async (t) => {
  const f = await fixture(t, { fetchImpl: async () => { throw Object.assign(new Error(`secret ${keyA}`), { status: 429, body: keyA }); } });
  const saved = await f.service.save('alice', config);
  await assert.rejects(f.service.test('alice', { connectionId: saved.connectionId, version: 1 }), (e) => e.code === 'ASSISTANT_CONNECTION_TEST_FAILED' && !JSON.stringify(e).includes(keyA) && !e.message.includes(keyA));
});

test('endpoint normalization rejects credential URLs, private IPs, alternate schemes and duplicate suffixes', () => {
  assert.equal(normalizeAssistantEndpoint('https://gateway.example/v1/'), 'https://gateway.example/v1/chat/completions');
  assert.equal(normalizeAssistantEndpoint('https://gateway.example/v1/chat/completions'), 'https://gateway.example/v1/chat/completions');
  for (const endpoint of ['file:///tmp/model', 'https://key@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/#key', 'https://127.1', 'https://[::ffff:127.0.0.1]', 'https://169.254.169.254', 'https://localhost']) {
    assert.throws(() => normalizeAssistantEndpoint(endpoint), (e) => e.status === 400);
  }
  for (const address of ['127.0.0.1', '10.1.1.1', '100.64.1.1', '::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('DNS with any private result and lookup cancellation fail before opening a socket', async () => {
  const fetch = createAssistantFetch({ lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(fetch('https://gateway.example/v1'), (e) => e.status === 400);
  const controller = new AbortController();
  const slow = createAssistantFetch({ lookupImpl: () => new Promise(() => {}) });
  const pending = slow('https://gateway.example/v1', { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
});

async function serverAt(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('chat route validates modes before opening a connection and forwards valid modes', async (t) => {
  const router = createRouter(), received = [];
  let opened = 0;
  registerAssistantRoutes(router, { orchestrator: {}, resolveTurn: async () => {
    opened++;
    return { release() {}, orchestrator: { runTurn: async input => { received.push(input); return { status: 'ok' }; } } };
  } });
  const logger = createLogger({ sink: { log() {}, warn() {}, error() {} }, level: 'error' });
  const base = await serverAt(t, createApp({ router, logger,
    authenticator: { async authenticate(ctx) { ctx.user = { userId: 'authenticated-user' }; } } }));
  const call = async (mode, stream = false) => {
    const res = await fetch(`${base}/api/v1/assistant/chat${stream ? '?stream=1' : ''}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }],
        context_key: 'rack-test', context: { surface: 'rack' }, ...(mode === undefined ? {} : { permission_mode: mode }) }) });
    return { status: res.status, body: await res.text() };
  };
  for (const stream of [false, true]) for (const invalid of [null, '', 'admin', {}, true]) {
    const result = await call(invalid, stream);
    assert.equal(result.status, 400);
    assert.match(result.body, /ASSISTANT_PERMISSION_MODE_INVALID/);
  }
  assert.equal(opened, 0);
  for (const stream of [false, true]) for (const mode of [undefined, 'read_only', 'ask', 'full']) {
    assert.equal((await call(mode, stream)).status, 200);
    assert.equal(received.at(-1).permissionMode, mode ?? 'ask');
    assert.equal(received.at(-1).context.userId, 'authenticated-user');
  }
});

test('administrator origin allowlist permits a local gateway; redirects and oversized responses are blocked', async (t) => {
  let mode = 'ok';
  const base = await serverAt(t, (req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); }
    else { res.end(mode === 'large' ? 'x'.repeat(100) : '{"ok":true}'); }
  });
  const fetch = createAssistantFetch({ allowedOrigins: [base], maxBytes: 30 });
  assert.deepEqual(await (await fetch(`${base}/v1`)).json(), { ok: true });
  mode = 'redirect'; await assert.rejects(fetch(`${base}/v1`), (e) => e.code === 'ASSISTANT_REDIRECT_BLOCKED');
  mode = 'large'; await assert.rejects(fetch(`${base}/v1`), /size limit/);
});

test('unconfigured deployment still builds a host when personal setup is enabled', async (t) => {
  const f = await fixture(t);
  const host = await createAssistantHostFor({ config: {}, pool: null, secrets: null, guard: null, connections: f.service });
  assert.ok(host.resolveTurn); assert.equal(host.provider.host, null);
});

test('connection HTTP lifecycle is authenticated, owner-scoped, versioned and never returns submitted keys', async (t) => {
  const f = await fixture(t);
  const router = createRouter();
  registerAssistantRoutes(router, { orchestrator: {}, connections: f.service });
  const logger = createLogger({ sink: { log() {}, warn() {}, error() {} }, level: 'error' });
  const base = await serverAt(t, createApp({ router, logger, authenticator: { async authenticate(ctx) {
    if (!ctx.headers['x-test-user']) throw errors.unauthorized();
    ctx.user = { userId: ctx.headers['x-test-user'] };
  } } }));
  const request = async (user, method = 'GET', body) => {
    const response = await fetch(`${base}/api/v1/assistant/connection`, { method,
      headers: { ...(user ? { 'x-test-user': user } : {}), 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(payload).includes(keyA));
    return { status: response.status, data: payload.data };
  };
  assert.equal((await request(null)).status, 401);
  assert.equal((await request('alice')).data.connection, null);
  const saved = await request('alice', 'PUT', config);
  assert.equal(saved.status, 200); assert.equal(saved.data.connection.hasKey, true);
  assert.equal((await request('bob')).data.connection, null);
  assert.equal((await request('alice', 'PUT', config)).status, 412);
  assert.equal((await request('alice', 'DELETE', { version: 2 })).status, 412);
  assert.equal((await request('alice', 'DELETE', { version: 1 })).status, 200);
  assert.equal((await request('alice')).data.connection, null);
});

test('authenticated routes use persisted owner connection, enforce session binding and redact real orchestrator output', async (t) => {
  const f = await fixture(t, { fetchImpl: fakeFetch(async (_url, options) => {
    const key = options.headers.authorization.slice(7);
    return reply(`Model response ${key}`);
  }) });
  const a = await f.service.save('alice', config);
  const b = await f.service.save('bob', { ...config, apiKey: keyB });
  const router = createRouter();
  registerAssistantRoutes(router, {
    orchestrator: { runTurn() { throw new Error('Unexpected shared provider.'); } }, connections: f.service,
    resolveTurn: async ({ userId, connectionId, connectionVersion }) => {
      const connection = await f.service.open(userId, connectionId, connectionVersion);
      const host = createAssistantHost({ provider: connection.provider, ...createDefaultCatalog(),
        resolveScope: async () => ({ surface: 'site_facility', workspaceId: 'project' }), authorize: async () => true, redact: connection.redact });
      return { ...host, models: connection.models, model: connection.model, connectionId, connectionVersion,
        redact: connection.redact, release: connection.release, signal: connection.signal };
    },
  });
  const logger = createLogger({ sink: { log() {}, warn() {}, error() {} }, level: 'error' });
  const base = await serverAt(t, createApp({ router, logger, authenticator: { async authenticate(ctx) {
    if (!ctx.headers['x-test-user']) throw new Error('Missing test identity');
    ctx.user = { userId: ctx.headers['x-test-user'] };
  } } }));
  const call = async (user, path, body) => {
    const res = await fetch(`${base}/api/v1/assistant/${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-test-user': user, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
  };
  const info = await call('alice', 'provider');
  assert.equal(info.body.data.connectionId, a.connectionId); assert.equal(info.cache, 'no-store');
  assert.ok(!JSON.stringify(info).includes(keyA));
  const bodyFor = (connection) => ({ connection_id: connection.connectionId, connection_version: connection.version,
    context_key: `project|connection:${connection.connectionId}:${connection.version}|model:test-model`, context: {}, messages: [{ role: 'user', content: 'Hi' }] });
  const results = await Promise.all([call('alice', 'chat', bodyFor(a)), call('bob', 'chat', bodyFor(b))]);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.ok(!JSON.stringify(result).includes(keyA)); assert.ok(!JSON.stringify(result).includes(keyB));
    assert.match(JSON.stringify(result), /redacted/);
  }
  assert.equal((await call('bob', 'chat', bodyFor(a))).status, 404);
  assert.equal((await call('alice', 'chat', { ...bodyFor(a), context_key: 'old-context' })).status, 400);
  assert.equal((await call('alice', 'chat', { ...bodyFor(a), apiKey: 'not-accepted' })).status, 400);
});
