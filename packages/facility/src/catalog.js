/**
 * The constraint catalog (doc/tools/site-and-facility/constraint-catalog.md).
 *
 * Every check the tool runs is registered here once. A diagnostic references one
 * of these identifiers and nothing else: the catalog is the stable registry, so
 * downstream filters, waivers, exports, and the assistant can link
 * deterministically, and a retired check keeps its identifier forever.
 *
 * `evidence` is the applicability key. A check runs only when the revision
 * actually contains its evidence, and a check whose evidence is absent is
 * recorded as **not checked** rather than passed — an empty result is never
 * evidence that a check succeeded (verification-requirements.md, "Coverage
 * Derivation"). The consequence is deliberate: a capability cannot reach
 * `VALIDATED` while any of its checks have gone unrun.
 */

export const CAPABILITIES = Object.freeze([
  'GEOMETRY', 'POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY', 'ENVIRONMENT', 'PHASING',
]);

/** Resource kinds that gate a capability of the same name. */
export const RESOURCE_CAPABILITIES = Object.freeze(['POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY']);

export const SEVERITIES = Object.freeze(['ERROR', 'WARNING', 'INFO']);

/** `BOTH` runs locally and in the batch; `FULL` runs only in the batch. */
export const SCOPES = Object.freeze(['BOTH', 'FULL']);

/**
 * `phase` is when a check runs. Validation-time checks gate coverage and the
 * `DRAFT` to `VALIDATED` transition; publish-time checks gate publication only
 * and are recorded as not checked during a validation run.
 */
const entry = (constraintId, severity, gates, scope, remediation, evidence, rule, implemented = true, phase = 'VALIDATION') =>
  Object.freeze({ constraintId, severity, gates, scope, remediation, evidence, rule, implemented, phase });

const CAPACITY = [
  entry('facility.utility.source.capacity_missing', 'ERROR', 'RESOURCE', 'BOTH', 'ADD_DATA', 'sources', 'Utility source capacity is undeclared.'),
  entry('facility.utility.source.negative_capacity', 'ERROR', 'RESOURCE', 'BOTH', 'CORRECT_GEOMETRY', 'sources', 'Capacity value is zero or negative where a positive value is required.'),
  entry('facility.utility.source.state_not_firm', 'WARNING', 'RESOURCE', 'BOTH', 'ADD_DATA', 'sources', 'Availability relies on non-firm capacity state.'),
  entry('facility.utility.source.availability_after_phase', 'ERROR', 'PHASING', 'FULL', 'ADJUST_PHASE', 'sources', 'Source availability date is later than the phase that consumes it.'),
  entry('facility.utility.interface.source_undefined', 'ERROR', 'RESOURCE', 'BOTH', 'ADD_DATA', 'interfaces', 'Interface references a missing or cross-project utility source.'),
  entry('facility.utility.interface.connectivity_missing', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'interfaces', 'Interface has no CONNECTION_POINT geometry.'),
  entry('facility.utility.interface.redefines_source', 'ERROR', 'RESOURCE', 'FULL', 'RESOLVE_CONFLICT', 'interfaces', 'Interface redefines source capacity state, basis, or failure domain.'),
  entry('facility.utility.route.disconnected', 'WARNING', 'GEOMETRY', 'FULL', 'CORRECT_GEOMETRY', 'routes', 'Site utility corridor does not reach its declared connection points.'),
  entry('facility.capacity.budget.overcommit', 'ERROR', 'RESOURCE', 'FULL', 'UPDATE_CAPACITY', 'budgets', 'Allocated demand exceeds firm capacity after derating and reserve.'),
  entry('facility.capacity.budget.duplicate', 'ERROR', 'RESOURCE', 'FULL', 'RESOLVE_CONFLICT', 'budgets', 'More than one budget exists for the same owner, phase, resource, and basis.'),
  entry('facility.capacity.allocation.basis_mismatch', 'ERROR', 'RESOURCE', 'BOTH', 'UPDATE_CAPACITY', 'allocations', 'Allocation basis does not match its budget basis.'),
  entry('facility.capacity.allocation.phase_mismatch', 'ERROR', 'PHASING', 'BOTH', 'ADJUST_PHASE', 'allocations', 'Allocation phase does not match its budget phase.'),
  entry('facility.capacity.allocation.provisional_gate', 'ERROR', 'RESOURCE', 'FULL', 'OBTAIN_APPROVAL', 'allocations', 'A PROVISIONAL allocation is used to satisfy a hard gate.'),
  entry('facility.capacity.reserve.eroded', 'ERROR', 'RESOURCE', 'FULL', 'UPDATE_CAPACITY', 'budgets', 'Reserve policy quantity is not held.'),
  entry('facility.capacity.derating.undefined', 'WARNING', 'RESOURCE', 'FULL', 'REVIEW_POLICY', 'budgets', 'Firm capacity relies on derating without a policy reference.'),
  entry('facility.capacity.planned.firm_claim', 'WARNING', 'RESOURCE', 'FULL', 'ADD_DATA', 'budgets', 'A firm-capacity claim depends on planned capacity.'),
  entry('facility.interface.allocation.exceeded', 'ERROR', 'RESOURCE', 'FULL', 'UPDATE_CAPACITY', 'demand', 'Downstream request exceeds its allocated envelope.'),
  entry('facility.interface.entity_invalid', 'ERROR', 'GEOMETRY', 'BOTH', 'ADD_DATA', 'demand', 'Downstream reference does not resolve to a facility entity in this revision.'),
  entry('facility.interface.request.provisional', 'WARNING', 'RESOURCE', 'FULL', 'OBTAIN_APPROVAL', 'demand', 'Downstream request is provisional.'),
];

