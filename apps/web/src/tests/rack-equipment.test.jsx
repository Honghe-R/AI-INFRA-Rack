import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RackEquipment, RackElevation } from '../rack/RackEquipment.jsx';
import {
  beginLayoutDraft,
  layoutCheckBody,
  defaultEditorEquipment,
  validateEditorEquipment,
} from '../rack/edit-layout-state.js';

const rack = { rackId: 'r', modelId: 'm', name: 'A01' };
const model = { modelId: 'm', heightU: 42 };
const device = {
  deviceId: 'd',
  name: 'GPU <A>',
  heightU: 2,
  weightKg: null,
  powerKw: 3,
  coolingKw: 3,
  rackId: 'r',
  startU: 1,
};
test('equipment draft is a deep copy and full save/check bodies carry exact assignments and capacity assumptions', () => {
  const equipment = {
    ...defaultEditorEquipment(),
    devices: [device],
    rackLimits: [{ rackId: 'r', maxWeightKg: 100, maxPowerKw: 5, maxCoolingKw: null }],
  };
  const draft = beginLayoutDraft({
    planId: 'p',
    version: 2,
    snapshot: { snapshotId: 's' },
    placements: [rack],
    equipment,
  });
  draft.equipment.devices[0].startU = 5;
  draft.equipment.rackLimits[0].maxPowerKw = 8;
  assert.equal(equipment.devices[0].startU, 1);
  assert.equal(equipment.rackLimits[0].maxPowerKw, 5);
  assert.deepEqual(layoutCheckBody(draft).equipment, draft.equipment);
});
test('editor distinguishes cleared U from unknown demand, prevents missing-rack assignments and duplicate devices', () => {
  const e = { ...defaultEditorEquipment(), devices: [device] };
  assert.equal(validateEditorEquipment(e, [rack]), null);
  for (const patch of [
    { startU: NaN },
    { heightU: NaN },
    { heightU: 1.5 },
    { weightKg: -1 },
    { rackId: 'foreign' },
    { powerKw: Infinity },
  ])
    assert.ok(validateEditorEquipment({ ...e, devices: [{ ...device, ...patch }] }, [rack]));
  assert.equal(
    validateEditorEquipment({ ...e, devices: [{ ...device, weightKg: 0, powerKw: null }] }, [rack]),
    null,
  );
  assert.ok(validateEditorEquipment({ ...e, devices: [device, device] }, [rack]));
  assert.ok(validateEditorEquipment(e, []));
});
test('U elevation renders U42 above U1, escapes device labels, preserves physical front schematic and shows conflicts', () => {
  const html = renderToStaticMarkup(
    <RackElevation
      rack={rack}
      model={model}
      devices={[device, { ...device, deviceId: 'e' }]}
      selectedId="d"
    />,
  );
  assert.ok(html.indexOf('>U42<') < html.indexOf('>U1<'));
  assert.ok(html.includes('GPU &lt;A&gt;'));
  assert.equal((html.match(/rack-u-slot has-issue/g) || []).length, 2);
  assert.ok(html.includes('U1 at the bottom'));
  assert.ok(!html.includes('NaN'));
});
test('equipment panel shows lower-bound demand, unknown limit, source and scope; viewers cannot add devices or edit limits', () => {
  const capacity = {
    unit: 'kg',
    knownSubtotal: 20,
    total: null,
    unknownDevices: 1,
    limit: null,
    status: 'UNKNOWN',
  };
  const report = {
    status: 'INCOMPLETE',
    coverage: 'UNKNOWN',
    installedDevices: 1,
    devicesChecked: 1,
    unassignedDeviceIds: [],
    racks: [
      {
        rackId: 'r',
        occupiedU: 2,
        heightU: 42,
        freeU: 40,
        uStatus: 'CHECKED_SCOPE_CLEAR',
        capacities: {
          weightKg: capacity,
          powerKw: { ...capacity, unit: 'kW' },
          coolingKw: { ...capacity, unit: 'kW' },
        },
      },
    ],
    diagnostics: [],
    uncheckedRules: ['GLOBAL_ASSET_IDENTITY'],
  };
  const html = renderToStaticMarkup(
    <RackEquipment
      equipment={{ ...defaultEditorEquipment(), devices: [device] }}
      placements={[rack]}
      models={[model]}
      selectedRackId="r"
      editable={false}
      report={report}
    />,
  );
  for (const value of [
    'Equipment planning reference',
    'Plan-local assumed specifications',
    'Unknown',
    '≥ 20',
    'INCOMPLETE',
    'GLOBAL_ASSET_IDENTITY',
    'disabled=""',
    'U elevation',
  ])
    assert.ok(html.includes(value), value);
});
test('invalid numeric U inputs never create invalid elevation nodes', () => {
  const html = renderToStaticMarkup(
    <RackElevation rack={rack} model={model} devices={[{ ...device, startU: NaN }]} />,
  );
  assert.ok(!html.includes('GPU &lt;A&gt;'));
  assert.ok(!html.includes('NaN'));
});
