import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createAccountStore, createRackAuthMiddleware, createLoginLimiter, RACK_GATEWAY_TOKEN } from '../lib/rack-auth.mjs';

const password = 'fixture-password-1234';
async function fixture(run) {
  const root = fileURLToPath(new URL('../../.local-runtime/auth-tests/', import.meta.url));
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'case-')), file = join(dir, 'accounts.json');
  let time = Date.now(), server;
  const now = () => time;
  const store = createAccountStore({ file, now });
  const account = { login: 'admin', subject: 'subject-admin', name: 'Admin', organisationId: 'org-a' };
  const activation = await store.provision(account);
  try {
    await run({ store, file, activation, account, advance: ms => { time += ms; }, now,
      start: async validateAccount => {
        const middleware = createRackAuthMiddleware({ store, mint: async subject => `signed:${subject}`, allowedOrigins: ['http://rack.test'], now, validateAccount });
        server = createServer((req, res) => middleware(req, res, () => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ token: req[RACK_GATEWAY_TOKEN] ?? null, clientSubject: req.headers['x-dev-subject'] ?? null, clientAuthorization: req.headers.authorization ?? null }));
        }));
        await new Promise(done => server.listen(0, '127.0.0.1', done));
        const url = `http://127.0.0.1:${server.address().port}`;
        return async (path, body, { cookie, origin = 'http://rack.test', headers = {} } = {}) => {
          const response = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(body ? { origin, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
          return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie'), cache: response.headers.get('cache-control') };
        };
      },
    });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    if (!resolve(dir).startsWith(resolve(root) + '\\') && !resolve(dir).startsWith(resolve(root) + '/')) throw new Error('Unsafe fixture cleanup path.');
    await rm(dir, { recursive: true, force: true });
  }
}

test('one-use activation saves a salted hash, never a default/shared password or raw token', () => fixture(async f => {
  assert.equal((await f.store.activate(f.activation, password)).login, 'admin');
  await assert.rejects(f.store.activate(f.activation, password), { code: 'ACTIVATION_INVALID' });
  const raw = await readFile(f.file, 'utf8');
  assert.ok(!raw.includes(password)); assert.ok(!raw.includes(f.activation));
  assert.match(JSON.parse(raw).accounts[0].passwordHash, /^[\w-]+\.[\w-]+$/);
  await assert.rejects(f.store.provision(f.account), /already activated/);
}));

test('unactivated, unknown and wrong-password accounts cannot sign in; short activation passwords fail', () => fixture(async f => {
  await assert.rejects(f.store.login('admin', password), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(f.store.activate(f.activation, 'short'), { code: 'PASSWORD_POLICY' });
  await f.store.activate(f.activation, password);
  for (const [login, pass] of [['missing', password], ['admin', 'wrong'], ['ADMIN', 'wrong']])
    await assert.rejects(f.store.login(login, pass), { code: 'INVALID_CREDENTIALS' });
  assert.equal((await f.store.login(' ADMIN ', password)).account.login, 'admin');
}));

test('activation expires and provisioning cannot bind another subject or account name', () => fixture(async f => {
  await assert.rejects(f.store.provision({ ...f.account, subject: 'someone-else' }), /already bound/);
  await assert.rejects(f.store.provision({ ...f.account, login: 'another' }), /already bound/);
  f.advance(24 * 60 * 60 * 1000 + 1);
  await assert.rejects(f.store.activate(f.activation, password), { code: 'ACTIVATION_INVALID' });
}));

test('sessions are hashed, survive another store instance, expire and revoke on logout', () => fixture(async f => {
  await f.store.activate(f.activation, password);
  const session = await f.store.login('admin', password);
  assert.equal((await f.store.session(session.raw)).subject, f.account.subject);
  assert.equal((await createAccountStore({ file: f.file, now: f.now }).session(session.raw)).login, 'admin');
  assert.ok(!(await readFile(f.file, 'utf8')).includes(session.raw));
  await f.store.logout(session.raw); assert.equal(await f.store.session(session.raw), null);
  const next = await f.store.login('admin', password);
  f.advance(8 * 60 * 60 * 1000 + 1); assert.equal(await f.store.session(next.raw), null);
}));

test('HTTP gate denies forged identity/bearer headers before login and never exposes other accounts', () => fixture(async f => {
  const request = await f.start();
  const denied = await request('/api/v1/me/permissions', null, { headers: { 'x-dev-subject': 'dev-user', authorization: 'Bearer forged' } });
  assert.equal(denied.status, 401);
  const status = await request('/__auth/session');
  assert.equal(status.cache, 'no-store'); assert.deepEqual(status.body, { data: { mode: 'password', account: null } });
  assert.equal((await request('/__auth/users')).status, 404);
}));

test('HTTP login authenticates once, ignores impersonation, enforces Origin and clears the session on sign-out', () => fixture(async f => {
  const request = await f.start();
  assert.equal((await request('/__auth/activate', { token: f.activation, password })).status, 200);
  const login = await request('/__auth/login', { login: 'admin', password });
  assert.equal(login.status, 200); assert.match(login.cookie, /HttpOnly/); assert.match(login.cookie, /SameSite=Strict/); assert.match(login.cookie, /Max-Age=28800/);
  const cookie = login.cookie.split(';')[0];
  const state = await request('/__auth/session', null, { cookie });
  assert.equal(state.body.data.account.login, 'admin'); assert.ok(!JSON.stringify(state.body).includes('subject-admin'));
  const response = await request('/api/v1/test', null, { cookie, headers: { 'x-dev-subject': 'other-admin', authorization: 'Bearer forged' } });
  assert.deepEqual(response.body, { token: 'signed:subject-admin', clientSubject: null, clientAuthorization: null });
  assert.equal((await request('/api/v1/test', {}, { cookie, origin: 'http://evil.test' })).status, 403);
  assert.equal((await request('/__auth/logout', {}, { cookie, origin: '' })).status, 403);
  const logout = await request('/__auth/logout', {}, { cookie });
  assert.match(logout.cookie, /Max-Age=0/);
  assert.equal((await request('/api/v1/test', null, { cookie })).status, 401);
}));

test('backend account suspension/absence blocks login without creating a session', () => fixture(async f => {
  await f.store.activate(f.activation, password);
  const request = await f.start(async () => { throw Object.assign(new Error('Invalid credentials.'), { status: 401, code: 'INVALID_CREDENTIALS' }); });
  const response = await request('/__auth/login', { login: 'admin', password });
  assert.equal(response.status, 401); assert.equal(response.cookie, null);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).sessions, []);
}));

test('bounded login limiter blocks repeated attempts and recovers after the window', () => {
  let time = 0; const limit = createLoginLimiter({ now: () => time, max: 2, windowMs: 100 });
  limit('account'); limit('account'); assert.throws(() => limit('account'), { status: 429 });
  time = 101; assert.doesNotThrow(() => limit('account'));
});
