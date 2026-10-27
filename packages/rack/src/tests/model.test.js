import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONTRACT_VERSION, RackInputError, createRackModel, createRackPlacement, rackFootprint } from '../index.js';

const fixture = JSON.parse(await readFile(new URL('../../examples/basic-rack.json', import.meta.url), 'utf8'));
const model = () => structuredClone(fixture.model);
const placement = () => structuredClone(fixture.placement);

function invalidField(fn, field) {
  assert.throws(fn, (error) => error instanceof RackInputError
    && error.code === 'RACK_INPUT_INVALID' && error.details[0].field === field);
}

test('the versioned fixture keeps unknown engineering limits explicit', () => {
  assert.equal(fixture.contractVersion, CONTRACT_VERSION);
  const input = model();
  delete input.maxPowerKw;
  const result = createRackModel(input);
  assert.equal(result.maxPowerKw, null);
  assert.equal(result.maxWeightKg, null);
  assert.equal(result.maxCoolingKw, null);
  assert.equal(result.source.kind, 'ASSUMED');
});

test('explicit zero capacity is preserved and negative limits are rejected', () => {
  assert.equal(createRackModel({ ...model(), maxPowerKw: 0 }).maxPowerKw, 0);
  for (const field of ['maxWeightKg', 'maxPowerKw', 'maxCoolingKw']) {
    invalidField(() => createRackModel({ ...model(), [field]: -1 }), field);
    invalidField(() => createRackModel({ ...model(), [field]: Infinity }), field);
  }
});

test('dimensions require positive finite numbers, not coerced strings', () => {
  for (const field of ['widthM', 'depthM']) {
    for (const value of [0, -1, NaN, Infinity, -Infinity, '0.6', null, undefined]) {
      invalidField(() => createRackModel({ ...model(), [field]: value }), field);
    }
  }
});

test('U capacity requires a positive safe integer', () => {
  for (const heightU of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42']) {
    invalidField(() => createRackModel({ ...model(), heightU }), 'heightU');
  }
});

test('a source is required and cannot silently claim a known specification', () => {
  invalidField(() => createRackModel({ ...model(), source: null }), 'source');
  invalidField(() => createRackModel({ ...model(), source: { kind: 'VERIFIED', reference: 'unknown' } }), 'source.kind');
  invalidField(() => createRackModel({ ...model(), source: { kind: 'REFERENCE', reference: ' ' } }), 'source.reference');
});

test('unknown fields fail instead of hiding a misspelled unit or capacity', () => {
  invalidField(() => createRackModel({ ...model(), maxPowerW: 10000 }), 'model.maxPowerW');
  invalidField(() => createRackPlacement({ ...placement(), x: 3 }), 'placement.x');
  invalidField(() => createRackModel({ ...model(), source: { ...model().source, reviewed: true } }), 'source.reviewed');
});

test('identifiers reject invalid values and normalise UUID casing', () => {
  invalidField(() => createRackModel({ ...model(), modelId: 'rack-1' }), 'modelId');
  for (const field of ['rackId', 'planId', 'projectId', 'modelId']) {
    invalidField(() => createRackPlacement({ ...placement(), [field]: '' }), field);
  }
  const uppercase = 'ABCDEFAB-0000-4000-8000-000000000001';
  assert.equal(createRackModel({ ...model(), modelId: uppercase }).modelId, uppercase.toLowerCase());
});

test('names must be bounded non-empty text', () => {
  for (const name of ['', '   ', 'a'.repeat(161), 42]) {
    invalidField(() => createRackModel({ ...model(), name }), 'name');
  }
  assert.equal(createRackPlacement({ ...placement(), name: ' Rack A01 ' }).name, 'Rack A01');
});

test('constructors reject arrays and missing records', () => {
  for (const input of [null, undefined, [], 'rack']) {
    invalidField(() => createRackModel(input), 'model');
    invalidField(() => createRackPlacement(input), 'placement');
  }
});

