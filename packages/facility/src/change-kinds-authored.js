import {
  AVAILABILITY_POLICIES,
  CAPACITY_BASES,
  CONFIDENCES,
  CONSTRAINT_KINDS,
  ChangeConflict,
  ChangeRejected,
  DOCUMENT_KINDS,
  PHASE_STATUSES,
  QUANTITY_STATES,
  RESERVE_KINDS,
  RESOURCE_KINDS,
  SEVERITIES,
  SERVICE_STATES,
  SUPPLY_STATES,
  assertBelongsToRevision,
  assertNoParentCycle,
  assertNoPhaseCycle,
  assertRange,
  assertWindow,
  newId,
  optionalEnum,
  optionalId,
  registerEntity,
  requireEnum,
  requireField,
  requireNumber,
  requirePinnedPolicy,
  resolveEntity,
} from './change-kind-shared.js';

/**
 * The change kinds that make findings clearable.
 *
 * The order these were built in is the order the catalog's evidence runs out: the
 * seeded campus is held back by one non-firm utility source, so `set_utility_source`
 * is what unblocks POWER, COOLING and NETWORK_ENTRY at once, and the six
 * `facility.phase.*` checks had no way to be satisfied at all until phases could be
 * assigned and ordered.
 *
 * Each kind follows the same shape — upsert by an optional id, register the entity,
 * validate what the store cannot hold — and refuses only what the store cannot hold.
 * A zero capacity, an unfirm source in a later phase, an interface with no connection
 * point: all of those are written, because the catalog has a check for each and a write
 * path that refused them would suppress the diagnostic.
 */

/** Utility sources: capacity, state, failure domain, phase. */
const setUtilitySource = {
  kind: 'set_utility_source',
  permission: 'facility.utility.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const kind = requireEnum(payload, 'kind', RESOURCE_KINDS);
    // Capacity is deliberately optional. The column is nullable and the catalog has
    // `facility.utility.source.capacity_missing` for an undeclared value, so requiring
    // it here would suppress the diagnostic the check exists to raise.
    const capacityValue = payload.capacity_value === undefined || payload.capacity_value === null ? null : requireNumber(payload, 'capacity_value');
    const capacityUnit = requireField(payload, 'capacity_unit');
    const capacityBasis = requireEnum(payload, 'capacity_basis', CAPACITY_BASES);
    const capacityState = requireEnum(payload, 'capacity_state', SUPPLY_STATES);
    // Both are NOT NULL in the store, so a source without them is not a finding — it is
    // a row the store will not hold.
    const failureDomainId = requireField(payload, 'failure_domain_id');
    const phaseId = requireField(payload, 'phase_id');
    const name = requireField(payload, 'name');

    await assertBelongsToRevision({
      client, projectId, revisionId, table: 'failure_domains', idColumn: 'failure_domain_id', id: failureDomainId, field: 'failure_domain_id',
    });
    await assertBelongsToRevision({
      client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: phaseId, field: 'phase_id',
    });

    const sourceId = optionalId(payload, 'utility_source_id');
    if (sourceId) {
      const updated = await client.query(
        `UPDATE utility_sources
            SET kind = $3, capacity_value = $4, capacity_unit = $5, capacity_basis = $6, capacity_state = $7,
                failure_domain_id = $8, phase_id = $9, available_from = $10, updated_at = now(), updated_by = $11
          WHERE project_id = $1 AND revision_id = $2 AND utility_source_id = $12
        RETURNING utility_source_id`,
        [projectId, revisionId, kind, capacityValue, capacityUnit, capacityBasis, capacityState, failureDomainId, phaseId, payload.available_from ?? null, actorId, sourceId],
      );
      if (updated.rows.length === 0) {
        throw new ChangeRejected('The utility source does not exist in this revision.', { field: 'payload.utility_source_id', reason: 'not_found' });
      }
      await client.query(
        `UPDATE entity_registry SET display_name = $4, updated_at = now(), updated_by = $5
          WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`,
        [projectId, revisionId, sourceId, name, actorId],
      );
      return { entityRef: { entity_id: sourceId, entity_type: 'UTILITY_SOURCE' }, utilitySourceId: sourceId, created: false };
    }

    const created = newId();
    await registerEntity({ client, projectId, scenarioId, revisionId, entityId: created, entityType: 'UTILITY_SOURCE', displayName: name, actorId });
    await client.query(
      `INSERT INTO utility_sources
         (utility_source_id, project_id, scenario_id, revision_id, envelope_id, kind, capacity_value, capacity_unit,
          capacity_basis, capacity_state, failure_domain_id, phase_id, available_from, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
      [created, projectId, scenarioId, revisionId, envelopeId, kind, capacityValue, capacityUnit, capacityBasis, capacityState, failureDomainId, phaseId, payload.available_from ?? null, JSON.stringify({ source_ref: 'change_set', confidence: 'MEDIUM' }), actorId],
    );
    return { entityRef: { entity_id: created, entity_type: 'UTILITY_SOURCE' }, utilitySourceId: created, created: true };
  },
};

/** Utility interfaces: exactly one source, a service state, and a phase. */
const setUtilityInterface = {
  kind: 'set_utility_interface',
  permission: 'facility.utility.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const sourceId = requireField(payload, 'utility_source_id');
    const serviceState = requireEnum(payload, 'service_state', SERVICE_STATES);
    const failureDomainId = requireField(payload, 'failure_domain_id');
    const phaseId = requireField(payload, 'phase_id');

    // An interface that resolves to no source is `facility.utility.interface.source_undefined`,
    // which is a finding — but a reference the store cannot resolve is not a finding, it
    // is a dangling row. So the source must exist.
    await assertBelongsToRevision({
      client, projectId, revisionId, table: 'utility_sources', idColumn: 'utility_source_id', id: sourceId, field: 'utility_source_id',
    });
    await assertBelongsToRevision({
      client, projectId, revisionId, table: 'failure_domains', idColumn: 'failure_domain_id', id: failureDomainId, field: 'failure_domain_id',
    });
    await assertBelongsToRevision({ client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: phaseId, field: 'phase_id' });

    const interfaceId = optionalId(payload, 'interface_id');
    const name = payload.name ?? 'Utility interface';
    // Capacity is all-or-nothing on an interface: either the whole declaration or none of
    // it, because a value with no unit is not a quantity.
    const declaresCapacity = payload.capacity_value !== undefined && payload.capacity_value !== null;
    const capacityValue = declaresCapacity ? requireNumber(payload, 'capacity_value') : null;
    const columns = [
      ['capacity_value', capacityValue],
      ['capacity_unit', declaresCapacity ? requireField(payload, 'capacity_unit') : null],
      ['capacity_basis', declaresCapacity ? requireEnum(payload, 'capacity_basis', CAPACITY_BASES) : null],
      ['capacity_state', declaresCapacity ? requireEnum(payload, 'capacity_state', SUPPLY_STATES) : null],
      ['service_state', serviceState],
    ];

    if (interfaceId) {
      const assignments = columns.map(([column], index) => `${column} = $${index + 4}`).join(', ');
      const updated = await client.query(
        `UPDATE utility_interfaces
            SET ${assignments}, failure_domain_id = $9, phase_id = $10, updated_at = now(), updated_by = $11
          WHERE project_id = $1 AND revision_id = $2 AND interface_id = $3
        RETURNING interface_id`,
        [projectId, revisionId, interfaceId, ...columns.map(([, value]) => value), failureDomainId, phaseId, actorId],
      );
      if (updated.rows.length === 0) {
        throw new ChangeRejected('The utility interface does not exist in this revision.', { field: 'payload.interface_id', reason: 'not_found' });
      }
      await client.query(
        `UPDATE entity_registry SET display_name = $4, updated_at = now(), updated_by = $5
          WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`,
        [projectId, revisionId, interfaceId, name, actorId],
      );
      return { entityRef: { entity_id: interfaceId, entity_type: 'UTILITY_INTERFACE' }, interfaceId, created: false };
    }

    const created = newId();
    await registerEntity({ client, projectId, scenarioId, revisionId, entityId: created, entityType: 'UTILITY_INTERFACE', displayName: name, actorId });
    await client.query(
      `INSERT INTO utility_interfaces
         (interface_id, project_id, scenario_id, revision_id, envelope_id, utility_source_id, capacity_value,
          capacity_unit, capacity_basis, capacity_state, service_state, failure_domain_id, phase_id, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
      [created, projectId, scenarioId, revisionId, envelopeId, sourceId, ...columns.map(([, value]) => value), failureDomainId, phaseId, JSON.stringify({ source_ref: 'change_set', confidence: 'MEDIUM' }), actorId],
    );
    return { entityRef: { entity_id: created, entity_type: 'UTILITY_INTERFACE' }, interfaceId: created, created: true };
  },
};

