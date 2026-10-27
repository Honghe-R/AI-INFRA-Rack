import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RackInputError, createRoomSnapshot, checkRackPlacement, MAX_ROOM_OBSTACLES, SPATIAL_RULES,
} from '../index.js';

const roomFixture = JSON.parse(await readFile(new URL('../../examples/rectangular-room.json', import.meta.url), 'utf8'));
const rackFixture = JSON.parse(await readFile(new URL('../../examples/basic-rack.json', import.meta.url), 'utf8'));
const room = () => structuredClone(roomFixture);
const model = () => ({ ...structuredClone(rackFixture.model), widthM: 2, depthM: 2 });
const placement = () => ({ ...structuredClone(rackFixture.placement), xM: 2, yM: 3 });
const otherId = 'abcdefab-0000-4000-8000-000000000099';
const check = (roomInput = room(), where = placement(), spec = model()) => checkRackPlacement(roomInput, spec, where);

function invalidField(fn, field) {
  assert.throws(fn, error => error instanceof RackInputError
    && error.code === 'RACK_INPUT_INVALID' && error.details[0].field === field);
}

test('room snapshot keeps explicit local units, origin, provenance and versioned facility input', () => {
  const result = createRoomSnapshot(room());
  assert.equal(result.contractVersion, 1);
  assert.equal(result.unit, 'm');
  assert.equal(result.frame, 'ROOM_LOCAL');
  assert.equal(result.originDescription, roomFixture.originDescription);
  assert.deepEqual(result.facilityInput, roomFixture.facilityInput);
  assert.equal(result.source.kind, 'ASSUMED');
  assert.deepEqual(createRoomSnapshot(JSON.parse(JSON.stringify(result))), result);
});

test('snapshot copies and deeply freezes nested bounds, obstacles and provenance', () => {
  const raw = room();
  const before = structuredClone(raw);
  const result = createRoomSnapshot(raw);
  assert.deepEqual(raw, before);
  raw.boundaryM.maxX = 100;
  raw.obstacles[0].boundsM.minX = 99;
  raw.facilityInput.revisionEtag = 'changed';
  raw.source.kind = 'REFERENCE';
  assert.equal(result.boundaryM.maxX, 10);
  assert.equal(result.obstacles[0].boundsM.minX, 4);
  assert.equal(result.facilityInput.revisionEtag, before.facilityInput.revisionEtag);
  for (const value of [result, result.boundaryM, result.obstacles, result.obstacles[0], result.obstacles[0].boundsM, result.source, result.facilityInput]) {
    assert.ok(Object.isFrozen(value));
  }
});

test('missing records, unknown polygon input, unsupported versions, units and coordinate frames are rejected', () => {
  for (const value of [undefined, null, [], 'room']) invalidField(() => createRoomSnapshot(value), 'room');
  invalidField(() => createRoomSnapshot({ ...room(), polygon: [[0, 0], [10, 8]] }), 'room.polygon');
  for (const contractVersion of [undefined, 2, '1']) invalidField(() => createRoomSnapshot({ ...room(), contractVersion }), 'contractVersion');
  for (const unit of [undefined, 'mm', 'degrees']) invalidField(() => createRoomSnapshot({ ...room(), unit }), 'unit');
  for (const frame of [undefined, 'WGS84', 'EPSG:32618']) invalidField(() => createRoomSnapshot({ ...room(), frame }), 'frame');
});

