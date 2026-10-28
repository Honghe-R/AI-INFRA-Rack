import { record, fail, text, uuid } from './input.js';
export const EMPTY_SPATIAL_CONSTRAINTS = Object.freeze({
  obstacleCoverage: 'UNKNOWN',
  source: Object.freeze({ kind: 'ASSUMED', reference: 'Planning inputs not recorded.' }),
  obstacles: Object.freeze([]),
  clearance: null,
});
function number(value, field, min, max) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    fail(field, `must be a finite number ≥ ${min} and ≤ ${max}`);
  return value;
}
function distance(value,field) {
  number(value,field,0,10);
  if(value>0 && value<.001) fail(field,'must be zero or at least 0.001 m');
  return value;
}
/** Rectangles are deliberately bounded planning assumptions in the fixed local frame. */
export function normalizeSpatialConstraints(input) {
  record(input, 'constraints', new Set(['obstacleCoverage', 'source', 'obstacles', 'clearance']));
  if (!['UNKNOWN', 'DECLARED_COMPLETE'].includes(input.obstacleCoverage))
    fail('obstacleCoverage', 'must be UNKNOWN or DECLARED_COMPLETE');
  record(input.source, 'source', new Set(['kind', 'reference']));
  if (input.source.kind !== 'ASSUMED')
    fail('source.kind', 'this editor accepts ASSUMED planning inputs only');
  const source = Object.freeze({
    kind: 'ASSUMED',
    reference: text(input.source.reference, 'source.reference', 512),
  });
  if (!Array.isArray(input.obstacles) || input.obstacles.length > 64)
    fail('obstacles', 'must contain at most 64 rectangles');
  const ids = new Set();
  const obstacles = input.obstacles.map((item, i) => {
    record(item, `obstacles[${i}]`, new Set(['obstacleId', 'name', 'xM', 'yM', 'widthM', 'depthM']));
    const obstacleId = uuid(item.obstacleId, 'obstacleId');
    if (ids.has(obstacleId)) fail('obstacleId', 'must be unique');
    ids.add(obstacleId);
    return Object.freeze({
      obstacleId,
      name: text(item.name, 'obstacle.name'),
      xM: number(item.xM, 'obstacle.xM', -10000, 10000),
      yM: number(item.yM, 'obstacle.yM', -10000, 10000),
      widthM: number(item.widthM, 'obstacle.widthM', 0.001, 10000),
      depthM: number(item.depthM, 'obstacle.depthM', 0.001, 10000),
    });
  });
  let clearance = null;
  if (input.clearance !== null) {
    record(input.clearance, 'clearance', new Set(['frontM', 'rearM']));
    clearance = Object.freeze({
      frontM: distance(input.clearance.frontM, 'clearance.frontM'),
      rearM: distance(input.clearance.rearM, 'clearance.rearM'),
    });
  }
  return Object.freeze({
    obstacleCoverage: input.obstacleCoverage,
    source,
    obstacles: Object.freeze(obstacles),
    clearance,
  });
}
export function localRectangle(xM, yM, widthM, depthM) {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [xM - widthM / 2, yM - depthM / 2],
        [xM + widthM / 2, yM - depthM / 2],
        [xM + widthM / 2, yM + depthM / 2],
        [xM - widthM / 2, yM + depthM / 2],
        [xM - widthM / 2, yM - depthM / 2],
      ],
    ],
  };
}
/** Front is -local Y. Bands may be shared; only rack bodies/obstacles obstruct them. */
export function rackClearanceBands(placement, model, clearance) {
  if (!clearance) return [];
  const [cos, sin] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ][placement.rotationDeg / 90];
  return [
    ['FRONT', clearance.frontM, -1],
    ['REAR', clearance.rearM, 1],
  ]
    .filter(([, distance]) => distance > 0)
    .map(([side, distance, sign]) => {
      const y0 = sign < 0 ? -model.depthM / 2 - distance : model.depthM / 2;
      const y1 = sign < 0 ? -model.depthM / 2 : model.depthM / 2 + distance;
      const corners = [
        [-model.widthM / 2, y0],
        [model.widthM / 2, y0],
        [model.widthM / 2, y1],
        [-model.widthM / 2, y1],
      ].map(([x, y]) => [placement.xM + x * cos - y * sin, placement.yM + x * sin + y * cos]);
      return {
        rackId: placement.rackId,
        side,
        geometry: { type: 'Polygon', coordinates: [[...corners, corners[0]]] },
      };
    });
}
