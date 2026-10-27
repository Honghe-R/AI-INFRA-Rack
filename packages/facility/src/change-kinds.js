import { randomUUID } from 'node:crypto';
import { getConstraint } from './catalog.js';
import { gatedCapabilities } from './coverage.js';
import {
  CONTAINER_KINDS,
  ChangeConflict,
  ChangeRejected,
  GEOMETRY_TYPE,
  assertBelongsToRevision,
  assertNoParentCycle,
  resolveEntity,
  requireEnum,
  requireField,
} from './change-kind-shared.js';
import { AUTHORED_KINDS } from './change-kinds-authored.js';
import { IMPORT_CHANGE_KINDS, IMPORT_KIND_RANK } from './change-kinds-imports.js';

export { ChangeConflict, ChangeRejected } from './change-kind-shared.js';

/**
 * The change kinds a change set may contain.
 *
 * This module is the registry: it holds the four kinds that edit structure and
 * composes the rest from `change-kinds-authored.js`. The pipeline in `changes.js`
 * orders, applies, collects and commits without knowing what a container is.
 *
 * The refusal shapes and the enumerated values live in `change-kind-shared.js`,
 * because both kind modules need them and a second copy of an enum is a second answer
 * to what the store accepts.
 */

/**
 * Tables that point at an entity, and the column that does it.
 *
 * A removal that ignored these would leave a dangling reference, and a `409` that
 * does not say *what* refers to the entity is not actionable. The list grows with the
 * change kinds: a table is added here when a kind starts writing it.
 *
 * `geometry_records` is deliberately absent. A geometry row's `entity_id` *is* the
 * entity it draws, so such a row is never a second object referring to the removed
 * one — it is the footprint the removal itself deletes. Listing it here made removing
 * any drawn object impossible, because its own geometry always counted as a referrer.
 */
const ENTITY_REFERENCES = Object.freeze([
  { table: 'facility_containers', column: 'parent_container_id', label: 'child container', nameColumn: 'name' },
  { table: 'spatial_constraints', column: 'container_id', label: 'spatial constraint', nameColumn: 'kind' },
  { table: 'capacity_budgets', column: 'owner_entity_id', label: 'capacity budget', nameColumn: 'resource_kind' },
  {
    table: 'environmental_constraints',
    column: 'affected_entity_id',
    label: 'environmental constraint',
    nameColumn: 'constraint_kind',
  },
  { table: 'utility_interfaces', column: 'utility_source_id', label: 'utility interface', nameColumn: 'service_state' },
]);

const CONTAINER_PATCH_FIELDS = Object.freeze([
  'name',
  'phase_id',
  'parent_container_id',
  'level_number',
  'elevation_base_m',
  'elevation_top_m',
]);
const COMMON_PATCH_FIELDS = Object.freeze(['display_name', 'status']);

/**
 * Creates a container and registers its stable identity.
 *
 * The container row and the registry row are written together: an identity without
 * a container is not a design object, and a container without an identity cannot be
 * referenced by anything the change set does next.
 */
