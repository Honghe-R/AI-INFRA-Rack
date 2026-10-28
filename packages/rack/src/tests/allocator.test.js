import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allocateUnassignedEquipment, checkEquipment, EMPTY_EQUIPMENT } from '../index.js';

function fixture() {
  const modelId = randomUUID();
  const models = [{ modelId, heightU: 10, maxWeightKg: 100, maxPowerKw: 10, maxCoolingKw: 10 }];
  const placements = [{ rackId: '10000000-0000-4000-8000-000000000001', modelId, locked: false },
    { rackId: '10000000-0000-4000-8000-000000000002', modelId, locked: false }];
  const device = (patch = {}) => ({ deviceId: randomUUID(), name: 'Synthetic device', heightU: 2, weightKg: 10, powerKw: 1, coolingKw: 1, rackId: null, startU: null, ...patch });
  const equipment = { ...structuredClone(EMPTY_EQUIPMENT), devices: [] };
  const run = () => allocateUnassignedEquipment({ equipment, placements, models });
  return { models, placements, equipment, device, run };
}
test('decreasing U order and lexical ties are repeatable, preserve inputs and keep installed assignments', () => {
  const f = fixture();
  const installed = f.device({ rackId: f.placements[0].rackId, startU: 1, heightU: 2 });
  f.equipment.devices = [f.device({heightU:2}), installed, f.device({heightU:6}), f.device({heightU:4})];
  const before = structuredClone({ equipment:f.equipment,placements:f.placements });
  const a=f.run(),b=f.run();
  assert.deepEqual(a,b); assert.deepEqual(f.equipment,before.equipment); assert.deepEqual(f.placements,before.placements);
  assert.deepEqual(a.equipment.devices.find(d=>d.deviceId===installed.deviceId),installed);
  assert.equal(a.assignments[0].endU-a.assignments[0].startU+1,6);
  assert.equal(a.assignments[0].startU,3); assert.equal(a.assignments[0].rackId,f.placements[0].rackId);
  assert.equal(a.assignments.length,3); assert.deepEqual(checkEquipment(a.equipment,f.placements,f.models).diagnostics,[]);
});
test('contiguous slots are required even when total free U would be sufficient', () => {
  const f=fixture(); f.placements.splice(1);
  f.equipment.devices=[f.device({rackId:f.placements[0].rackId,startU:4,heightU:1}),f.device({rackId:f.placements[0].rackId,startU:8,heightU:1}),f.device({heightU:4})];
  const r=f.run(); assert.equal(r.assignments.length,0); assert.equal(r.unassigned[0].rejectionCounts.NO_CONTIGUOUS_U,1);
});
test('locked target racks are excluded and existing devices are never migrated', () => {
  const f=fixture(); f.placements[0].locked=true;
  const installed=f.device({rackId:f.placements[0].rackId,startU:3}); f.equipment.devices=[installed,f.device()];
  const r=f.run();assert.equal(r.assignments[0].rackId,f.placements[1].rackId);assert.equal(r.metrics.excludedLockedRacks,1);
  assert.deepEqual(r.equipment.devices[0],installed);
  f.placements[1].locked=true;assert.equal(f.run().unassigned[0].code,'NO_UNLOCKED_RACK');
});
test('unknown device demand and unknown limits or installed demand never become zero or unlimited', () => {
  const f=fixture(); f.placements.splice(1);f.equipment.devices=[f.device({powerKw:null})];
  assert.equal(f.run().unassigned[0].code,'UNKNOWN_DEVICE_RESOURCE');
  f.equipment.devices=[f.device()];f.models[0].maxPowerKw=null;
  assert.equal(f.run().unassigned[0].rejectionCounts.UNKNOWN_RACK_CAPACITY,1);
  f.models[0].maxPowerKw=10;f.equipment.devices.push(f.device({rackId:f.placements[0].rackId,startU:1,weightKg:null}));
  assert.equal(f.run().unassigned[0].rejectionCounts.UNKNOWN_RACK_CAPACITY,1);
});
test('each resource limits allocation and explicit zero demand at zero limit is accepted', () => {
  for (const [key,maxKey] of [['weightKg','maxWeightKg'],['powerKw','maxPowerKw'],['coolingKw','maxCoolingKw']]) {
    const f=fixture();f.placements.splice(1);f.models[0][maxKey]=0;f.equipment.devices=[f.device()];
    assert.equal(f.run().unassigned[0].rejectionCounts.CAPACITY_EXCEEDED,1);
    f.equipment.devices=[f.device({[key]:0})];assert.equal(f.run().assignments.length,1);
  }
});
test('plan limit assumptions override model limits; exact floating-point capacity uses the checker policy', () => {
  const f=fixture();f.placements.splice(1);f.equipment.rackLimits=[{rackId:f.placements[0].rackId,maxWeightKg:100,maxPowerKw:.3,maxCoolingKw:10}];
  f.equipment.devices=[f.device({powerKw:.1}),f.device({powerKw:.2})];
  const r=f.run();assert.equal(r.assignments.length,2);assert.equal(r.equipmentReport.diagnostics.length,0);
  f.equipment.devices.push(f.device({powerKw:.01}));assert.equal(f.run().assignments.length,2);
});
test('partial results preserve every identity, source, limits and unassigned record', () => {
  const f=fixture();f.equipment.devices=[f.device(),f.device({heightU:100}),f.device({weightKg:null})];
  const r=f.run();assert.equal(r.assignments.length,1);assert.equal(r.unassigned.length,2);
  assert.deepEqual(r.equipment.devices.map(d=>d.deviceId),f.equipment.devices.map(d=>d.deviceId));
  assert.deepEqual(r.equipment.devices.slice(1),f.equipment.devices.slice(1));assert.deepEqual(r.equipment.source,f.equipment.source);
  assert.deepEqual(r.equipment.rackLimits,f.equipment.rackLimits);assert.equal(r.equipment.coverage,'UNKNOWN');
});
test('existing U errors are refused; allocation search caps bound devices, racks and height', () => {
  const f=fixture();f.equipment.devices=[f.device({rackId:f.placements[0].rackId,startU:10})];
  assert.throws(f.run,/resolve existing/);
  f.equipment.devices=Array.from({length:129},()=>f.device());assert.throws(f.run,/128/);
  f.equipment.devices=[];f.placements.splice(0,f.placements.length,...Array.from({length:65},()=>({rackId:randomUUID(),modelId:f.models[0].modelId,locked:false})));assert.throws(f.run,/64/);
  f.placements.splice(1);f.models[0].heightU=1000000000;assert.throws(f.run,/100 U/);
});
test('empty inventory returns an explicit no-op result', () => {
  const f=fixture(),r=f.run();assert.equal(r.assignments.length,0);assert.equal(r.metrics.attemptedDevices,0);assert.equal(r.equipmentReport.status,'NOT_CHECKED');
});
