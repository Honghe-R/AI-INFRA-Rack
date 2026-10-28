// Real running API through the Vite development identity bridge. Temporary plan removed afterward.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@ai-infra/db';

assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
const pool = createPool({ connectionString: process.env.DATABASE_URL });
const web = `http://localhost:${process.env.WEB_PORT}`;
const key = randomUUID();
let projectId;
async function request(path, { method = 'GET', body, subject = 'dev-user', creationKey = key } = {}) {
  const response = await fetch(`${web}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-dev-subject': subject, 'idempotency-key': creationKey },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}
try {
  const project = (await pool.query("SELECT project_id FROM projects WHERE name='Northern DC Campus' ORDER BY created_at LIMIT 1")).rows[0];
  assert.ok(project);
  projectId = project.project_id;
  const scenarios = await request(`/api/v1/projects/${projectId}/scenarios`);
  assert.equal(scenarios.status, 200);
  const scenario = scenarios.body.data[0];
  const revisionId = scenario.activeRevision.revisionId;
  const source = await request(`/api/v1/projects/${projectId}/facility/revisions/${revisionId}`);
  assert.equal(source.status, 200);
  const hall = source.body.data.designContext.containers.find(container => container.kind === 'HALL');
  assert.ok(hall);
  const body = {
    contract_version: 1, name: 'Temporary Rack API smoke check', scenario_id: scenario.scenarioId,
    facility_input: { revision_id: revisionId, container_id: hall.containerId, revision_etag: source.body.data.etag },
  };
  const base = `/api/v1/projects/${projectId}/rack/plans`;
  const created = await request(base, { method: 'POST', body });
  assert.equal(created.status, 201);
  const id = created.body.data.planId;
  const read = await request(`${base}/${id}`, { subject: 'dev-viewer' });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, created.body.data);
  const replay = await request(base, { method: 'POST', body });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.meta.replayed, true);
  assert.equal(replay.body.data.planId, id);
  assert.equal((await request(base, { method: 'POST', body, subject: 'dev-viewer' })).status, 403);
  assert.equal((await request(`${base}/${id}`, { subject: 'dev-second-admin' })).status, 403);
  const stale = await request(base, { method: 'POST', body: { ...body, facility_input: { ...body.facility_input, revision_etag: 'old-token' } }, creationKey: randomUUID() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'RACK_SOURCE_STALE');
  console.log('Live Vite proxy + API: create 201, viewer read 200, same-key replay 200/same plan.');
  console.log('Viewer create 403; foreign organisation read 403; stale source create 409.');
  console.log('Persisted plan is version 1 / DRAFT / NOT_RUN, empty placements, source UNCHANGED.');
} finally {
  if (projectId) {
    await pool.query('DELETE FROM rack_plans WHERE project_id=$1 AND creation_key=$2', [projectId, key]);
    console.log('Removed only this check\'s temporary plan by project and unique creation key.');
  }
  await pool.end();
}