const createContainer = {
  kind: 'create_container',
  permission: 'facility.entity.write',
  async apply({ client, projectId, scenarioId, revisionId, envelopeId, actorId, change }) {
    const payload = change.payload ?? {};
    const containerKind = requireEnum(payload, 'container_kind', CONTAINER_KINDS);
    const name = requireField(payload, 'name');
    const scopeId = requireField(payload, 'scope_id');

    // A level number is what makes a floor plan meaningful, and the store enforces
    // that only a FLOOR or a HALL has one. Checking it here answers with the rule
    // rather than with the name of a check constraint.
    const levelNumber = payload.level_number ?? null;
    const carriesLevel = containerKind === 'FLOOR' || containerKind === 'HALL';
    if (carriesLevel && levelNumber === null) {
      throw new ChangeRejected('A FLOOR or HALL requires a level number.', {
        field: 'payload.level_number',
        reason: 'required',
        note: 'A level number is unique within the building, so two halls in one building are two levels.',
      });
    }
    if (!carriesLevel && levelNumber !== null) {
      throw new ChangeRejected('Only a FLOOR or a HALL carries a level number.', {
        field: 'payload.level_number',
        reason: 'not_allowed',
      });
    }

    // An inverted elevation is a malformed object rather than a design finding: no check
    // in the catalog reports it, so the store's constraint is the only thing standing
    // between the graph and a floor above its own roof.
    const base = payload.elevation_base_m ?? null;
    const top = payload.elevation_top_m ?? null;
    if (base !== null && top !== null && top < base) {
      throw new ChangeRejected('The top elevation cannot be below the base elevation.', {
        field: 'payload.elevation_top_m',
        reason: 'elevation_inverted',
        elevation_base_m: base,
        elevation_top_m: top,
      });
    }

    if (!envelopeId) {
      throw new ChangeConflict('The revision has no facility envelope to attach a container to.', {
        reason: 'no_envelope',
      });
    }
    await assertBelongsToRevision({
      client, projectId, revisionId, table: 'design_scopes', idColumn: 'scope_id', id: scopeId, field: 'scope_id',
    });
    if (payload.parent_container_id) {
      await assertBelongsToRevision({
        client, projectId, revisionId, table: 'facility_containers', idColumn: 'container_id', id: payload.parent_container_id, field: 'parent_container_id',
      });
    }
    if (payload.phase_id) {
      await assertBelongsToRevision({
        client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: payload.phase_id, field: 'phase_id',
      });
    }

    const containerId = payload.container_id ?? randomUUID();
    await client.query(
      `INSERT INTO entity_registry
         (entity_id, revision_id, project_id, scenario_id, entity_type, status, display_name, created_by)
       VALUES ($1, $2, $3, $4, $5, 'PROVISIONAL', $6, $7)`,
      [containerId, revisionId, projectId, scenarioId, containerKind, name, actorId],
    );
    await client.query(
      `INSERT INTO facility_containers
         (container_id, project_id, scenario_id, revision_id, envelope_id, scope_id, parent_container_id,
          phase_id, kind, entity_type, name, level_number, status, elevation_base_m, elevation_top_m,
          provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PROVISIONAL', $13, $14, $15::jsonb, $16)`,
      [
        containerId,
        projectId,
        scenarioId,
        revisionId,
        envelopeId,
        scopeId,
        payload.parent_container_id ?? null,
        payload.phase_id ?? null,
        // `kind` and `entity_type` are distinct enum types that happen to carry the
        // same value, so they need distinct parameters: PostgreSQL cannot deduce one
        // type for a parameter used as both.
        containerKind,
        containerKind,
        name,
        levelNumber,
        base,
        top,
        JSON.stringify({ source_ref: 'change_set', confidence: 'MEDIUM' }),
        actorId,
      ],
    );

    return { entityRef: { entity_id: containerId, entity_type: containerKind }, containerId, name };
  },
};

/**
 * Patches declared attributes.
 *
 * `entity_registry` is thin — status and display name only — so the real attributes
 * of a container live on its own row. The dispatch is the substance of this kind.
 * A reparent is cycle-checked, because a cycle in the hierarchy makes it unreadable
 * and `facility.data.entity.parent_cycle` is a report, not a repair.
 */
