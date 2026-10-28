import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RackAllocation } from '../rack/RackAllocation.jsx';
import { stageRackOption } from '../rack/rack-options-state.js';
import { createApiClient } from '../api/client.js';

const layout={projectId:'p',planId:'plan',version:2,snapshot:{snapshotId:'s'},facilityInput:{revisionEtag:'e'},sourceStatus:{status:'UNCHANGED'},placements:[],models:[],equipment:{devices:[{deviceId:'d',rackId:null}]} };
test('device allocation entry describes conservative scope, caps and dirty protection',()=>{
  const html=renderToStaticMarkup(<RackAllocation client={{}} layout={layout} draft={{baseVersion:2}} canWrite />);
  for(const text of ['128 unassigned','64 unlocked','100 U','Existing assignments','Unknown data is not treated as zero','Save or discard','disabled=""'])assert.ok(html.includes(text),text);
});
test('partial allocation can stage after review without dropping devices left unassigned',()=>{
  const c={canStage:true,unplaced:[],unassigned:[{deviceId:'left'}],report:{diagnostics:[]},equipmentReport:{diagnostics:[]},body:{placements:[],constraints:{},equipment:{devices:[{deviceId:'placed',rackId:'r',startU:1},{deviceId:'left',rackId:null,startU:null}]}}};
  const result={projectId:'p',planId:'plan',baseVersion:2,snapshotId:'s',facilityInput:layout.facilityInput,candidates:[c]};
  assert.throws(()=>stageRackOption(layout,result,c,{canWrite:true,confirmed:false}));
  const draft=stageRackOption(layout,result,c,{canWrite:true,confirmed:true});
  assert.equal(draft.equipment.devices.length,2);assert.equal(draft.equipment.devices[1].rackId,null);draft.equipment.devices[0].startU=4;assert.equal(c.body.equipment.devices[0].startU,1);
  c.canStage=false;assert.throws(()=>stageRackOption(layout,result,c,{canWrite:true,confirmed:true}));
});
test('allocation client sends only saved base and snapshot, no write headers',async()=>{
  let sent;const signal=new AbortController().signal;
  const client=createApiClient({identity:()=>null,fetchImpl:async(url,options)=>{sent={url,options};return {ok:true,json:async()=>({data:{}})};}});
  const body={contract_version:1,base_version:2,snapshot_id:'s'};
  await client.generateRackEquipmentOption('p/x','plan/x',body,{signal});
  assert.equal(sent.url,'/api/v1/projects/p%2Fx/rack/plans/plan%2Fx/layout/equipment-options');assert.equal(sent.options.method,'POST');assert.deepEqual(JSON.parse(sent.options.body),body);assert.equal(sent.options.signal,signal);assert.equal(sent.options.headers['If-Match'],undefined);
});
