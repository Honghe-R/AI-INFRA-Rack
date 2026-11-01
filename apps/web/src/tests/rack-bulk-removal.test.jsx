import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { bulkRemoval, removalItems, filterRemovalItems, unlockRacks, setRackLocks } from '../rack/bulk-removal.js';
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

test('batch rack removal deletes installed equipment and limits while preserving unassigned inventory and other racks', () => {
  const e = equipment(), before = structuredClone({ e, placements });
  const result = bulkRemoval({ kind: 'racks', ids: ['a', 'b'], placements, equipment: e });
  assert.equal(result.removedCount, 2);
  assert.equal(result.removedDeviceCount, 2);
  assert.deepEqual(result.placements.map(r => r.rackId), ['c']);
  assert.deepEqual(result.equipment.rackLimits.map(l => l.rackId), ['c']);
  assert.deepEqual(result.equipment.devices.map(d => d.deviceId), ['d3', 'd4']);
  assert.deepEqual(result.equipment.devices, e.devices.slice(2));
  assert.deepEqual(result.equipment.roomBudget, e.roomBudget);
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
  assert.equal(body.snapshot_id, 's'); assert.equal(body.placements.length, 1); assert.equal(body.equipment.devices.length, 2);
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
  assert.match(readonly, /disabled="">Delete selected racks/);
  const editor = render(true);
  assert.equal((editor.match(/type="checkbox" disabled=""/g) ?? []).length, 1);
  assert.match(editor, /Select filtered \(2\)/);
  assert.match(editor, /together with all devices installed in them/);
  assert.match(editor, /Unassigned devices and devices in other racks are kept/);
});

test('batch unlock changes only draft locks; saved protection remains until unlock is saved', () => {
  const before = structuredClone(placements);
  const unlocked = unlockRacks(placements, ['a', 'c']);
  assert.deepEqual(unlocked, placements.map(r => r.rackId === 'c' ? { ...r, locked: false } : r));
  assert.deepEqual(placements, before);
  assert.throws(() => bulkRemoval({ kind: 'racks', ids: ['c'], placements: unlocked, savedPlacements: placements, equipment: equipment() }), /Unlock and save/);
  assert.equal(bulkRemoval({ kind: 'racks', ids: ['c'], placements: unlocked, savedPlacements: unlocked, equipment: equipment() }).removedCount, 1);
  assert.throws(() => unlockRacks(placements, ['a', 'missing']), /changed/);
  assert.throws(() => unlockRacks(placements, ['a', 'a']), /changed/);
  assert.throws(() => unlockRacks(placements, []), /changed/);
});

test('bulk panel exposes a clear delete action before the list and explains saved versus pending locks', () => {
  const html = renderToStaticMarkup(<RackBulkRemoval kind="racks" placements={placements} equipment={equipment()} editable onUnlock={() => {}} />);
  assert.match(html, /<details[^>]*open=""/);
  assert.ok(html.indexOf('Delete selected racks') < html.indexOf('racks bulk selection'));
  assert.match(html, /Unlock filtered racks \(1\)/);
  assert.match(html, /Position locks protect racks/);
  const unlocked = unlockRacks(placements, ['c']);
  const pending = renderToStaticMarkup(<RackBulkRemoval kind="racks" placements={unlocked} savedPlacements={placements} equipment={equipment()} editable onUnlock={() => {}} />);
  assert.match(pending, /1 unlocks pending save/);
  assert.match(pending, /Unlock pending — Save layout before deletion/);
  assert.match(pending, /disabled="">Unlock filtered racks \(0\)/);
});

test('device panel includes bulk inventory actions and escapes untrusted labels', () => {
  const e = equipment(); e.devices[0].name = '<img onerror=alert(1)>';
  const html = renderToStaticMarkup(<RackEquipment equipment={e} placements={placements} models={[]} editable mode="equipment" />);
  assert.match(html, /Bulk remove devices/);
  assert.match(html, /Device location/);
  assert.ok(html.includes('&lt;img onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img onerror'));
});

 test('selected rack lock changes are atomic, preserve identities and leave other rack fields untouched', () => {
  const before=structuredClone(placements);
  const locked=setRackLocks(placements,['a','c'],true);
  assert.equal(locked[0].locked,true);assert.equal(locked[1],placements[1]);assert.equal(locked[2].locked,true);
  assert.deepEqual(setRackLocks(locked,['a','c'],false).map(r=>r.locked),[false,false,false]);
  for(const ids of [[],['a','a'],['a','missing']]) assert.throws(()=>setRackLocks(placements,ids,true),/changed/);
  assert.deepEqual(placements,before);
 });
 test('rack lock management permits selecting locked rows but retains read-only selection protection', () => {
  const props={kind:'racks',placements,equipment:equipment(),onLock:()=>{},onUnlock:()=>{}};
  const html=renderToStaticMarkup(<RackBulkRemoval {...props} editable/>);
  assert.match(html,/Lock selected/);assert.match(html,/Unlock selected/);
  assert.match(html,/Select filtered \(3\)/);
  assert.doesNotMatch(html,/type="checkbox" disabled/);
  assert.match(html,/can be selected for lock changes but cannot be deleted/);
  const readonly=renderToStaticMarkup(<RackBulkRemoval {...props} editable={false}/>);
  assert.equal((readonly.match(/type="checkbox" disabled/g)??[]).length,3);
  assert.match(readonly,/disabled="">Lock selected/);assert.match(readonly,/disabled="">Unlock selected/);
 });


test('rack cascade counts every installed device, supports empty racks and keeps unassigned inventory when all racks are deleted', () => {
  const unlocked = placements.map(r => ({ ...r, locked: false }));
  const e = equipment();
  e.devices.push(device('d5', 'a'));
  const before = structuredClone(e);
  const empty = bulkRemoval({ kind: 'racks', ids: ['a'], placements: unlocked, equipment: { ...e, devices: [device('pending', null)] } });
  assert.equal(empty.removedDeviceCount, 0);
  assert.equal(empty.equipment.devices[0].deviceId, 'pending');
  const subset = bulkRemoval({ kind: 'racks', ids: ['a'], placements: unlocked, equipment: e });
  assert.equal(subset.removedDeviceCount, 2);
  assert.deepEqual(subset.equipment.devices.map(d => d.deviceId), ['d2', 'd3', 'd4']);
  const all = bulkRemoval({ kind: 'racks', ids: ['a', 'b', 'c'], placements: unlocked, equipment: e });
  assert.equal(all.removedDeviceCount, 4);
  assert.deepEqual(all.placements, []);
  assert.deepEqual(all.equipment.rackLimits, []);
  assert.deepEqual(all.equipment.devices, [e.devices[3]]);
  assert.equal(validateEditorEquipment(all.equipment, []), null);
  assert.deepEqual(e, before);
});