const updateEntity = {
  kind: 'update_entity',
  permission: 'facility.entity.write',
  async apply({ client, projectId, revisionId, actorId, change }) {
    const entity = await resolveEntity({ client, projectId, revisionId, entityRef: change.entity_ref });
    const patch = change.payload?.patch ?? {};
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new ChangeRejected('The change requires a non-empty patch.', { field: 'payload.patch', reason: 'required' });
    }

    const isContainer = CONTAINER_KINDS.includes(entity.entity_type);
    const allowed = isContainer ? [...COMMON_PATCH_FIELDS, ...CONTAINER_PATCH_FIELDS] : [...COMMON_PATCH_FIELDS];
    const unknown = keys.filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      throw new ChangeRejected('The patch names fields that are not editable on this entity.', {
        reason: 'unknown_property',
        unknown,
        allowed,
      });
    }

    if (isContainer) {
      if ('phase_id' in patch && patch.phase_id) {
        await assertBelongsToRevision({
          client, projectId, revisionId, table: 'facility_phases', idColumn: 'phase_id', id: patch.phase_id, field: 'phase_id',
        });
      }

      // The store enforces both structural rules with check constraints, and a refusal
      // that names `facility_containers_level_number_check` tells the caller nothing.
      // They are asserted here instead, against the values the row will actually hold —
      // the same way `create_container` asserts them.
      const carriesLevel = entity.entity_type === 'FLOOR' || entity.entity_type === 'HALL';
      if ('level_number' in patch) {
        if (!carriesLevel && patch.level_number !== null && patch.level_number !== undefined) {
          throw new ChangeRejected('Only a FLOOR or a HALL carries a level number.', {
            field: 'payload.patch.level_number',
            reason: 'not_allowed',
            entity_type: entity.entity_type,
            allowed_for: ['FLOOR', 'HALL'],
          });
        }
        if (carriesLevel && (patch.level_number === null || patch.level_number === undefined)) {
          throw new ChangeRejected('A FLOOR or a HALL requires a level number.', {
            field: 'payload.patch.level_number',
            reason: 'required',
            entity_type: entity.entity_type,
          });
        }
      }

      // An inverted elevation is judged on the row the update produces, not on the pair
      // the patch happens to state: raising a base above an untouched top is the same
      // inverted floor as lowering the top below the base, and the store refuses both.
      if ('elevation_base_m' in patch || 'elevation_top_m' in patch) {
        const { rows: existingRows } = await client.query(
          `SELECT elevation_base_m, elevation_top_m FROM facility_containers
            WHERE project_id = $1 AND revision_id = $2 AND container_id = $3`,
          [projectId, revisionId, entity.entity_id],
        );
        const existing = existingRows[0] ?? {};
        const base = 'elevation_base_m' in patch ? patch.elevation_base_m : existing.elevation_base_m;
        const top = 'elevation_top_m' in patch ? patch.elevation_top_m : existing.elevation_top_m;
        if (base !== null && base !== undefined && top !== null && top !== undefined && Number(top) < Number(base)) {
          throw new ChangeRejected('The top elevation cannot be below the base elevation.', {
            field: 'payload.patch.elevation_top_m',
            reason: 'elevation_inverted',
            elevation_base_m: base,
            elevation_top_m: top,
          });
        }
      }

      if ('parent_container_id' in patch && patch.parent_container_id) {
        await assertBelongsToRevision({
          client, projectId, revisionId, table: 'facility_containers', idColumn: 'container_id', id: patch.parent_container_id, field: 'parent_container_id',
        });
        await assertNoParentCycle({
          client,
          projectId,
          revisionId,
          table: 'facility_containers',
          idColumn: 'container_id',
          parentColumn: 'parent_container_id',
          id: entity.entity_id,
          parentId: patch.parent_container_id,
          label: 'parent',
        });
      }

      const assignments = [];
      const values = [projectId, revisionId];
      const push = (value) => {
        values.push(value);
        return `$${values.length}`;
      };
      for (const field of CONTAINER_PATCH_FIELDS) {
        if (field in patch) assignments.push(`${field} = ${push(patch[field])}`);
      }
      if (assignments.length > 0) {
        await client.query(
          `UPDATE facility_containers SET ${assignments.join(', ')}, updated_at = now(), updated_by = ${push(actorId)}
            WHERE project_id = $1 AND revision_id = $2 AND container_id = ${push(entity.entity_id)}`,
          values,
        );
      }
    }

    const registryAssignments = [];
    const registryValues = [projectId, revisionId];
    const pushRegistry = (value) => {
      registryValues.push(value);
      return `$${registryValues.length}`;
    };
    if ('display_name' in patch) registryAssignments.push(`display_name = ${pushRegistry(patch.display_name)}`);
    if ('status' in patch) registryAssignments.push(`status = ${pushRegistry(patch.status)}`);
    if (registryAssignments.length > 0) {
      await client.query(
        `UPDATE entity_registry SET ${registryAssignments.join(', ')}, updated_at = now(), updated_by = ${pushRegistry(actorId)}
          WHERE project_id = $1 AND revision_id = $2 AND entity_id = ${pushRegistry(entity.entity_id)}`,
        registryValues,
      );
    }

    return { entityRef: { entity_id: entity.entity_id, entity_type: entity.entity_type }, patched: keys };
  },
};