test('snapshot identity, descriptive fields and provenance cannot be absent or fabricated as verified', () => {
  invalidField(() => createRoomSnapshot({ ...room(), snapshotId: 'room-1' }), 'snapshotId');
  for (const name of [undefined, '', 'x'.repeat(161)]) invalidField(() => createRoomSnapshot({ ...room(), name }), 'name');
  for (const originDescription of [null, '', 'x'.repeat(513)]) invalidField(() => createRoomSnapshot({ ...room(), originDescription }), 'originDescription');
  invalidField(() => createRoomSnapshot({ ...room(), facilityInput: {} }), 'facilityInput.projectId');
  invalidField(() => createRoomSnapshot({ ...room(), source: null }), 'source');
  invalidField(() => createRoomSnapshot({ ...room(), source: { kind: 'VERIFIED', reference: 'claim' } }), 'source.kind');
  invalidField(() => createRoomSnapshot({ ...room(), source: { kind: 'REFERENCE', reference: ' ' } }), 'source.reference');
});

test('rectangles reject nonfinite values, wrong types, zero, reversed and overflowing extents', () => {
  for (const boundaryM of [undefined, null, [], 'bounds']) invalidField(() => createRoomSnapshot({ ...room(), boundaryM }), 'boundaryM');
  for (const key of ['minX', 'minY', 'maxX', 'maxY']) {
    for (const value of [undefined, null, NaN, Infinity, '2']) {
      invalidField(() => createRoomSnapshot({ ...room(), boundaryM: { ...room().boundaryM, [key]: value } }), `boundaryM.${key}`);
    }
  }
  for (const boundaryM of [
    { minX: 0, minY: 0, maxX: 0, maxY: 8 },
    { minX: 10, minY: 0, maxX: 0, maxY: 8 },
    { minX: 0, minY: 8, maxX: 10, maxY: 8 },
    { minX: 0, minY: 8, maxX: 10, maxY: 0 },
    { minX: -Number.MAX_VALUE, minY: 0, maxX: Number.MAX_VALUE, maxY: 8 },
  ]) invalidField(() => createRoomSnapshot({ ...room(), boundaryM }), 'boundaryM');
  invalidField(() => createRoomSnapshot({ ...room(), boundaryM: { ...room().boundaryM, width: 10 } }), 'boundaryM.width');
});

test('negative local coordinates are supported without silently moving the origin', () => {
  const input = { ...room(), boundaryM: { minX: -10, minY: -8, maxX: 0, maxY: 0 }, obstacles: [] };
  assert.equal(check(input, { ...placement(), xM: -2, yM: -3 }).status, 'CHECKED_SCOPE_CLEAR');
});

test('obstacle array and completeness declaration are required; sparse arrays cannot hide missing data', () => {
  for (const obstacles of [undefined, null, {}, new Array(1)]) {
    invalidField(() => createRoomSnapshot({ ...room(), obstacles }), Array.isArray(obstacles) ? 'obstacles[0]' : 'obstacles');
  }
  for (const obstacleCoverage of [undefined, null, true, 'PARTIAL']) {
    invalidField(() => createRoomSnapshot({ ...room(), obstacleCoverage }), 'obstacleCoverage');
  }
  invalidField(() => createRoomSnapshot({ ...room(), obstacles: new Array(MAX_ROOM_OBSTACLES + 1) }), 'obstacles');
});

test('obstacle schema, identities, names and bounds are checked rather than ignored', () => {
  const base = room().obstacles[0];
  for (const [entry, field] of [
    [null, 'obstacles[0]'],
    [{ ...base, obstacleId: 'column' }, 'obstacles[0].obstacleId'],
    [{ ...base, name: '' }, 'obstacles[0].name'],
    [{ ...base, hidden: true }, 'obstacles[0].hidden'],
    [{ ...base, boundsM: { ...base.boundsM, maxX: '5' } }, 'obstacles[0].boundsM.maxX'],
    [{ ...base, boundsM: { minX: 4, maxX: 4, minY: 2, maxY: 4 } }, 'obstacles[0].boundsM'],
  ]) invalidField(() => createRoomSnapshot({ ...room(), obstacles: [entry] }), field);
});