const RESILIENCE = [
  entry('facility.resilience.failure_domain.missing', 'WARNING', 'RESOURCE', 'FULL', 'RECONFIGURE_RESILIENCE', 'requirements', 'A required independent path has no declared failure domain.'),
  entry('facility.resilience.failure_domain.shared', 'ERROR', 'RESOURCE', 'FULL', 'RECONFIGURE_RESILIENCE', 'requirements', 'Paths required to be independent share a prohibited failure-domain ancestor.'),
  entry('facility.resilience.failure_domain.cycle', 'ERROR', 'RESOURCE', 'FULL', 'RESOLVE_CONFLICT', 'domains', 'Failure-domain containment is cyclic.'),
  entry('facility.resilience.availability_policy.violated', 'ERROR', 'RESOURCE', 'FULL', 'RECONFIGURE_RESILIENCE', 'requirements', 'A resource kind the policy names has no supplying path.'),
  entry('facility.resilience.availability_policy.unresolved', 'WARNING', 'RESOURCE', 'FULL', 'REVIEW_POLICY', 'requirements', 'Availability policy reference is missing or has no version.'),
  entry('facility.resilience.fuel_duration.insufficient', 'ERROR', 'FUEL', 'FULL', 'RECONFIGURE_RESILIENCE', 'requirements', 'Fuel autonomy is shorter than the policy requires.'),
  entry('facility.resilience.water_duration.insufficient', 'ERROR', 'WATER', 'FULL', 'RECONFIGURE_RESILIENCE', 'requirements', 'Water autonomy is shorter than the policy requires.'),
  entry('facility.resilience.redundancy.path_count', 'ERROR', 'RESOURCE', 'FULL', 'RECONFIGURE_RESILIENCE', 'requirements', 'Independent path count is below the policy requirement.'),
];

const ENVIRONMENT = [
  entry('facility.environment.design_weather.missing', 'WARNING', 'ENVIRONMENT', 'FULL', 'ADD_DATA', 'envelope', 'No design-weather reference is declared.'),
  entry('facility.environment.permit.exceeded', 'ERROR', 'ENVIRONMENT', 'FULL', 'OBTAIN_APPROVAL', 'envConstraints', 'A declared permit constraint is exceeded.', false),
  entry('facility.environment.water.envelope_missing', 'WARNING', 'WATER', 'FULL', 'ADD_DATA', 'envelope', 'Water availability or permit envelope is undeclared.'),
  entry('facility.environment.hazard.mitigation_missing', 'ERROR', 'ENVIRONMENT', 'FULL', 'ADD_DATA', 'envConstraints', 'A policy-required hazard mitigation is absent.', false),
  entry('facility.environment.emissions.exceeded', 'ERROR', 'ENVIRONMENT', 'FULL', 'OBTAIN_APPROVAL', 'envConstraints', 'Declared emissions limit is exceeded.', false),
  entry('facility.environment.profile.out_of_scope', 'ERROR', 'ENVIRONMENT', 'FULL', 'RESOLVE_CONFLICT', 'profiles', 'Environmental profile is applied outside its site or effective period.'),
  entry('facility.environment.constraint.basis_missing', 'ERROR', 'ENVIRONMENT', 'BOTH', 'ADD_DATA', 'envConstraints', 'Constraint has no declared unit or basis.'),
];

