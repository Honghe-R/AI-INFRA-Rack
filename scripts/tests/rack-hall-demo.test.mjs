import test from 'node:test';
import assert from 'node:assert/strict';
import { getRackCatalog, normalizeEquipment, checkEquipment, allocateUnassignedEquipment } from '@ai-infra/rack';
import { createHallDemoBody, hallDemoId } from '../lib/rack-hall-demo.mjs';

const layout = { snapshot: { snapshotId:'synthetic-snapshot',view:{extentM:{width:106,height:92}} }, models:[
  { modelId:'10000000-0000-4000-8000-000000000001',widthM:.6,depthM:1.2,heightU:42 },
  { modelId:'10000000-0000-4000-8000-000000000002',widthM:.8,depthM:1.2,heightU:42 },
] };

test('hall fixture is deterministic with unique pinned identities and leaves source/catalog unchanged',()=>{
  const catalog=getRackCatalog(), before=structuredClone({layout,catalog});
  const a=createHallDemoBody(layout,catalog,'test'), b=createHallDemoBody(layout,catalog,'test');
  assert.deepEqual(a,b); assert.deepEqual({layout,catalog},before);
  assert.equal(a.placements.length,32);assert.equal(a.equipment.devices.length,244);
  assert.equal(new Set(a.equipment.devices.map(d=>d.deviceId)).size,244);
  assert.equal(new Set(a.placements.map(p=>p.rackId)).size,32);
  assert.notEqual(hallDemoId('test','A01'),hallDemoId('other','A01'));
  assert.equal(a.constraints.obstacleCoverage,'UNKNOWN');
  assert.equal(a.placements.filter(p=>p.locked).length,24);
});

test('hall fixture has valid installed U/resources, mixed loading and an exact 6kW room margin',()=>{
  const body=createHallDemoBody(layout,getRackCatalog(),'test');
  const normalized=normalizeEquipment(body.equipment,body.placements);
  const r=checkEquipment(normalized,body.placements,layout.models);
  assert.deepEqual(r.diagnostics,[]);assert.equal(r.installedDevices,236);assert.equal(r.unassignedDeviceIds.length,8);
  assert.equal(r.roomCapacity.resources.powerKw.total,240);
  assert.equal(r.roomCapacity.resources.coolingKw.total,240);
  assert.equal(r.roomCapacity.resources.powerKw.remaining,6);
  assert.equal(r.status,'INCOMPLETE');assert.equal(r.roomCapacity.status,'CHECKED_SCOPE_CLEAR');
  assert.ok(r.racks.some(s=>s.capacities.powerKw.total/s.capacities.powerKw.limit>=.8));
  assert.ok(r.racks.some(s=>s.capacities.powerKw.total/s.capacities.powerKw.limit<.8));
  // Adjacent row faces: 2.4m gaps front/front and 1.8m rear/rear.
  assert.equal(body.placements[0].rotationDeg,180);assert.equal(body.placements[8].rotationDeg,0);
  assert.ok(Math.abs(body.placements[8].yM-body.placements[0].yM-3.6)<1e-10);
});

test('real allocator admits only two pending GPUs, retaining unknown, oversized and room-blocked devices',()=>{
  const body=createHallDemoBody(layout,getRackCatalog(),'test');
  const r=allocateUnassignedEquipment({equipment:body.equipment,placements:body.placements,models:layout.models});
  assert.equal(r.assignments.length,2);assert.equal(r.unassigned.length,6);
  assert.equal(r.unassigned.filter(d=>d.code==='ROOM_BUDGET_EXCEEDED').length,4);
  assert.equal(r.unassigned.filter(d=>d.code==='UNKNOWN_DEVICE_RESOURCE').length,1);
  assert.equal(r.unassigned.filter(d=>d.code==='NO_ELIGIBLE_POSITION').length,1);
  assert.equal(r.equipmentReport.roomCapacity.resources.powerKw.total,246);
  assert.deepEqual(r.equipmentReport.diagnostics,[]);
  assert.ok(r.assignments.every(a=>!body.placements.find(p=>p.rackId===a.rackId).locked));
});

test('small/unknown rooms and missing catalog models are refused before writing demo input',()=>{
  assert.throws(()=>createHallDemoBody({...layout,snapshot:{...layout.snapshot,view:{extentM:{width:20,height:20}}}},getRackCatalog(),'test'),/40/);
  assert.throws(()=>createHallDemoBody(layout,{models:[]},'test'),/Missing pinned/);
});
