/**
 * Input validity is separate from engineering feasibility. These constructors
 * validate data shapes; they do not certify placement, capacity or permissions.
 * No database, network, identity or mutable global state belongs in this module.
 */
import { fail, record, uuid, text } from './input.js';
export { RackInputError } from './input.js';

export const CONTRACT_VERSION = 1;
export const ROTATIONS_DEG = Object.freeze([0, 90, 180, 270]);

const MODEL_FIELDS = new Set([
  'modelId', 'name', 'widthM', 'depthM', 'heightU', 'maxWeightKg',
  'maxPowerKw', 'maxCoolingKw', 'source',
]);
const PLACEMENT_FIELDS = new Set([
  'rackId', 'planId', 'projectId', 'modelId', 'name', 'xM', 'yM', 'rotationDeg', 'locked',
]);

function finite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, 'must be a finite number');
  return value;
}

function positive(value, field) {
  finite(value, field);
  if (value <= 0) fail(field, 'must be positive');
  return value;
}

// Missing capacity stays unknown. Zero is an explicit no-capacity limit, not a
// default and never an alias for unlimited capacity.
function optionalLimit(value, field) {
  if (value === null || value === undefined) return null;
  finite(value, field);
  if (value < 0) fail(field, 'must be non-negative or null');
  return value;
}

export function createRackModel(input) {
  record(input, 'model', MODEL_FIELDS);
  if (!Number.isSafeInteger(input.heightU) || input.heightU <= 0) {
    fail('heightU', 'must be a positive safe integer');
  }
  record(input.source, 'source', new Set(['kind', 'reference']));
  if (!['ASSUMED', 'REFERENCE'].includes(input.source.kind)) {
    fail('source.kind', 'must be ASSUMED or REFERENCE');
  }
  const source = Object.freeze({
    kind: input.source.kind,
    reference: text(input.source.reference, 'source.reference', 512),
  });
  return Object.freeze({
    modelId: uuid(input.modelId, 'modelId'),
    name: text(input.name, 'name'),
    widthM: positive(input.widthM, 'widthM'),
    depthM: positive(input.depthM, 'depthM'),
    heightU: input.heightU,
    maxWeightKg: optionalLimit(input.maxWeightKg, 'maxWeightKg'),
    maxPowerKw: optionalLimit(input.maxPowerKw, 'maxPowerKw'),
    maxCoolingKw: optionalLimit(input.maxCoolingKw, 'maxCoolingKw'),
    source,
  });
}

/** Position is the footprint's centre, in a room-local Cartesian frame (metres). */
export function createRackPlacement(input) {
  record(input, 'placement', PLACEMENT_FIELDS);
  const rotationDeg = input.rotationDeg === undefined ? 0 : input.rotationDeg;
  if (!ROTATIONS_DEG.includes(rotationDeg)) fail('rotationDeg', 'must be 0, 90, 180 or 270');
  const locked = input.locked === undefined ? false : input.locked;
  if (typeof locked !== 'boolean') fail('locked', 'must be a boolean');
  return Object.freeze({
    rackId: uuid(input.rackId, 'rackId'),
    planId: uuid(input.planId, 'planId'),
    projectId: uuid(input.projectId, 'projectId'),
    modelId: uuid(input.modelId, 'modelId'),
    name: text(input.name, 'name'),
    xM: finite(input.xM, 'xM'),
    yM: finite(input.yM, 'yM'),
    rotationDeg,
    locked,
  });
}
