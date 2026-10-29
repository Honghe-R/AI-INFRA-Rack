import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { addPlanObject, rackCommandReason, RACK_COMMANDS } from '../rack/rack-commands.js';
import { beginLayoutDraft, defaultEditorEquipment, defaultEditorConstraints } from '../rack/edit-layout-state.js';
import { RackCapacityTable, RackElevations, capacityLabel } from '../rack/RackViews.jsx';
import { ActiveToolToolbar } from '../shell/ActiveToolToolbar.jsx';
import { RackAddDialog } from '../rack/RackAddDialog.jsx';

const model = {modelId:'m',name:'42U',heightU:42,widthM:.6,depthM:1.2};
const layout = {planId:'p',version:3,snapshot:{snapshotId:'s',view:{extentM:{width:20,height:10}}},sourceStatus:{status:'UNCHANGED'},models:[model],placements:[],constraints:defaultEditorConstraints(),equipment:defaultEditorEquipment()};
const catalog = {models:[{modelId:'gpu',version:2,name:'GPU',specification:{heightU:4,weightKg:80,powerKw:3,coolingKw:3}}]};
const rackValues = {modelId:'m',name:'Rack <A>',xM:'3',yM:'4',rotationDeg:'90'};

test('toolbar registers Rack domain commands, explains missing plan and filters writer commands for readers', () => {
  const html = renderToStaticMarkup(<ActiveToolToolbar toolId="rack" grantedKeys={['rack.read','rack.write']} disabledReasons={{rack_add:'Select a saved Plan first.'}}/>);
  for (const c of RACK_COMMANDS) assert.ok(html.includes(c.label));
  assert.match(html,/aria-label="Add rack" aria-disabled="true" title="Select a saved Plan first."/);
  const reader = renderToStaticMarkup(<ActiveToolToolbar toolId="rack" grantedKeys={['rack.read']}/>);
  assert.ok(reader.includes('Check results'));assert.ok(!reader.includes('Add rack'));assert.ok(!reader.includes('Publish'));
});

test('command guards protect stale sources, immutable attempts, draft scope and candidate generation', () => {
  const base = {layout,canWrite:true,busy:false,draft:null};
  assert.equal(rackCommandReason(base,'rack_add'),null);
  for(const patch of [{canWrite:false},{busy:true},{layout:{...layout,snapshot:null}},
    {layout:{...layout,sourceStatus:{status:'STALE'}}},{draft:{...beginLayoutDraft(layout),baseVersion:2}},
    {draft:{...beginLayoutDraft(layout),snapshotId:'other'}},{draft:{...beginLayoutDraft(layout),attempt:{key:'pending'}}}])
    assert.ok(rackCommandReason({...base,...patch},'rack_add'));
  assert.equal(rackCommandReason({...base,canWrite:false},'rack_checks'),null);
  assert.ok(rackCommandReason({...base,draft:beginLayoutDraft(layout)},'rack_design'));
});

test('add actions compose into one versioned copied draft, preserve inventory, and do not write saved data', () => {
  const before = structuredClone(layout);let id = 0;const uuid=()=>`id-${++id}`;
  const first=addPlanObject(layout,null,'rack_add',rackValues,catalog,uuid);
  assert.equal(first.draft.baseVersion,3);assert.equal(first.draft.snapshotId,'s');
  const second=addPlanObject(layout,first.draft,'rack_device',{quantity:3,catalogKey:'gpu@2'},catalog,uuid);
  const third=addPlanObject(layout,second.draft,'rack_zone',{name:'Service area',xM:10,yM:5,widthM:2,depthM:1},catalog,uuid);
  assert.equal(first.draft.equipment.devices.length,0);assert.equal(second.draft.constraints.obstacles.length,0);
  assert.equal(third.draft.placements.length,1);assert.equal(third.draft.equipment.devices.length,3);assert.equal(third.draft.constraints.obstacles.length,1);
  for (const d of third.draft.equipment.devices) {assert.equal(d.rackId,null);assert.equal(d.startU,null);assert.deepEqual(d.catalogRef,{modelId:'gpu',version:2});}
  assert.equal(new Set(third.draft.equipment.devices.map(d=>d.deviceId)).size,3);
  assert.deepEqual(layout,before);
});

test('invalid or oversized additions fail without modifying saved or unsaved input', () => {
  const draft=beginLayoutDraft(layout),before=structuredClone(draft);
  for(const values of [{quantity:0,catalogKey:'gpu@2'},{quantity:129,catalogKey:'gpu@2'},{quantity:1.5,catalogKey:'gpu@2'},{quantity:1,catalogKey:'gpu@1'}])
    assert.throws(()=>addPlanObject(layout,draft,'rack_device',values,catalog));
  assert.throws(()=>addPlanObject(layout,draft,'rack_add',{...rackValues,xM:NaN},catalog));
  assert.throws(()=>addPlanObject(layout,draft,'rack_add',{...rackValues,xM:''},catalog));
  assert.throws(()=>addPlanObject(layout,{...draft,placements:Array(256).fill({})},'rack_add',rackValues,catalog));
  assert.throws(()=>addPlanObject(layout,{...draft,constraints:{...draft.constraints,obstacles:Array(64).fill({})}},'rack_zone',{},catalog));
  assert.throws(()=>addPlanObject(layout,{...draft,equipment:{...draft.equipment,devices:Array(512).fill({})}},'rack_device',{quantity:1,catalogKey:'gpu@2'},catalog));
  assert.throws(()=>addPlanObject(layout,{...draft,attempt:{}},'rack_add',rackValues,catalog));
  assert.deepEqual(draft,before);assert.equal(layout.placements.length,0);
});

test('add equipment dialog exposes quantity and pinned version without silently installing devices', () => {
  const html=renderToStaticMarkup(<RackAddDialog kind="rack_device" layout={layout} draft={null} catalogState={{data:catalog}}/>);
  for(const text of ['设备数量','GPU · v2','待上架库存','Save layout','取消','加入草稿']) assert.ok(html.includes(text),text);
});

test('schematic views retain rack/device IDs and show unknown capacities and actual U ranges', () => {
  const rack={...rackValues,rackId:'r',xM:3,yM:4,rotationDeg:90};
  const devices=[{deviceId:'d',name:'GPU <1>',rackId:'r',startU:1,heightU:4,catalogRef:{modelId:'gpu'}}];
  const source=structuredClone({rack,devices});
  const elevations=renderToStaticMarkup(<RackElevations placements={[rack]} models={[model]} devices={devices} selectedId="r" onSelect={()=>{}}/>);
  assert.ok(elevations.includes('GPU &lt;1&gt;'));assert.ok(elevations.includes('U1–4'));assert.ok(elevations.includes('aria-pressed="true"'));assert.ok(elevations.includes('Not checked'));
  const table=renderToStaticMarkup(<RackCapacityTable placements={[rack]} devices={devices} selectedId="r" onSelect={()=>{}}/>);
  assert.ok(table.includes('3, 4 m · 90°'));assert.ok(table.includes('待检查'));
  assert.equal(capacityLabel({capacities:{powerKw:{total:null,knownSubtotal:3,limit:null,status:'UNKNOWN'}}},'powerKw','kW'),'≥3 / ? kW · 未知');
  assert.equal(capacityLabel({capacities:{powerKw:{total:0,knownSubtotal:0,limit:0,status:'WITHIN_LIMIT'}}},'powerKw','kW'),'0 / 0 kW');
  assert.deepEqual({rack,devices},source);
});
