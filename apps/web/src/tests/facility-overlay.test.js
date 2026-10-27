import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  OVERLAY_LAYERS,
  anchorFor,
  boundsOf,
  labelsFor,
  layerCounts,
  layerOf,
  overlayFor,
  pathFor,
  positionsOf,
  screenGeometry,
  unprojectScreen,
} from '../map/facility-overlay.js';

const VIEW = { lon: -77.49, lat: 39.043, zoom: 16 };
const SIZE = { widthPx: 800, heightPx: 600 };

const polygon = (ring) => ({ type: 'Polygon', coordinates: [[...ring, ring[0]]] });

const BUILDING = {
  geometryId: 'g-building',
  entityId: 'e-building',
  entityType: 'BUILDING',
  role: 'FOOTPRINT',
  displayName: 'Data Centre A',
  geojson4326: polygon([
    [-77.4916, 39.0429],
    [-77.4896, 39.0429],
    [-77.4896, 39.0441],
    [-77.4916, 39.0441],
  ]),
};

const SITE = {
  geometryId: 'g-site',
  entityId: 'e-site',
  entityType: 'SITE',
  role: 'BOUNDARY',
  displayName: 'Northern DC Campus',
  geojson4326: polygon([
    [-77.4925, 39.0425],
    [-77.4866, 39.0425],
    [-77.4866, 39.0455],
    [-77.4925, 39.0455],
  ]),
};

const ENTRANCE = {
  geometryId: 'g-entrance',
  entityId: 'e-entrance',
  entityType: 'UTILITY_INTERFACE',
  role: 'CONNECTION_POINT',
  displayName: 'Power Interface A',
  geojson4326: { type: 'Point', coordinates: [-77.4919, 39.0435] },
};

const HEIGHT_LIMIT = {
  geometryId: 'g-constraint',
  entityId: 'e-constraint',
  entityType: 'SPATIAL_CONSTRAINT',
  role: 'CONSTRAINT_AREA',
  displayName: 'Height limit',
  geojson4326: polygon([
    [-77.4916, 39.0429],
    [-77.4896, 39.0429],
    [-77.4896, 39.0441],
  ]),
};

const FEATURES = [SITE, BUILDING, ENTRANCE, HEIGHT_LIMIT];

test('each entity type lands in exactly one draw layer', () => {
  assert.equal(layerOf(SITE), 'site');
  assert.equal(layerOf({ entityType: 'PARCEL' }), 'site');
  assert.equal(layerOf(BUILDING), 'buildings');
  assert.equal(layerOf({ entityType: 'HALL' }), 'spaces');
  assert.equal(layerOf({ entityType: 'SUPPORT_SPACE' }), 'spaces');
  assert.equal(layerOf(ENTRANCE), 'utilities');
  assert.equal(layerOf(HEIGHT_LIMIT), 'constraints');
  assert.equal(layerOf({ entityType: 'SOMETHING_NEW' }), 'utilities', 'an unknown type is still drawn');
});

test('a point at the view centre projects to the centre of the viewport', () => {
  const geometry = screenGeometry({ type: 'Point', coordinates: [VIEW.lon, VIEW.lat] }, { view: VIEW, ...SIZE });
  assert.equal(geometry.kind, 'POINT');
  assert.equal(geometry.points.length, 1);
  assert.equal(geometry.points[0].x, SIZE.widthPx / 2);
  assert.equal(geometry.points[0].y, SIZE.heightPx / 2);
});

test('east is right and north is up, matching the tile origin', () => {
  const centre = screenGeometry({ type: 'Point', coordinates: [VIEW.lon, VIEW.lat] }, { view: VIEW, ...SIZE });
  const east = screenGeometry({ type: 'Point', coordinates: [VIEW.lon + 0.005, VIEW.lat] }, { view: VIEW, ...SIZE });
  const north = screenGeometry({ type: 'Point', coordinates: [VIEW.lon, VIEW.lat + 0.005] }, { view: VIEW, ...SIZE });
  assert.ok(east.points[0].x > centre.points[0].x, 'a point east of centre draws to the right');
  assert.ok(north.points[0].y < centre.points[0].y, 'a point north of centre draws above');
});

