import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecretNotFoundError,
  cachedSecretProvider,
  createSecretProvider,
  envSecretProvider,
  fileSecretProvider,
} from '../index.js';

test('env provider reads and requires', async () => {
  const provider = envSecretProvider({ MAP_PROVIDER_KEY: 'value-1' });
  assert.equal(await provider.get('MAP_PROVIDER_KEY'), 'value-1');
  assert.equal(await provider.get('MISSING'), undefined);
  await assert.rejects(() => provider.require('MISSING'), SecretNotFoundError);
});

test('env provider treats an empty value as absent', async () => {
  const provider = envSecretProvider({ EMPTY: '' });
  assert.equal(await provider.get('EMPTY'), undefined);
});

test('env provider honours a prefix', async () => {
  const provider = envSecretProvider({ SECRET_DB: 'v' }, { prefix: 'SECRET_' });
  assert.equal(await provider.get('DB'), 'v');
});

test('file provider reads one file per secret and ignores missing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-infra-secrets-'));
  try {
    await writeFile(join(dir, 'LICENCE_KEY'), 'licence-value\n');
    const provider = fileSecretProvider(dir);
    assert.equal(await provider.get('LICENCE_KEY'), 'licence-value');
    assert.equal(await provider.get('ABSENT'), undefined);
    await assert.rejects(() => provider.require('ABSENT'), SecretNotFoundError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file provider rejects a path-traversal secret name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-infra-secrets-'));
  try {
    const provider = fileSecretProvider(dir);
    await assert.rejects(() => provider.get('../../etc/passwd'), /Invalid secret name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('caching provider resolves once per TTL and clears on demand', async () => {
  let calls = 0;
  let clock = 1_000;
  const provider = cachedSecretProvider(
    {
      async get() {
        calls += 1;
        return `value-${calls}`;
      },
    },
    { ttlMs: 100, now: () => clock },
  );

  assert.equal(await provider.get('A'), 'value-1');
  assert.equal(await provider.get('A'), 'value-1');
  assert.equal(calls, 1);

  clock += 101;
  assert.equal(await provider.get('A'), 'value-2');
  assert.equal(calls, 2);

  provider.clear('A');
  assert.equal(await provider.get('A'), 'value-3');
  assert.equal(calls, 3);
});

test('createSecretProvider accepts an injected provider', async () => {
  const provider = createSecretProvider({ source: { get: async () => 'injected' } });
  assert.equal(await provider.require('ANY'), 'injected');
});

test('createSecretProvider rejects an unknown source', () => {
  assert.throws(() => createSecretProvider({ source: 'vault-of-doom' }), /Unknown secret source/);
});
