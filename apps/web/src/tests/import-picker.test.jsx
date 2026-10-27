import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetPicker } from '../assets/AssetPicker.jsx';
import {
  BINDING_ROLES,
  defaultBindingRole,
  describeBindingAgainstAssets,
  orderRepresentations,
  representationLabel,
} from '../assets/asset-state.js';

/**
 * The import path's picker.
 *
 * What matters here is the contract the tool has to satisfy: a binding names an
 * exact version and representation (ui-pattern.md, "Import Entry Points" 3), a role
 * is required, a blocked asset stays listed with a textual reason (rule 5), and an
 * unreviewed source never reads as authoritative.
 */

const VERSIONS = [
  { assetVersionId: 'v2', versionNumber: 2, status: 'CURRENT', filename: 'campus-v2.geojson', representations: [
    { representationId: 'r-features', kind: 'FEATURES', producerId: 'geojson', status: 'READY' },
    { representationId: 'r-georef', kind: 'GEOREFERENCE', producerId: 'geojson', status: 'READY' },
  ] },
  { assetVersionId: 'v1', versionNumber: 1, status: 'SUPERSEDED', filename: 'campus-v1.geojson', representations: [
    { representationId: 'r-old', kind: 'FEATURES', producerId: 'geojson', status: 'READY' },
  ] },
];

const ASSET = {
  assetId: 'a1',
  name: 'Campus survey',
  kind: 'GIS',
  mediaType: 'application/geo+json',
  currentVersionId: 'v2',
  currentVersionNumber: 2,
  scanState: 'CLEAN',
  classification: 'PROJECT',
  versions: VERSIONS,
  representations: VERSIONS[0].representations,
};

const render = (props = {}) =>
  renderToStaticMarkup(
    <AssetPicker assets={[ASSET]} canImport selectedAssetId="a1" onSelectAsset={() => {}} {...props} />,
  );

test('the picker offers an exact version and representation, and a required role', () => {
  const html = render();

  assert.match(html, /<span>Version<\/span>/);
  assert.match(html, /v2 · current/);
  assert.match(html, /v1 · SUPERSEDED/, 'an older version stays selectable');
  assert.match(html, /<span>Representation<\/span>/);
  assert.match(html, /FEATURES · geojson/);
  assert.match(html, /<span>Role<\/span>/);
  for (const role of BINDING_ROLES) {
    assert.match(html, new RegExp(`value="${role.value}"`), `${role.value} is offered`);
  }
  assert.match(html, /Bind to revision/);
});

test('the default role under-claims rather than over-claims', () => {
  // Geometry-bearing files are sources; anything unrecognized is a reference, which
  // asserts the least. A default that over-claims reads as authoritative before review.
  assert.equal(defaultBindingRole({ kind: 'GIS' }), 'SOURCE');
  assert.equal(defaultBindingRole({ kind: 'CAD' }), 'SOURCE');
  assert.equal(defaultBindingRole({ kind: 'BIM' }), 'SOURCE');
  assert.equal(defaultBindingRole({ kind: 'DATASET' }), 'EVIDENCE');
  assert.equal(defaultBindingRole({ kind: 'DOCUMENT' }), 'REFERENCE');
  assert.equal(defaultBindingRole({ kind: 'RASTER' }), 'REFERENCE');
  assert.equal(defaultBindingRole(null), 'REFERENCE');
});

test('a version with no representation says so instead of offering an empty choice', () => {
  const html = render({
    assets: [{ ...ASSET, versions: [{ ...VERSIONS[1], representations: [] }], representations: [] }],
  });

  assert.match(html, /No representation has been produced for this version/);
  // The binding is still offered: pinning a version before its derivative exists is a
  // legitimate state, and the command accepts it.
  assert.match(html, /Bind to revision/);
  assert.doesNotMatch(html, /<span>Representation<\/span>\s*<select/, 'no empty select is rendered');
});