/**
 * Creates or replaces one geometry record for an entity and role.
 *
 * The projected representation is materialized at write time ([D15]) so a spatial
 * index can serve containment and measurement without a per-read transform, and the
 * upsert is keyed on the table's own uniqueness rule so re-setting a role replaces it
 * rather than accumulating duplicates.
 */
const setGeometry = {
  kind: 'set_geometry',
  permission: 'facility.geometry.write',
  async apply({ client, projectId, scenarioId, revisionId, actorId, change }) {
    const entity = await resolveEntity({ client, projectId, revisionId, entityRef: change.entity_ref });
    const payload = change.payload ?? {};
    const role = requireField(payload, 'role');
    const expectedType = GEOMETRY_TYPE[role];
    if (!expectedType) {
      throw new ChangeRejected('The geometry role is not a catalog role.', {
        field: 'payload.role',
        reason: 'not_allowed',
        allowed: Object.keys(GEOMETRY_TYPE),
      });
    }
    const geometry = payload.geojson_4326;
    if (!geometry || typeof geometry !== 'object') {
      throw new ChangeRejected('The change requires WGS 84 GeoJSON.', {
        field: 'payload.geojson_4326',
        reason: 'required',
      });
    }
    // GeoJSON names types in title case (`Polygon`) and the store's enum is upper
    // case (`POLYGON`), so the comparison is case-insensitive and the enum value is
    // what gets written.
    const declaredType = typeof geometry.type === 'string' ? geometry.type.toUpperCase() : null;
    if (declaredType !== expectedType) {
      throw new ChangeRejected('The geometry type does not match the declared role.', {
        field: 'payload.geojson_4326.type',
        reason: 'type_mismatch',
        expected: expectedType,
        actual: geometry.type ?? null,
      });
    }

    const ordinal = payload.ordinal ?? 0;
    const { rows } = await client.query(
      `INSERT INTO geometry_records
         (geometry_id, project_id, scenario_id, revision_id, entity_id, entity_type, role, ordinal,
          geometry_type, geojson_4326, projected_geometry, projected_crs, elevation_base_m, elevation_top_m,
          height_m, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               ST_SetSRID(ST_GeomFromGeoJSON($10), 4326),
               ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($10), 4326), 32618),
               'EPSG:32618', $11, $12, $13, $14::jsonb, $15)
       ON CONFLICT (entity_id, entity_type, revision_id, role, ordinal, project_id)
       DO UPDATE SET geojson_4326 = EXCLUDED.geojson_4326,
                     projected_geometry = EXCLUDED.projected_geometry,
                     projected_crs = EXCLUDED.projected_crs,
                     geometry_type = EXCLUDED.geometry_type,
                     -- A height the caller supplied wins; one it omitted keeps what the revision
                     -- already stored. Taking EXCLUDED alone would null them, which is how a
                     -- caller that re-writes only the position — the assistant did — flattened a
                     -- building whose stored geometry carried its height. A *new* geometry has
                     -- nothing to keep, so the insert path still stores what it was given.
                     -- Clearing a height is therefore not expressible here; it would be its own
                     -- change, not a side effect of moving an object.
                     elevation_base_m = COALESCE(EXCLUDED.elevation_base_m, geometry_records.elevation_base_m),
                     elevation_top_m = COALESCE(EXCLUDED.elevation_top_m, geometry_records.elevation_top_m),
                     height_m = COALESCE(EXCLUDED.height_m, geometry_records.height_m),
                     provenance = EXCLUDED.provenance
       RETURNING geometry_id`,
      [
        payload.geometry_id ?? randomUUID(),
        projectId,
        scenarioId,
        revisionId,
        entity.entity_id,
        entity.entity_type,
        role,
        ordinal,
        expectedType,
        JSON.stringify(geometry),
        // The caller's own values, or null when it did not carry them. The upsert keeps the
        // stored ones in that case, so a move never has to know what it is not changing.
        payload.elevation_base_m ?? null,
        payload.elevation_top_m ?? null,
        payload.height_m ?? null,
        JSON.stringify({ source_ref: 'change_set', confidence: 'HIGH' }),
        actorId,
      ],
    );

    return {
      entityRef: { entity_id: entity.entity_id, entity_type: entity.entity_type },
      geometryId: rows[0].geometry_id,
      role,
      ordinal,
    };
  },
};

