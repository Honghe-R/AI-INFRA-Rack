#!/usr/bin/env node
// Add an independent local demonstration through the normal guarded HTTP APIs.
// Never seed/reset Facility, replace an existing plan, or contact a teacher host.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const [projectId, sourcePlanId] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
assert.ok(uuid.test(projectId ?? '') && uuid.test(sourcePlanId ?? ''),
  'Usage: npm run rack:demo:catalog -- <local-project-uuid> <existing-local-plan-uuid>');
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.pathname, '/rack_facility');
const port = Number(process.env.WEB_PORT);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const root = `http://localhost:${port}/api/v1/projects/${projectId}/rack`;
async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${root}${path}`, { method,
    headers: { 'x-dev-subject': 'dev-user', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error?.code ?? 'REQUEST_FAILED'} ${result.error?.message ?? ''}`);
  return result.data;
}
function id(label) {
  const h = createHash('sha256').update(`rack-catalog-example-v1:${projectId}:${sourcePlanId}:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const source = await request(`/plans/${sourcePlanId}/layout`);
assert.equal(source.sourceStatus.status, 'UNCHANGED');
assert.equal(source.snapshot?.sourceGeometry.provenanceReference, 'dev-seed-facility', 'Only the explicitly synthetic local Facility example is supported.');
assert.ok(source.snapshot.view.extentM.width > 20 && source.snapshot.view.extentM.height > 20);
const catalog = await request('/catalog');
const plan = await request('/plans', 'POST', { contract_version: 1,
  name: 'Rack catalog demo — six racks', scenario_id: source.scenarioId,
  facility_input: { revision_id: source.facilityInput.revisionId, container_id: source.facilityInput.containerId,
    revision_etag: source.facilityInput.revisionEtag } }, { 'Idempotency-Key': id('create') });
let layout = await request(`/plans/${plan.planId}/layout`);
if (layout.version !== 1 || layout.placements.length || layout.equipment.devices.length) {
  console.log(`Existing demo retained: ${plan.planId}, v${layout.version}. No layout overwritten.`);
  process.exit(0);
}
const rackModel = layout.models.find((m) => m.widthM === 0.6 && m.heightU === 42);
assert.ok(rackModel, 'Expected the local assumed 42U rack model.');
const { width, height } = layout.snapshot.view.extentM;
const placements = Array.from({ length: 6 }, (_, i) => ({ rackId: id(`rack-${i}`), modelId: rackModel.modelId,
  name: `${i < 3 ? 'A' : 'B'}0${i % 3 + 1}`, xM: width / 2 + (i % 3 - 1) * 2,
  yM: height / 2 + (i < 3 ? -2 : 2), rotationDeg: i < 3 ? 0 : 180, locked: false }));
const lists = [
  ['demo-gpu-4u', 'demo-tor-1u'],
  ['demo-gpu-4u', 'demo-gpu-4u', 'demo-gpu-4u', 'demo-tor-1u'],
  ['demo-compute-2u', 'demo-tor-1u'],
  ['demo-unspecified-1u', 'demo-optical-2u'],
  ['demo-compute-2u', 'demo-compute-2u', 'demo-compute-2u'],
  ['demo-gpu-4u', 'demo-compute-2u', 'demo-compute-2u', 'demo-compute-2u'],
];
const devices = lists.flatMap((list, i) => {
  let startU = 1;
  return list.map((modelId, j) => {
    const m = catalog.models.find((m) => m.modelId === modelId && m.version === 1);
    assert.ok(m);
    const device = { deviceId: id(`device-${i}-${j}`), name: `${placements[i].name} · ${m.name} · ${j + 1}`,
      ...m.specification, catalogRef: { modelId: m.modelId, version: m.version }, rackId: placements[i].rackId, startU };
    startU += m.specification.heightU;
    return device;
  });
});
const limits = [6, 10, 4, 6, 3, 8];
const body = { contract_version: 1, snapshot_id: layout.snapshot.snapshotId, placements,
  constraints: { obstacleCoverage: 'DECLARED_COMPLETE', source: { kind: 'ASSUMED', reference: 'Synthetic six-rack planning scenario, not a surveyed obstacle inventory.' },
    obstacles: [{ obstacleId: id('obstacle'), name: 'Assumed service zone', xM: width / 2 + 5, yM: height / 2, widthM: 1, depthM: 2 }],
    clearance: { frontM: 1, rearM: 0.5 } },
  equipment: { coverage: 'DECLARED_COMPLETE', source: { kind: 'ASSUMED', reference: 'Synthetic catalog v1 allocation; model demands and per-rack limits are planning assumptions.' }, devices,
    rackLimits: placements.map((r, i) => ({ rackId: r.rackId, maxWeightKg: 500, maxPowerKw: limits[i], maxCoolingKw: limits[i] })) } };
const checked = await request(`/plans/${plan.planId}/layout/check`, 'POST', body);
assert.equal(checked.report.diagnostics.length, 0, 'Example spatial constraints conflict; leave the new empty plan for inspection.');
assert.equal(checked.equipmentReport.diagnostics.length, 0);
layout = await request(`/plans/${plan.planId}/layout`, 'PUT', body,
  { 'Idempotency-Key': id('save'), 'If-Match': '"1"' });
const reopened = await request(`/plans/${plan.planId}/layout`);
assert.deepEqual(reopened, layout); assert.equal(reopened.validationState, 'NOT_RUN');
assert.equal(reopened.equipment.devices.length, 17);
console.log(`Created independent local demo: ${plan.planId}, v${layout.version}, 6 racks / 17 pinned devices.`);
console.log(`Spatial: ${checked.report.status}; equipment: ${checked.equipmentReport.status}; whole plan: NOT_RUN.`);
console.log('Unknown device demands remain unknown. Existing source plan and Facility were only read.');