/** Failure domains: a tree, so the parent link is cycle-checked. */
const setFailureDomain = {
  kind: 'set_failure_domain',
  permission: 'facility.utility.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const name = requireField(payload, 'name');
    const domainKind = requireField(payload, 'kind');
    const parentId = optionalId(payload, 'parent_failure_domain_id');

    if (parentId) {
      await assertBelongsToRevision({
        client, projectId, revisionId, table: 'failure_domains', idColumn: 'failure_domain_id', id: parentId, field: 'parent_failure_domain_id',
      });
    }

    const domainId = optionalId(payload, 'failure_domain_id') ?? newId();
    await assertNoParentCycle({
      client, projectId, revisionId, table: 'failure_domains', idColumn: 'failure_domain_id', parentColumn: 'parent_failure_domain_id',
      id: domainId, parentId, label: 'failure-domain',
    });

    const changed = await client.query(
      `UPDATE failure_domains
          SET name = $3, kind = $4, parent_failure_domain_id = $5, updated_at = now(), updated_by = $6
        WHERE project_id = $1 AND revision_id = $2 AND failure_domain_id = $7
      RETURNING failure_domain_id`,
      [projectId, revisionId, name, domainKind, parentId, actorId, domainId],
    );

    if (changed.rows.length > 0) {
      await client.query(
        `UPDATE entity_registry SET display_name = $4, updated_at = now(), updated_by = $5
          WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`,
        [projectId, revisionId, domainId, name, actorId],
      );
      return { entityRef: { entity_id: domainId, entity_type: 'FAILURE_DOMAIN' }, failureDomainId: domainId, created: false };
    }

    await registerEntity({ client, projectId, scenarioId, revisionId, entityId: domainId, entityType: 'FAILURE_DOMAIN', displayName: name, actorId });
    await client.query(
      `INSERT INTO failure_domains
         (failure_domain_id, project_id, scenario_id, revision_id, envelope_id, parent_failure_domain_id, name, kind, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [domainId, projectId, scenarioId, revisionId, envelopeId, parentId, name, domainKind, JSON.stringify({ source_ref: 'change_set' }), actorId],
    );
    return { entityRef: { entity_id: domainId, entity_type: 'FAILURE_DOMAIN' }, failureDomainId: domainId, created: true };
  },
};

/** Storage reserves: fuel and water, with an autonomy duration. */
const setStorageReserve = {
  kind: 'set_storage_reserve',
  permission: 'facility.utility.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const kind = requireEnum(payload, 'kind', RESERVE_KINDS);
    const capacityUnit = requireField(payload, 'capacity_unit');
    const capacityBasis = requireEnum(payload, 'capacity_basis', CAPACITY_BASES);
    const capacityState = requireEnum(payload, 'capacity_state', SUPPLY_STATES);
    const failureDomainId = requireField(payload, 'failure_domain_id');
    const phaseId = requireField(payload, 'phase_id');
    const name = payload.name ?? `${kind === 'FUEL' ? 'Fuel' : 'Water'} storage`;

    // Capacity and autonomy are both nullable, and both have checks that report their
    // absence or insufficiency, so neither is required here.
    const capacityValue = payload.capacity_value === undefined || payload.capacity_value === null ? null : requireNumber(payload, 'capacity_value');
    const autonomy = payload.autonomy_duration_seconds === undefined || payload.autonomy_duration_seconds === null
      ? null
      : requireNumber(payload, 'autonomy_duration_seconds');

    // The store pairs a reserve's kind with its basis: fuel is measured in volume and
    // water in flow. Answering with the pairing is more use than answering with the
    // constraint that enforces it.
    const requiredBasis = kind === 'FUEL' ? 'FUEL_VOLUME' : 'WATER_FLOW';
    if (capacityBasis !== requiredBasis) {
      throw new ChangeRejected(`A ${kind} reserve is measured on the "${requiredBasis}" basis.`, {
        field: 'payload.capacity_basis',
        reason: 'basis_does_not_match_kind',
        expected: requiredBasis,
        actual: capacityBasis,
      });
    }

    await assertBelongsToRevision({ client, projectId, revisionId, table: 'failure_domains', idColumn: 'failure_domain_id', id: failureDomainId, field: 'failure_domain_id' });
    await assertBelongsToRevision({ client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: phaseId, field: 'phase_id' });

    const storageId = optionalId(payload, 'storage_id') ?? newId();
    const changed = await client.query(
      `UPDATE storage_reserves
          SET kind = $3, capacity_value = $4, capacity_unit = $5, capacity_basis = $6, capacity_state = $7,
              autonomy_duration_seconds = $8, failure_domain_id = $9, phase_id = $10, updated_at = now(), updated_by = $11
        WHERE project_id = $1 AND revision_id = $2 AND storage_id = $12
      RETURNING storage_id`,
      [projectId, revisionId, kind, capacityValue, capacityUnit, capacityBasis, capacityState, autonomy, failureDomainId, phaseId, actorId, storageId],
    );

    if (changed.rows.length > 0) return { entityRef: { entity_id: storageId, entity_type: 'FUEL_STORAGE' }, storageId, created: false };

    await registerEntity({ client, projectId, scenarioId, revisionId, entityId: storageId, entityType: kind === 'FUEL' ? 'FUEL_STORAGE' : 'WATER_STORAGE', displayName: name, actorId });
    await client.query(
      `INSERT INTO storage_reserves
         (storage_id, project_id, scenario_id, revision_id, envelope_id, kind, capacity_value, capacity_unit,
          capacity_basis, capacity_state, autonomy_duration_seconds, failure_domain_id, phase_id, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
      [storageId, projectId, scenarioId, revisionId, envelopeId, kind, capacityValue, capacityUnit, capacityBasis, capacityState, autonomy, failureDomainId, phaseId, JSON.stringify({ source_ref: 'change_set' }), actorId],
    );
    return { entityRef: { entity_id: storageId, entity_type: kind === 'FUEL' ? 'FUEL_STORAGE' : 'WATER_STORAGE' }, storageId, created: true };
  },
};

