import { fail, record, uuid, text } from './input.js';
import { CONTRACT_VERSION } from './model.js';
import { createFacilityInputReference } from './plan.js';

export const MAX_ROOM_OBSTACLES = 256;
const ROOM_FIELDS = new Set([
  'contractVersion', 'snapshotId', 'facilityInput', 'name', 'unit', 'frame',
  'originDescription', 'boundaryM', 'obstacleCoverage', 'obstacles', 'source',
]);
const BOUNDS_FIELDS = new Set(['minX', 'minY', 'maxX', 'maxY']);
const OBSTACLE_FIELDS = new Set(['obstacleId', 'name', 'boundsM']);
const SOURCE_FIELDS = new Set(['kind', 'reference']);

function rectangle(input, field) {
  record(input, field, BOUNDS_FIELDS);
  for (const key of BOUNDS_FIELDS) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) {
      fail(`${field}.${key}`, 'must be a finite number in metres');
    }
  }
  if (!(input.maxX > input.minX) || !Number.isFinite(input.maxX - input.minX)) {
    fail(field, 'X extent must be positive and finite');
  }
  if (!(input.maxY > input.minY) || !Number.isFinite(input.maxY - input.minY)) {
    fail(field, 'Y extent must be positive and finite');
  }
  return Object.freeze(Object.fromEntries([...BOUNDS_FIELDS].map(key => [key, Object.is(input[key], -0) ? 0 : input[key]])));
}

export function containsBounds(outer, inner) {
  return inner.minX >= outer.minX && inner.minY >= outer.minY
    && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY;
}

/** Explicit rectangular local input; never derive a room rectangle from a polygon's bounds. */
export function createRoomSnapshot(input) {
  record(input, 'room', ROOM_FIELDS);
  if (input.contractVersion !== CONTRACT_VERSION) fail('contractVersion', 'unsupported room contract version');
  if (input.unit !== 'm') fail('unit', 'must be m; no implicit unit conversion');
  if (input.frame !== 'ROOM_LOCAL') fail('frame', 'must be ROOM_LOCAL; no implicit CRS conversion');
  if (!['COMPLETE', 'UNKNOWN'].includes(input.obstacleCoverage)) {
    fail('obstacleCoverage', 'must explicitly be COMPLETE or UNKNOWN');
  }
  if (!Array.isArray(input.obstacles) || input.obstacles.length > MAX_ROOM_OBSTACLES) {
    fail('obstacles', `must be an explicit array of at most ${MAX_ROOM_OBSTACLES} obstacles`);
  }
  const boundaryM = rectangle(input.boundaryM, 'boundaryM');
  const ids = new Set();
  const obstacles = Array.from(input.obstacles, (entry, index) => {
    const field = `obstacles[${index}]`;
    record(entry, field, OBSTACLE_FIELDS);
    const obstacleId = uuid(entry.obstacleId, `${field}.obstacleId`);
    if (ids.has(obstacleId)) fail(`${field}.obstacleId`, 'duplicate obstacle identity');
    ids.add(obstacleId);
    const boundsM = rectangle(entry.boundsM, `${field}.boundsM`);
    if (!containsBounds(boundaryM, boundsM)) fail(`${field}.boundsM`, 'obstacle must lie entirely within the room');
    return Object.freeze({ obstacleId, name: text(entry.name, `${field}.name`), boundsM });
  });
  record(input.source, 'source', SOURCE_FIELDS);
  if (!['ASSUMED', 'REFERENCE'].includes(input.source.kind)) fail('source.kind', 'must be ASSUMED or REFERENCE');
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    snapshotId: uuid(input.snapshotId, 'snapshotId'),
    facilityInput: createFacilityInputReference(input.facilityInput),
    name: text(input.name, 'name'),
    unit: 'm',
    frame: 'ROOM_LOCAL',
    originDescription: text(input.originDescription, 'originDescription', 512),
    boundaryM,
    obstacleCoverage: input.obstacleCoverage,
    obstacles: Object.freeze(obstacles),
    source: Object.freeze({ kind: input.source.kind, reference: text(input.source.reference, 'source.reference', 512) }),
  });
}
