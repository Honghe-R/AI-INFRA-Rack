// Read-only comparison of the browser-created local demonstration with SQL/API.
import assert from 'node:assert/strict';
import { createPool } from '@ai-infra/db';

assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
const pool = createPool({ connectionString: process.env.DATABASE_URL });
const id = '3abd796d-461a-45f6-a0ce-ced7bce99020';
async function request(path, subject = 'dev-user') {
  const response = await fetch(`http://localhost:${process.env.WEB_PORT}${path}`, {
    headers: { 'x-dev-subject': subject }, signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
try {
  const rows = (await pool.query(`SELECT p.*, j.name AS project_name FROM rack_plans p
    JOIN projects j ON j.project_id=p.project_id WHERE p.plan_id=$1`, [id])).rows;
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.project_name, 'Northern DC Campus');
  assert.equal(row.name, 'Rack UI demo — Hall A1');
  const base = `/api/v1/projects/${row.project_id}/rack/plans`;
  const admin = (await request(`${base}/${id}`)).data;
  const viewer = (await request(`${base}/${id}`, 'dev-viewer')).data;
  assert.deepEqual(viewer, admin);
  assert.equal(admin.planId, id);
  assert.equal(admin.createdAt, row.created_at.toISOString());
  assert.equal(admin.facilityInput.containerId, row.source_container_id);
  assert.equal(admin.facilityInput.revisionEtag, row.source_revision_etag);
  assert.equal(admin.version, 1);
  assert.equal(admin.state, 'DRAFT');
  assert.equal(admin.validationState, 'NOT_RUN');
  assert.deepEqual(admin.placements, []);
  const list = (await request(`${base}?scenario_id=${row.scenario_id}&revision_id=${row.source_revision_id}`)).data;
  assert.deepEqual(list.items.find(plan => plan.planId === id), admin);
  console.log('Browser demo exists exactly once in SQL. List, detail and viewer GET agree.');
  console.log(`Plan ${id}: v1 / DRAFT / NOT_RUN; no rack placements.`);
  console.log(`Current Facility status: ${admin.facilityInputStatus.status}. No test mutation or seed executed.`);
} finally { await pool.end(); }
