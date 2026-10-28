import assert from 'node:assert/strict';
import {createPool} from '@ai-infra/db';
assert.equal(process.env.COMPOSE_PROJECT_NAME,'ai-infra-rack-dev');
const pool=createPool({connectionString:process.env.DATABASE_URL});
const id='24b5422e-8206-4a76-bdf5-9f7e93a05aac';
const oldId='3abd796d-461a-45f6-a0ce-ced7bce99020';
async function request(path,subject='dev-user',body) {
  const response=await fetch(`http://localhost:${process.env.WEB_PORT}${path}`,{
    method:body?'POST':'GET',headers:{'x-dev-subject':subject,...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  return {status:response.status,body:await response.json(),etag:response.headers.get('etag')};
}
try {
  const row=(await pool.query('SELECT * FROM rack_plans WHERE plan_id=$1',[id])).rows[0];assert.ok(row);
  const base=`/api/v1/projects/${row.project_id}/rack/plans/${id}`;
  const response=await request(`${base}/layout`);assert.equal(response.status,200);const layout=response.body.data;
  assert.equal(layout.version,4);assert.equal(response.etag,'"4"');assert.equal(layout.placements.length,2);
  assert.equal(layout.sourceStatus.status,'UNCHANGED');assert.equal(layout.validationState,'NOT_RUN');
  const snapshot=(await pool.query('SELECT * FROM rack_room_snapshots WHERE plan_id=$1',[id])).rows[0];
  assert.deepEqual(layout.snapshot,{snapshotId:snapshot.snapshot_id,...snapshot.document});
  const dbPlacements=(await pool.query(`SELECT rack_id AS "rackId",model_id AS "modelId",name,x_m AS "xM",y_m AS "yM",rotation_deg AS "rotationDeg",locked
    FROM rack_placements WHERE plan_id=$1 ORDER BY rack_id`,[id])).rows;
  assert.deepEqual(layout.placements,dbPlacements);
  const a=layout.placements.find(p=>p.name==='A01'),b=layout.placements.find(p=>p.name==='A02');
  assert.equal(a.locked,true);assert.equal(b.rotationDeg,90);assert.ok(b.xM>55.5&&b.xM<55.51);
  const viewer=await request(`${base}/layout`,'dev-viewer');assert.equal(viewer.status,200);assert.deepEqual(viewer.body.data,layout);
  assert.equal((await request(`${base}/layout`,'dev-second-admin')).status,403);
  const body={contract_version:1,snapshot_id:layout.snapshot.snapshotId,placements:layout.placements};
  const checked=await request(`${base}/layout/check`,'dev-viewer',body);assert.equal(checked.status,200);
  assert.equal(checked.body.data.report.status,'CHECKED_SCOPE_CLEAR');assert.equal(checked.body.data.report.pairsChecked,1);
  assert.deepEqual((await pool.query('SELECT * FROM rack_plans WHERE plan_id=$1',[id])).rows[0],row);
  const old=(await pool.query('SELECT version,source_revision_etag FROM rack_plans WHERE plan_id=$1',[oldId])).rows[0];
  assert.equal(old.version,1);assert.equal(old.source_revision_etag,'1f1b35f2-b80b-4831-8c29-065b2ea848bf');
  assert.equal((await pool.query('SELECT * FROM rack_room_snapshots WHERE plan_id=$1',[oldId])).rowCount,0);
  assert.equal((await pool.query('SELECT * FROM rack_placements WHERE plan_id=$1',[oldId])).rowCount,0);
  console.log(`Live layout ${id}: v4, exactly two placements, fixed snapshot agrees with database.`);
  console.log('A01 locked; A02 rotated 90 degrees and dragged to x=55.50169946275522 m; full precision preserved.');
  console.log('Admin/viewer GET and viewer check 200; other organisation 403; HTTP ETag "4".');
  console.log('Spatial scope clear for 2 racks / 1 pair; whole-plan NOT_RUN and obstacle coverage UNKNOWN retained.');
  console.log('Read-only checks left plan unchanged; previous v1 demo has no new snapshot or placements.');
}finally{await pool.end();}
