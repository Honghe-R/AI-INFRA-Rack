import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RackInputError, checkRackLayout, checkRackPlacement, MAX_LAYOUT_RACKS, MAX_LAYOUT_MODELS, SPATIAL_RULES,
} from '../index.js';

const roomFixture = JSON.parse(await readFile(new URL('../../examples/rectangular-room.json', import.meta.url), 'utf8'));
const rackFixture = JSON.parse(await readFile(new URL('../../examples/basic-rack.json', import.meta.url), 'utf8'));
const id = number => `abcdefab-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
function input() {
  return {
    projectId: rackFixture.placement.projectId,
    planId: rackFixture.placement.planId,
    room: { ...structuredClone(roomFixture), obstacles: [] },
    models: [{ ...structuredClone(rackFixture.model), widthM: 2, depthM: 2 }],
    placementCoverage: 'COMPLETE',
    placements: [
      { ...structuredClone(rackFixture.placement), rackId: id(1), name: 'A', xM: 2, yM: 3 },
      { ...structuredClone(rackFixture.placement), rackId: id(2), name: 'B', xM: 6, yM: 3 },
    ],
  };
}
const pairFindings = report => report.diagnostics.filter(entry => entry.ruleId === SPATIAL_RULES.RACK_COLLISION);
const collisionCheck = report => report.checks.find(entry => entry.ruleId === SPATIAL_RULES.RACK_COLLISION);
function invalidField(fn, field) {
  assert.throws(fn, error => error instanceof RackInputError
    && error.code === 'RACK_INPUT_INVALID' && error.details[0].field === field);
}

test('separated racks reuse single-rack checks and report complete pair coverage', () => {
  const raw = input();
  const report = checkRackLayout(raw);
  assert.equal(report.status, 'CHECKED_SCOPE_CLEAR');
  assert.deepEqual(report.summary, { racksChecked: 2, pairsChecked: 1, collidingPairs: 0 });
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.checks.map(check => check.status), ['PASS', 'PASS', 'PASS']);
  assert.equal(report.rackReports.length, 2);
  assert.deepEqual(report.rackReports[0], checkRackPlacement(raw.room, raw.models[0], raw.placements[0]));
  assert.ok(report.uncheckedRules.includes('maintenance_clearance'));
  assert.ok(report.uncheckedRules.includes('source_freshness'));
  assert.ok(!report.uncheckedRules.includes('rack_to_rack_collision'));
  assert.equal(Object.hasOwn(report, 'feasible'), false);
});

test('interior overlap returns one diagnostic with both rack identities and intersection bounds', () => {
  const raw = input();
  raw.placements[1].xM = 3;
  const report = checkRackLayout(raw);
  assert.equal(report.status, 'ISSUES_FOUND');
  assert.equal(collisionCheck(report).status, 'FAIL');
  assert.equal(report.summary.collidingPairs, 1);
  assert.equal(pairFindings(report).length, 1);
  const finding = pairFindings(report)[0];
  assert.equal(finding.code, 'RACK_PAIR_OVERLAP');
  assert.equal(finding.severity, 'ERROR');
  assert.deepEqual(finding.rackIds, [id(1), id(2)]);
  assert.deepEqual(finding.evidence.overlapBoundsM, { minX: 2, minY: 2, maxX: 3, maxY: 4 });
  assert.equal(finding.evidence.unit, 'm');
});

test('identical locations and full containment are collisions even without crossing edges', () => {
  const raw = input();
  raw.placements[1].xM = 2;
  assert.equal(checkRackLayout(raw).summary.collidingPairs, 1);
  raw.models.push({ ...raw.models[0], modelId: id(20), widthM: 1, depthM: 1 });
  raw.placements[1].modelId = id(20);
  assert.equal(checkRackLayout(raw).summary.collidingPairs, 1);
});

test('side and corner contacts are allowed by the footprint rule and do not claim clearance', () => {
  for (const [xM, yM] of [[4, 3], [2, 5], [4, 5]]) {
    const raw = input();
    Object.assign(raw.placements[1], { xM, yM });
    const report = checkRackLayout(raw);
    assert.equal(report.status, 'CHECKED_SCOPE_CLEAR');
    assert.equal(report.summary.collidingPairs, 0);
    assert.ok(report.uncheckedRules.includes('maintenance_clearance'));
    assert.ok(report.uncheckedRules.includes('aisles'));
  }
});

test('small positive gaps and overlaps retain their sign without hidden tolerance', () => {
  const raw = input();
  raw.placements[1].xM = 4 + 1e-12;
  assert.equal(checkRackLayout(raw).summary.collidingPairs, 0);
  raw.placements[1].xM = 4 - 1e-12;
  assert.equal(checkRackLayout(raw).summary.collidingPairs, 1);
});

test('every pair uses the rotated rectangular footprint rather than unrotated dimensions', () => {
  for (const rotationDeg of [0, 90, 180, 270]) {
    const raw = input();
    raw.models[0].depthM = 4;
    raw.placements[1].xM = 4.5;
    raw.placements[1].rotationDeg = rotationDeg;
    assert.equal(checkRackLayout(raw).summary.collidingPairs, rotationDeg % 180 ? 1 : 0);
  }
});

test('all unordered pairs are visited once in deterministic input order, including locked racks', () => {
  const raw = input();
  raw.placements[1].xM = 2;
  raw.placements[1].locked = true;
  raw.placements.push({ ...raw.placements[0], rackId: id(3) });
  const report = checkRackLayout(raw);
  assert.deepEqual(report.summary, { racksChecked: 3, pairsChecked: 3, collidingPairs: 3 });
  assert.deepEqual(pairFindings(report).map(finding => finding.rackIds), [[id(1), id(2)], [id(1), id(3)], [id(2), id(3)]]);
  assert.equal(raw.placements[1].locked, true);
});

test('batch diagnostics retain wall and obstacle failures before pair findings', () => {
  const raw = input();
  raw.room = structuredClone(roomFixture);
  raw.placements[0].xM = 0;
  raw.placements[1].xM = 4.5;
  raw.placements.push({ ...raw.placements[1], rackId: id(3) });
  const report = checkRackLayout(raw);
  assert.deepEqual(report.diagnostics.map(finding => finding.code), [
    'RACK_OUTSIDE_ROOM', 'RACK_OBSTACLE_CONFLICT', 'RACK_OBSTACLE_CONFLICT', 'RACK_PAIR_OVERLAP',
  ]);
  assert.deepEqual(report.checks.map(check => check.status), ['FAIL', 'FAIL', 'FAIL']);
});

test('unknown rack inventory or obstacle inventory prevents an overall clear conclusion', () => {
  const raw = input();
  raw.placementCoverage = 'UNKNOWN';
  let report = checkRackLayout(raw);
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(collisionCheck(report).status, 'NOT_CHECKED');
  assert.equal(collisionCheck(report).pairsChecked, 1);
  assert.equal(collisionCheck(report).inputCoverage, 'UNKNOWN');
  raw.placementCoverage = 'COMPLETE';
  raw.room.obstacleCoverage = 'UNKNOWN';
  report = checkRackLayout(raw);
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.checks[1].status, 'NOT_CHECKED');
  assert.equal(collisionCheck(report).status, 'PASS');
});

test('a known pair collision is still a failure with an incomplete inventory', () => {
  const raw = input();
  raw.placements[1].xM = 3;
  raw.placementCoverage = 'UNKNOWN';
  raw.room.obstacleCoverage = 'UNKNOWN';
  const report = checkRackLayout(raw);
  assert.equal(report.status, 'ISSUES_FOUND');
  assert.equal(collisionCheck(report).status, 'FAIL');
  assert.equal(collisionCheck(report).inputCoverage, 'UNKNOWN');
});

test('an empty inventory is NOT_CHECKED rather than automatically passing a plan', () => {
  const raw = input();
  raw.models = [];
  raw.placements = [];
  for (const placementCoverage of ['COMPLETE', 'UNKNOWN']) {
    const report = checkRackLayout({ ...raw, placementCoverage });
    assert.equal(report.status, 'NOT_CHECKED');
    assert.deepEqual(report.summary, { racksChecked: 0, pairsChecked: 0, collidingPairs: 0 });
    assert.deepEqual(report.checks.map(check => check.status), ['NOT_CHECKED', 'NOT_CHECKED', 'NOT_CHECKED']);
  }
});

test('one fully listed rack has zero pairs and only passes the bounded check scope', () => {
  const raw = input();
  raw.placements.pop();
  const report = checkRackLayout(raw);
  assert.equal(report.status, 'CHECKED_SCOPE_CLEAR');
  assert.equal(report.summary.pairsChecked, 0);
  assert.equal(collisionCheck(report).status, 'PASS');
  assert.ok(report.uncheckedRules.includes('equipment_and_capacity'));
});

test('layout rejects missing records, unknown fields and absent inventory declaration', () => {
  for (const value of [undefined, null, [], 'layout']) invalidField(() => checkRackLayout(value), 'layout');
  invalidField(() => checkRackLayout({ ...input(), state: 'PASSED' }), 'layout.state');
  for (const placementCoverage of [undefined, null, true, 'PARTIAL']) {
    invalidField(() => checkRackLayout({ ...input(), placementCoverage }), 'placementCoverage');
  }
  invalidField(() => checkRackLayout({ ...input(), planId: 'plan-1' }), 'planId');
  invalidField(() => checkRackLayout({ ...input(), projectId: null }), 'projectId');
});

test('model and placement arrays must be explicit, bounded and have no sparse slots', () => {
  for (const field of ['models', 'placements']) {
    for (const value of [undefined, null, {}, 'list']) invalidField(() => checkRackLayout({ ...input(), [field]: value }), field);
  }
  invalidField(() => checkRackLayout({ ...input(), models: new Array(MAX_LAYOUT_MODELS + 1) }), 'models');
  invalidField(() => checkRackLayout({ ...input(), placements: new Array(MAX_LAYOUT_RACKS + 1) }), 'placements');
  invalidField(() => checkRackLayout({ ...input(), models: new Array(1) }), 'model');
  invalidField(() => checkRackLayout({ ...input(), placements: new Array(1) }), 'placement');
});

test('room project and every rack project/plan must match the declared layout', () => {
  const raw = input();
  raw.room.facilityInput.projectId = id(10);
  invalidField(() => checkRackLayout(raw), 'room.facilityInput.projectId');
  for (const field of ['projectId', 'planId']) {
    const changed = input();
    changed.placements[1][field] = id(10);
    invalidField(() => checkRackLayout(changed), `placements[1].${field}`);
  }
});

test('duplicate rack and model identities are refused after UUID normalization', () => {
  const raw = input();
  raw.placements[1].rackId = raw.placements[0].rackId.toUpperCase();
  invalidField(() => checkRackLayout(raw), 'placements[1].rackId');
  const changed = input();
  changed.models[0].modelId = id(20);
  changed.models.push({ ...changed.models[0], modelId: id(20).toUpperCase(), widthM: 9 });
  invalidField(() => checkRackLayout(changed), 'models[1].modelId');
});

test('missing model references and malformed model dimensions do not get skipped', () => {
  const raw = input();
  raw.placements[1].modelId = id(20);
  invalidField(() => checkRackLayout(raw), 'placements[1].modelId');
  invalidField(() => checkRackLayout({ ...input(), models: [] }), 'placements[0].modelId');
  const changed = input();
  changed.models[0].widthM = '2';
  invalidField(() => checkRackLayout(changed), 'widthM');
});

test('normalized model, project and plan IDs resolve without case-sensitive false mismatches', () => {
  const raw = input();
  raw.projectId = id(10).toUpperCase();
  raw.planId = id(11).toUpperCase();
  raw.room.facilityInput.projectId = id(10);
  raw.models[0].modelId = id(20).toUpperCase();
  for (const placement of raw.placements) {
    Object.assign(placement, { projectId: id(10), planId: id(11), modelId: id(20) });
  }
  const report = checkRackLayout(raw);
  assert.equal(report.projectId, id(10));
  assert.equal(report.planId, id(11));
  assert.equal(report.status, 'CHECKED_SCOPE_CLEAR');
});

test('the maximum supported rack inventory is accepted and visits exactly n(n-1)/2 pairs', () => {
  const raw = input();
  raw.room.boundaryM.maxX = 1000;
  raw.placements = Array.from({ length: MAX_LAYOUT_RACKS }, (_, index) => ({
    ...raw.placements[0], rackId: id(index + 1), xM: 2 + index * 3,
  }));
  const report = checkRackLayout(raw);
  assert.equal(report.status, 'CHECKED_SCOPE_CLEAR');
  assert.equal(report.summary.pairsChecked, MAX_LAYOUT_RACKS * (MAX_LAYOUT_RACKS - 1) / 2);
});

test('reports and nested collision evidence are immutable and no input is changed', () => {
  const raw = input();
  raw.placements[1].xM = 3;
  const before = structuredClone(raw);
  const report = checkRackLayout(raw);
  assert.deepEqual(raw, before);
  const finding = pairFindings(report)[0];
  for (const value of [report, report.summary, report.checks, ...report.checks, report.rackReports, report.diagnostics, finding, finding.rackIds, finding.evidence, finding.evidence.overlapBoundsM, report.uncheckedRules]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(() => { finding.evidence.overlapBoundsM.maxX = 100; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('moving a conflicting rack and rerunning clears findings without stale mutable state', () => {
  const raw = input();
  raw.placements[1].xM = 3;
  const before = checkRackLayout(raw);
  raw.placements[1].xM = 6;
  const after = checkRackLayout(raw);
  assert.equal(before.summary.collidingPairs, 1);
  assert.equal(after.summary.collidingPairs, 0);
  assert.deepEqual(after.diagnostics, []);
  assert.equal(after.status, 'CHECKED_SCOPE_CLEAR');
});
