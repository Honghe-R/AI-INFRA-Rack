import { ApiError } from '@ai-infra/core';
import { readEnvelope, readStore, readStores } from '../stores.js';
import { readEtag } from '../etags.js';
import { BINDING_ROLES, REVIEW_STATES, resolveAssetIdentities } from '../asset-bindings.js';
import { availableCapacity } from '../capacity.js';
import { CATALOG, CAPABILITIES, getConstraint } from '../catalog.js';
import { gatedCapabilities } from '../coverage.js';
import { paginate } from './bounds.js';
import { field } from './schema.js';
import { projectActivityEvent, projectAll, projectPhaseDependency, projectRequirement, projectStore } from './mappers.js';
import { defineTool } from './registry.js';

/**
 * The read tools.
 *
 * A read is a projection over a store, plus the filter the tool's contract
 * declares. Filtering happens in process because a revision is a bounded graph
 * (tens to hundreds of rows per store) and the published contract bounds the
 * *result*, not the query — which is what lets these tools share one statement
 * per store with the validation engine instead of maintaining 29 bespoke queries.
 *
 * The exceptions are the spatial reads, which must push their predicate into
 * PostGIS, and the derivation reads (`list_diagnostics`, `explain_constraint`),
 * which consult the catalog rather than a store.
 */

const READ = 'facility.read';
const LIMIT = field.int({ min: 1, max: 200, default: 50 });
const CURSOR = field.string();

const revisionInput = (extra = {}) => ({
  revision_id: field.uuid({ required: true }),
  ...extra,
  limit: LIMIT,
  cursor: CURSOR,
});

/**
 * A list tool over one store: read, project, filter, page.
 *
 * `filter` receives the projected item, so it works in the surface's own naming
 * and cannot accidentally depend on a column the projection deliberately withholds.
 */
