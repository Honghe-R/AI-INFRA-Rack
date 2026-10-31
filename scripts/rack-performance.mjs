#!/usr/bin/env node
// Read/computation only. No saves, seed/reset, provider calls or credentials.
import assert from 'node:assert/strict';
import { cpus, platform, release, totalmem } from 'node:os';

const [projectId, ...planIds] = process.argv.slice(2), uuid=/^[0-9a-f-]{36}$/i;
assert.ok(uuid.test(projectId??'') && planIds.length>=1 && planIds.length<=3 && planIds.every(id=>uuid.test(id)),
  'Usage: node --env-file-if-exists=.env scripts/rack-performance.mjs <project UUID> <plan UUID> [plan UUID] [plan UUID]');
const port=Number(process.env.WEB_PORT??5193);
assert.ok(Number.isInteger(port)&&port>0&&port<=65535,'Invalid local Web port');
const base=`http://localhost:${port}/api/v1/projects/${projectId}/rack/plans`, repetitions=5;
async function request(path,body) {
  const started=performance.now();
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'x-dev-subject':'dev-user',
    ...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const payload=await response.json();
  assert.ok(response.ok,`${response.status}: ${payload.error?.code??'request failed'}`);
  return {data:payload.data,ms:+(performance.now()-started).toFixed(3)};
}
const result={kind:'RACK_LOCAL_PERFORMANCE_SAMPLE',generatedAt:new Date().toISOString(),repetitions,warmupsPerOperation:1,
  environment:{node:process.version,platform:platform(),osRelease:release(),cpu:cpus()[0]?.model,
    logicalCpus:cpus().length,memoryGiB:+(totalmem()/1024**3).toFixed(2)},
  scope:'Sequential local HTTP round trips including proxy, authentication, SQL, domain checks, serialization and JSON parsing. Not a concurrency/load test, optimizer benchmark or SLA.',
  plans:[]};
for(const planId of planIds) {
  const initial=(await request(`/${planId}/layout`)).data;
  assert.equal(initial.sourceStatus.status,'UNCHANGED');assert.ok(initial.snapshot,'Snapshot required');
  const body={contract_version:1,snapshot_id:initial.snapshot.snapshotId,placements:initial.placements,
    constraints:initial.constraints,equipment:initial.equipment};
  const operations={};
  for(const [name,path,bodyArg] of [['read',`/${planId}/layout`],['check',`/${planId}/layout/check`,body],['report',`/${planId}/report`]]) {
    await request(path,bodyArg); // Discard one warmup per operation.
    const samplesMs=[];
    for(let i=0;i<repetitions;i++) {
      const sample=await request(path,bodyArg);samplesMs.push(sample.ms);
      if(name==='check') {
        assert.equal(sample.data.report.diagnostics.length,0,'Fixture spatial conflicts');
        assert.equal(sample.data.equipmentReport.diagnostics.length,0,'Fixture equipment conflicts');
      }
    }
    const sorted=[...samplesMs].sort((a,b)=>a-b);
    operations[name]={samplesMs,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1]};
  }
  assert.deepEqual((await request(`/${planId}/layout`)).data,initial,'A computation changed the saved layout or another actor edited it; rerun on a stable fixture.');
  result.plans.push({planId,version:initial.version,racks:initial.placements.length,inventory:initial.equipment.devices.length,
    installed:initial.equipment.devices.filter(d=>d.rackId!==null).length,
    rackPairs:initial.placements.length*(initial.placements.length-1)/2,
    obstacles:initial.constraints.obstacles.length,polygonVertices:initial.snapshot.view.boundaryLocalM.coordinates.flat().length,
    savedLayoutPreserved:true,operations});
}
console.log(JSON.stringify(result,null,2));
