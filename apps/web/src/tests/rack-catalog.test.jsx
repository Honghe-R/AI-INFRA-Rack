import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogContent } from '../catalog/CatalogSurface.jsx';
import { deviceFromCatalog, detachCatalogDevice, filterCatalog } from '../catalog/catalog-state.js';
import { rackLoadDisplay, rackGroupCamera } from '../rack/floorplan-load.js';
import { createApiClient } from '../api/client.js';
import { getTool, visibleTools } from '../state/tool-registry.js';
import { beginLayoutDraft, layoutCheckBody, defaultEditorEquipment } from '../rack/edit-layout-state.js';

const model = { modelId: 'gpu', version: 1, name: 'GPU <example>', kind: 'SERVER', status: 'DEMO',
  source: { kind: 'ASSUMED', reference: 'Synthetic example only.' },
  components: [{ technologyId: 'chassis', version: 1, quantity: 1 }],
  specification: { heightU: 4, weightKg: 80, powerKw: 3, coolingKw: null },
  fieldSources: { heightU: 'chassis@1', weightKg: 'WHOLE_DEVICE_ASSUMPTION', powerKw: 'WHOLE_DEVICE_ASSUMPTION', coolingKw: 'UNKNOWN' },
  note: 'Not a power-supply consumption calculation.' };
const tech = { technologyId: 'chassis', version: 1, name: '4U chassis', slotType: 'chassis', status: 'DEMO', declares: { heightU: 4 } };
const catalog = { catalogRevision: 'v1', models: [model], technologies: [tech], examples: [] };

test('catalog filters by the exact category and case-insensitive identity; model creation copies specifications and explicit unknowns', () => {
  assert.equal(filterCatalog([model], 'GPU', 'SERVER', 'kind').length, 1);
  assert.equal(filterCatalog([model], 'gpu', 'SWITCH', 'kind').length, 0);
  assert.equal(filterCatalog([tech], 'chassis', 'chassis', 'slotType').length, 1);
  const d = deviceFromCatalog(model, 'device-1');
  assert.deepEqual(d.catalogRef, { modelId: 'gpu', version: 1 });
  assert.equal(d.coolingKw, null); assert.equal(d.rackId, null); assert.equal(d.startU, null);
  d.powerKw = 10;
  assert.equal(model.specification.powerKw, 3);
  const custom = detachCatalogDevice(d);
  assert.equal(Object.hasOwn(custom, 'catalogRef'), false); assert.equal(custom.deviceId, d.deviceId);
});

test('draft and full save body preserve deep-copied model pins, assignment and unknown demand', () => {
  const device = deviceFromCatalog(model, 'd');
  const original = { planId: 'p', version: 2, snapshot: { snapshotId: 's' }, placements: [],
    equipment: { ...defaultEditorEquipment(), devices: [device] } };
  const draft = beginLayoutDraft(original);
  draft.equipment.devices[0].catalogRef.version = 2;
  assert.equal(original.equipment.devices[0].catalogRef.version, 1);
  assert.equal(layoutCheckBody(draft).equipment.devices[0].coolingKw, null);
});

test('catalog models expose pinned composition, provenance, unknowns and an actual Rack usage path', () => {
  const html = renderToStaticMarkup(<CatalogContent catalog={catalog} />);
  for (const text of ['GPU &lt;example&gt;', 'gpu@1', 'chassis@1', 'Unknown', 'WHOLE_DEVICE_ASSUMPTION', 'Add from catalog', 'Synthetic examples'])
    assert.ok(html.includes(text), text);
  const technologies = renderToStaticMarkup(<CatalogContent catalog={catalog} functionId="technologies" />);
  assert.ok(technologies.includes('heightU: 4')); assert.ok(!technologies.includes('Selected model composition'));
});