/**
 * Removes an entity from the revision.
 *
 * The registry row is marked `SUPERSEDED` rather than deleted, so a diagnostic or a
 * reference that named it still resolves and the change stays auditable. The
 * container row and its geometry are removed, because a removed design object with
 * a live footprint would keep appearing on the canvas.
 */
const removeEntity = {
  kind: 'remove_entity',
  permission: 'facility.entity.write',
  async apply({ client, projectId, revisionId, actorId, change }) {
    const entity = await resolveEntity({ client, projectId, revisionId, entityRef: change.entity_ref });
    const cascade = change.payload?.cascade ?? 'NONE';
    if (!['NONE', 'CHILDREN'].includes(cascade)) {
      throw new ChangeRejected('The cascade must be NONE or CHILDREN.', {
        field: 'payload.cascade',
        reason: 'not_allowed',
        allowed: ['NONE', 'CHILDREN'],
      });
    }

    const referrers = [];
    for (const reference of ENTITY_REFERENCES) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await client.query(
        `SELECT ${reference.nameColumn} AS name
           FROM ${reference.table}
          WHERE project_id = $1 AND revision_id = $2 AND ${reference.column} = $3
          LIMIT 5`,
        [projectId, revisionId, entity.entity_id],
      );
      for (const row of rows) {
        referrers.push({ table: reference.table, label: reference.label, name: row.name });
      }
    }

    // A child container is what cascade is for; everything else is a reference the
    // caller has to resolve first, whatever the cascade says.
    const blocking = referrers.filter((referrer) => referrer.table !== 'facility_containers');
    if (blocking.length > 0) {
      throw new ChangeConflict('Other records reference this entity.', {
        reason: 'referenced',
        entity_id: entity.entity_id,
        referrers: blocking,
      });
    }
    const children = referrers.filter((referrer) => referrer.table === 'facility_containers');
    if (children.length > 0 && cascade !== 'CHILDREN') {
      throw new ChangeConflict('The entity has children; pass cascade CHILDREN to remove them.', {
        reason: 'has_children',
        entity_id: entity.entity_id,
        referrers: children,
      });
    }

    if (cascade === 'CHILDREN') {
      await client.query(
        `DELETE FROM geometry_records
          WHERE project_id = $1 AND revision_id = $2
            AND entity_id IN (SELECT container_id FROM facility_containers
                               WHERE project_id = $1 AND revision_id = $2 AND parent_container_id = $3)`,
        [projectId, revisionId, entity.entity_id],
      );
      await client.query(
        `UPDATE entity_registry SET status = 'SUPERSEDED', updated_at = now(), updated_by = $4
          WHERE project_id = $1 AND revision_id = $2
            AND entity_id IN (SELECT container_id FROM facility_containers
                               WHERE project_id = $1 AND revision_id = $2 AND parent_container_id = $3)`,
        [projectId, revisionId, entity.entity_id, actorId],
      );
      await client.query(
        `DELETE FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND parent_container_id = $3`,
        [projectId, revisionId, entity.entity_id],
      );
    }

    await client.query(`DELETE FROM geometry_records WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`, [
      projectId, revisionId, entity.entity_id,
    ]);
    await client.query(`DELETE FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND container_id = $3`, [
      projectId, revisionId, entity.entity_id,
    ]);
    await client.query(
      `UPDATE entity_registry SET status = 'SUPERSEDED', updated_at = now(), updated_by = $4
        WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`,
      [projectId, revisionId, entity.entity_id, actorId],
    );

    return {
      entityRef: { entity_id: entity.entity_id, entity_type: entity.entity_type },
      removedChildren: cascade === 'CHILDREN' ? children.length : 0,
    };
  },
};

