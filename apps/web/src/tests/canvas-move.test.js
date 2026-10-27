import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { overlayFor } from '../map/facility-overlay.js';

/**
 * Dragging a placed object.
 *
 * The gesture itself needs a pointer, but two things about it are decided in code and were each
 * wrong once: a press that never became a drag must stay the selection click it has always been,
 * and the object drawn under the pointer must be the object whose move is staged. Both are
 * asserted here; the pointer path is exercised in the browser.
 */
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const canvas = readFileSync(new URL('../map/BasemapCanvas.jsx', import.meta.url), 'utf8');
const surface = readFileSync(new URL('../map/SiteFacilityCanvas.jsx', import.meta.url), 'utf8');

const feature = (entityId, geometryId, extra = {}) => ({
  geometryId,
  entityId,
  entityType: 'BUILDING',
  role: 'FOOTPRINT',
  displayName: 'Data Centre A',
  geojson4326: { type: 'Point', coordinates: [0, 0] },
  ...extra,
});

const VIEW = { lon: 0, lat: 0, zoom: 12 };
const SIZE = { widthPx: 800, heightPx: 600 };

test('a shape being moved is drawn at its own projection plus the drag', () => {
  const at = (moving) => overlayFor([feature('b-1', 'g-1')], { view: VIEW, ...SIZE, moving })[0];

  // At rest the shape is not wrapped, so a still map pays nothing for the gesture.
  assert.equal(at(null).translate, null);

  const carried = at({ entityId: 'b-1', dxPx: 40, dyPx: -15 });
  assert.equal(carried.translate, 'translate(40 -15)');
  // The preview must not move the projection: the shape's own coordinates are untouched, and a
  // release turns the same pixel delta into the world delta that gets staged.
  assert.deepEqual(carried.geometry.points[0], at(null).geometry.points[0]);
});

test('only the object being dragged is carried', () => {
  const shapes = overlayFor([feature('b-1', 'g-1'), feature('b-2', 'g-2')], {
    view: VIEW,
    ...SIZE,
    moving: { entityId: 'b-1', dxPx: 10, dyPx: 10 },
  });

  assert.equal(shapes.find((shape) => shape.entityId === 'b-1').translate, 'translate(10 10)');
  assert.equal(shapes.find((shape) => shape.entityId === 'b-2').translate, null, 'its neighbour stays put');
});

test('a press only arms a move on the selected shape of an editable revision', () => {
  // The condition, read from the source because it is a prop decision rather than a projection:
  // an unselected shape must select on click as it always has, and a read-only revision must not
  // offer a gesture the server would refuse.
  assert.match(canvas, /const canMove = movable && shape\.selected && shape\.entityId !== null;/);
  assert.match(
    canvas,
    /onPointerDown: canMove \? \(event\) => onMovePointerDown\(event, shape\) : stopDrag/,
    'the press is armed only where a move is offered',
  );
  assert.match(surface, /movable=\{canWrite && !blockedReason\}/);
});

test('a release decides once, so a click does not deselect what it just selected', () => {
  // A physical click arrives twice: once as the release this component handles, and once as the
  // compatibility click the browser synthesises. Without the flag the selection toggles straight
  // back off, and the object can never be picked up.
  assert.match(canvas, /handledRef\.current = true;/);
  assert.match(canvas, /if \(handledRef\.current\) \{\s*handledRef\.current = false;\s*return;\s*\}/);
});

test('a press that never became a drag does not pan the map either', () => {
  // The threshold is what keeps the two gestures apart: before it the press is still a click, so
  // the map must not have moved.
  assert.match(canvas, /const MOVE_THRESHOLD_PX = 3;/);
  assert.match(canvas, /if \(drag\.kind === 'move'\) \{/);
  assert.match(canvas, /if \(drag\.moving\) onMoveEnd\?\.\(\{ entityId: drag\.entityId, dxPx: drag\.dxPx, dyPx: drag\.dyPx \}\);/);
  assert.match(canvas, /dragRef\.current = \{ x: event\.clientX, y: event\.clientY \};\s*pan\(dxPx, dyPx\);/);
});

test('the move stages one set_geometry per part, through the composition both surfaces share', () => {
  assert.match(surface, /const moveParts = \(entityId\) => features\.filter\(\(record\) => record\.entityId === entityId\);/);
  assert.match(surface, /fromPx: \{ xPx: 0, yPx: 0 \}/, 'the delta is measured from the press, not from the last move');
  // The payload — role, ordinal, position, and the record's own heights — is not written here any
  // more: `placementChanges` states it once for both surfaces, and the parity fixture runs the
  // client's copy and the server's through the same cases. What this pins is that the canvas
  // stages *that* composition rather than a hand-rolled change that can drift from the server's.
  assert.match(surface, /for \(const change of placementChanges\(plan\)\) authoring\.stage\(change\);/);
  assert.match(surface, /import \{ movePlan, placementChanges \} from '\.\/move-geometry\.js';/);
});

test('a staged move is drawn at its intended place, marked as pending', () => {
  // The gesture ends when the pointer comes up, but the edit is not committed until the author
  // says so. Between those two moments the object has to be where the commit will put it.
  assert.match(surface, /const stagedEdits = useMemo\(\(\) => stagedGeometry\(authoring\.changes\), \[authoring\.changes\]\);/);
  assert.match(surface, /edits=\{stagedEdits\}/);
  assert.match(canvas, /edits = null,/);
  assert.match(canvas, /edits,\s*\}\);/);

  // Amber and dashed, which is what this stylesheet already means by "not settled" — the same
  // pair as the pending chip, and the dash the unfinished polygon uses.
  const edited = css.slice(css.indexOf('.canvas__feature--edited {'), css.indexOf('.canvas__feature--edited {') + 260);
  assert.match(edited, /stroke:\s*var\(--warning\)/);
  assert.match(edited, /stroke-dasharray:/);
  // Selected and pending at once still reads as both.
  assert.match(css, /\.canvas__feature--edited\.canvas__feature--selected/);
});

test('the map says a move is in progress, which is where the user looks for the way out', () => {
  assert.match(canvas, /Moving \{moving\.name \?\? 'object'\} — release to stage it/);
  // Escape abandons it, the same way it abandons a draw.
  assert.match(surface, /if \(!mappingTool && !moveDraft\) return undefined;/);
  // And a revision switch cannot leave a draft addressing a graph that is no longer on screen.
  assert.match(surface, /useEffect\(\(\) => \{\s*setMoveDraft\(null\);\s*\}, \[revisionId\]\);/);
  // The chip is a stated mode, so it is styled like the drawing chip rather than invented.
  assert.match(css, /\.canvas__mode--centre/);
});