/**
 * The active resilience requirement.
 *
 * "Replaces the active requirement" is the contract's word, and it matters: two active
 * requirements would make `facility.resilience.*` ambiguous about which policy applies.
 * So the previous actives are deactivated in the same change rather than left standing.
 */
const setResilienceRequirement = {
  kind: 'set_resilience_requirement',
  permission: 'facility.utility.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const availabilityPolicy = requireEnum(payload, 'availability_policy', AVAILABILITY_POLICIES);
    const policyId = requireField(payload, 'policy_id');
    const resolved = requirePinnedPolicy(policyId);
    const appliesTo = Array.isArray(payload.applies_to) ? payload.applies_to : [];
    for (const resourceKind of appliesTo) {
      if (!RESOURCE_KINDS.includes(resourceKind)) {
        throw new ChangeRejected('An applied resource kind is not one the store accepts.', {
          field: 'payload.applies_to', reason: 'not_allowed', allowed: [...RESOURCE_KINDS], actual: resourceKind,
        });
      }
    }
    if (appliesTo.length === 0) {
      throw new ChangeRejected('A resilience requirement must name the resource kinds it applies to.', {
        field: 'payload.applies_to', reason: 'required',
      });
    }

    // A policy may demand more independent paths than the named policy version carries;
    // that is a finding (`facility.resilience.redundancy.path_count`), not a refusal. The
    // policy reference itself, though, has to resolve — an unresolvable policy is a
    // requirement nobody can evaluate.
    const superseded = await client.query(
      `UPDATE resilience_requirements SET active = false, updated_at = now(), updated_by = $3
        WHERE project_id = $1 AND revision_id = $2 AND active = true
      RETURNING requirement_id`,
      [projectId, revisionId, actorId],
    );

    const requirementId = optionalId(payload, 'requirement_id') ?? newId();
    await registerEntity({ client, projectId, scenarioId, revisionId, entityId: requirementId, entityType: 'RESILIENCE_REQUIREMENT', displayName: `Resilience requirement (${availabilityPolicy})`, actorId });
    await client.query(
      `INSERT INTO resilience_requirements
         (requirement_id, project_id, scenario_id, revision_id, envelope_id, availability_policy, policy_id,
          applies_to, autonomy_duration_seconds, active, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::resource_kind[], $9, true, $10::jsonb, $11)`,
      [requirementId, projectId, scenarioId, revisionId, envelopeId, availabilityPolicy, policyId, appliesTo, payload.autonomy_duration_seconds ?? null, JSON.stringify({ source_ref: 'change_set', policy_version: resolved.policy.version }), actorId],
    );

    return {
      entityRef: { entity_id: requirementId, entity_type: 'RESILIENCE_REQUIREMENT' },
      requirementId,
      supersededRequirementIds: superseded.rows.map((row) => row.requirement_id),
      created: true,
    };
  },
};

