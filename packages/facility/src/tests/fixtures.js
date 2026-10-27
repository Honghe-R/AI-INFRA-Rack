import { randomUUID } from 'node:crypto';

/**
 * Fixtures for the constraint pairs.
 *
 * `seedBaseline` writes a revision that is clean for every catalog check whose
 * evidence exists, so each constraint's positive fixture is the baseline itself
 * and its negative fixture is one deliberate mutation. The graph is deliberately
 * small: a site, a parcel, one building, one yard, four utility sources with
 * their interfaces and connection points, two phases, two failure domains, a
 * budget with an accepted allocation, a profile, one constraint of each kind, one
 * route, one binding with a reviewed mapping and feature, and one resolved
 * assumption.
 *
 * Every geometry is given as projected WKT in EPSG:32618 and transformed to WGS 84
 * for the interoperable column, so the fixture cannot accidentally hold a
 * geometry whose two representations disagree.
 */

const rect = (x1, y1, x2, y2) => `POLYGON((${x1} ${y1}, ${x2} ${y1}, ${x2} ${y2}, ${x1} ${y2}, ${x1} ${y1}))`;
const line = (x1, y1, x2, y2) => `LINESTRING(${x1} ${y1}, ${x2} ${y2})`;
const point = (x, y) => `POINT(${x} ${y})`;

const SITE = rect(0, 0, 600, 400);
const BUILDING = rect(50, 50, 200, 150);
const YARD = rect(300, 50, 400, 150);
const EASEMENT = rect(480, 280, 580, 380);
const HAZARD = rect(480, 20, 580, 120);
const ROUTE = line(430, 200, 500, 200);
const CONNECTION = point(500, 200);

