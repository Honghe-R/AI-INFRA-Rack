import { fail, record, uuid } from './input.js';
import { createRackModel, createRackPlacement } from './model.js';
import { rackFootprint } from './geometry.js';
import { createRoomSnapshot } from './room.js';
import { checkRackPlacement, SPATIAL_RULES } from './spatial.js';

export const MAX_LAYOUT_RACKS = 256;
export const MAX_LAYOUT_MODELS = 256;
const LAYOUT_FIELDS = new Set(['projectId', 'planId', 'room', 'models', 'placements', 'placementCoverage']);
const UNCHECKED_RULES = Object.freeze([
  'maintenance_clearance', 'aisles', 'equipment_and_capacity',
  'source_freshness', 'plan_binding', 'authorization',
]);

function boundedArray(value, field, limit) {
  if (!Array.isArray(value) || value.length > limit) {
    fail(field, `must be an explicit array of at most ${limit} records`);
  }
}

function pairOverlap(a, b) {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  // Edge/corner contact has no interior overlap. Clearance is a separate rule.
  return minX < maxX && minY < maxY ? Object.freeze({ minX, minY, maxX, maxY }) : null;
}

/** Checks the supplied inventory in one declared plan/room; does not load or save a plan. */
export function checkRackLayout(input) {
  record(input, 'layout', LAYOUT_FIELDS);
  const projectId = uuid(input.projectId, 'projectId');
  const planId = uuid(input.planId, 'planId');
  if (!['COMPLETE', 'UNKNOWN'].includes(input.placementCoverage)) {
    fail('placementCoverage', 'must explicitly be COMPLETE or UNKNOWN');
  }
  boundedArray(input.models, 'models', MAX_LAYOUT_MODELS);
  boundedArray(input.placements, 'placements', MAX_LAYOUT_RACKS);
  const room = createRoomSnapshot(input.room);
  if (room.facilityInput.projectId !== projectId) fail('room.facilityInput.projectId', 'must match the declared layout project');

  const models = new Map();
  // Array.from visits sparse slots too; a missing model cannot silently disappear.
  Array.from(input.models, (raw, index) => {
    const model = createRackModel(raw);
    if (models.has(model.modelId)) fail(`models[${index}].modelId`, 'duplicate model identity');
    models.set(model.modelId, model);
  });
  const rackIds = new Set();
  const placements = Array.from(input.placements, (raw, index) => {
    const placement = createRackPlacement(raw);
    if (placement.projectId !== projectId) fail(`placements[${index}].projectId`, 'must match the declared layout project');
    if (placement.planId !== planId) fail(`placements[${index}].planId`, 'must match the declared layout plan');
    if (rackIds.has(placement.rackId)) fail(`placements[${index}].rackId`, 'duplicate rack identity');
    if (!models.has(placement.modelId)) fail(`placements[${index}].modelId`, 'referenced model is missing from the supplied catalogue');
    rackIds.add(placement.rackId);
    return placement;
  });

  // Reuse the single-rack rules so batch checks cannot drift from manual checks.
  const rackReports = placements.map(placement => checkRackPlacement(room, models.get(placement.modelId), placement));
  const footprints = placements.map(placement => rackFootprint(models.get(placement.modelId), placement));
  const diagnostics = rackReports.flatMap(report => report.diagnostics);
  let pairsChecked = 0;
  let conflicts = 0;
  for (let first = 0; first < placements.length; first++) {
    for (let second = first + 1; second < placements.length; second++) {
      pairsChecked++;
      const overlapBoundsM = pairOverlap(footprints[first].boundsM, footprints[second].boundsM);
      if (!overlapBoundsM) continue;
      conflicts++;
      diagnostics.push(Object.freeze({
        ruleId: SPATIAL_RULES.RACK_COLLISION,
        code: 'RACK_PAIR_OVERLAP',
        severity: 'ERROR',
        rackIds: Object.freeze([placements[first].rackId, placements[second].rackId]),
        message: 'Two rack footprints have an interior overlap.',
        evidence: Object.freeze({
          unit: 'm',
          firstBoundsM: footprints[first].boundsM,
          secondBoundsM: footprints[second].boundsM,
          overlapBoundsM,
        }),
      }));
    }
  }

  const hasRacks = placements.length > 0;
  const complete = input.placementCoverage === 'COMPLETE';
  const completeObstacles = room.obstacleCoverage === 'COMPLETE';
  const aggregateStatus = ruleId => {
    const statuses = rackReports.map(report => report.checks.find(check => check.ruleId === ruleId)?.status);
    if (statuses.includes('FAIL')) return 'FAIL';
    return hasRacks && statuses.every(status => status === 'PASS') ? 'PASS' : 'NOT_CHECKED';
  };
  const status = diagnostics.length ? 'ISSUES_FOUND'
    : !hasRacks ? 'NOT_CHECKED'
      : complete && completeObstacles ? 'CHECKED_SCOPE_CLEAR' : 'INCOMPLETE';
  return Object.freeze({
    projectId,
    planId,
    snapshotId: room.snapshotId,
    facilityInput: room.facilityInput,
    roomSource: room.source,
    placementCoverage: input.placementCoverage,
    status,
    summary: Object.freeze({ racksChecked: placements.length, pairsChecked, collidingPairs: conflicts }),
    checks: Object.freeze([
      Object.freeze({ ruleId: SPATIAL_RULES.ROOM_BOUNDS, status: aggregateStatus(SPATIAL_RULES.ROOM_BOUNDS), racksChecked: placements.length }),
      Object.freeze({ ruleId: SPATIAL_RULES.OBSTACLES, status: aggregateStatus(SPATIAL_RULES.OBSTACLES), inputCoverage: room.obstacleCoverage, obstaclesPerRack: room.obstacles.length }),
      Object.freeze({ ruleId: SPATIAL_RULES.RACK_COLLISION, status: conflicts ? 'FAIL' : hasRacks && complete ? 'PASS' : 'NOT_CHECKED', inputCoverage: input.placementCoverage, pairsChecked }),
    ]),
    rackReports: Object.freeze(rackReports),
    diagnostics: Object.freeze(diagnostics),
    uncheckedRules: UNCHECKED_RULES,
  });
}
