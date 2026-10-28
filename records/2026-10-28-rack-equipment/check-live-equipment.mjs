import assert from 'node:assert/strict';
import { createPool } from '@ai-infra/db';

assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
const dbUrl = new URL(process.env.DATABASE_URL);
assert.equal(dbUrl.hostname, '127.0.0.1');
assert.equal(dbUrl.pathname, '/rack_facility');
const pool = createPool({ connectionString: dbUrl.toString() });
const projectId = '4c11ab8d-5d57-4ad8-ad55-ac08574fba46';
async function request(path, subject = 'dev-user', body) {
  const response = await fetch(`http://localhost:${process.env.WEB_PORT}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-dev-subject': subject, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json(), etag: response.headers.get('etag') };
}
try {
  const rows = (await pool.query('SELECT * FROM rack_plans WHERE project_id=$1 AND name=$2', [projectId, 'Rack equipment demo — Hall A1'])).rows;
  assert.equal(rows.length, 1);
  const row = rows[0], id = row.plan_id, base = `/api/v1/projects/${projectId}/rack/plans/${id}/layout`;
  const response = await request(base);
  assert.equal(response.status, 200);
  assert.equal(response.etag, '"2"');
  const layout = response.body.data;
  assert.equal(layout.version, 2); assert.equal(layout.sourceStatus.status, 'UNCHANGED');
  assert.equal(layout.validationState, 'NOT_RUN');
  assert.deepEqual(layout.equipment, row.equipment);
  assert.equal(layout.equipment.devices.length, 2);
  assert.equal(layout.equipment.coverage, 'DECLARED_COMPLETE');
  assert.equal(layout.equipment.source.kind, 'ASSUMED');
  assert.equal(layout.placements.length, 1);
  const rack = layout.placements[0]; assert.equal(rack.name, 'C01');
  const gpu = layout.equipment.devices.find(d => d.name === 'Assumed GPU server');
  const tor = layout.equipment.devices.find(d => d.name === 'Assumed ToR switch');
  assert.deepEqual([gpu.heightU, gpu.startU, gpu.weightKg, gpu.powerKw, gpu.coolingKw], [4, 35, 80, 3, 3]);
  assert.deepEqual([tor.heightU, tor.startU, tor.weightKg, tor.powerKw, tor.coolingKw], [1, 41, 10, 0.3, 0.3]);
  assert.equal(gpu.rackId, rack.rackId); assert.equal(tor.rackId, rack.rackId);
  assert.deepEqual(layout.equipment.rackLimits, [{ rackId: rack.rackId, maxWeightKg: 500, maxPowerKw: 6, maxCoolingKw: 6 }]);
  const snapshot = (await pool.query('SELECT * FROM rack_room_snapshots WHERE plan_id=$1', [id])).rows[0];
  assert.deepEqual(layout.snapshot, { snapshotId: snapshot.snapshot_id, ...snapshot.document });
  const viewer = await request(base, 'dev-viewer'); assert.equal(viewer.status, 200); assert.deepEqual(viewer.body.data, layout);
  const body = { contract_version: 1, snapshot_id: snapshot.snapshot_id, placements: layout.placements, constraints: layout.constraints, equipment: layout.equipment };
  const checked = await request(`${base}/check`, 'dev-viewer', body); assert.equal(checked.status, 200);
  const report = checked.body.data.equipmentReport;
  assert.equal(report.status, 'CHECKED_SCOPE_CLEAR'); assert.equal(report.installedDevices, 2);
  assert.equal(report.racks[0].occupiedU, 5); assert.equal(report.racks[0].freeU, 37);
  assert.equal(report.racks[0].capacities.weightKg.total, 90);
  assert.equal(report.racks[0].capacities.powerKw.total, 3.3);
  assert.equal(report.racks[0].capacities.coolingKw.total, 3.3);
  assert.equal(report.diagnostics.length, 0);
  assert.equal(checked.body.data.report.status, 'INCOMPLETE', 'spatial assumptions were deliberately not declared complete');
  assert.equal((await request(base, 'dev-second-admin')).status, 403);
  assert.equal((await request(`${base}/check`, 'dev-second-admin', body)).status, 403);
  assert.deepEqual((await pool.query('SELECT * FROM rack_plans WHERE plan_id=$1', [id])).rows[0], row);
  for (const [oldId, version, count] of [
    ['88e1821b-e8fe-49ce-ba9e-ecfda6925c77', 2, 2],
    ['24b5422e-8206-4a76-bdf5-9f7e93a05aac', 4, 2],
    ['3abd796d-461a-45f6-a0ce-ced7bce99020', 1, 0],
  ]) {
    const old = (await pool.query('SELECT version,equipment,source_revision_etag FROM rack_plans WHERE plan_id=$1', [oldId])).rows[0];
    assert.equal(old.version, version); assert.deepEqual(old.equipment.devices, []);
    assert.equal(old.equipment.coverage, 'UNKNOWN');
    assert.equal(old.source_revision_etag, '1f1b35f2-b80b-4831-8c29-065b2ea848bf');
    assert.equal((await pool.query('SELECT rack_id FROM rack_placements WHERE plan_id=$1', [oldId])).rowCount, count);
    const oldLayout = await request(`/api/v1/projects/${projectId}/rack/plans/${oldId}/layout`);
    assert.equal(oldLayout.body.data.sourceStatus.status, 'UNCHANGED');
  }
  console.log(`Live equipment demo ${id}: v2, C01 / 42U, GPU U35-38, ToR U41.`);
  console.log('Equipment matches SQL; snapshot preserved; 5 U occupied, 37 free, 90 kg / 500 kg, 3.3 kW / 6 kW power and cooling.');
  console.log('Equipment CHECKED_SCOPE_CLEAR; spatial INCOMPLETE and whole-plan NOT_RUN remain separate.');
  console.log('Admin/viewer GET and viewer check 200; other organisation GET/check 403; exact ETag "2".');
  console.log('Read-only checks left row unchanged; previous three demos retain v2/v4/v1, placements and unknown empty equipment; Facility ETag unchanged.');
} finally { await pool.end(); }