test('a polygon keeps its rings and closes the path', () => {
  const geometry = screenGeometry(SITE.geojson4326, { view: VIEW, ...SIZE });
  assert.equal(geometry.kind, 'POLYGON');
  assert.equal(geometry.polygons.length, 1);
  assert.equal(geometry.polygons[0][0].length, 5, 'four corners plus the closing position');

  const path = pathFor(geometry);
  assert.match(path, /^M [\d.-]+ [\d.-]+ L /);
  assert.match(path, / Z$/);
});

test('a multi polygon renders one subpath per polygon', () => {
  const geometry = screenGeometry(
    { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1]]], [[[2, 2], [3, 2], [3, 3]]]] },
    { view: VIEW, ...SIZE },
  );
  assert.equal(geometry.kind, 'POLYGON');
  assert.equal(geometry.polygons.length, 2);
  assert.equal(pathFor(geometry).match(/Z/g).length, 2);
});

test('positionsOf flattens every geometry shape, and boundsOf spans the records', () => {
  assert.deepEqual(positionsOf({ type: 'Point', coordinates: [1, 2] }), [{ lon: 1, lat: 2 }]);
  assert.equal(positionsOf(SITE.geojson4326).length, 5);

  const bounds = boundsOf(FEATURES);
  assert.equal(bounds.length > 0, true);
  const lons = bounds.map((point) => point.lon);
  assert.equal(Math.min(...lons), -77.4925);
  assert.equal(Math.max(...lons), -77.4866);
});

test('a record with no geometry contributes no bounds', () => {
  assert.deepEqual(boundsOf([{ geometryId: 'x', geojson4326: null }]), []);
});

test('the draw list is ordered bottom to top by layer, not by input order', () => {
  const shapes = overlayFor(FEATURES, { view: VIEW, ...SIZE });
  const order = shapes.map((shape) => shape.layer);
  const expected = OVERLAY_LAYERS.map((layer) => layer.id).filter((id) => order.includes(id));
  assert.deepEqual(order, expected);
  // Constraints sit under the site, buildings over spaces: input order is ignored.
  assert.equal(order[0], 'constraints');
  assert.equal(order[order.length - 1], 'utilities');
});

test('a hidden layer is filtered before anything is projected', () => {
  const shapes = overlayFor(FEATURES, { view: VIEW, ...SIZE, visibleLayers: ['buildings'] });
  assert.deepEqual(shapes.map((shape) => shape.entityType), ['BUILDING']);
});

test('selection is carried on one shape and never invented', () => {
  const shapes = overlayFor(FEATURES, { view: VIEW, ...SIZE, selectedGeometryId: 'g-building' });
  assert.equal(shapes.filter((shape) => shape.selected).length, 1);
  assert.equal(shapes.find((shape) => shape.selected).geometryId, 'g-building');
});

test('a label anchors inside its shape', () => {
  const geometry = screenGeometry(SITE.geojson4326, { view: VIEW, ...SIZE });
  const anchor = anchorFor(geometry);
  const xs = geometry.polygons[0][0].map((point) => point.x);
  const ys = geometry.polygons[0][0].map((point) => point.y);
  assert.ok(anchor.x >= Math.min(...xs) && anchor.x <= Math.max(...xs));
  assert.ok(anchor.y >= Math.min(...ys) && anchor.y <= Math.max(...ys));

  const pointAnchor = anchorFor(screenGeometry(ENTRANCE.geojson4326, { view: VIEW, ...SIZE }));
  assert.equal(typeof pointAnchor.x, 'number');
});

test('layer counts state what is on the map, including empty layers', () => {
  const counts = layerCounts(FEATURES);
  assert.equal(counts.site, 1);
  assert.equal(counts.buildings, 1);
  assert.equal(counts.spaces, 0);
  assert.equal(counts.utilities, 1);
  assert.equal(counts.constraints, 1);
});

test('an unsupported geometry type is skipped rather than drawn wrong', () => {
  assert.equal(screenGeometry({ type: 'GeometryCollection', coordinates: [] }, { view: VIEW, ...SIZE }), null);
  assert.equal(pathFor(null), null);
  assert.equal(pathFor({ kind: 'POINT', points: [] }), null);
});

