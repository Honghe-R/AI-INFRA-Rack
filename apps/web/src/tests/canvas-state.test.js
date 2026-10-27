import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW,
  INITIAL_BASEMAP_RUN,
  MAX_LATITUDE,
  TILE_FAILURE_LIMIT,
  attributionFor,
  basemapLost,
  basemapRun,
  clampView,
  clampZoom,
  fitBounds,
  formatDistance,
  isPlanOnly,
  metersPerPixel,
  niceDistance,
  panBy,
  planOnlyState,
  project,
  scaleBar,
  selectProvider,
  tileUrl,
  unproject,
  visibleTiles,
  wheelZoom,
  zoomAround,
} from '../map/canvas-state.js';

const PROVIDER = { providerId: 'test', label: 'Test', minZoom: 1, maxZoom: 18, tileSize: 256, attributionText: '© Test' };

test('the projection matches Web Mercator at known points', () => {
  const origin = project({ lon: 0, lat: 0 }, 0);
  assert.equal(origin.x, 128);
  assert.equal(origin.y, 128);

  const northWest = project({ lon: -180, lat: 0 }, 0);
  assert.equal(northWest.x, 0);

  const z1 = project({ lon: 0, lat: 0 }, 1);
  assert.equal(z1.x, 256);

  // Latitude is clamped at the Mercator limit rather than running to infinity.
  assert.ok(Number.isFinite(project({ lon: 0, lat: 89.9 }, 4).y));
  assert.equal(unproject(project({ lon: 10, lat: MAX_LATITUDE }, 4), 4).lat, MAX_LATITUDE);
});

test('project and unproject round-trip', () => {
  const point = { lon: 121.47, lat: 31.23 };
  const back = unproject(project(point, 12), 12);
  assert.ok(Math.abs(back.lon - point.lon) < 1e-9);
  assert.ok(Math.abs(back.lat - point.lat) < 1e-9);
});

test('zoom is clamped to the provider range', () => {
  assert.equal(clampZoom(0, PROVIDER), 1);
  assert.equal(clampZoom(25, PROVIDER), 18);
  assert.equal(clampZoom(7.4, PROVIDER), 7);
  assert.equal(clampZoom(Number.NaN, PROVIDER), 1);
  assert.equal(clampZoom(30, null), 22);
});

test('the view is brought inside the provider range, so the tiles and the geometry share one scale', () => {
  // The range has to hold for the view, not only for the tile request. `visibleTiles` clamps
  // internally and lays the grid out at the level it clamped to, while the overlay is projected
  // at `view.zoom` — so a view above the ceiling is two scales at once, and the geometry is drawn
  // over imagery it does not line up with.
  const above = { lon: 0, lat: 0, zoom: 21 };
  assert.equal(
    visibleTiles({ view: above, widthPx: 512, heightPx: 512, provider: PROVIDER }).zoom,
    18,
    'the tiles stop at the ceiling',
  );
  assert.equal(above.zoom, 21, 'and the view does not follow them on its own');

  const clamped = clampView(above, PROVIDER);
  assert.deepEqual(clamped, { lon: 0, lat: 0, zoom: 18 }, 'the view comes down to the tiles');
  assert.equal(
    visibleTiles({ view: clamped, widthPx: 512, heightPx: 512, provider: PROVIDER }).zoom,
    clamped.zoom,
    'the tile level and the view agree, which is the property the overlay projection needs',
  );

  // The floor is the same rule at the other end, and the centre is not moved by either.
  assert.deepEqual(clampView({ lon: 0, lat: 0, zoom: 0 }, PROVIDER), { lon: 0, lat: 0, zoom: 1 });

  // Identity is preserved when nothing moves, because this is used directly as a state updater:
  // a clamp that always allocated a new object would re-render on every call.
  const inside = { lon: 3, lat: 4, zoom: 9 };
  assert.equal(clampView(inside, PROVIDER), inside);
  // With no provider the range is the whole grid, which is not a clamp at all.
  const wide = { lon: 3, lat: 4, zoom: 22 };
  assert.equal(clampView(wide, null), wide);
});

test('the visible tile set covers the viewport and positions each tile inside it', () => {
  const layer = visibleTiles({ view: { lon: 0, lat: 0, zoom: 3 }, widthPx: 512, heightPx: 512, provider: PROVIDER });

  assert.equal(layer.zoom, 3);
  // 512px viewport at 256px tiles needs at most a 3x3 grid, offset by the centre.
  assert.ok(layer.tiles.length >= 4 && layer.tiles.length <= 9, `expected a small grid, got ${layer.tiles.length}`);
  for (const tile of layer.tiles) {
    assert.ok(tile.left > -256 && tile.left < 512, 'each tile overlaps the viewport');
    assert.ok(tile.top > -256 && tile.top < 512);
    assert.ok(tile.x >= 0 && tile.x < 2 ** layer.zoom, 'tile x wraps into the world');
  }
});

