import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RackCheckHistory } from '../rack/RackCheckHistory.jsx';
import { assertRackReportScope, rackInventoryCsv, savedCheckBlockReason } from '../rack/rack-report.js';
import { createApiClient } from '../api/client.js';

const layout = { projectId: 'p', planId: 'plan', version: 3, snapshot: { snapshotId: 's' }, sourceStatus: {status:'UNCHANGED'},
  placements: [{rackId:'r',name:'Rack,"A"'}], equipment: {devices:[
    {deviceId:'d',name:'=HYPERLINK("url")',rackId:'r',startU:4,heightU:2,weightKg:null,powerKw:0,coolingKw:2,catalogRef:{modelId:'gpu',version:1}},
    {deviceId:'u',name:' \t+cmd\nName',rackId:null,startU:null,heightU:1,weightKg:3,powerKw:null,coolingKw:null},
  ]} };
const report = {contractVersion:1,kind:'RACK_PLANNING_REPORT',layout};
test('report scope rejects another project, plan, version, snapshot and contract', () => {
  assert.equal(assertRackReportScope(report,layout),report);
  for (const patch of [{projectId:'other'},{planId:'other'},{version:4},{snapshot:{snapshotId:'other'}}])
    assert.throws(() => assertRackReportScope({...report,layout:{...layout,...patch}},layout), /Reload/);
  assert.throws(() => assertRackReportScope({...report,contractVersion:2},layout), /Reload/);
});
test('inventory CSV preserves installed/pending U intervals, zero/unknown, pinned models and neutralizes formulas', () => {
  const csv=rackInventoryCsv(report);
  assert.ok(csv.startsWith('\ufeff"project_id"'));
  assert.ok(csv.includes('"INSTALLED","r","Rack,""A""","4","5","2","","0","2","gpu","1"'));
  assert.ok(csv.includes('"UNASSIGNED","","","","","1","3","","","",""'));
  assert.ok(csv.includes('"\'=HYPERLINK(""url"")"'));
  assert.ok(csv.includes('"\' \t+cmd\nName"'));
  assert.ok(!csv.includes('undefined') && !csv.includes('NaN') && !csv.includes('null'));
  assert.equal((csv.match(/\r\n/g)??[]).length,3);
});
test('saved evidence is gated by write permission, draft, snapshot and source while viewer downloads remain available', () => {
  assert.equal(savedCheckBlockReason(layout,null,true),null);
  for(const [data,draft,canWrite] of [[layout,null,false],[layout,{},true],[{...layout,snapshot:null},null,true],
    [{...layout,sourceStatus:{status:'STALE'}},null,true]]) assert.ok(savedCheckBlockReason(data,draft,canWrite));
  const viewer=renderToStaticMarkup(<RackCheckHistory client={{}} layout={layout} canWrite={false}/>);
  assert.ok(viewer.includes('Rack edit permission') && viewer.includes('NOT_RUN'));
  assert.ok(viewer.includes('disabled="" title="Recording requires Rack edit permission."'));
  assert.ok(viewer.includes('<button>Download plan JSON</button>'));
  const dirty=renderToStaticMarkup(<RackCheckHistory client={{}} layout={layout} draft={{}} canWrite/>);
  assert.ok(dirty.includes('Save or discard your draft'));
  assert.ok(dirty.includes('<button disabled="">Download equipment CSV</button>'));
});
test('check/report API client encodes scope, carries abort and preserves recording retry key and body', async () => {
  const calls=[],signal=new AbortController().signal,body={contract_version:1,base_version:3,snapshot_id:'s'};
  const client=createApiClient({identity:()=> 'viewer',fetchImpl:async(url,options)=>{
    calls.push({url,options});return{ok:true,json:async()=>({data:{}})};
  }});
  await client.listRackCheckRuns('p/x','id/x',{signal});
  await client.getRackCheckRun('p/x','id/x','run/x',{signal});
  await client.getRackReport('p/x','id/x',{signal});
  await client.recordRackCheckRun('p/x','id/x',body,{idempotencyKey:'retry-key',signal});
  assert.ok(calls[0].url.endsWith('/p%2Fx/rack/plans/id%2Fx/check-runs'));
  assert.ok(calls[1].url.endsWith('/check-runs/run%2Fx'));
  assert.ok(calls[2].url.endsWith('/report'));
  assert.equal(calls[3].options.method,'POST');
  assert.equal(calls[3].options.headers['Idempotency-Key'],'retry-key');
  assert.deepEqual(JSON.parse(calls[3].options.body),body);
  for(const c of calls){assert.equal(c.options.signal,signal);assert.equal(c.options.cache,'no-store');}
});
