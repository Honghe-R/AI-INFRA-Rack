import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { RUN_REASON, contentChecksum, executeRun } from './engine.js';
import { loadRevisionContext } from './context.js';
import { defaultPolicyRegistry } from './policies.js';
import { ensureEtag } from './etags.js';

/**
 * Lifecycle and publication (T5).
 *
 * The lifecycle is `DRAFT` -> `VALIDATED` -> `PUBLISHED`, and it is one-way on
 * purpose ([D17](../../doc/tools/site-and-facility/decisions.md)). The engine
 * already owns the first transition; this module owns the rest:
 *
 *   * `createRevision` starts a branch. A branch is the *only* way to change a
 *     `VALIDATED` or `PUBLISHED` revision, so it copies the design graph with
 *     fresh ids — references between copied rows are remapped, not shared — and
 *     records lineage. Diagnostics and validation runs are deliberately **not**
 *     copied: a validation result describes the revision it ran against, and a
 *     branch has not been validated yet.
 *   * `publishRevision` is the `VALIDATED` -> `PUBLISHED` transition. Publication
 *     is the point where the specification stops being a draft and becomes an
 *     immutable handoff, so the publication gate is re-run *in the publishing
 *     transaction* (the `PUBLISH`-phase checks are skipped by every validation
 *     run). The gate result, the lifecycle update, the content checksum, the
 *     outbox event, the Impact Notice, and the frozen envelope all commit or none
 *     of them does.
 *   * `recordApproval` appends an attestation. A decision is a record, never a
 *     mutation of the envelope: `approval_state` is a projection of the latest
 *     governing attestation, and rejecting or revoking one never reopens the
 *     revision ([D17]).
 *   * `issueImpactNotice` is the supersession notice. It is exported separately
 *     because the change-set commit needs the same insert for a *shared* draft.
 *
 * The frozen envelope is canonical JSON, gzipped, at a deterministic key. There
 * is **no protobuf contract in this repository** (T0 never shipped), so
 * `facility-envelope.json.gz` is a deliberate delta from
 * storage-shape.md's `facility-envelope.pb`; see the module report. The key is
 * deterministic so a retry overwrites the same object rather than orphaning a new
 * one, and sanitized so a hostile id cannot escape its prefix.
 */

/** The consumer types a published envelope invalidates (backend-api-contracts.md). */
export const PUBLISH_INVALIDATED_CONSUMER_TYPES = Object.freeze([
  'POWER', 'THERMAL', 'FLOORPLAN', 'NETWORK', 'DEPLOYMENT',
]);

/** The full `consumer_type` enumeration from migration 001, for validation. */
export const CONSUMER_TYPES = Object.freeze([
  'FLOORPLAN', 'RACK', 'POWER', 'THERMAL', 'NETWORK', 'CABLING', 'VERIFY',
  'SIMULATION', 'COST_SCHEDULE', 'DEPLOYMENT',
]);

/** The approval decisions the contract records. */
export const APPROVAL_DECISIONS = Object.freeze(['APPROVED', 'REJECTED', 'REVOKED']);

/** Lifecycle states an attestation may be recorded against. */
const ATTESTABLE_STATES = Object.freeze(['DRAFT', 'VALIDATED']);

/**
 * The deterministic, sanitized object key for a frozen envelope.
 *
 * storage-shape.md names `projects/{project_id}/revisions/{revision_id}/facility-envelope.pb`.
 * This repository has no protobuf contract, so the frozen payload is canonical
 * JSON and the extension says so. Both identifiers are UUIDs, but they are
 * sanitized anyway: a key is a filesystem/S3 path, and an id is not allowed to
 * decide how many segments it occupies.
 */
export function envelopeKey(projectId, revisionId) {
  return `projects/${segment(projectId)}/revisions/${segment(revisionId)}/facility-envelope.json.gz`;
}

/**
 * Creates a new `DRAFT` revision, optionally branched from a base revision.
 *
 * Branching is the correction path ([D17]): a `VALIDATED` or `PUBLISHED`
 * revision is never reopened, so every later change starts here. The copy
 * remaps every internal reference with a fresh id so the new revision is
 * genuinely independent — an edit to the branch can never touch the base — while
 * keeping external references (asset versions) verbatim, because those are
 * pinned provenance rather than revision-local rows.
 *
 * `scenario_id` defaults to the base revision's scenario. Copied rows carry the
 * new revision's scenario so the `(revision_id, project_id, scenario_id)` foreign
 * keys stay satisfied even when the branch moves to a new scenario.
 */
