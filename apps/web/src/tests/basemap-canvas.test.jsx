import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { BasemapCanvas } from '../map/BasemapCanvas.jsx';

const PROVIDER = {
  providerId: 'test',
  label: 'Test provider',
  minZoom: 1,
  maxZoom: 18,
  tileSize: 256,
  available: true,
  attributionText: '© Test',
  attributionUrl: 'https://example.test/attribution',
};

const PROVIDERS = [PROVIDER, { providerId: 'google', label: 'Google Maps', available: false, unavailableReason: 'no credential' }];

function render(props = {}) {
  return renderToStaticMarkup(
    <BasemapCanvas projectId="p-1" providers={PROVIDERS} provider={PROVIDER} size={{ widthPx: 512, heightPx: 512 }} {...props} />,
  );
}

test('the canvas draws proxied tiles, never a provider URL', () => {
  const html = render();

  assert.match(html, /data-canvas-mode="BASEMAP"/);
  assert.match(html, /class="canvas__tile"/);
  assert.match(html, /src="\/api\/v1\/map\/tiles\/test\/\d+\/\d+\/\d+\?project_id=p-1"/);
  assert.doesNotMatch(html, /tile\.googleapis\.com|MAP_|api_key|key=/, 'no provider URL or credential may reach the client');
  assert.equal((html.match(/class="canvas__tile"/g) ?? []).length >= 4, true, 'a 512px viewport needs several tiles');
});

test('attribution renders with the tiles, as the licence requires', () => {
  const html = render();
  assert.match(html, /canvas__attribution/);
  assert.match(html, /© Test/);
  assert.match(html, /href="https:\/\/example\.test\/attribution"/);
});

test('a provider without a usable credential degrades to the plan-only grid', () => {
  const html = render({ provider: null });

  assert.match(html, /data-canvas-mode="PLAN_ONLY"/);
  assert.match(html, /canvas__surface--plan-only/);
  assert.doesNotMatch(html, /class="canvas__tile"/, 'no tile is requested at all');
  assert.match(html, /No basemap provider is available for this project/);
  assert.match(html, /canvas__attribution--none/, 'the plan-only state is credited on the map');
  assert.match(html, /Plan-only grid/);
  assert.match(html, /Plan only/);
});

test('a role without map.read gets the plan-only grid and the reason', () => {
  const html = render({ canRead: false });
  assert.match(html, /data-canvas-mode="PLAN_ONLY"/);
  assert.match(html, /needs map.read, which your role does not hold/);
});

test('an unavailable provider stays listed but cannot be selected, and plan-only is always a choice', () => {
  const html = render();
  assert.match(html, /<option value=""( selected="")?>Plan only<\/option>/);
  assert.match(html, /<option value="google" disabled="">Google Maps — no credential<\/option>/);
  assert.match(html, /<option value="test"( selected="")?>Test provider<\/option>/);
});

test('turning the basemap off is a stated choice, not a failure', () => {
  const html = render({ provider: null, planOnlyReason: 'The basemap is off.' });
  assert.match(html, /data-canvas-mode="PLAN_ONLY"/);
  assert.match(html, /The basemap is off\. Showing the plan-only grid\./);
  assert.doesNotMatch(html, /could not be reached|No basemap provider is available/);
  // The notice completes the reason with its own sentence, so a reason that already ended in
  // that sentence read it twice — and this is the state the canvas now opens in, where an empty
  // project shows the notice rather than hiding it behind the drawing.
  assert.equal((html.match(/Showing the plan-only grid/g) ?? []).length, 1);
});

test('zoom bounds come from the provider, so the proxy is never asked for a tile it refuses', () => {
  const atMax = render({ view: { lon: 0, lat: 0, zoom: 18 } });
  assert.match(atMax, /aria-label="Zoom in"[^>]*disabled/);

  const atMin = render({ view: { lon: 0, lat: 0, zoom: 1 } });
  assert.match(atMin, /aria-label="Zoom out"[^>]*disabled/);

  const middle = render({ view: { lon: 0, lat: 0, zoom: 5 } });
  assert.doesNotMatch(middle, /aria-label="Zoom in"[^>]*disabled/);
  assert.doesNotMatch(middle, /aria-label="Zoom out"[^>]*disabled/);
});

test('the canvas is operable from the keyboard and says how', () => {
  const html = render();
  assert.match(html, /role="application"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /Scroll or pinch to zoom/);
  assert.match(html, /arrow keys pan, plus and minus zoom/);
});

