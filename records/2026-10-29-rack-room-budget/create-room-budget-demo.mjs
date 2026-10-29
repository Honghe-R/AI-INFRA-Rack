// Synthetic local example through ordinary HTTP. No reset, migration or old-plan writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '55532');
assert.equal(database.pathname, '/rack_facility');
const port = Number(process.env.WEB_PORT); assert.equal(port, 5193);
const projectId = '4c11ab8d-5d57-4ad8-ad55-ac08574fba46';
const oldIds = ['e446aafb-1846-4a69-af10-636fd50ba87c', 'cb017b9b-ca11-483b-a5fd-c8f527195072',
  '88e1821b-e8fe-49ce-ba9e-ecfda6925c77', '24b5422e-8206-4a76-bdf5-9f7e93a05aac',
  '3abd796d-461a-45f6-a0ce-ced7bce99020', '44b72453-8cf6-47ff-ab61-0d4c28c99c21'];
const root = `/api/v1/projects/${projectId}/rack/plans`;
async function request(path, body, method = 'POST', version = null, expectedStatus = null) {
  const response = await fetch(`http://localhost:${port}${path}`, {
    method: body ? method : 'GET', headers: { 'x-dev-subject': 'dev-user',
      ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
      ...(version ? { 'if-match': `"${version}"` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json();
  if (expectedStatus) { assert.equal(response.status, expectedStatus, JSON.stringify(payload)); return payload; }
  assert.ok(response.ok, JSON.stringify(payload)); return payload.data;
}
const before = await Promise.all(oldIds.map(id => request(`${root}/${id}/layout`)));
const source = before[0];
assert.equal(source.sourceStatus.status, 'UNCHANGED');
assert.equal(source.snapshot.sourceGeometry.provenanceReference, 'dev-seed-facility');
const name = 'Rack room budget demo — shared power and cooling';
const existing = (await request(`${root}?limit=50&scenario_id=${source.scenarioId}&revision_id=${source.facilityInput.revisionId}`)).items.find(p => p.name === name);
let planId = existing?.planId;
if (!planId) {
  const created = await request(root, { contract_version: 1, name, scenario_id: source.scenarioId,
    facility_input: { revision_id: source.facilityInput.revisionId, container_id: source.facilityInput.containerId, revision_etag: source.facilityInput.revisionEtag } });
  planId = created.planId;
  const empty = await request(`${root}/${planId}/layout`);
  const racks = source.placements.slice(0, 3).map((p, i) => ({ ...p, rackId: randomUUID(), name: `Budget rack ${String.fromCharCode(65+i)}`, locked: i === 0 }));
  const device = (label, powerKw, rackId = null, heightU = 2) => ({ deviceId: randomUUID(), name: label, heightU,
    weightKg: 10, powerKw, coolingKw: powerKw, rackId, startU: rackId ? 1 : null });
  const equipment = { coverage: 'DECLARED_COMPLETE', source: { kind: 'ASSUMED', reference: 'Synthetic teaching example; no vendor specifications or engineering certification.' },
    roomBudget: { maxPowerKw: 3, maxCoolingKw: 3, source: { kind: 'ASSUMED', reference: 'Synthetic 3 kW plan-wide installed device budget. Excludes idle racks and other plans.' } },
    rackLimits: racks.map(r => ({ rackId: r.rackId, maxWeightKg: 100, maxPowerKw: 10, maxCoolingKw: 10 })),
    devices: [device('Installed on locked A', 1, racks[0].rackId), device('Installed on B', 1, racks[1].rackId),
      device('Unassigned 2 kW — room budget blocks', 2, null, 4), device('Unassigned 1 kW — exactly fits', 1)] };
  await request(`${root}/${planId}/layout`, { contract_version: 1, snapshot_id: empty.snapshot.snapshotId, placements: racks, constraints: empty.constraints, equipment }, 'PUT', empty.version);
}
const saved = await request(`${root}/${planId}/layout`);
const body = { contract_version: 1, snapshot_id: saved.snapshot.snapshotId, placements: saved.placements, constraints: saved.constraints, equipment: saved.equipment };
const checked = await request(`${root}/${planId}/layout/check`, body);
const allocation = await request(`${root}/${planId}/layout/equipment-options`, { contract_version: 1, base_version: saved.version, snapshot_id: saved.snapshot.snapshotId });
assert.equal(checked.equipmentReport.roomCapacity.resources.powerKw.total, 2);
assert.equal(checked.equipmentReport.roomCapacity.resources.powerKw.inventory.total, 5);
const c = allocation.candidates[0]; assert.equal(c.assignments.length, 1);
assert.equal(c.unassigned[0].code, 'ROOM_BUDGET_EXCEEDED');
assert.equal(c.equipmentReport.roomCapacity.resources.powerKw.total, 3);
const bad = structuredClone(body);
for (const device of bad.equipment.devices) if (device.rackId) { device.powerKw = 2; device.coolingKw = 2; }
const conflictReport = await request(`${root}/${planId}/layout/check`, bad);
assert.ok(conflictReport.equipmentReport.racks.every(r => r.capacities.powerKw.status === 'WITHIN_LIMIT'));
const rejected = await request(`${root}/${planId}/layout`, bad, 'PUT', saved.version, 422);
assert.equal(rejected.error.code, 'RACK_EQUIPMENT_CONFLICT');
assert.deepEqual(await request(`${root}/${planId}/layout`), saved);
assert.deepEqual(await Promise.all(oldIds.map(id => request(`${root}/${id}/layout`))), before);
const summary = { name, planId, version: saved.version, installedDemandKw: 2, inventoryDemandKw: 5, roomLimitKw: 3,
  assignedDevices: c.assignments.length, remainingReasons: c.unassigned, blockedSave: rejected.error.code, unchangedOldDemos: oldIds.length };
await writeFile(new URL('./room-budget-demo.json', import.meta.url), JSON.stringify({ summary, checked, allocation, conflictReport }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
