import assert from 'node:assert/strict';
import { createPool } from '@ai-infra/db';

assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
const dbUrl = new URL(process.env.DATABASE_URL);
assert.equal(dbUrl.hostname, '127.0.0.1');
assert.equal(dbUrl.pathname, '/rack_facility');
const pool = createPool({ connectionString: dbUrl.toString() });
const id = '88e1821b-e8fe-49ce-ba9e-ecfda6925c77';
async function request(path, subject = 'dev-user', body) {
  const response = await fetch(`http://localhost:${process.env.WEB_PORT}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-dev-subject': subject, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json(), etag: response.headers.get('etag') };
}
try {
  const before = (await pool.query('SELECT * FROM rack_plans WHERE plan_id=$1', [id])).rows[0];
  assert.ok(before);
  const base = `/api/v1/projects/${before.project_id}/rack/plans/${id}`;
  const response = await request(`${base}/layout`);
  assert.equal(response.status, 200);
  assert.equal(response.etag, '"2"');
  const layout = response.body.data;
  assert.equal(layout.version, 2);
  assert.equal(layout.validationState, 'NOT_RUN');
  assert.equal(layout.sourceStatus.status, 'UNCHANGED');
  assert.equal(layout.placements.length, 2);
  assert.deepEqual(layout.constraints, before.spatial_constraints);
  assert.equal(layout.constraints.obstacleCoverage, 'DECLARED_COMPLETE');
  assert.deepEqual(layout.constraints.clearance, { frontM: 1, rearM: 0.5 });
  assert.equal(layout.constraints.source.kind, 'ASSUMED');
  assert.equal(layout.constraints.obstacles.length, 1);
  assert.equal(layout.constraints.obstacles[0].name, 'Assumed no-go block');
  assert.equal(layout.constraints.obstacles[0].xM, 58);
  assert.equal(layout.constraints.obstacles[0].yM, 45.82);
  const snapshot = (await pool.query('SELECT * FROM rack_room_snapshots WHERE plan_id=$1', [id])).rows[0];
  assert.deepEqual(layout.snapshot, { snapshotId: snapshot.snapshot_id, ...snapshot.document });
  const placements = (await pool.query(`SELECT rack_id AS "rackId",model_id AS "modelId",name,x_m AS "xM",y_m AS "yM",rotation_deg AS "rotationDeg",locked FROM rack_placements WHERE plan_id=$1 ORDER BY rack_id`, [id])).rows;
  assert.deepEqual(layout.placements, placements);
  assert.equal(placements.find(p => p.name === 'B02').rotationDeg, 90);
  const viewer = await request(`${base}/layout`, 'dev-viewer');
  assert.equal(viewer.status, 200);
  assert.deepEqual(viewer.body.data, layout);
  assert.equal((await request(`${base}/layout`, 'dev-second-admin')).status, 403);
  const checkBody = { contract_version: 1, snapshot_id: snapshot.snapshot_id, placements, constraints: layout.constraints };
  const checked = await request(`${base}/layout/check`, 'dev-viewer', checkBody);
  assert.equal(checked.status, 200);
  const report = checked.body.data.report;
  assert.equal(report.status, 'CHECKED_SCOPE_CLEAR');
  assert.equal(report.racksChecked, 2);
  assert.equal(report.pairsChecked, 1);
  assert.equal(report.obstaclesChecked, 1);
  assert.equal(report.clearanceBandsChecked, 4);
  assert.equal(report.diagnostics.length, 0);
  assert.equal((await request(`${base}/layout/check`, 'dev-second-admin', checkBody)).status, 403);
  assert.deepEqual((await pool.query('SELECT * FROM rack_plans WHERE plan_id=$1', [id])).rows[0], before);
  for (const [oldId, version, count] of [
    ['24b5422e-8206-4a76-bdf5-9f7e93a05aac', 4, 2],
    ['3abd796d-461a-45f6-a0ce-ced7bce99020', 1, 0],
  ]) {
    const old = (await pool.query('SELECT version,source_revision_etag,spatial_constraints FROM rack_plans WHERE plan_id=$1', [oldId])).rows[0];
    assert.equal(old.version, version);
    assert.equal(old.source_revision_etag, '1f1b35f2-b80b-4831-8c29-065b2ea848bf');
    assert.equal(old.spatial_constraints.obstacleCoverage, 'UNKNOWN');
    assert.equal(old.spatial_constraints.clearance, null);
    assert.equal((await pool.query('SELECT * FROM rack_placements WHERE plan_id=$1', [oldId])).rowCount, count);
    const oldLayout = await request(`/api/v1/projects/${before.project_id}/rack/plans/${oldId}/layout`);
    assert.equal(oldLayout.status, 200);
    assert.equal(oldLayout.body.data.sourceStatus.status, 'UNCHANGED');
  }
  console.log(`Live constraints demo ${id}: v2, two racks, one assumed obstacle, four maintenance bands.`);
  console.log('Snapshot, full-precision placements and constraints match SQL; front 1 m / rear 0.5 m.');
  console.log('Admin/viewer GET and viewer check 200; other organisation GET/check 403; HTTP ETag "2".');
  console.log('CHECKED_SCOPE_CLEAR within declared scope; no diagnostics; whole-plan NOT_RUN retained.');
  console.log('Read/check left saved row unchanged; prior v4/v1 demos and Facility source ETag retained.');
} finally {
  await pool.end();
}
