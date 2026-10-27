import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticator, requireMfa, requireRecentAuth } from '../index.js';

const USER = { userId: 'u-1', status: 'ACTIVE' };

function fakeVerifier(result) {
  return {
    async verify() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function fakeDirectory(result) {
  return { async resolveUser() { return result; } };
}

function context(authorization) {
  return { request: { headers: authorization ? { authorization } : {} } };
}

async function expectError(fn) {
  try {
    await fn();
    assert.fail('expected an error');
  } catch (error) {
    return error;
  }
}

test('a missing token is 401', async () => {
  const authenticator = createAuthenticator({ verifier: fakeVerifier({ subject: 's' }), directory: fakeDirectory({ user: USER }) });
  const error = await expectError(() => authenticator.authenticate(context()));
  assert.equal(error.status, 401);
  assert.equal(error.code, 'UNAUTHENTICATED');
});

test('a non-bearer header is treated as no token', async () => {
  const authenticator = createAuthenticator({ verifier: fakeVerifier({ subject: 's' }), directory: fakeDirectory({ user: USER }) });
  const error = await expectError(() => authenticator.authenticate(context('Basic abc')));
  assert.equal(error.status, 401);
});

test('an invalid or expired token is 403, not 401', async () => {
  const failure = Object.assign(new Error('expired'), { code: 'ERR_JWT_EXPIRED' });
  const authenticator = createAuthenticator({ verifier: fakeVerifier(failure), directory: fakeDirectory({ user: USER }) });
  const error = await expectError(() => authenticator.authenticate(context('Bearer token')));
  assert.equal(error.status, 403, 'credentials were presented and rejected: re-prompting for a login is wrong');
  assert.equal(error.code, 'INVALID_TOKEN');
  assert.equal(error.details[0].reason, 'ERR_JWT_EXPIRED');
});

test('an unknown user record is 401', async () => {
  const authenticator = createAuthenticator({ verifier: fakeVerifier({ subject: 's' }), directory: fakeDirectory(null) });
  const error = await expectError(() => authenticator.authenticate(context('Bearer token')));
  assert.equal(error.status, 401);
});

test('a suspended account is 403 and is not confused with a bad token', async () => {
  const authenticator = createAuthenticator({ verifier: fakeVerifier({ subject: 's' }), directory: fakeDirectory({ suspended: true }) });
  const error = await expectError(() => authenticator.authenticate(context('Bearer token')));
  assert.equal(error.status, 403);
  assert.equal(error.code, 'ACCOUNT_SUSPENDED');
});

test('a valid token attaches the user and the auth-strength context', async () => {
  const authenticator = createAuthenticator({
    verifier: fakeVerifier({ subject: 's', mfa: true, authenticatedAt: 1_700_000_000 }),
    directory: fakeDirectory({ user: USER }),
  });
  const ctx = context('Bearer token');
  const user = await authenticator.authenticate(ctx);
  assert.equal(user, USER);
  assert.equal(ctx.user, USER);
  assert.deepEqual(ctx.authStrength, { mfa: true, authenticatedAt: 1_700_000_000 });
});

test('a directory failure is 500, never an unhandled crash and never an allow', async () => {
  const authenticator = createAuthenticator({
    verifier: fakeVerifier({ subject: 's' }),
    directory: { async resolveUser() { throw new Error('database down'); } },
  });
  const error = await expectError(() => authenticator.authenticate(context('Bearer token')));
  assert.equal(error.status, 500);
});

test('the MFA guard fails closed without a second factor', async () => {
  const guard = requireMfa();
  assert.equal(guard({ authStrength: { mfa: true } }), true);
  const error = await expectError(async () => guard({ authStrength: { mfa: false } }));
  assert.equal(error.status, 403);
  assert.equal(error.code, 'MFA_REQUIRED');
  await expectError(async () => guard({}));
});

test('the recent-auth guard enforces a freshness window', async () => {
  const guard = requireRecentAuth(300);
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.equal(guard({ authStrength: { authenticatedAt: nowSeconds - 10 } }), true);

  const error = await expectError(async () => guard({ authStrength: { authenticatedAt: nowSeconds - 3_600 } }));
  assert.equal(error.status, 403);
  assert.equal(error.code, 'REAUTHENTICATION_REQUIRED');

  await expectError(async () => guard({ authStrength: {} }));
});