/**
 * Every kind, composed.
 *
 * A kind that edits an object the model treats as a design entity is a change set's
 * business; a kind that moves authority — publication, approval, waivers — is a tool
 * of its own, because those are governance acts rather than edits.
 */
export const CHANGE_KINDS = Object.freeze({
  create_container: createContainer,
  update_entity: updateEntity,
  set_geometry: setGeometry,
  remove_entity: removeEntity,
  ...AUTHORED_KINDS,
  // T3's one kind, in its own module so neither registry imports the other.
  ...IMPORT_CHANGE_KINDS,
});

/**
 * Dependency rank: a change set is applied in this order regardless of submission order.
 *
 * The order is the contract's — entities, then geometry, then constraints, phases,
 * utilities, resilience, capacity and environment — extended with the phase and
 * document kinds, and with removal last so a set may remove something it earlier
 * replaced.
 */
export const KIND_RANK = Object.freeze({
  create_container: 10,
  set_phase: 15,
  update_entity: 20,
  set_geometry: 30,
  assign_constraint: 40,
  assign_phase: 50,
  set_phase_capability: 52,
  set_phase_dependency: 55,
  set_utility_source: 60,
  set_utility_interface: 62,
  set_failure_domain: 65,
  set_storage_reserve: 67,
  set_resilience_requirement: 70,
  set_capacity_budget: 80,
  set_environmental_constraint: 90,
  record_assumption: 95,
  resolve_assumption: 96,
  attach_document: 97,
  detach_document: 98,
  remove_entity: 99,
  // Geometry re-projection runs after every geometry write and before removal.
  ...IMPORT_KIND_RANK,
});

export const CHANGE_KIND_NAMES = Object.freeze(Object.keys(CHANGE_KINDS));

/** The permission keys a given set of changes requires, deduplicated. */
export function permissionsForChanges(changes = []) {
  const keys = new Set();
  for (const change of changes) {
    const kind = CHANGE_KINDS[change?.kind];
    if (kind) keys.add(kind.permission);
  }
  return [...keys].sort();
}

/** Every permission any kind can require, for describing the tool to a caller. */
export function allChangePermissions() {
  return [...new Set(Object.values(CHANGE_KINDS).map((kind) => kind.permission))].sort();
}

/**
 * The catalog keys a finding carries, shared with the diagnostics read.
 *
 * One function so a previewed finding and a re-read one are identical in shape; the
 * capability derivation itself stays in `coverage.js`, which is the authority on it.
 */
export function catalogKeysFor(constraintId, resourceKind = null) {
  const entry = getConstraint(constraintId);
  return {
    evidence: entry?.evidence ?? null,
    gates: entry?.gates ?? null,
    capabilities: entry ? gatedCapabilities(entry, resourceKind) : [],
    capabilityExact: entry?.gates !== 'RESOURCE' || resourceKind !== null,
  };
}
