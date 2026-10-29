import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RackRoomCapacity } from '../rack/RackRoomCapacity.jsx';
import { beginLayoutDraft, defaultEditorEquipment, layoutCheckBody, validateEditorEquipment } from '../rack/edit-layout-state.js';
import { rackInputSummary } from '../rack/rack-inputs.js';
import { checkRoomBudget } from '@ai-infra/rack';

const roomBudget = { maxPowerKw: 0, maxCoolingKw: null, source: { kind: 'ASSUMED', reference: 'Test <budget>' } };
const equipment = { ...defaultEditorEquipment(), roomBudget };

test('room budget editor distinguishes zero, unknown, absent, explicit removal and invalid references', () => {
  assert.equal(validateEditorEquipment(equipment, []), null);
  assert.equal(validateEditorEquipment(defaultEditorEquipment(), []), null);
  assert.equal(validateEditorEquipment({ ...equipment, roomBudget: null }, []), null);
  for (const patch of [{ maxPowerKw: NaN }, { maxCoolingKw: -1 }, { maxCoolingKw: '3' }, { maxPowerKw: 1000001 }, { source: null }, { source: { kind: 'REFERENCE', reference: 'x' } }, { source: { kind: 'ASSUMED', reference: ' ' } }])
    assert.ok(validateEditorEquipment({ ...equipment, roomBudget: { ...roomBudget, ...patch } }, []));
});

test('room budget stays in independent shared drafts and full request bodies and marks capacity consumers changed', () => {
  const layout = { planId: 'p', version: 2, snapshot: { snapshotId: 's' }, placements: [], equipment };
  const draft = beginLayoutDraft(layout);
  draft.equipment.roomBudget.maxPowerKw = 4;
  draft.equipment.roomBudget.source.reference = 'Changed';
  assert.equal(equipment.roomBudget.maxPowerKw, 0);
  assert.equal(equipment.roomBudget.source.reference, 'Test <budget>');
  assert.deepEqual(layoutCheckBody(draft).equipment.roomBudget, draft.equipment.roomBudget);
  const summary = rackInputSummary(layout, [], draft.constraints, draft.equipment, draft);
  assert.deepEqual(summary.changed, ['limits']);
  assert.ok(summary.affected.has('equipment') && summary.affected.has('save'));
  draft.equipment.roomBudget = null;
  assert.deepEqual(rackInputSummary(layout, [], draft.constraints, draft.equipment, draft).changed, ['limits']);
});

test('capacity panel renders real room totals and unknown lower bounds with source escaping and disabled viewer controls', () => {
  const e = { ...equipment, devices: [
    { rackId: 'r', powerKw: 2, coolingKw: null },
    { rackId: null, powerKw: 4, coolingKw: 4 },
  ] };
  const html = renderToStaticMarkup(<RackRoomCapacity equipment={e} report={{ roomCapacity: checkRoomBudget(e) }} editable={false} />);
  for (const value of ['Test &lt;budget&gt;', 'ROOM_BUDGET_EXCEEDED', 'ISSUES_FOUND', '1 installed', '1 unassigned', '≥ 0 (1 unknown)', 'above budget if all installed', 'disabled=""', 'does not reserve Facility capacity', 'No global room weight limit']) assert.ok(html.includes(value), value);
  assert.ok(!html.includes('NaN'));
});

test('no budget is explicitly scoped to per-rack checks and does not invent room limits', () => {
  const e = defaultEditorEquipment();
  const html = renderToStaticMarkup(<RackRoomCapacity equipment={e} report={{ roomCapacity: checkRoomBudget(e) }} editable={true} />);
  for (const value of ['Room budget not recorded', 'INCOMPLETE', 'Unknown', 'per-rack-only scope']) assert.ok(html.includes(value), value);
  assert.ok(!html.includes('Room power limit (kW)'));
});