/** Capacity budgets: one per owner, phase, resource kind and basis. */
const setCapacityBudget = {
  kind: 'set_capacity_budget',
  permission: 'facility.capacity.allocate',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const ownerEntityId = requireField(payload, 'owner_entity_id');
    const phaseId = requireField(payload, 'phase_id');
    const resourceKind = requireEnum(payload, 'resource_kind', RESOURCE_KINDS);
    const basis = requireEnum(payload, 'basis', CAPACITY_BASES);
    const unit = requireField(payload, 'unit');

    await resolveEntity({ client, projectId, revisionId, entityRef: { entity_id: ownerEntityId } });
    await assertBelongsToRevision({ client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: phaseId, field: 'phase_id' });

    const quantities = {};
    for (const field of ['commissioned_value', 'planned_value', 'reserved_value', 'allocated_value', 'available_value']) {
      quantities[field] = payload[field] === undefined || payload[field] === null ? 0 : requireNumber(payload, field);
    }
    const deratingFactor = payload.derating_factor === undefined || payload.derating_factor === null ? 0 : requireNumber(payload, 'derating_factor');
    assertRange(deratingFactor, { min: 0, max: 1, field: 'derating_factor' });

    const budgetId = optionalId(payload, 'budget_id');
    if (budgetId) {
      const updated = await client.query(
        `UPDATE capacity_budgets
            SET owner_entity_id = $3, phase_id = $4, resource_kind = $5, basis = $6, unit = $7,
                commissioned_value = $8, planned_value = $9, reserved_value = $10, allocated_value = $11,
                available_value = $12, derating_factor = $13, updated_at = now(), updated_by = $14
          WHERE project_id = $1 AND revision_id = $2 AND budget_id = $15
        RETURNING budget_id`,
        [projectId, revisionId, ownerEntityId, phaseId, resourceKind, basis, unit, ...Object.values(quantities), deratingFactor, actorId, budgetId],
      );
      if (updated.rows.length === 0) {
        throw new ChangeRejected('The capacity budget does not exist in this revision.', { field: 'payload.budget_id', reason: 'not_found' });
      }
      return { entityRef: { entity_id: ownerEntityId, entity_type: 'CAPACITY_BUDGET' }, budgetId, created: false };
    }

    // A second budget for the same owner, phase, resource and basis makes firm
    // availability ambiguous, so the contract rejects it rather than reporting it.
    const duplicate = await client.query(
      `SELECT budget_id FROM capacity_budgets
        WHERE project_id = $1 AND revision_id = $2 AND owner_entity_id = $3 AND phase_id = $4
          AND resource_kind = $5 AND basis = $6`,
      [projectId, revisionId, ownerEntityId, phaseId, resourceKind, basis],
    );
    if (duplicate.rows.length > 0) {
      throw new ChangeConflict('A budget already exists for that owner, phase, resource kind and basis.', {
        reason: 'duplicate_budget',
        existing_budget_id: duplicate.rows[0].budget_id,
        owner_entity_id: ownerEntityId,
        phase_id: phaseId,
        resource_kind: resourceKind,
        basis,
      });
    }

    const created = newId();
    await client.query(
      `INSERT INTO capacity_budgets
         (budget_id, project_id, scenario_id, revision_id, envelope_id, owner_entity_id, phase_id, resource_kind,
          basis, unit, commissioned_value, planned_value, reserved_value, allocated_value, available_value,
          derating_factor, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)`,
      [created, projectId, scenarioId, revisionId, envelopeId, ownerEntityId, phaseId, resourceKind, basis, unit, ...Object.values(quantities), deratingFactor, JSON.stringify({ source_ref: 'change_set' }), actorId],
    );
    return { entityRef: { entity_id: ownerEntityId, entity_type: 'CAPACITY_BUDGET' }, budgetId: created, created: true };
  },
};

