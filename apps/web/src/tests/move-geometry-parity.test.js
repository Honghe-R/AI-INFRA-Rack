import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { placementChanges, placementPlan, translateGeometry } from '../map/move-geometry.js';

/**
 * The client's move composition is a copy of the server's — the browser cannot import a server
 * package — so one fixture is run through both. Its expected values were generated from
 * `packages/facility/src/geometry-move.js`, and `packages/facility/src/tests/geometry-move.test.js`
 * asserts the same file, so an edit to either copy fails a test rather than drifting silently and
 * giving the two surfaces different results for the same edit.
 *
 * The fixture is read as *data*: importing it would be reaching across the boundary the
 * import-boundary test exists to protect.
 */
const FIXTURE = fileURLToPath(
  new URL('../../../../packages/facility/src/tests/fixtures/geometry-move-cases.json', import.meta.url),
);

test('the client move composition matches the shared fixture', async () => {
  const { cases } = JSON.parse(await readFile(FIXTURE, 'utf8'));

  for (const entry of cases) {
    const plan = placementPlan(entry.records, (geojson) => translateGeometry(geojson, entry.delta));
    assert.deepEqual(plan, entry.plan, `${entry.name}: plan`);
    assert.deepEqual(placementChanges(plan), entry.changes, `${entry.name}: changes`);
  }
});

test('the plan stages the identical change the server would commit', () => {
  const plan = placementPlan(
    [
      {
        entityId: 'yard-1',
        role: 'BOUNDARY',
        ordinal: 0,
        geojson4326: { type: 'Point', coordinates: [1, 1] },
        elevationBaseM: 0,
        elevationTopM: 12,
        heightM: 12,
      },
    ],
    (geojson) => geojson,
  );

  assert.deepEqual(placementChanges(plan), [
    {
      kind: 'set_geometry',
      entity_ref: { entity_id: 'yard-1' },
      payload: {
        role: 'BOUNDARY',
        ordinal: 0,
        geojson_4326: { type: 'Point', coordinates: [1, 1] },
        elevation_base_m: 0,
        elevation_top_m: 12,
        height_m: 12,
      },
    },
  ]);
});
