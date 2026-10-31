import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { bulkRemoval, removalItems, filterRemovalItems } from '../rack/bulk-removal.js';
import { RackBulkRemoval } from '../rack/RackBulkRemoval.jsx';
import { RackEquipment } from '../rack/RackEquipment.jsx';
import { defaultEditorEquipment, beginLayoutDraft, layoutCheckBody, validateEditorEquipment } from '../rack/edit-layout-state.js';

const placements = [
  { rackId: 'a', name: 'A01', locked: false },
  { rackId: 'b', name: 'B01', locked: false },
  { rackId: 'c', name: 'C01', locked: true },
];
const device = (id, rackId) => ({ deviceId: id, name: `GPU ${id}`, heightU: 4, startU: rackId ? 1 : null,
  rackId, weightKg: null, powerKw: 3, coolingKw: 3, catalogRef: { modelId: 'demo-gpu-4u', version: 1 } });
function equipment() {
  return { ...defaultEditorEquipment(), devices: [device('d1', 'a'), device('d2', 'b'), device('d3', 'c'), device('d4', null)],
    rackLimits: placements.map(r => ({ rackId: r.rackId, maxWeightKg: 800, maxPowerKw: 12, maxCoolingKw: 12 })),
    roomBudget: { maxPowerKw: 100, maxCoolingKw: null, source: { kind: 'ASSUMED', reference: 'test budget' } } };
}

test('batch device removal handles installed and unassigned inventory without changing racks, budgets or other device specs', () => {
  const e = equipment(), before = structuredClone(e);
  const result = bulkRemoval({ kind: 'devices', ids: ['d1', 'd4'], placements, equipment: e });
  assert.equal(result.removedCount, 2);
  assert.deepEqual(result.equipment.devices.map(d => d.deviceId), ['d2', 'd3']);
  assert.equal(result.placements, placements);
  assert.deepEqual(result.equipment.rackLimits, e.rackLimits);
  assert.deepEqual(result.equipment.roomBudget, e.roomBudget);
  assert.deepEqual(result.equipment.devices[0], e.devices[1]);
  assert.deepEqual(e, before);
});

test('batch rack removal unassigns equipment, removes limit references and preserves complete inventory with valid U state', () => {
  const e = equipment(), before = structuredClone({ e, placements });
  const result = bulkRemoval({ kind: 'racks', ids: ['a', 'b'], placements, equipment: e });
  assert.equal(result.removedCount, 2);
  assert.equal(result.unassignedCount, 2);
  assert.deepEqual(result.placements.map(r => r.rackId), ['c']);
  assert.deepEqual(result.equipment.rackLimits.map(l => l.rackId), ['c']);
  assert.equal(result.equipment.devices.length, 4);
  for (const d of result.equipment.devices.slice(0, 2)) {
    assert.equal(d.rackId, null); assert.equal(d.startU, null);
    assert.equal(d.weightKg, null); assert.deepEqual(d.catalogRef, e.devices[0].catalogRef);
  }
  assert.deepEqual(result.equipment.devices.slice(2), e.devices.slice(2));
  assert.equal(validateEditorEquipment(result.equipment, result.placements), null);
  assert.deepEqual({ e, placements }, before);
});

test('mixed locked selection rejects the whole operation, including an unsaved unlock of a saved locked rack', () => {
  const e = equipment(), before = structuredClone(e);
  for (const current of [placements, placements.map(r => ({ ...r, locked: false }))]) {
    assert.throws(() => bulkRemoval({ kind: 'racks', ids: ['a', 'c'], placements: current, savedPlacements: placements, equipment: e }), /Unlock and save/);
  }
  assert.deepEqual(e, before);
});

test('empty, duplicate and stale selections reject atomically instead of removing a partial set', () => {
  const e = equipment(), before = structuredClone(e);
  for (const [kind, ids] of [['racks', []], ['racks', ['a', 'a']], ['racks', ['a', 'missing']], ['devices', ['d1', 'missing']], ['unsupported', ['a']]])
    assert.throws(() => bulkRemoval({ kind, ids, placements, equipment: e }));
  assert.deepEqual(e, before);
});

