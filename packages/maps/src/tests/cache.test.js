import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, createTileCache } from '../cache.js';

test('a cached tile is returned until its lifetime expires', () => {
  let clock = 1_000;
  const cache = createTileCache({ now: () => clock });
  const coordinates = { providerId: 'p', style: 'standard', z: 1, x: 0, y: 0 };

  assert.equal(cache.set(coordinates, { bytes: 'x' }, 10), true);
  assert.deepEqual(cache.get(coordinates), { bytes: 'x' }, 'the stored value is returned, not the internal entry');
  clock += 10_001;
  assert.equal(cache.get(coordinates), null, 'the entry expired');
});

test('a zero lifetime is never stored', () => {
  const cache = createTileCache();
  assert.equal(cache.set({ providerId: 'p', style: null, z: 0, x: 0, y: 0 }, { bytes: 'x' }, 0), false);
  assert.equal(cache.size, 0);
});

test('the cache evicts the least recently used entry at capacity', () => {
  const cache = createTileCache({ maxEntries: 2 });
  const base = { providerId: 'p', style: null, z: 0 };
  cache.set({ ...base, x: 0, y: 0 }, { id: 1 }, 60);
  cache.set({ ...base, x: 1, y: 0 }, { id: 2 }, 60);
  cache.get({ ...base, x: 0, y: 0 }); // refresh x=0
  cache.set({ ...base, x: 2, y: 0 }, { id: 3 }, 60);
  assert.ok(cache.get({ ...base, x: 0, y: 0 }), 'the refreshed entry survives');
  assert.equal(cache.get({ ...base, x: 1, y: 0 }), null, 'the least recently used entry was evicted');
});

test('the rate limiter allows a burst and reports a retry delay', () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => clock });
  assert.equal(limiter.check('k').allowed, true);
  assert.equal(limiter.check('k').allowed, true);
  const denied = limiter.check('k');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0);

  clock = 1_001;
  assert.equal(limiter.check('k').allowed, true, 'the window slid');
  assert.equal(limiter.check('other').allowed, true, 'keys are independent');
});
