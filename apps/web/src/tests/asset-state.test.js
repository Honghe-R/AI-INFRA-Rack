import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  IMPORT_ENTRY_POINTS,
  boundToolLabels,
  createAssetIntent,
  describeBinding,
  filterAssets,
  formatBytes,
  getEntryPoint,
  scanStateLabel,
  selectability,
  upgradeAffordance,
} from '../assets/asset-state.js';

test('every declared entry point produces the same intake request shape', () => {
  assert.equal(IMPORT_ENTRY_POINTS.length, 7);
  for (const point of IMPORT_ENTRY_POINTS) {
    const intent = createAssetIntent({
      entryPointId: point.entryPointId,
      projectId: 'p-1',
      files: [{ name: 'a.kml' }],
      toolId: point.binding ? 'site_facility' : null,
    });
    assert.equal(intent.projectId, 'p-1');
    assert.equal(intent.entryPointId, point.entryPointId);
    assert.equal(intent.files.length, 1);
    // The tool submits an intent, not bytes: creating and binding stay separate.
    assert.equal(intent.binding ? intent.binding.toolId : null, point.binding ? 'site_facility' : null);
  }
});

test('an unknown entry point, a missing project, or no files is refused', () => {
  assert.throws(() => createAssetIntent({ entryPointId: 'nope', projectId: 'p', files: [{}] }), /Unknown import entry point/);
  assert.throws(() => createAssetIntent({ entryPointId: 'project_add_files', files: [{}] }), /requires a project/);
  assert.throws(() => createAssetIntent({ entryPointId: 'project_add_files', projectId: 'p', files: [] }), /at least one file/);
  assert.throws(
    () => createAssetIntent({ entryPointId: 'tool_import', projectId: 'p', files: [{}] }),
    /requires a tool id/,
    'a binding entry point must name its tool',
  );
});

test('an assistant attachment intake demands explicit confirmation', () => {
  const intent = createAssetIntent({ entryPointId: 'assistant_promotion', projectId: 'p', files: [{}] });
  assert.equal(intent.requiresConfirmation, true);
  assert.equal(getEntryPoint('assistant_promotion').surface, 'ASSISTANT');
});

test('a quota of blocked assets stays selectable-with-reason, never absent', () => {
  assert.deepEqual(selectability({ scanState: 'CLEAN' }), { selectable: true, reason: null });
  assert.match(selectability({ quarantined: true }).reason, /quarantined/);
  assert.match(selectability({ archived: true }).reason, /archived/);
  assert.match(selectability({ authorized: false }).reason, /do not have access/);
  assert.match(selectability({ scanState: 'PENDING' }).reason, /scan state is scanning/);
  assert.match(selectability(null).reason, /no longer exists/);
});

test('scan state is text plus an icon', () => {
  assert.deepEqual(scanStateLabel('CLEAN'), { text: 'Scanned clean', icon: '✓' });
  assert.deepEqual(scanStateLabel('INFECTED'), { text: 'Infected — quarantined', icon: '!' });
  assert.equal(scanStateLabel('WHATEVER').text, 'Scan state unknown');
});

test('byte sizes are human readable and degrade safely', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(20 * 1024 * 1024 * 1024), '20 GB');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(-1), '—');
});

test('a newer version offers an explicit upgrade that requires review', () => {
  const binding = { bindingId: 'b1', assetVersionId: 'v1' };
  const asset = { currentVersionId: 'v2', currentVersionNumber: 2 };

  const affordance = upgradeAffordance(binding, asset);
  assert.equal(affordance.toVersionId, 'v2');
  assert.equal(affordance.requiresReview, true, 'upgrading re-enters the tool review workflow');
  assert.match(affordance.label, /Version 2 is available/);

  assert.equal(upgradeAffordance(binding, { currentVersionId: 'v1' }), null, 'a pinned version never changes silently');
  assert.equal(upgradeAffordance(null, asset), null);
});

test('a binding describes the exact version and representation it pins', () => {
  assert.equal(describeBinding({ assetVersionId: 'v1' }).label, 'v1');
  assert.match(describeBinding({ assetVersionId: 'v1', representationId: 'r1' }).label, /v1 · r1/);
  assert.equal(describeBinding(null), null);
});

test('assets filter by query, kind, and scan state together', () => {
  const assets = [
    { assetId: 'a1', name: 'site-plan.kml', kind: 'CAD', mediaType: 'application/vnd.kml', scanState: 'CLEAN' },
    { assetId: 'a2', name: 'survey.pdf', kind: 'STUDY', mediaType: 'application/pdf', scanState: 'PENDING' },
    { assetId: 'a3', name: 'site-photo.png', kind: 'RASTER', mediaType: 'image/png' },
  ];

  assert.equal(filterAssets(assets).length, 3);
  assert.deepEqual(filterAssets(assets, { query: 'site' }).map((a) => a.assetId), ['a1', 'a3']);
  assert.deepEqual(filterAssets(assets, { kind: 'STUDY' }).map((a) => a.assetId), ['a2']);
  assert.deepEqual(filterAssets(assets, { scanState: 'PENDING' }).map((a) => a.assetId), ['a2']);
  assert.deepEqual(filterAssets(assets, { scanState: 'NOT_SCANNED' }).map((a) => a.assetId), ['a3'], 'an unscanned asset is filterable');
  assert.deepEqual(filterAssets(assets, { query: 'pdf', mediaType: 'application/pdf' }).map((a) => a.assetId), ['a2']);
});

test('bound tools resolve to readable labels', () => {
  const asset = { boundToolIds: ['site_facility', 'floorplan'] };
  assert.deepEqual(boundToolLabels(asset, { site_facility: 'Site & Facility' }), ['Site & Facility', 'floorplan']);
  assert.deepEqual(boundToolLabels({}, {}), []);
});
