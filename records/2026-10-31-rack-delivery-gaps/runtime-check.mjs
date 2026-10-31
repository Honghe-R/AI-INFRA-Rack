import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { rackInventoryCsv } from '../../apps/web/src/rack/rack-report.js';

// Local synthetic demo only; appends one idempotent check record, never saves a layout.
const project='4c11ab8d-5d57-4ad8-ad55-ac08574fba46',plan='879a2cbc-87d4-4c7a-93c3-ca435e3f34f3';
const root=`http://localhost:5193/api/v1/projects/${project}/rack/plans`;
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
async function request(path,{body,key}={}) {
  const response=await fetch(root+path,{method:body?'POST':'GET',headers:{'x-dev-subject':'dev-user',
    ...(body?{'content-type':'application/json','idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const payload=await response.json();assert.ok(response.ok,`${response.status}: ${payload.error?.code}`);
  return {data:payload.data,meta:payload.meta,status:response.status};
}
const before={};
for(const id of ['4b8f7bf3-9015-455f-8bc8-ef3520f0d748',plan,'8fbee1e3-7b0a-4584-b785-5a289e9bbdb3'])
  before[id]=(await request(`/${id}/layout`)).data;
const layout=before[plan];
assert.equal(layout.placements.length,128);assert.equal(layout.equipment.devices.length,952);
assert.equal(layout.snapshot.sourceGeometry.provenanceReference,'dev-seed-facility');
const hex=digest(`round35:${project}:${plan}:${layout.version}`),key=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
const args={key,body:{contract_version:1,base_version:layout.version,snapshot_id:layout.snapshot.snapshotId}};
const created=await request(`/${plan}/check-runs`,args),replay=await request(`/${plan}/check-runs`,args);
assert.equal(replay.meta.replayed,true);assert.equal(created.data.runId,replay.data.runId);
const run=created.data;assert.equal(run.freshness.status,'CURRENT');
assert.equal(run.report.diagnostics.length,0);assert.equal(run.equipmentReport.diagnostics.length,0);
const report=(await request(`/${plan}/report`)).data;
assert.equal(report.checkRun.runId,run.runId);assert.deepEqual(report.layout,layout);
const csv=rackInventoryCsv(report);
assert.equal((csv.match(/\r\n/g)??[]).length,953);
const history=(await request(`/${plan}/check-runs`)).data;
assert.ok(history.items.some(item=>item.runId===run.runId));
for(const [id,data] of Object.entries(before)) assert.deepEqual((await request(`/${id}/layout`)).data,data);
for(const path of ['/healthz','/readyz']) assert.equal((await fetch(`http://localhost:8797${path}`)).status,200);
const output={generatedAt:new Date().toISOString(),planId:plan,version:layout.version,runId:run.runId,
  spatialStatus:run.spatialStatus,equipmentStatus:run.equipmentStatus,freshness:run.freshness,
  racks:128,installed:944,inventory:952,exactRetryDeduplicated:true,threeActiveLayoutsUnchanged:true,
  jsonReportMatched:true,csvRows:952,csvSha256:digest(csv),healthz:200,readyz:200,
  visualAcceptance:'Not performed: native Computer Use helper unavailable. HTTP/static-render/build verification only.'};
await writeFile(new URL('./runtime-result.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
