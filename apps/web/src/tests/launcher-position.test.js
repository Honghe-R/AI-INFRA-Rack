import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  LAUNCHER_DRAG_SLOP_PX,
  LAUNCHER_KEY_STEP_PX,
  LAUNCHER_POSITION_KEY,
  clampOffset,
  dragDelta,
  isDrag,
  nudgeOffset,
  readStoredOffset,
  storeOffset,
} from '../assistant/launcher-position.js';

/**
 * The collapsed launcher is dragged around the canvas, so its geometry decides two things
 * a reader notices immediately: whether the launcher can be pushed off screen (it must
 * not), and whether a click that twitched counts as a move (it must not). Both are pure
 * arithmetic, so they are asserted here rather than through a browser.
 */

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    raw: map,
  };
}

test('the offset is the movement between two pointer positions', () => {
  assert.deepEqual(dragDelta({ x: 10, y: 20 }, { x: 40, y: 5 }), { x: 30, y: -15 });
  // Nothing to measure from, or a coordinate that is not a number: not a drag.
  assert.equal(dragDelta(null, { x: 1, y: 1 }), null);
  assert.equal(dragDelta({ x: 0, y: 0 }, { x: Number.NaN, y: 1 }), null);
});

test('a twitch is a click, not a drag', () => {
  assert.equal(isDrag({ x: 0, y: 0 }), false);
  assert.equal(isDrag({ x: LAUNCHER_DRAG_SLOP_PX, y: 0 }), false, 'exactly at the slop is still a click');
  assert.equal(isDrag({ x: LAUNCHER_DRAG_SLOP_PX + 1, y: 0 }), true);
  // Vertical movement counts too: the launcher is dragged up out of the way most often.
  assert.equal(isDrag({ x: 0, y: -(LAUNCHER_DRAG_SLOP_PX + 1) }), true);
  assert.equal(isDrag(null), false);
});

test('an offset is held inside the room available', () => {
  const bounds = { minX: -100, maxX: 50, minY: -20, maxY: 200 };

  assert.deepEqual(clampOffset({ x: 10, y: 10 }, bounds), { x: 10, y: 10 }, 'a legal offset is untouched');
  assert.deepEqual(clampOffset({ x: 999, y: 999 }, bounds), { x: 50, y: 200 }, 'it stops at the far edge');
  assert.deepEqual(clampOffset({ x: -999, y: -999 }, bounds), { x: -100, y: -20 }, 'and at the near edge');

  // A viewport smaller than the launcher has no legal offset. The far edge wins, so the
  // launcher is never pushed off screen — the worse of the two failures.
  const impossible = { minX: -100, maxX: -300, minY: 0, maxY: -10 };
  const clamped = clampOffset({ x: 0, y: 0 }, impossible);
  assert.ok(clamped.x >= impossible.maxX && clamped.y >= impossible.maxY, 'clamped to the reachable edge');

  // No bounds means no opinion, which is what an unmeasured launcher gets.
  assert.deepEqual(clampOffset({ x: 5, y: 5 }, null), { x: 5, y: 5 });
});

test('the arrow keys move the launcher by one step, and stop at the edge', () => {
  const bounds = { minX: -50, maxX: 50, minY: -50, maxY: 50 };

  assert.deepEqual(nudgeOffset({ x: 0, y: 0 }, 'ArrowRight', { bounds }), { x: LAUNCHER_KEY_STEP_PX, y: 0 });
  assert.deepEqual(nudgeOffset({ x: 0, y: 0 }, 'ArrowUp', { bounds }), { x: 0, y: -LAUNCHER_KEY_STEP_PX });
  // Clamped like a drag, so the keyboard has the same reach and the same limits.
  assert.deepEqual(nudgeOffset({ x: 45, y: 0 }, 'ArrowRight', { bounds }), { x: 50, y: 0 });
  // Any other key is not a move: the handler must not swallow Tab or Enter.
  assert.equal(nudgeOffset({ x: 0, y: 0 }, 'Tab'), null);
  assert.equal(nudgeOffset({ x: 0, y: 0 }, 'Enter'), null);
});

test('the position survives a reload, and malformed storage does not throw', () => {
  const storage = fakeStorage();
  assert.deepEqual(readStoredOffset(storage), { x: 0, y: 0 }, 'nothing stored means the resting place');

  storeOffset({ x: 12.4, y: -30.6 }, storage);
  assert.deepEqual(readStoredOffset(storage), { x: 12, y: -31 }, 'recorded rounded, and read back');

  // A half-written or hand-edited value must not take the composer down with it.
  for (const bad of ['not json', '{}', '{"x":null,"y":2}', '{"x":"5","y":1}', '[1,2]']) {
    const broken = fakeStorage({ [LAUNCHER_POSITION_KEY]: bad });
    assert.deepEqual(readStoredOffset(broken), { x: 0, y: 0 }, `recovers from ${bad}`);
  }

  // Storage that throws (private mode, quota) is survivable in both directions.
  const hostile = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
  };
  assert.deepEqual(readStoredOffset(hostile), { x: 0, y: 0 });
  assert.doesNotThrow(() => storeOffset({ x: 1, y: 1 }, hostile));
});
