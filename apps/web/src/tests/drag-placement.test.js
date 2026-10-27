import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canDropOn, draggedEntityId } from '../map/drag-placement.js';

/**
 * The drop guard, and the bug it exists to prevent.
 *
 * The palette's rows dragged and nothing could be placed, because the `dragover` handler decided
 * by reading `dataTransfer.getData('text/plain')` — which every browser returns empty during a
 * drag, by design. The guard never passed, `preventDefault` never ran, the browser cancelled the
 * drop, and no drop event was ever dispatched. These tests pin the rule: the payload is not read
 * while the drag is in flight, and the type list is.
 */
const node = (name) => {
  const marker = { name };
  return { name, contains: (child) => child !== null && child.inside === marker, marker };
};
const insideSurface = (surface) => ({ inside: surface.marker });
const item = { entityId: 'u-1', role: 'CONNECTION_POINT', geometryType: 'POINT' };

test('a drag our own row started is accepted over the drawing surface', () => {
  const surface = node('surface');

  assert.equal(canDropOn({ carrying: item, target: insideSurface(surface), surface }), true);
});

test('the decision never consults the drag, because a drag carries nothing readable', () => {
  // The measured behaviour of a real mouse-driven drag in Chrome: over every `dragover` on the
  // map, `types` was `['chromium/x-drag-id']` and `getData('text/plain')` was `''`. Neither the
  // payload nor the type the row declared is available while the drag is in flight, so a guard
  // that reads either refuses the gesture and no drop is ever dispatched. This is the regression:
  // the first attempt at this feature guarded on `getData`, then on `types`, and both refused
  // every real drag. The signature is the assertion — there is nothing to read.
  const surface = node('surface');

  assert.equal(canDropOn({ target: insideSurface(surface), surface }), false, 'nothing was picked up');
  assert.equal(canDropOn({ carrying: null, target: insideSurface(surface), surface }), false);
  assert.equal(canDropOn({ carrying: item, target: insideSurface(surface), surface }), true, 'only our own gesture');
});

test('a release outside the drawing surface is refused, whoever asks', () => {
  const surface = node('surface');
  const elsewhere = node('inspector');
  const target = { inside: node('other').marker };

  // The listener is on the frame, which also holds the side column and the toolbar around it.
  assert.equal(canDropOn({ carrying: item, target, surface }), false);
  assert.equal(canDropOn({ carrying: item, target: elsewhere, surface }), false);
  assert.equal(canDropOn({ carrying: item, target: null, surface }), false);
  assert.equal(canDropOn({ carrying: item, target: insideSurface(surface), surface: null }), false);
  // A drag that is only passing over the map must not be refused the moment it leaves.
  assert.equal(canDropOn({ carrying: item, target: insideSurface(elsewhere), surface: elsewhere }), true);
});

test('the payload is what a drop reads, and the pointer is the second answer', () => {
  assert.equal(draggedEntityId({ carried: 'u-1', dragged: item }), 'u-1');
  // A drop delivered with an empty `dataTransfer` is still a placement: the pointer said so
  // when it picked the row up.
  assert.equal(draggedEntityId({ carried: '', dragged: item }), 'u-1');
  assert.equal(draggedEntityId({ carried: '', dragged: null }), null);
  assert.equal(draggedEntityId({}), null);
});

test('neither handler reads the drag while it is in flight', () => {
  const source = readFileSync(new URL('../map/SiteFacilityCanvas.jsx', import.meta.url), 'utf8');
  const allowDrop = source.slice(source.indexOf('const allowDrop = (event) =>'));

  // The one place a payload may be read is the drop handler. The `dragover` handler may still
  // set `dropEffect` — that is the cursor the user sees, not a read — but it must never ask the
  // drag what it is carrying, because over a real drag the answer is always empty.
  assert.equal(
    allowDrop.slice(0, allowDrop.indexOf('\n  };')).includes('getData'),
    false,
    'dragover must not read the payload — nothing about it is readable yet',
  );
  assert.match(source.slice(source.indexOf('const dropOnMap')), /getData\('text\/plain'\)/, 'the drop reads it');
  assert.match(allowDrop, /draggingItemRef\.current/, 'the guard is our own memory of the gesture');
});