/** Environmental constraints, hung off the revision's profile. */
const setEnvironmentalConstraint = {
  kind: 'set_environmental_constraint',
  permission: 'facility.constraint.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const profileId = requireField(payload, 'profile_id');
    const constraintKind = requireField(payload, 'constraint_kind');
    const thresholdValue = requireNumber(payload, 'threshold_value');
    const thresholdUnit = requireField(payload, 'threshold_unit');
    // `basis` reuses the capacity_basis enum, so an arbitrary unit-of-measure string is
    // not accepted.
    const basis = requireEnum(payload, 'basis', CAPACITY_BASES);
    const affectedEntityId = optionalId(payload, 'affected_entity_id');
    assertWindow({
      from: payload.effective_at,
      to: payload.effective_until,
      fromField: 'effective_at',
      toField: 'effective_until',
      label: 'The effective window',
    });

    await assertBelongsToRevision({ client, projectId, revisionId, table: 'environmental_profiles', idColumn: 'profile_id', id: profileId, field: 'profile_id' });
    if (affectedEntityId) {
      await resolveEntity({ client, projectId, revisionId, entityRef: { entity_id: affectedEntityId } });
    }

    const constraintId = optionalId(payload, 'environmental_constraint_id');
    if (constraintId) {
      const updated = await client.query(
        `UPDATE environmental_constraints
            SET profile_id = $3, affected_entity_id = $4, constraint_kind = $5, threshold_value = $6,
                threshold_unit = $7, basis = $8, effective_at = $9, effective_until = $10, updated_at = now(), updated_by = $11
          WHERE project_id = $1 AND revision_id = $2 AND environmental_constraint_id = $12
        RETURNING environmental_constraint_id`,
        [projectId, revisionId, profileId, affectedEntityId, constraintKind, thresholdValue, thresholdUnit, basis, payload.effective_at ?? null, payload.effective_until ?? null, actorId, constraintId],
      );
      if (updated.rows.length === 0) {
        throw new ChangeRejected('The environmental constraint does not exist in this revision.', { field: 'payload.environmental_constraint_id', reason: 'not_found' });
      }
      return { entityRef: { entity_id: constraintId, entity_type: 'ENVIRONMENTAL_CONSTRAINT' }, environmentalConstraintId: constraintId, created: false };
    }

    const created = newId();
    await client.query(
      `INSERT INTO environmental_constraints
         (environmental_constraint_id, project_id, scenario_id, revision_id, envelope_id, profile_id, affected_entity_id,
          applies_to_geometry_id, constraint_kind, threshold_value, threshold_unit, basis, effective_at, effective_until,
          provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)`,
      [created, projectId, scenarioId, revisionId, envelopeId, profileId, affectedEntityId, optionalId(payload, 'applies_to_geometry_id'), constraintKind, thresholdValue, thresholdUnit, basis, payload.effective_at ?? null, payload.effective_until ?? null, JSON.stringify({ source_ref: 'change_set' }), actorId],
    );
    return { entityRef: { entity_id: created, entity_type: 'ENVIRONMENTAL_CONSTRAINT' }, environmentalConstraintId: created, created: true };
  },
};

