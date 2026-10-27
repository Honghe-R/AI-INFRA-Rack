import { RackInputError, createRackModel, createRackPlacement } from './model.js';

/**
 * Counter-clockwise rotation around the rack centre. At 0 degrees width runs
 * along +X, depth along +Y and the front is the local -Y edge. Return local
 * Cartesian coordinates only: these are not GeoJSON/WGS 84 coordinates.
 * Corners start at the local front-left/front-right edge before rotation;
 * frontEdgeM retains which side is the front for future clearance rules.
 */
export function rackFootprint(modelInput, placementInput) {
  const model = createRackModel(modelInput);
  const placement = createRackPlacement(placementInput);
  if (model.modelId !== placement.modelId) {
    throw new RackInputError('modelId', 'placement references a different rack model');
  }
  // Exact quarter-turn coefficients avoid trigonometric slivers at right angles.
  const [cos, sin] = [[1, 0], [0, 1], [-1, 0], [0, -1]][placement.rotationDeg / 90];
  const halfWidth = model.widthM / 2;
  const halfDepth = model.depthM / 2;
  const corners = [
    [-halfWidth, -halfDepth], [halfWidth, -halfDepth],
    [halfWidth, halfDepth], [-halfWidth, halfDepth],
  ].map(([x, y]) => {
    const point = [placement.xM + x * cos - y * sin, placement.yM + x * sin + y * cos];
    if (point.some((value) => !Number.isFinite(value))) {
      throw new RackInputError('footprint', 'coordinates exceed the finite numeric range');
    }
    return Object.freeze(point.map((value) => Object.is(value, -0) ? 0 : value));
  });
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  if (corners[0].every((value, index) => value === corners[1][index])
      || corners[1].every((value, index) => value === corners[2][index])) {
    throw new RackInputError('footprint', 'dimensions are lost at this coordinate precision');
  }
  return Object.freeze({
    unit: 'm',
    frame: 'ROOM_LOCAL',
    cornersM: Object.freeze(corners),
    frontEdgeM: Object.freeze([corners[0], corners[1]]),
    boundsM: Object.freeze({ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }),
  });
}
