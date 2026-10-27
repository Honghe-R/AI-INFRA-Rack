import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../index.js';

test('caches a value for its TTL and reloads after expiry', async () => {
  let clock = 1_000;
  let loads = 0;
  const cache = createTtlCache({ ttlMs: 100, now: () => clock });
  const load = async () => {
    loads += 1;
    return `v${loads}`;
  };

  assert.equal(await cache.getOrLoad('a', load), 'v1');
  assert.equal(await cache.getOrLoad('a', load), 'v1');
  assert.equal(loads, 1);

  clock += 101;
  assert.equal(await cache.getOrLoad('a', load), 'v2');
  assert.equal(loads, 2);
});

test('de-duplicates concurrent loads behind one promise', async () => {
  let loads = 0;
  const cache = createTtlCache({ ttlMs: 1_000 });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const load = async () => {
    loads += 1;
    await gate;
    return 'value';
  };

  const pending = Promise.all([
    cache.getOrLoad('k', load),
    cache.getOrLoad('k', load),
    cache.getOrLoad('k', load),
  ]);
  release();
  const [a, b, c] = await pending;
  assert.deepEqual([a, b, c], ['value', 'value', 'value']);
  assert.equal(loads, 1, 'concurrent callers must share one load');
});

test('invalidates entries by tag', async () => {
  const cache = createTtlCache({ ttlMs: 1_000 });
  await cache.getOrLoad('d1', async () => 1, ['user:u1', 'project:p1']);
  await cache.getOrLoad('d2', async () => 2, ['user:u2', 'project:p1']);
  await cache.getOrLoad('d3', async () => 3, ['user:u3', 'project:p2']);
  assert.equal(cache.size, 3);

  assert.equal(cache.invalidateTags('user:u1'), 1);
  assert.equal(cache.size, 2);
  assert.equal(cache.invalidateTags(['project:p1']), 1);
  assert.equal(cache.size, 1);
  assert.equal(cache.invalidateTags('user:nobody'), 0);
});

test('clear empties the cache and reports the count', async () => {
  const cache = createTtlCache({ ttlMs: 1_000 });
  await cache.getOrLoad('a', async () => 1);
  await cache.getOrLoad('b', async () => 2);
  assert.equal(cache.clear(), 2);
  assert.equal(cache.size, 0);
});

test('peek and set support callers that must not cache negatives', async () => {
  let clock = 1_000;
  const cache = createTtlCache({ ttlMs: 100, now: () => clock });
  assert.equal(cache.peek('missing'), undefined);

  cache.set('k', 'value', ['tag']);
  assert.equal(cache.peek('k'), 'value');

  clock += 101;
  assert.equal(cache.peek('k'), undefined, 'an expired entry must not be returned');
  assert.equal(cache.size, 0, 'peek must evict an expired entry');
});

test('bounds the number of entries', async () => {
  const cache = createTtlCache({ ttlMs: 1_000, maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) await cache.getOrLoad(`k${i}`, async () => i);
  assert.ok(cache.size <= 3, `expected at most 3 entries, saw ${cache.size}`);
});
