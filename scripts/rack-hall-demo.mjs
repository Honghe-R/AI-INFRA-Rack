#!/usr/bin/env node
// Local synthetic demo via ordinary APIs. Never seed/reset or overwrite old plans.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHallDemoBody, hallDemoId, HALL_DEMO_NAME } from './lib/rack-hall-demo.mjs';
import { createLargeHallDemoBody, prepareLargeHallEquipmentUpgrade, LARGE_HALL_DEMO_NAME, LARGE_HALL_BUDGET_KW } from './lib/rack-large-hall-demo.mjs';

const [projectId, sourceId, scale] = process.argv.slice(2);
assert.ok(scale === undefined || ['--large', '--upgrade-large-equipment'].includes(scale), 'Optional scale must be --large or --upgrade-large-equipment.');
const upgrade = scale === '--upgrade-large-equipment';
const large = scale !== undefined;
const demoName = large ? LARGE_HALL_DEMO_NAME : HALL_DEMO_NAME;
const roomLimitKw = large ? LARGE_HALL_BUDGET_KW : 246;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
assert.ok(uuid.test(projectId ?? '') && uuid.test(sourceId ?? ''), 'Usage: npm run rack:demo:hall -- <local-project-uuid> <source-plan-uuid> [--large | --upgrade-large-equipment]');
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
assert.equal(process.env.AI_INFRA_COMPOSE_FILE, 'compose.rack.yaml');
const db = new URL(process.env.DATABASE_URL);
assert.equal(db.hostname, '127.0.0.1'); assert.equal(db.port, '55532'); assert.equal(db.pathname, '/rack_facility');
const port = Number(process.env.WEB_PORT); assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const root = `http://localhost:${port}/api/v1/projects/${projectId}/rack`, seed = `${projectId}:${sourceId}${large ? ':large-128-v1' : ''}`;
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
const matches = plans.filter(p => p.name === demoName || (!large && p.name === '完整机房演示 · 32柜 / 多排混合设备'));
assert.ok(matches.length <= 1, 'Multiple matching demos; choose explicitly rather than overwriting.');
const oldPlans = plans.filter(p => p.planId !== matches[0]?.planId);
const before = await Promise.all(oldPlans.map(p => request(`/plans/${p.planId}/layout`)));
let saved, checked, verifyPreviews = false;
if (matches.length) {
  saved = await request(`/plans/${matches[0].planId}/layout`);
  if (upgrade) {
    assert.notEqual(saved.planId, sourceId, 'Use the original source plan, not the upgrade target.');
    const prepared = prepareLargeHallEquipmentUpgrade(saved, catalog, seed);
    if (prepared.changed) {
      checked = await request(`/plans/${saved.planId}/layout/check`, 'POST', prepared.body);
      assert.deepEqual(checked.report.diagnostics, []); assert.deepEqual(checked.equipmentReport.diagnostics, []);
      const backupDir = new URL('../records/2026-10-30-rack-density-upgrade/', import.meta.url);
      await mkdir(backupDir, { recursive: true });
      const backup = new URL(`before-${saved.planId}-v${saved.version}.json`, backupDir);
      await writeFile(backup, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' });
      const previous = saved;
      saved = await request(`/plans/${saved.planId}/layout`, 'PUT', prepared.body,
        { 'if-match': `"${saved.version}"`, 'idempotency-key': hallDemoId(seed, `density-v2-save-${saved.version}`) });
      assert.deepEqual(saved.placements, previous.placements); assert.deepEqual(saved.constraints, previous.constraints);
      verifyPreviews = true;
      console.log(JSON.stringify({ equipmentUpgraded: true, oldVersion: previous.version, newVersion: saved.version,
        oldDevices: previous.equipment.devices.length, newDevices: saved.equipment.devices.length, backup: backup.pathname }));
    }
  }
  if (!verifyPreviews)
  console.log(JSON.stringify({ name: demoName, planId:saved.planId, version:saved.version, retainedExisting:true,
    message:'Existing demo retained exactly; no layout or candidate changed.' }));
} else {
  const created = await request('/plans','POST',{ contract_version:1,name:demoName,scenario_id:source.scenarioId,
    facility_input:{revision_id:source.facilityInput.revisionId,container_id:source.facilityInput.containerId,revision_etag:source.facilityInput.revisionEtag} },
    {'idempotency-key':hallDemoId(seed,'create')});
  const layout = await request(`/plans/${created.planId}/layout`);
  // An interrupted earlier attempt is never silently replaced.
  assert.equal(layout.version,1); assert.equal(layout.placements.length,0); assert.equal(layout.equipment.devices.length,0);
  const body = (large ? createLargeHallDemoBody : createHallDemoBody)(layout,catalog,seed);
  checked = await request(`/plans/${created.planId}/layout/check`,'POST',body);
  assert.deepEqual(checked.report.diagnostics,[]); assert.deepEqual(checked.equipmentReport.diagnostics,[]);
  saved = await request(`/plans/${created.planId}/layout`,'PUT',body, {'if-match':'"1"','idempotency-key':hallDemoId(seed,'save')});
  verifyPreviews = true;
}
if (verifyPreviews) {
  const wire = {contract_version:1,base_version:saved.version,snapshot_id:saved.snapshot.snapshotId};
  const allocation = await request(`/plans/${saved.planId}/layout/equipment-options`,'POST',wire);
  const a = allocation.candidates[0];
  assert.equal(a.canStage,true); assert.equal(a.assignments.length,2); assert.equal(a.unassigned.length,6);
  assert.ok(Math.abs(a.equipmentReport.roomCapacity.resources.powerKw.total-roomLimitKw)<1e-8);
  const options = await request(`/plans/${saved.planId}/layout/options`,'POST',{...wire,options:{grid_step_m:2,allow_rotation:false,strategy:'COMPARE'}});
  assert.equal(options.candidates.length,2);
  for (const c of options.candidates) {
    assert.equal(c.canStage,true,JSON.stringify(c.unplaced)); assert.deepEqual(c.report.diagnostics,[]);
    assert.deepEqual(c.equipmentReport.diagnostics,[]);
    assert.deepEqual(c.body.equipment,saved.equipment);
    for (const fixed of saved.placements.filter(p=>p.locked)) assert.deepEqual(c.placements.find(p=>p.rackId===fixed.rackId),fixed);
  }
  console.log(JSON.stringify({name:demoName,planId:saved.planId,version:saved.version,racks:saved.placements.length,
    installedDevices:checked.equipmentReport.installedDevices,inventoryDevices:saved.equipment.devices.length,
    unassignedDevices:checked.equipmentReport.unassignedDeviceIds.length,lockedRacks:saved.placements.filter(p=>p.locked).length,
    powerKw:checked.equipmentReport.roomCapacity.resources.powerKw.total,roomLimitKw,
    highLoadRacks:checked.equipmentReport.racks.filter(r=>r.capacities.powerKw.limit>0&&r.capacities.powerKw.total/r.capacities.powerKw.limit>=.8).length,
    spatialStatus:checked.report.status,equipmentStatus:checked.equipmentReport.status,validationState:saved.validationState,
    allocation:{assigned:a.assignments.length,remaining:a.unassigned.length,reasons:a.unassigned.map(d=>d.code)},
    layoutCandidates:options.candidates.map(c=>({algorithmId:c.algorithmId,canStage:c.canStage,movedRacks:c.metrics.movedRacks,unplaced:c.unplaced.length})),
    note:'Single local smoke timings, not a scaling benchmark or production capacity claim.',timings},null,2));
}
assert.deepEqual(await request(`/plans/${saved.planId}/layout`),saved, 'Preview must not persist changes.');
assert.deepEqual(await Promise.all(oldPlans.map(p=>request(`/plans/${p.planId}/layout`))),before);
assert.deepEqual(await request(`/plans/${sourceId}/layout`),source);
console.log(JSON.stringify({unchangedOldPlans:oldPlans.length,sourceUnchanged:true,candidatesSaved:false}));
