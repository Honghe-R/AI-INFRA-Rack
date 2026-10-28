import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getRackCatalog, resolveCatalogReference, getCatalogExamples, normalizeEquipment, EMPTY_EQUIPMENT, RackInputError } from '../index.js';

const ref = { modelId: 'demo-gpu-4u', version: 1 };
function device(modelRef = ref) {
  return { deviceId: randomUUID(), name: 'Local device', ...resolveCatalogReference(modelRef).specification,
    catalogRef: { ...modelRef }, rackId: null, startU: null };
}
const equipment = (devices) => ({ ...EMPTY_EQUIPMENT, devices });
const invalid = (fn) => assert.throws(fn, RackInputError);

test('released catalog v1 has a stable fingerprint, immutable graph and resolvable component versions', () => {
  const c = getRackCatalog();
  assert.equal(createHash('sha256').update(JSON.stringify(c)).digest('hex'),
    'c13080cf8198d1986b78687cc344479ddd627eb7dcd776807622df060de29905',
    'published v1 definitions are append-only: new specifications need new versions and retained old versions');
  assert.ok(Object.isFrozen(c.models[0].specification));
  assert.throws(() => { c.models[0].specification.powerKw = 99; }, TypeError);
  const keys = new Set(c.technologies.map((t) => `${t.technologyId}@${t.version}`));
  assert.equal(keys.size, c.technologies.length);
  for (const m of c.models) {
    const chassis = m.components.filter((p) => c.technologies.find((t) => t.technologyId === p.technologyId).slotType === 'chassis');
    assert.equal(chassis.length, 1);
    for (const p of m.components) { assert.ok(keys.has(`${p.technologyId}@${p.version}`)); assert.ok(Number.isInteger(p.quantity) && p.quantity > 0); }
    assert.equal(m.source.kind, 'ASSUMED'); assert.equal(m.status, 'DEMO');
  }
});

test('model resolution requires the exact version and never upgrades an unknown, malformed or injected reference', () => {
  assert.equal(resolveCatalogReference(ref).specification.heightU, 4);
  for (const bad of [null, {}, 'demo-gpu-4u@1', { ...ref, version: 2 }, { ...ref, version: '1' },
    { ...ref, version: 0 }, { ...ref, projectId: randomUUID() }, { ...ref, modelId: 'toString' }])
    invalid(() => resolveCatalogReference(bad));
});

test('pinned specification survives normalization and JSON; binding is copied and cannot mask custom demands', () => {
  const d = device(), normalized = normalizeEquipment(equipment([d]), []);
  assert.deepEqual(normalized.devices[0], d);
  d.catalogRef.version = 99;
  assert.equal(normalized.devices[0].catalogRef.version, 1);
  assert.deepEqual(normalizeEquipment(JSON.parse(JSON.stringify(normalized)), []), normalized);
  for (const patch of [{ heightU: 1 }, { weightKg: null }, { powerKw: 0 }, { coolingKw: 4 }, { catalogRef: null }])
    invalid(() => normalizeEquipment(equipment([{ ...device(), ...patch }]), []));
});

test('unbinding preserves identity and assignment but explicitly becomes a custom specification', () => {
  const pinned = device();
  const { catalogRef, ...custom } = pinned;
  const modified = normalizeEquipment(equipment([{ ...custom, powerKw: 2 }]), []).devices[0];
  assert.equal(modified.deviceId, pinned.deviceId); assert.equal(modified.powerKw, 2);
  assert.equal(Object.hasOwn(modified, 'catalogRef'), false);
});

test('unknown model demands stay null and component output ratings do not become consumption', () => {
  const optical = device({ modelId: 'demo-optical-2u', version: 1 });
  assert.equal(normalizeEquipment(equipment([optical]), []).devices[0].coolingKw, null);
  invalid(() => normalizeEquipment(equipment([{ ...optical, coolingKw: 0 }]), []));
  const gpu = resolveCatalogReference(ref);
  assert.equal(gpu.specification.powerKw, 3);
  const psu = getRackCatalog().technologies.find((t) => t.technologyId === 'demo-psu-2000');
  assert.notEqual(gpu.specification.powerKw, psu.declares.ratedOutputW * 2 / 1000);
});

test('read-only catalog examples use production equipment checks and return separate scope results', () => {
  const cases = getCatalogExamples();
  assert.deepEqual(cases.map((c) => c.equipmentReport.status), ['CHECKED_SCOPE_CLEAR', 'ISSUES_FOUND', 'ISSUES_FOUND', 'INCOMPLETE']);
  assert.equal(cases[0].equipmentReport.racks[0].occupiedU, 5);
  assert.equal(cases[0].equipmentReport.racks[0].capacities.powerKw.total, 3.3);
  assert.ok(cases[1].equipmentReport.diagnostics.some((d) => d.code === 'DEVICE_U_OVERLAP'));
  assert.ok(cases[2].equipmentReport.diagnostics.some((d) => d.code === 'RACK_CAPACITY_EXCEEDED' && d.dimension === 'powerKw'));
  assert.equal(cases[3].equipmentReport.racks[0].capacities.powerKw.total, null);
  assert.ok(cases.every((c) => c.validationState === 'NOT_RUN'));
  cases[0].equipmentReport.status = 'tampered';
  assert.equal(getCatalogExamples()[0].equipmentReport.status, 'CHECKED_SCOPE_CLEAR');
});