test('the strip below the map retires, and the credit floats on it', () => {
  // The credits moved into the map's corner and the tool's readings were removed, so the row
  // that held them has no reason to exist — it cost the drawing area a line and read as a
  // second toolbar under the canvas. Attribution is a licence condition and stays; nothing
  // else was in there worth a row.
  const html = render();
  assert.match(html, /canvas__attribution/);
  assert.doesNotMatch(html, /canvas__usage/, 'the readings are gone');
  assert.doesNotMatch(html, /canvas__status/, 'and so is the strip that held them');

  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const at = css.indexOf('\n.canvas__attribution {');
  assert.notEqual(at, -1, 'expected a rule for the credit');
  const rule = css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(rule, /position: absolute/);
  assert.match(rule, /right: var\(--space-2\)/);
  assert.match(rule, /bottom: var\(--space-2\)/);
  assert.match(rule, /pointer-events: none/, 'the corner of a map is where a pan starts');
  assert.match(rule, /text-overflow: ellipsis/);
});

/* ------------------------------------------------------- facility overlay */

const CAMPUS = {
  geometryId: 'g-site',
  entityId: 'e-site',
  entityType: 'SITE',
  role: 'BOUNDARY',
  displayName: 'Northern DC Campus',
  geojson4326: {
    type: 'Polygon',
    coordinates: [[[-77.4925, 39.0425], [-77.4866, 39.0425], [-77.4866, 39.0455], [-77.4925, 39.0425]]],
  },
};

const POWER = {
  geometryId: 'g-power',
  entityId: 'e-power',
  entityType: 'UTILITY_INTERFACE',
  role: 'CONNECTION_POINT',
  displayName: 'Power Interface A',
  geojson4326: { type: 'Point', coordinates: [-77.4919, 39.0435] },
};

const FEATURES = [CAMPUS, POWER];

const LAYERS = [
  { id: 'site', label: 'Site & parcel', visible: true, count: 1 },
  { id: 'buildings', label: 'Buildings', visible: true, count: 0 },
  { id: 'utilities', label: 'Utilities', visible: true, count: 1 },
];

const CLOSE_VIEW = { lon: -77.49, lat: 39.043, zoom: 15 };

