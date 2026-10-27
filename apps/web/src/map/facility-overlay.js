/**
 * Facility overlay geometry.
 *
 * Turns the normalized geometry records the API returns (WGS 84 GeoJSON) into
 * screen-space shapes the canvas can draw, and keeps that maths free of React and
 * the DOM so it can be asserted without a browser — the same reason
 * `canvas-state.js` is pure (implementation plan T7b).
 *
 * It shares the viewport origin with the tile renderer: `screen = world - (centre
 * - viewport / 2)`, exactly how `visibleTiles` places a tile. Anything else would
 * make the overlay drift away from the basemap as you pan.
 */
import { project, unproject } from './canvas-state.js';
import { editFor } from './staged-geometry.js';

/** Draw order, bottom to top. A later layer paints over an earlier one. */
export const OVERLAY_LAYERS = Object.freeze([
  { id: 'constraints', label: 'Constraints' },
  { id: 'site', label: 'Site & parcel' },
  { id: 'spaces', label: 'Floors, halls & spaces' },
  { id: 'buildings', label: 'Buildings' },
  { id: 'utilities', label: 'Utilities' },
]);

const LAYER_BY_ENTITY_TYPE = Object.freeze({
  SITE: 'site',
  PARCEL: 'site',
  EQUIPMENT_YARD: 'site',
  RESERVED_AREA: 'site',
  BUILDING: 'buildings',
  FLOOR: 'spaces',
  HALL: 'spaces',
  SUPPORT_SPACE: 'spaces',
  UTILITY_SOURCE: 'utilities',
  UTILITY_INTERFACE: 'utilities',
  UTILITY_ROUTE: 'utilities',
  SPATIAL_CONSTRAINT: 'constraints',
  ENVIRONMENTAL_CONSTRAINT: 'constraints',
});

/** The layer a record belongs to; unknown types are drawn with the utilities. */
export function layerOf(feature) {
  return LAYER_BY_ENTITY_TYPE[feature?.entityType] ?? 'utilities';
}

/** The origin `visibleTiles` uses, so overlay and tiles cannot disagree. */
function originOf(view, widthPx, heightPx) {
  const world = project(view, view.zoom);
  return { left: world.x - widthPx / 2, top: world.y - heightPx / 2 };
}

/**
 * The inverse of `screenGeometry`: a click position back to `[lon, lat]`.
 *
 * It lives beside the forward projection on purpose. Drawing a footprint means turning a
 * pointer position into a coordinate, and a second implementation of the origin would be
 * a second answer to where the map is — off by whatever the two disagreed about.
 */
export function unprojectScreen({ xPx, yPx }, { view, widthPx, heightPx }) {
  const origin = originOf(view, widthPx, heightPx);
  const point = unproject({ x: xPx + origin.left, y: yPx + origin.top }, view.zoom);
  return [point.lon, point.lat];
}

const round = (value) => Math.round(value * 10) / 10;

/**
 * Every `[lon, lat]` position in a GeoJSON geometry, flattened. Used for the
 * initial fit, so it must not care which geometry type it is handed.
 */
export function positionsOf(geojson) {
  const positions = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      positions.push({ lon: node[0], lat: node[1] });
      return;
    }
    for (const child of node) walk(child);
  };
  if (geojson && geojson.coordinates) walk(geojson.coordinates);
  return positions;
}

/**
 * The bounds of a record set, as the `{lon, lat}` list `fitBounds` consumes. A
 * record with no usable geometry contributes nothing rather than a zero point at
 * the equator.
 */
export function boundsOf(features = []) {
  const positions = [];
  for (const feature of features) {
    for (const position of positionsOf(feature?.geojson4326)) positions.push(position);
  }
  return positions;
}

/**
 * One geometry record in screen space. Coordinates are projected per zoom level
 * once, then translated; a polygon keeps its rings so holes still render.
 */
export function screenGeometry(geojson, { view, widthPx, heightPx }) {
  if (!geojson || !geojson.type) return null;
  const origin = originOf(view, widthPx, heightPx);
  // Coordinates are relative to the viewport, so the projection happens once here
  // and the origin subtraction is all that follows.
  const flat = (point) => {
    const world = project({ lon: point[0], lat: point[1] }, view.zoom);
    return { x: round(world.x - origin.left), y: round(world.y - origin.top) };
  };

  const toLine = (positions) => positions.map(flat);
  const toRing = (ring) => ring.map(flat);

  switch (geojson.type) {
    case 'Point':
      return { kind: 'POINT', points: [flat(geojson.coordinates)] };
    case 'MultiPoint':
      return { kind: 'POINT', points: geojson.coordinates.map(flat) };
    case 'LineString':
      return { kind: 'LINESTRING', lines: [toLine(geojson.coordinates)] };
    case 'MultiLineString':
      return { kind: 'LINESTRING', lines: geojson.coordinates.map(toLine) };
    case 'Polygon':
      return { kind: 'POLYGON', polygons: [geojson.coordinates.map(toRing)] };
    case 'MultiPolygon':
      return { kind: 'POLYGON', polygons: geojson.coordinates.map((polygon) => polygon.map(toRing)) };
    default:
      return null;
  }
}

