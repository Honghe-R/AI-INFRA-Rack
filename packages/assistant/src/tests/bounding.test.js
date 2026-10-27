import test from 'node:test';
import assert from 'node:assert/strict';
import { boundValue, byteLength, sanitize } from '../bounding.js';

test('sanitize survives cycles, exotic types, and hostile getters', () => {
  const cyclic = { name: 'a' };
  cyclic.self = cyclic;
  const hostile = {};
  Object.defineProperty(hostile, 'trap', {
    enumerable: true,
    get() {
      throw new Error('nope');
    },
  });

  const value = sanitize({
    cyclic,
    big: 10n,
    bytes: Buffer.from('abc'),
    map: new Map([['k', 'v']]),
    set: new Set([1, 2]),
    when: new Date('2026-01-01T00:00:00Z'),
    bad: new Date('nope'),
    fn: () => {},
    p: Promise.resolve(1),
    hostile,
  });

  assert.equal(value.cyclic.self, '[circular]');
  assert.equal(value.big, '10n');
  assert.equal(value.bytes, '[bytes:3]');
  assert.deepEqual(value.map['[map]'], [['k', 'v']]);
  assert.deepEqual(value.set['[set]'], [1, 2]);
  assert.equal(value.when, '2026-01-01T00:00:00.000Z');
  assert.equal(value.bad, '[invalid date]');
  assert.equal(value.fn, '[function]');
  assert.equal(value.p, '[promise]');
  assert.equal(value.hostile.trap, '[unreadable]');
});

test('a result within budget is untouched', () => {
  const bounded = boundValue({ items: [1, 2, 3] }, { limitBytes: 1_000, kind: 'tool', label: 'list' });
  assert.equal(bounded.truncated, false);
  assert.deepEqual(bounded.value, { items: [1, 2, 3] });
  assert.equal(bounded.notice, null);
});

test('an over-budget result shrinks into a self-describing envelope', () => {
  const big = { items: Array.from({ length: 5_000 }, (_, index) => ({ entityId: `e-${index}`, name: `Entity ${index}`, blob: 'x'.repeat(200) })) };
  const bounded = boundValue(big, { limitBytes: 2_000, kind: 'tool', label: 'list_containers' });

  assert.equal(bounded.truncated, true);
  assert.equal(bounded.value.truncated, true);
  assert.equal(bounded.value.tool, 'list_containers');
  assert.ok(bounded.value.original_bytes > bounded.value.limit_bytes);
  assert.ok(bounded.value.note.includes('truncated'));
  assert.ok(byteLength(bounded.value) <= 2_000, 'the envelope respects the limit');
  assert.ok(['TOOL_RESULT_TRUNCATED', 'TOOL_RESULT_OVER_BUDGET'].includes(bounded.notice.code));
});

test('the final hard clamp guarantees the limit even for an enormous digest', () => {
  const huge = { blob: 'y'.repeat(50_000) };
  const bounded = boundValue(huge, { limitBytes: 64, kind: 'digest', label: 'digest' });
  assert.ok(byteLength(bounded.value) <= 64);
  assert.equal(bounded.value.data, '[omitted]');
});
