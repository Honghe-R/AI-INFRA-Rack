/**
 * Basemap canvas geometry, kept free of React and the DOM (implementation plan
 * T7b; D16 and the W5 tile proxy).
 *
 * The server owns the credential and meters every tile, so this layer only has to
 * answer three questions: which tiles cover the viewport, where each one sits, and
 * which URL asks the proxy for it. Every function is pure, which is what lets the
 * tile maths be asserted without a browser.
 */

export const TILE_SIZE = 256;

/** Web Mercator's latitude limit; beyond it the projection runs to infinity. */
export const MAX_LATITUDE = 85.051_128_78;

/** A world view: the whole map, which is what a canvas with no site data shows. */
export const DEFAULT_VIEW = Object.freeze({ lon: 0, lat: 20, zoom: 2 });

/** The most tiles one viewport may ask for, so a zoom bug cannot flood the proxy. */
export const MAX_VISIBLE_TILES = 256;

/** A few blank tiles are normal at the edge of coverage; a run of failures is not. */
export const TILE_FAILURE_LIMIT = 3;

export const INITIAL_BASEMAP_RUN = Object.freeze({ failures: 0 });

/**
 * The tile-failure run, as a value rather than a component's private counter.
 *
 * `TILE_FAILURE_LIMIT` says "a *run* of failures", which is a statement about
 * consecutive failures. Counting them cumulatively instead turned the plan-only
 * fallback into a one-way latch, and it could not clear itself: the degraded canvas
 * renders no tiles at all, so no tile can load and end the run. Three edge-of-coverage
 * tiles failed, and the project was stuck on the plan-only grid for the rest of the
 * session — switching to a provider that answers changed nothing, because the count
 * outlived the provider that produced it.
 *
 * Two events therefore clear the run. `loaded` is what makes it consecutive rather
 * than cumulative. `scope` says the question is genuinely new: a different provider is
 * a different upstream, and a different viewport is a different set of tiles. `scope`
 * is the only way back from a dead provider, because while the canvas is degraded
 * there are no tiles left to fail or succeed.
 */
export function basemapRun(state, event) {
  switch (event?.type) {
    case 'loaded':
    case 'scope':
      return state.failures === 0 ? state : INITIAL_BASEMAP_RUN;
    case 'failed':
      return { failures: state.failures + 1 };
    default:
      return state;
  }
}

/** Whether the run has gone on long enough to stop asking for tiles. */
export function basemapLost(state, limit = TILE_FAILURE_LIMIT) {
  return (state?.failures ?? 0) >= limit;
}

/**
 * Why the canvas is on the plan-only grid, and whether asking again could help.
 *
 * The states are distinct and each needs to say something different, which is more
 * than a chip reading "Plan only" and a nested ternary in the render can carry. The
 * reason used to be shown only when the canvas would otherwise be empty, so a project
 * with facility geometry drawn and a provider that was not answering saw an
 * unexplained "Plan only" and nothing else — the only way to learn why was the network
 * panel.
 *
 * `retry` is true only for the failure case. A missing permission or a project with no
 * provider is not fixed by asking again, and a control that cannot succeed is worse
 * than no control.
 */
export function planOnlyState({ planOnlyReason = null, canRead = true, lost = false } = {}) {
  if (planOnlyReason) return { text: planOnlyReason, retry: false };
  if (!canRead) {
    return { text: 'The basemap needs map.read, which your role does not hold.', retry: false };
  }
  if (lost) return { text: 'The basemap provider could not be reached.', retry: true };
  return { text: 'No basemap provider is available for this project.', retry: false };
}

/** Longitude and latitude to world pixels at a zoom level. */
export function project({ lon, lat }, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const clampedLat = Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, lat));
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/** World pixels back to longitude and latitude, for panning. */
export function unproject({ x, y }, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat: Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, lat)) };
}

/**
 * Zoom is clamped to the provider's declared range: a provider that stops at 18
 * must not be asked for a level 20 tile the proxy would refuse.
 */
export function clampZoom(zoom, provider = null) {
  const min = provider?.minZoom ?? 0;
  const max = provider?.maxZoom ?? 22;
  const rounded = Number.isFinite(zoom) ? Math.round(zoom) : min;
  return Math.min(max, Math.max(min, rounded));
}

/**
 * A view brought inside the provider's zoom range, with its centre left where it is.
 *
 * The range has to hold for the *view* and not only for the tile request. `visibleTiles` clamps
 * internally and lays the tile grid out at the clamped level, while `facility-overlay.js`
 * projects the geometry at `view.zoom` — so a view above the provider's ceiling draws the site
 * at one scale over imagery at another, and the scale bar reads the wrong distance with it. The
 * two agree exactly when the view itself is in range, which is what this establishes.
 *
 * It returns the same object when nothing moves, so it is safe to use directly as a state
 * updater: a clamp that always allocated would re-render on every call.
 */
export function clampView(view, provider = null) {
  const zoom = clampZoom(view.zoom, provider);
  return zoom === view.zoom ? view : { ...view, zoom };
}