test('a blocked asset stays listed, disabled, and explained', () => {
  const html = render({
    assets: [{ ...ASSET, name: 'bad.zip', archived: true }],
  });

  assert.match(html, /bad\.zip/, 'it is still listed');
  assert.match(html, /archived; restore it before binding/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /Bind to revision/, 'a blocked selection offers no bind action');
});

test('a read failure is reported rather than rendered as an empty project', () => {
  const html = render({ assets: [], error: new Error('The project assets could not be read.') });
  assert.match(html, /role="alert"/);
  assert.match(html, /could not be read/);
});

test('an empty project explains how an asset comes to exist', () => {
  const html = render({ assets: [] });
  assert.match(html, /This project has no assets yet/);
  assert.match(html, /every tool in the project can then use it/);
});

test('a binding is read as its asset, its version, and its review state', () => {
  const described = describeBindingAgainstAssets(
    {
      bindingId: 'b1',
      assetId: 'a1',
      assetVersionId: 'v2',
      role: 'SOURCE',
      status: 'UNREVIEWED',
      authoritative: false,
      mappingsInReview: 2,
    },
    [{ ...ASSET }],
  );

  assert.equal(described.assetName, 'Campus survey');
  assert.equal(described.filename, 'campus-v2.geojson');
  assert.equal(described.versionNumber, 2);
  assert.equal(described.authoritative, false);
  assert.equal(described.mappingsInReview, 2);

  // An asset that is no longer in the project must not vanish from provenance.
  const orphaned = describeBindingAgainstAssets(
    { bindingId: 'b2', assetVersionId: 'v9', role: 'SOURCE', status: 'UNREVIEWED' },
    [{ ...ASSET }],
  );
  assert.equal(orphaned.assetName, null);
  assert.equal(orphaned.missingAsset, true);
});

test('the bound list shows what each binding pinned, and its review state as text', () => {
  const html = render({
    bindings: [
      {
        bindingId: 'b1',
        assetId: 'a1',
        assetVersionId: 'v2',
        role: 'SOURCE',
        status: 'UNREVIEWED',
        authoritative: false,
        mappingsInReview: 1,
      },
    ],
  });

  assert.match(html, /aria-label="Bound assets"/);
  assert.match(html, /Campus survey/);
  assert.match(html, /v2/);
  assert.match(html, /SOURCE/);
  // State is text plus icon, never colour alone (ui-pattern.md, "Import Entry Points" 6).
  assert.match(html, /Not reviewed/);
  assert.doesNotMatch(html, /✓ Reviewed/);
});

test('the derivative offered first follows the role', () => {
  // A source wants the extract the mapping reads; a reference wants the file itself.
  const representations = [
    { representationId: 'r-orig', kind: 'ORIGINAL', producerId: 'original' },
    { representationId: 'r-feat', kind: 'FEATURES', producerId: 'kml' },
    { representationId: 'r-geo', kind: 'GEOREFERENCE', producerId: 'kml' },
  ];

  assert.deepEqual(
    orderRepresentations(representations, 'SOURCE').map((item) => item.representationId),
    ['r-feat', 'r-geo', 'r-orig'],
  );
  assert.deepEqual(
    orderRepresentations(representations, 'REFERENCE').map((item) => item.representationId),
    ['r-orig', 'r-feat', 'r-geo'],
  );
  // Ordering, not filtering: every derivative stays reachable.
  assert.equal(orderRepresentations(representations, 'SOURCE').length, 3);
});

test('a representation label does not say the same word twice', () => {
  assert.equal(representationLabel({ kind: 'ORIGINAL', producerId: 'original' }), 'ORIGINAL');
  assert.equal(representationLabel({ kind: 'FEATURES', producerId: 'kml' }), 'FEATURES · kml');
  assert.equal(representationLabel({ kind: 'FEATURES' }), 'FEATURES');
  assert.equal(representationLabel(null), '');
});