test('labels appear only at a working zoom, and only for named layers', () => {
  const shapes = overlayFor(FEATURES, { view: VIEW, ...SIZE });
  const far = labelsFor(shapes, { zoom: 5 });
  assert.deepEqual(far, [], 'a label larger than the building is not drawn');

  const close = labelsFor(shapes, { zoom: 15 });
  assert.deepEqual(close.map((shape) => shape.entityType).sort(), ['BUILDING', 'SITE']);
  assert.equal(close.some((shape) => shape.layer === 'utilities'), false, 'a point carries no name on the map');
});

test('a shared anchor gets one label, and the selection wins that spot', () => {
  // A parcel boundary that shares the site's ring: both centroids coincide.
  const shared = overlayFor(
    [
      SITE,
      { ...SITE, geometryId: 'g-parcel', entityId: 'e-parcel', entityType: 'PARCEL', displayName: 'Parcel 1' },
    ],
    { view: VIEW, ...SIZE },
  );
  const labels = labelsFor(shared, { zoom: 15 });
  assert.equal(labels.length, 1, 'two names must not stack on one anchor');
  assert.equal(labels[0].displayName, 'Northern DC Campus', 'the first drawn wins by default');

  const selected = labelsFor(
    overlayFor(
      [
        SITE,
        { ...SITE, geometryId: 'g-parcel', entityId: 'e-parcel', entityType: 'PARCEL', displayName: 'Parcel 1' },
      ],
      { view: VIEW, ...SIZE, selectedGeometryId: 'g-parcel' },
    ),
    { zoom: 15 },
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].displayName, 'Parcel 1');
});

test('a selection is labelled even when the zoom is too far out for names', () => {
  const shapes = overlayFor(FEATURES, { view: VIEW, ...SIZE, selectedGeometryId: 'g-building' });
  const labels = labelsFor(shapes, { zoom: 4 });
  assert.deepEqual(labels.map((shape) => shape.geometryId), ['g-building']);
});

/* ------------------------------------------------- pointer to coordinate */

test('a click position projects back to the coordinate it came from', () => {
  // Drawing a footprint means turning a pointer position into a coordinate, and the
  // inverse has to agree with the forward projection or a drawn shape lands somewhere
  // else than the same shape read back from the server.
  const view = { lon: -77.49, lat: 39.043, zoom: 16 };
  const widthPx = 800;
  const heightPx = 600;
  const original = [-77.488, 39.044];

  const screen = screenGeometry({ type: 'Point', coordinates: original }, { view, widthPx, heightPx }).points[0];
  const roundTripped = unprojectScreen({ xPx: screen.x, yPx: screen.y }, { view, widthPx, heightPx });

  assert.ok(Math.abs(roundTripped[0] - original[0]) < 1e-6, `longitude drifted to ${roundTripped[0]}`);
  assert.ok(Math.abs(roundTripped[1] - original[1]) < 1e-6, `latitude drifted to ${roundTripped[1]}`);
});

test('the inverse follows the view, so a pan moves the drawn point with the map', () => {
  const widthPx = 800;
  const heightPx = 600;
  const panned = { lon: -77.48, lat: 39.05, zoom: 16 };
  const before = screenGeometry({ type: 'Point', coordinates: [-77.488, 39.044] }, { view: { lon: -77.49, lat: 39.043, zoom: 16 }, widthPx, heightPx }).points[0];
  const after = screenGeometry({ type: 'Point', coordinates: [-77.488, 39.044] }, { view: panned, widthPx, heightPx }).points[0];

  const fromBefore = unprojectScreen({ xPx: before.x, yPx: before.y }, { view: { lon: -77.49, lat: 39.043, zoom: 16 }, widthPx, heightPx });
  const fromAfter = unprojectScreen({ xPx: after.x, yPx: after.y }, { view: panned, widthPx, heightPx });

  assert.ok(Math.abs(fromBefore[0] - fromAfter[0]) < 1e-6);
  assert.ok(Math.abs(fromBefore[1] - fromAfter[1]) < 1e-6);
});