/** Spatial constraints: the setback and height rules the site checks read. */
const assignConstraint = {
  kind: 'assign_constraint',
  permission: 'facility.constraint.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const constraintKind = requireEnum(payload, 'constraint_kind', CONSTRAINT_KINDS);
    const severity = requireEnum(payload, 'severity', SEVERITIES);
    const scopeId = optionalId(payload, 'scope_id');
    const containerId = optionalId(payload, 'container_id');
    const geometryId = optionalId(payload, 'applies_to_geometry_id');

    // A constraint hangs off exactly one anchor: the site scope, or a container. Both
    // would leave it ambiguous which boundary it measures against, and neither would
    // leave it unanchored.
    if ((scopeId !== null) === (containerId !== null)) {
      throw new ChangeRejected('A spatial constraint is anchored to exactly one of a scope or a container.', {
        field: 'payload.container_id',
        reason: 'anchor_not_exclusive',
        note: 'Pass scope_id for a site-wide rule, or container_id for one that applies to a single object.',
      });
    }
    const ruleValue = payload.rule_value ?? null;
    if (ruleValue !== null && (!payload.rule_kind || !payload.rule_unit)) {
      throw new ChangeRejected('A numeric rule declares its kind and its unit as well as its value.', {
        field: 'payload.rule_value',
        reason: 'incomplete_rule',
        note: 'A number with no unit is not a constraint.',
      });
    }

    if (scopeId) await assertBelongsToRevision({ client, projectId, revisionId, table: 'design_scopes', idColumn: 'scope_id', id: scopeId, field: 'scope_id' });
    if (containerId) await assertBelongsToRevision({ client, projectId, revisionId, table: 'facility_containers', idColumn: 'container_id', id: containerId, field: 'container_id' });
    if (geometryId) await assertBelongsToRevision({ client, projectId, revisionId, table: 'geometry_records', idColumn: 'geometry_id', id: geometryId, field: 'applies_to_geometry_id' });

    // The contract's payload carries an optional `policy_id`, but `spatial_constraints`
    // has no such column. Refusing it is the honest answer: accepting and dropping it
    // would let a caller believe a constraint was pinned to a policy when nothing
    // recorded it.
    if (payload.policy_id) {
      requirePinnedPolicy(payload.policy_id);
      throw new ChangeRejected('This store does not record a policy reference on a spatial constraint.', {
        field: 'payload.policy_id',
        reason: 'not_supported_by_store',
        note: 'The specification declares it; `spatial_constraints` has no column for it. Pin the rule through provenance until the schema carries it.',
      });
    }

    const constraintId = optionalId(payload, 'constraint_id') ?? newId();
    const changed = await client.query(
      `UPDATE spatial_constraints
          SET scope_id = $3, container_id = $4, applies_to_geometry_id = $5, kind = $6, severity = $7,
              rule_kind = $8, rule_value = $9, rule_unit = $10, updated_at = now(), updated_by = $11
        WHERE project_id = $1 AND revision_id = $2 AND constraint_id = $12
      RETURNING constraint_id`,
      [projectId, revisionId, scopeId, containerId, geometryId, constraintKind, severity, payload.rule_kind ?? null, payload.rule_value ?? null, payload.rule_unit ?? null, actorId, constraintId],
    );

    if (changed.rows.length > 0) {
      await client.query(
        `UPDATE entity_registry SET display_name = $4, updated_at = now(), updated_by = $5
          WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`,
        [projectId, revisionId, constraintId, `${constraintKind} constraint`, actorId],
      );
      return { entityRef: { entity_id: constraintId, entity_type: 'SPATIAL_CONSTRAINT' }, constraintId, created: false };
    }

    await registerEntity({ client, projectId, scenarioId, revisionId, entityId: constraintId, entityType: 'SPATIAL_CONSTRAINT', displayName: `${constraintKind} constraint`, actorId });
    await client.query(
      `INSERT INTO spatial_constraints
         (constraint_id, project_id, scenario_id, revision_id, envelope_id, scope_id, container_id,
          applies_to_geometry_id, kind, severity, rule_kind, rule_value, rule_unit, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
      [constraintId, projectId, scenarioId, revisionId, envelopeId, scopeId, containerId, geometryId, constraintKind, severity, payload.rule_kind ?? null, payload.rule_value ?? null, payload.rule_unit ?? null, JSON.stringify({ source_ref: 'change_set' }), actorId],
    );
    return { entityRef: { entity_id: constraintId, entity_type: 'SPATIAL_CONSTRAINT' }, constraintId, created: true };
  },
};

/** Assigning an entity to a phase; the container column is where a phase lives. */
const assignPhase = {
  kind: 'assign_phase',
  permission: 'facility.phase.write',
  async apply({ client, projectId, revisionId, actorId, change }) {
    const payload = change.payload ?? {};
    const entityRef = change.entity_ref ?? {};
    const entity = await resolveEntity({ client, projectId, revisionId, entityRef });
    const phaseId = requireField(payload, 'phase_id');
    await assertBelongsToRevision({ client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: phaseId, field: 'phase_id' });

    const { rowCount } = await client.query(
      `UPDATE facility_containers SET phase_id = $4, updated_at = now(), updated_by = $5
        WHERE project_id = $1 AND revision_id = $2 AND container_id = $3`,
      [projectId, revisionId, entity.entity_id, phaseId, actorId],
    );
    if (rowCount === 0) {
      throw new ChangeRejected('Only a container carries a phase assignment.', {
        field: 'entity_ref.entity_id',
        reason: 'not_a_container',
        entity_type: entity.entity_type,
      });
    }
    return { entityRef: { entity_id: entity.entity_id, entity_type: entity.entity_type }, phaseId, created: false };
  },
};

/** Phase dependencies: ordered, acyclic, and not duplicated. */
const setPhaseDependency = {
  kind: 'set_phase_dependency',
  permission: 'facility.phase.write',
  async apply({ client, projectId, scenarioId, revisionId, actorId, change }) {
    const payload = change.payload ?? {};
    const predecessorId = requireField(payload, 'predecessor_phase_id');
    const successorId = requireField(payload, 'successor_phase_id');

    if (predecessorId === successorId) {
      throw new ChangeRejected('A phase cannot depend on itself.', { field: 'payload.successor_phase_id', reason: 'self_dependency' });
    }
    await assertBelongsToRevision({ client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: predecessorId, field: 'predecessor_phase_id' });
    await assertBelongsToRevision({ client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: successorId, field: 'successor_phase_id' });

    const duplicate = await client.query(
      `SELECT 1 FROM phase_dependencies
        WHERE project_id = $1 AND revision_id = $2 AND predecessor_phase_id = $3 AND successor_phase_id = $4`,
      [projectId, revisionId, predecessorId, successorId],
    );
    if (duplicate.rows.length > 0) {
      throw new ChangeConflict('That dependency already exists.', {
        reason: 'duplicate_dependency', predecessor_phase_id: predecessorId, successor_phase_id: successorId,
      });
    }

    await assertNoPhaseCycle({ client, projectId, revisionId, predecessorId, successorId });

    await client.query(
      `INSERT INTO phase_dependencies
         (predecessor_phase_id, successor_phase_id, project_id, scenario_id, revision_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [predecessorId, successorId, projectId, scenarioId, revisionId, actorId],
    );
    return { entityRef: null, predecessorPhaseId: predecessorId, successorPhaseId: successorId, created: true };
  },
};

/** An assumption, with the confidence the catalog's checks read. */
const recordAssumption = {
  kind: 'record_assumption',
  permission: 'facility.entity.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const statement = requireField(payload, 'statement');
    const owner = requireField(payload, 'owner');
    const confidence = requireEnum(payload, 'confidence', CONFIDENCES);
    // The store requires it, and staleness is measured from it
    // (`facility.data.provenance.stale`), so it is not optional.
    const effectiveAt = requireField(payload, 'effective_at');
    assertWindow({ from: effectiveAt, to: payload.expires_at, fromField: 'effective_at', toField: 'expires_at', label: 'An assumption expiry' });
    const entityRefs = Array.isArray(payload.entity_refs) ? payload.entity_refs : [];
    for (const ref of entityRefs) {
      // eslint-disable-next-line no-await-in-loop
      await resolveEntity({ client, projectId, revisionId, entityRef: ref });
    }

    const assumptionId = newId();
    await registerEntity({ client, projectId, scenarioId, revisionId, entityId: assumptionId, entityType: 'ASSUMPTION', displayName: statement.slice(0, 120), actorId });
    await client.query(
      `INSERT INTO assumptions
         (assumption_id, project_id, scenario_id, revision_id, envelope_id, statement, owner, confidence,
          effective_at, expires_at, status, entity_refs, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'OPEN', $11::jsonb, $12::jsonb, $13)`,
      [assumptionId, projectId, scenarioId, revisionId, envelopeId, statement, owner, confidence, effectiveAt, payload.expires_at ?? null, JSON.stringify(entityRefs), JSON.stringify({ source_ref: 'change_set' }), actorId],
    );
    return { entityRef: { entity_id: assumptionId, entity_type: 'ASSUMPTION' }, assumptionId, created: true };
  },
};

