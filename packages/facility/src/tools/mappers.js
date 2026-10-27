/**
 * Store rows to normalized tool results.
 *
 * The stores keep snake_case columns and the surface returns camelCase, because
 * the surface is what a browser and a model consume while the stores are the
 * tool's own domain shape. The mapping lives here, once, rather than in each
 * transport's adapter — a second mapper is how two consumers start describing the
 * same row differently.
 *
 * Every mapper is a field list, so a column that is not listed is deliberately
 * not exposed. That is the redaction boundary as much as a naming convention.
 */

/** Projects a row through an output->column field spec. */
export function project(row, spec) {
  const out = {};
  for (const [outKey, column] of Object.entries(spec)) out[outKey] = row?.[column] ?? null;
  return out;
}

export function projectAll(rows, spec) {
  return rows.map((row) => project(row, spec));
}

const SCOPE = {
  scopeId: 'scope_id',
  entityType: 'entity_type',
  scopeKind: 'scope_kind',
  name: 'name',
  jurisdiction: 'jurisdiction',
  parentScopeId: 'parent_scope_id',
  provenance: 'provenance',
};

const ENTITY = {
  entityId: 'entity_id',
  entityType: 'entity_type',
  status: 'status',
  displayName: 'display_name',
};

const CONTAINER = {
  containerId: 'container_id',
  scopeId: 'scope_id',
  parentContainerId: 'parent_container_id',
  phaseId: 'phase_id',
  kind: 'kind',
  entityType: 'entity_type',
  name: 'name',
  levelNumber: 'level_number',
  status: 'status',
  elevationBaseM: 'elevation_base_m',
  elevationTopM: 'elevation_top_m',
  provenance: 'provenance',
  createdAt: 'created_at',
};

const GEOMETRY = {
  geometryId: 'geometry_id',
  entityId: 'entity_id',
  entityType: 'entity_type',
  role: 'role',
  ordinal: 'ordinal',
  geometryType: 'geometry_type',
  projectedCrs: 'projected_crs',
  verticalCrs: 'vertical_crs',
  parentTransformId: 'parent_transform_id',
  elevationBaseM: 'elevation_base_m',
  elevationTopM: 'elevation_top_m',
  heightM: 'height_m',
  provenance: 'provenance',
  createdAt: 'created_at',
};

const SPATIAL_CONSTRAINT = {
  constraintId: 'constraint_id',
  scopeId: 'scope_id',
  containerId: 'container_id',
  appliesToGeometryId: 'applies_to_geometry_id',
  kind: 'kind',
  severity: 'severity',
  ruleKind: 'rule_kind',
  ruleValue: 'rule_value',
  ruleUnit: 'rule_unit',
  provenance: 'provenance',
  createdAt: 'created_at',
};

const SOURCE = {
  utilitySourceId: 'utility_source_id',
  kind: 'kind',
  capacityValue: 'capacity_value',
  capacityUnit: 'capacity_unit',
  capacityBasis: 'capacity_basis',
  capacityState: 'capacity_state',
  failureDomainId: 'failure_domain_id',
  phaseId: 'phase_id',
  availableFrom: 'available_from',
  provenance: 'provenance',
  displayName: 'display_name',
};

const INTERFACE = {
  interfaceId: 'interface_id',
  utilitySourceId: 'utility_source_id',
  capacityValue: 'capacity_value',
  capacityUnit: 'capacity_unit',
  capacityBasis: 'capacity_basis',
  capacityState: 'capacity_state',
  serviceState: 'service_state',
  failureDomainId: 'failure_domain_id',
  phaseId: 'phase_id',
  availableFrom: 'available_from',
  provenance: 'provenance',
  displayName: 'display_name',
};

const BUDGET = {
  budgetId: 'budget_id',
  ownerEntityId: 'owner_entity_id',
  phaseId: 'phase_id',
  utilityInterfaceId: 'utility_interface_id',
  resourceKind: 'resource_kind',
  basis: 'basis',
  unit: 'unit',
  commissionedValue: 'commissioned_value',
  plannedValue: 'planned_value',
  reservedValue: 'reserved_value',
  allocatedValue: 'allocated_value',
  availableValue: 'available_value',
  deratingFactor: 'derating_factor',
  provenance: 'provenance',
};

const ALLOCATION = {
  allocationId: 'allocation_id',
  budgetId: 'budget_id',
  demandRequestId: 'demand_request_id',
  quantityValue: 'quantity_value',
  quantityUnit: 'quantity_unit',
  quantityBasis: 'quantity_basis',
  quantityState: 'quantity_state',
  state: 'state',
  validFrom: 'valid_from',
};

const DEMAND = {
  requestId: 'request_id',
  consumerType: 'consumer_type',
  consumerId: 'consumer_id',
  phaseId: 'phase_id',
  resourceKind: 'resource_kind',
  requestedValue: 'requested_value',
  requestedUnit: 'requested_unit',
  requestedBasis: 'requested_basis',
  requestedState: 'requested_state',
  requiredFrom: 'required_from',
  priority: 'priority',
  provenance: 'provenance',
};

const RESERVE = {
  storageId: 'storage_id',
  kind: 'kind',
  capacityValue: 'capacity_value',
  capacityUnit: 'capacity_unit',
  capacityBasis: 'capacity_basis',
  capacityState: 'capacity_state',
  autonomyDurationSeconds: 'autonomy_duration_seconds',
  failureDomainId: 'failure_domain_id',
  phaseId: 'phase_id',
};

const DOMAIN = {
  failureDomainId: 'failure_domain_id',
  parentFailureDomainId: 'parent_failure_domain_id',
  name: 'name',
  kind: 'kind',
};