test('obstacle identities are unique after UUID normalization; overlapping distinct obstacles remain valid', () => {
  const first = { ...room().obstacles[0], obstacleId: otherId };
  invalidField(() => createRoomSnapshot({ ...room(), obstacles: [first, { ...first, obstacleId: otherId.toUpperCase() }] }), 'obstacles[1].obstacleId');
  assert.equal(createRoomSnapshot({ ...room(), obstacles: [first, room().obstacles[0]] }).obstacles.length, 2);
});

test('obstacles outside the room are refused while obstacles touching walls are accepted', () => {
  const base = room().obstacles[0];
  invalidField(() => createRoomSnapshot({ ...room(), obstacles: [{ ...base, boundsM: { minX: -1, minY: 0, maxX: 1, maxY: 2 } }] }), 'obstacles[0].boundsM');
  assert.equal(createRoomSnapshot({ ...room(), obstacles: [{ ...base, boundsM: { minX: 0, minY: 0, maxX: 1, maxY: 2 } }] }).obstacles.length, 1);
});

test('clear placement reports only checked scope and retains synthetic source evidence', () => {
  const report = check();
  assert.equal(report.status, 'CHECKED_SCOPE_CLEAR');
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.checks.map(entry => entry.status), ['PASS', 'PASS']);
  assert.equal(report.checks[1].obstaclesChecked, 1);
  assert.equal(report.roomSource.kind, 'ASSUMED');
  assert.equal(report.snapshotId, roomFixture.snapshotId);
  assert.equal(report.facilityInput.revisionEtag, roomFixture.facilityInput.revisionEtag);
  assert.equal(report.planId, placement().planId);
  assert.ok(report.uncheckedRules.includes('rack_to_rack_collision'));
  assert.ok(report.uncheckedRules.includes('maintenance_clearance'));
  assert.ok(report.uncheckedRules.includes('source_freshness'));
  assert.equal(Object.hasOwn(report, 'feasible'), false);
});

test('protrusion beyond each of the four walls returns a structured issue rather than an input exception', () => {
  for (const where of [
    { xM: 0.5, yM: 5 }, { xM: 9.5, yM: 5 }, { xM: 2, yM: 0.5 }, { xM: 2, yM: 7.5 },
  ]) {
    const report = check(room(), { ...placement(), ...where });
    assert.equal(report.status, 'ISSUES_FOUND');
    assert.equal(report.checks[0].status, 'FAIL');
    assert.equal(report.diagnostics[0].ruleId, SPATIAL_RULES.ROOM_BOUNDS);
    assert.equal(report.diagnostics[0].code, 'RACK_OUTSIDE_ROOM');
    assert.equal(report.diagnostics[0].evidence.unit, 'm');
  }
});

test('being exactly on the room boundary is contained, without implying maintenance clearance', () => {
  for (const [xM, yM] of [[1, 1], [9, 1], [9, 7], [1, 7]]) {
    const report = check({ ...room(), obstacles: [] }, { ...placement(), xM, yM });
    assert.equal(report.status, 'CHECKED_SCOPE_CLEAR');
    assert.ok(report.uncheckedRules.includes('maintenance_clearance'));
  }
});

test('obstacle containment, overlap, edge and corner contact all count as conflicts', () => {
  for (const [xM, yM] of [[4.5, 3], [4, 3], [3, 3], [3, 1]]) {
    const report = check(room(), { ...placement(), xM, yM });
    assert.equal(report.status, 'ISSUES_FOUND');
    assert.equal(report.checks[1].status, 'FAIL');
    assert.equal(report.diagnostics[0].obstacleId, roomFixture.obstacles[0].obstacleId);
    assert.equal(report.diagnostics[0].code, 'RACK_OBSTACLE_CONFLICT');
  }
  const largeRack = { ...model(), widthM: 4, depthM: 4 };
  assert.equal(check(room(), { ...placement(), xM: 4.5, yM: 3 }, largeRack).checks[1].status, 'FAIL');
});

