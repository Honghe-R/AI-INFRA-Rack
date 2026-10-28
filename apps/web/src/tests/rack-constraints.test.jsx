import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RackConstraints } from '../rack/RackConstraints.jsx';
import { RoomFloorplan } from '../rack/RackRoomView.jsx';
import {
  defaultEditorConstraints,
  validateEditorConstraints,
  displayClearanceBands,
  beginLayoutDraft,
  layoutCheckBody,
} from '../rack/edit-layout-state.js';
const obstacle = { obstacleId: 'o', name: 'Column <A>', xM: 5, yM: 5, widthM: 1, depthM: 1 };
const model = { modelId: 'm', widthM: 0.8, depthM: 1.2 };
const rack = { rackId: 'r', modelId: 'm', name: 'A01', xM: 3, yM: 3, rotationDeg: 0 };
test('constraints participate in draft copying and exact save bodies without sharing saved arrays', () => {
  const constraints = {
    ...defaultEditorConstraints(),
    obstacles: [obstacle],
    clearance: { frontM: 1, rearM: 0.5 },
  };
  const draft = beginLayoutDraft({
    planId: 'p',
    version: 4,
    snapshot: { snapshotId: 's' },
    placements: [rack],
    constraints,
  });
  draft.constraints.obstacles[0].xM = 9;
  draft.constraints.clearance.frontM = 2;
  assert.equal(constraints.obstacles[0].xM, 5);
  assert.equal(constraints.clearance.frontM, 1);
  assert.deepEqual(layoutCheckBody(draft).constraints, draft.constraints);
});
test('editor rejects incomplete distances and rectangle dimensions while unknown and zero remain distinct', () => {
  const c = defaultEditorConstraints();
  assert.equal(validateEditorConstraints(c), null);
  assert.equal(validateEditorConstraints({ ...c, clearance: { frontM: 0, rearM: 0 } }), null);
  for (const patch of [
    { source: { kind: 'ASSUMED', reference: ' ' } },
    { obstacles: [{ ...obstacle, widthM: 0 }] },
    { obstacles: [{ ...obstacle, xM: NaN }] },
    { clearance: { frontM: NaN, rearM: 0 } },
    { clearance: { frontM: 11, rearM: 0 } },
  ])
    assert.ok(validateEditorConstraints({ ...c, ...patch }));
});
test('display bands preserve server quarter-turn geometry and never render incomplete numeric inputs', () => {
  const c = { frontM: 1, rearM: 2 };
  const bands = displayClearanceBands({ ...rack, rotationDeg: 90 }, model, c);
  assert.deepEqual(bands[0].points, [
    [4.6, 2.6],
    [4.6, 3.4],
    [3.6, 3.4],
    [3.6, 2.6],
  ]);
  assert.deepEqual(displayClearanceBands(rack, model, null), []);
  assert.equal(displayClearanceBands(rack, model, { frontM: NaN, rearM: 0 }).length, 0);
});
test('constraint inspector labels assumptions, units, coverage and unknown distances and disables writes for viewers', () => {
  const html = renderToStaticMarkup(
    <RackConstraints
      constraints={{
        ...defaultEditorConstraints(),
        obstacles: [obstacle],
        clearance: { frontM: 1, rearM: 0.5 },
      }}
      editable={false}
      selectedId="o"
      extent={{ width: 10, height: 10 }}
    />,
  );
  for (const label of [
    'Planning constraints',
    'Planning input reference',
    'Obstacle coverage',
    'Unknown — unrecorded obstacles may exist',
    'Front clearance (m)',
    'Rear clearance (m)',
    'Obstacle X centre (m)',
    'Obstacle width (m)',
    'Column &lt;A&gt;',
    'Remove obstacle',
    'disabled=""',
  ])
    assert.ok(html.includes(label), label);
});
test('floorplan draws assumption blocks and maintenance bands, highlights obstacle-only diagnostics and omits NaN shapes', () => {
  const html = renderToStaticMarkup(
    <RoomFloorplan
      room={{ name: 'Hall' }}
      view={{
        extentM: { width: 10, height: 10 },
        boundaryLocalM: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
          ],
        },
        areaM2: 100,
        interiorRingCount: 0,
        originProjectedM: [0, 0],
      }}
      sourceGeometry={{}}
      models={[model]}
      placements={[rack]}
      constraints={{
        ...defaultEditorConstraints(),
        obstacles: [obstacle, { ...obstacle, obstacleId: 'bad', xM: NaN }],
        clearance: { frontM: 1, rearM: 0.5 },
      }}
      selectedObstacleId="o"
      report={{ diagnostics: [{ rackIds: [], obstacleIds: ['o'] }] }}
    />,
  );
  for (const text of [
    'rack-maintenance-band front',
    'rack-maintenance-band rear',
    'rack-drawn-obstacle has-issue is-selected',
    'Select obstacle Column &lt;A&gt;',
    'Maintenance: front 1 m / rear 0.5 m',
    'NOT_RUN',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('NaN'));
});
