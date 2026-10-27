import { fail } from './input.js';
import { createRackPlacement } from './model.js';
import { rackFootprint } from './geometry.js';
import { createRoomSnapshot, containsBounds } from './room.js';

export const SPATIAL_RULES = Object.freeze({
  ROOM_BOUNDS: 'rack.space.room_bounds',
  OBSTACLES: 'rack.space.obstacles',
  RACK_COLLISION: 'rack.space.rack_collision',
});
const UNCHECKED_RULES = Object.freeze([
  'rack_to_rack_collision', 'maintenance_clearance', 'aisles',
  'equipment_and_capacity', 'source_freshness', 'plan_binding', 'authorization',
]);

// Touching an obstacle is conservatively a conflict. A wall is handled separately:
// touching the room boundary is contained, but says nothing about maintenance access.
function intersectsOrTouches(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Checks ONE footprint against rectangular room input, never whole-plan feasibility. */
export function checkRackPlacement(roomInput, modelInput, placementInput) {
  const room = createRoomSnapshot(roomInput);
  const placement = createRackPlacement(placementInput);
  if (placement.projectId !== room.facilityInput.projectId) {
    fail('projectId', 'placement and room source must declare the same project');
  }
  const footprint = rackFootprint(modelInput, placement);
  const inside = containsBounds(room.boundaryM, footprint.boundsM);
  const hits = room.obstacles.filter(obstacle => intersectsOrTouches(obstacle.boundsM, footprint.boundsM));
  const diagnostics = [];
  if (!inside) {
    diagnostics.push(Object.freeze({
      ruleId: SPATIAL_RULES.ROOM_BOUNDS,
      code: 'RACK_OUTSIDE_ROOM',
      severity: 'ERROR',
      rackId: placement.rackId,
      message: 'Rack footprint extends beyond the rectangular room boundary.',
      evidence: Object.freeze({ unit: 'm', rackBoundsM: footprint.boundsM, roomBoundsM: room.boundaryM }),
    }));
  }
  for (const obstacle of hits) {
    diagnostics.push(Object.freeze({
      ruleId: SPATIAL_RULES.OBSTACLES,
      code: 'RACK_OBSTACLE_CONFLICT',
      severity: 'ERROR',
      rackId: placement.rackId,
      obstacleId: obstacle.obstacleId,
      message: 'Rack footprint overlaps or touches a known obstacle.',
      evidence: Object.freeze({ unit: 'm', rackBoundsM: footprint.boundsM, obstacleBoundsM: obstacle.boundsM }),
    }));
  }
  const complete = room.obstacleCoverage === 'COMPLETE';
  const obstacleStatus = hits.length ? 'FAIL' : complete ? 'PASS' : 'NOT_CHECKED';
  return Object.freeze({
    snapshotId: room.snapshotId,
    facilityInput: room.facilityInput,
    roomSource: room.source,
    planId: placement.planId,
    rackId: placement.rackId,
    status: !inside || hits.length ? 'ISSUES_FOUND' : complete ? 'CHECKED_SCOPE_CLEAR' : 'INCOMPLETE',
    checks: Object.freeze([
      Object.freeze({ ruleId: SPATIAL_RULES.ROOM_BOUNDS, status: inside ? 'PASS' : 'FAIL' }),
      Object.freeze({ ruleId: SPATIAL_RULES.OBSTACLES, status: obstacleStatus, inputCoverage: room.obstacleCoverage, obstaclesChecked: room.obstacles.length }),
    ]),
    diagnostics: Object.freeze(diagnostics),
    uncheckedRules: UNCHECKED_RULES,
  });
}