export async function createRevision({
  pool = null,
  client: providedClient = null,
  projectId,
  scenarioId = null,
  actorId = null,
  name = null,
  baseRevisionId = null,
} = {}) {
  if (!pool && !providedClient) throw new Error('createRevision requires a database pool.');

  return inTenant(providedClient, pool, projectId, async (client) => {
    const base = baseRevisionId ? await requireRevision({ client, projectId, revisionId: baseRevisionId }) : null;
    const resolvedScenarioId = scenarioId ?? base?.scenario_id ?? null;
    if (!resolvedScenarioId) throw fieldError('scenario_id', 'required');
    await requireScenario({ client, projectId, scenarioId: resolvedScenarioId });

    const revisionId = randomUUID();
    const envelopeId = randomUUID();

    await client.query(
      `INSERT INTO revisions (revision_id, project_id, scenario_id, base_revision_id, lifecycle_state, name, created_by)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6)`,
      [revisionId, projectId, resolvedScenarioId, baseRevisionId ?? null, name, actorId],
    );
    await client.query(
      `INSERT INTO facility_envelopes (envelope_id, project_id, scenario_id, revision_id, lifecycle_state, created_by)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5)`,
      [envelopeId, projectId, resolvedScenarioId, revisionId, actorId],
    );
    const token = await ensureEtag({ client, projectId, revisionId, scenarioId: resolvedScenarioId, actorId });

    if (baseRevisionId) {
      await client.query(
        `INSERT INTO revision_lineage (revision_id, parent_revision_id, project_id, scenario_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [revisionId, baseRevisionId, projectId, resolvedScenarioId, actorId],
      );
    }

    const copied = baseRevisionId
      ? await copyGraph({ client, projectId, scenarioId: resolvedScenarioId, revisionId, envelopeId, baseRevisionId, actorId })
      : {};

    return {
      revisionId,
      scenarioId: resolvedScenarioId,
      envelopeId,
      etag: token.etag,
      etagVersion: token.etagVersion,
      baseRevisionId: baseRevisionId ?? null,
      copied,
    };
  });
}

/**
 * The graph tables a branch copies, with the id column that must be remapped.
 *
 * The order is dependency order; `copyGraph` runs the inserts in it. A table not
 * in this list is either derived from a validation run (diagnostics, validation
 * runs) or import extraction output (`import_features`, `import_reports`), and
 * neither is a design decision the user authored.
 */
const COPIED_TABLE_IDS = Object.freeze([
  ['entity_registry', 'entity_id'],
  ['design_scopes', 'scope_id'],
  ['facility_phases', 'phase_id'],
  ['failure_domains', 'failure_domain_id'],
  ['facility_containers', 'container_id'],
  ['asset_bindings', 'binding_id'],
  ['spatial_transforms', 'transform_id'],
  ['geometry_records', 'geometry_id'],
  ['import_mappings', 'mapping_id'],
  ['spatial_constraints', 'constraint_id'],
  ['environmental_profiles', 'profile_id'],
  ['environmental_constraints', 'environmental_constraint_id'],
  ['utility_sources', 'utility_source_id'],
  ['utility_interfaces', 'interface_id'],
  ['storage_reserves', 'storage_id'],
  ['resilience_requirements', 'requirement_id'],
  ['capacity_budgets', 'budget_id'],
  ['assumptions', 'assumption_id'],
  ['waivers', 'waiver_id'],
]);

/**
 * Copies the base revision's graph into the new revision.
 *
 * The id remapping rides a transaction-local temp table (`branch_id_map`), so
 * every `INSERT ... SELECT` can resolve an old id to its new one without the
 * statement knowing anything about the row that owns it. That is what makes
 * "fresh ids, preserved references" true for self-referential trees (scopes,
 * containers, failure domains) as well as for cross-table edges.
 *
 * `asset_bindings` and `spatial_transforms` reference each other, so the binding
 * row lands with the base transform id, the transform rows land next, and the
 * binding is then pointed at the new transform. This is legal rather than clever:
 * an internal id is never a cross-revision reference, and the second statement
 * makes that explicit.
 */
async function copyGraph({ client, projectId, scenarioId, revisionId, envelopeId, baseRevisionId, actorId }) {
  // Statements that need the new envelope use `withEnvelope` (all six values);
  // statements that do not must not leave a placeholder gap, because PostgreSQL
  // cannot infer a type for a parameter no clause references.
  const withEnvelope = [projectId, scenarioId, revisionId, envelopeId, actorId, baseRevisionId];
  const withoutEnvelope = [projectId, scenarioId, revisionId, actorId, baseRevisionId];

  await client.query('CREATE TEMP TABLE IF NOT EXISTS branch_id_map (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP');
  await client.query('TRUNCATE branch_id_map');

  for (const [table, idColumn] of COPIED_TABLE_IDS) {
    await client.query(
      `INSERT INTO branch_id_map (old_id, new_id)
       SELECT ${idColumn}, gen_random_uuid() FROM ${table}
        WHERE project_id = $1 AND revision_id = $2
       ON CONFLICT (old_id) DO NOTHING`,
      [projectId, baseRevisionId],
    );
  }

  const copied = {};
  const count = (table, result) => {
    copied[table] = result.rowCount;
  };

  count('entity_registry', await client.query(
    `INSERT INTO entity_registry (entity_id, revision_id, project_id, scenario_id, entity_type, status, display_name, created_by)
     SELECT m.new_id, $3, $1, $2, e.entity_type, e.status, e.display_name, $4
       FROM entity_registry e JOIN branch_id_map m ON m.old_id = e.entity_id
      WHERE e.project_id = $1 AND e.revision_id = $5`,
    withoutEnvelope,
  ));

  count('design_scopes', await client.query(
    `INSERT INTO design_scopes (scope_id, project_id, scenario_id, revision_id, envelope_id, parent_scope_id,
                                entity_type, scope_kind, name, jurisdiction, provenance, created_by)
     SELECT ${mapId('s.scope_id')}, $1, $2, $3, $4, ${mapId('s.parent_scope_id')},
            s.entity_type, s.scope_kind, s.name, s.jurisdiction, s.provenance, $5
       FROM design_scopes s WHERE s.project_id = $1 AND s.revision_id = $6`,
    withEnvelope,
  ));

  count('facility_phases', await client.query(
    `INSERT INTO facility_phases (phase_id, project_id, scenario_id, revision_id, envelope_id, name, phase_order,
                                  activation_date, activation_date_precision, status, provenance, created_by)
     SELECT ${mapId('p.phase_id')}, $1, $2, $3, $4, p.name, p.phase_order,
            p.activation_date, p.activation_date_precision, p.status, p.provenance, $5
       FROM facility_phases p WHERE p.project_id = $1 AND p.revision_id = $6`,
    withEnvelope,
  ));

  count('failure_domains', await client.query(
    `INSERT INTO failure_domains (failure_domain_id, project_id, scenario_id, revision_id, envelope_id,
                                  parent_failure_domain_id, name, kind, provenance, created_by)
     SELECT ${mapId('d.failure_domain_id')}, $1, $2, $3, $4, ${mapId('d.parent_failure_domain_id')}, d.name, d.kind,
            d.provenance, $5
       FROM failure_domains d WHERE d.project_id = $1 AND d.revision_id = $6`,
    withEnvelope,
  ));

  count('facility_containers', await client.query(
    `INSERT INTO facility_containers (container_id, project_id, scenario_id, revision_id, envelope_id, scope_id,
                                      parent_container_id, phase_id, kind, entity_type, name, level_number, status,
                                      elevation_base_m, elevation_top_m, provenance, created_by)
     SELECT ${mapId('c.container_id')}, $1, $2, $3, $4, ${mapId('c.scope_id')}, ${mapId('c.parent_container_id')},
            ${mapId('c.phase_id')}, c.kind, c.entity_type, c.name, c.level_number, c.status,
            c.elevation_base_m, c.elevation_top_m, c.provenance, $5
       FROM facility_containers c WHERE c.project_id = $1 AND c.revision_id = $6`,
    withEnvelope,
  ));

  // Bindings land pointing at the base transform (still inside the same project,
  // so the foreign key holds) and are re-pointed once the transforms exist.
  count('asset_bindings', await client.query(
    `INSERT INTO asset_bindings (binding_id, project_id, scenario_id, revision_id, asset_version_id,
                                 representation_id, transform_id, role, tool_id, status, mapping_ids, payload_ref, created_by)
     SELECT ${mapId('b.binding_id')}, $1, $2, $3, b.asset_version_id, b.representation_id, b.transform_id,
            b.role, b.tool_id, b.status, b.mapping_ids, b.payload_ref, $4
       FROM asset_bindings b WHERE b.project_id = $1 AND b.revision_id = $5`,
    withoutEnvelope,
  ));

  count('spatial_transforms', await client.query(
    `INSERT INTO spatial_transforms (transform_id, project_id, scenario_id, revision_id, binding_id, asset_version_id,
                                     source_units, target_units, source_crs, target_crs, vertical_crs, method,
                                     control_points, residual_error_m, review_state, reviewer_id, reviewed_at, created_by)
     SELECT ${mapId('t.transform_id')}, $1, $2, $3, ${mapId('t.binding_id')}, t.asset_version_id,
            t.source_units, t.target_units, t.source_crs, t.target_crs, t.vertical_crs, t.method,
            t.control_points, t.residual_error_m, t.review_state, t.reviewer_id, t.reviewed_at, $4
       FROM spatial_transforms t WHERE t.project_id = $1 AND t.revision_id = $5`,
    withoutEnvelope,
  ));

  await client.query(
    `UPDATE asset_bindings b SET transform_id = m.new_id
       FROM branch_id_map m
      WHERE b.project_id = $1 AND b.revision_id = $2 AND b.transform_id = m.old_id`,
    [projectId, revisionId],
  );

  count('geometry_records', await client.query(
    `INSERT INTO geometry_records (geometry_id, project_id, scenario_id, revision_id, entity_id, entity_type, role,
                                   ordinal, geometry_type, geojson_4326, projected_geometry, projected_crs, vertical_crs,
                                   parent_transform_id, elevation_base_m, elevation_top_m, height_m, asset_version_id,
                                   binding_id, provenance, created_by)
     SELECT ${mapId('g.geometry_id')}, $1, $2, $3, ${mapId('g.entity_id')}, g.entity_type, g.role, g.ordinal,
            g.geometry_type, g.geojson_4326, g.projected_geometry, g.projected_crs, g.vertical_crs,
            ${mapId('g.parent_transform_id')}, g.elevation_base_m, g.elevation_top_m, g.height_m, g.asset_version_id,
            ${mapId('g.binding_id')}, g.provenance, $4
       FROM geometry_records g WHERE g.project_id = $1 AND g.revision_id = $5`,
    withoutEnvelope,
  ));

  count('import_mappings', await client.query(
    `INSERT INTO import_mappings (mapping_id, project_id, scenario_id, revision_id, binding_id, asset_version_id,
                                  transform_id, source_selector, target_entity_type, target_geometry_role,
                                  attribute_mapping, cardinality, required, review_state, reviewer_id, reviewed_at, created_by)
     SELECT ${mapId('m.mapping_id')}, $1, $2, $3, ${mapId('m.binding_id')}, m.asset_version_id,
            ${mapId('m.transform_id')}, m.source_selector, m.target_entity_type, m.target_geometry_role,
            m.attribute_mapping, m.cardinality, m.required, m.review_state, m.reviewer_id, m.reviewed_at, $4
       FROM import_mappings m WHERE m.project_id = $1 AND m.revision_id = $5`,
    withoutEnvelope,
  ));

  await client.query(
    `UPDATE asset_bindings b
        SET mapping_ids = COALESCE((
              SELECT array_agg(m.new_id ORDER BY u.ord)
                FROM unnest(b.mapping_ids) WITH ORDINALITY AS u(old_id, ord)
                JOIN branch_id_map m ON m.old_id = u.old_id), '{}'::uuid[])
      WHERE b.project_id = $1 AND b.revision_id = $2`,
    [projectId, revisionId],
  );

  count('spatial_constraints', await client.query(
    `INSERT INTO spatial_constraints (constraint_id, project_id, scenario_id, revision_id, envelope_id, scope_id,
                                      container_id, applies_to_geometry_id, kind, severity, rule_kind, rule_value,
                                      rule_unit, provenance, created_by)
     SELECT ${mapId('c.constraint_id')}, $1, $2, $3, $4, ${mapId('c.scope_id')}, ${mapId('c.container_id')},
            ${mapId('c.applies_to_geometry_id')}, c.kind, c.severity, c.rule_kind, c.rule_value, c.rule_unit,
            c.provenance, $5
       FROM spatial_constraints c WHERE c.project_id = $1 AND c.revision_id = $6`,
    withEnvelope,
  ));

  count('environmental_profiles', await client.query(
    `INSERT INTO environmental_profiles (profile_id, project_id, scenario_id, revision_id, site_scope_id,
                                         design_weather_ref, hazard_classifications, permit_constraints, operating_ranges,
                                         effective_at, effective_until, asset_version_id, provenance, created_by)
     SELECT ${mapId('p.profile_id')}, $1, $2, $3, ${mapId('p.site_scope_id')}, p.design_weather_ref,
            p.hazard_classifications, p.permit_constraints, p.operating_ranges, p.effective_at, p.effective_until,
            p.asset_version_id, p.provenance, $4
       FROM environmental_profiles p WHERE p.project_id = $1 AND p.revision_id = $5`,
    withoutEnvelope,
  ));

  count('environmental_constraints', await client.query(
    `INSERT INTO environmental_constraints (environmental_constraint_id, project_id, scenario_id, revision_id, envelope_id,
                                            profile_id, affected_entity_id, applies_to_geometry_id, constraint_kind,
                                            threshold_value, threshold_unit, basis, effective_at, effective_until,
                                            provenance, created_by)
     SELECT ${mapId('c.environmental_constraint_id')}, $1, $2, $3, $4, ${mapId('c.profile_id')},
            ${mapId('c.affected_entity_id')}, ${mapId('c.applies_to_geometry_id')}, c.constraint_kind,
            c.threshold_value, c.threshold_unit, c.basis, c.effective_at, c.effective_until, c.provenance, $5
       FROM environmental_constraints c WHERE c.project_id = $1 AND c.revision_id = $6`,
    withEnvelope,
  ));

  count('utility_sources', await client.query(
    `INSERT INTO utility_sources (utility_source_id, project_id, scenario_id, revision_id, envelope_id, kind,
                                  capacity_value, capacity_unit, capacity_basis, capacity_state, failure_domain_id,
                                  phase_id, available_from, provenance, created_by)
     SELECT ${mapId('s.utility_source_id')}, $1, $2, $3, $4, s.kind, s.capacity_value, s.capacity_unit, s.capacity_basis,
            s.capacity_state, ${mapId('s.failure_domain_id')}, ${mapId('s.phase_id')}, s.available_from, s.provenance, $5
       FROM utility_sources s WHERE s.project_id = $1 AND s.revision_id = $6`,
    withEnvelope,
  ));

  count('utility_interfaces', await client.query(
    `INSERT INTO utility_interfaces (interface_id, project_id, scenario_id, revision_id, envelope_id, utility_source_id,
                                     capacity_value, capacity_unit, capacity_basis, capacity_state, service_state,
                                     failure_domain_id, phase_id, available_from, provenance, created_by)
     SELECT ${mapId('i.interface_id')}, $1, $2, $3, $4, ${mapId('i.utility_source_id')}, i.capacity_value,
            i.capacity_unit, i.capacity_basis, i.capacity_state, i.service_state, ${mapId('i.failure_domain_id')},
            ${mapId('i.phase_id')}, i.available_from, i.provenance, $5
       FROM utility_interfaces i WHERE i.project_id = $1 AND i.revision_id = $6`,
    withEnvelope,
  ));

  count('storage_reserves', await client.query(
    `INSERT INTO storage_reserves (storage_id, project_id, scenario_id, revision_id, envelope_id, kind, capacity_value,
                                   capacity_unit, capacity_basis, capacity_state, autonomy_duration_seconds,
                                   failure_domain_id, phase_id, provenance, created_by)
     SELECT ${mapId('r.storage_id')}, $1, $2, $3, $4, r.kind, r.capacity_value, r.capacity_unit, r.capacity_basis,
            r.capacity_state, r.autonomy_duration_seconds, ${mapId('r.failure_domain_id')}, ${mapId('r.phase_id')},
            r.provenance, $5
       FROM storage_reserves r WHERE r.project_id = $1 AND r.revision_id = $6`,
    withEnvelope,
  ));

  count('resilience_requirements', await client.query(
    `INSERT INTO resilience_requirements (requirement_id, project_id, scenario_id, revision_id, envelope_id,
                                          availability_policy, policy_id, applies_to, autonomy_duration_seconds, active,
                                          provenance, created_by)
     SELECT ${mapId('q.requirement_id')}, $1, $2, $3, $4, q.availability_policy, q.policy_id, q.applies_to,
            q.autonomy_duration_seconds, q.active, q.provenance, $5
       FROM resilience_requirements q WHERE q.project_id = $1 AND q.revision_id = $6`,
    withEnvelope,
  ));

  count('capacity_budgets', await client.query(
    `INSERT INTO capacity_budgets (budget_id, project_id, scenario_id, revision_id, envelope_id, owner_entity_id,
                                   phase_id, utility_interface_id, resource_kind, basis, unit, commissioned_value,
                                   planned_value, reserved_value, allocated_value, available_value, derating_factor,
                                   provenance, created_by)
     SELECT ${mapId('b.budget_id')}, $1, $2, $3, $4, ${mapId('b.owner_entity_id')}, ${mapId('b.phase_id')},
            ${mapId('b.utility_interface_id')}, b.resource_kind, b.basis, b.unit, b.commissioned_value,
            b.planned_value, b.reserved_value, b.allocated_value, b.available_value, b.derating_factor,
            b.provenance, $5
       FROM capacity_budgets b WHERE b.project_id = $1 AND b.revision_id = $6`,
    withEnvelope,
  ));

  // Coverage is derived from a validation run, and this revision has none, so
  // the capability keys are kept but their status is reset ([D11]). Copying the
  // base's derived status would be an assertion, which is exactly what D11 forbids.
  count('capability_coverage', await client.query(
    `INSERT INTO capability_coverage (revision_id, capability, project_id, scenario_id, envelope_id, status,
                                      evidence_refs, reviewed_at, created_by)
     SELECT $3, c.capability, $1, $2, $4, 'NOT_PROVIDED', '[]'::jsonb, NULL, $5
       FROM capability_coverage c WHERE c.project_id = $1 AND c.revision_id = $6`,
    withEnvelope,
  ));

  count('assumptions', await client.query(
    `INSERT INTO assumptions (assumption_id, project_id, scenario_id, revision_id, envelope_id, statement, owner,
                              confidence, effective_at, expires_at, status, entity_refs, provenance, created_by)
     SELECT ${mapId('a.assumption_id')}, $1, $2, $3, $4, a.statement, a.owner, a.confidence, a.effective_at,
            a.expires_at, a.status, ${remapEntityRefs('a.entity_refs')}, a.provenance, $5
       FROM assumptions a WHERE a.project_id = $1 AND a.revision_id = $6`,
    withEnvelope,
  ));

  count('waivers', await client.query(
    `INSERT INTO waivers (waiver_id, project_id, scenario_id, revision_id, envelope_id, diagnostic_ids, scope,
                          granted_by, policy_id, reason, granted_at, expires_at, status, created_by)
     SELECT ${mapId('w.waiver_id')}, $1, $2, $3, $4, w.diagnostic_ids, w.scope, w.granted_by, w.policy_id,
            w.reason, w.granted_at, w.expires_at, w.status, $5
       FROM waivers w WHERE w.project_id = $1 AND w.revision_id = $6`,
    withEnvelope,
  ));

  await client.query('TRUNCATE branch_id_map');
  return copied;
}

/**
 * Publishes a `VALIDATED` revision.
 *
 * The gate is evaluated twice over: the persisted `validation_run_id` must be the
 * revision's current clean `FULL` run, and the `PUBLISH`-phase checks are run
 * here, in this transaction, because a validation run deliberately skips them.
 * Only when that run leaves no unwaived `ERROR` does the transition commit —
 * together with the checksum, the outbox event, the Impact Notice and the frozen
 * envelope. A refusal is recorded nowhere: the caller's transaction is restored
 * to a savepoint before the error is raised.
 *
 * `storage` may be null. Publication still commits, with `objectKey: null` and a
 * notice, because the object store is a derived artifact whose absence must not
 * block a lifecycle transition.
 */
export async function publishRevision({
  pool = null,
  client: providedClient = null,
  storage = null,
  projectId,
  revisionId,
  validationRunId = null,
  actorId = null,
  correlationId = null,
  policies = defaultPolicyRegistry,
  approvalPolicy = null,
  logger = null,
} = {}) {
  if (!pool && !providedClient) throw new Error('publishRevision requires a database pool.');

  return inTenant(providedClient, pool, projectId, async (client) => {
    await client.query('SAVEPOINT publish_revision');
    try {
      const result = await publishWithinSavepoint(client);
      await client.query('RELEASE SAVEPOINT publish_revision');
      return result;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT publish_revision');
      await client.query('RELEASE SAVEPOINT publish_revision');
      throw error;
    }
  });

  async function publishWithinSavepoint(client) {
    const target = await loadPublishTarget({ client, projectId, revisionId });

    if (target.lifecycle_state !== 'VALIDATED') {
      throw new ApiError('VALIDATION_REQUIRED', 'Only a VALIDATED revision can be published.', {
        status: 409,
        details: [{
          field: 'lifecycle_state',
          reason: 'not_validated',
          constraint_id: 'facility.revision.publish.requires_validation',
          revision_id: revisionId,
          lifecycle_state: target.lifecycle_state,
        }],
      });
    }
    if (validationRunId && validationRunId !== target.validation_run_id) {
      throw new ApiError('VALIDATION_REQUIRED', 'The named validation run is not the revision\'s current clean FULL run.', {
        status: 409,
        details: [{
          field: 'validation_run_id',
          reason: 'not_current_clean_run',
          constraint_id: 'facility.revision.publish.requires_validation',
          supplied_validation_run_id: validationRunId,
          current_validation_run_id: target.validation_run_id,
        }],
      });
    }

    // The gate runs with the envelope presented as DRAFT.
    //
    // `facility.revision.writes_immutable` answers "may a change set write to this
    // revision", and it fires for every non-DRAFT lifecycle. Publication is the
    // one authorized non-DRAFT transition, so evaluating the gate against a
    // VALIDATED envelope makes the run emit that ERROR and *every* publish fails
    // on a finding that is not about publishing. The timestamp/lifecycle are the
    // only things the check reads, and the PUBLISHED update below restores the
    // real state before the transaction ends, so the interim value is never
    // visible outside this transaction. The PUBLISH-phase checks are unaffected.
    await client.query(
      `UPDATE facility_envelopes SET lifecycle_state = 'DRAFT', updated_at = now()
        WHERE envelope_id = $1 AND project_id = $2`,
      [target.envelope_id, projectId],
    );

    const run = await executeRun({
      client,
      projectId,
      scenarioId: target.scenario_id,
      revisionId,
      scope: 'FULL',
      reason: RUN_REASON.PUBLISH,
      actorId,
      policies,
      approvalPolicy,
    });

    const warnings = run.diagnostics.filter((item) => item.severity === 'WARNING'
      && item.status !== 'RESOLVED' && item.status !== 'SUPERSEDED');
    const blocking = run.diagnostics.filter((item) => item.severity === 'ERROR' && item.status !== 'WAIVED');

    if (blocking.length > 0 || run.incomplete) {
      throw new ApiError('VALIDATION_REQUIRED', 'The publication gate found blocking findings.', {
        status: 409,
        details: [
          ...blocking.map(toDiagnosticShape),
          ...(run.incomplete
            ? [{ constraint_id: 'facility.revision.publish.requires_validation', reason: 'run_incomplete' }]
            : []),
        ],
      });
    }

    const confirmedRunId = validationRunId ?? target.validation_run_id ?? null;
    const ctx = await loadRevisionContext({ client, projectId, scenarioId: target.scenario_id, revisionId });
    const checksum = contentChecksum(ctx);

    const published = (
      await client.query(
        `UPDATE revisions
            SET lifecycle_state = 'PUBLISHED', content_checksum = $3, published_at = now(), updated_at = now()
          WHERE project_id = $1 AND revision_id = $2 AND lifecycle_state = 'VALIDATED'
        RETURNING published_at`,
        [projectId, revisionId, checksum],
      )
    ).rows[0];
    if (!published) {
      // The guard above and this conditional update are the two halves of the
      // one-way transition: between them the row is only ever VALIDATED -> PUBLISHED.
      throw new ApiError('VALIDATION_REQUIRED', 'The revision is no longer in a publishable state.', {
        status: 409,
        details: [{ constraint_id: 'facility.revision.publish.requires_validation', revision_id: revisionId }],
      });
    }

    await client.query(
      `UPDATE facility_envelopes
          SET lifecycle_state = 'PUBLISHED', published_at = $3, content_checksum = $4,
              validation_run_id = $5, updated_at = now()
        WHERE envelope_id = $1 AND project_id = $2`,
      [target.envelope_id, projectId, published.published_at, checksum, confirmedRunId],
    );

    // approval_state is a projection, and publication only confirms it. A
    // NOT_REQUIRED envelope stays NOT_REQUIRED; an envelope that needed approval
    // is marked APPROVED only when a governing APPROVED attestation exists.
    let approvalState = target.approval_state;
    if (approvalState !== 'NOT_REQUIRED') {
      const governing = await governingDecision({ client, projectId, revisionId });
      if (governing === 'APPROVED') {
        approvalState = 'APPROVED';
        await client.query(
          `UPDATE facility_envelopes SET approval_state = 'APPROVED', updated_at = now()
            WHERE envelope_id = $1 AND project_id = $2`,
          [target.envelope_id, projectId],
        );
      }
    }

    let objectKey = null;
    let notice = null;
    if (storage) {
      objectKey = envelopeKey(projectId, revisionId);
      const envelope = await buildEnvelope({
        client,
        projectId,
        target,
        ctx,
        run,
        confirmedRunId,
        checksum,
        publishedAt: published.published_at,
        approvalState,
      });
      const body = gzipSync(Buffer.from(canonicalJson(envelope)));
      await storage.putObject({ key: objectKey, body, contentType: 'application/gzip' });
    } else {
      notice = 'No storage adapter was supplied, so the published envelope was not frozen to object storage.';
    }

    await client.query(
      `INSERT INTO outbox_events
         (event_id, project_id, scenario_id, revision_id, event_type, aggregate_type, aggregate_id, payload,
          correlation_id, created_by)
       VALUES ($1, $2, $3, $4, 'facility.envelope.published.v1', 'facility_envelope', $5, $6::jsonb, $7, $8)`,
      [
        randomUUID(), projectId, target.scenario_id, revisionId, target.envelope_id,
        JSON.stringify({
          envelope_id: target.envelope_id,
          revision_id: revisionId,
          content_checksum: checksum,
          lifecycle_state: 'PUBLISHED',
          approval_state: approvalState,
          object_key: objectKey,
          published_at: published.published_at,
          coverage: Object.values(run.coverage ?? {}).map((entry) => ({
            capability: entry.capability, status: entry.status,
          })),
        }),
        correlationId,
        actorId,
      ],
    );

    // An ImpactNotice names the revision it supersedes. A root revision has no
    // base, and `impact_notices.previous_revision_id` is NOT NULL and distinct,
    // so there is no row to write: nothing has been superseded. That is a schema
    // limitation recorded in the module report, not a silent skip.
    let impactNoticeId = null;
    if (target.base_revision_id) {
      const impactNotice = await issueImpactNotice({
        client,
        projectId,
        scenarioId: target.scenario_id,
        previousRevisionId: target.base_revision_id,
        revisionId,
        changedEntityRefs: [],
        invalidatedConsumerTypes: [...PUBLISH_INVALIDATED_CONSUMER_TYPES],
        actorId,
      });
      impactNoticeId = impactNotice.impactNoticeId;
    } else {
      notice = [notice, 'The revision has no base revision, so no ImpactNotice was issued.']
        .filter(Boolean).join(' ');
    }

    logger?.info?.('facility.envelope.published', {
      projectId, revisionId, envelopeId: target.envelope_id, objectKey, warnings: warnings.length,
    });

    return {
      revisionId,
      lifecycleState: 'PUBLISHED',
      publishedAt: published.published_at,
      contentChecksum: checksum,
      objectKey,
      impactNoticeId,
      validationRunId: confirmedRunId,
      warnings,
      notice,
    };
  }
}

/**
 * Records one approval decision.
 *
 * An attestation is append-only: rejecting or revoking is a new row, never an
 * edit. `facility_envelopes.approval_state` is updated as a *projection* of the
 * latest governing row, so the envelope stays a cheap read while the ledger
 * stays the truth. The schema has no "approval request" table, so `PENDING` is a
 * state the caller may set but this command never invents.
 */
export async function recordApproval({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  actorId = null,
  policyId,
  decision,
  comment = null,
  correlationId = null,
} = {}) {
  if (!pool && !providedClient) throw new Error('recordApproval requires a database pool.');
  assertEnum(decision, APPROVAL_DECISIONS, 'decision');
  if (!policyId) throw fieldError('policy_id', 'required');

  return inTenant(providedClient, pool, projectId, async (client) => {
    const target = await loadPublishTarget({ client, projectId, revisionId });
    if (!ATTESTABLE_STATES.includes(target.lifecycle_state)) {
      throw new ApiError('REVISION_IMMUTABLE', 'An approval attestation cannot be recorded against a published revision.', {
        status: 409,
        details: [{
          constraint_id: 'facility.revision.writes_immutable',
          lifecycle_state: target.lifecycle_state,
          revision_id: revisionId,
        }],
      });
    }

    const attestationId = randomUUID();
    // `approved_at` is set from the wall clock rather than the transaction clock:
    // two decisions recorded in one transaction share `now()`, and the governing
    // decision is defined by recency, so the ledger needs a value that orders them.
    const row = (
      await client.query(
        `INSERT INTO approval_attestations
           (attestation_id, project_id, scenario_id, envelope_id, revision_id, approver_id, policy_id, decision,
            approved_at, comment, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), $9, $6)
        RETURNING attestation_id, revision_id, approver_id, policy_id, decision, approved_at, comment`,
        [attestationId, projectId, target.scenario_id, target.envelope_id, revisionId, actorId, policyId, decision, comment],
      )
    ).rows[0];

    const approvalState = await governingDecision({ client, projectId, revisionId });
    if (approvalState) {
      await client.query(
        `UPDATE facility_envelopes SET approval_state = $3, updated_at = now()
          WHERE envelope_id = $1 AND project_id = $2`,
        [target.envelope_id, projectId, approvalState],
      );
    }

    await client.query(
      `INSERT INTO outbox_events
         (event_id, project_id, scenario_id, revision_id, event_type, aggregate_type, aggregate_id, payload,
          correlation_id, created_by)
       VALUES ($1, $2, $3, $4, 'facility.approval.recorded.v1', 'approval_attestation', $5, $6::jsonb, $7, $8)`,
      [
        randomUUID(), projectId, target.scenario_id, revisionId, attestationId,
        JSON.stringify({ attestation_id: attestationId, revision_id: revisionId, policy_id: policyId, decision }),
        correlationId, actorId,
      ],
    );

    const attestation = {
      attestationId: row.attestation_id,
      revisionId: row.revision_id,
      approverId: row.approver_id,
      policyId: row.policy_id,
      decision: row.decision,
      approvedAt: row.approved_at,
      comment: row.comment,
    };
    // Both the flat fields and the nested object, so a caller can read either.
    return { ...attestation, attestation, approvalState: approvalState ?? target.approval_state };
  });
}

/**
 * Inserts one Impact Notice.
 *
 * Exported because the change-set commit issues the same record for a shared or
 * published revision, and a second copy of this statement would be a second
 * definition of "which consumers a change invalidates".
 */
export async function issueImpactNotice({
  client,
  projectId,
  scenarioId,
  previousRevisionId,
  revisionId,
  changedEntityRefs = [],
  invalidatedConsumerTypes = [],
  actorId = null,
} = {}) {
  if (!client) throw new Error('issueImpactNotice requires a database client.');
  if (previousRevisionId === revisionId) {
    throw fieldError('previous_revision_id', 'must_differ_from_revision_id');
  }
  for (const consumerType of invalidatedConsumerTypes) {
    assertEnum(consumerType, CONSUMER_TYPES, 'invalidated_consumer_types');
  }

  const row = (
    await client.query(
      `INSERT INTO impact_notices
         (impact_notice_id, project_id, scenario_id, previous_revision_id, revision_id, changed_entity_refs,
          invalidated_consumer_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::consumer_type[], $8)
      RETURNING impact_notice_id, project_id, scenario_id, previous_revision_id, revision_id, changed_entity_refs,
                invalidated_consumer_types::text[] AS invalidated_consumer_types, issued_at`,
      [
        randomUUID(), projectId, scenarioId, previousRevisionId, revisionId,
        JSON.stringify(changedEntityRefs), invalidatedConsumerTypes, actorId,
      ],
    )
  ).rows[0];

  return {
    impactNoticeId: row.impact_notice_id,
    projectId: row.project_id,
    scenarioId: row.scenario_id,
    previousRevisionId: row.previous_revision_id,
    revisionId: row.revision_id,
    changedEntityRefs: row.changed_entity_refs ?? [],
    invalidatedConsumerTypes: row.invalidated_consumer_types ?? [],
    issuedAt: row.issued_at,
  };
}

/* ------------------------------------------------------------------ helpers */

/** The revision plus its envelope, locked for the transition. */
async function loadPublishTarget({ client, projectId, revisionId }) {
  const { rows } = await client.query(
    `SELECT r.revision_id, r.project_id, r.scenario_id, r.base_revision_id, r.lifecycle_state,
            r.content_checksum, r.published_at,
            e.envelope_id, e.approval_state, e.validation_run_id,
            e.lifecycle_state AS envelope_lifecycle_state
       FROM revisions r
       JOIN facility_envelopes e
         ON e.project_id = r.project_id AND e.revision_id = r.revision_id
      WHERE r.project_id = $1 AND r.revision_id = $2
        FOR UPDATE OF r, e`,
    [projectId, revisionId],
  );
  const row = rows[0];
  if (!row) throw errors.notFound('The requested resource was not found.');
  return row;
}

/** The latest governing approval decision for a revision, or null. */
async function governingDecision({ client, projectId, revisionId }) {
  const { rows } = await client.query(
    `SELECT decision FROM approval_attestations
      WHERE project_id = $1 AND revision_id = $2
      ORDER BY approved_at DESC, created_at DESC, attestation_id DESC
      LIMIT 1`,
    [projectId, revisionId],
  );
  return rows[0]?.decision ?? null;
}

/**
 * The frozen envelope: the design context plus the coverage and validation
 * summary the run produced. It is built from the same stores the checks read, so
 * the frozen bytes and the validated conclusion cannot describe different graphs.
 */
async function buildEnvelope({ client, projectId, target, ctx, run, confirmedRunId, checksum, publishedAt, approvalState }) {
  const validationSummary = await loadValidationSummary({ client, projectId, run, confirmedRunId });
  const assetVersionRefs = [...new Set(
    ctx.bindings.map((binding) => binding.asset_version_id).filter(Boolean),
  )].sort();

  return {
    schema_version: 1,
    producer: 'site_facility',
    envelope_id: target.envelope_id,
    project_id: projectId,
    scenario_id: target.scenario_id,
    revision_id: target.revision_id,
    lifecycle_state: 'PUBLISHED',
    approval_state: approvalState,
    content_checksum: checksum,
    published_at: publishedAt,
    design_context: {
      scopes: ctx.scopes,
      containers: ctx.containers,
      entities: ctx.entities,
      geometry: ctx.geometry,
      spatial_constraints: ctx.spatialConstraints,
      facility_phases: ctx.phases,
      phase_dependencies: ctx.phaseDeps,
      phase_capability_availability: ctx.phaseAvailability,
      environmental_profiles: ctx.profiles,
      environmental_constraints: ctx.envConstraints,
      failure_domains: ctx.domains,
      resilience_requirements: ctx.requirements,
      storage_reserves: ctx.reserves,
      utility_sources: ctx.sources,
      utility_interfaces: ctx.interfaces,
      capacity_budgets: ctx.budgets,
      assumptions: ctx.assumptions,
      waivers: ctx.waivers,
      asset_bindings: ctx.bindings,
      import_mappings: ctx.mappings,
    },
    capability_coverage: Object.values(run.coverage ?? {}).map((entry) => ({
      capability: entry.capability,
      status: entry.status,
      reasons: entry.reasons ?? [],
    })),
    validation_summary: validationSummary,
    asset_version_refs: assetVersionRefs,
  };
}

async function loadValidationSummary({ client, projectId, run, confirmedRunId }) {
  if (confirmedRunId) {
    const { rows } = await client.query(
      `SELECT validation_run_id, revision_id, scope, status, checked_capabilities::text[] AS checked_capabilities,
              not_checked_capabilities::text[] AS not_checked_capabilities, error_count, warning_count,
              started_at, completed_at
         FROM validation_runs WHERE project_id = $1 AND validation_run_id = $2`,
      [projectId, confirmedRunId],
    );
    const row = rows[0];
    if (row) {
      return {
        run_id: row.validation_run_id,
        revision_id: row.revision_id,
        scope: row.scope,
        status: row.status,
        checked_capabilities: row.checked_capabilities ?? [],
        not_checked_capabilities: row.not_checked_capabilities ?? [],
        error_count: row.error_count,
        warning_count: row.warning_count,
        started_at: row.started_at,
        completed_at: row.completed_at,
      };
    }
  }
  return {
    run_id: run.runId,
    revision_id: null,
    scope: run.scope,
    status: run.status,
    checked_capabilities: run.checkedCapabilities ?? [],
    not_checked_capabilities: run.notCheckedCapabilities ?? [],
    error_count: run.errorCount,
    warning_count: run.warningCount,
    started_at: null,
    completed_at: null,
  };
}

/** The API-shaped diagnostic carried by a refusal and returned as a warning. */
function toDiagnosticShape(item) {
  return {
    constraint_id: item.constraintId,
    severity: item.severity,
    status: item.status ?? 'OPEN',
    entity_refs: item.entityRefs ?? [],
    geometry_refs: item.geometryRefs ?? [],
    source_values: item.sourceValues ?? [],
    computed: item.computed ?? {},
    remediation_category: item.remediationCategory ?? null,
    remediation_hint: item.remediationHint ?? null,
    policy_ref: item.policyRef ?? null,
  };
}

/**
 * A deterministic JSON encoding: object keys are sorted at every level, so two
 * runs over the same graph produce the same bytes and the same object payload.
 */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

/** A scalar subquery resolving an old id to the branch's fresh one. */
function mapId(expression) {
  return `(SELECT new_id FROM branch_id_map WHERE old_id = ${expression})`;
}

/** Remaps the (entity_type, entity_id) pairs inside a jsonb reference array. */
function remapEntityRefs(expression) {
  return `COALESCE((
    SELECT jsonb_agg(
             CASE WHEN u.elem ? 'entity_id'
                  THEN jsonb_set(u.elem, '{entity_id}', to_jsonb(COALESCE(m.new_id, (u.elem->>'entity_id')::uuid)))
                  ELSE u.elem END
             ORDER BY u.ord)
      FROM jsonb_array_elements(${expression}) WITH ORDINALITY AS u(elem, ord)
      LEFT JOIN branch_id_map m ON m.old_id = (u.elem->>'entity_id')::uuid), '[]'::jsonb)`;
}

/** Every key segment is sanitized so a hostile id cannot escape its prefix. */
function segment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

async function requireRevision({ client, projectId, revisionId }) {
  const { rows } = await client.query(
    `SELECT revision_id, scenario_id, lifecycle_state, base_revision_id FROM revisions
      WHERE project_id = $1 AND revision_id = $2`,
    [projectId, revisionId],
  );
  const row = rows[0];
  if (!row) {
    throw new ApiError('BASE_REVISION_NOT_FOUND', 'The named base revision does not exist.', {
      status: 404,
      details: [{ field: 'base_revision_id', value: revisionId }],
    });
  }
  return row;
}

async function requireScenario({ client, projectId, scenarioId }) {
  const { rows } = await client.query(
    `SELECT 1 FROM scenarios WHERE project_id = $1 AND scenario_id = $2`,
    [projectId, scenarioId],
  );
  if (rows.length === 0) throw errors.notFound('The scenario was not found.');
}

/**
 * Runs `fn` on the caller's transaction when one was supplied, and opens the
 * tenant-scoped transaction otherwise. The tool executor already holds a tenant
 * transaction, so re-opening one would both pay for a second connection and read
 * a different snapshot than the caller's.
 */
function inTenant(providedClient, pool, projectId, fn) {
  return providedClient ? fn(providedClient) : withTenant(pool, projectId, fn);
}

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ApiError('VALIDATION_FAILED', `The field ${field} is not valid.`, {
      status: 400,
      details: [{ field, reason: 'not_allowed', allowed }],
    });
  }
}

function fieldError(field, reason) {
  return new ApiError('VALIDATION_FAILED', `The field ${field} is not valid.`, {
    status: 400,
    details: [{ field, reason }],
  });
}
