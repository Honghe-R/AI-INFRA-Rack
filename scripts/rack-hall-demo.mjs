#!/usr/bin/env node
// Local synthetic demo via ordinary APIs. Never seed/reset or overwrite old plans.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHallDemoBody, hallDemoId, HALL_DEMO_NAME } from './lib/rack-hall-demo.mjs';

const [projectId, sourceId] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
assert.ok(uuid.test(projectId ?? '') && uuid.test(sourceId ?? ''), 'Usage: npm run rack:demo:hall -- <local-project-uuid> <source-plan-uuid>');
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
assert.equal(process.env.AI_INFRA_COMPOSE_FILE, 'compose.rack.yaml');
const db = new URL(process.env.DATABASE_URL);
assert.equal(db.hostname, '127.0.0.1'); assert.equal(db.port, '55532'); assert.equal(db.pathname, '/rack_facility');
const port = Number(process.env.WEB_PORT); assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const root = `http://localhost:${port}/api/v1/projects/${projectId}/rack`, seed = `${projectId}:${sourceId}`;
const timings = [];
async function request(path, method = 'GET', body, headers = {}) {
  const started = performance.now();
  const response = await fetch(root+path, { method, headers: { 'x-dev-subject': 'dev-user',
    ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? {body:JSON.stringify(body)} : {}), signal: AbortSignal.timeout(25000) });
  const text = await response.text();
  assert.ok(text.trim(), `${response.status}: Empty API response for ${method} ${path}; check local API readiness.`);
  const payload = JSON.parse(text);
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload.error)}`);
  timings.push({ method, endpoint: path.replace(/\/[0-9a-f-]{36}/g,'/:id'), durationMs: +(performance.now()-started).toFixed(2) });
  return payload.data;
}
const source = await request(`/plans/${sourceId}/layout`);
assert.equal(source.sourceStatus.status, 'UNCHANGED');
assert.equal(source.snapshot?.sourceGeometry.provenanceReference, 'dev-seed-facility', 'Only explicitly synthetic local source geometry is supported.');
const catalog = await request('/catalog');
const plans = []; let cursor = null;
do {
  const page = await request(`/plans?limit=50&scenario_id=${source.scenarioId}&revision_id=${source.facilityInput.revisionId}${cursor ? `&cursor=${cursor}` : ''}`);
  plans.push(...page.items); cursor = page.nextCursor;
  assert.ok(plans.length <= 1000, 'Refuse unexpectedly large demonstration project.');
} while (cursor);
// Recognize existing demos created before the English label update; never duplicate them.
const matches = plans.filter(p => p.name === HALL_DEMO_NAME || p.name === '完整机房演示 · 32柜 / 多排混合设备');
assert.ok(matches.length <= 1, 'Multiple matching demos; choose explicitly rather than overwriting.');
const oldPlans = plans.filter(p => p.planId !== matches[0]?.planId);
const before = await Promise.all(oldPlans.map(p => request(`/plans/${p.planId}/layout`)));
let saved;
if (matches.length) {
  saved = await request(`/plans/${matches[0].planId}/layout`);
  console.log(JSON.stringify({ name: HALL_DEMO_NAME, planId:saved.planId, version:saved.version, retainedExisting:true,
    message:'Existing demo retained exactly; no layout or candidate changed.' }));
} else {
  const created = await request('/plans','POST',{ contract_version:1,name:HALL_DEMO_NAME,scenario_id:source.scenarioId,
    facility_input:{revision_id:source.facilityInput.revisionId,container_id:source.facilityInput.containerId,revision_etag:source.facilityInput.revisionEtag} },
    {'idempotency-key':hallDemoId(seed,'create')});
  const layout = await request(`/plans/${created.planId}/layout`);
  // An interrupted earlier attempt is never silently replaced.
  assert.equal(layout.version,1); assert.equal(layout.placements.length,0); assert.equal(layout.equipment.devices.length,0);
  const body = createHallDemoBody(layout,catalog,seed);
  const checked = await request(`/plans/${created.planId}/layout/check`,'POST',body);
  assert.deepEqual(checked.report.diagnostics,[]); assert.deepEqual(checked.equipmentReport.diagnostics,[]);
  saved = await request(`/plans/${created.planId}/layout`,'PUT',body, {'if-match':'"1"','idempotency-key':hallDemoId(seed,'save')});
  const wire = {contract_version:1,base_version:saved.version,snapshot_id:saved.snapshot.snapshotId};
  const allocation = await request(`/plans/${saved.planId}/layout/equipment-options`,'POST',wire);
  const a = allocation.candidates[0];
  assert.equal(a.canStage,true); assert.equal(a.assignments.length,2); assert.equal(a.unassigned.length,6);
  assert.equal(a.equipmentReport.roomCapacity.resources.powerKw.total,246);
  const options = await request(`/plans/${saved.planId}/layout/options`,'POST',{...wire,options:{grid_step_m:2,allow_rotation:false,strategy:'COMPARE'}});
  assert.equal(options.candidates.length,2);
  for (const c of options.candidates) {
    assert.equal(c.canStage,true,JSON.stringify(c.unplaced)); assert.deepEqual(c.report.diagnostics,[]);
    assert.deepEqual(c.equipmentReport.diagnostics,[]);
    assert.deepEqual(c.body.equipment,saved.equipment);
    for (const fixed of saved.placements.filter(p=>p.locked)) assert.deepEqual(c.placements.find(p=>p.rackId===fixed.rackId),fixed);
  }
  console.log(JSON.stringify({name:HALL_DEMO_NAME,planId:saved.planId,version:saved.version,racks:saved.placements.length,
    installedDevices:checked.equipmentReport.installedDevices,inventoryDevices:saved.equipment.devices.length,
    unassignedDevices:checked.equipmentReport.unassignedDeviceIds.length,lockedRacks:24,
    powerKw:checked.equipmentReport.roomCapacity.resources.powerKw.total,roomLimitKw:246,
    spatialStatus:checked.report.status,equipmentStatus:checked.equipmentReport.status,validationState:saved.validationState,
    allocation:{assigned:a.assignments.length,remaining:a.unassigned.length,reasons:a.unassigned.map(d=>d.code)},
    layoutCandidates:options.candidates.map(c=>({algorithmId:c.algorithmId,canStage:c.canStage,movedRacks:c.metrics.movedRacks,unplaced:c.unplaced.length})),
    note:'Single local smoke timings, not a scaling benchmark or production capacity claim.',timings},null,2));
}
assert.deepEqual(await request(`/plans/${saved.planId}/layout`),saved, 'Preview must not persist changes.');
assert.deepEqual(await Promise.all(oldPlans.map(p=>request(`/plans/${p.planId}/layout`))),before);
assert.deepEqual(await request(`/plans/${sourceId}/layout`),source);
console.log(JSON.stringify({unchangedOldPlans:oldPlans.length,sourceUnchanged:true,candidatesSaved:false}));
