import { CATALOG, EVIDENCE_BUCKETS } from '../catalog.js';
import { createFacilityValidationService } from '../service.js';
import { createToolExecutor, createToolRegistry, SURFACE_KEY, TOOL_SURFACE_VERSION } from './registry.js';
import { PENDING_ACTIONS, createActionTools } from './actions.js';
import { RULE_TOOLS } from './rules.js';
import { SPATIAL_TOOLS } from './spatial.js';
import {
  compareRevisions,
  getAssetBinding,
  getCapacityBudget,
  getCoverage,
  getEntity,
  getRevisionActivity,
  getRevisionContext,
  getValidationRun,
  listAssetBindings,
  listAssumptions,
  listAttestations,
  listContainers,
  listDiagnostics,
  listEntities,
  listEnvironmentalConstraints,
  listEnvironmentalProfiles,
  listFailureDomains,
  listImpactNotices,
  listImportSessions,
  listPhases,
  listResilienceRequirements,
  listSpatialConstraints,
  listStorageReserves,
  listUtilityInterfaces,
  listUtilitySources,
  listWaivers,
} from './reads.js';

export {
  SURFACE_KEY,
  TOOL_SURFACE_VERSION,
  createToolRegistry,
  createToolExecutor,
  defineTool,
} from './registry.js';
export { PENDING_ACTIONS, PENDING_CHANGE_KINDS } from './actions.js';
export { CHANGE_KIND_NAMES } from '../change-kinds.js';
export { applyChangeSet, orderChanges, requiredPermissionsFor } from '../changes.js';
export { deriveDiagnostic } from './reads.js';

/**
 * The reader tools, in the order the specification presents them.
 *
 * The list is the coverage claim: for every evidence bucket the catalog declares,
 * at least one tool here reads it. `unreadEvidenceBuckets()` checks that, and the
 * contract test fails the build when a new constraint arrives with no reader.
 */
export const READ_TOOLS = Object.freeze([
  getRevisionContext,
  getRevisionActivity,
  listEntities,
  listContainers,
  getEntity,
  listPhases,
  ...SPATIAL_TOOLS,
  listSpatialConstraints,
  listUtilitySources,
  listUtilityInterfaces,
  getCapacityBudget,
  listStorageReserves,
  listFailureDomains,
  listResilienceRequirements,
  listEnvironmentalProfiles,
  listEnvironmentalConstraints,
  listAssumptions,
  ...RULE_TOOLS,
  listDiagnostics,
  getValidationRun,
  getCoverage,
  listWaivers,
  listAttestations,
  listImpactNotices,
  getAssetBinding,
  listAssetBindings,
  listImportSessions,
  compareRevisions,
]);

/**
 * Evidence buckets that are projections rather than stores, and the buckets whose
 * readers together satisfy them.
 *
 * `routes` is geometry with a role, so `query_geometry` reads it and declares it.
 * `quantities` is a union across four stores, so no single tool owns it: it is
 * readable exactly when all four of its constituent readers exist. Recording the
 * projection here is what keeps "every constraint is explainable" an honest
 * property instead of a claim that quietly excludes the derived buckets.
 */
export const EVIDENCE_PROJECTIONS = Object.freeze({
  routes: ['geometry'],
  quantities: ['sources', 'budgets', 'reserves', 'envConstraints'],
});

/**
 * Evidence buckets the catalog declares that no read tool claims.
 *
 * A bucket with no reader is a constraint that can be named and not explained, so
 * an empty array here is the property the surface exists to provide.
 */
export function unreadEvidenceBuckets(tools = READ_TOOLS) {
  const covered = new Set();
  for (const tool of tools) {
    if (tool.access !== 'read') continue;
    for (const bucket of tool.evidence) covered.add(bucket);
  }
  for (const [bucket, constituents] of Object.entries(EVIDENCE_PROJECTIONS)) {
    if (constituents.every((constituent) => covered.has(constituent))) covered.add(bucket);
  }
  return EVIDENCE_BUCKETS.filter((bucket) => !covered.has(bucket));
}

/** Catalog constraints whose evidence bucket no read tool can read. */
export function unexplainedConstraints(tools = READ_TOOLS) {
  const unread = new Set(unreadEvidenceBuckets(tools));
  return CATALOG.filter((entry) => unread.has(entry.evidence)).map((entry) => entry.constraintId);
}

/**
 * Assembles the surface.
 *
 * One service instance is shared with whatever else the process runs, so a tool
 * call and a UI request cannot take different code paths through validation.
 */
export function createFacilityToolSurface({
  pool,
  logger = null,
  authorize = null,
  onAudit = null,
  validationService = null,
  runInTenant = null,
  storage = null,
} = {}) {
  if (!pool) throw new Error('The facility tool surface requires a database pool.');

  const service = validationService ?? createFacilityValidationService({ pool, logger });
  const tools = [...READ_TOOLS, ...createActionTools({ validationService: service, logger, storage })];
  const registry = createToolRegistry({ tools });
  const executor = createToolExecutor({ pool, registry, logger, authorize, onAudit, runInTenant });

  return {
    surface: SURFACE_KEY,
    version: TOOL_SURFACE_VERSION,
    registry,
    executor,
    validationService: service,
    pendingActions: PENDING_ACTIONS,
    /** Descriptors safe to hand a model or a client: never a handler. */
    describe: (options = {}) => registry.select(options).map((tool) => registry.describeOne(tool.name)),
    execute: (input) => executor.execute(input),
    coverage: () => ({
      readTools: READ_TOOLS.length,
      actionTools: tools.length - READ_TOOLS.length,
      total: tools.length,
      unreadEvidenceBuckets: unreadEvidenceBuckets(),
      unexplainedConstraints: unexplainedConstraints(),
      pendingActions: PENDING_ACTIONS.map((action) => action.name),
    }),
  };
}
