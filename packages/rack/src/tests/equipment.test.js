import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeEquipment, checkEquipment, EMPTY_EQUIPMENT } from '../equipment.js';
import { MAX_EQUIPMENT_DEVICES } from '../limits.js';

const rackId = randomUUID(),
  otherRackId = randomUUID(),
  modelId = randomUUID();
const placements = [
  { rackId, modelId },
  { rackId: otherRackId, modelId },
];
const models = [
  {
    modelId,
    heightU: 42,
    maxWeightKg: null,
    maxPowerKw: null,
    maxCoolingKw: null,
  },
];
const device = (patch = {}) => ({
  deviceId: randomUUID(),
  name: 'Device',
  heightU: 2,
  weightKg: 20,
  powerKw: 1,
  coolingKw: 1,
  rackId,
  startU: 1,
  ...patch,
});
const doc = (devices = [], patch = {}) => ({
  ...structuredClone(EMPTY_EQUIPMENT),
  devices,
  ...patch,
});
const limit = (id = rackId, patch = {}) => ({
  rackId: id,
  maxWeightKg: 100,
  maxPowerKw: 10,
  maxCoolingKw: 10,
  ...patch,
});
const report = (input, racks = placements, catalog = models) =>
  checkEquipment(normalizeEquipment(input, racks), racks, catalog);