const PHASING = [
  entry('facility.phase.dependency.cycle', 'ERROR', 'PHASING', 'FULL', 'ADJUST_PHASE', 'phaseDeps', 'Phase dependency graph contains a cycle.'),
  entry('facility.phase.dependency.duplicate', 'ERROR', 'PHASING', 'FULL', 'RESOLVE_CONFLICT', 'phaseDeps', 'Duplicate phase dependency edge.'),
  entry('facility.phase.dependency.self', 'ERROR', 'PHASING', 'FULL', 'ADJUST_PHASE', 'phaseDeps', 'Phase depends on itself.'),
  entry('facility.phase.capability.before_commissioned', 'ERROR', 'PHASING', 'FULL', 'ADJUST_PHASE', 'phases', 'A phase consumes capability before it is commissioned.'),
  entry('facility.phase.capacity.future_reserved_consumed', 'ERROR', 'PHASING', 'FULL', 'ADJUST_PHASE', 'budgets', 'A phase consumes capacity reserved for a later phase.'),
  entry('facility.phase.date.unconfirmed', 'WARNING', 'PHASING', 'FULL', 'ADD_DATA', 'phases', 'Phase date or precision is not confirmed.'),
];

const DATA = [
  entry('facility.data.entity.required', 'ERROR', 'GEOMETRY', 'BOTH', 'ADD_DATA', 'envelope', 'A required entity for the declared design scope is absent.'),
  entry('facility.data.id.duplicate', 'ERROR', 'GEOMETRY', 'FULL', 'RESOLVE_CONFLICT', 'entities', 'Duplicate stable ID within a revision.'),
  entry('facility.data.crs.missing', 'ERROR', 'GEOMETRY', 'BOTH', 'ADD_DATA', 'geometry', 'Geometry has no declared coordinate reference system.'),
  entry('facility.data.units.missing', 'ERROR', 'GEOMETRY', 'BOTH', 'ADD_DATA', 'quantities', 'Quantity has no unit or basis.'),
  entry('facility.data.geometry.invalid', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'geometry', 'Geometry is topologically invalid.'),
  entry('facility.data.geometry.self_intersection', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'geometry', 'Polygon ring self-intersects.'),
  entry('facility.data.geometry.type_mismatch', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'geometry', 'Geometry type does not match the declared role.'),
  entry('facility.data.geometry.role_missing', 'ERROR', 'GEOMETRY', 'BOTH', 'ADD_DATA', 'entities', 'Required geometry role is absent for the entity kind.'),
  entry('facility.data.transform.unreviewed', 'WARNING', 'GEOMETRY', 'BOTH', 'REVIEW_IMPORT', 'geometry', 'Local geometry transform is unreviewed.'),
  entry('facility.data.provenance.missing', 'ERROR', 'GEOMETRY', 'BOTH', 'ADD_DATA', 'geometry', 'Authoritative value has no provenance.'),
  entry('facility.data.provenance.stale', 'WARNING', 'GEOMETRY', 'FULL', 'ADD_DATA', 'geometry', 'Value is older than the project staleness threshold.'),
  entry('facility.data.assumption.unresolved', 'WARNING', 'GEOMETRY', 'FULL', 'ADD_DATA', 'assumptions', 'An active assumption remains unresolved.'),
  entry('facility.data.entity.parent_cycle', 'ERROR', 'GEOMETRY', 'FULL', 'RESOLVE_CONFLICT', 'containers', 'Container hierarchy contains a cycle.'),
  entry('facility.data.entity.parent_cross_scope', 'ERROR', 'GEOMETRY', 'FULL', 'RESOLVE_CONFLICT', 'containers', 'Parent/child link crosses scope or revision.'),
];

const SITE = [
  entry('facility.site.container.outside_parent', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'containers', 'Building or equipment lies outside its parcel.'),
  entry('facility.site.container.overlap', 'WARNING', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'containers', 'Containers overlap where overlap is prohibited.'),
  entry('facility.site.setback.violated', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'spatialConstraints', 'Footprint violates a setback constraint.'),
  entry('facility.site.easement.violated', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'spatialConstraints', 'Footprint or equipment falls within an easement.'),
  entry('facility.site.access_route.blocked', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'routes', 'Access route is blocked by a container or exclusion zone.'),
  entry('facility.site.height.exceeded', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'spatialConstraints', 'Height limit exceeded.'),
  entry('facility.site.hazard.excluded', 'ERROR', 'GEOMETRY', 'BOTH', 'CORRECT_GEOMETRY', 'spatialConstraints', 'Placement falls inside a hazard or exclusion zone.'),
  entry('facility.site.constraint.rule_missing', 'ERROR', 'GEOMETRY', 'FULL', 'REVIEW_POLICY', 'spatialConstraints', 'Regulatory or hazard constraint has no rule or provenance reference.'),
  entry('facility.site.constraint.geometry_missing', 'ERROR', 'GEOMETRY', 'BOTH', 'ADD_DATA', 'spatialConstraints', 'Constraint has no linked geometry where geometry is required.'),
];

