export {
  CONTRACT_VERSION,
  ROTATIONS_DEG,
  RackInputError,
  createRackModel,
  createRackPlacement,
} from './model.js';
export { rackFootprint } from './geometry.js';
export { createFacilityInputReference, createRackPlan, assessFacilityInput } from './plan.js';
export { createRoomSnapshot, MAX_ROOM_OBSTACLES } from './room.js';
export { checkRackPlacement, SPATIAL_RULES } from './spatial.js';
export { checkRackLayout, MAX_LAYOUT_RACKS, MAX_LAYOUT_MODELS } from './layout.js';
export { localizeRoomBoundary, MAX_ROOM_VIEW_POINTS, MAX_ROOM_VIEW_RINGS } from './room-view.js';
export { normalizeEditableLayout, assertLockedRacksUnchanged } from './edit-layout.js';
export { EMPTY_SPATIAL_CONSTRAINTS, normalizeSpatialConstraints, localRectangle, rackClearanceBands } from './constraints.js';
export { EMPTY_EQUIPMENT, normalizeEquipment, checkEquipment } from './equipment.js';
export { MAX_EQUIPMENT_DEVICES, MAX_EQUIPMENT_RACK_LIMITS } from './limits.js';
export { getRackCatalog, resolveCatalogReference, assertCatalogDevice } from './catalog.js';
export { getCatalogExamples } from './catalog-examples.js';
export { generateRackOptions, normalizePlannerOptions, plannerGeometry, layoutMetrics, PLANNER_LIMITS } from './planner.js';
export { allocateUnassignedEquipment, ALLOCATION_LIMITS } from './allocator.js';
export { normalizeRoomBudget, checkRoomBudget } from './room-budget.js';
export { normalizeDesignDemand, generateDemandOptions, DEMAND_LIMITS } from './demand-planner.js';