test('local coordinates permit negative positions but refuse missing or non-finite data', () => {
  assert.equal(createRackPlacement({ ...placement(), xM: -2 }).xM, -2);
  for (const field of ['xM', 'yM']) {
    for (const value of [NaN, Infinity, undefined, null, '2']) {
      invalidField(() => createRackPlacement({ ...placement(), [field]: value }), field);
    }
  }
});

test('rotation and lock defaults do not coerce null or strings', () => {
  const input = placement();
  delete input.rotationDeg;
  delete input.locked;
  assert.equal(createRackPlacement(input).rotationDeg, 0);
  assert.equal(createRackPlacement(input).locked, false);
  for (const rotationDeg of [45, 360, -90, null, '90']) {
    invalidField(() => createRackPlacement({ ...placement(), rotationDeg }), 'rotationDeg');
  }
  for (const locked of [null, 'false', 0]) {
    invalidField(() => createRackPlacement({ ...placement(), locked }), 'locked');
  }
});

test('returned records do not alias caller-owned mutable input', () => {
  const input = model();
  const result = createRackModel(input);
  input.source.reference = 'changed later';
  assert.notEqual(result.source.reference, input.source.reference);
  assert.throws(() => { result.source.kind = 'REFERENCE'; }, TypeError);
  assert.throws(() => { createRackPlacement(placement()).xM = 99; }, TypeError);
});

test('the unrotated footprint is centred at its placement and uses metres', () => {
  const shape = rackFootprint(model(), placement());
  assert.equal(shape.frame, 'ROOM_LOCAL');
  assert.equal(shape.unit, 'm');
  assert.deepEqual(shape.cornersM, [[1.7, 2.4], [2.3, 2.4], [2.3, 3.6], [1.7, 3.6]]);
  assert.deepEqual(shape.frontEdgeM, [[1.7, 2.4], [2.3, 2.4]]);
  assert.deepEqual(shape.boundsM, { minX: 1.7, minY: 2.4, maxX: 2.3, maxY: 3.6 });
});

test('all quarter-turn rotations keep the physical front edge identifiable', () => {
  const spec = { ...model(), widthM: 2, depthM: 4 };
  const expected = [
    [[-1, -2], [1, -2]], [[2, -1], [2, 1]],
    [[1, 2], [-1, 2]], [[-2, 1], [-2, -1]],
  ];
  [0, 90, 180, 270].forEach((rotationDeg, index) => {
    const shape = rackFootprint(spec, { ...placement(), xM: 0, yM: 0, rotationDeg });
    assert.deepEqual(shape.frontEdgeM, expected[index]);
    assert.equal(shape.boundsM.maxX - shape.boundsM.minX, index % 2 ? 4 : 2);
    assert.equal(shape.boundsM.maxY - shape.boundsM.minY, index % 2 ? 2 : 4);
  });
});

test('footprints cannot silently use the wrong model or overflow coordinates', () => {
  invalidField(() => rackFootprint(model(), { ...placement(), modelId: fixture.placement.rackId }), 'modelId');
  invalidField(() => rackFootprint({ ...model(), widthM: Number.MAX_VALUE }, { ...placement(), xM: Number.MAX_VALUE }), 'footprint');
});

test('geometry is immutable and never claims engineering feasibility', () => {
  const shape = rackFootprint(model(), placement());
  assert.throws(() => { shape.cornersM[0][0] = 9; }, TypeError);
  assert.throws(() => { shape.boundsM.minX = 9; }, TypeError);
  assert.equal('valid' in shape, false);
  assert.equal('feasible' in shape, false);
});

test('unrepresentable dimensions are rejected rather than yielding zero-area footprints', () => {
  invalidField(() => rackFootprint({ ...model(), widthM: Number.MIN_VALUE }, placement()), 'footprint');
  invalidField(() => rackFootprint(model(), { ...placement(), xM: 1e100 }), 'footprint');
});