const IMPORT = [
  entry('facility.import.mapping.unresolved', 'ERROR', 'GEOMETRY', 'FULL', 'REVIEW_IMPORT', 'mappings', 'A required mapping matches no source feature.'),
  entry('facility.import.mapping.ambiguous', 'WARNING', 'GEOMETRY', 'BOTH', 'REVIEW_IMPORT', 'mappings', 'A selector matches more than one normalized target where cardinality is one-to-one.'),
  entry('facility.import.geometry.out_of_bounds', 'ERROR', 'GEOMETRY', 'BOTH', 'REVIEW_IMPORT', 'bindings', 'Imported geometry falls outside the design scope.'),
];

const GOVERNANCE = [
  entry('facility.revision.current', 'ERROR', 'PUBLICATION', 'BOTH', 'ADD_DATA', 'envelope', 'Request targets a revision that is not the current draft.'),
  entry('facility.revision.publish.requires_validation', 'ERROR', 'PUBLICATION', 'FULL', 'OBTAIN_APPROVAL', 'envelope', 'Publication attempted for a revision without a clean validation run.', true, 'PUBLISH'),
  entry('facility.revision.publish.source_unpinned', 'ERROR', 'PUBLICATION', 'FULL', 'ADD_DATA', 'bindings', 'A source document or policy is not pinned.', true, 'PUBLISH'),
  entry('facility.revision.writes_immutable', 'ERROR', 'PUBLICATION', 'FULL', 'RESOLVE_CONFLICT', 'envelope', 'A write targeted a VALIDATED or PUBLISHED revision.'),
  entry('facility.governance.approval.required', 'ERROR', 'PUBLICATION', 'FULL', 'OBTAIN_APPROVAL', 'envelope', 'Deployment policy requires an approval attestation that does not exist.', true, 'PUBLISH'),
  entry('facility.governance.waiver.expired', 'WARNING', 'PUBLICATION', 'FULL', 'OBTAIN_APPROVAL', 'waivers', 'A waiver that gated this revision has expired.', true, 'PUBLISH'),
  entry('facility.governance.waiver.scope_mismatch', 'ERROR', 'PUBLICATION', 'FULL', 'OBTAIN_APPROVAL', 'waivers', 'Waiver does not cover the referenced diagnostic or revision.', true, 'PUBLISH'),
  entry('facility.governance.attestation.revoked', 'ERROR', 'PUBLICATION', 'FULL', 'OBTAIN_APPROVAL', 'attestations', 'The governing approval attestation was revoked.', true, 'PUBLISH'),
];

/** Ordered by domain, matching the catalog document. */
export const CATALOG = Object.freeze([
  ...CAPACITY, ...RESILIENCE, ...ENVIRONMENT, ...PHASING, ...DATA, ...SITE, ...IMPORT, ...GOVERNANCE,
]);

export const CONSTRAINT_IDS = Object.freeze(CATALOG.map((item) => item.constraintId));

const BY_ID = new Map(CATALOG.map((item) => [item.constraintId, item]));

export function getConstraint(constraintId) {
  return BY_ID.get(constraintId) ?? null;
}

export function isConstraintId(constraintId) {
  return BY_ID.has(constraintId);
}

/** Every catalog entry a run of this scope must consider. */
export function constraintsForScope(scope) {
  return scope === 'AFFECTED_SUBGRAPH' ? CATALOG.filter((item) => item.scope === 'BOTH') : CATALOG;
}

/** The evidence bucket a check needs before it can run at all. */
export const EVIDENCE_BUCKETS = Object.freeze([
  'envelope', 'entities', 'containers', 'geometry', 'routes', 'spatialConstraints', 'quantities',
  'sources', 'interfaces', 'budgets', 'allocations', 'demand', 'reserves', 'requirements', 'domains',
  'phases', 'phaseDeps', 'profiles', 'envConstraints', 'assumptions', 'waivers', 'attestations',
  'bindings', 'mappings',
]);