export async function seedBaseline(client, { projectId, scenarioId, revisionId, actorId = null, requestId = randomUUID() }) {
  const id = (name) => ({ name, value: randomUUID() });
  const envelope = id('envelope');
  const scope = id('scope');
  const parcel = id('parcel');
  const building = id('building');
  const yard = id('yard');
  const phase1 = id('phase1');
  const phase2 = id('phase2');
  const domainA = id('domainA');
  const domainB = id('domainB');
  const requirement = id('requirement');
  const powerA = id('powerA');
  const powerB = id('powerB');
  const coolingA = id('coolingA');
  const coolingB = id('coolingB');
  const ifacePowerA = id('ifacePowerA');
  const ifacePowerB = id('ifacePowerB');
  const ifaceCoolingA = id('ifaceCoolingA');
  const ifaceCoolingB = id('ifaceCoolingB');
  const budget = id('budget');
  const demand = id('demand');
  const allocation = id('allocation');
  const profile = id('profile');
  const envConstraint = id('envConstraint');
  const assumption = id('assumption');
  const binding = id('binding');
  const transform = id('transform');
  const mapping = id('mapping');
  const feature = id('feature');
  const setback = id('setback');
  const height = id('height');
  const easement = id('easement');
  const hazard = id('hazard');
  const cycleRoute = id('route');
  const routeEntity = randomUUID();
  const fuelStorage = id('fuelStorage');

  const ids = {
    projectId, scenarioId, revisionId,
    envelope: envelope.value, scope: scope.value, parcel: parcel.value, building: building.value, yard: yard.value,
    phase1: phase1.value, phase2: phase2.value, domainA: domainA.value, domainB: domainB.value,
    requirement: requirement.value, powerA: powerA.value, powerB: powerB.value,
    coolingA: coolingA.value, coolingB: coolingB.value,
    ifacePowerA: ifacePowerA.value, ifacePowerB: ifacePowerB.value,
    ifaceCoolingA: ifaceCoolingA.value, ifaceCoolingB: ifaceCoolingB.value,
    budget: budget.value, demand: demand.value, allocation: allocation.value,
    profile: profile.value, envConstraint: envConstraint.value, assumption: assumption.value,
    binding: binding.value, transform: transform.value, mapping: mapping.value, feature: feature.value,
    setback: setback.value, height: height.value, easement: easement.value, hazard: hazard.value,
    route: cycleRoute.value, routeEntity, fuelStorage: fuelStorage.value, requestId,
  };

  const q = (sql, params) => client.query(sql, params);
  const scoped = [projectId, scenarioId, revisionId];

  await q(
    `INSERT INTO facility_envelopes (envelope_id, project_id, scenario_id, revision_id, lifecycle_state, approval_state)
     VALUES ($1, $2, $3, $4, 'DRAFT', 'NOT_REQUIRED')`,
    [envelope.value, ...scoped],
  );

  const entities = [
    [scope.value, 'SITE'], [parcel.value, 'PARCEL'], [building.value, 'BUILDING'], [yard.value, 'EQUIPMENT_YARD'],
    [phase1.value, 'FACILITY_PHASE'], [phase2.value, 'FACILITY_PHASE'],
    [domainA.value, 'FAILURE_DOMAIN'], [domainB.value, 'FAILURE_DOMAIN'],
    [requirement.value, 'RESILIENCE_REQUIREMENT'],
    [powerA.value, 'UTILITY_SOURCE'], [powerB.value, 'UTILITY_SOURCE'],
    [coolingA.value, 'UTILITY_SOURCE'], [coolingB.value, 'UTILITY_SOURCE'],
    [ifacePowerA.value, 'UTILITY_INTERFACE'], [ifacePowerB.value, 'UTILITY_INTERFACE'],
    [ifaceCoolingA.value, 'UTILITY_INTERFACE'], [ifaceCoolingB.value, 'UTILITY_INTERFACE'],
    [assumption.value, 'ASSUMPTION'],
    [routeEntity, 'UTILITY_ROUTE'],
    [fuelStorage.value, 'FUEL_STORAGE'],
    [setback.value, 'SPATIAL_CONSTRAINT'],
    [height.value, 'SPATIAL_CONSTRAINT'],
    [easement.value, 'SPATIAL_CONSTRAINT'],
    [hazard.value, 'SPATIAL_CONSTRAINT'],
  ];
  for (const [entityId, entityType] of entities) {
    await q(
      `INSERT INTO entity_registry (entity_id, revision_id, project_id, scenario_id, entity_type, status, display_name, created_by)
       VALUES ($1, $4, $2, $3, $5, 'PROVISIONAL', $6, $7)`,
      [entityId, projectId, scenarioId, revisionId, entityType, entityType, actorId],
    );
  }

  await q(
    `INSERT INTO design_scopes (scope_id, project_id, scenario_id, revision_id, envelope_id, scope_kind, name, provenance)
     VALUES ($1, $2, $3, $4, $5, 'CAMPUS', 'Fixture campus', '{"source_ref":"fixture"}'::jsonb)`,
    [scope.value, ...scoped, envelope.value],
  );

  const containers = [
    [parcel, 'PARCEL', 'PARCEL', null, null, null],
    [building, 'BUILDING', 'BUILDING', parcel.value, null, 12],
    [yard, 'EQUIPMENT_YARD', 'EQUIPMENT_YARD', parcel.value, null, null],
  ];
  for (const [entry, kind, entityType, parent, level, top] of containers) {
    await q(
      `INSERT INTO facility_containers
         (container_id, project_id, scenario_id, revision_id, envelope_id, scope_id, parent_container_id, phase_id,
          kind, entity_type, name, level_number, status, elevation_base_m, elevation_top_m, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, 'PROVISIONAL', $12, $13, '{"source_ref":"fixture"}'::jsonb)`,
      [
        entry.value, ...scoped, envelope.value, scope.value, parent, kind, entityType,
        entry.name, level, level === null ? null : 0, top,
      ],
    );
  }

  const geometry = async (geometryId, entityId, entityType, role, wkt, extra = {}) => {
    const geometryType = wkt.startsWith('POLYGON') ? 'POLYGON' : wkt.startsWith('LINESTRING') ? 'LINESTRING' : 'POINT';
    await q(
      `INSERT INTO geometry_records
         (geometry_id, project_id, scenario_id, revision_id, entity_id, entity_type, role, ordinal, geometry_type,
          geojson_4326, projected_geometry, projected_crs, elevation_base_m, elevation_top_m, height_m,
          parent_transform_id, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8,
               ST_Transform(ST_GeomFromText($9, 32618), 4326), ST_GeomFromText($9, 32618), 'EPSG:32618',
               $10, $11, $12, $13, $14::jsonb)`,
      [
        randomUUID(), ...scoped, entityId, entityType, role, geometryType, wkt,
        extra.base ?? null, extra.top ?? null, extra.height ?? null, extra.transform ?? null,
        JSON.stringify({ source_ref: 'fixture', effective_at: new Date().toISOString() }),
      ],
    );
  };

  await geometry(randomUUID(), scope.value, 'SITE', 'BOUNDARY', SITE);
  await geometry(randomUUID(), parcel.value, 'PARCEL', 'BOUNDARY', SITE);
  await geometry(randomUUID(), building.value, 'BUILDING', 'FOOTPRINT', BUILDING, { base: 0, top: 12, height: 12 });
  await geometry(randomUUID(), yard.value, 'EQUIPMENT_YARD', 'BOUNDARY', YARD);
  for (const source of [powerA, powerB, coolingA, coolingB]) {
    await geometry(randomUUID(), source.value, 'UTILITY_SOURCE', 'CONNECTION_POINT', CONNECTION);
  }
  for (const utilityInterface of [ifacePowerA, ifacePowerB, ifaceCoolingA, ifaceCoolingB]) {
    await geometry(randomUUID(), utilityInterface.value, 'UTILITY_INTERFACE', 'CONNECTION_POINT', CONNECTION);
  }
  const routeGeometryId = randomUUID();
  await q(
    `INSERT INTO geometry_records
       (geometry_id, project_id, scenario_id, revision_id, entity_id, entity_type, role, ordinal, geometry_type,
        geojson_4326, projected_geometry, projected_crs, provenance)
     VALUES ($1, $2, $3, $4, $5, 'UTILITY_ROUTE', 'ROUTE', 0, 'LINESTRING',
             ST_Transform(ST_GeomFromText($6, 32618), 4326), ST_GeomFromText($6, 32618), 'EPSG:32618', $7::jsonb)`,
    [routeGeometryId, ...scoped, routeEntity, ROUTE, JSON.stringify({ source_ref: 'fixture', failure_domain_id: domainA.value })],
  );

  await q(
    `INSERT INTO failure_domains (failure_domain_id, project_id, scenario_id, revision_id, envelope_id, name, kind)
     VALUES ($1, $2, $3, $4, $5, 'Feed A', 'UTILITY_FEED'), ($6, $2, $3, $4, $5, 'Feed B', 'UTILITY_FEED')`,
    [domainA.value, ...scoped, envelope.value, domainB.value],
  );

  await q(
    `INSERT INTO facility_phases
       (phase_id, project_id, scenario_id, revision_id, envelope_id, name, phase_order, activation_date,
        activation_date_precision, status)
     VALUES ($1, $2, $3, $4, $5, 'Phase 1', 0, '2026-01-01', 'DAY', 'PLANNED'),
            ($6, $2, $3, $4, $5, 'Phase 2', 1, '2027-01-01', 'DAY', 'PLANNED')`,
    [phase1.value, ...scoped, envelope.value, phase2.value],
  );
  await q(
    `INSERT INTO phase_dependencies (predecessor_phase_id, successor_phase_id, project_id, scenario_id, revision_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [phase1.value, phase2.value, ...scoped],
  );
  for (const capability of ['POWER', 'COOLING', 'GEOMETRY', 'ENVIRONMENT']) {
    await q(
      `INSERT INTO phase_capability_availability
         (phase_id, capability, project_id, scenario_id, revision_id, available, available_from)
       VALUES ($1, $2, $3, $4, $5, true, '2025-06-01T00:00:00Z')`,
      [phase1.value, capability, ...scoped],
    );
  }
  // Containers are created before their phase exists (the phase FK is declared
  // later in the migration), so the assignment lands here.
  await q('UPDATE facility_containers SET phase_id = $2 WHERE project_id = $1', [projectId, phase1.value]);

  await q(
    `INSERT INTO utility_sources
       (utility_source_id, project_id, scenario_id, revision_id, envelope_id, kind, capacity_value, capacity_unit,
        capacity_basis, capacity_state, failure_domain_id, phase_id, provenance)
     VALUES ($1, $2, $3, $4, $5, 'POWER', 10000, 'kW', 'IT_LOAD', 'FIRM', $6, $7, '{"source_ref":"fixture"}'::jsonb),
            ($8, $2, $3, $4, $5, 'POWER', 10000, 'kW', 'IT_LOAD', 'FIRM', $9, $7, '{"source_ref":"fixture"}'::jsonb),
            ($10, $2, $3, $4, $5, 'COOLING', 8000, 'kW', 'HEAT_REJECTION', 'FIRM', $6, $7, '{"source_ref":"fixture"}'::jsonb),
            ($11, $2, $3, $4, $5, 'COOLING', 8000, 'kW', 'HEAT_REJECTION', 'FIRM', $9, $7, '{"source_ref":"fixture"}'::jsonb)`,
    [
      powerA.value, ...scoped, envelope.value, domainA.value, phase1.value,
      powerB.value, domainB.value, coolingA.value, coolingB.value,
    ],
  );

  const interfaceRows = [
    [ifacePowerA, powerA, 'POWER', 10000, 'kW', 'IT_LOAD', 'FIRM', domainA],
    [ifacePowerB, powerB, 'POWER', 10000, 'kW', 'IT_LOAD', 'FIRM', domainB],
    [ifaceCoolingA, coolingA, 'COOLING', 8000, 'kW', 'HEAT_REJECTION', 'FIRM', domainA],
    [ifaceCoolingB, coolingB, 'COOLING', 8000, 'kW', 'HEAT_REJECTION', 'FIRM', domainB],
  ];
  for (const [entry, source, , value, unit, basis, state, domain] of interfaceRows) {
    await q(
      `INSERT INTO utility_interfaces
         (interface_id, project_id, scenario_id, revision_id, envelope_id, utility_source_id, capacity_value,
          capacity_unit, capacity_basis, capacity_state, service_state, failure_domain_id, phase_id, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'AVAILABLE', $11, $12, '{"source_ref":"fixture"}'::jsonb)`,
      [entry.value, ...scoped, envelope.value, source.value, value, unit, basis, state, domain.value, phase1.value],
    );
  }

  await q(
    `INSERT INTO resilience_requirements
       (requirement_id, project_id, scenario_id, revision_id, envelope_id, availability_policy, policy_id,
        applies_to, autonomy_duration_seconds, active, provenance)
     VALUES ($1, $2, $3, $4, $5, 'N_PLUS_1', 'corp-dc-standard@3', '{POWER,COOLING}'::resource_kind[], 86400, true,
             '{"source_ref":"fixture"}'::jsonb)`,
    [requirement.value, ...scoped, envelope.value],
  );

  await q(
    `INSERT INTO storage_reserves
       (storage_id, project_id, scenario_id, revision_id, envelope_id, kind, capacity_value, capacity_unit,
        capacity_basis, capacity_state, autonomy_duration_seconds, failure_domain_id, phase_id)
     VALUES ($1, $2, $3, $4, $5, 'FUEL', 150000, 'L', 'FUEL_VOLUME', 'PLANNED', 172800, $6, $7)`,
    [fuelStorage.value, ...scoped, envelope.value, domainA.value, phase1.value],
  );

  await q(
    `INSERT INTO capacity_budgets
       (budget_id, project_id, scenario_id, revision_id, envelope_id, owner_entity_id, phase_id, resource_kind,
        basis, unit, commissioned_value, planned_value, reserved_value, allocated_value, available_value,
        derating_factor, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'POWER', 'IT_LOAD', 'kW', 10000, 0, 1000, 2000, 7000, 0,
             '{"source_ref":"fixture","policy_ref":"corp-dc-standard@3"}'::jsonb)`,
    [budget.value, ...scoped, envelope.value, building.value, phase1.value],
  );
  await q(
    `INSERT INTO capacity_demand_requests
       (request_id, project_id, scenario_id, revision_id, envelope_id, consumer_type, consumer_id, phase_id,
        resource_kind, requested_value, requested_unit, requested_basis, requested_state, required_from, priority)
     VALUES ($1, $2, $3, $4, $5, 'RACK', $6, $7, 'POWER', 2000, 'kW', 'IT_LOAD', 'FIRM', now(), 'NORMAL')`,
    [demand.value, ...scoped, envelope.value, building.value, phase1.value],
  );
  await q(
    `INSERT INTO capacity_allocations
       (allocation_id, project_id, scenario_id, revision_id, budget_id, demand_request_id, quantity_value,
        quantity_unit, quantity_basis, quantity_state, state)
     VALUES ($1, $2, $3, $4, $5, $6, 2000, 'kW', 'IT_LOAD', 'FIRM', 'ACCEPTED')`,
    [allocation.value, ...scoped, budget.value, demand.value],
  );

  await q(
    `INSERT INTO environmental_profiles
       (profile_id, project_id, scenario_id, revision_id, site_scope_id, design_weather_ref, hazard_classifications,
        permit_constraints, operating_ranges, effective_at)
     VALUES ($1, $2, $3, $4, $5, 'ASHRAE 0.4% dry bulb 35.6 C', '{}', '{}', '{}'::jsonb, now())`,
    [profile.value, ...scoped, scope.value],
  );
  await q(
    `INSERT INTO environmental_constraints
       (environmental_constraint_id, project_id, scenario_id, revision_id, envelope_id, profile_id,
        constraint_kind, threshold_value, threshold_unit, basis, effective_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'WATER_DISCHARGE', 500, 'm3/day', 'WATER_FLOW', now())`,
    [envConstraint.value, ...scoped, envelope.value, profile.value],
  );

  await q(
    `INSERT INTO assumptions
       (assumption_id, project_id, scenario_id, revision_id, envelope_id, statement, owner, confidence,
        effective_at, status, entity_refs)
     VALUES ($1, $2, $3, $4, $5, 'Fixture assumption, already resolved.', 'fixture', 'HIGH', now(), 'RESOLVED',
             '[]'::jsonb)`,
    [assumption.value, ...scoped, envelope.value],
  );

  const constraintRows = [
    [setback, 'SETBACK', 'ERROR', 'DISTANCE_FROM_BOUNDARY', 15, 'm', { scope: scope.value }],
    [height, 'HEIGHT_LIMIT', 'ERROR', 'MAX_HEIGHT', 40, 'm', { container: building.value }],
    [easement, 'EASEMENT', 'ERROR', 'EXCLUSION', null, null, { scope: scope.value, geometry: 'easement' }],
    [hazard, 'HAZARD_ZONE', 'ERROR', 'EXCLUSION', null, null, { scope: scope.value, geometry: 'hazard' }],
  ];
  const zoneGeometry = {};
  for (const [entry, kind, severity, ruleKind, ruleValue, ruleUnit, anchor] of constraintRows) {
    await q(
      `INSERT INTO spatial_constraints
         (constraint_id, project_id, scenario_id, revision_id, envelope_id, scope_id, container_id,
          applies_to_geometry_id, kind, severity, rule_kind, rule_value, rule_unit, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '{"source_ref":"fixture"}'::jsonb)`,
      [
        entry.value, ...scoped, envelope.value,
        anchor.scope ?? null, anchor.container ?? null, null,
        kind, severity, ruleKind, ruleValue, ruleUnit,
      ],
    );
    if (anchor.geometry) zoneGeometry[anchor.geometry] = entry;
  }
  for (const [name, wkt] of [['easement', EASEMENT], ['hazard', HAZARD]]) {
    const entry = zoneGeometry[name];
    const geometryId = randomUUID();
    await q(
      `INSERT INTO geometry_records
         (geometry_id, project_id, scenario_id, revision_id, entity_id, entity_type, role, ordinal, geometry_type,
          geojson_4326, projected_geometry, projected_crs, provenance)
       VALUES ($1, $2, $3, $4, $5, 'SPATIAL_CONSTRAINT', 'CONSTRAINT_AREA', 0, 'POLYGON',
               ST_Transform(ST_GeomFromText($6, 32618), 4326), ST_GeomFromText($6, 32618), 'EPSG:32618',
               '{"source_ref":"fixture"}'::jsonb)`,
      [geometryId, ...scoped, entry.value, wkt],
    );
    await q(
      `UPDATE spatial_constraints SET applies_to_geometry_id = $3 WHERE constraint_id = $1 AND project_id = $2`,
      [entry.value, projectId, geometryId],
    );
  }

  // The binding and its transform reference each other, so the binding lands
  // first with no transform and is pointed at one afterwards.
  await q(
    `INSERT INTO asset_bindings
       (binding_id, project_id, scenario_id, revision_id, asset_version_id, role, status)
     VALUES ($1, $2, $3, $4, $5, 'SOURCE', 'REVIEWED')`,
    [binding.value, ...scoped, randomUUID()],
  );
  await q(
    `INSERT INTO spatial_transforms
       (transform_id, project_id, scenario_id, revision_id, binding_id, asset_version_id, source_units,
        target_units, source_crs, target_crs, method, review_state)
     VALUES ($1, $2, $3, $4, $5, $6, 'm', 'm', 'EPSG:32618', 'EPSG:32618', 'DECLARED_CRS', 'REVIEWED')`,
    [transform.value, ...scoped, binding.value, randomUUID()],
  );
  await q('UPDATE asset_bindings SET transform_id = $3 WHERE binding_id = $1 AND project_id = $2', [
    binding.value, projectId, transform.value,
  ]);
  await q(
    `INSERT INTO import_mappings
       (mapping_id, project_id, scenario_id, revision_id, binding_id, asset_version_id, transform_id,
        source_selector, target_entity_type, target_geometry_role, cardinality, required, review_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'layer:BUILDING', 'BUILDING', 'FOOTPRINT', 'ONE_TO_ONE', true, 'REVIEWED')`,
    [mapping.value, ...scoped, binding.value, randomUUID(), transform.value],
  );
  await q(
    `INSERT INTO import_features
       (import_feature_id, project_id, scenario_id, revision_id, asset_version_id, binding_id, source_selector,
        source_feature_id, geometry_type, status, import_mapping_id, normalized_entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'layer:BUILDING', 'f-1', 'POLYGON', 'MAPPED', $7, $8)`,
    [feature.value, ...scoped, randomUUID(), binding.value, mapping.value, building.value],
  );

  return {
    ...ids,
    geometryIds: { routeGeometryId },
  };
}

/** Constraint identifier to the mutation that makes its check fire. */
export const MUTATIONS = {
  'facility.data.entity.required': async (client, ids, projectId) => {
    await client.query('DELETE FROM spatial_constraints WHERE project_id = $1', [projectId]);
    await client.query('UPDATE facility_containers SET parent_container_id = NULL WHERE project_id = $1', [projectId]);
    await client.query('DELETE FROM facility_containers WHERE project_id = $1', [projectId]);
  },
  'facility.data.id.duplicate': null,
  'facility.data.crs.missing': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records SET projected_crs = '' WHERE project_id = $1 AND entity_id = $2`,
      [projectId, ids.building],
    );
  },
  'facility.data.units.missing': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_budgets SET unit = '' WHERE project_id = $1 AND budget_id = $2`, [projectId, ids.budget]);
  },
  'facility.data.geometry.invalid': async (client, ids, projectId) => {
    // A hole outside its shell is invalid without being a self-intersection, so
    // this fixture exercises `invalid` and not the more specific identifier.
    await client.query(
      `UPDATE geometry_records
          SET projected_geometry = ST_GeomFromText(
                'POLYGON((0 0, 100 0, 100 100, 0 100, 0 0), (200 200, 260 200, 260 260, 200 260, 200 200))', 32618)
        WHERE project_id = $1 AND entity_id = $2 AND role = 'BOUNDARY'`,
      [projectId, ids.yard],
    );
  },
  'facility.data.geometry.self_intersection': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records
          SET projected_geometry = ST_GeomFromText('POLYGON((0 0, 100 100, 100 0, 0 100, 0 0))', 32618)
        WHERE project_id = $1 AND entity_id = $2 AND role = 'BOUNDARY'`,
      [projectId, ids.yard],
    );
  },
  'facility.data.geometry.type_mismatch': async (client, ids, projectId) => {
    // A point stored where a polygon is declared; the schema check forbids the
    // declared type disagreeing with the stored geometry, so the declaration is
    // what changes.
    await client.query(
      `UPDATE geometry_records SET geometry_type = 'POINT' WHERE project_id = $1 AND entity_id = $2 AND role = 'BOUNDARY'`,
      [projectId, ids.yard],
    );
  },
  'facility.data.geometry.role_missing': async (client, ids) => {
    await client.query(
      `INSERT INTO entity_registry (entity_id, revision_id, project_id, scenario_id, entity_type, status)
       VALUES ($1, $2, $3, $4, 'HALL', 'PROVISIONAL')`,
      [randomUUID(), ids.revisionId, ids.projectId, ids.scenarioId],
    );
  },
  'facility.data.transform.unreviewed': async (client, ids, projectId) => {
    await client.query(`UPDATE spatial_transforms SET review_state = 'UNREVIEWED' WHERE project_id = $1`, [projectId]);
    await client.query(
      `UPDATE geometry_records SET parent_transform_id = $3
        WHERE project_id = $1 AND entity_id = $2 AND role = 'FOOTPRINT'`,
      [projectId, ids.building, ids.transform],
    );
  },
  'facility.data.provenance.missing': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records SET provenance = '{}'::jsonb WHERE project_id = $1 AND entity_id = $2`,
      [projectId, ids.building],
    );
  },
  'facility.data.provenance.stale': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records
          SET provenance = jsonb_set(provenance, '{effective_at}', to_jsonb((now() - interval '800 days')::text))
        WHERE project_id = $1 AND entity_id = $2`,
      [projectId, ids.building],
    );
  },
  'facility.data.assumption.unresolved': async (client, ids, projectId) => {
    await client.query(`UPDATE assumptions SET status = 'OPEN' WHERE project_id = $1`, [projectId]);
  },
  'facility.data.entity.parent_cycle': async (client, ids, projectId) => {
    // parcel -> building -> parcel is a cycle the schema cannot express.
    await client.query(`UPDATE facility_containers SET parent_container_id = $2 WHERE container_id = $1 AND project_id = $3`, [
      ids.parcel, ids.building, projectId,
    ]);
  },
  'facility.data.entity.parent_cross_scope': async (client, ids, projectId) => {
    const other = randomUUID();
    await client.query(
      `INSERT INTO entity_registry (entity_id, revision_id, project_id, scenario_id, entity_type, status)
       VALUES ($1, $2, $3, $4, 'SITE', 'PROVISIONAL')`,
      [other, ids.revisionId, projectId, ids.scenarioId],
    );
    await client.query(
      `INSERT INTO design_scopes (scope_id, project_id, scenario_id, revision_id, envelope_id, scope_kind, name)
       VALUES ($1, $2, $3, $4, $5, 'BUILDING', 'Other scope')`,
      [other, projectId, ids.scenarioId, ids.revisionId, ids.envelope],
    );
    await client.query('UPDATE facility_containers SET scope_id = $2 WHERE container_id = $1 AND project_id = $3', [
      ids.building, other, projectId,
    ]);
  },

  'facility.site.container.outside_parent': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records SET projected_geometry = ST_GeomFromText('POLYGON((900 900, 950 900, 950 950, 900 950, 900 900))', 32618)
        WHERE project_id = $1 AND entity_id = $2 AND role = 'FOOTPRINT'`,
      [projectId, ids.building],
    );
  },
  'facility.site.container.overlap': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records SET projected_geometry = ST_GeomFromText('POLYGON((100 100, 350 100, 350 150, 100 150, 100 100))', 32618)
        WHERE project_id = $1 AND entity_id = $2 AND role = 'BOUNDARY'`,
      [projectId, ids.yard],
    );
  },
  'facility.site.setback.violated': async (client, ids, projectId) => {
    await client.query(
      `UPDATE spatial_constraints SET rule_value = 200 WHERE project_id = $1 AND kind = 'SETBACK'`,
      [projectId],
    );
    void ids;
  },
  'facility.site.easement.violated': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records g SET projected_geometry = ST_GeomFromText($2, 32618)
         FROM spatial_constraints c
        WHERE g.project_id = $1 AND g.entity_id = c.constraint_id AND c.kind = 'EASEMENT'`,
      [projectId, rect(40, 40, 210, 160)],
    );
  },
  'facility.site.access_route.blocked': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records SET projected_geometry = ST_GeomFromText('LINESTRING(0 100, 600 100)', 32618)
        WHERE project_id = $1 AND role = 'ROUTE'`,
      [projectId],
    );
  },
  'facility.site.height.exceeded': async (client, ids, projectId) => {
    await client.query(`UPDATE spatial_constraints SET rule_value = 10 WHERE project_id = $1 AND kind = 'HEIGHT_LIMIT'`, [projectId]);
  },
  'facility.site.hazard.excluded': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records g SET projected_geometry = ST_GeomFromText($2, 32618)
         FROM spatial_constraints c
        WHERE g.project_id = $1 AND g.entity_id = c.constraint_id AND c.kind = 'HAZARD_ZONE'`,
      [projectId, rect(40, 40, 210, 160)],
    );
  },
  'facility.site.constraint.rule_missing': async (client, ids, projectId) => {
    await client.query(
      `UPDATE spatial_constraints SET rule_kind = NULL, rule_value = NULL, rule_unit = NULL
        WHERE project_id = $1 AND constraint_id = $2`,
      [projectId, ids.setback],
    );
  },
  'facility.site.constraint.geometry_missing': async (client, ids, projectId) => {
    await client.query(
      `UPDATE spatial_constraints SET applies_to_geometry_id = NULL WHERE project_id = $1 AND kind = 'EASEMENT'`,
      [projectId],
    );
    await client.query(
      `DELETE FROM geometry_records WHERE project_id = $1 AND entity_id IN
         (SELECT constraint_id FROM spatial_constraints WHERE project_id = $1 AND kind = 'EASEMENT')`,
      [projectId],
    );
  },

  'facility.utility.source.capacity_missing': async (client, ids, projectId) => {
    await client.query(`UPDATE utility_sources SET capacity_unit = '' WHERE project_id = $1`, [projectId]);
  },
  'facility.utility.source.negative_capacity': async (client, ids, projectId) => {
    await client.query(`UPDATE utility_sources SET capacity_value = 0 WHERE project_id = $1`, [projectId]);
  },
  'facility.utility.source.state_not_firm': async (client, ids, projectId) => {
    await client.query(`UPDATE utility_sources SET capacity_state = 'PLANNED' WHERE project_id = $1`, [projectId]);
  },
  'facility.utility.source.availability_after_phase': async (client, ids, projectId) => {
    await client.query(`UPDATE utility_sources SET available_from = '2030-01-01T00:00:00Z' WHERE project_id = $1`, [projectId]);
  },
  'facility.utility.interface.source_undefined': async (client, ids, projectId) => {
    await client.query(`UPDATE utility_interfaces SET utility_source_id = $2 WHERE project_id = $1`, [projectId, randomUUID()]);
  },
  'facility.utility.interface.connectivity_missing': async (client, ids, projectId) => {
    await client.query(
      `DELETE FROM geometry_records WHERE project_id = $1 AND role = 'CONNECTION_POINT' AND entity_type = 'UTILITY_INTERFACE'`,
      [projectId],
    );
  },
  'facility.utility.interface.redefines_source': async (client, ids, projectId) => {
    await client.query(`UPDATE utility_interfaces SET capacity_basis = 'FACILITY_INPUT' WHERE project_id = $1`, [projectId]);
  },
  'facility.utility.route.disconnected': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records SET projected_geometry = ST_GeomFromText('LINESTRING(0 380, 50 380)', 32618)
        WHERE project_id = $1 AND role = 'ROUTE'`,
      [projectId],
    );
  },

  'facility.capacity.budget.overcommit': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_budgets SET commissioned_value = 1000 WHERE project_id = $1`, [projectId]);
  },
  'facility.capacity.budget.duplicate': async (client, ids, projectId) => {
    await client.query(
      `INSERT INTO capacity_budgets
         (budget_id, project_id, scenario_id, revision_id, envelope_id, owner_entity_id, phase_id, resource_kind,
          basis, unit, commissioned_value, provenance)
       SELECT $1, project_id, scenario_id, revision_id, envelope_id, owner_entity_id, phase_id, resource_kind,
              basis, unit, 1, '{"source_ref":"fixture"}'::jsonb
         FROM capacity_budgets WHERE project_id = $2 LIMIT 1`,
      [randomUUID(), projectId],
    );
  },
  'facility.capacity.allocation.basis_mismatch': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_allocations SET quantity_basis = 'FACILITY_INPUT' WHERE project_id = $1`, [projectId]);
  },
  'facility.capacity.allocation.phase_mismatch': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_demand_requests SET phase_id = $2 WHERE project_id = $1`, [projectId, ids.phase2]);
  },
  'facility.capacity.allocation.provisional_gate': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_allocations SET state = 'PROVISIONAL' WHERE project_id = $1`, [projectId]);
    await client.query(`UPDATE capacity_budgets SET available_value = 0 WHERE project_id = $1`, [projectId]);
  },
  'facility.capacity.reserve.eroded': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_budgets SET reserved_value = 0 WHERE project_id = $1`, [projectId]);
  },
  'facility.capacity.derating.undefined': async (client, ids, projectId) => {
    await client.query(
      `UPDATE capacity_budgets SET derating_factor = 0.1, provenance = '{"source_ref":"fixture"}'::jsonb WHERE project_id = $1`,
      [projectId],
    );
  },
  'facility.capacity.planned.firm_claim': async (client, ids, projectId) => {
    await client.query(
      `UPDATE capacity_budgets SET planned_value = 5000, available_value = 12000 WHERE project_id = $1`,
      [projectId],
    );
  },
  'facility.interface.allocation.exceeded': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_allocations SET quantity_value = 5000 WHERE project_id = $1`, [projectId]);
  },
  'facility.interface.entity_invalid': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_demand_requests SET consumer_id = $2 WHERE project_id = $1`, [projectId, randomUUID()]);
  },
  'facility.interface.request.provisional': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_demand_requests SET requested_state = 'PLANNED' WHERE project_id = $1`, [projectId]);
  },

  'facility.resilience.failure_domain.missing': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records SET provenance = '{"source_ref":"fixture"}'::jsonb WHERE project_id = $1 AND role = 'ROUTE'`,
      [projectId],
    );
  },
  'facility.resilience.failure_domain.shared': async (client, ids, projectId) => {
    await client.query(`UPDATE utility_sources SET failure_domain_id = $2 WHERE project_id = $1`, [projectId, ids.domainA]);
  },
  'facility.resilience.failure_domain.cycle': async (client, ids, projectId) => {
    await client.query(
      `UPDATE failure_domains SET parent_failure_domain_id = $2 WHERE project_id = $1 AND failure_domain_id = $3`,
      [projectId, ids.domainB, ids.domainA],
    );
    await client.query(
      `UPDATE failure_domains SET parent_failure_domain_id = $2 WHERE project_id = $1 AND failure_domain_id = $3`,
      [projectId, ids.domainA, ids.domainB],
    );
  },
  'facility.resilience.availability_policy.violated': async (client, ids, projectId) => {
    await client.query(
      `DELETE FROM utility_interfaces WHERE project_id = $1 AND utility_source_id IN
         (SELECT utility_source_id FROM utility_sources WHERE project_id = $1 AND kind = 'COOLING')`,
      [projectId],
    );
    await client.query(`DELETE FROM utility_sources WHERE project_id = $1 AND kind = 'COOLING'`, [projectId]);
  },
  'facility.resilience.availability_policy.unresolved': async (client, ids, projectId) => {
    await client.query(`UPDATE resilience_requirements SET policy_id = 'corp-dc-standard' WHERE project_id = $1`, [projectId]);
  },
  'facility.resilience.fuel_duration.insufficient': async (client, ids, projectId) => {
    await client.query(`UPDATE resilience_requirements SET applies_to = '{POWER,FUEL}'::resource_kind[] WHERE project_id = $1`, [projectId]);
    await client.query(`UPDATE storage_reserves SET autonomy_duration_seconds = 60 WHERE project_id = $1`, [projectId]);
  },
  'facility.resilience.water_duration.insufficient': async (client, ids, projectId) => {
    await client.query(`UPDATE resilience_requirements SET applies_to = '{POWER,WATER}'::resource_kind[] WHERE project_id = $1`, [projectId]);
  },
  'facility.resilience.redundancy.path_count': async (client, ids, projectId) => {
    await client.query(`DELETE FROM utility_interfaces WHERE project_id = $1 AND utility_source_id = $2`, [projectId, ids.coolingB]);
    await client.query(`DELETE FROM utility_sources WHERE project_id = $1 AND utility_source_id = $2`, [projectId, ids.coolingB]);
  },

  'facility.environment.design_weather.missing': async (client, ids, projectId) => {
    await client.query(`DELETE FROM environmental_constraints WHERE project_id = $1`, [projectId]);
    await client.query(`DELETE FROM environmental_profiles WHERE project_id = $1`, [projectId]);
  },
  'facility.environment.permit.exceeded': null,
  'facility.environment.water.envelope_missing': async (client, ids, projectId) => {
    await client.query(`DELETE FROM environmental_constraints WHERE project_id = $1`, [projectId]);
  },
  'facility.environment.hazard.mitigation_missing': null,
  'facility.environment.emissions.exceeded': null,
  'facility.environment.profile.out_of_scope': async (client, ids, projectId) => {
    // A profile whose effective period has already closed is out of scope for a
    // current revision, even though its site is right.
    await client.query(
      `UPDATE environmental_profiles
          SET effective_at = now() - interval '30 days', effective_until = now() - interval '1 day'
        WHERE project_id = $1`,
      [projectId],
    );
  },
  'facility.environment.constraint.basis_missing': async (client, ids, projectId) => {
    await client.query(`UPDATE environmental_constraints SET threshold_unit = '' WHERE project_id = $1`, [projectId]);
  },

  'facility.phase.dependency.cycle': async (client, ids, projectId) => {
    await client.query(
      `INSERT INTO phase_dependencies (predecessor_phase_id, successor_phase_id, project_id, scenario_id, revision_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [ids.phase2, ids.phase1, projectId, ids.scenarioId, ids.revisionId],
    );
  },
  'facility.phase.dependency.duplicate': async (client, ids, projectId) => {
    await client.query(
      `INSERT INTO phase_dependencies (predecessor_phase_id, successor_phase_id, project_id, scenario_id, revision_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [ids.phase1, ids.phase2, projectId, ids.scenarioId, ids.revisionId],
    );
  },
  'facility.phase.dependency.self': async (client, ids, projectId) => {
    await client.query(
      `INSERT INTO phase_dependencies (predecessor_phase_id, successor_phase_id, project_id, scenario_id, revision_id)
       VALUES ($1, $1, $2, $3, $4)`,
      [ids.phase1, projectId, ids.scenarioId, ids.revisionId],
    );
  },
  'facility.phase.capability.before_commissioned': async (client, ids, projectId) => {
    await client.query(
      `UPDATE phase_capability_availability SET available_from = '2030-01-01T00:00:00Z' WHERE project_id = $1`,
      [projectId],
    );
  },
  'facility.phase.capacity.future_reserved_consumed': async (client, ids, projectId) => {
    await client.query(`UPDATE capacity_budgets SET phase_id = $2 WHERE project_id = $1`, [projectId, ids.phase2]);
  },
  'facility.phase.date.unconfirmed': async (client, ids, projectId) => {
    await client.query(`UPDATE facility_phases SET activation_date_precision = NULL WHERE project_id = $1`, [projectId]);
  },

  'facility.import.mapping.unresolved': async (client, ids, projectId) => {
    await client.query(
      `UPDATE import_mappings SET source_selector = 'layer:MISSING' WHERE project_id = $1`,
      [projectId],
    );
  },
  'facility.import.mapping.ambiguous': async (client, ids, projectId) => {
    await client.query(
      `INSERT INTO import_features
         (import_feature_id, project_id, scenario_id, revision_id, asset_version_id, binding_id, source_selector,
          source_feature_id, geometry_type, status, import_mapping_id, normalized_entity_id)
       SELECT $1, project_id, scenario_id, revision_id, asset_version_id, binding_id, source_selector,
              'f-2', 'POLYGON', 'MAPPED', import_mapping_id, normalized_entity_id
         FROM import_features WHERE project_id = $2 LIMIT 1`,
      [randomUUID(), projectId],
    );
  },
  'facility.import.geometry.out_of_bounds': async (client, ids, projectId) => {
    await client.query(
      `UPDATE geometry_records SET projected_geometry = ST_GeomFromText('POLYGON((900 900, 950 900, 950 950, 900 950, 900 900))', 32618)
        WHERE project_id = $1 AND entity_id = $2 AND role = 'FOOTPRINT'`,
      [projectId, ids.building],
    );
  },

  'facility.revision.current': null,
  'facility.revision.publish.requires_validation': async () => {},
  'facility.revision.publish.source_unpinned': async (client, ids, projectId) => {
    await client.query(`UPDATE resilience_requirements SET policy_id = 'corp-dc-standard' WHERE project_id = $1`, [projectId]);
  },
  'facility.revision.writes_immutable': async (client, ids, projectId) => {
    await client.query(
      `UPDATE facility_envelopes SET lifecycle_state = 'VALIDATED', content_checksum = 'fixture' WHERE project_id = $1`,
      [projectId],
    );
  },
  'facility.governance.approval.required': async (client, ids, projectId) => {
    await client.query(
      `UPDATE resilience_requirements
          SET provenance = '{"source_ref":"fixture","approval_policy":"deployment-approval@1"}'::jsonb
        WHERE project_id = $1`,
      [projectId],
    );
  },
  'facility.governance.waiver.expired': async (client, ids, projectId) => {
    await client.query(
      `INSERT INTO waivers
         (waiver_id, project_id, scenario_id, revision_id, diagnostic_ids, scope, granted_by, policy_id, reason,
          granted_at, expires_at, status)
       VALUES ($1, $2, $3, $4, '{}', 'REVISION', $5, 'coverage-promoting-waiver@1', 'expired fixture',
               now() - interval '10 days', now() - interval '1 day', 'GRANTED')`,
      [randomUUID(), projectId, ids.scenarioId, ids.revisionId, randomUUID()],
    );
  },
  'facility.governance.waiver.scope_mismatch': async (client, ids, projectId) => {
    await client.query(
      `INSERT INTO waivers
         (waiver_id, project_id, scenario_id, revision_id, diagnostic_ids, scope, granted_by, policy_id, reason, status)
       VALUES ($1, $2, $3, $4, ARRAY[$5]::uuid[], 'REVISION', $6, 'coverage-promoting-waiver@1', 'dangling', 'GRANTED')`,
      [randomUUID(), projectId, ids.scenarioId, ids.revisionId, randomUUID(), randomUUID()],
    );
  },
  'facility.governance.attestation.revoked': async (client, ids, projectId) => {
    await client.query(
      `INSERT INTO approval_attestations
         (attestation_id, project_id, scenario_id, envelope_id, revision_id, approver_id, policy_id, decision)
       VALUES ($1, $2, $3, $4, $5, $6, 'deployment-approval@1', 'REVOKED')`,
      [randomUUID(), projectId, ids.scenarioId, ids.envelope, ids.revisionId, randomUUID()],
    );
  },
};

/** Checks whose failure is an engine option rather than a stored row. */
export const OPTION_MUTATIONS = Object.freeze({
  'facility.revision.current': { isCurrentDraft: false },
});

/** Extra rows a publish-only check needs before its positive case is clean. */
export const PUBLISH_PREPARE = {
  'facility.revision.publish.requires_validation': async (client, ids, projectId) => {
    await client.query(
      `INSERT INTO validation_runs
         (validation_run_id, project_id, scenario_id, revision_id, envelope_id, scope, status, error_count,
          warning_count, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'FULL', 'COMPLETED', 0, 0, now(), now())`,
      [randomUUID(), projectId, ids.scenarioId, ids.revisionId, ids.envelope],
    );
  },
};

/** Constraints whose failure the schema makes unstorable today. */
export const SCHEMA_GUARDED = Object.freeze([
  'facility.data.id.duplicate',
  'facility.utility.interface.source_undefined',
  'facility.capacity.budget.duplicate',
  'facility.phase.dependency.duplicate',
  'facility.phase.dependency.self',
  'facility.data.geometry.type_mismatch',
]);

export { rect, line, point, SITE, BUILDING, YARD };