test('equipment normalization isolates and freezes nested inputs, preserves unknown and explicit zero', () => {
  const d = device({ weightKg: null, powerKw: 0 });
  const input = doc([d]);
  const value = normalizeEquipment(input, placements);
  d.name = 'Changed';
  assert.equal(value.devices[0].name, 'Device');
  assert.equal(value.devices[0].weightKg, null);
  assert.equal(value.devices[0].powerKw, 0);
  assert.ok(
    Object.isFrozen(value) &&
      Object.isFrozen(value.devices) &&
      Object.isFrozen(value.devices[0]) &&
      Object.isFrozen(value.source),
  );
  assert.deepEqual(normalizeEquipment(JSON.parse(JSON.stringify(value)), placements), value);
});
test('equipment rejects malformed, missing, injected and unbounded fields', () => {
  for (const input of [
    null,
    {},
    doc([], { projectId: randomUUID() }),
    doc([], { coverage: 'COMPLETE' }),
    doc([], { source: { kind: 'REFERENCE', reference: 'x' } }),
    doc([], { devices: Array.from({ length: MAX_EQUIPMENT_DEVICES + 1 }, () => device()) }),
  ])
    assert.throws(() => normalizeEquipment(input, placements));
  for (const patch of [
    { heightU: 0 },
    { heightU: 1.5 },
    { heightU: 101 },
    { startU: 0 },
    { startU: '1' },
    { startU: 10001 },
    { weightKg: -1 },
    { powerKw: NaN },
    { coolingKw: Infinity },
    { weightKg: 1000001 },
    { name: ' ' },
    { extra: true },
    { deviceId: 'x' },
  ])
    assert.throws(() => normalizeEquipment(doc([device(patch)]), placements), JSON.stringify(patch));
  const missing = device();
  delete missing.powerKw;
  assert.throws(() => normalizeEquipment(doc([missing]), placements));
});
test('one device identity cannot be installed twice, even with UUID case differences', () => {
  const d = device();
  assert.throws(() =>
    normalizeEquipment(
      doc([d, { ...d, deviceId: d.deviceId.toUpperCase(), rackId: otherRackId }]),
      placements,
    ),
  );
});
test('unknown/foreign/deleted rack references and duplicate limits are rejected', () => {
  assert.throws(() => normalizeEquipment(doc([device({ rackId: randomUUID() })]), placements));
  assert.throws(() => normalizeEquipment(doc([], { rackLimits: [limit(), limit()] }), placements));
  assert.throws(() => normalizeEquipment(doc([], { rackLimits: [limit(randomUUID())] }), placements));
  assert.throws(() => normalizeEquipment(doc([device()]), []), /unassign/);
});
test('unassigned devices retain specs without consuming U or capacity and remain incomplete', () => {
  const result = report(
    doc([device({ rackId: null, startU: null })], {
      coverage: 'DECLARED_COMPLETE',
    }),
  );
  assert.equal(result.installedDevices, 0);
  assert.equal(result.unassignedDeviceIds.length, 1);
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.racks[0].occupiedU, 0);
  assert.equal(result.racks[0].capacities.weightKg.total, 0);
  assert.throws(() => normalizeEquipment(doc([device({ rackId: null, startU: 1 })]), placements));
  assert.throws(() => normalizeEquipment(doc([device({ startU: null })]), placements));
});
test('U1 bottom, inclusive end and adjacent full-width devices are legal; overflow and overlap diagnose both objects', () => {
  let result = report(
    doc([device({ startU: 1 }), device({ startU: 3 }), device({ heightU: 1, startU: 42 })]),
  );
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.racks[0].occupiedU, 5);
  assert.equal(result.racks[0].freeU, 37);
  result = report(doc([device({ startU: 42 }), device({ startU: 42 })]));
  assert.equal(result.diagnostics.filter((d) => d.code === 'DEVICE_U_OUT_OF_BOUNDS').length, 2);
  const collision = result.diagnostics.find((d) => d.code === 'DEVICE_U_OVERLAP');
  assert.equal(collision.deviceIds.length, 2);
  assert.equal(collision.rackId, rackId);
  assert.equal(result.racks[0].occupiedU, 1);
  assert.equal(result.racks[0].requestedU, 4);
});
test('same U positions in different racks are independent; moving preserves device identity', () => {
  const a = device(),
    b = device({ rackId: otherRackId });
  const input = doc([a, b]);
  assert.equal(report(input).diagnostics.length, 0);
  input.devices[0] = { ...a, rackId: otherRackId };
  assert.ok(report(input).diagnostics.some((d) => d.code === 'DEVICE_U_OVERLAP'));
  input.devices[0] = { ...a, rackId: otherRackId, startU: 3 };
  assert.equal(report(input).diagnostics.length, 0);
  assert.equal(input.devices[0].deviceId, a.deviceId);
});
test('capacity sums all dimensions and explicit assumed limits without changing the catalog', () => {
  const result = report(
    doc([device(), device({ startU: 3 })], {
      coverage: 'DECLARED_COMPLETE',
      rackLimits: [limit(), limit(otherRackId)],
    }),
  );
  assert.equal(result.status, 'CHECKED_SCOPE_CLEAR');
  assert.equal(result.racks[0].capacities.weightKg.total, 40);
  assert.equal(result.racks[0].capacities.powerKw.total, 2);
  assert.equal(result.racks[0].capacities.coolingKw.status, 'WITHIN_LIMIT');
  assert.equal(models[0].maxWeightKg, null);
  assert.equal(result.racks[0].capacities.weightKg.limitSource, 'PLAN_ASSUMPTION');
});
test('unknown demand is not zero; a known lower bound can still exceed the limit', () => {
  const result = report(
    doc([device({ weightKg: 120, powerKw: null }), device({ startU: 3, weightKg: null })], {
      rackLimits: [limit()],
    }),
  );
  const c = result.racks[0].capacities.weightKg;
  assert.equal(c.total, null);
  assert.equal(c.knownSubtotal, 120);
  assert.equal(c.unknownDevices, 1);
  assert.equal(c.status, 'EXCEEDED');
  assert.equal(result.racks[0].capacities.powerKw.status, 'UNKNOWN');
  assert.equal(result.status, 'ISSUES_FOUND');
});
test('unknown model limits, zero limits, exact equality, arithmetic rounding and small real exceedance stay distinct', () => {
  assert.equal(report(doc([device()])).racks[0].capacities.weightKg.status, 'UNKNOWN');
  const result = report(
    doc([device({ weightKg: 0, powerKw: 0.1 }), device({ startU: 3, weightKg: 0, powerKw: 0.2 })], {
      rackLimits: [limit(rackId, { maxWeightKg: 0, maxPowerKw: 0.3 })],
    }),
  );
  assert.equal(result.racks[0].capacities.weightKg.status, 'WITHIN_LIMIT');
  assert.equal(result.racks[0].capacities.powerKw.status, 'WITHIN_LIMIT');
  assert.equal(
    report(
      doc([device({ weightKg: 1e-12 })], {
        rackLimits: [limit(rackId, { maxWeightKg: 0 })],
      }),
    ).racks[0].capacities.weightKg.status,
    'EXCEEDED',
  );
  assert.equal(
    report(doc([device({ weightKg: 100.000001 })], { rackLimits: [limit()] })).racks[0].capacities.weightKg
      .status,
    'EXCEEDED',
  );
});
test('model capacity fallback and report incompleteness are scoped to declared inventory', () => {
  const catalog = [{ ...models[0], maxWeightKg: 100, maxPowerKw: 10, maxCoolingKw: 10 }];
  assert.equal(report(doc([]), placements, catalog).status, 'NOT_CHECKED');
  assert.equal(report(doc([device()]), placements, catalog).status, 'INCOMPLETE');
  const complete = report(doc([device()], { coverage: 'DECLARED_COMPLETE' }), placements, catalog);
  assert.equal(complete.status, 'CHECKED_SCOPE_CLEAR');
  assert.ok(complete.uncheckedRules.includes('GLOBAL_ASSET_IDENTITY'));
  assert.equal(complete.racks[0].capacities.weightKg.limitSource, 'MODEL');
});
test('full supported inventory is checked with bounded totals and no mutation', () => {
  const devices = Array.from({ length: MAX_EQUIPMENT_DEVICES }, (_, i) => device({ heightU: 1, rackId: null, startU: null }));
  const input = doc(devices);
  const copy = structuredClone(input);
  assert.equal(report(input).devicesChecked, MAX_EQUIPMENT_DEVICES);
  assert.deepEqual(input, copy);
});

test('full supported installed inventory preserves every slot and capacity across 128 cabinets', () => {
  const racks = Array.from({length:128}, () => ({rackId:randomUUID(), modelId}));
  const perRack = MAX_EQUIPMENT_DEVICES / racks.length;
  const devices = racks.flatMap(r => Array.from({length:perRack}, (_, i) => device({rackId:r.rackId,heightU:1,startU:i+1})));
  const input = doc(devices, {coverage:'DECLARED_COMPLETE',rackLimits:racks.map(r => limit(r.rackId,{maxWeightKg:1000,maxPowerKw:100,maxCoolingKw:100}))});
  const result = report(input,racks);
  assert.equal(result.installedDevices,MAX_EQUIPMENT_DEVICES);
  assert.equal(result.unassignedDeviceIds.length,0);
  assert.deepEqual(result.diagnostics,[]);
  assert.ok(result.racks.every(r => r.occupiedU === perRack && r.freeU === 42-perRack && r.capacities.powerKw.total === perRack));
});
