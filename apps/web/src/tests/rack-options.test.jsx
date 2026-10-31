import {test} from 'vitest';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {RackOptions} from '../rack/RackOptions.jsx';
import {optionStageReason,stageRackOption} from '../rack/rack-options-state.js';
import {createApiClient} from '../api/client.js';
const layout={projectId:'p',planId:'plan',version:2,sourceStatus:{status:'UNCHANGED'},facilityInput:{revisionId:'r',containerId:'h',revisionEtag:'e'},
  snapshot:{snapshotId:'s'},placements:[{rackId:'r',locked:true}]};
const option={canStage:true,unplaced:[],report:{diagnostics:[]},equipmentReport:{diagnostics:[]},
  body:{placements:[{rackId:'r',xM:1}],constraints:{clearance:null},equipment:{devices:[{deviceId:'d',rackId:'r',startU:1}],rackLimits:[]}}};
const result={projectId:'p',planId:'plan',baseVersion:2,snapshotId:'s',facilityInput:layout.facilityInput,candidates:[option]};
const guards={canWrite:true,draft:null,confirmed:true};

test('new-design lock choice applies only to new racks, leaving existing racks and candidate unchanged',()=>{
  const c={...option,body:{...option.body,placements:[{rackId:'r',locked:false},{rackId:'new',locked:false}]}};
  const r={...result,candidates:[c]};
  const locked=stageRackOption(layout,r,c,{...guards,newRackLocked:true});
  assert.equal(locked.placements[0].locked,false);
  assert.equal(locked.placements[1].locked,true);
  assert.equal(c.body.placements[1].locked,false);
  assert.equal(stageRackOption(layout,r,c,{...guards,newRackLocked:false}).placements[1].locked,false);
});
test('staging preserves exact plan body in a new shared draft; preview is not a save',()=>{
  const draft=stageRackOption(layout,result,option,guards);
  assert.equal(draft.baseVersion,2);assert.equal(draft.snapshotId,'s');assert.equal(draft.attempt,null);
  assert.deepEqual(draft.equipment,option.body.equipment);draft.placements[0].xM=9;assert.equal(option.body.placements[0].xM,1);
});
test('staging blocks missing review, read-only, dirty drafts, stale inputs, old version and partial or erroneous candidates',()=>{
  for(const patch of [{canWrite:false},{confirmed:false},{draft:{attempt:{key:'keep'}}}]) assert.ok(optionStageReason(layout,result,option,{...guards,...patch}));
  for(const patch of [{version:3},{planId:'other'},{sourceStatus:{status:'STALE'}},{facilityInput:{...layout.facilityInput,containerId:'other'}}])
    assert.throws(()=>stageRackOption({...layout,...patch},result,option,guards));
  for(const patch of [{canStage:false},{unplaced:[{}]},{report:{diagnostics:[{code:'CONFLICT'}]}},{equipmentReport:{diagnostics:[{code:'CAPACITY'}]}}]){
    const blocked={...option,...patch};assert.ok(optionStageReason(layout,{...result,candidates:[blocked]},blocked,guards));
  }
});
test('options entry states bounds and real scope, generation is disabled for shared drafts',()=>{
  const html=renderToStaticMarkup(<RackOptions client={{}} layout={layout} draft={{baseVersion:2}} canWrite={false} />);
  for(const text of ['64 movable racks','2,048','16,384','No device allocation','Current edits will not be overwritten','disabled=""']) assert.ok(html.includes(text),text);
});
test('planning client sends saved version and snapshot with an abort signal without write headers',async()=>{
  const signal=new AbortController().signal;let call;
  const client=createApiClient({identity:()=>null,fetchImpl:async(url,options)=>{call={url,options};return {ok:true,json:async()=>({data:result})};}});
  const body={contract_version:1,base_version:2,snapshot_id:'s',options:{strategy:'COMPARE'}};
  await client.generateRackOptions('p/x','plan/x',body,{signal});
  assert.equal(call.url,'/api/v1/projects/p%2Fx/rack/plans/plan%2Fx/layout/options');
  assert.equal(call.options.method,'POST');assert.equal(call.options.signal,signal);assert.deepEqual(JSON.parse(call.options.body),body);
  assert.equal(call.options.headers['If-Match'],undefined);assert.equal(call.options.headers['Idempotency-Key'],undefined);
});
