import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeEquipment, checkEquipment, normalizeRoomBudget, EMPTY_EQUIPMENT } from '../index.js';

const modelId = randomUUID();
const placements = [1,2].map(() => ({ rackId: randomUUID(), modelId }));
const models = [{ modelId, heightU: 42, maxWeightKg: 100, maxPowerKw: 10, maxCoolingKw: 10 }];
const budget = (patch = {}) => ({ maxPowerKw: 3, maxCoolingKw: 3, source: { kind: 'ASSUMED', reference: 'Synthetic planning budget' }, ...patch });
const device = (patch = {}) => ({ deviceId: randomUUID(), name: 'Synthetic server', heightU: 2, weightKg: 10, powerKw: 2, coolingKw: 2, rackId: placements[0].rackId, startU: 1, ...patch });
const report = (devices, patch = {}) => checkEquipment(normalizeEquipment({ ...EMPTY_EQUIPMENT, coverage: 'DECLARED_COMPLETE', devices, roomBudget: budget(), ...patch }, placements), placements, models);

test('room budgets isolate and freeze source; absent and explicit null preserve old equipment shapes', () => {
  const input = budget(), normalized = normalizeRoomBudget(input);
  input.source.reference = 'Changed';
  assert.equal(normalized.source.reference, 'Synthetic planning budget');
  assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.source));
  assert.equal(normalizeRoomBudget(null), null);
  assert.ok(!Object.hasOwn(normalizeEquipment(EMPTY_EQUIPMENT, placements), 'roomBudget'));
  assert.equal(normalizeEquipment({ ...EMPTY_EQUIPMENT, roomBudget: null }, placements).roomBudget, null);
});

test('budget schema rejects missing, forged, negative, nonfinite and unbounded inputs', () => {
  for (const input of [undefined, {}, [], budget({ maxPowerKw: undefined }), budget({ maxCoolingKw: '3' }), budget({ maxPowerKw: -1 }), budget({ maxPowerKw: NaN }), budget({ maxPowerKw: Infinity }), budget({ maxPowerKw: 1000001 }), budget({ maxWeightKg: 100 }), budget({ source: { kind: 'REFERENCE', reference: 'x' } }), budget({ source: { kind: 'ASSUMED', reference: ' ' } }), budget({ source: { kind: 'ASSUMED', reference: 'x', certified: true } })])
    assert.throws(() => normalizeRoomBudget(input));
});

test('two racks can each be within limits while combined power and cooling exceed the room budget', () => {
  const devices = [device(), device({ rackId: placements[1].rackId })];
  const before = structuredClone(devices), r = report(devices);
  assert.ok(r.racks.every(s => Object.values(s.capacities).every(c => c.status === 'WITHIN_LIMIT')));
  assert.equal(r.status, 'ISSUES_FOUND');
  assert.equal(r.roomCapacity.status, 'ISSUES_FOUND');
  assert.equal(r.roomCapacity.resources.powerKw.total, 4);
  assert.equal(r.roomCapacity.resources.powerKw.remaining, -1);
  assert.deepEqual(r.diagnostics.map(d => d.dimension), ['powerKw', 'coolingKw']);
  assert.ok(r.diagnostics.every(d => d.code === 'ROOM_BUDGET_EXCEEDED' && d.rackId === null));
  assert.deepEqual(devices, before);
});

test('unassigned demand is visible as inventory but does not consume the installed budget', () => {
  const r = report([device(), device({ rackId: null, startU: null, powerKw: 5, coolingKw: 5 })]);
  const room = r.roomCapacity;
  assert.equal(r.status, 'INCOMPLETE');
  assert.equal(room.status, 'CHECKED_SCOPE_CLEAR');
  assert.equal(room.installedDevices, 1); assert.equal(room.unassignedDevices, 1);
  assert.equal(room.resources.powerKw.total, 2);
  assert.equal(room.resources.powerKw.inventory.total, 7);
  assert.equal(room.resources.powerKw.inventoryExceedsLimit, true);
  assert.deepEqual(r.diagnostics, []);
});

test('unknown demand retains lower bounds and never hides a known subtotal exceeding the budget', () => {
  const devices = [device({ powerKw: 4 }), device({ rackId: placements[1].rackId, powerKw: null, coolingKw: null })];
  const r = report(devices).roomCapacity;
  assert.equal(r.resources.powerKw.total, null);
  assert.equal(r.resources.powerKw.knownSubtotal, 4);
  assert.equal(r.resources.powerKw.unknownDevices, 1);
  assert.equal(r.resources.powerKw.remaining, null);
  assert.equal(r.resources.powerKw.status, 'EXCEEDED');
  assert.equal(r.resources.coolingKw.status, 'UNKNOWN');
  assert.equal(r.diagnostics.length, 1);
});

test('missing budgets, unknown limits and unknown coverage remain explicit', () => {
  for (const patch of [{ roomBudget: null }, { roomBudget: budget({ maxCoolingKw: null }) }, { coverage: 'UNKNOWN' }]) {
    const r = report([device()], patch);
    assert.equal(r.roomCapacity.status, 'INCOMPLETE');
  }
  const missing = report([device()], { roomBudget: null });
  assert.equal(missing.roomCapacity.budgetState, 'NOT_RECORDED');
  assert.ok(missing.uncheckedRules.includes('ROOM_POWER_COOLING_BUDGET'));
  assert.equal(missing.status, 'CHECKED_SCOPE_CLEAR', 'legacy equipment status remains scoped to recorded per-rack limits');
});

test('zero is a real room limit and decimal equality follows the shared floating-point policy', () => {
  const zero = budget({ maxPowerKw: 0, maxCoolingKw: 0 });
  assert.equal(report([device({ powerKw: 0, coolingKw: 0 })], { roomBudget: zero }).roomCapacity.status, 'CHECKED_SCOPE_CLEAR');
  assert.equal(report([device()], { roomBudget: zero }).roomCapacity.diagnostics.length, 2);
  const devices = [device({ powerKw: .1 }), device({ rackId: placements[1].rackId, powerKw: .2 })];
  assert.equal(report(devices, { roomBudget: budget({ maxPowerKw: .3, maxCoolingKw: 4 }) }).diagnostics.length, 0);
  devices[1].powerKw += .00001;
  assert.equal(report(devices, { roomBudget: budget({ maxPowerKw: .3, maxCoolingKw: 4 }) }).diagnostics.length, 1);
});

test('empty declared inventory can clear the installed scope; unknown inventory demand remains unknown', () => {
  assert.equal(report([]).roomCapacity.status, 'CHECKED_SCOPE_CLEAR');
  const room = report([device({ rackId: null, startU: null, powerKw: null })]).roomCapacity;
  assert.equal(room.resources.powerKw.total, 0);
  assert.equal(room.resources.powerKw.inventory.total, null);
  assert.ok(room.uncheckedRules.includes('OTHER_PLANS_SHARED_ROOM'));
  assert.ok(room.uncheckedRules.includes('RACK_IDLE_POWER'));
});
