// Display contract only. Polygon topology is checked by PostGIS at the adapter;
// this conversion is not the rectangular rule engine's createRoomSnapshot.
export const MAX_ROOM_VIEW_POINTS = 4096;
export const MAX_ROOM_VIEW_RINGS = 64;

const unsupported = reason => Object.freeze({ status: 'UNSUPPORTED', reason, view: null });
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Translate an authoritative WGS84 UTM polygon to a local grid-metre frame.
 * Input coordinates remain unchanged; no geographic reprojection or rotation.
 */
export function localizeRoomBoundary({ geometry, crs, srid, valid, dimensions }) {
  const zone = Number.isInteger(srid) ? srid % 100 : 0;
  if (!((srid >= 32601 && srid <= 32660) || (srid >= 32701 && srid <= 32760))
    || zone < 1 || zone > 60 || crs !== `EPSG:${srid}`) return unsupported('CRS_UNSUPPORTED');
  if (dimensions !== 2) return unsupported('DIMENSION_UNSUPPORTED');
  if (valid !== true) return unsupported('INVALID_BOUNDARY');
  if (geometry?.type !== 'Polygon') return unsupported('GEOMETRY_TYPE_UNSUPPORTED');
  const rings = geometry.coordinates;
  if (!Array.isArray(rings) || rings.length === 0) return unsupported('INVALID_BOUNDARY');
  if (rings.length > MAX_ROOM_VIEW_RINGS) return unsupported('GEOMETRY_TOO_COMPLEX');
  let pointCount = 0;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) return unsupported('INVALID_BOUNDARY');
    pointCount += ring.length;
    if (pointCount > MAX_ROOM_VIEW_POINTS) return unsupported('GEOMETRY_TOO_COMPLEX');
    for (const point of ring) {
      if (!Array.isArray(point) || point.length !== 2
        || !point.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9)) {
        return unsupported('INVALID_BOUNDARY');
      }
    }
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) return unsupported('INVALID_BOUNDARY');
  }
  const minX = Math.min(...rings[0].map(point => point[0]));
  const minY = Math.min(...rings[0].map(point => point[1]));
  const width = Math.max(...rings[0].map(point => point[0])) - minX;
  const height = Math.max(...rings[0].map(point => point[1])) - minY;
  if (!(width > 0 && height > 0) || width > 10000 || height > 10000) return unsupported('EXTENT_UNSUPPORTED');
  const coordinates = rings.map(ring => ring.map(([x, y]) => [x - minX, y - minY]));
  const areas = coordinates.map(ring => Math.abs(ring.slice(1).reduce((sum, point, index) =>
    sum + ring[index][0] * point[1] - point[0] * ring[index][1], 0)) / 2);
  const areaM2 = areas[0] - areas.slice(1).reduce((sum, area) => sum + area, 0);
  if (!(areaM2 > 0) || areas.some(area => !(area > 0))) return unsupported('INVALID_BOUNDARY');
  return freeze({ status: 'AVAILABLE', reason: null, view: {
    unit: 'm', frame: 'ROOM_LOCAL', transform: 'TRANSLATE_ONLY',
    sourceCrs: crs, originProjectedM: [minX, minY],
    originDescription: 'Minimum easting and northing of the outer ring; the origin may lie outside a concave room.',
    axes: { x: 'GRID_EAST', y: 'GRID_NORTH' },
    boundaryLocalM: { type: 'Polygon', coordinates },
    extentM: { width, height }, areaM2, interiorRingCount: rings.length - 1,
    obstacleCoverage: 'UNKNOWN',
  } });
}
