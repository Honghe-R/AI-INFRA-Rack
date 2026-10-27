/**
 * The revision-scoped store reads, in one place.
 *
 * Both consumers of a revision's graph go through this module: the validation
 * engine's snapshot loader (`context.js`, which runs all of them for one run) and
 * the tool surface (`tools/`, which runs the one a tool needs). A second copy of
 * these statements would be a second answer to "what is in this revision", and
 * the two would drift the first time a column moved.
 *
 * Every statement is scoped by `project_id` and `revision_id` ($1, $2) and the
 * row-level security policy applies to both callers, so a revision read is
 * tenant-isolated by construction rather than by remembering to filter.
 *
 * Ordering is part of the contract, not an accident: a tool's determinism
 * requirement and a check's determinism requirement are the same requirement.
 * Two statements were previously unordered and now carry an explicit sort.
 */

/** Envelope identity for one revision. */
export const ENVELOPE_SQL = `
  SELECT envelope_id, project_id, scenario_id, revision_id, lifecycle_state, approval_state,
         content_checksum, validation_run_id, created_at, updated_at
    FROM facility_envelopes
   WHERE project_id = $1 AND revision_id = $2`;

/**
 * Store key -> statement. The key is the same noun the checks and the evidence
 * buckets use, so a tool declares the store it reads by that name.
 */
