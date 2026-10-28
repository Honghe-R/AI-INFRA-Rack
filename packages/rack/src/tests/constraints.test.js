import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  EMPTY_SPATIAL_CONSTRAINTS,
  normalizeSpatialConstraints,
  rackClearanceBands,
  localRectangle,
} from '../index.js';
const obstacle = () => ({
  obstacleId: randomUUID(),
  name: 'Planning column',
  xM: 5,
  yM: 5,
  widthM: 1,
  depthM: 1,
});
const input = () => structuredClone(EMPTY_SPATIAL_CONSTRAINTS);
const rack = { rackId: randomUUID(), xM: 5, yM: 5, rotationDeg: 0 };
const model = { widthM: 2, depthM: 4 };
test('planning constraints retain unknown coverage and null clearance without inventing engineering defaults', () => {
  const c = input();
  const normalized = normalizeSpatialConstraints(c);
  assert.deepEqual(normalized, c);
  assert.equal(normalized.clearance, null);
  assert.equal(normalized.obstacleCoverage, 'UNKNOWN');
  assert.ok(Object.isFrozen(normalized.obstacles));
  assert.equal(normalizeSpatialConstraints({ ...c, clearance: { frontM: 0, rearM: 0 } }).clearance.frontM, 0);
});
test('planning obstacles normalize identities and references without changing callers', () => {
  const o = obstacle();
  const c = {
    ...input(),
    source: { kind: 'ASSUMED', reference: '  Group design assumption ' },
    obstacles: [{ ...o, obstacleId: o.obstacleId.toUpperCase() }],
  };
  const normalized = normalizeSpatialConstraints(c);
  assert.equal(normalized.obstacles[0].obstacleId, o.obstacleId);
  assert.equal(normalized.source.reference, 'Group design assumption');
  assert.notEqual(normalized.obstacles, c.obstacles);
  assert.ok(Object.isFrozen(normalized.obstacles[0]));
  assert.equal(c.source.reference, '  Group design assumption ');
});
test('planning inputs reject incomplete, injected, duplicate and oversized assumptions', () => {
  const c = input(),
    o = obstacle();
  for (const value of [
    null,
    {},
    { ...c, obstacleCoverage: 'COMPLETE' },
    { ...c, source: { kind: 'REFERENCE', reference: 'x' } },
    { ...c, source: { kind: 'ASSUMED', reference: ' ' } },
    { ...c, unknown: 1 },
    { ...c, clearance: undefined },
    { ...c, clearance: { frontM: -1, rearM: 0 } },
    { ...c, clearance: { frontM: 10.01, rearM: 0 } },
    { ...c, clearance: { frontM: '1', rearM: 0 } },
    { ...c, clearance: { frontM: 1, rearM: 0, sideM: 1 } },
    { ...c, obstacles: Array.from({ length: 65 }, obstacle) },
    { ...c, obstacles: [o, o] },
    { ...c, obstacles: [{ ...o, geometry: {} }] },
    { ...c, obstacles: [{ ...o, widthM: 0.00001 }] },
    { ...c, obstacles: [{ ...o, xM: 10001 }] },
    { ...c, obstacles: [{ ...o, depthM: NaN }] },
  ]) {
    assert.throws(() => normalizeSpatialConstraints(value), { code: 'RACK_INPUT_INVALID' });
  }
  assert.equal(
    normalizeSpatialConstraints({ ...c, obstacles: Array.from({ length: 64 }, obstacle) }).obstacles.length,
    64,
  );
});
test('front and rear maintenance bands rotate with exact quarter turns and preserve asymmetric distances', () => {
  const expected = [
    [
      [4, 2],
      [6, 2],
      [6, 3],
      [4, 3],
      [4, 2],
    ],
    [
      [8, 4],
      [8, 6],
      [7, 6],
      [7, 4],
      [8, 4],
    ],
    [
      [6, 8],
      [4, 8],
      [4, 7],
      [6, 7],
      [6, 8],
    ],
    [
      [2, 6],
      [2, 4],
      [3, 4],
      [3, 6],
      [2, 6],
    ],
  ];
  for (const [i, rotationDeg] of [0, 90, 180, 270].entries()) {
    const bands = rackClearanceBands({ ...rack, rotationDeg }, model, { frontM: 1, rearM: 2 });
    assert.equal(bands.length, 2);
    assert.equal(bands[0].side, 'FRONT');
    assert.equal(bands[1].side, 'REAR');
    assert.deepEqual(bands[0].geometry.coordinates[0], expected[i]);
    const points = bands[1].geometry.coordinates[0];
    const xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1]);
    assert.equal((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)), 4);
  }
});
test('null and explicit zero produce no degenerate maintenance polygons; one-sided requirements remain one-sided', () => {
  assert.deepEqual(rackClearanceBands(rack, model, null), []);
  assert.deepEqual(rackClearanceBands(rack, model, { frontM: 0, rearM: 0 }), []);
  assert.deepEqual(
    rackClearanceBands(rack, model, { frontM: 0, rearM: 1 }).map((b) => b.side),
    ['REAR'],
  );
  assert.deepEqual(localRectangle(5, 5, 2, 4).coordinates[0], [
    [4, 3],
    [6, 3],
    [6, 7],
    [4, 7],
    [4, 3],
  ]);
});

test('sub-millimetre planning requirements are rejected instead of producing degenerate bands',()=>{
  assert.throws(()=>normalizeSpatialConstraints({...input(),clearance:{frontM:1e-100,rearM:0}}),{code:'RACK_INPUT_INVALID'});
  assert.equal(normalizeSpatialConstraints({...input(),clearance:{frontM:.001,rearM:0}}).clearance.frontM,.001);
});
