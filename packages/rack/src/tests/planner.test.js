import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRackOptions, normalizePlannerOptions, plannerGeometry, PLANNER_LIMITS } from '../planner.js';
import { EMPTY_SPATIAL_CONSTRAINTS } from '../constraints.js';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const model = {modelId:uuid(1),name:'Assumed',widthM:1,depthM:2,heightU:42,source:{kind:'ASSUMED',reference:'test'}};
const rack = n => ({rackId:uuid(n+10),projectId:uuid(2),planId:uuid(3),modelId:model.modelId,name:`R${n}`,xM:5,yM:5,rotationDeg:0,locked:false});
const boundary = {type:'Polygon',coordinates:[[[0,0],[10,0],[10,10],[0,10],[0,0]]]};
const fixture = patch => ({placements:[rack(1),rack(2)],models:[model],boundary,constraints:EMPTY_SPATIAL_CONSTRAINTS,
  options:{grid_step_m:1,allow_rotation:false},pickPosition:async(batch,placed) => {
    const index = batch.findIndex(g => placed.every(p => g.bounds.maxX <= p.bounds.minX || g.bounds.minX >= p.bounds.maxX || g.bounds.maxY <= p.bounds.minY || g.bounds.minY >= p.bounds.maxY));
    return index < 0 ? null : index;
  },...patch});

test('planner validates parameters strictly, including null, injected keys and invalid budgets', () => {
  assert.equal(normalizePlannerOptions().strategy,'COMPARE');
  for(const input of [null,{grid_step_m:0},{grid_step_m:'1'},{grid_step_m:NaN},{allow_rotation:1},{strategy:'OPTIMAL'},{max_iterations:1e9}])
    assert.throws(()=>normalizePlannerOptions(input),{code:'RACK_INPUT_INVALID'});
});
test('both strategies are repeatable, compact racks and leave inputs unchanged', async()=>{
  const input=fixture(),before=structuredClone({...input,pickPosition:undefined});
  const result=await generateRackOptions(input);
  assert.deepEqual(result,await generateRackOptions(input));
  assert.equal(result.length,2);
  for(const option of result){assert.equal(option.unplaced.length,0);assert.equal(option.metrics.envelopeAreaM2,4);assert.equal(option.metrics.movedRacks,2);}
  assert.deepEqual({...input,pickPosition:undefined},before);
});
test('locked cabinets keep every property, and largest-first orders heterogeneous sizes with stable ties', async()=>{
  const larger={...model,modelId:uuid(4),widthM:2,depthM:3};
  const locked={...rack(4),locked:true,xM:7};
  const seen=[];
  const input=fixture({models:[model,larger],placements:[locked,rack(1),{...rack(2),modelId:larger.modelId}],options:{strategy:'LARGEST_FIRST'},
    pickPosition:async(batch,placed)=>{seen.push({id:batch[0].placement.rackId,fixed:placed.map(p=>p.placement.rackId)});return 0;}});
  const [option]=await generateRackOptions(input);
  assert.deepEqual(option.placements[0],locked);assert.equal(seen[0].id,rack(2).rackId);assert.ok(seen[0].fixed.includes(locked.rackId));
});
test('maintenance bands rotate physically with the proposal; geometry adapter controls feasibility', async()=>{
  const constraints={...EMPTY_SPATIAL_CONSTRAINTS,clearance:{frontM:1,rearM:.5}};
  const g=plannerGeometry({...rack(1),xM:0,yM:0,rotationDeg:90},model,constraints.clearance);
  assert.equal(g.bands.length,2);assert.ok(g.bands[0].coordinates[0].every(p=>p[0]>=1));
  const [option]=await generateRackOptions(fixture({constraints,options:{allow_rotation:true,strategy:'INPUT_ORDER'},pickPosition:async batch=>batch.findIndex(p=>p.placement.rotationDeg===90)}));
  assert.ok(option.placements.every(p=>p.rotationDeg===90));
});
test('no accepted grid position retains original identities and distinguishes finite exhaustion from search limits', async()=>{
  const [small]=await generateRackOptions(fixture({boundary:{type:'Polygon',coordinates:[[[0,0],[.1,0],[.1,.1],[0,.1],[0,0]]]},options:{strategy:'INPUT_ORDER'},
    pickPosition:async()=>{throw new Error('oversized rack should not reach adapter');}}));
  assert.deepEqual(small.placements,[rack(1),rack(2)]);assert.equal(small.unplaced[0].code,'NO_GRID_POSITION');
  const [limited]=await generateRackOptions(fixture({options:{grid_step_m:.1,strategy:'INPUT_ORDER'},pickPosition:async()=>null}));
  assert.ok(limited.unplaced.every(p=>p.code==='SEARCH_LIMIT'));assert.equal(limited.unplaced[0].positionsSubmitted,PLANNER_LIMITS.posesPerRack);
});
test('planner refuses empty and excess movable inventory, and clamps total work', async()=>{
  await assert.rejects(()=>generateRackOptions(fixture({placements:[]})),{code:'RACK_INPUT_INVALID'});
  await assert.rejects(()=>generateRackOptions(fixture({placements:Array.from({length:65},(_,i)=>rack(i))})),{code:'RACK_INPUT_INVALID'});
  const [option]=await generateRackOptions(fixture({placements:Array.from({length:10},(_,i)=>rack(i)),options:{grid_step_m:.1,strategy:'INPUT_ORDER'},pickPosition:async()=>null}));
  assert.equal(option.positionsSubmitted,PLANNER_LIMITS.posesPerOption);assert.equal(option.unplaced.at(-1).positionsSubmitted,0);
});