function listTool({ name, axis, store, description, evidence = [], input = {}, filter = null, requires = [READ] }) {
  return defineTool({
    name,
    axis,
    access: 'read',
    description,
    stores: [store],
    evidence,
    requiredFunctions: requires,
    input: revisionInput(input),
    handler: async ({ client, args, context }) => {
      const rows = await readStore({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        store,
      });
      const items = projectStore(store, rows);
      const matched = filter ? items.filter((item) => filter(item, args)) : items;
      return paginate(matched, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
    },
  });
}

/* ------------------------------------------------------------------ context */

export const getRevisionContext = defineTool({
  name: 'get_revision_context',
  axis: 'STATE',
  access: 'read',
  description:
    'Envelope identity, lifecycle, derived capability coverage, the latest validation summary, and the freshness facts an editor needs before writing.',
  stores: ['revisions', 'coverage', 'validationRuns'],
  evidence: ['envelope'],
  requiredFunctions: [READ],
  input: revisionInput({ include_coverage: field.bool({ default: true }), include_validation: field.bool({ default: true }) }),
  handler: async ({ client, args, context }) => {
    const envelope = await readEnvelope({ client, projectId: context.projectId, revisionId: context.revisionId });
    const [revisions, coverageRows, runRows, etag] = await Promise.all([
      readStore({ client, projectId: context.projectId, revisionId: context.revisionId, store: 'revisions' }),
      readStore({ client, projectId: context.projectId, revisionId: context.revisionId, store: 'coverage' }),
      readStore({ client, projectId: context.projectId, revisionId: context.revisionId, store: 'validationRuns' }),
      readEtag({ client, projectId: context.projectId, revisionId: context.revisionId }),
    ]);

    const revision = revisions[0] ?? null;
    const lifecycleState = envelope?.lifecycle_state ?? revision?.lifecycle_state ?? null;
    const checksum = envelope?.content_checksum ?? revision?.content_checksum ?? null;
    const latestRun = runRows[0] ?? null;

    return {
      envelopeId: envelope?.envelope_id ?? null,
      projectId: context.projectId,
      scenarioId: envelope?.scenario_id ?? revision?.scenario_id ?? context.scenarioId ?? null,
      revisionId: context.revisionId,
      revisionName: revision?.name ?? null,
      lifecycleState,
      approvalState: envelope?.approval_state ?? null,
      baseRevisionId: revision?.base_revision_id ?? null,
      // Two different questions, kept apart on purpose. The draft token is what a
      // write must present; the content checksum exists only once the revision is
      // frozen. Conflating them was why a local result could never be shown stale.
      draftEtag: etag?.etag ?? null,
      etagVersion: etag?.etagVersion ?? null,
      contentChecksum: checksum,
      freshness: {
        draft_etag: etag?.etag ?? null,
        etag_version: etag?.etagVersion ?? null,
        available: etag !== null,
        source: 'revision_etags.etag',
        note:
          etag === null
            ? 'This revision has no draft ETag row, so a write cannot be conditioned on its state. It is created on the first write or by the seed.'
            : 'The draft ETag advances on every committed change, so a validation result pinned to an earlier value is stale.',
      },
      readOnly: lifecycleState !== null && lifecycleState !== 'DRAFT',
      publishedAt: envelope?.published_at ?? revision?.published_at ?? null,
      updatedAt: envelope?.updated_at ?? revision?.updated_at ?? null,
      capabilityCoverage: args.include_coverage ? completeCoverage(coverageRows) : [],
      validationSummary: args.include_validation && latestRun ? mapRun(latestRun) : null,
    };
  },
});

/* ---------------------------------------------------------------- structure */

/**
 * Display-name equality for the entity resolver.
 *
 * Trimmed, whitespace-collapsed, and case-insensitive: a model reproduces a label but not
 * its exact spacing or casing, and a resolver that missed on "central chiller  plant"
 * would send the caller back to inventing an id. It is still an *equality* — a prefix or
 * a substring never selects an entity, because picking the wrong object is worse than
 * answering "no such name".
 */
function sameDisplayName(left, right) {
  return normaliseName(left) === normaliseName(right);
}

function normaliseName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

export const listEntities = listTool({
  name: 'list_entities',
  axis: 'STATE',
  store: 'entities',
  description:
    'List registered entities for a revision, optionally filtered by type, status, exact display name, or entity id. The id filter is what lets a caller check that an identifier names something, rather than reading an empty result as an object with no geometry.',
  evidence: ['entities'],
  input: {
    entity_type: field.string(),
    status: field.enum(['IMPORTED_REFERENCE', 'PROVISIONAL', 'VALIDATED', 'SUPERSEDED']),
    name: field.string(),
    entity_id: field.uuid(),
  },
  filter: (item, args) =>
    (!args.entity_type || item.entityType === args.entity_type) &&
    (!args.status || item.status === args.status) &&
    (!args.entity_id || item.entityId === args.entity_id) &&
    (!args.name || sameDisplayName(item.displayName, args.name)),
});

export const listContainers = listTool({
  name: 'list_containers',
  axis: 'STATE',
  store: 'containers',
  description: 'List facility containers under an optional parent, optionally filtered by container type.',
  evidence: ['containers'],
  input: { parent_entity_id: field.uuid(), entity_type: field.string() },
  filter: (item, args) =>
    (args.parent_entity_id === undefined || item.parentContainerId === args.parent_entity_id) &&
    (!args.entity_type || item.kind === args.entity_type || item.entityType === args.entity_type),
});

export const listPhases = defineTool({
  name: 'list_phases',
  axis: 'STATE',
  access: 'read',
  description:
    'List facility phases with their dependency edges and per-capability commissioning availability. This is the reader for the phases and phaseDeps evidence buckets.',
  stores: ['phases', 'phaseDeps', 'phaseAvailability'],
  evidence: ['phases', 'phaseDeps'],
  requiredFunctions: [READ],
  input: revisionInput({
    phase_id: field.uuid(),
    include_dependencies: field.bool({ default: true }),
    include_capability_availability: field.bool({ default: true }),
  }),
  handler: async ({ client, args, context }) => {
    const { phases, phaseDeps, phaseAvailability } = await readStores({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      stores: ['phases', 'phaseDeps', 'phaseAvailability'],
    });
    const items = projectAll(phases, {
      phaseId: 'phase_id',
      name: 'name',
      phaseOrder: 'phase_order',
      activationDate: 'activation_date',
      activationDatePrecision: 'activation_date_precision',
      status: 'status',
    });

    const availability = projectAll(phaseAvailability, {
      phaseId: 'phase_id',
      capability: 'capability',
      available: 'available',
      availableFrom: 'available_from',
      notes: 'notes',
    });
    const deps = phaseDeps.map(projectPhaseDependency);

    const enriched = items.map((phase) => ({
      ...phase,
      dependencies: args.include_dependencies ? deps.filter((edge) => edge.successorPhaseId === phase.phaseId) : [],
      capabilityAvailability: args.include_capability_availability
        ? availability.filter((entry) => entry.phaseId === phase.phaseId)
        : [],
    }));

    const matched = args.phase_id ? enriched.filter((phase) => phase.phaseId === args.phase_id) : enriched;

    // `phase_id` addresses a single phase; the caller that names one gets the
    // whole record rather than a one-item page.
    if (args.phase_id) return matched[0] ?? null;
    return paginate(matched, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
  },
});

export const getEntity = defineTool({
  name: 'get_entity',
  axis: 'STATE',
  access: 'read',
  description:
    'Read one entity by identity: its registered type and status, its container parent and phase, its declared geometry roles, and its provenance.',
  stores: ['entities', 'containers', 'geometry'],
  evidence: ['entities'],
  requiredFunctions: [READ],
  input: {
    revision_id: field.uuid({ required: true }),
    entity_id: field.uuid({ required: true }),
    entity_type: field.string(),
    include_geometry_metadata: field.bool({ default: true }),
  },
  handler: async ({ client, args, context }) => {
    const { entities, containers, geometry } = await readStores({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      stores: ['entities', 'containers', 'geometry'],
    });

    const entity = projectStore('entities', entities).find((item) => item.entityId === args.entity_id) ?? null;
    if (!entity) return null;
    if (args.entity_type && entity.entityType !== args.entity_type) {
      // The identity resolved to a different type than the caller asserted. That is
      // a mismatch worth reporting rather than silently answering about the entity
      // the caller did not ask for.
      throw new ApiError('VALIDATION_FAILED', 'The entity exists but not with the declared type.', {
        status: 400,
        details: [{ field: 'entity_type', reason: 'type_mismatch', actual: entity.entityType }],
      });
    }

    const container = projectStore('containers', containers).find((item) => item.containerId === args.entity_id) ?? null;
    const owned = projectStore('geometry', geometry).filter((item) => item.entityId === args.entity_id);

    return {
      ...entity,
      container,
      phaseId: container?.phaseId ?? null,
      parentContainerId: container?.parentContainerId ?? null,
      geometry: args.include_geometry_metadata
        ? owned.map((record) => ({
            geometryId: record.geometryId,
            role: record.role,
            geometryType: record.geometryType,
            heightM: record.heightM,
            elevationBaseM: record.elevationBaseM,
            elevationTopM: record.elevationTopM,
            provenance: record.provenance,
          }))
        : [],
      geometryRoles: owned.map((record) => record.role),
    };
  },
});

export const listSpatialConstraints = listTool({
  name: 'list_spatial_constraints',
  axis: 'STATE',
  store: 'spatialConstraints',
  description: 'List declared spatial constraints (setbacks, height limits, hazard exclusions) with their rules.',
  evidence: ['spatialConstraints'],
  input: {
    constraint_id: field.uuid(),
    kind: field.string(),
    severity: field.enum(['ERROR', 'WARNING', 'INFO']),
    container_id: field.uuid(),
    applies_to_geometry_id: field.uuid(),
  },
  filter: (item, args) =>
    (!args.constraint_id || item.constraintId === args.constraint_id) &&
    (!args.kind || item.kind === args.kind) &&
    (!args.severity || item.severity === args.severity) &&
    (!args.container_id || item.containerId === args.container_id) &&
    (!args.applies_to_geometry_id || item.appliesToGeometryId === args.applies_to_geometry_id),
});

/* ---------------------------------------------------------------- resources */

export const listUtilitySources = listTool({
  name: 'list_utility_sources',
  axis: 'STATE',
  store: 'sources',
  description: 'List utility sources with declared capacity, capacity state, failure domain, and phase.',
  evidence: ['sources'],
  input: {
    utility_source_id: field.uuid(),
    kind: field.enum(['POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY']),
    phase_id: field.uuid(),
    failure_domain_id: field.uuid(),
  },
  filter: (item, args) =>
    (!args.utility_source_id || item.utilitySourceId === args.utility_source_id) &&
    (!args.kind || item.kind === args.kind) &&
    (!args.phase_id || item.phaseId === args.phase_id) &&
    (!args.failure_domain_id || item.failureDomainId === args.failure_domain_id),
});

export const listUtilityInterfaces = defineTool({
  name: 'list_utility_interfaces',
  axis: 'STATE',
  access: 'read',
  description:
    'List planning-level utility interfaces with their source, service state, failure domain, and phase. `resource_kind` filters on the kind of the interface source, which is where the resource kind lives.',
  stores: ['interfaces', 'sources'],
  evidence: ['interfaces'],
  requiredFunctions: [READ],
  input: revisionInput({
    utility_interface_id: field.uuid(),
    utility_source_id: field.uuid(),
    resource_kind: field.enum(['POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY']),
    phase_id: field.uuid(),
  }),
  handler: async ({ client, args, context }) => {
    const { interfaces, sources } = await readStores({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      stores: ['interfaces', 'sources'],
    });
    const kindBySource = new Map(sources.map((row) => [row.utility_source_id, row.kind]));
    const nameBySource = new Map(sources.map((row) => [row.utility_source_id, row.display_name]));
    const items = projectStore('interfaces', interfaces).map((item) => ({
      ...item,
      resourceKind: kindBySource.get(item.utilitySourceId) ?? null,
      // The source travels as its own object so one read identifies both the interface and
      // the source it belongs to. Flattened, the row's `utilitySourceId` would pair with the
      // interface's own display name in the entity-reference pass — a link to the wrong
      // object — because that pass emits one id/label pair per row.
      source: item.utilitySourceId
        ? {
            utilitySourceId: item.utilitySourceId,
            entityType: 'UTILITY_SOURCE',
            kind: kindBySource.get(item.utilitySourceId) ?? null,
            displayName: nameBySource.get(item.utilitySourceId) ?? null,
          }
        : null,
    }));
    const matched = items.filter(
      (item) =>
        (!args.utility_interface_id || item.interfaceId === args.utility_interface_id) &&
        (!args.utility_source_id || item.utilitySourceId === args.utility_source_id) &&
        (!args.resource_kind || item.resourceKind === args.resource_kind) &&
        (!args.phase_id || item.phaseId === args.phase_id),
    );
    return paginate(matched, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
  },
});

export const getCapacityBudget = defineTool({
  name: 'get_capacity_budget',
  axis: 'STATE',
  access: 'read',
  description:
    'Capacity budgets with commissioned, planned, reserved, allocated, and available quantities, plus the allocations and demand requests that consume them.',
  stores: ['budgets', 'allocations', 'demand'],
  evidence: ['budgets', 'allocations', 'demand'],
  requiredFunctions: [READ],
  input: revisionInput({
    budget_id: field.uuid(),
    owner_entity_id: field.uuid(),
    phase_id: field.uuid(),
    resource_kind: field.enum(['POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY']),
    basis: field.string(),
    include_allocations: field.bool({ default: true }),
    include_demand: field.bool({ default: true }),
  }),
  handler: async ({ client, args, context }) => {
    const { budgets, allocations, demand } = await readStores({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      stores: ['budgets', 'allocations', 'demand'],
    });
    const allAllocations = projectStore('allocations', allocations);
    const allDemand = projectStore('demand', demand);

    const items = projectStore('budgets', budgets)
      .filter(
        (budget) =>
          (!args.budget_id || budget.budgetId === args.budget_id) &&
          (!args.owner_entity_id || budget.ownerEntityId === args.owner_entity_id) &&
          (!args.phase_id || budget.phaseId === args.phase_id) &&
          (!args.resource_kind || budget.resourceKind === args.resource_kind) &&
          (!args.basis || budget.basis === args.basis),
      )
      .map((budget) => {
        const allocations = allAllocations.filter((entry) => entry.budgetId === budget.budgetId);
        // [D5] is recomputed rather than read back. `available_value` is a stored
        // projection that a write refreshes, but a projection is not the formula: a
        // budget written by a caller with a value of its own would otherwise make the
        // read assert an availability no allocation supports.
        const accepted = allocations
          .filter((entry) => entry.state === 'ACCEPTED')
          .reduce((sum, entry) => sum + Number(entry.quantityValue), 0);
        const available = availableCapacity({
          commissioned: budget.commissionedValue,
          deratingFactor: budget.deratingFactor,
          reserved: budget.reservedValue,
          accepted,
        });
        return {
          ...budget,
          allocatedValue: accepted,
          availableValue: available,
          allocations: args.include_allocations ? allocations : [],
          demand: args.include_demand
            ? allDemand.filter(
                (entry) =>
                  entry.resourceKind === budget.resourceKind &&
                  (!budget.phaseId || entry.phaseId === budget.phaseId),
              )
            : [],
        };
      });

    if (args.budget_id) return items[0] ?? null;
    return paginate(items, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
  },
});

export const listStorageReserves = listTool({
  name: 'list_storage_reserves',
  axis: 'STATE',
  store: 'reserves',
  description: 'List fuel and water storage reserves with capacity, state, autonomy duration, and phase.',
  evidence: ['reserves'],
  input: {
    storage_id: field.uuid(),
    kind: field.enum(['FUEL', 'WATER']),
    phase_id: field.uuid(),
  },
  filter: (item, args) =>
    (!args.storage_id || item.storageId === args.storage_id) &&
    (!args.kind || item.kind === args.kind) &&
    (!args.phase_id || item.phaseId === args.phase_id),
});

/* ------------------------------------- resilience, environment, assumptions */

export const listFailureDomains = listTool({
  name: 'list_failure_domains',
  axis: 'STATE',
  store: 'domains',
  description: 'List declared failure domains and their containment, which is the evidence behind resilience independence findings.',
  evidence: ['domains'],
  input: { failure_domain_id: field.uuid() },
  filter: (item, args) => !args.failure_domain_id || item.failureDomainId === args.failure_domain_id,
});

export const listResilienceRequirements = defineTool({
  name: 'list_resilience_requirements',
  axis: 'STATE',
  access: 'read',
  description:
    'List resilience requirements with their availability policy, pinned policy reference, autonomy duration, and the resource kinds they apply to.',
  stores: ['requirements'],
  evidence: ['requirements'],
  requiredFunctions: [READ],
  input: revisionInput({
    requirement_id: field.uuid(),
    active_only: field.bool({ default: true }),
  }),
  handler: async ({ client, args, context }) => {
    const rows = await readStore({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      store: 'requirements',
    });
    const items = rows.map(projectRequirement).filter(
      (item) =>
        (!args.requirement_id || item.requirementId === args.requirement_id) &&
        (!args.active_only || item.active === true),
    );
    if (args.requirement_id) return items[0] ?? null;
    return paginate(items, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
  },
});

export const listEnvironmentalProfiles = defineTool({
  name: 'get_environmental_profile',
  axis: 'STATE',
  access: 'read',
  description:
    'Read the environmental profile applied to a revision or site scope: design weather, hazard classifications, permit constraints, and operating ranges.',
  stores: ['profiles'],
  evidence: ['profiles'],
  requiredFunctions: [READ],
  input: revisionInput({ profile_id: field.uuid(), site_scope_id: field.uuid() }),
  handler: async ({ client, args, context }) => {
    const rows = await readStore({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      store: 'profiles',
    });
    const items = projectStore('profiles', rows).filter(
      (item) =>
        (!args.profile_id || item.profileId === args.profile_id) &&
        (!args.site_scope_id || item.siteScopeId === args.site_scope_id),
    );
    if (args.profile_id || args.site_scope_id) return items[0] ?? null;
    return paginate(items, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
  },
});

export const listEnvironmentalConstraints = listTool({
  name: 'list_environmental_constraints',
  axis: 'STATE',
  store: 'envConstraints',
  description: 'List environmental constraints with their thresholds, units, basis, and effective period.',
  evidence: ['envConstraints'],
  input: {
    constraint_id: field.uuid(),
    kind: field.string(),
    profile_id: field.uuid(),
    affected_entity_id: field.uuid(),
  },
  filter: (item, args) =>
    (!args.constraint_id || item.environmentalConstraintId === args.constraint_id) &&
    (!args.kind || item.constraintKind === args.kind) &&
    (!args.profile_id || item.profileId === args.profile_id) &&
    (!args.affected_entity_id || item.affectedEntityId === args.affected_entity_id),
});

export const listAssumptions = listTool({
  name: 'list_assumptions',
  axis: 'STATE',
  store: 'assumptions',
  description: 'List assumptions with their owner, confidence, effective and expiry dates, and the entities they reference.',
  evidence: ['assumptions'],
  input: {
    assumption_id: field.uuid(),
    status: field.enum(['OPEN', 'RESOLVED', 'SUPERSEDED']),
  },
  filter: (item, args) =>
    (!args.assumption_id || item.assumptionId === args.assumption_id) && (!args.status || item.status === args.status),
});

/* -------------------------------------------------------------- verification */

export const listDiagnostics = defineTool({
  name: 'list_diagnostics',
  axis: 'STATE',
  access: 'read',
  description:
    'List validation diagnostics for a revision, each carrying its catalog rule reference, its evidence model, its gating capability, and its remediation category. Superseded records are excluded unless requested.',
  stores: ['diagnostics', 'sources', 'budgets'],
  requiredFunctions: [READ],
  input: revisionInput({
    diagnostic_id: field.uuid(),
    validation_run_id: field.uuid(),
    severity: field.enum(['ERROR', 'WARNING', 'INFO']),
    status: field.enum(['OPEN', 'ACKNOWLEDGED', 'WAIVED', 'RESOLVED', 'SUPERSEDED']),
    constraint_id: field.string(),
    capability: field.enum(CAPABILITIES),
    entity_id: field.uuid(),
    include_superseded: field.bool({ default: false }),
  }),
  handler: async ({ client, args, context }) => {
    const rows = await readStore({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      store: 'diagnostics',
    });

    // The catalog knows which resource capability a diagnostic gates, but the
    // stored row does not record it. Where the diagnostic references a source or a
    // budget, the kind is recoverable from the store, so those two are read to
    // turn a possible set into an actual one.
    const needsResourceKind = rows.some((row) => getConstraint(row.constraint_id)?.gates === 'RESOURCE');
    const { sources, budgets } = needsResourceKind
      ? await readStores({
          client,
          projectId: context.projectId,
          revisionId: context.revisionId,
          stores: ['sources', 'budgets'],
        })
      : { sources: [], budgets: [] };

    const kindBySource = new Map(sources.map((row) => [row.utility_source_id, row.kind]));
    const kindByBudget = new Map(budgets.map((row) => [row.budget_id, row.resource_kind]));

    const derived = rows
      .map((row) => deriveDiagnostic(row, { kindBySource, kindByBudget }))
      .filter(
        (item) =>
          (args.include_superseded || item.status !== 'SUPERSEDED') &&
          (!args.diagnostic_id || item.diagnosticId === args.diagnostic_id) &&
          (!args.validation_run_id || item.validationRunId === args.validation_run_id) &&
          (!args.severity || item.severity === args.severity) &&
          (!args.status || item.status === args.status) &&
          (!args.constraint_id || item.constraintId === args.constraint_id) &&
          (!args.capability || item.capabilities.includes(args.capability)) &&
          (!args.entity_id || item.entityRefs.some((ref) => ref.entity_id === args.entity_id)),
      );

    if (args.diagnostic_id) return { items: derived, total: derived.length, returned: derived.length, truncated: false };
    return paginate(derived, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
  },
});

export const getValidationRun = defineTool({
  name: 'get_validation_run',
  axis: 'STATE',
  access: 'read',
  description: 'Read one validation run with the diagnostics it produced and the coverage it derived. Without a run id, the most recent run is returned.',
  stores: ['validationRuns', 'diagnostics', 'coverage'],
  requiredFunctions: [READ],
  input: revisionInput({ validation_run_id: field.uuid() }),
  handler: async ({ client, args, context }) => {
    const { validationRuns, diagnostics, coverage } = await readStores({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      stores: ['validationRuns', 'diagnostics', 'coverage'],
    });
    const run = args.validation_run_id
      ? validationRuns.find((row) => row.validation_run_id === args.validation_run_id) ?? null
      : validationRuns[0] ?? null;
    if (!run) return null;

    return {
      run: mapRun(run),
      diagnostics: diagnostics
        .filter((row) => row.validation_run_id === run.validation_run_id)
        .map((row) => deriveDiagnostic(row, { kindBySource: new Map(), kindByBudget: new Map() })),
      coverage: coverage.map(mapCoverage),
    };
  },
});

export const getCoverage = defineTool({
  name: 'get_coverage',
  axis: 'STATE',
  access: 'read',
  description: 'Derived capability coverage for a revision. A capability with no row has not been derived, which is not the same as passing.',
  stores: ['coverage'],
  requiredFunctions: [READ],
  input: { revision_id: field.uuid({ required: true }) },
  handler: async ({ client, context }) => {
    const rows = await readStore({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      store: 'coverage',
    });
    return { coverage: completeCoverage(rows) };
  },
});

export const listWaivers = listTool({
  name: 'list_waivers',
  axis: 'STATE',
  store: 'waivers',
  description: 'List waivers recorded against a revision. A revoked or expired waiver stays listed; a waiver never removes a finding.',
  evidence: ['waivers'],
  input: {
    waiver_id: field.uuid(),
    status: field.enum(['GRANTED', 'EXPIRED', 'REVOKED']),
  },
  filter: (item, args) =>
    (!args.waiver_id || item.waiverId === args.waiver_id) && (!args.status || item.status === args.status),
});

export const listAttestations = listTool({
  name: 'list_attestations',
  axis: 'STATE',
  store: 'attestations',
  description: 'List approval attestations for a revision with their decision, policy reference, and comment.',
  evidence: ['attestations'],
  input: {
    attestation_id: field.uuid(),
    decision: field.enum(['APPROVED', 'REJECTED', 'REVOKED']),
  },
  filter: (item, args) =>
    (!args.attestation_id || item.attestationId === args.attestation_id) &&
    (!args.decision || item.decision === args.decision),
});

export const listImpactNotices = listTool({
  name: 'list_impact_notices',
  axis: 'IMPACT',
  store: 'impactNotices',
  description: 'List impact notices: which consumers a change invalidated, and the entity references that changed.',
  evidence: ['envelope'],
  input: { since: field.timestamp() },
  filter: (item, args) => !args.since || (item.issuedAt ?? '') >= args.since,
});

/* ---------------------------------------------------------------- provenance */

export const getAssetBinding = defineTool({
  name: 'get_asset_binding',
  axis: 'PROVENANCE',
  access: 'read',
  description:
    'Read one asset binding with its pinned asset version, transform and mapping review state, and optional mappings. Never returns source bytes or a storage location.',
  stores: ['bindings', 'mappings'],
  evidence: ['bindings', 'mappings'],
  requiredFunctions: [READ, 'asset.read'],
  input: {
    revision_id: field.uuid({ required: true }),
    binding_id: field.uuid({ required: true }),
    include_mappings: field.bool({ default: true }),
  },
  handler: async ({ client, args, context }) => {
    const { bindings, mappings } = await readStores({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      stores: ['bindings', 'mappings'],
    });
    const binding = projectStore('bindings', bindings).find((item) => item.bindingId === args.binding_id) ?? null;
    if (!binding) return null;
    const related = projectStore('mappings', mappings).filter((item) => item.bindingId === binding.bindingId);
    const identity =
      (await resolveAssetIdentities(client, context.projectId, [binding.assetVersionId])).get(binding.assetVersionId) ??
      null;
    return {
      ...binding,
      assetId: identity?.assetId ?? null,
      assetName: identity?.assetName ?? null,
      assetKind: identity?.assetKind ?? null,
      versionNumber: identity?.versionNumber ?? null,
      filename: identity?.filename ?? null,
      isCurrentVersion: identity?.isCurrentVersion ?? null,
      mappings: args.include_mappings ? related : [],
      mappingsInReview: related.filter((item) => item.reviewState !== 'REVIEWED').length,
      // A binding's status is a review state, so an imported value is
      // authoritative exactly when the binding and every one of its mappings have
      // been reviewed. Anything less is an unreviewed source, not a fact.
      authoritative: binding.status === 'REVIEWED' && related.every((item) => item.reviewState === 'REVIEWED'),
    };
  },
});

export const listImportSessions = listTool({
  name: 'list_import_sessions',
  axis: 'PROVENANCE',
  store: 'mappings',
  description: 'List import mappings for a revision with their review state, cardinality, and whether each required mapping is satisfied.',
  evidence: ['mappings'],
  input: {
    binding_id: field.uuid(),
    review_state: field.enum(['UNREVIEWED', 'IN_REVIEW', 'REVIEWED', 'REJECTED']),
    required_only: field.bool({ default: false }),
  },
  filter: (item, args) =>
    (!args.binding_id || item.bindingId === args.binding_id) &&
    (!args.review_state || item.reviewState === args.review_state) &&
    (!args.required_only || item.required === true),
});

/**
 * A list of bindings that says what each one is a binding *to*.
 *
 * Not the generic `listTool`, because the store holds a version identifier and the
 * asset it belongs to lives in the project asset layer: a provenance read that
 * returned only a version id would report that something was imported without
 * saying what. The binding rows still come from the one shared store query; the
 * identity is a second, bounded lookup over the ids on the page.
 */
export const listAssetBindings = defineTool({
  name: 'list_asset_bindings',
  axis: 'PROVENANCE',
  access: 'read',
  description:
    'List the project asset versions this revision consumes, with the asset and version each one names, the pinned representation, the role, and the review state. Never returns source bytes or a storage location.',
  stores: ['bindings'],
  evidence: ['bindings'],
  requiredFunctions: [READ, 'asset.read'],
  input: revisionInput({
    asset_version_id: field.uuid(),
    asset_id: field.uuid(),
    role: field.enum(BINDING_ROLES),
    status: field.enum(REVIEW_STATES),
  }),
  handler: async ({ client, args, context }) => {
    const rows = await readStore({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      store: 'bindings',
    });

    const matched = projectStore('bindings', rows).filter(
      (item) =>
        (!args.asset_version_id || item.assetVersionId === args.asset_version_id) &&
        (!args.role || item.role === args.role) &&
        (!args.status || item.status === args.status),
    );

    const identities = await resolveAssetIdentities(
      client,
      context.projectId,
      matched.map((item) => item.assetVersionId),
    );

    const items = matched
      .map((item) => {
        const identity = identities.get(item.assetVersionId) ?? null;
        return {
          ...item,
          // `null` rather than a guess: an asset version that no longer resolves is
          // reported as unknown, never as a name that happens to be handy.
          assetId: identity?.assetId ?? null,
          assetName: identity?.assetName ?? null,
          assetKind: identity?.assetKind ?? null,
          versionNumber: identity?.versionNumber ?? null,
          filename: identity?.filename ?? null,
          mediaType: identity?.mediaType ?? null,
          isCurrentVersion: identity?.isCurrentVersion ?? null,
        };
      })
      .filter((item) => !args.asset_id || item.assetId === args.asset_id);

    return paginate(items, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
  },
});

/**
 * What happened to a revision, newest first.
 *
 * This is the read that answers "what changed recently", and it exists because
 * `compare_revisions` structurally cannot: a `DRAFT` is mutable in place ([D1]), so
 * there are no per-edit revisions to diff, and the transactional outbox is the only
 * change history the store keeps ([D-A]). One committed change set is one
 * `facility.revision.changed.v1` row carrying its change kinds, changed entity refs,
 * and the draft ETag version it produced — which is exactly the edit trail.
 *
 * It reads the outbox; it does not *deliver* it. There is no dispatcher, no
 * publication, and no consumer here, so D-B's deferral of event delivery is untouched.
 */
export const getRevisionActivity = defineTool({
  name: 'get_revision_activity',
  axis: 'STATE',
  access: 'read',
  description:
    "List what happened to a revision, newest first: each committed change set with its change kinds, changed entities, and resulting draft ETag version, plus any other event recorded against the revision. A draft is edited in place, so this read — not a revision diff — is the revision's history.",
  stores: ['activity'],
  requiredFunctions: [READ],
  input: revisionInput({
    event_type: field.string(),
    change_kind: field.string(),
  }),
  handler: async ({ client, args, context }) => {
    const rows = await readStore({
      client,
      projectId: context.projectId,
      revisionId: context.revisionId,
      store: 'activity',
    });

    const matched = rows
      .map(projectActivityEvent)
      // A change kind filters on the change-set payload; an event that carries none is
      // excluded rather than reported as if it changed nothing.
      .filter((event) => !args.event_type || event.eventType === args.event_type)
      .filter((event) => !args.change_kind || (event.changeSet?.changeKinds ?? []).includes(args.change_kind));

    return paginate(matched, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
  },
});

export const compareRevisions = defineTool({
  name: 'compare_revisions',
  axis: 'STATE',
  access: 'read',
  description:
    'Compare two revisions that both exist in the same project and scenario and report changed entity references by type. Bounded by max_changes. A revision-to-revision diff, not the edit history of a draft — for that, read get_revision_activity.',
  requiredFunctions: [READ],
  requiresRevision: false,
  input: {
    base_revision_id: field.uuid({ required: true }),
    target_revision_id: field.uuid({ required: true }),
    max_changes: field.int({ min: 1, max: 200, default: 50 }),
  },
  handler: async ({ client, args, context }) => {
    // A comparison is only meaningful between two revisions that exist. Reading a
    // revision that does not returns no rows, and "nothing" against "something" diffs
    // as a full list of additions while "nothing" against "nothing" reads as
    // *identical* — neither of which can be told apart from a real answer. A missing
    // revision is refused rather than diffed, so a typo or a fabricated identifier
    // cannot come back as "the history is empty".
    const [baseRevision, targetRevision] = await Promise.all(
      [args.base_revision_id, args.target_revision_id].map((revisionId) =>
        readStore({ client, projectId: context.projectId, revisionId, store: 'revisions' }).then((rows) => rows[0] ?? null),
      ),
    );
    const missing = [];
    if (!baseRevision) missing.push('base_revision_id');
    if (!targetRevision) missing.push('target_revision_id');
    if (missing.length > 0) {
      throw new ApiError('NOT_FOUND', 'A revision named for comparison does not exist in this project.', {
        status: 404,
        details: missing.map((field) => ({ field, reason: 'not_found' })),
      });
    }
    // The contract compares two revisions of one scenario; diffing across scenarios
    // would report one scenario's whole graph as added to another's.
    if (baseRevision.scenario_id !== targetRevision.scenario_id) {
      throw new ApiError('VALIDATION_FAILED', 'Only two revisions of the same scenario can be compared.', {
        status: 422,
        details: [
          { field: 'base_revision_id', reason: 'scenario_mismatch', scenario_id: baseRevision.scenario_id },
          { field: 'target_revision_id', reason: 'scenario_mismatch', scenario_id: targetRevision.scenario_id },
        ],
      });
    }

    const changes = [];
    const byStore = {};

    for (const [store, key] of Object.entries(COMPARE_STORES)) {
      // eslint-disable-next-line no-await-in-loop
      const [base, target] = await Promise.all([
        readStore({ client, projectId: context.projectId, revisionId: args.base_revision_id, store }),
        readStore({ client, projectId: context.projectId, revisionId: args.target_revision_id, store }),
      ]);
      const diff = diffRows(base, target, key);
      byStore[store] = { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length };
      for (const entry of diff.added) changes.push({ store, change: 'ADDED', id: entry });
      for (const entry of diff.removed) changes.push({ store, change: 'REMOVED', id: entry });
      for (const entry of diff.changed) changes.push({ store, change: 'CHANGED', id: entry });
    }

    const bounded = changes.slice(0, args.max_changes);
    const identical = args.base_revision_id === args.target_revision_id;
    return {
      baseRevisionId: args.base_revision_id,
      targetRevisionId: args.target_revision_id,
      // The identities are echoed from the store, never from the caller's sentence, so a
      // caller that named the wrong revision is answered about the real one.
      baseRevision: revisionIdentity(baseRevision),
      targetRevision: revisionIdentity(targetRevision),
      identical,
      isEqual: changes.length === 0,
      byStore,
      changes: bounded,
      totalChanges: changes.length,
      truncated: changes.length > bounded.length,
      notice: identical
        ? 'The base and target are the same revision, so there is nothing to compare. A draft is edited in place, so its history is not a sequence of revisions.'
        : changes.length > bounded.length
          ? `Showing the first ${bounded.length} of ${changes.length} changes; raise max_changes or narrow by store.`
          : null,
    };
  },
});

/** The resolved identity of a compared revision, so a caller can report which one it read. */
function revisionIdentity(row) {
  return {
    revisionId: row.revision_id,
    name: row.name,
    lifecycleState: row.lifecycle_state,
    scenarioId: row.scenario_id,
  };
}

/** The stores a revision comparison covers, and the identity column of each. */
const COMPARE_STORES = Object.freeze({
  scopes: 'scope_id',
  containers: 'container_id',
  geometry: 'geometry_id',
  spatialConstraints: 'constraint_id',
  sources: 'utility_source_id',
  interfaces: 'interface_id',
  budgets: 'budget_id',
  allocations: 'allocation_id',
  demand: 'request_id',
  reserves: 'storage_id',
  requirements: 'requirement_id',
  domains: 'failure_domain_id',
  phases: 'phase_id',
  profiles: 'profile_id',
  envConstraints: 'environmental_constraint_id',
  assumptions: 'assumption_id',
  waivers: 'waiver_id',
  attestations: 'attestation_id',
  bindings: 'binding_id',
  mappings: 'mapping_id',
  entities: 'entity_id',
});

/** Volatile columns are not a change: a re-read must not look like an edit. */
const VOLATILE = new Set(['created_at', 'updated_at', 'reviewed_at', 'created_by', 'updated_by']);

function diffRows(base, target, key) {
  const baseById = new Map(base.map((row) => [row[key], row]));
  const targetById = new Map(target.map((row) => [row[key], row]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, row] of targetById) {
    const before = baseById.get(id);
    if (!before) added.push(id);
    else if (stable(row) !== stable(before)) changed.push(id);
  }
  for (const id of baseById.keys()) if (!targetById.has(id)) removed.push(id);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

function stable(row) {
  const entries = Object.entries(row)
    .filter(([column]) => !VOLATILE.has(column))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

/* ------------------------------------------------------------------ mapping */

export function mapRun(row) {
  return {
    validationRunId: row.validation_run_id,
    revisionId: row.revision_id,
    scope: row.scope,
    status: row.status,
    baseEtag: row.base_etag ?? null,
    requestedCapabilities: row.requested_capabilities ?? [],
    checkedCapabilities: row.checked_capabilities ?? [],
    notCheckedCapabilities: row.not_checked_capabilities ?? [],
    errorCount: row.error_count,
    warningCount: row.warning_count,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at ?? null,
  };
}

export function mapCoverage(row) {
  return {
    capability: row.capability,
    status: row.status,
    reasons: row.evidence_refs?.reasons ?? [],
    validationRunId: row.evidence_refs?.validation_run_id ?? null,
    reviewedAt: row.reviewed_at ?? null,
    derived: true,
  };
}

/**
 * Coverage over every capability, with the underived ones stated as such.
 *
 * A capability the table has no row for has not been derived, which is
 * `NOT_PROVIDED` — not an absence to leave implied. Both coverage reads go
 * through here so `get_revision_context` and `get_coverage` cannot disagree
 * about a capability neither has evidence for.
 */
export function completeCoverage(rows) {
  const derived = new Map(rows.map((row) => [row.capability, mapCoverage(row)]));
  return CAPABILITIES.map(
    (capability) =>
      derived.get(capability) ?? {
        capability,
        status: 'NOT_PROVIDED',
        reasons: ['not derived by any validation run'],
        validationRunId: null,
        reviewedAt: null,
        derived: false,
      },
  );
}

/**
 * A diagnostic plus the routing keys the catalog supplies and the stored row does
 * not: the evidence model that explains it, the gate that applies it, and the
 * capability (or capabilities) it holds back.
 *
 * `capabilityExact` is false when a resource-gated diagnostic's store does not
 * record which resource kind it gated, in which case `capabilities` is the
 * possible set rather than a recorded attribution. Saying so is the honest
 * option; reporting a guess as an attribution is not.
 */
export function deriveDiagnostic(row, { kindBySource, kindByBudget } = {}) {
  const entry = getConstraint(row.constraint_id);
  const resourceKind = resolveResourceKind(row, { kindBySource, kindByBudget });
  const capabilities = entry ? gatedCapabilities(entry, resourceKind) : [];

  return {
    diagnosticId: row.diagnostic_id,
    validationRunId: row.validation_run_id ?? null,
    constraintId: row.constraint_id,
    severity: row.severity,
    status: row.status,
    entityRefs: row.entity_refs ?? [],
    geometryRefs: row.geometry_refs ?? [],
    sourceValues: row.source_values ?? [],
    computed: row.computed ?? {},
    remediationCategory: row.remediation_category ?? null,
    remediationHint: row.remediation_hint ?? null,
    policyRef: row.policy_ref ?? null,
    supersedesDiagnosticId: row.supersedes_diagnostic_id ?? null,
    createdAt: row.created_at ?? null,
    evidence: entry?.evidence ?? null,
    gates: entry?.gates ?? null,
    resourceKind,
    capabilities,
    capabilityExact: entry?.gates !== 'RESOURCE' || resourceKind !== null,
  };
}

function resolveResourceKind(row, { kindBySource, kindByBudget }) {
  for (const ref of row.entity_refs ?? []) {
    const type = ref?.entity_type ?? ref?.entityType;
    const id = ref?.entity_id ?? ref?.entityId;
    if (!id) continue;
    if (type === 'UTILITY_SOURCE' && kindBySource?.has(id)) return kindBySource.get(id);
    if (type === 'CAPACITY_BUDGET' && kindByBudget?.has(id)) return kindByBudget.get(id);
  }
  return null;
}

export const CATALOG_SIZE = CATALOG.length;
export { projectAll };