test('a tiny positive gap is clear and a tiny overlap is detected, with no hidden rounding tolerance', () => {
  assert.equal(check(room(), { ...placement(), xM: 3 - 1e-12 }).checks[1].status, 'PASS');
  assert.equal(check(room(), { ...placement(), xM: 3 + 1e-12 }).checks[1].status, 'FAIL');
});

test('all quarter-turns use the rotated footprint for wall and obstacle checks', () => {
  const rectangle = { ...model(), widthM: 2, depthM: 4 };
  for (const rotationDeg of [0, 90, 180, 270]) {
    const report = check(room(), { ...placement(), xM: 2.5, yM: 3, rotationDeg }, rectangle);
    assert.equal(report.checks[0].status, 'PASS');
    assert.equal(report.checks[1].status, rotationDeg % 180 === 0 ? 'PASS' : 'FAIL');
    const wallReport = check({ ...room(), obstacles: [] }, { ...placement(), xM: 1, yM: 3, rotationDeg }, rectangle);
    assert.equal(wallReport.checks[0].status, rotationDeg % 180 === 0 ? 'PASS' : 'FAIL');
  }
});

test('missing obstacle coverage never becomes a pass merely because no known conflicts exist', () => {
  for (const obstacles of [[], room().obstacles]) {
    const report = check({ ...room(), obstacleCoverage: 'UNKNOWN', obstacles });
    assert.equal(report.status, 'INCOMPLETE');
    assert.equal(report.checks[1].status, 'NOT_CHECKED');
    assert.equal(report.checks[1].inputCoverage, 'UNKNOWN');
    assert.deepEqual(report.diagnostics, []);
  }
  assert.equal(check({ ...room(), obstacles: [], obstacleCoverage: 'COMPLETE' }).checks[1].status, 'PASS');
});

test('known failures are still reported when the obstacle inventory is incomplete', () => {
  const report = check({ ...room(), obstacleCoverage: 'UNKNOWN' }, { ...placement(), xM: 4.5 });
  assert.equal(report.status, 'ISSUES_FOUND');
  assert.equal(report.checks[1].status, 'FAIL');
  assert.equal(report.checks[1].inputCoverage, 'UNKNOWN');
});

test('all simultaneous wall and obstacle findings are returned in deterministic order', () => {
  const raw = room();
  raw.obstacles.push({ ...structuredClone(raw.obstacles[0]), obstacleId: otherId });
  const report = check(raw, { ...placement(), xM: 4.5, yM: 3 }, { ...model(), widthM: 12 });
  assert.deepEqual(report.diagnostics.map(entry => entry.code), ['RACK_OUTSIDE_ROOM', 'RACK_OBSTACLE_CONFLICT', 'RACK_OBSTACLE_CONFLICT']);
  assert.deepEqual(report.diagnostics.slice(1).map(entry => entry.obstacleId), [raw.obstacles[0].obstacleId, otherId]);
});

test('wrong project, model or malformed placement is rejected before producing a spatial verdict', () => {
  invalidField(() => check(room(), { ...placement(), projectId: otherId }), 'projectId');
  invalidField(() => check(room(), { ...placement(), modelId: otherId }), 'modelId');
  invalidField(() => check(room(), { ...placement(), xM: '2' }), 'xM');
});

test('report evidence is deeply immutable and checking changes no inputs', () => {
  const rawRoom = room();
  const rawModel = model();
  const rawPlacement = { ...placement(), xM: 4.5 };
  const before = structuredClone([rawRoom, rawModel, rawPlacement]);
  const report = checkRackPlacement(rawRoom, rawModel, rawPlacement);
  assert.deepEqual([rawRoom, rawModel, rawPlacement], before);
  for (const value of [report, report.checks, ...report.checks, report.diagnostics, report.diagnostics[0], report.diagnostics[0].evidence, report.diagnostics[0].evidence.rackBoundsM, report.uncheckedRules]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(() => { report.diagnostics[0].evidence.rackBoundsM.minX = 123; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});
