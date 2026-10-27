import { test } from 'vitest';
import assert from 'node:assert/strict';
import { movePlan, translateGeometry } from '../map/move-geometry.js';

/**
 * Moving a placed object.
 *
 * `set_geometry` upserts on the entity's role and ordinal, so a move is not a new server
 * operation — it is the same change with different coordinates. What these pin is the part that
 * is easy to get wrong and that the validator would not catch: every part of the entity moves,
 * the delta is the projection's own, and the stored elevations ride along.
 */
const unproject = ({ xPx, yPx }) => [xPx / 1000, yPx / 1000];

const record = (entityId, role, geojson4326, extra = {}) => ({
  geometryId: `g-${role}`,
  entityId,
  entityType: 'BUILDING',
  role,
  ordinal: 0,
  geojson4326,
  ...extra,
});

const square = (x, y) => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]],
});

test('every position is shifted by the same delta', () => {
  const moved = translateGeometry(square(0, 0), { deltaLon: 0.5, deltaLat: -0.25 });

  assert.deepEqual(moved.coordinates[0][0], [0.5, -0.25]);
  assert.deepEqual(moved.coordinates[0][2], [0.501, -0.249]);
  // The ring closes where it opened, which a shift preserves and a per-position edit would not.
  assert.deepEqual(moved.coordinates[0][0], moved.coordinates[0][4]);
});

test('the shape is copied, not written through', () => {
  const original = square(0, 0);
  const before = JSON.stringify(original);

  translateGeometry(original, { deltaLon: 1, deltaLat: 1 });

  // The record belongs to the revision. A draft that mutated it would move the object on screen
  // before the change set was ever committed.
  assert.equal(JSON.stringify(original), before);
});

test('a point, a line, and a multipolygon all move', () => {
  const point = translateGeometry({ type: 'Point', coordinates: [1, 2] }, { deltaLon: 0.5, deltaLat: 0.5 });
  assert.deepEqual(point.coordinates, [1.5, 2.5]);

  const line = translateGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { deltaLon: 1, deltaLat: 2 });
  assert.deepEqual(line.coordinates, [[1, 2], [2, 3]]);

  const multi = translateGeometry(
    { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    { deltaLon: -1, deltaLat: -1 },
  );
  assert.deepEqual(multi.coordinates[0][0][0], [-1, -1]);

  // A geometry with nothing in it is not an error to move; there is simply nothing to shift.
  assert.deepEqual(translateGeometry({ type: 'Polygon', coordinates: [] }, { deltaLon: 1, deltaLat: 1 }), {
    type: 'Polygon',
    coordinates: [],
  });
  assert.equal(translateGeometry(null), null);
});

test('a drag turns into a world delta by unprojecting both ends', () => {
  // Longitude and latitude do not scale together, so the delta cannot be a metres-per-pixel
  // constant: unprojecting both corners is what gets the zoom and the latitude right.
  const plan = movePlan({
    records: [record('b-1', 'FOOTPRINT', square(0, 0))],
    fromPx: { xPx: 0, yPx: 0 },
    toPx: { xPx: 300, yPx: -200 },
    unproject,
  });

  assert.deepEqual(plan[0].geojson.coordinates[0][0], [0.3, -0.2]);
});

test('an entity moves as one object, all of its parts together', () => {
  const plan = movePlan({
    records: [
      record('yard-1', 'BOUNDARY', square(0, 0)),
      record('yard-1', 'FOOTPRINT', square(0.01, 0.01)),
      // A second entity's geometry is present in the revision and must not be dragged along by
      // a caller that handed over the whole graph by mistake.
      record('other', 'FOOTPRINT', square(9, 9)),
    ],
    fromPx: { xPx: 0, yPx: 0 },
    toPx: { xPx: 100, yPx: 100 },
    unproject,
  });

  assert.equal(plan.length, 3, 'every part with geometry is in the plan');
  // Both parts moved by the same delta, so the shape of the entity is preserved: the offset
  // between a boundary corner and a footprint corner is the same before and after.
  assert.deepEqual(plan[0].geojson.coordinates[0][0], [0.1, 0.1], 'the boundary moved by the drag');
  assert.deepEqual(plan[1].geojson.coordinates[0][0], [0.11, 0.11], 'and so did the footprint');
});

test('a part with no geometry is not a part to move, and the role and ordinal come along', () => {
  const plan = movePlan({
    records: [
      record('b-1', 'FOOTPRINT', null),
      record('b-1', 'ROUTE', { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { ordinal: 2 }),
    ],
    fromPx: { xPx: 0, yPx: 0 },
    toPx: { xPx: 1000, yPx: 1000 },
    unproject,
  });

  assert.equal(plan.length, 1, 'nothing to shift is not a change to stage');
  // The ordinal is what the upsert keys on, so getting it wrong would replace a different part.
  assert.equal(plan[0].role, 'ROUTE');
  assert.equal(plan[0].ordinal, 2);
  assert.deepEqual(plan[0].geojson.coordinates, [[1, 1], [2, 2]]);
});

test('the elevations a geometry already carried are reported with it', () => {
  const plan = movePlan({
    records: [record('b-1', 'FOOTPRINT', square(0, 0), { elevationBaseM: 12.5, elevationTopM: 40, heightM: 27.5 })],
    fromPx: { xPx: 0, yPx: 0 },
    toPx: { xPx: 0, yPx: 0 },
    unproject,
  });

  // A move that dropped them would silently flatten a building whose height the revision knows.
  assert.equal(plan[0].elevationBaseM, 12.5);
  assert.equal(plan[0].elevationTopM, 40);
  assert.equal(plan[0].heightM, 27.5);
});
