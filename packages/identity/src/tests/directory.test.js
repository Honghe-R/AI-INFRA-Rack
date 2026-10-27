import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserDirectory } from '../index.js';

function fakeRepository({ existing = null, created = { userId: 'u-new' } } = {}) {
  const calls = { find: 0, create: 0 };
  return {
    calls,
    async findUserBySubject() {
      calls.find += 1;
      return existing;
    },
    async createUser(args) {
      calls.create += 1;
      return { ...created, subject: args.subject };
    },
  };
}

test('an existing active user is returned', async () => {
  const repository = fakeRepository({ existing: { userId: 'u-1', status: 'ACTIVE' } });
  const directory = createUserDirectory({ repository });
  assert.deepEqual(await directory.resolveUser({ subject: 's-1' }), { user: { userId: 'u-1', status: 'ACTIVE' } });
  assert.equal(repository.calls.create, 0);
});

test('a disabled account is reported as suspended, not as unknown', async () => {
  const repository = fakeRepository({ existing: { userId: 'u-1', status: 'SUSPENDED' } });
  const directory = createUserDirectory({ repository });
  assert.deepEqual(await directory.resolveUser({ subject: 's-1' }), { suspended: true });
});

test('an unknown subject is provisioned on first sign-in', async () => {
  const repository = fakeRepository();
  const directory = createUserDirectory({ repository, autoProvision: true });
  const result = await directory.resolveUser({ subject: 's-2', email: 'c@example.test' });
  assert.equal(result.user.userId, 'u-new');
  assert.equal(result.user.subject, 's-2');
  assert.equal(repository.calls.create, 1);
});

test('provisioning can be disabled', async () => {
  const repository = fakeRepository();
  const directory = createUserDirectory({ repository, autoProvision: false });
  assert.equal(await directory.resolveUser({ subject: 's-3' }), null);
  assert.equal(repository.calls.create, 0);
});

test('an identity without a subject resolves to nothing', async () => {
  const repository = fakeRepository();
  const directory = createUserDirectory({ repository });
  assert.equal(await directory.resolveUser({}), null);
  assert.equal(await directory.resolveUser(null), null);
});