/**
 * Closing an assumption.
 *
 * The store has no resolution column, so the resolution text is recorded in
 * `provenance` alongside the time — the alternative is discarding what the user wrote,
 * and an assumption closed with no reason is not auditable. Resolving does not promote
 * coverage: only a later run does that ([D11]).
 */
const resolveAssumption = {
  kind: 'resolve_assumption',
  permission: 'facility.entity.write',
  async apply({ client, projectId, revisionId, actorId, change }) {
    const payload = change.payload ?? {};
    const assumptionId = requireField(payload, 'assumption_id');
    const { rows } = await client.query(
      `SELECT statement, status, provenance FROM assumptions
        WHERE project_id = $1 AND revision_id = $2 AND assumption_id = $3`,
      [projectId, revisionId, assumptionId],
    );
    const assumption = rows[0];
    if (!assumption) {
      throw new ChangeRejected('The assumption does not exist in this revision.', { field: 'payload.assumption_id', reason: 'not_found' });
    }
    if (assumption.status !== 'OPEN') {
      throw new ChangeConflict('Only an open assumption can be resolved.', {
        reason: 'not_open', assumption_id: assumptionId, status: assumption.status,
      });
    }

    await client.query(
      `UPDATE assumptions
          SET status = 'RESOLVED', provenance = $4::jsonb, updated_at = now(), updated_by = $5
        WHERE project_id = $1 AND revision_id = $2 AND assumption_id = $3`,
      [
        projectId,
        revisionId,
        assumptionId,
        JSON.stringify({
          ...(assumption.provenance ?? {}),
          resolution: payload.resolution ?? null,
          resolved_at: new Date().toISOString(),
        }),
        actorId,
      ],
    );
    return { entityRef: { entity_id: assumptionId, entity_type: 'ASSUMPTION' }, assumptionId, created: false };
  },
};

/**
 * Document metadata.
 *
 * The bytes stay in the project asset layer; this records that a version of an artifact
 * belongs to the revision, addressed by checksum and key. It never carries the bytes,
 * and it never carries a signed URL — the contract's rule that a document is metadata
 * about an artifact, not the artifact.
 */
const attachDocument = {
  kind: 'attach_document',
  permission: 'facility.document.manage',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const documentKind = requireEnum(payload, 'kind', DOCUMENT_KINDS);
    const title = requireField(payload, 'title');
    const mediaType = requireField(payload, 'media_type');
    const contentChecksum = requireField(payload, 'content_checksum');
    const storageKey = requireField(payload, 'storage_key');
    const owner = requireField(payload, 'owner');
    assertWindow({ from: payload.issued_at, to: payload.expires_at, fromField: 'issued_at', toField: 'expires_at', label: 'A document expiry' });
    const entityRefs = Array.isArray(payload.entity_refs) ? payload.entity_refs : [];
    for (const ref of entityRefs) {
      // eslint-disable-next-line no-await-in-loop
      await resolveEntity({ client, projectId, revisionId, entityRef: ref });
    }

    // One document per checksum per project: the same bytes are the same artifact, and a
    // second row for them would be two records of one thing.
    const duplicate = await client.query(
      'SELECT document_id FROM documents WHERE project_id = $1 AND content_checksum = $2',
      [projectId, contentChecksum],
    );
    if (duplicate.rows.length > 0) {
      throw new ChangeConflict('A document with that content checksum is already attached to this project.', {
        reason: 'duplicate_checksum',
        existing_document_id: duplicate.rows[0].document_id,
        content_checksum: contentChecksum,
      });
    }

    const documentId = newId();
    await registerEntity({ client, projectId, scenarioId, revisionId, entityId: documentId, entityType: 'DOCUMENT', displayName: title, actorId });
    await client.query(
      `INSERT INTO documents
         (document_id, project_id, scenario_id, revision_id, kind, title, media_type, content_checksum,
          storage_key, owner, issued_at, expires_at, entity_refs, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15)`,
      [documentId, projectId, scenarioId, revisionId, documentKind, title, mediaType, contentChecksum, storageKey, owner, payload.issued_at ?? null, payload.expires_at ?? null, JSON.stringify(entityRefs), JSON.stringify({ source_ref: 'change_set' }), actorId],
    );
    return { entityRef: { entity_id: documentId, entity_type: 'DOCUMENT' }, documentId, created: true };
  },
};

/** Detaching a document removes the reference for this revision, not the asset. */
const detachDocument = {
  kind: 'detach_document',
  permission: 'facility.document.manage',
  async apply({ client, projectId, revisionId, actorId, change }) {
    const payload = change.payload ?? {};
    const documentId = requireField(payload, 'document_id');
    const { rowCount } = await client.query(
      `DELETE FROM documents WHERE project_id = $1 AND revision_id = $2 AND document_id = $3`,
      [projectId, revisionId, documentId],
    );
    if (rowCount === 0) {
      throw new ChangeRejected('The document does not exist in this revision.', { field: 'payload.document_id', reason: 'not_found' });
    }
    await client.query(
      `UPDATE entity_registry SET status = 'SUPERSEDED', updated_at = now(), updated_by = $4
        WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`,
      [projectId, revisionId, documentId, actorId],
    );
    return { entityRef: { entity_id: documentId, entity_type: 'DOCUMENT' }, documentId, created: false };
  },
};

