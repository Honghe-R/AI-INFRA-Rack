export const CANVAS = Object.freeze({ width: 800, height: 440 });
export function fitRoom(extent) {
  return { cx: extent.width / 2, cy: extent.height / 2,
    scale: Math.min((CANVAS.width - 120) / extent.width, (CANVAS.height - 120) / extent.height) };
}
export function toScreen([x, y], camera) {
  return [CANVAS.width / 2 + (x - camera.cx) * camera.scale, CANVAS.height / 2 - (y - camera.cy) * camera.scale];
}
export function toLocal([x, y], camera) {
  return [camera.cx + (x - CANVAS.width / 2) / camera.scale, camera.cy - (y - CANVAS.height / 2) / camera.scale];
}
export function panCamera(camera, dx, dy) {
  return { ...camera, cx: camera.cx - dx / camera.scale, cy: camera.cy + dy / camera.scale };
}
export function zoomCamera(camera, factor, fitScale, anchor = [CANVAS.width / 2, CANVAS.height / 2]) {
  const scale = Math.min(fitScale * 32, Math.max(fitScale / 4, camera.scale * factor));
  const before = toLocal(anchor, camera);
  const after = toLocal(anchor, { ...camera, scale });
  return { scale, cx: camera.cx + before[0] - after[0], cy: camera.cy + before[1] - after[1] };
}
export function niceMetres(target) {
  const base = 10 ** Math.floor(Math.log10(target));
  return [10, 5, 2, 1].find(value => value * base <= target) * base;
}
export function boundaryPath(boundary, camera) {
  return boundary.coordinates.map(ring => ring.map((point, index) =>
    `${index === 0 ? 'M' : 'L'}${toScreen(point, camera).join(' ')}`).join(' ') + ' Z').join(' ');
}
export function gridLines(camera) {
  const stepM = niceMetres(50 / camera.scale);
  const [left, top] = toLocal([0, 0], camera);
  const [right, bottom] = toLocal([CANVAS.width, CANVAS.height], camera);
  const lines = [];
  // Bounded by viewport spacing, independent of the room's coordinate magnitude.
  for (let i = Math.ceil(left / stepM); i <= Math.floor(right / stepM) && lines.length < 100; i++) {
    const x = toScreen([i * stepM, 0], camera)[0]; lines.push([x, 0, x, CANVAS.height]);
  }
  for (let i = Math.ceil(bottom / stepM); i <= Math.floor(top / stepM) && lines.length < 200; i++) {
    const y = toScreen([0, i * stepM], camera)[1]; lines.push([0, y, CANVAS.width, y]);
  }
  return { stepM, lines };
}

export const ROOM_VIEW_REASONS = Object.freeze({
  FACILITY_SOURCE_CHANGED: 'Facility changed after this plan was created. Historical geometry was not saved; the bound floorplan cannot be reconstructed. Source rebinding is pending.',
  BOUNDARY_MISSING: 'This HALL has no stored floor or room boundary.',
  BOUNDARY_AMBIGUOUS: 'This HALL has multiple candidate boundaries. A boundary must be selected explicitly before a floorplan can be shown.',
  CRS_UNSUPPORTED: 'This view currently supports matching WGS 84 UTM metre projections (EPSG:32601–32660 / 32701–32760). No unit or CRS fallback was applied.',
  DIMENSION_UNSUPPORTED: 'Only two-dimensional boundaries are supported.',
  INVALID_BOUNDARY: 'The stored boundary is invalid or empty. No replacement rectangle was inferred.',
  GEOMETRY_TYPE_UNSUPPORTED: 'Only a single Polygon, including its interior rings, is supported.',
  GEOMETRY_TOO_COMPLEX: 'This boundary exceeds the view limit of 4096 points or 64 rings.',
  EXTENT_UNSUPPORTED: 'Boundary extents must be positive and no larger than 10 km on either axis.',
});