/**
 * The tiles covering a viewport centred on `view`. `left`/`top` are the tile's
 * offsets inside the viewport, so the renderer never repeats the projection.
 */
export function visibleTiles({ view, widthPx, heightPx, provider = null, tileSize = TILE_SIZE, maxTiles = MAX_VISIBLE_TILES }) {
  const zoom = clampZoom(view.zoom, provider);
  const world = project(view, zoom);
  const left = world.x - widthPx / 2;
  const top = world.y - heightPx / 2;
  const count = 2 ** zoom;
  const firstX = Math.floor(left / tileSize);
  const lastX = Math.floor((left + widthPx - 1) / tileSize);
  const firstY = Math.max(0, Math.floor(top / tileSize));
  const lastY = Math.min(count - 1, Math.floor((top + heightPx - 1) / tileSize));

  const tiles = [];
  let truncated = false;
  for (let y = firstY; y <= lastY; y += 1) {
    for (let x = firstX; x <= lastX; x += 1) {
      if (tiles.length >= maxTiles) {
        truncated = true;
        break;
      }
      // Longitude wraps around the antimeridian; latitude is clamped instead,
      // because there is no map above the pole.
      const wrappedX = ((x % count) + count) % count;
      tiles.push({
        key: `${zoom}/${x}/${y}`,
        z: zoom,
        x: wrappedX,
        y,
        left: Math.round(x * tileSize - left),
        top: Math.round(y * tileSize - top),
      });
    }
    if (truncated) break;
  }

  return { zoom, tiles, truncated, tileSize };
}

/**
 * Moves the view by a screen delta. Dragging right moves the map right, which
 * means the centre moves left.
 */
export function panBy(view, { dxPx, dyPx }) {
  const zoom = view.zoom;
  const centre = project(view, zoom);
  const moved = unproject({ x: centre.x - dxPx, y: centre.y - dyPx }, zoom);
  return { ...view, lon: moved.lon, lat: moved.lat };
}

/**
 * Zooms while keeping the point under `anchorPx` under it. Zooming about the
 * centre is the special case where the anchor is the centre of the viewport; a
 * wheel or pinch zooms about the cursor, which is what makes a map feel anchored
 * to the pointer rather than to the window.
 */
export function zoomAround(view, { nextZoom, anchorPx, widthPx, heightPx }) {
  const zoom = Number.isFinite(nextZoom) ? nextZoom : view.zoom;
  if (zoom === view.zoom) return { ...view, zoom };

  const world = project(view, view.zoom);
  const anchorGeo = unproject({ x: world.x - widthPx / 2 + anchorPx.x, y: world.y - heightPx / 2 + anchorPx.y }, view.zoom);

  const anchorAtNext = project(anchorGeo, zoom);
  const centre = unproject(
    { x: anchorAtNext.x - (anchorPx.x - widthPx / 2), y: anchorAtNext.y - (anchorPx.y - heightPx / 2) },
    zoom,
  );
  return { lon: centre.lon, lat: centre.lat, zoom };
}

/** One wheel notch, in pixels. A trackpad's many small deltas accumulate to it. */
export const WHEEL_STEP_PX = 40;
/** The most zoom levels one gesture may cross, so a flung wheel cannot teleport. */
export const MAX_WHEEL_STEPS = 2;

/**
 * Turns a wheel gesture into whole zoom steps. Positive `steps` means **zoom out**,
 * which is what scrolling down does on every map. A trackpad's deltas are small
 * and frequent, so the remainder carries to the next event; a delta large enough
 * to cross many levels at once is capped and its remainder discarded rather than
 * banked, because banking it would zoom again on the very next flick.
 */
export function wheelZoom({ deltaY, deltaMode = 0, accumulated = 0, threshold = WHEEL_STEP_PX, maxSteps = MAX_WHEEL_STEPS }) {
  // 0: pixels, 1: lines, 2: pages.
  const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  const total = accumulated + deltaY * scale;
  const raw = total > 0 ? Math.floor(total / threshold) : Math.ceil(total / threshold);
  if (Math.abs(raw) > maxSteps) {
    return { steps: Math.sign(raw) * maxSteps, accumulated: 0 };
  }
  return { steps: raw, accumulated: total - raw * threshold };
}

/** The proxied URL for one tile. The client never sees the provider's own URL. */
export function tileUrl({ projectId, providerId, z, x, y, style = null }) {
  const query = new URLSearchParams({ project_id: projectId });
  if (style) query.set('style', style);
  return `/api/v1/map/tiles/${encodeURIComponent(providerId)}/${z}/${x}/${y}?${query.toString()}`;
}

/**
 * Which provider the canvas draws with: the project's choice when it is still
 * available, otherwise the first available one. Nothing available means the
 * plan-only grid, which is a valid state, not an error.
 */
export function selectProvider(providers = [], settings = null) {
  const configured = settings?.providerId ? providers.find((item) => item.providerId === settings.providerId) : null;
  if (configured?.available) return configured;
  return providers.find((item) => item.available) ?? null;
}

