import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDemandOptions, normalizeDesignDemand, DEMAND_LIMITS } from '../demand-planner.js';
import { checkEquipment } from '../equipment.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const model={modelId:id(1),name:'Test rack',source:{kind:'ASSUMED',reference:'test'},widthM:.6,depthM:1.2,heightU:42,maxWeightKg:null,maxPowerKw:null,maxCoolingKw:null};
const constraints={obstacleCoverage:'UNKNOWN',source:{kind:'ASSUMED',reference:'test'},obstacles:[],clearance:{frontM:1,rearM:.6}};
const demand={groups:[{modelId:'demo-gpu-4u',version:1,quantity:8},{modelId:'demo-compute-2u',version:1,quantity:12},{modelId:'demo-tor-1u',version:1,quantity:2}],
  rackModelId:id(1),maxRacks:16,rackLimits:{maxWeightKg:800,maxPowerKw:12,maxCoolingKw:12},gapM:.2,sourceReference:'test assumptions'};
const fixture=(patch={})=>({projectId:id(2),planId:id(3),demand,models:[model],boundary:{type:'Polygon',coordinates:[[[0,0],[100,0],[100,100],[0,100],[0,0]]]},constraints,
  makeId:(kind,i)=>id((kind==='rack'?100:1000)+i),pickArrangement:async()=>0,...patch});
test('demand schema pins model versions, explicit resources and finite work limits',()=>{
  assert.equal(normalizeDesignDemand(demand).groups.length,3);
  for(const patch of [{unknown:true},{maxRacks:33},{gapM:'1'},{rackLimits:{...demand.rackLimits,maxPowerKw:null}},
    {groups:[{modelId:'demo-gpu-4u',version:99,quantity:1}]},{groups:[{...demand.groups[0],quantity:129}]},
    {groups:[demand.groups[0],demand.groups[0]]},{groups:[{...demand.groups[0],quantity:100},{...demand.groups[1],quantity:100}]}])
    assert.throws(()=>normalizeDesignDemand({...demand,...patch}),{code:'RACK_INPUT_INVALID'});
});
test('both strategies retain all identities, allocate legal continuous U and resources deterministically without mutating input',async()=>{
  const before=structuredClone({demand,model,constraints}),result=await generateDemandOptions(fixture());
  assert.deepEqual(result,await generateDemandOptions(fixture()));assert.deepEqual({demand,model,constraints},before);
  for(const c of result){assert.equal(c.equipment.devices.length,22);assert.equal(c.metrics.assignedDevices,22);assert.equal(c.metrics.rackCount,3);assert.equal(c.unplaced.length,0);
    assert.ok(Math.abs(c.metrics.envelopeAreaM2-2.64)<1e-10,'rank the displayed rack envelope, rather than clearance envelope');
    assert.equal(checkEquipment(c.equipment,c.placements,[model]).diagnostics.length,0);assert.equal(new Set(c.equipment.devices.map(d=>d.deviceId)).size,22);}
});
test('unknown, oversized and rack-count-limited devices remain in inventory with explanatory blockers',async()=>{
  for(const [patch,code] of [[{groups:[{modelId:'demo-optical-2u',version:1,quantity:2}]},'UNKNOWN_DEVICE_DEMAND'],
    [{rackLimits:{...demand.rackLimits,maxPowerKw:0}},'DEVICE_EXCEEDS_RACK'],[{maxRacks:1},'RACK_COUNT_LIMIT']]){
    const result=await generateDemandOptions(fixture({demand:{...demand,...patch}}));
    for(const c of result){assert.ok(c.unplaced.some(u=>u.code===code));assert.equal(c.equipment.devices.length,patch.groups?2:22);assert.ok(c.equipment.devices.some(d=>d.rackId===null&&d.startU===null));}
  }
});
test('rack model authority cannot be relaxed by input limits; explicit zero and unknown room budgets block adoption',async()=>{
  const limited=await generateDemandOptions(fixture({models:[{...model,maxPowerKw:2}]}));
  assert.ok(limited.every(c=>c.unplaced.some(u=>u.code==='DEVICE_EXCEEDS_RACK')));
  for(const [limit,code] of [[0,'DEMAND_EXCEEDS_ROOM_BUDGET'],[null,'UNKNOWN_ROOM_BUDGET']]){
    const result=await generateDemandOptions(fixture({roomBudget:{source:{kind:'ASSUMED',reference:'test'},maxPowerKw:limit,maxCoolingKw:100}}));
    assert.ok(result.every(c=>c.unplaced.some(u=>u.code===code)));
  }
});
test('whole arrangement search checks multiple shapes fairly and terminates with no false infeasibility proof',async()=>{
  let calls=0;
  const result=await generateDemandOptions(fixture({pickArrangement:async batch=>{calls++;assert.ok(batch.length<=DEMAND_LIMITS.batchSize);assert.equal(batch[0].geometry.type,'GeometryCollection');return null;}}));
  for(const c of result){assert.equal(c.positionsSubmitted,256);assert.ok(c.unplaced.some(u=>u.code==='NO_COMPACT_LAYOUT'));assert.equal(c.equipment.devices.length,22);}
  assert.equal(calls,32);
  await assert.rejects(()=>generateDemandOptions(fixture({pickArrangement:async()=>999})),/Invalid arrangement/);
});