test('the facility graph draws as SVG over the basemap', () => {
  const html = render({ features: FEATURES, layers: LAYERS, view: CLOSE_VIEW });

  assert.match(html, /class="canvas__overlay"/);
  assert.match(html, /canvas__feature--site/);
  assert.match(html, /<path[^>]*d="M /);
  assert.match(html, /canvas__feature--utilities/);
  assert.match(html, /<circle/);
  // At a working zoom the site and building names are drawn.
  assert.match(html, /canvas__feature-label/);
  assert.match(html, /Northern DC Campus/);
});

test('a hidden layer is filtered before it is projected', () => {
  const hidden = LAYERS.map((layer) => (layer.id === 'utilities' ? { ...layer, visible: false } : layer));
  const html = render({ features: FEATURES, layers: hidden, view: CLOSE_VIEW });
  assert.match(html, /canvas__feature--site/);
  assert.doesNotMatch(html, /canvas__feature--utilities/);
});

test('the layer switches state their counts, and an empty layer is not offered', () => {
  const html = render({ features: FEATURES, layers: LAYERS, view: CLOSE_VIEW });
  assert.match(html, /Facility layers/);
  assert.match(html, /Site &amp; parcel/);
  assert.match(html, /canvas__layer-count">1</);
  assert.doesNotMatch(html, /Buildings/, 'a layer with no records has nothing to switch');
});

test('the facility graph still draws on the plan-only grid, and the fallback notice steps aside', () => {
  const html = render({ provider: null, features: FEATURES, layers: LAYERS, view: CLOSE_VIEW });
  assert.match(html, /data-canvas-mode="PLAN_ONLY"/);
  assert.match(html, /canvas__feature--site/, 'geometry is the project’s data, not a basemap feature');
  assert.doesNotMatch(html, /canvas__notice/, 'the grid is no longer empty, so the explanation would cover the site');
  assert.match(html, /canvas__attribution--none/, 'the plan-only state is credited on the map');
  assert.match(html, /Plan-only grid/);
});

test('a selected feature is marked and carries its accessible name', () => {
  const html = render({ features: FEATURES, layers: LAYERS, view: CLOSE_VIEW, selectedGeometryId: 'g-site' });
  assert.match(html, /canvas__feature--selected/);
  assert.match(html, /aria-label="Northern DC Campus \(BOUNDARY\)"/);
});

/**
 * The markup inside the map surface, found by counting the `div`s it opens.
 *
 * The search has to be *outside* the surface, and "outside" is a nesting question, not an
 * ordering one: the surface disables native touch panning and claims the wheel to zoom, and
 * both apply to every descendant.
 */
function surfaceMarkup(html) {
  const start = html.indexOf('<div class="canvas__surface');
  assert.notEqual(start, -1, 'the surface renders');
  const tags = /<(\/?)div\b/g;
  tags.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tags.exec(html))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  throw new Error('unbalanced divs after the surface');
}

test('the search control floats over the map from outside it, and only over a drawing', () => {
  // A name is how a plan is navigated when you do not yet know where a thing is, so the
  // search sits in the top-right corner; it is closed until it is asked for.
  const html = render({ features: FEATURES, layers: LAYERS, view: CLOSE_VIEW });
  assert.match(html, /canvas__search/);
  assert.match(html, /aria-label="Search the facility graph"/);
  assert.equal(html.includes('canvas__search-input'), false, 'closed until it is asked for');

  // And it is a sibling of the surface rather than a child of it. Inside, a wheel over the
  // results zoomed the map instead of scrolling them — the surface's handler claims the
  // gesture — and `touch-action: none` on the surface meant a finger could not scroll them
  // either. Both of those reach every descendant, so the panel must not have any.
  assert.equal(
    surfaceMarkup(html).includes('canvas__search'),
    false,
    'a panel with its own scroll cannot live inside the element that claims the wheel',
  );

  // Nothing drawn is nothing to search: the control is absent rather than opening onto an
  // empty panel.
  assert.doesNotMatch(render({ features: [], layers: [], view: CLOSE_VIEW }), /canvas__search/);
});

test('the fit control is offered only when there is something to fit', () => {
  assert.doesNotMatch(render({ features: FEATURES, layers: LAYERS }), /Fit facility/);
  const html = render({ features: FEATURES, layers: LAYERS, onFit: () => {} });
  assert.match(html, /aria-label="Fit facility"/);
});

test('nothing renders above the map, because nothing is passed a slot above it', () => {
  // There is no `banner` prop any more. It is the mechanism that inserted a row above the
  // map and resized it — which moved every feature the user was about to click on — and
  // nothing had passed one since the selection banner was deleted in favour of the
  // inspector. Controls that belong on the map are overlaid on it instead.
  const html = render({ banner: <p className="canvas__selection">Selected: Data Centre A</p> });
  assert.doesNotMatch(html, /canvas__selection/, 'an unknown prop cannot insert a row above the map');
  assert.doesNotMatch(html, /canvas__bar/, 'and there is no row above it to insert into');
});

test('the canvas carries a distance scale in metres and kilometres', () => {
  const html = render({ view: { lon: -77.49, lat: 39.043, zoom: 16 } });
  assert.match(html, /class="canvas__scale"/);
  assert.match(html, /role="img" aria-label="Map scale: \d+(\.\d+)? (m|km)"/);
  assert.match(html, /class="canvas__scale-label">\d+(\.\d+)? (m|km)</);
  assert.match(html, /class="canvas__scale-bar" style="width:\s*\d+px"/);
});

test('the scale is drawn on the plan-only grid too, where it matters most', () => {
  const html = render({ provider: null, view: { lon: -77.49, lat: 39.043, zoom: 16 } });
  assert.match(html, /data-canvas-mode="PLAN_ONLY"/);
  assert.match(html, /canvas__scale-bar/);
});

/* ------------------------------------------------------------- drawing mode */

test('a draft polygon draws as a draft, not as a facility feature', () => {
  const html = render({
    drawing: true,
    draftShape: { path: 'M 10 10 L 90 10 L 90 90', points: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }] },
  });

  assert.match(html, /class="canvas__draft"/);
  assert.match(html, /canvas__draft-path/);
  assert.equal((html.match(/canvas__draft-vertex/g) ?? []).length, 3, 'every placed vertex is marked');
  // It is unfinished work, so it is not offered as something to select.
  assert.doesNotMatch(html, /canvas__feature--draft/);
});

test('drawing mode says so, and takes the map out from under the polygon', () => {
  const html = render({ drawing: true, onDraftPoint: () => {} });
  assert.match(html, /canvas__surface--drawing/);
  assert.match(html, /canvas__mode--centre[^>]*>Drawing</, 'the mode is announced');
  assert.match(html, /Click to place a vertex/);
  assert.match(html, /Panning and zooming are paused/);
});

test('with nothing drawn there is no draft layer at all', () => {
  const html = render({ drawing: true, draftShape: null, onDraftPoint: () => {} });
  assert.doesNotMatch(html, /canvas__draft/);
  assert.match(html, /canvas__mode--centre[^>]*>Drawing</, 'the mode is still announced');
});
