import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * What the canvas shows before the user has asked for anything.
 *
 * This needs its own file because it mocks the provider read, and every other canvas test either
 * leaves that hook unmocked or is about the map once a provider is in hand. A static render runs
 * no effects, so an unmocked `useMapProviders` never resolves and the canvas is plan-only whatever
 * the default is — the one arrangement in which the default is unobservable. Giving it a provider
 * that *is* available is what makes the assertion mean something: the state is then a choice this
 * component made, not a read that had not come back yet.
 *
 * A tile is a metered request to a licensed third party, so "which view opens first" is a
 * correctness question about what the tool spends, not only about what it looks like.
 */
vi.mock('../permissions/usePermission.jsx', () => ({
  usePermission: () => ({ allowed: true, pending: false, unavailable: false }),
}));

vi.mock('../facility/useFacilityEnvelope.js', () => ({
  useFacilityEnvelope: () => ({
    envelope: { revisionId: 'r-1', lifecycleState: 'DRAFT' },
    features: [],
    containers: [],
    scopes: [],
    utilitySources: [],
    utilityInterfaces: [],
    spatialConstraints: [],
    capabilityCoverage: [],
    pending: false,
    error: null,
    reload: () => {},
  }),
}));

/**
 * An available provider, and one the project has already chosen.
 *
 * Both halves are set so that the only thing left able to keep the canvas on the grid is the
 * component's own default. If the default were `false`, this render draws a basemap.
 */
vi.mock('../api/useMapProviders.js', () => ({
  useMapProviders: () => ({
    providers: [
      {
        providerId: 'test',
        label: 'Test provider',
        minZoom: 1,
        maxZoom: 18,
        tileSize: 256,
        available: true,
        attributionText: '© Test',
        attributionUrl: 'https://example.test/attribution',
      },
    ],
    settings: { providerId: 'test' },
    provider: {
      providerId: 'test',
      label: 'Test provider',
      minZoom: 1,
      maxZoom: 18,
      tileSize: 256,
      available: true,
      attributionText: '© Test',
      attributionUrl: 'https://example.test/attribution',
    },
    pending: false,
    error: null,
    choose: async () => null,
    reload: async () => null,
  }),
}));

const { SiteFacilityCanvas } = await import('../map/SiteFacilityCanvas.jsx');

const client = {
  request: async () => ({}),
  get: async () => ({}),
  post: async () => ({}),
  put: async () => ({}),
  can: async () => ({ allowed: true }),
};

const markup = () =>
  renderToStaticMarkup(<SiteFacilityCanvas client={client} projectId="p-1" revisionId="r-1" />);

test('the canvas opens on the plan-only grid even when a provider is chosen and available', () => {
  const html = markup();

  assert.match(html, /data-canvas-mode="PLAN_ONLY"/, 'the first view is the plan grid, not imagery');
  assert.doesNotMatch(html, /class="canvas__tile"/, 'opening a project spends no tile request');
  assert.match(
    html,
    /<option value="" selected="">Plan only<\/option>/,
    'the control opens stating the state it is actually in, rather than naming an unchosen provider',
  );
  // Stated, not silent: the user can see why the map is a grid, and the control is one step away.
  assert.match(html, /The basemap is off\./);
});
