import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RACK_CAPACITY_TEMPLATES, applyRackCapacityTemplate } from '../rack/capacity-catalog.js';
import { RackCapacityCatalog } from '../rack/RackCapacityCatalog.jsx';
import { RackEquipment } from '../rack/RackEquipment.jsx';
import { defaultEditorEquipment, validateEditorEquipment, beginLayoutDraft, layoutCheckBody } from '../rack/edit-layout-state.js';

const rack = { rackId: 'r', name: 'A01', modelId: 'm' };
const other = { rackId: 'other', name: 'A02', modelId: 'm' };

test('every catalog preset creates valid editable numeric limits and preserves unrelated draft data', () => {
  const equipment = { ...defaultEditorEquipment(), rackLimits: [{ rackId: 'other', maxWeightKg: 800, maxPowerKw: null, maxCoolingKw: 0 }] };
  const before = structuredClone(equipment);
  for (const template of RACK_CAPACITY_TEMPLATES) {
    const result = applyRackCapacityTemplate(equipment, [rack, other], 'r', template.templateId);
    assert.equal(validateEditorEquipment(result, [rack, other]), null);
    assert.equal(result.rackLimits.length, 2);
    assert.deepEqual(result.rackLimits[0], equipment.rackLimits[0]);
    assert.equal(result.devices, equipment.devices);
    assert.equal(result.source, equipment.source);
    assert.equal(result.roomBudget, equipment.roomBudget);
    assert.deepEqual(result.rackLimits[1], { rackId: 'r', maxWeightKg: template.maxWeightKg, maxPowerKw: template.maxPowerKw, maxCoolingKw: template.maxCoolingKw });
  }
  assert.deepEqual(equipment, before);
});

test('reapplying a different preset replaces all three limits without duplicates and uses the ordinary save contract', () => {
  const original = { planId: 'p', version: 3, snapshot: { snapshotId: 's' }, placements: [rack], equipment: defaultEditorEquipment() };
  const draft = beginLayoutDraft(original);
  draft.equipment = applyRackCapacityTemplate(draft.equipment, [rack], 'r', 'edge');
  draft.equipment = applyRackCapacityTemplate(draft.equipment, [rack], 'r', 'gpu');
  assert.deepEqual(layoutCheckBody(draft).equipment.rackLimits, [{ rackId: 'r', maxWeightKg: 1500, maxPowerKw: 30, maxCoolingKw: 30 }]);
  assert.equal(original.equipment.rackLimits.length, 0);
  draft.equipment.rackLimits[0].maxPowerKw = 24;
  assert.equal(validateEditorEquipment(draft.equipment, [rack]), null);
  assert.equal(RACK_CAPACITY_TEMPLATES.find(t => t.templateId === 'gpu').maxPowerKw, 30);
});

test('unknown rack and template reject without changing equipment', () => {
  const equipment = defaultEditorEquipment();
  assert.throws(() => applyRackCapacityTemplate(equipment, [rack], 'missing', 'gpu'), /existing rack/);
  assert.throws(() => applyRackCapacityTemplate(equipment, [rack], 'r', 'missing'), /valid capacity template/);
  assert.deepEqual(equipment.rackLimits, []);
});

test('catalog previews all five profiles and protects read-only or already matching limits', () => {
  const html = renderToStaticMarkup(<RackCapacityCatalog rack={rack} editable={false} />);
  for (const label of ['Light-duty / edge', 'General-purpose servers', 'Compute-dense', 'High-density GPU', 'Liquid-cooled AI', '1000 kg', '8 kW power', '8 kW cooling', 'ASSUMED', 'room budgets stay unchanged']) assert.ok(html.includes(label), label);
  assert.match(html, /<button disabled="">Apply to selected rack/);
  const matching = renderToStaticMarkup(<RackCapacityCatalog rack={rack} editable limit={{ maxWeightKg: 1000, maxPowerKw: 8, maxCoolingKw: 8 }} />);
  assert.match(matching, /<button disabled="">Apply to selected rack/);
  assert.match(matching, /Current limits match/);
  const editor = renderToStaticMarkup(<RackEquipment equipment={defaultEditorEquipment()} placements={[rack]} models={[]} selectedRackId="r" editable mode="capacity" />);
  assert.match(editor, /Rack capacity catalog/);
  assert.match(editor, /Use plan-assumed capacity limits/);
});