const PHASE = {
  phaseId: 'phase_id',
  name: 'name',
  phaseOrder: 'phase_order',
  activationDate: 'activation_date',
  activationDatePrecision: 'activation_date_precision',
  status: 'status',
};

const PHASE_AVAILABILITY = {
  phaseId: 'phase_id',
  capability: 'capability',
  available: 'available',
  availableFrom: 'available_from',
  notes: 'notes',
};

const PROFILE = {
  profileId: 'profile_id',
  siteScopeId: 'site_scope_id',
  designWeatherRef: 'design_weather_ref',
  hazardClassifications: 'hazard_classifications',
  permitConstraints: 'permit_constraints',
  operatingRanges: 'operating_ranges',
  effectiveAt: 'effective_at',
  effectiveUntil: 'effective_until',
};

const ENV_CONSTRAINT = {
  environmentalConstraintId: 'environmental_constraint_id',
  profileId: 'profile_id',
  affectedEntityId: 'affected_entity_id',
  appliesToGeometryId: 'applies_to_geometry_id',
  constraintKind: 'constraint_kind',
  thresholdValue: 'threshold_value',
  thresholdUnit: 'threshold_unit',
  basis: 'basis',
  effectiveAt: 'effective_at',
  effectiveUntil: 'effective_until',
  provenance: 'provenance',
};

const ASSUMPTION = {
  assumptionId: 'assumption_id',
  statement: 'statement',
  owner: 'owner',
  confidence: 'confidence',
  effectiveAt: 'effective_at',
  expiresAt: 'expires_at',
  status: 'status',
  entityRefs: 'entity_refs',
};

const WAIVER = {
  waiverId: 'waiver_id',
  diagnosticIds: 'diagnostic_ids',
  scope: 'scope',
  policyId: 'policy_id',
  reason: 'reason',
  grantedAt: 'granted_at',
  expiresAt: 'expires_at',
  status: 'status',
};

const ATTESTATION = {
  attestationId: 'attestation_id',
  approverId: 'approver_id',
  policyId: 'policy_id',
  decision: 'decision',
  approvedAt: 'approved_at',
  comment: 'comment',
};

const BINDING = {
  bindingId: 'binding_id',
  assetVersionId: 'asset_version_id',
  representationId: 'representation_id',
  transformId: 'transform_id',
  role: 'role',
  status: 'status',
  mappingIds: 'mapping_ids',
};

const MAPPING = {
  mappingId: 'mapping_id',
  bindingId: 'binding_id',
  assetVersionId: 'asset_version_id',
  transformId: 'transform_id',
  sourceSelector: 'source_selector',
  targetEntityType: 'target_entity_type',
  targetGeometryRole: 'target_geometry_role',
  cardinality: 'cardinality',
  required: 'required',
  reviewState: 'review_state',
};

export const SPECS = Object.freeze({
  scopes: SCOPE,
  entities: ENTITY,
  containers: CONTAINER,
  geometry: GEOMETRY,
  spatialConstraints: SPATIAL_CONSTRAINT,
  sources: SOURCE,
  interfaces: INTERFACE,
  budgets: BUDGET,
  allocations: ALLOCATION,
  demand: DEMAND,
  reserves: RESERVE,
  domains: DOMAIN,
  phases: PHASE,
  phaseAvailability: PHASE_AVAILABILITY,
  profiles: PROFILE,
  envConstraints: ENV_CONSTRAINT,
  assumptions: ASSUMPTION,
  waivers: WAIVER,
  attestations: ATTESTATION,
  bindings: BINDING,
  mappings: MAPPING,
});

/** Projects a store's rows using its registered spec. */
export function projectStore(store, rows) {
  const spec = SPECS[store];
  if (!spec) throw new Error(`No projection is registered for store "${store}".`);
  return projectAll(rows, spec);
}

/** Resilience requirements carry a `resource_kind[]`, cast to a real array in SQL. */
export function projectRequirement(row) {
  return {
    requirementId: row.requirement_id,
    availabilityPolicy: row.availability_policy ?? null,
    policyId: row.policy_id ?? null,
    appliesTo: row.applies_to ?? [],
    autonomyDurationSeconds: row.autonomy_duration_seconds ?? null,
    active: row.active ?? null,
    provenance: row.provenance ?? null,
  };
}

/** Phase dependency edges are pairs, not rows with an identity. */
export function projectPhaseDependency(row) {
  return {
    predecessorPhaseId: row.predecessor_phase_id,
    successorPhaseId: row.successor_phase_id,
  };
}

/** The event type one committed change set writes; the one event `get_revision_activity` interprets. */
export const REVISION_CHANGED_EVENT = 'facility.revision.changed.v1';

/**
 * One recorded activity event.
 *
 * A change-set event is projected into the fields a reader actually asks about — what
 * changed, which entities, which draft version — instead of handing over the raw
 * payload. Any other event keeps its payload, because this read does not model it and
 * inventing change fields for it would report a shape that is not there.
 */
export function projectActivityEvent(row) {
  const base = {
    eventId: row.event_id,
    eventType: row.event_type,
    revisionId: row.revision_id ?? null,
    actorId: row.created_by ?? null,
    correlationId: row.correlation_id ?? null,
    occurredAt: row.occurred_at ?? row.created_at ?? null,
  };
  if (row.event_type !== REVISION_CHANGED_EVENT) return { ...base, payload: row.payload ?? {} };

  const payload = row.payload ?? {};
  return {
    ...base,
    changeSet: {
      previousEtag: payload.previous_etag ?? null,
      etag: payload.new_etag ?? null,
      etagVersion: payload.etag_version ?? null,
      changeKinds: payload.change_kinds ?? [],
      changedEntityRefs: payload.changed_entity_refs ?? [],
    },
  };
}
