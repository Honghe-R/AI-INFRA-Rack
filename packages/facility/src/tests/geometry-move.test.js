import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { placementChanges, placementPlan, translateGeometry } from '../geometry-move.js';

/**
 * The shared move fixture, generated from this implementation and asserted on both sides of the
 * web/server boundary. The client keeps its own copy of these functions because the browser
 * cannot import a server package, so this is what keeps the two from drifting: an edit to either
 * copy fails its own test against the fixture, not the other surface silently.
 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/geometry-move-cases.json', import.meta.url), 'utf8'));

test('the facility move composition matches the shared fixture', () => {
  for (const entry of fixture.cases) {
    const plan = placementPlan(entry.records, (geojson) => translateGeometry(geojson, entry.delta));
    assert.deepEqual(plan, entry.plan, `${entry.name}: plan`);
    assert.deepEqual(placementChanges(plan), entry.changes, `${entry.name}: changes`);
  }
});

test('a move never mutates the record it was given', () => {
  const original = { type: 'Point', coordinates: [1, 2] };
  const moved = translateGeometry(original, { deltaLon: 5, deltaLat: -5 });

  assert.deepEqual(original.coordinates, [1, 2], 'the revision record is left as it was');
  assert.deepEqual(moved.coordinates, [6, -3]);
});

test('the plan carries each part heights, so a move cannot flatten a geometry', () => {
  const plan = placementPlan(
    [
      {
        entityId: 'b-1',
        role: 'FOOTPRINT',
        ordinal: 1,
        geojson4326: { type: 'Point', coordinates: [0, 0] },
        elevationBaseM: 0,
        elevationTopM: 12,
        heightM: 12,
      },
    ],
    (geojson) => geojson,
  );

  assert.deepEqual(plan[0], {
    entityId: 'b-1',
    role: 'FOOTPRINT',
    ordinal: 1,
    elevationBaseM: 0,
    elevationTopM: 12,
    heightM: 12,
    geojson: { type: 'Point', coordinates: [0, 0] },
  });
});
