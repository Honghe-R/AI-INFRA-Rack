// Read-only local replay/performance probe. Never create or save plans.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
assert.equal(process.env.COMPOSE_PROJECT_NAME,'ai-infra-rack-dev');
const db = new URL(process.env.DATABASE_URL);
assert.equal(db.hostname,'127.0.0.1');assert.equal(db.pathname,'/rack_facility');
const port=Number(process.env.WEB_PORT);assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535);
const projectId='4c11ab8d-5d57-4ad8-ad55-ac08574fba46';
const ids=['e446aafb-1846-4a69-af10-636fd50ba87c','cb017b9b-ca11-483b-a5fd-c8f527195072',
  '88e1821b-e8fe-49ce-ba9e-ecfda6925c77','24b5422e-8206-4a76-bdf5-9f7e93a05aac','3abd796d-461a-45f6-a0ce-ced7bce99020'];
async function request(id,suffix='',body){
  const response=await fetch(`http://localhost:${port}/api/v1/projects/${projectId}/rack/plans/${id}/layout${suffix}`,{
    method:body?'POST':'GET',headers:{'x-dev-subject':'dev-user',...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(22000)});
  const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));return payload.data;
}
const before=await Promise.all(ids.map(id=>request(id)));
const layout=before[0];assert.equal(layout.snapshot.sourceGeometry.provenanceReference,'dev-seed-facility');
const body={contract_version:1,base_version:layout.version,snapshot_id:layout.snapshot.snapshotId,
  options:{grid_step_m:.5,allow_rotation:true,strategy:'COMPARE'}};
const runs=[];
for(let i=0;i<2;i++){
  const started=performance.now();const result=await request(ids[0],'/options',body);
  assert.ok(result.candidates.every(c=>c.canStage&&c.unplaced.length===0));
  for(const candidate of result.candidates)assert.deepEqual(candidate.body.equipment,layout.equipment);
  if(runs.length)assert.deepEqual(result.candidates,runs[0].result.candidates);
  runs.push({wallMs:Math.round(performance.now()-started),result});
}
assert.deepEqual(await Promise.all(ids.map(id=>request(id))),before);
await writeFile(new URL('./live-results.json',import.meta.url),JSON.stringify({body,runs},null,2)+'\n');
console.log(JSON.stringify({planId:layout.planId,baseVersion:layout.version,racks:layout.placements.length,devices:layout.equipment.devices.length,
  gridStepM:.5,wallMs:runs.map(r=>r.wallMs),serverMs:runs.map(r=>r.result.elapsedMs),
  baselineAreaM2:runs[0].result.baseline.metrics.envelopeAreaM2,
  options:runs[0].result.candidates.map(c=>({algorithm:c.algorithmId,areaM2:c.metrics.envelopeAreaM2,movementM:c.metrics.movementM,
    positionsSubmitted:c.positionsSubmitted,spatial:c.report.status,equipment:c.equipmentReport.status,unplaced:c.unplaced.length})),
  unchangedDemos:ids.length,repeatable:true},null,2));
