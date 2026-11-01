import test from 'node:test';
import assert from 'node:assert/strict';
import { localLoginEnabled, withLocalLogin } from '../lib/rack-local-login.mjs';
const base = { login: async () => { throw Object.assign(new Error('denied'), { status: 401 }); }, session: async () => null, logout: async () => {} };

test('only local development enables the temporary login, with an explicit disable switch', () => {
  assert.equal(localLoginEnabled({ mode: 'development', host: '127.0.0.1' }), true);
  for (const options of [{mode:'production',host:'127.0.0.1'}, {mode:'development',host:'0.0.0.0'}, {mode:'development',host:true}, {mode:'development',host:'127.0.0.1',enabled:false}]) assert.equal(localLoginEnabled(options), false);
});
test('local 111 login validates backend identity, persists until expiry, and revokes on sign-out', async () => {
  let now = 0, checked = 0;
  const store = withLocalLogin(base, { enabled: true, organisationId: 'local-org', now: () => now });
  const result = await store.login('111', '111', async account => { checked++; assert.equal(account.subject, 'dev-user'); }, '127.0.0.1');
  assert.equal(checked, 1); assert.equal((await store.session(result.raw)).organisationId, 'local-org');
  await store.logout(result.raw); assert.equal(await store.session(result.raw), null);
  const next = await store.login('111', '111', async () => {}, '::1'); now += 8 * 60 * 60 * 1000;
  assert.equal(await store.session(next.raw), null);
});
test('disabled, wrong-password, remote and unverifiable logins fail; sessions never survive disable/restart', async () => {
  const store = withLocalLogin(base, { enabled: true });
  for (const [password, remote] of [['wrong','127.0.0.1'],['111','192.168.1.2']]) await assert.rejects(store.login('111', password, async () => {}, remote), {status:401});
  await assert.rejects(withLocalLogin(base).login('111','111',async()=>{},'127.0.0.1'), {status:401});
  await assert.rejects(store.login('111','111',null,'127.0.0.1'), /verification is required/);
  await assert.rejects(store.login('111','111',async()=>{throw new Error('Backend offline');},'127.0.0.1'), /Backend offline/);
  const result = await store.login('111','111',async()=>{},'127.0.0.1');
  assert.equal(await withLocalLogin(base,{enabled:true}).session(result.raw),null);
  assert.equal(await withLocalLogin(base).session(result.raw),null);
});