test('the tile grid is capped so a bad zoom cannot flood the proxy', () => {
  const layer = visibleTiles({ view: { lon: 0, lat: 0, zoom: 2 }, widthPx: 20_000, heightPx: 20_000, provider: { ...PROVIDER, minZoom: 0 }, maxTiles: 50 });
  assert.equal(layer.tiles.length, 50);
  assert.equal(layer.truncated, true);
});

test('panning moves the centre opposite the drag', () => {
  const view = { lon: 0, lat: 0, zoom: 4 };
  const east = panBy(view, { dxPx: -256, dyPx: 0 });
  assert.ok(east.lon > view.lon, 'dragging left moves the view east');

  const north = panBy(view, { dxPx: 0, dyPx: 256 });
  assert.ok(north.lat > view.lat, 'dragging down moves the view north');
  assert.equal(panBy(view, { dxPx: 0, dyPx: 0 }).lon, view.lon);
});

test('zooming about the cursor keeps the point under it', () => {
  const view = { lon: 0, lat: 20, zoom: 4 };
  const size = { widthPx: 800, heightPx: 600 };
  const anchorPx = { x: 620, y: 130 };

  // The geography under the cursor before the zoom…
  const world = project(view, view.zoom);
  const under = unproject({ x: world.x - size.widthPx / 2 + anchorPx.x, y: world.y - size.heightPx / 2 + anchorPx.y }, view.zoom);

  for (const nextZoom of [5, 7, 3]) {
    const zoomed = zoomAround(view, { nextZoom, anchorPx, ...size });
    assert.equal(zoomed.zoom, nextZoom);

    // …must still be under the cursor afterwards.
    const nextWorld = project(zoomed, nextZoom);
    const back = unproject(
      { x: nextWorld.x - size.widthPx / 2 + anchorPx.x, y: nextWorld.y - size.heightPx / 2 + anchorPx.y },
      nextZoom,
    );
    assert.ok(Math.abs(back.lon - under.lon) < 1e-9, `longitude drifted at z${nextZoom}`);
    assert.ok(Math.abs(back.lat - under.lat) < 1e-9, `latitude drifted at z${nextZoom}`);
  }
});

test('zooming about the centre is the centre-preserving case', () => {
  const view = { lon: 12, lat: 34, zoom: 6 };
  const zoomed = zoomAround(view, { nextZoom: 8, anchorPx: { x: 400, y: 300 }, widthPx: 800, heightPx: 600 });
  assert.ok(Math.abs(zoomed.lon - view.lon) < 1e-9);
  assert.ok(Math.abs(zoomed.lat - view.lat) < 1e-9);

  const unchanged = zoomAround(view, { nextZoom: 6, anchorPx: { x: 10, y: 10 }, widthPx: 800, heightPx: 600 });
  assert.deepEqual(unchanged, view, 'a zoom that changes nothing moves nothing');
});

test('a wheel notch steps once, and a trackpad accumulates', () => {
  const one = wheelZoom({ deltaY: 40 });
  assert.equal(one.steps, 1, 'scrolling down steps out');
  assert.equal(one.accumulated, 0);

  assert.equal(wheelZoom({ deltaY: -120 }).steps, -2, 'a fast scroll in is capped at two levels per event');

  const partial = wheelZoom({ deltaY: 15 });
  assert.equal(partial.steps, 0, 'a trackpad flick smaller than a notch does nothing yet');
  assert.equal(partial.accumulated, 15);
  const completed = wheelZoom({ deltaY: 25, accumulated: partial.accumulated });
  assert.equal(completed.steps, 1);
  assert.equal(completed.accumulated, 0);

  // Deltas arrive in lines or pages, not only pixels.
  assert.equal(wheelZoom({ deltaY: 3, deltaMode: 1 }).steps, 1);
  assert.equal(wheelZoom({ deltaY: 1, deltaMode: 2 }).steps, 2, 'a page delta is capped at two levels');
});

test('a flung wheel is capped rather than banked', () => {
  const flung = wheelZoom({ deltaY: 4000 });
  assert.equal(flung.steps, 2);
  assert.equal(flung.accumulated, 0, 'the remainder is discarded, so the next flick does not zoom again');
});

