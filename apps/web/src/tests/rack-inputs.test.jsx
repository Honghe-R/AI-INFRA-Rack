import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { inputImpact, rackInputSummary } from '../rack/rack-inputs.js';
import { RackInputs } from '../rack/RackInputs.jsx';
import { beginLayoutDraft, defaultEditorConstraints, defaultEditorEquipment } from '../rack/edit-layout-state.js';

const layout = {
  planId: 'p', version: 3, validationState: 'NOT_RUN',
  facilityInput: { revisionId: 'rev', containerId: 'hall', revisionEtag: '<pinned>' },
  sourceStatus: { status: 'UNCHANGED', reasons: [] }, snapshot: { snapshotId: 'fixed-room' },
  placements: [{ rackId: 'r', modelId: 'm', name: 'R01', xM: 3, yM: 5, rotationDeg: 0, locked: true }],
  constraints: defaultEditorConstraints(),
  equipment: { ...defaultEditorEquipment(), devices: [
    { deviceId: 'd', rackId: 'r', startU: 1, catalogRef: { modelId: 'gpu', version: 1 }, powerKw: null },
    { deviceId: 'd2', rackId: null, startU: null, catalogRef: { modelId: 'gpu', version: 2 } },
    { deviceId: 'd3', rackId: null, startU: null },
  ] },
};
const summarize = draft => rackInputSummary(layout, draft?.placements ?? layout.placements,
  draft?.constraints ?? layout.constraints, draft?.equipment ?? layout.equipment, draft);

test('dependency impact distinguishes spatial consumers from U/resource consumers', () => {
  assert.deepEqual([...inputImpact('room')], ['room', 'spatial', 'save']);
  assert.deepEqual([...inputImpact('rules')], ['rules', 'spatial', 'save']);
  assert.deepEqual([...inputImpact('devices')], ['devices', 'equipment', 'save']);
  for (const id of ['spatial', 'equipment', 'save']) assert.ok(inputImpact('racks').has(id));
});

test('draft comparisons retain pinned versions and detect unknown/zero/invalid distinctions without mutation', () => {
  const before = structuredClone(layout);
  const draft = beginLayoutDraft(layout);
  assert.deepEqual(summarize(draft).changed, []);
  const summary = summarize(null);
  assert.deepEqual(summary.pins, [{ modelId: 'gpu', version: 1, count: 1 }, { modelId: 'gpu', version: 2, count: 1 }]);
  assert.equal(summary.customDevices, 1);
  assert.equal(summary.assignedDevices, 1);
  draft.equipment.devices[0].powerKw = 0;
  assert.deepEqual(summarize(draft).changed, ['devices']);
  draft.equipment.devices[0].powerKw = NaN;
  assert.deepEqual(summarize(draft).changed, ['devices']);
  draft.placements[0].xM = 4;
  draft.constraints.clearance = { frontM: 0, rearM: 0 };
  draft.equipment.rackLimits.push({ rackId: 'r', maxPowerKw: 0 });
  assert.deepEqual(summarize(draft).changed, ['racks', 'rules', 'devices', 'limits']);
  assert.deepEqual(layout, before);
});

test('reference map uses actual saved inputs, scope reports and draft changes while preserving stale-source and version warnings', () => {
  const draft = beginLayoutDraft(layout);
  draft.equipment.rackLimits.push({ rackId: 'r', maxPowerKw: 1 });
  const html = renderToStaticMarkup(<RackInputs layout={{ ...layout, version: 4, sourceStatus: { status: 'STALE', reasons: ['ETAG_CHANGED'] } }}
    placements={draft.placements} constraints={draft.constraints} equipment={draft.equipment} draft={draft}
    spatialReport={{ status: 'INCOMPLETE' }} equipmentReport={null} onNavigate={() => {}} />);
  for (const text of ['ETAG_CHANGED', 'writes are blocked', 'fixed-room', '&lt;pinned&gt;', 'INCOMPLETE',
    'Not currently checked', 'NOT_RUN', 'Capacity assumptions · unsaved changes', 'Affected checks: U &amp; resource checks',
    'original draft base v3', 'no persistent history', 'version-pinned']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes('Affected checks: Spatial checks'));
  assert.ok(html.includes('aria-pressed="true"'));
  assert.ok(html.includes('not physical cables'));
});
