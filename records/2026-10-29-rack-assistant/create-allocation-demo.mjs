// Local synthetic example via ordinary HTTP commands; never reset existing data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
assert.equal(process.env.COMPOSE_PROJECT_NAME,'ai-infra-rack-dev');
const database=new URL(process.env.DATABASE_URL);assert.equal(database.hostname,'127.0.0.1');assert.equal(database.pathname,'/rack_facility');
const port=Number(process.env.WEB_PORT);assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535);
const projectId='4c11ab8d-5d57-4ad8-ad55-ac08574fba46';
const ids=['e446aafb-1846-4a69-af10-636fd50ba87c','cb017b9b-ca11-483b-a5fd-c8f527195072','88e1821b-e8fe-49ce-ba9e-ecfda6925c77','24b5422e-8206-4a76-bdf5-9f7e93a05aac','3abd796d-461a-45f6-a0ce-ced7bce99020'];
const root=`/api/v1/projects/${projectId}/rack/plans`;
async function request(path,body,method='POST',version=null) {
  const response=await fetch(`http://localhost:${port}${path}`,{method:body?method:'GET',headers:{'x-dev-subject':'dev-user',...(body?{'content-type':'application/json','idempotency-key':randomUUID()}:{}),...(version?{'if-match':`"${version}"`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  const payload=await response.json();assert.ok(response.ok,JSON.stringify(payload));return payload.data;
}
const before=await Promise.all(ids.map(id=>request(`${root}/${id}/layout`)));
const source=before[0];assert.equal(source.sourceStatus.status,'UNCHANGED');assert.equal(source.snapshot.sourceGeometry.provenanceReference,'dev-seed-facility');
const name='Rack allocation demo — unassigned devices';
const existing=(await request(`${root}?limit=50&scenario_id=${source.scenarioId}&revision_id=${source.facilityInput.revisionId}`)).items.find(p=>p.name===name);
let planId=existing?.planId;
if(!planId) {
  const created=await request(root,{contract_version:1,name,scenario_id:source.scenarioId,facility_input:{revision_id:source.facilityInput.revisionId,container_id:source.facilityInput.containerId,revision_etag:source.facilityInput.revisionEtag}});
  planId=created.planId;
  const empty=await request(`${root}/${planId}/layout`);
  const racks=source.placements.slice(0,3).map((p,i)=>({...p,rackId:randomUUID(),name:`Allocation rack ${String.fromCharCode(65+i)}`,locked:i===0}));
  const device=(label,heightU,weightKg,powerKw,rackId=null)=>({deviceId:randomUUID(),name:label,heightU,weightKg,powerKw,coolingKw:powerKw,rackId,startU:rackId?1:null});
  const equipment={coverage:'UNKNOWN',source:{kind:'ASSUMED',reference:'Synthetic course allocation experiment; quantities are illustrative assumptions, not vendor specifications.'},
    devices:[device('Existing locked-rack device',2,20,1,racks[0].rackId),device('Unassigned 8U example',8,40,4),device('Unassigned 4U example',4,20,1),device('Unassigned 2U example',2,10,1),device('Oversized 100U example',100,10,1),device('Unknown weight example',2,null,1)],
    rackLimits:racks.map(r=>({rackId:r.rackId,maxWeightKg:100,maxPowerKw:6,maxCoolingKw:6}))};
  const body={contract_version:1,snapshot_id:empty.snapshot.snapshotId,placements:racks,constraints:empty.constraints,equipment};
  const checked=await request(`${root}/${planId}/layout/check`,body);assert.equal(checked.report.diagnostics.length,0);assert.equal(checked.equipmentReport.diagnostics.length,0);
  await request(`${root}/${planId}/layout`,body,'PUT',empty.version);
}
const saved=await request(`${root}/${planId}/layout`);
const result=await request(`${root}/${planId}/layout/equipment-options`,{contract_version:1,base_version:saved.version,snapshot_id:saved.snapshot.snapshotId});
assert.deepEqual(await Promise.all(ids.map(id=>request(`${root}/${id}/layout`))),before);
assert.deepEqual(await request(`${root}/${planId}/layout`),saved);
const summary={name,planId,version:saved.version,racks:saved.placements.length,devices:saved.equipment.devices.length,
  metrics:result.candidates[0].metrics,canStage:result.candidates[0].canStage,remainingReasons:result.candidates[0].unassigned,unchangedOldDemos:ids.length};
await writeFile(new URL('./allocation-demo.json',import.meta.url),JSON.stringify({summary,result},null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