test('catalog examples keep scope, lower bounds and conflict diagnostics visible without save controls', () => {
  const c = { total: null, knownSubtotal: 3, limit: 6, unit: 'kW', status: 'UNKNOWN' };
  const example = { exampleId: 'e', name: 'Example conflict', description: 'Overlap.', validationState: 'NOT_RUN',
    rack: { rackId: 'r', name: 'A01' }, rackModel: { heightU: 42 }, equipment: { devices: [] },
    equipmentReport: { status: 'ISSUES_FOUND', diagnostics: [{ code: 'DEVICE_U_OVERLAP', message: 'Overlap.' }], racks: [{ capacities: { powerKw: c } }] } };
  const html = renderToStaticMarkup(<CatalogContent catalog={{ ...catalog, examples: [example] }} functionId="examples" />);
  for (const text of ['DEVICE_U_OVERLAP', 'NOT_RUN', 'unknown total', 'UNKNOWN', 'U1 at the bottom']) assert.ok(html.includes(text));
  assert.ok(!html.includes('Save layout'));
});

test('catalog HTTP client encodes project scope and forwards cancellation and dev identity', async () => {
  const abort = new AbortController(); let call;
  const client = createApiClient({ identity: () => 'viewer', fetchImpl: async (url, options) => {
    call = { url, options }; return { ok: true, json: async () => ({ data: catalog }) };
  } });
  await client.getRackCatalog('p/a', { signal: abort.signal });
  assert.equal(call.url, '/api/v1/projects/p%2Fa/rack/catalog');
  assert.equal(call.options.signal, abort.signal); assert.equal(call.options.headers['x-dev-subject'], 'viewer');
  assert.equal(getTool('catalog').permission, 'rack.read');
  assert.ok(!visibleTools([]).some((t) => t.toolId === 'catalog'));
  assert.deepEqual(getTool('catalog').functions.map((f) => f.functionId), ['models', 'technologies', 'examples']);
});

test('map colors distinguish U conflicts, high usage, unknown totals/limits and explicit zero power', () => {
  const row = { rackId: 'r', heightU: 42, occupiedU: 5, uStatus: 'CHECKED_SCOPE_CLEAR',
    capacities: { powerKw: { status: 'WITHIN_LIMIT', knownSubtotal: 3.3, total: 3.3, limit: 6 } } };
  const report = { racks: [row] };
  assert.equal(rackLoadDisplay('layout', 'r', report), null);
  assert.equal(rackLoadDisplay('u', 'r', report).label, '5/42 U');
  row.occupiedU = 40; assert.equal(rackLoadDisplay('u', 'r', report).tone, 'high');
  row.uStatus = 'ISSUES_FOUND'; assert.equal(rackLoadDisplay('u', 'r', report).tone, 'issue');
  const power = row.capacities.powerKw;
  assert.equal(rackLoadDisplay('power', 'r', report).tone, 'clear');
  power.total = null; power.status = 'UNKNOWN';
  assert.deepEqual(rackLoadDisplay('power', 'r', report), { tone: 'unknown', label: '≥3.3/6 kW' });
  power.status = 'EXCEEDED'; assert.equal(rackLoadDisplay('power', 'r', report).tone, 'issue');
  Object.assign(power, { total: 0, knownSubtotal: 0, limit: 0, status: 'WITHIN_LIMIT' });
  assert.deepEqual(rackLoadDisplay('power', 'r', report), { tone: 'clear', label: '0/0 kW' });
  assert.equal(rackLoadDisplay('u', 'r', null).tone, 'unknown');
});

test('fit racks centers rotated footprints at a bounded zoom without changing their saved coordinates', () => {
  const rack = { rackId: 'r', modelId: 'm', xM: 5, yM: 3, rotationDeg: 90 };
  const model = { modelId: 'm', widthM: 0.6, depthM: 1.2 };
  const fit = { cx: 50, cy: 40, scale: 4 };
  const camera = rackGroupCamera([rack], [model], fit);
  assert.deepEqual([camera.cx, camera.cy], [5, 3]);
  assert.ok(camera.scale > fit.scale && camera.scale <= fit.scale * 32);
  assert.deepEqual([rack.xM, rack.yM, rack.rotationDeg], [5, 3, 90]);
  assert.equal(rackGroupCamera([], [model], fit), null);
  assert.equal(rackGroupCamera([{ ...rack, xM: NaN }], [model], fit), null);
});
