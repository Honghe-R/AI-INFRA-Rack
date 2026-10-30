import test from 'node:test';
import assert from 'node:assert/strict';
import { getRackCatalog, normalizeEquipment, checkEquipment, allocateUnassignedEquipment } from '@ai-infra/rack';
import { createLargeHallDemoBody, createSparseLargeHallDemoBody, prepareLargeHallEquipmentUpgrade } from '../lib/rack-large-hall-demo.mjs';
import { rackLoadDisplay } from '../../apps/web/src/rack/floorplan-load.js';

const layout = { snapshot: { snapshotId: 'synthetic-snapshot', view: { extentM: { width: 106, height: 92 } } }, models: [
  { modelId: '10000000-0000-4000-8000-000000000001', widthM: .6, depthM: 1.2, heightU: 42 },
  { modelId: '10000000-0000-4000-8000-000000000002', widthM: .8, depthM: 1.2, heightU: 42 },
] };

test('large fixture keeps deterministic identities and inputs, fits saved-plan and planner bounds', () => {
  const catalog = getRackCatalog(), before = structuredClone({ layout, catalog });
  const body = createLargeHallDemoBody(layout, catalog, 'test');
  assert.deepEqual(body, createLargeHallDemoBody(layout, catalog, 'test'));
  assert.deepEqual({ layout, catalog }, before);
  assert.equal(body.placements.length, 128);
  assert.equal(body.equipment.devices.length, 952);
  assert.equal(new Set(body.placements.map(p => p.rackId)).size, 128);
  assert.equal(new Set(body.equipment.devices.map(d => d.deviceId)).size, 952);
  assert.equal(body.placements.filter(p => p.locked).length, 96);
  for (const letter of 'ABCDEFGH') assert.equal(body.placements.filter(p => p.name.startsWith(letter)).length, 16);
  assert.equal(body.constraints.obstacleCoverage, 'UNKNOWN');
});

test('large fixture has valid resources/U positions and an explicit 6 kW room margin', () => {
  const body = createLargeHallDemoBody(layout, getRackCatalog(), 'test');
  const report = checkEquipment(normalizeEquipment(body.equipment, body.placements), body.placements, layout.models);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.installedDevices, 944);
  assert.equal(report.unassignedDeviceIds.length, 8);
  for (const resource of ['powerKw', 'coolingKw']) {
    assert.ok(Math.abs(report.roomCapacity.resources[resource].total - 960) < 1e-8);
    assert.ok(Math.abs(report.roomCapacity.resources[resource].remaining - 6) < 1e-8);
  }
  assert.equal(report.status, 'INCOMPLETE');
  const tones = report.racks.map(r => rackLoadDisplay('power', r.rackId, report).tone);
  assert.equal(tones.filter(t => t === 'high').length, 80);
  assert.equal(tones.filter(t => t === 'clear').length, 48);
  assert.equal(tones.filter(t => t === 'issue' || t === 'unknown').length, 0);
  assert.ok(report.racks.some(r => r.capacities.powerKw.total / r.capacities.powerKw.limit > .98));
  const kinds = body.equipment.devices.filter(d => d.rackId !== null).map(d => d.catalogRef.modelId);
  assert.equal(kinds.filter(k => k === 'demo-gpu-4u').length, 144);
  assert.equal(kinds.filter(k => k === 'demo-compute-2u').length, 576);
  assert.equal(kinds.filter(k => k === 'demo-tor-1u').length, 224);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1024 * 1024, 'Fixture fits the existing API body bound.');
});

test('large fixture exercises real allocation without changing locked racks or baseline', () => {
  const body = createLargeHallDemoBody(layout, getRackCatalog(), 'test'), before = structuredClone(body);
  const result = allocateUnassignedEquipment({ equipment: body.equipment, placements: body.placements, models: layout.models });
  assert.deepEqual(body, before);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.unassigned.length, 6);
  assert.equal(result.unassigned.filter(d => d.code === 'ROOM_BUDGET_EXCEEDED').length, 4);
  assert.equal(result.unassigned.filter(d => d.code === 'UNKNOWN_DEVICE_RESOURCE').length, 1);
  assert.equal(result.unassigned.filter(d => d.code === 'NO_ELIGIBLE_POSITION').length, 1);
  assert.deepEqual(result.equipmentReport.diagnostics, []);
  assert.ok(result.assignments.every(a => !body.placements.find(p => p.rackId === a.rackId).locked));
});

test('large fixture refuses unsupported rooms, rack models and missing pinned equipment', () => {
  assert.throws(() => createLargeHallDemoBody({ ...layout, snapshot: { ...layout.snapshot, view: { extentM: { width: 39, height: 92 } } } }, getRackCatalog(), 'test'), /40/);
  assert.throws(() => createLargeHallDemoBody({ ...layout, models: [] }, getRackCatalog(), 'test'), /42U/);
  assert.throws(() => createLargeHallDemoBody(layout, { models: [] }, 'test'), /Missing pinned/);
});

test('explicit density upgrade preserves geometry and constraints, refuses edited equipment and is repeatable', () => {
  const catalog = getRackCatalog();
  const sparse = createSparseLargeHallDemoBody(layout, catalog, 'test');
  const saved = { ...layout, ...sparse, placements: [...sparse.placements].reverse(),
    equipment: { ...sparse.equipment, devices: [...sparse.equipment.devices].reverse() } };
  saved.placements[0] = { ...saved.placements[0], xM: saved.placements[0].xM + .1 };
  const before = structuredClone(saved);
  const upgrade = prepareLargeHallEquipmentUpgrade(saved, catalog, 'test');
  assert.equal(upgrade.changed, true);
  assert.deepEqual(upgrade.body.placements, saved.placements);
  assert.deepEqual(upgrade.body.constraints, saved.constraints);
  assert.deepEqual(saved, before);
  assert.equal(prepareLargeHallEquipmentUpgrade({ ...saved, ...upgrade.body }, catalog, 'test').changed, false);
  const edited = structuredClone(saved); edited.equipment.devices[0].name = 'User equipment edit';
  assert.throws(() => prepareLargeHallEquipmentUpgrade(edited, catalog, 'test'), /Equipment was edited/);
  const renamed = structuredClone(saved); renamed.placements[0].name = 'User rack rename';
  assert.throws(() => prepareLargeHallEquipmentUpgrade(renamed, catalog, 'test'), /Rack identities/);
});
