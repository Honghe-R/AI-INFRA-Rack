import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  beginLayoutDraft,
  layoutCheckBody,
  rackCorners,
  validateEditorPlacements,
} from '../rack/edit-layout-state.js';
import { RoomFloorplan } from '../rack/RackRoomView.jsx';
import { createApiClient } from '../api/client.js';
const model = { modelId: 'm', widthM: 0.8, depthM: 1.2 };
const rack = { rackId: 'r', modelId: 'm', name: 'Rack <A>', xM: 3, yM: 3, rotationDeg: 0, locked: false };
test('editor draft copies saved racks and retains version and snapshot identity across tab state storage', () => {
  const layout = { planId: 'p', version: 4, snapshot: { snapshotId: 's' }, placements: [rack] };
  const draft = beginLayoutDraft(layout);
  draft.placements[0].xM = 8;
  assert.equal(layout.placements[0].xM, 3);
  assert.equal(draft.baseVersion, 4);
  assert.deepEqual(layoutCheckBody(draft), {
    contract_version: 1,
    snapshot_id: 's',
    placements: draft.placements,
  });
  assert.equal(validateEditorPlacements(draft.placements), null);
  for (const patch of [{ name: ' ' }, { xM: NaN }, { yM: 10001 }, { rotationDeg: 45 }])
    assert.ok(validateEditorPlacements([{ ...rack, ...patch }]));
});
test('quarter-turn display keeps physical front edge and dimensions without changing stored coordinates', () => {
  assert.deepEqual(rackCorners({ ...rack, xM: 0, yM: 0, rotationDeg: 90 }, model), [
    [0.6, -0.4],
    [0.6, 0.4],
    [-0.6, 0.4],
    [-0.6, -0.4],
  ]);
  assert.equal(rack.xM, 3);
});
test('floorplan renders selected/conflicting racks with front edge, escapes labels and skips incomplete coordinates', () => {
  const html = renderToStaticMarkup(
    <RoomFloorplan
      room={{ name: 'Hall' }}
      view={{
        extentM: { width: 10, height: 10 },
        boundaryLocalM: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
          ],
        },
        areaM2: 100,
        interiorRingCount: 0,
        sourceCrs: 'EPSG:32618',
        originProjectedM: [0, 0],
      }}
      sourceGeometry={{ provenanceReference: 'demo' }}
      models={[model]}
      placements={[rack, { ...rack, rackId: 'invalid', xM: NaN }]}
      selectedId="r"
      report={{ diagnostics: [{ rackIds: ['r'] }] }}
    />,
  );
  for (const text of ['is-selected has-issue', 'rack-front-edge', 'Select rack Rack &lt;A&gt;']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('rack invalid'));
});
test('layout client sends scope, identity, If-Match, exact key and abort signal for each operation', async () => {
  const calls = [];
  const client = createApiClient({
    identity: () => 'editor',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    },
  });
  const signal = new AbortController().signal;
  const body = { contract_version: 1, snapshot_id: 's', placements: [rack] };
  await client.getRackLayout('p/x', 'id/x', { signal });
  await client.checkRackLayout('p/x', 'id/x', body, { signal });
  await client.saveRackLayout('p/x', 'id/x', body, { version: 4, idempotencyKey: 'key', signal });
  await client.captureRackRoom('p/x', 'id/x', { version: 4, idempotencyKey: 'capture', signal });
  assert.equal(calls[0].url, '/api/v1/projects/p%2Fx/rack/plans/id%2Fx/layout');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[2].options.method, 'PUT');
  assert.equal(calls[2].options.headers['If-Match'], '"4"');
  assert.equal(calls[2].options.headers['Idempotency-Key'], 'key');
  assert.deepEqual(JSON.parse(calls[2].options.body), body);
  assert.ok(calls[3].url.endsWith('/room-snapshot'));
  assert.deepEqual(JSON.parse(calls[3].options.body), { contract_version: 1 });
  for (const { options } of calls) {
    assert.equal(options.signal, signal);
    assert.equal(options.headers['x-dev-subject'], 'editor');
  }
});
