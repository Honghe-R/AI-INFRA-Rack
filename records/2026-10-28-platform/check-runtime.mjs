// Run from the repository: node --env-file=.env records/2026-10-28-platform/check-runtime.mjs
// Reads seeded data; creates and removes one unique storage smoke-test object.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@ai-infra/db';
import { createStorage } from '@ai-infra/storage';
import { loadConfig } from '@ai-infra/core';
import { DEV_ORGANISATIONS } from '../../scripts/lib/dev-identities.mjs';

const config = loadConfig();
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
assert.equal(new URL(config.databaseUrl).hostname, '127.0.0.1');
const pool = createPool({ connectionString: config.databaseUrl });
const web = `http://localhost:${process.env.WEB_PORT}`;
async function json(path, subject = 'dev-user') {
  const response = await fetch(`${web}${path}`, {
    headers: { 'x-dev-subject': subject }, signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return (await response.json()).data;
}

try {
  const extensions = await pool.query('SELECT PostGIS_Version() AS postgis');
  const migrations = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(migrations.rows[0].n, 6);
  console.log(`Database connected; PostGIS ${extensions.rows[0].postgis}; 6 migrations recorded.`);
  assert.equal((await fetch(`${process.env.API_URL}/readyz`)).status, 200);
  assert.equal((await fetch(`${process.env.API_URL}/api/v1/projects`)).status, 401);

  const targets = await pool.query('SELECT project_id, organization_id, name FROM projects ORDER BY name');
  assert.equal(targets.rows.length, 2);
  for (const project of targets.rows) {
    const definition = DEV_ORGANISATIONS.find((org) => org.projectName === project.name);
    assert.ok(definition);
    const subject = definition.ownerSubject;
    const listed = await json(`/api/v1/projects?organisation_id=${project.organization_id}`, subject);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].projectId, project.project_id);
    const scenarios = await json(`/api/v1/projects/${project.project_id}/scenarios`, subject);
    assert.equal(scenarios.length, 1);
    const revision = scenarios[0].activeRevision.revisionId;
    const facilityPath = `/api/v1/projects/${project.project_id}/facility/revisions/${revision}`;
    const graph = await json(facilityPath, subject);
    assert.ok(graph.designContext.containers.length > 0);
    assert.ok(graph.geometryRecords.length > 0);
    const assets = await json(`/api/v1/projects/${project.project_id}/assets`, subject);
    assert.equal(assets.length, 5);
    const foreignSubject = subject === 'dev-user' ? 'dev-second-admin' : 'dev-user';
    const denied = await fetch(`${web}${facilityPath}`, { headers: { 'x-dev-subject': foreignSubject } });
    assert.ok([403, 404].includes(denied.status));
    console.log(`${project.name}: project/scenario/facility/assets HTTP 200; ${graph.designContext.containers.length} containers, ${graph.geometryRecords.length} geometries, 5 assets; foreign identity denied (${denied.status}).`);
  }
  const storage = createStorage(config);
  const key = `runtime-check/${randomUUID()}.txt`;
  const content = Buffer.from('Rack local S3 compatibility check\n');
  try {
    await storage.putObject({ key, body: content, contentType: 'text/plain', contentLength: content.length });
    assert.equal((await storage.headObject({ key })).size, content.length);
    const object = await storage.getObject({ key });
    assert.equal(await new Response(object.body).text(), content.toString());
    const signed = storage.signedDownloadUrl({ key, expiresIn: 60 });
    const response = await fetch(signed.url ?? signed, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), content.toString());
    console.log('RustFS through existing S3 driver: PUT/HEAD/GET/signed download succeeded.');
  } finally {
    await storage.deleteObject({ key });
  }
  const tile = await fetch(`http://127.0.0.1:${process.env.TILE_PORT}/tiles/0/0/0.png`);
  assert.equal(tile.status, 200);
  assert.match(tile.headers.get('content-type'), /image\/png/);
  console.log('Local synthetic grid tiles: HTTP 200 image/png. These are not geographic basemap imagery.');
  console.log('Runtime smoke checks passed. This is not a full repository test or a database RLS security audit.');
} finally {
  await pool.end();
}