test('saved draft snapshot and command identity remain intact; changes enter one ordinary save body and discard restores original inputs', () => {
  const saved = { planId: 'p', version: 3, snapshot: { snapshotId: 's' }, placements, equipment: equipment() };
  const draft = beginLayoutDraft(saved), result = bulkRemoval({ kind: 'racks', ids: ['a', 'b'], placements: draft.placements, equipment: draft.equipment, savedPlacements: saved.placements });
  const next = { ...draft, placements: result.placements, equipment: result.equipment };
  const body = layoutCheckBody(next);
  assert.equal(next.baseVersion, 3); assert.equal(next.planId, 'p'); assert.equal(next.attempt, null);
  assert.equal(body.snapshot_id, 's'); assert.equal(body.placements.length, 1); assert.equal(body.equipment.devices.length, 4);
  assert.deepEqual(beginLayoutDraft(saved), draft);
  assert.equal(saved.equipment.devices[0].rackId, 'a');
});

test('search and location filters work on literal text and full inventory, retaining saved-lock protection', () => {
  const e = equipment();
  const rows = removalItems('devices', placements, e);
  assert.equal(filterRemovalItems(rows, 'devices', '  gpu  ').length, 4);
  assert.deepEqual(filterRemovalItems(rows, 'devices', '', 'b').map(r => r.id), ['d2']);
  assert.deepEqual(filterRemovalItems(rows, 'devices', 'demo-gpu', 'unassigned').map(r => r.id), ['d4']);
  assert.equal(filterRemovalItems(rows, 'devices', '<script>').length, 0);
  const racks = removalItems('racks', placements.map(r => ({ ...r, locked: false })), e, placements);
  assert.equal(racks[2].blocked, true);
  assert.deepEqual(filterRemovalItems(racks, 'racks', '', 'unlocked').map(r => r.id), ['a', 'b']);
  assert.equal(racks[0].detail, '1 devices');
});

test('large inventories paginate rendering while Select filtered includes matches across all pages', () => {
  const e = { ...equipment(), devices: Array.from({ length: 128 }, (_, i) => device(`gpu-${i}`, null)) };
  const html = renderToStaticMarkup(<RackBulkRemoval kind="devices" placements={placements} equipment={e} editable onApply={() => {}} />);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 50);
  assert.match(html, /Select filtered \(128\)/);
  assert.match(html, /Page 1 of 3/);
  assert.match(html, /includes all matching pages/);
  assert.match(html, /Save layout to persist or Discard changes/);
});

test('read-only users have no enabled selection or removal actions; saved locked rows stay disabled for editors', () => {
  const render = editable => renderToStaticMarkup(<RackBulkRemoval kind="racks" placements={placements} savedPlacements={placements}
    equipment={equipment()} editable={editable} onApply={() => {}} />);
  const readonly = render(false);
  assert.equal((readonly.match(/type="checkbox" disabled=""/g) ?? []).length, 3);
  assert.match(readonly, /disabled="">Select filtered/);
  assert.match(readonly, /disabled="">Review removal/);
  const editor = render(true);
  assert.equal((editor.match(/type="checkbox" disabled=""/g) ?? []).length, 1);
  assert.match(editor, /Select filtered \(2\)/);
  assert.match(editor, /keep their devices as unassigned inventory/);
});

test('device panel includes bulk inventory actions and escapes untrusted labels', () => {
  const e = equipment(); e.devices[0].name = '<img onerror=alert(1)>';
  const html = renderToStaticMarkup(<RackEquipment equipment={e} placements={placements} models={[]} editable mode="equipment" />);
  assert.match(html, /Bulk remove devices/);
  assert.match(html, /Device location/);
  assert.ok(html.includes('&lt;img onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img onerror'));
});