export function isPlanOnly(provider) {
  return !provider || provider.available === false;
}

/** Attribution travels with the map: a canvas without it must not render tiles. */
export function attributionFor(provider) {
  if (!provider) return null;
  return { text: provider.attributionText ?? null, url: provider.attributionUrl ?? null };
}

/** A view centred on the given bounds, or the default world view. */
export function fitBounds(bounds, { widthPx, heightPx, provider = null } = {}) {
  const list = Array.isArray(bounds) ? bounds : [];
  if (list.length === 0) return { ...DEFAULT_VIEW };

  const lons = list.map((point) => point.lon);
  const lats = list.map((point) => point.lat);
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const centre = { lon: (west + east) / 2, lat: (south + north) / 2 };

  // The zoom whose world-pixel span of the bounds just fits the viewport.
  let zoom = provider?.maxZoom ?? 22;
  for (let candidate = zoom; candidate >= (provider?.minZoom ?? 0); candidate -= 1) {
    const a = project({ lon: west, lat: north }, candidate);
    const b = project({ lon: east, lat: south }, candidate);
    if (b.x - a.x <= widthPx * 0.9 && b.y - a.y <= heightPx * 0.9) {
      zoom = candidate;
      break;
    }
  }
  return { ...centre, zoom: clampZoom(zoom, provider) };
}

/** The Earth's circumference at the equator, in metres (WGS 84). */
const EQUATORIAL_CIRCUMFERENCE_M = 40_075_016.686;

/**
 * Ground metres per screen pixel at a latitude and zoom.
 *
 * Web Mercator is conformal, so the scale is true along the parallel at the
 * latitude it is computed for and expands away from it: a scale bar is only
 * honest about the latitude it was drawn at, which is why the bar uses the view
 * centre. `tileSize` is the projection's own constant, not a provider's declared
 * tile size — mixing the two would silently mislabel every distance.
 */
export function metersPerPixel({ lat = 0, zoom = 0, tileSize = TILE_SIZE } = {}) {
  const clamped = Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, lat));
  return (EQUATORIAL_CIRCUMFERENCE_M * Math.cos((clamped * Math.PI) / 180)) / (tileSize * 2 ** zoom);
}

/**
 * The largest 1, 2, or 5 times a power of ten that fits: the ladder a scale bar
 * is allowed to use, so it reads "200 m" rather than "183 m".
 */
export function niceDistance(maxMeters) {
  if (!Number.isFinite(maxMeters) || maxMeters <= 0) return 0;
  const base = 10 ** Math.floor(Math.log10(maxMeters));
  for (const factor of [5, 2, 1]) {
    // A tolerance keeps an exact power of ten (100, 1000) from falling to the
    // rung below it through floating-point error.
    if (factor * base <= maxMeters * (1 + 1e-9)) return factor * base;
  }
  return base;
}

/** SI only: D10 normalizes stored and displayed distances to metres. */
export function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return '';
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${Number.isInteger(km) ? km : Number(km.toFixed(1))} km`;
  }
  if (meters >= 1) return `${Number.isInteger(meters) ? meters : Number(meters.toFixed(1))} m`;
  return `${Number((meters * 100).toFixed(0)) / 100} m`;
}

/**
 * A scale bar for the viewport: the longest round distance that fits inside
 * `maxWidthPx`, and the pixel width that distance actually occupies. Returns
 * `null` rather than a zero-width bar when the projection degenerates at a pole.
 */
export function scaleBar({ lat = 0, zoom = 0, maxWidthPx = 120, tileSize = TILE_SIZE } = {}) {
  const perPixel = metersPerPixel({ lat, zoom, tileSize });
  if (!Number.isFinite(perPixel) || perPixel <= 0) return null;

  const distanceM = niceDistance(maxWidthPx * perPixel);
  if (distanceM <= 0) return null;

  // Rounding the width moves the bar by at most half a pixel, which is well
  // inside the tolerance of a scale that is itself an approximation.
  return { distanceM, widthPx: Math.max(1, Math.round(distanceM / perPixel)), label: formatDistance(distanceM) };
}


/**
 * Whether a key press ends the active map tool.
 *
 * The tools stay active while they are used — a footprint takes several vertices, an
 * interface takes a click and a form — so they need a way out that is not "finish the
 * shape". Escape is that way out, and it is the same gesture the composer and the shell's
 * menus use, so it needs no explaining.
 *
 * Only Escape, and only when a tool is running: an idle map must not swallow the key, or
 * it would stop working as a way to dismiss whatever else is open.
 */
export function endsActiveTool(event, { active = false } = {}) {
  return active === true && event?.key === 'Escape';
}

/** The command that started a tool mode, or null when the map is idle. */
export function activeToolCommand(mode) {
  if (mode === 'DRAW_FOOTPRINT') return 'draw_footprint';
  if (mode === 'PLACE_INTERFACE') return 'add_interface';
  return null;
}
