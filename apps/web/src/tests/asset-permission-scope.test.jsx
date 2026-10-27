import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * A permission gate must be asked **in scope**.
 *
 * `asset.write` and `asset.delete` are project-scoped keys, and the server answers an
 * unscoped question about them with a determined `false` — not "unknown", not "ask
 * again", but a refusal. So a `<Can permission="asset.write">` that omits `projectId`
 * hides its children permanently, and the only symptom is a button that is not there: the
 * Assets surface never offered Upload files, and every row's Delete never appeared, while
 * both were fully implemented behind the gate. (A third, the project bar's Add files, has
 * since been removed outright — intake lives on the Assets surface.)
 *
 * The gate is mocked here rather than exercised, because the question being asked is not
 * what the server decides but **what scope the client asks in** — and a static render
 * cannot resolve a permission either way.
 */
const gates = [];
vi.mock('../permissions/usePermission.jsx', () => ({
  Can: ({ permission, projectId = null, fallback = null, children }) => {
    gates.push({ permission, projectId });
    // A real gate with no scope gets a refusal, so render as it would.
    return projectId ? children : fallback;
  },
}));

const { AssetsSurface } = await import('../assets/AssetsSurface.jsx');

const ASSETS = [
  {
    assetId: 'a1',
    name: 'campus.geojson',
    kind: 'GIS',
    mediaType: 'application/geo+json',
    versionNumber: 1,
    currentVersionId: 'v1',
    sizeBytes: 2048,
    uploader: 'ada',
    scanState: 'CLEAN',
    classification: 'PROJECT',
    boundToolIds: [],
  },
];

const render = (props = {}) =>
  renderToStaticMarkup(<AssetsSurface assets={ASSETS} projectId="p-1" {...props} />);

test('every gate on the assets surface is asked in the project scope', () => {
  gates.length = 0;
  render();

  assert.ok(gates.length > 0, 'the surface gates something');
  for (const gate of gates) {
    assert.equal(
      gate.projectId,
      'p-1',
      `${gate.permission} was asked without a project, which the server answers with a refusal`,
    );
  }
});

test('the upload control appears once the gate is asked in scope', () => {
  const html = render();
  assert.match(html, /Upload files/, 'the intake path is reachable, not just implemented');
});

test('the upload control is withheld when the surface is given no scope', () => {
  // Not an endorsement of rendering without a project — it is what makes the test above
  // mean something. If the gate ignored the scope, this would still render the button.
  const html = render({ projectId: null });
  assert.doesNotMatch(html, /Upload files/);
});

test('the destructive control is gated in scope too', () => {
  gates.length = 0;
  render();
  const keys = gates.map((gate) => gate.permission);
  assert.ok(keys.includes('asset.delete'), 'deleting an asset is gated');
  for (const gate of gates.filter((item) => item.permission === 'asset.delete')) {
    assert.equal(gate.projectId, 'p-1');
  }
});