test('a tile URL addresses the proxy with the project scope and never the provider', () => {
  const url = tileUrl({ projectId: 'p-1', providerId: 'google', z: 12, x: 3400, y: 1600, style: 'terrain' });
  assert.equal(url, '/api/v1/map/tiles/google/12/3400/1600?project_id=p-1&style=terrain');
  assert.doesNotMatch(url, /tile\.googleapis\.com|key=/);
});

test('the project choice wins while it is available, otherwise a usable provider is picked', () => {
  const providers = [
    { providerId: 'google', label: 'Google', available: false, unavailableReason: 'no credential' },
    { providerId: 'self-hosted', label: 'Self hosted', available: true },
  ];
  assert.equal(selectProvider(providers, { providerId: 'self-hosted' }).providerId, 'self-hosted');
  assert.equal(selectProvider(providers, { providerId: 'google' }).providerId, 'self-hosted', 'an unusable choice falls through');
  assert.equal(selectProvider(providers, null).providerId, 'self-hosted');
  assert.equal(selectProvider([providers[0]], null), null, 'nothing usable means plan only');
  assert.equal(selectProvider([], { providerId: 'google' }), null);
});

test('plan-only is the absence of a usable provider, not an error', () => {
  assert.equal(isPlanOnly(null), true);
  assert.equal(isPlanOnly({ available: false }), true);
  assert.equal(isPlanOnly({ available: true }), false);
});

test('attribution is carried only when there is a provider to attribute', () => {
  assert.deepEqual(attributionFor({ attributionText: '© Test', attributionUrl: 'https://example.test' }), {
    text: '© Test',
    url: 'https://example.test',
  });
  assert.equal(attributionFor(null), null);
});

test('fitBounds zooms so the bounds fit the viewport, and clamps to the provider', () => {
  const tight = fitBounds(
    [
      { lon: 121.4, lat: 31.2 },
      { lon: 121.5, lat: 31.3 },
    ],
    { widthPx: 800, heightPx: 600, provider: PROVIDER },
  );
  assert.ok(tight.zoom > 8 && tight.zoom <= 18, `expected a close zoom, got ${tight.zoom}`);
  assert.ok(Math.abs(tight.lon - 121.45) < 1e-6);

  assert.deepEqual(fitBounds([], { widthPx: 800, heightPx: 600 }), DEFAULT_VIEW);
});

/* --------------------------------------------------------------- scale bar */

test('ground resolution matches the Web Mercator scale at known values', () => {
  // 40 075 016.686 m over 256 px at zoom 0.
  assert.ok(Math.abs(metersPerPixel({ lat: 0, zoom: 0 }) - 156_543.03) < 0.01);
  // One zoom level doubles the resolution.
  assert.ok(Math.abs(metersPerPixel({ lat: 0, zoom: 1 }) - metersPerPixel({ lat: 0, zoom: 0 }) / 2) < 1e-9);
  // And it shrinks with the cosine of the latitude.
  const atEquator = metersPerPixel({ lat: 0, zoom: 12 });
  const atAshburn = metersPerPixel({ lat: 39.043, zoom: 12 });
  assert.ok(Math.abs(atAshburn - atEquator * Math.cos((39.043 * Math.PI) / 180)) < 1e-9);
  assert.ok(atAshburn < atEquator, 'a pixel covers less ground away from the equator');
});

test('the ladder is 1, 2, or 5 times a power of ten, and never overshoots', () => {
  assert.equal(niceDistance(9), 5);
  assert.equal(niceDistance(10), 10, 'an exact power of ten does not fall to the rung below');
  assert.equal(niceDistance(100), 100);
  assert.equal(niceDistance(350), 200);
  assert.equal(niceDistance(1000), 1000);
  assert.equal(niceDistance(0.9), 0.5);
  for (const limit of [3, 47, 512, 9001, 18_000_000]) {
    const chosen = niceDistance(limit);
    assert.ok(chosen <= limit * (1 + 1e-9), `${chosen} must fit inside ${limit}`);
    assert.ok(chosen * 2.5 > limit, `${chosen} must be the largest rung that fits inside ${limit}`);
  }
  assert.equal(niceDistance(0), 0);
  assert.equal(niceDistance(Number.NaN), 0);
});

test('distances read in metres below a kilometre and in kilometres above it', () => {
  assert.equal(formatDistance(200), '200 m');
  assert.equal(formatDistance(500), '500 m');
  assert.equal(formatDistance(1000), '1 km');
  assert.equal(formatDistance(2000), '2 km');
  assert.equal(formatDistance(200_000), '200 km');
  assert.equal(formatDistance(0.5), '0.5 m');
  assert.equal(formatDistance(0), '');
});