/** An SVG path for a projected polygon or line; `null` for a point or an empty shape. */
export function pathFor(geometry) {
  if (!geometry) return null;
  const line = (points) => points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  if (geometry.kind === 'POLYGON') {
    const parts = geometry.polygons
      .flatMap((polygon) => polygon.map((ring) => (ring.length < 3 ? null : `${line(ring)} Z`)))
      .filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }
  if (geometry.kind === 'LINESTRING') {
    const parts = geometry.lines.filter((points) => points.length >= 2).map(line);
    return parts.length ? parts.join(' ') : null;
  }
  return null;
}

/** A stable centre for a label: the centroid of the first ring, or the point. */
export function anchorFor(geometry) {
  if (!geometry) return null;
  if (geometry.kind === 'POINT') return geometry.points[0] ?? null;
  const rings = geometry.kind === 'POLYGON' ? geometry.polygons[0] : [geometry.lines[0]];
  const ring = rings?.[0];
  if (!ring || ring.length === 0) return null;
  const total = ring.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  return { x: round(total.x / ring.length), y: round(total.y / ring.length) };
}

/**
 * The draw list. Layers are emitted in `OVERLAY_LAYERS` order so a building never
 * paints under the parcel it sits in, and hidden layers are filtered before any
 * projection happens.
 */
/**
 * The shift, in screen pixels, that a shape is being dragged by.
 *
 * The object follows the pointer while a move is being made, and the pointer is the only thing
 * that knows where it is. The screen is the right place for it: a pixel delta is a pixel delta
 * whatever the zoom, and the split is exact — the shape moves under the pointer, and whether
 * the release commits anything is decided in world coordinates from the same delta.
 *
 * `translate` is null at rest, so a shape that is not being moved is projected once and not
 * wrapped in a group at all.
 */
export function overlayFor(
  features = [],
  { view, widthPx, heightPx, visibleLayers = null, selectedGeometryId = null, moving = null, edits = null } = {},
) {
  const wanted = visibleLayers ? new Set(visibleLayers) : null;
  const shapes = [];

  for (const feature of features) {
    const layer = layerOf(feature);
    if (wanted && !wanted.has(layer)) continue;
    // A staged edit is what the revision will look like, so it is what gets drawn — at the
    // coordinates the change set intends rather than the ones the revision still holds. The
    // layer is taken from the feature, so the edit does not have to know which layer it is in.
    const edit = editFor(edits, feature);
    const geometry = screenGeometry(edit ?? feature.geojson4326, { view, widthPx, heightPx });
    if (!geometry) continue;
    const carried = moving && moving.entityId === feature.entityId ? `translate(${moving.dxPx} ${moving.dyPx})` : null;
    shapes.push({
      geometryId: feature.geometryId,
      entityId: feature.entityId,
      entityType: feature.entityType,
      role: feature.role,
      layer,
      displayName: feature.displayName ?? null,
      selected: selectedGeometryId !== null && feature.geometryId === selectedGeometryId,
      edited: Boolean(edit),
      geometry,
      path: pathFor(geometry),
      anchor: anchorFor(geometry),
      translate: carried,
    });
  }

  return OVERLAY_LAYERS.flatMap((layer) => shapes.filter((shape) => shape.layer === layer.id));
}

/** Per-layer record counts, for a legend that states what is drawn. */
export function layerCounts(features = []) {
  const counts = {};
  for (const layer of OVERLAY_LAYERS) counts[layer.id] = 0;
  for (const feature of features) {
    const layer = layerOf(feature);
    counts[layer] = (counts[layer] ?? 0) + 1;
  }
  return counts;
}

/**
 * Which shapes get a name drawn on the map.
 *
 * Below `minZoom` a label is larger than the building it names, so only the
 * selection is labelled. Site and parcel boundaries frequently share a ring, and
 * a shared centroid would stack two names on top of each other; one label per
 * anchor is kept, and the selected shape wins that spot. Selection is checked
 * before zoom because it is a direct answer to what the user clicked.
 */
export function labelsFor(shapes = [], { zoom = 0, minZoom = 14 } = {}) {
  const chosen = new Map();
  for (const shape of shapes) {
    if (!shape.anchor) continue;
    const named = shape.layer === 'site' || shape.layer === 'buildings';
    if (!shape.selected && !(named && zoom >= minZoom)) continue;

    const key = `${Math.round(shape.anchor.x)}:${Math.round(shape.anchor.y)}`;
    const existing = chosen.get(key);
    if (!existing || (shape.selected && !existing.selected)) chosen.set(key, shape);
  }
  return [...chosen.values()];
}
