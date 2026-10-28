// Read-only comparison of the existing local demo, PostgreSQL/PostGIS and Vite API.
import assert from 'node:assert/strict';
import {createPool} from '@ai-infra/db';
assert.equal(process.env.COMPOSE_PROJECT_NAME,'ai-infra-rack-dev');
const pool=createPool({connectionString:process.env.DATABASE_URL});
const id='3abd796d-461a-45f6-a0ce-ced7bce99020';
async function request(path,subject='dev-user') {
  const response=await fetch(`http://localhost:${process.env.WEB_PORT}${path}`,{
    headers:{'x-dev-subject':subject},signal:AbortSignal.timeout(10000),
  });
  return {status:response.status,body:await response.json()};
}
try {
  const before=(await pool.query('SELECT * FROM rack_plans WHERE plan_id=$1',[id])).rows[0];
  assert.ok(before);
  const base=`/api/v1/projects/${before.project_id}/rack/plans/${id}`;
  const admin=await request(`${base}/room-view`);
  assert.equal(admin.status,200);
  const data=admin.body.data;
  assert.equal(data.status,'AVAILABLE');
  assert.equal(data.facilityInput.revisionEtag,before.source_revision_etag);
  assert.equal(data.facilityInputStatus.status,'UNCHANGED');
  const source=(await pool.query(`SELECT ST_AsGeoJSON(projected_geometry,15,0)::json AS geometry,
    ST_Area(projected_geometry) AS area, projected_crs FROM geometry_records
    WHERE project_id=$1 AND geometry_id=$2`,[before.project_id,data.sourceGeometry.geometryId])).rows[0];
  const local=data.view.boundaryLocalM.coordinates;
  assert.equal(local.length,source.geometry.coordinates.length);
  source.geometry.coordinates.forEach((ring,r)=>{
    assert.equal(local[r].length,ring.length);
    ring.forEach((point,p)=>point.forEach((value,axis)=>{
      assert.ok(Math.abs(local[r][p][axis]-(value-data.view.originProjectedM[axis]))<1e-9);
    }));
  });
  assert.ok(Math.abs(data.view.areaM2-source.area)<1e-6);
  assert.equal(data.view.sourceCrs,source.projected_crs);
  const viewer=await request(`${base}/room-view`,'dev-viewer');
  assert.equal(viewer.status,200);
  assert.deepEqual(viewer.body.data,data);
  assert.equal((await request(`${base}/room-view`,'dev-second-admin')).status,403);
  assert.deepEqual((await pool.query('SELECT * FROM rack_plans WHERE plan_id=$1',[id])).rows[0],before);
  console.log('Live Vite + API: admin/viewer room view 200; another organisation 403.');
  console.log(`Source ${source.projected_crs}; ${local.length} ring(s); every vertex equals stored projected point minus the declared origin.`);
  console.log(`Projected extents ${data.view.extentM.width.toFixed(2)} x ${data.view.extentM.height.toFixed(2)} m; polygon area ${data.view.areaM2.toFixed(2)} m2 agrees with PostGIS within 1e-6 m2.`);
  console.log(`Provenance ${data.sourceGeometry.provenanceReference}; georeferencing review ${data.sourceGeometry.transformReviewState}; obstacles ${data.view.obstacleCoverage}.`);
  console.log('Saved plan row unchanged. No seed, snapshot, geometry update or placement mutation.');
} finally {await pool.end();}