test('a scale bar is a round distance inside the width it is given', () => {
  const scale = scaleBar({ lat: 39.043, zoom: 16, maxWidthPx: 120 });
  assert.match(scale.label, /^\d+(\.\d+)? (m|km)$/);
  assert.ok(scale.widthPx > 0 && scale.widthPx <= 120, `bar must fit its box, got ${scale.widthPx}`);
  // The bar's pixel width and its label describe the same distance.
  const perPixel = metersPerPixel({ lat: 39.043, zoom: 16 });
  assert.ok(Math.abs(scale.distanceM - scale.widthPx * perPixel) < perPixel, 'width and label agree within a pixel');
});

test('the scale bar lengthens as you zoom in, and degenerates nowhere', () => {
  const out = scaleBar({ lat: 39.043, zoom: 12, maxWidthPx: 120 });
  const inClose = scaleBar({ lat: 39.043, zoom: 18, maxWidthPx: 120 });
  assert.ok(inClose.distanceM < out.distanceM, 'zooming in means a shorter round distance');

  // At the latitude limit the cosine is tiny but never zero, so a bar still exists.
  const polar = scaleBar({ lat: MAX_LATITUDE, zoom: 3 });
  assert.ok(polar && polar.widthPx >= 1);
  assert.equal(scaleBar({ lat: 0, zoom: Number.POSITIVE_INFINITY }), null);
});

/* ------------------------------------------------------- the tile-failure run */

const runEvents = (state, types) => types.reduce((current, type) => basemapRun(current, { type }), state);

test('a run of failures loses the basemap, and a loaded tile ends the run', () => {
  const lost = runEvents(INITIAL_BASEMAP_RUN, Array.from({ length: TILE_FAILURE_LIMIT }, () => 'failed'));
  assert.equal(basemapLost(lost), true);
  assert.equal(basemapLost(runEvents(INITIAL_BASEMAP_RUN, ['failed', 'failed'])), false);

  // Consecutive, not cumulative: this is what "a run of failures" means, and it is
  // what lets a provider that is merely flaky recover without a page reload.
  assert.equal(basemapLost(runEvents(lost, ['loaded'])), false);
  assert.equal(
    basemapLost(runEvents(INITIAL_BASEMAP_RUN, ['failed', 'failed', 'loaded', 'failed', 'failed'])),
    false,
    'failures do not accumulate across a tile that arrived',
  );
});

test('a lost basemap can always be recovered by changing what is being asked', () => {
  // The regression this exists for: the count only ever went up, and because the
  // degraded canvas renders no tiles, no tile could load to clear it. A project whose
  // provider had no tile server stayed on the plan-only grid for the whole session,
  // and switching to a provider that answered changed nothing.
  const lost = runEvents(INITIAL_BASEMAP_RUN, ['failed', 'failed', 'failed']);
  assert.equal(basemapLost(lost), true);

  for (const scope of ['provider', 'viewport']) {
    assert.equal(
      basemapLost(basemapRun(lost, { type: 'scope' })),
      false,
      `changing the ${scope} must give the basemap another chance`,
    );
  }
});

test('an unchanged run is the same value, so a reset cannot churn a render', () => {
  assert.equal(basemapRun(INITIAL_BASEMAP_RUN, { type: 'scope' }), INITIAL_BASEMAP_RUN);
  assert.equal(basemapRun(INITIAL_BASEMAP_RUN, { type: 'loaded' }), INITIAL_BASEMAP_RUN);
  const failed = basemapRun(INITIAL_BASEMAP_RUN, { type: 'failed' });
  assert.notEqual(failed, INITIAL_BASEMAP_RUN);
  assert.equal(basemapRun(failed, { type: 'unknown' }), failed);
});

test('the plan-only state says why, and only offers retry when retrying could work', () => {
  // Each cause is a different sentence, because "Plan only" alone told the user nothing.
  assert.deepEqual(planOnlyState({ lost: true }), {
    text: 'The basemap provider could not be reached.',
    retry: true,
  });
  assert.deepEqual(planOnlyState({ canRead: false }), {
    text: 'The basemap needs map.read, which your role does not hold.',
    retry: false,
  });
  assert.deepEqual(planOnlyState({}), {
    text: 'No basemap provider is available for this project.',
    retry: false,
  });
  // A caller's own reason wins, and never offers a retry it cannot deliver.
  assert.deepEqual(planOnlyState({ planOnlyReason: 'The basemap is turned off.', lost: true }), {
    text: 'The basemap is turned off.',
    retry: false,
  });
  assert.equal(planOnlyState({ lost: false }).retry, false);
});