/** Phase records themselves: name, order, activation, status. */
const setPhase = {
  kind: 'set_phase',
  permission: 'facility.phase.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const name = requireField(payload, 'name');
    const phaseOrder = requireNumber(payload, 'phase_order');
    const status = optionalEnum(payload, 'status', PHASE_STATUSES) ?? 'PLANNED';

    const phaseId = optionalId(payload, 'phase_id') ?? newId();
    const changed = await client.query(
      `UPDATE facility_phases
          SET name = $3, phase_order = $4, activation_date = $5, activation_date_precision = $6, status = $7,
              updated_at = now(), updated_by = $8
        WHERE project_id = $1 AND revision_id = $2 AND phase_id = $9
      RETURNING phase_id`,
      [projectId, revisionId, name, phaseOrder, payload.activation_date ?? null, payload.activation_date_precision ?? null, status, actorId, phaseId],
    );

    if (changed.rows.length > 0) {
      await client.query(
        `UPDATE entity_registry SET display_name = $4, updated_at = now(), updated_by = $5
          WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`,
        [projectId, revisionId, phaseId, name, actorId],
      );
      return { entityRef: { entity_id: phaseId, entity_type: 'FACILITY_PHASE' }, phaseId, created: false };
    }

    const orderTaken = await client.query(
      `SELECT phase_id FROM facility_phases
        WHERE project_id = $1 AND revision_id = $2 AND envelope_id = $3 AND phase_order = $4`,
      [projectId, revisionId, envelopeId, phaseOrder],
    );
    if (orderTaken.rows.length > 0) {
      throw new ChangeConflict('Another phase already occupies that order.', {
        reason: 'duplicate_phase_order',
        existing_phase_id: orderTaken.rows[0].phase_id,
        phase_order: phaseOrder,
      });
    }

    await registerEntity({ client, projectId, scenarioId, revisionId, entityId: phaseId, entityType: 'FACILITY_PHASE', displayName: name, actorId });
    await client.query(
      `INSERT INTO facility_phases
         (phase_id, project_id, scenario_id, revision_id, envelope_id, name, phase_order, activation_date,
          activation_date_precision, status, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [phaseId, projectId, scenarioId, revisionId, envelopeId, name, phaseOrder, payload.activation_date ?? null, payload.activation_date_precision ?? null, status, JSON.stringify({ source_ref: 'change_set' }), actorId],
    );
    return { entityRef: { entity_id: phaseId, entity_type: 'FACILITY_PHASE' }, phaseId, created: true };
  },
};

/** Phase capability availability: when a phase can offer a capability. */
const setPhaseCapability = {
  kind: 'set_phase_capability',
  permission: 'facility.phase.write',
  async apply({ client, projectId, scenarioId, revisionId, actorId, change }) {
    const payload = change.payload ?? {};
    const phaseId = requireField(payload, 'phase_id');
    const capability = requireField(payload, 'capability');
    await assertBelongsToRevision({ client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: phaseId, field: 'phase_id' });

    const available = payload.available === true;
    // A capability that is available has to say from when; otherwise a phase planner
    // cannot tell whether it is available yet.
    if (available && !payload.available_from) {
      throw new ChangeRejected('A capability that is available requires the date it becomes available.', {
        field: 'payload.available_from',
        reason: 'required_when_available',
      });
    }
    const existing = await client.query(
      `SELECT 1 FROM phase_capability_availability
        WHERE project_id = $1 AND revision_id = $2 AND phase_id = $3 AND capability = $4`,
      [projectId, revisionId, phaseId, capability],
    );

    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE phase_capability_availability
            SET available = $5, available_from = $6, notes = $7, updated_at = now(), updated_by = $8
          WHERE project_id = $1 AND revision_id = $2 AND phase_id = $3 AND capability = $4`,
        [projectId, revisionId, phaseId, capability, available, payload.available_from ?? null, payload.notes ?? null, actorId],
      );
      return { entityRef: null, phaseId, capability, available, created: false };
    }

    await client.query(
      `INSERT INTO phase_capability_availability
         (phase_id, capability, project_id, scenario_id, revision_id, available, available_from, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [phaseId, capability, projectId, scenarioId, revisionId, available, payload.available_from ?? null, payload.notes ?? null, actorId],
    );
    return { entityRef: null, phaseId, capability, available, created: true };
  },
};

export const AUTHORED_KINDS = Object.freeze({
  set_utility_source: setUtilitySource,
  set_utility_interface: setUtilityInterface,
  set_failure_domain: setFailureDomain,
  set_storage_reserve: setStorageReserve,
  set_resilience_requirement: setResilienceRequirement,
  set_capacity_budget: setCapacityBudget,
  set_environmental_constraint: setEnvironmentalConstraint,
  assign_constraint: assignConstraint,
  assign_phase: assignPhase,
  set_phase: setPhase,
  set_phase_dependency: setPhaseDependency,
  set_phase_capability: setPhaseCapability,
  record_assumption: recordAssumption,
  resolve_assumption: resolveAssumption,
  attach_document: attachDocument,
  detach_document: detachDocument,
});

export { ChangeConflict, ChangeRejected, QUANTITY_STATES };
