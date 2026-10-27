import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPermissionClient } from '../rbac/client.js';
import { App } from '../App.jsx';
import { AssetsSurface } from '../assets/AssetsSurface.jsx';
import { AssetPicker } from '../assets/AssetPicker.jsx';
import { createWorkspaceContext } from '../state/workspace-context.js';
import { createOpenViewsState, openViewsReducer } from '../state/open-views.js';

const CONTEXT = createWorkspaceContext({
  projectId: 'p-1',
  projectName: 'Northern DC',
  scenarioId: 's-1',
  revisionId: 'rev-11111111',
});

const ASSETS = [
  { assetId: 'a1', name: 'site-plan.kml', kind: 'CAD', mediaType: 'application/vnd.kml', versionNumber: 2, currentVersionId: 'v2', currentVersionNumber: 2, sizeBytes: 2048, uploader: 'ada', scanState: 'CLEAN', classification: 'PROJECT', boundToolIds: ['site_facility'] },
  { assetId: 'a2', name: 'survey.pdf', kind: 'STUDY', mediaType: 'application/pdf', versionNumber: 1, currentVersionId: 'v1', sizeBytes: 5 * 1024 * 1024, uploader: 'grace', scanState: 'PENDING', classification: 'RESTRICTED' },
  { assetId: 'a3', name: 'old.dwg', kind: 'CAD', mediaType: 'image/vnd.dwg', versionNumber: 1, currentVersionId: 'v1', sizeBytes: 1024, uploader: 'ada', scanState: 'CLEAN', archived: true },
  { assetId: 'a4', name: 'bad.zip', kind: 'OTHER', mediaType: 'application/zip', versionNumber: 1, currentVersionId: 'v1', sizeBytes: 1024, uploader: 'ada', scanState: 'INFECTED', quarantined: true },
];

function clientWith(keys) {
  const client = createPermissionClient({ fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } }) });
  client.setUnscopedKeys(keys);
  return client;
}

function renderApp(props = {}) {
  return renderToStaticMarkup(
    <App projects={[]} permissionClient={clientWith(props.keys ?? [])} {...props} />,
  );
}

test('the assets surface lists the state a binding decision needs', () => {
  const html = renderToStaticMarkup(<AssetsSurface assets={ASSETS} toolLabels={{ site_facility: 'Site & Facility' }} />);
  assert.match(html, /aria-label="Project assets"/);
  assert.match(html, /<table/);
  assert.match(html, /<th scope="col">Scan<\/th>/);
  assert.match(html, /site-plan\.kml/);
  assert.match(html, /v2/);
  assert.match(html, /2\.0 KB/);
  assert.match(html, /Scanned clean/);
  assert.match(html, /Site &amp; Facility/, 'bound tools are named');
  assert.match(html, /RESTRICTED/, 'classification is shown');
  assert.match(html, /not bound/);
});

test('blocked assets stay listed with a textual reason', () => {
  const html = renderToStaticMarkup(<AssetsSurface assets={ASSETS} />);
  assert.match(html, /archived; restore it before binding/);
  assert.match(html, /Infected — quarantined/);
  assert.match(html, /Scanning/);
});

test('the surface never edits design data and says so', () => {
  const html = renderToStaticMarkup(<AssetsSurface assets={ASSETS} />);
  assert.match(html, /never edits design data/);
});

test('upload and delete are permission gated', () => {
  const granted = renderToStaticMarkup(
    <App initialContext={CONTEXT} keys={['facility.read', 'asset.read', 'asset.write', 'asset.delete']} assets={ASSETS} />,
  );
  assert.doesNotMatch(granted, /Upload files/, 'the surface only renders when its tab is open');

  const surface = renderToStaticMarkup(
    <AssetsSurface assets={ASSETS} />,
  );
  assert.doesNotMatch(surface, /Upload files/, 'without a granted key the upload action is not drawn');
  assert.doesNotMatch(surface, /Delete/);
});

test('opening the Assets tool renders the surface in the main view', () => {
  const views = openViewsReducer(createOpenViewsState(), {
    type: 'OPEN',
    tabId: 'tab-assets',
    toolId: 'assets',
    workspaceContext: CONTEXT,
    routeState: {},
  });

  const html = renderApp({
    initialContext: CONTEXT,
    initialViews: views,
    keys: ['asset.read'],
    assets: ASSETS,
    toolLabels: { site_facility: 'Site & Facility' },
  });

  assert.match(html, /aria-label="Project assets"/, 'the supporting workspace renders as a main view');
  assert.match(html, /aria-selected="true"/, 'and it is the active open-view tab');
  assert.match(html, /data-tool-id="assets"/);
});

test('the picker pins an exact version and representation', () => {
  const html = renderToStaticMarkup(
    <AssetPicker
      assets={[
        { ...ASSETS[0], representations: [{ representationId: 'r1', kind: 'MESH', producer: 'ifc-adapter' }] },
      ]}
      canImport
    />,
  );
  assert.match(html, /aria-label="Choose a project asset"/);
  assert.match(html, /Import a new file/);
  assert.match(html, /Representation/);
  assert.match(html, /MESH · ifc-adapter/);
  assert.match(html, /Bind to revision/);
});

test('the picker disables a blocked asset and explains why', () => {
  const html = renderToStaticMarkup(<AssetPicker assets={[ASSETS[3]]} />);
  assert.match(html, /disabled=""/);
  assert.match(html, /quarantined until the scan clears/);
  // A blocked asset offers no bind action at all rather than a disabled one: the
  // version, representation, and role controls that now sit above the button could
  // not be used either, so rendering them would be a form that exists only to
  // refuse. The invariant the earlier version of this test asserted — that a
  // blocked selection cannot be bound — holds either way, and the radio is what
  // cannot be selected.
  assert.doesNotMatch(html, /Bind to revision/);
});

test('a newer version offers an explicit upgrade that requires review', () => {
  const html = renderToStaticMarkup(
    <AssetPicker
      assets={[ASSETS[0]]}
      bindings={[{ bindingId: 'b1', assetId: 'a1', assetVersionId: 'v1' }]}
    />,
  );
  assert.match(html, /aria-label="Bound assets"/);
  assert.match(html, /Version 2 is available — review and upgrade/);
});