export const REVISION_STORES = Object.freeze({
  scopes: `
    SELECT scope_id, entity_type, scope_kind, name, jurisdiction, parent_scope_id, provenance
      FROM design_scopes WHERE project_id = $1 AND revision_id = $2 ORDER BY name, scope_id`,

  containers: `
    SELECT container_id, scope_id, parent_container_id, phase_id, kind, entity_type, name, level_number,
           status, elevation_base_m, elevation_top_m, provenance, created_at
      FROM facility_containers WHERE project_id = $1 AND revision_id = $2 ORDER BY kind, name, container_id`,

  geometry: `
    SELECT geometry_id, entity_id, entity_type, role, ordinal, geometry_type, projected_crs, vertical_crs,
           parent_transform_id, elevation_base_m, elevation_top_m, height_m, provenance, created_at
      FROM geometry_records WHERE project_id = $1 AND revision_id = $2
     ORDER BY entity_type, role, ordinal, geometry_id`,

  spatialConstraints: `
    SELECT constraint_id, scope_id, container_id, applies_to_geometry_id, kind, severity, rule_kind,
           rule_value, rule_unit, provenance, created_at
      FROM spatial_constraints WHERE project_id = $1 AND revision_id = $2 ORDER BY kind, constraint_id`,

  // The display name is the one handle a caller can reproduce. A model copies a label
  // and not an id, and without this join a utility read returned four sources and four
  // interfaces that were distinguishable only by an opaque identifier — so "move the
  // Central Chiller Plant" could not be told from "move the Carrier Meet-Me Room", and
  // the entity-reference pass, which pairs an id with a label, collected nothing.
  sources: `
    SELECT s.utility_source_id, s.kind, s.capacity_value, s.capacity_unit, s.capacity_basis, s.capacity_state,
           s.failure_domain_id, s.phase_id, s.available_from, s.provenance, e.display_name
      FROM utility_sources s
      LEFT JOIN entity_registry e
        ON e.entity_id = s.utility_source_id AND e.project_id = s.project_id AND e.revision_id = s.revision_id
     WHERE s.project_id = $1 AND s.revision_id = $2 ORDER BY s.kind, s.utility_source_id`,

  interfaces: `
    SELECT i.interface_id, i.utility_source_id, i.capacity_value, i.capacity_unit, i.capacity_basis, i.capacity_state,
           i.service_state, i.failure_domain_id, i.phase_id, i.available_from, i.provenance, e.display_name
      FROM utility_interfaces i
      LEFT JOIN entity_registry e
        ON e.entity_id = i.interface_id AND e.project_id = i.project_id AND e.revision_id = i.revision_id
     WHERE i.project_id = $1 AND i.revision_id = $2 ORDER BY i.interface_id`,

  budgets: `
    SELECT budget_id, owner_entity_id, phase_id, utility_interface_id, resource_kind, basis, unit,
           commissioned_value, planned_value, reserved_value, allocated_value, available_value,
           derating_factor, provenance
      FROM capacity_budgets WHERE project_id = $1 AND revision_id = $2 ORDER BY budget_id`,

  allocations: `
    SELECT allocation_id, budget_id, demand_request_id, quantity_value, quantity_unit, quantity_basis,
           quantity_state, state, valid_from
      FROM capacity_allocations WHERE project_id = $1 AND revision_id = $2 ORDER BY allocation_id`,

  demand: `
    SELECT request_id, consumer_type, consumer_id, phase_id, resource_kind, requested_value, requested_unit,
           requested_basis, requested_state, required_from, priority, provenance
      FROM capacity_demand_requests WHERE project_id = $1 AND revision_id = $2 ORDER BY request_id`,

  reserves: `
    SELECT storage_id, kind, capacity_value, capacity_unit, capacity_basis, capacity_state,
           autonomy_duration_seconds, failure_domain_id, phase_id
      FROM storage_reserves WHERE project_id = $1 AND revision_id = $2 ORDER BY kind, storage_id`,

  // `resource_kind[]` is a custom type, which node-postgres hands back as the raw
  // array literal; the text[] cast is what makes it a real array.
  requirements: `
    SELECT requirement_id, availability_policy, policy_id, applies_to::text[] AS applies_to,
           autonomy_duration_seconds, active, provenance
      FROM resilience_requirements WHERE project_id = $1 AND revision_id = $2
     ORDER BY created_at, requirement_id`,

  domains: `
    SELECT failure_domain_id, parent_failure_domain_id, name, kind
      FROM failure_domains WHERE project_id = $1 AND revision_id = $2 ORDER BY name, failure_domain_id`,

  phases: `
    SELECT phase_id, name, phase_order, activation_date, activation_date_precision, status
      FROM facility_phases WHERE project_id = $1 AND revision_id = $2 ORDER BY phase_order, phase_id`,

  phaseDeps: `
    SELECT predecessor_phase_id, successor_phase_id
      FROM phase_dependencies WHERE project_id = $1 AND revision_id = $2
     ORDER BY predecessor_phase_id, successor_phase_id`,

  phaseAvailability: `
    SELECT phase_id, capability, available, available_from, notes
      FROM phase_capability_availability WHERE project_id = $1 AND revision_id = $2
     ORDER BY phase_id, capability`,

  profiles: `
    SELECT profile_id, site_scope_id, design_weather_ref, hazard_classifications, permit_constraints,
           operating_ranges, effective_at, effective_until
      FROM environmental_profiles WHERE project_id = $1 AND revision_id = $2 ORDER BY effective_at`,

  envConstraints: `
    SELECT environmental_constraint_id, profile_id, affected_entity_id, applies_to_geometry_id,
           constraint_kind, threshold_value, threshold_unit, basis, effective_at, effective_until,
           provenance
      FROM environmental_constraints WHERE project_id = $1 AND revision_id = $2 ORDER BY constraint_kind`,

  assumptions: `
    SELECT assumption_id, statement, owner, confidence, effective_at, expires_at, status, entity_refs
      FROM assumptions WHERE project_id = $1 AND revision_id = $2 ORDER BY assumption_id`,

  waivers: `
    SELECT waiver_id, diagnostic_ids, scope, policy_id, reason, granted_at, expires_at, status
      FROM waivers WHERE project_id = $1 AND revision_id = $2 ORDER BY created_at, waiver_id`,

  attestations: `
    SELECT attestation_id, approver_id, policy_id, decision, approved_at, comment
      FROM approval_attestations WHERE project_id = $1 AND revision_id = $2
     ORDER BY created_at, attestation_id`,

  bindings: `
    SELECT binding_id, asset_version_id, representation_id, transform_id, role, status, mapping_ids
      FROM asset_bindings WHERE project_id = $1 AND revision_id = $2 ORDER BY binding_id`,

  mappings: `
    SELECT mapping_id, binding_id, asset_version_id, transform_id, source_selector, target_entity_type,
           target_geometry_role, cardinality, required, review_state
      FROM import_mappings WHERE project_id = $1 AND revision_id = $2 ORDER BY mapping_id`,

  entities: `
    SELECT entity_id, entity_type, status, display_name
      FROM entity_registry WHERE project_id = $1 AND revision_id = $2 ORDER BY entity_type, entity_id`,

  revisions: `
    SELECT revision_id, scenario_id, name, lifecycle_state, content_checksum, created_at, updated_at
      FROM revisions WHERE project_id = $1 AND revision_id = $2`,

  diagnostics: `
    SELECT diagnostic_id, validation_run_id, constraint_id, severity, status, entity_refs, geometry_refs,
           source_values, computed, remediation_category, remediation_hint, policy_ref,
           supersedes_diagnostic_id, created_at
      FROM facility_diagnostics WHERE project_id = $1 AND revision_id = $2
     ORDER BY severity, constraint_id, created_at, diagnostic_id`,

  coverage: `
    SELECT capability, status, evidence_refs, reviewed_at
      FROM capability_coverage WHERE project_id = $1 AND revision_id = $2 ORDER BY capability`,

  validationRuns: `
    SELECT validation_run_id, revision_id, scope, status, base_etag,
           requested_capabilities::text[] AS requested_capabilities,
           checked_capabilities::text[] AS checked_capabilities,
           not_checked_capabilities::text[] AS not_checked_capabilities,
           error_count, warning_count, started_at, completed_at, created_at
      FROM validation_runs WHERE project_id = $1 AND revision_id = $2
     ORDER BY created_at DESC, validation_run_id`,

  impactNotices: `
    SELECT impact_notice_id, previous_revision_id, revision_id, changed_entity_refs,
           invalidated_consumer_types, issued_at, created_at
      FROM impact_notices WHERE project_id = $1 AND revision_id = $2
     ORDER BY created_at DESC, impact_notice_id`,

  /**
   * The revision's recorded activity, newest first.
   *
   * `outbox_events` is the only change history the store keeps ([D-A] in
   * `doc/authoring-plan.md`): a draft is edited in place, so there are no per-edit
   * revisions to diff and one commit is one `facility.revision.changed.v1` row. Reading
   * it is a revision-scoped read, not the event *delivery* D-B defers — nothing here is
   * consumed, published, or dispatched.
   *
   * The table is range-partitioned on `created_at`, so a predicate on `revision_id`
   * cannot prune partitions; `outbox_events_revision_idx` serves the scan within each
   * one, and the read is bounded by the page.
   */
  activity: `
    SELECT event_id, event_type, revision_id, aggregate_type, aggregate_id, payload,
           correlation_id, occurred_at, created_at, created_by
      FROM outbox_events WHERE project_id = $1 AND revision_id = $2
     ORDER BY occurred_at DESC, event_id DESC`,
});

export const REVISION_STORE_KEYS = Object.freeze(Object.keys(REVISION_STORES));

/** The evidence-bucket name a store populates, where the two names differ. */
export const STORE_EVIDENCE_BUCKET = Object.freeze({
  scopes: 'envelope',
  phaseAvailability: 'phases',
});

/** Runs one store statement for a revision on an already tenant-scoped client. */
export async function readStore({ client, projectId, revisionId, store }) {
  const sql = REVISION_STORES[store];
  if (!sql) throw new Error(`Unknown revision store "${store}".`);
  const { rows } = await client.query(sql, [projectId, revisionId]);
  return rows;
}

/** Runs several stores in parallel; returns them keyed by store name. */
export async function readStores({ client, projectId, revisionId, stores }) {
  const entries = await Promise.all(
    stores.map(async (store) => [store, await readStore({ client, projectId, revisionId, store })]),
  );
  return Object.fromEntries(entries);
}

export async function readEnvelope({ client, projectId, revisionId }) {
  const { rows } = await client.query(ENVELOPE_SQL, [projectId, revisionId]);
  return rows[0] ?? null;
}
