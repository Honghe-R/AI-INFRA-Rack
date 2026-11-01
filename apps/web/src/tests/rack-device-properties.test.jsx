import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RackDeviceProperties } from '../rack/RackDeviceProperties.jsx';
import { confirmDeviceProperties } from '../rack/device-properties.js';
import { defaultEditorEquipment, validateEditorEquipment } from '../rack/edit-layout-state.js';

const device = { deviceId: 'd', name: 'Server', heightU: 2, weightKg: 20, powerKw: 1, coolingKw: 1,
  rackId: 'r', startU: 3, catalogRef: { modelId: 'server', version: 1 } };

test('confirmed specification edits detach the device model and preserve identity and assignment without mutation', () => {
  const before = structuredClone(device);
  const result = confirmDeviceProperties(device, { ...device, heightU: '4', weightKg: '0', powerKw: '2.5', coolingKw: '' });
  assert.deepEqual(result, { deviceId: 'd', name: 'Server', heightU: 4, weightKg: 0, powerKw: 2.5, coolingKw: null, rackId: 'r', startU: 3 });
  assert.deepEqual(device, before);
  assert.equal(validateEditorEquipment({ ...defaultEditorEquipment(), devices: [result] }, [{ rackId: 'r' }]), null);
});

test('unchanged numeric specifications and name-only edits retain the version pin', () => {
  const result = confirmDeviceProperties(device, { ...device, name: ' Renamed server ', heightU: '2', weightKg: '20.0' });
  assert.equal(result.name, 'Renamed server');
  assert.deepEqual(result.catalogRef, device.catalogRef);
  const custom = { ...device }; delete custom.catalogRef;
  assert.equal(Object.hasOwn(confirmDeviceProperties(custom, { ...custom, heightU: 3 }), 'catalogRef'), false);
});

test('invalid confirmed properties are rejected before any device can be changed', () => {
  const before = structuredClone(device);
  for (const patch of [{ name: ' ' }, { name: 'x'.repeat(161) }, { heightU: '' }, { heightU: 1.5 }, { heightU: 0 },
    { heightU: 101 }, { weightKg: -1 }, { powerKw: 'Infinity' }, { coolingKw: 1000001 }, { weightKg: 'abc' }]) {
    assert.throws(() => confirmDeviceProperties(device, { ...device, ...patch }));
  }
  assert.deepEqual(device, before);
});

test('pinned device fields are editable with an explicit confirmation; read-only users cannot confirm', () => {
  const html = renderToStaticMarkup(<RackDeviceProperties device={device} editable />);
  for (const label of ['Device height (U)', 'Device weight (kg)', 'Device power (kW)', 'Device cooling (kW)',
    'Confirm device changes', 'custom plan assumptions', 'Save layout']) assert.ok(html.includes(label), label);
  assert.ok(!html.includes('disabled=""'));
  const readOnly = renderToStaticMarkup(<RackDeviceProperties device={device} editable={false} />);
  assert.equal((readOnly.match(/disabled=""/g) ?? []).length, 6);
});
