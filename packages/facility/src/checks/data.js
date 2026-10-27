import { finding, SELF_INTERSECTION } from './shared.js';

/** Geometry roles and the geometry types they admit (entity-model.md). */
const ROLE_TYPES = Object.freeze({
  BOUNDARY: ['POLYGON', 'MULTIPOLYGON'],
  FOOTPRINT: ['POLYGON'],
  FLOOR_BOUNDARY: ['POLYGON'],
  ROOM_BOUNDARY: ['POLYGON'],
  ROUTE: ['LINESTRING'],
  CONNECTION_POINT: ['POINT'],
  CONSTRAINT_AREA: ['POLYGON', 'MULTIPOLYGON'],
  REFERENCE_POINT: ['POINT'],
});

/** Entity kinds with a required geometry role (entity-model.md, requirements table). */
const REQUIRED_ROLE = Object.freeze({
  SITE: 'BOUNDARY',
  PARCEL: 'BOUNDARY',
  BUILDING: 'FOOTPRINT',
  FLOOR: 'FLOOR_BOUNDARY',
  HALL: 'FLOOR_BOUNDARY',
  SUPPORT_SPACE: 'ROOM_BOUNDARY',
  EQUIPMENT_YARD: 'BOUNDARY',
  RESERVED_AREA: 'BOUNDARY',
  UTILITY_SOURCE: 'CONNECTION_POINT',
  UTILITY_INTERFACE: 'CONNECTION_POINT',
});

const ids = (rows, idColumn) => rows.map((row) => row[idColumn]);

export const dataChecks = {
  /** A scope with no containers, or an envelope with no scope, has nothing to design. */
  'facility.data.entity.required': async (ctx, constraint) => {
    const findings = [];
    if (ctx.scopes.length === 0) {
      findings.push(finding(constraint, {
        computed: { expression: 'design_scopes for envelope', expected: '>= 1', actual: 0 },
        remediationHint: 'Declare the SITE design scope for this envelope.',
      }));
    }
    for (const scope of ctx.scopes) {
      const children = ctx.containers.filter((container) => container.scope_id === scope.scope_id);
      if (children.length === 0) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'SITE', entity_id: scope.scope_id }],
          computed: { expression: 'facility_containers per scope', expected: '>= 1', actual: 0 },
          remediationHint: `Scope "${scope.name}" has no containers.`,
        }));
      }
    }
    return findings;
  },

  /** One stable id must not denote two entity types inside one revision. */
  'facility.data.id.duplicate': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT entity_id, array_agg(DISTINCT entity_type::text) AS entity_types
         FROM entity_registry
        WHERE project_id = $1 AND revision_id = $2
        GROUP BY entity_id
       HAVING count(DISTINCT entity_type) > 1`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_types[0], entity_id: row.entity_id }],
      computed: { expression: 'distinct entity_type per entity_id', expected: 1, actual: row.entity_types.length },
      remediationHint: `Entity id ${row.entity_id} is registered as ${row.entity_types.join(' and ')}.`,
    }));
  },

  'facility.data.crs.missing': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT geometry_id, entity_id, entity_type, role, projected_crs
         FROM geometry_records
        WHERE project_id = $1 AND revision_id = $2
          AND (projected_crs IS NULL OR btrim(projected_crs) = ''
               OR ST_SRID(projected_geometry) <= 0
               OR ST_SRID(geojson_4326) <> 4326)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
      geometryRefs: [row.geometry_id],
      sourceValues: [{ field: 'projected_crs', value: row.projected_crs }],
      computed: { expression: 'declared CRS and stored SRID', expected: 'EPSG + SRID > 0', actual: 'missing' },
    }));
  },

  /** A quantity without a unit or a basis cannot be compared with anything. */
  'facility.data.units.missing': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT 'utility_source' AS subject, utility_source_id::text AS id, utility_source_id AS ref_id,
              capacity_unit AS unit, capacity_basis::text AS basis
         FROM utility_sources
        WHERE project_id = $1 AND revision_id = $2
          AND (capacity_unit IS NULL OR btrim(capacity_unit) = '' OR capacity_basis IS NULL)
        UNION ALL
       SELECT 'capacity_budget', budget_id::text, owner_entity_id, unit, basis::text
         FROM capacity_budgets
        WHERE project_id = $1 AND revision_id = $2
          AND (unit IS NULL OR btrim(unit) = '' OR basis IS NULL)
        UNION ALL
       SELECT 'storage_reserve', storage_id::text, storage_id, capacity_unit, capacity_basis::text
         FROM storage_reserves
        WHERE project_id = $1 AND revision_id = $2
          AND (capacity_unit IS NULL OR btrim(capacity_unit) = '' OR capacity_basis IS NULL)
        UNION ALL
       SELECT 'environmental_constraint', environmental_constraint_id::text, affected_entity_id,
              threshold_unit, basis::text
         FROM environmental_constraints
        WHERE project_id = $1 AND revision_id = $2
          AND (threshold_unit IS NULL OR btrim(threshold_unit) = '' OR basis IS NULL)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: row.ref_id ? [{ entity_type: 'ENTITY', entity_id: row.ref_id }] : [],
      sourceValues: [{ field: 'unit', value: row.unit }, { field: 'basis', value: row.basis }],
      computed: { expression: `${row.subject} unit and basis`, expected: 'declared', actual: 'missing' },
      remediationHint: `${row.subject} ${row.id} declares no unit or basis.`,
    }));
  },

  /**
   * Topological validity. A self-intersection is reported by its own, more
   * specific identifier, so this check covers every other invalidity and the two
   * never both fire for one geometry.
   */
  'facility.data.geometry.invalid': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT geometry_id, entity_id, entity_type, role, ST_IsValidReason(projected_geometry) AS reason
         FROM geometry_records
        WHERE project_id = $1 AND revision_id = $2
          AND NOT ST_IsValid(projected_geometry)
          AND ST_IsValidReason(projected_geometry) !~* 'self-intersection'`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
      geometryRefs: [row.geometry_id],
      computed: { expression: 'ST_IsValid(projected_geometry)', expected: true, actual: false },
      remediationHint: row.reason,
    }));
  },

  'facility.data.geometry.self_intersection': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT geometry_id, entity_id, entity_type, role, ST_IsValidReason(projected_geometry) AS reason
         FROM geometry_records
        WHERE project_id = $1 AND revision_id = $2
          AND NOT ST_IsValid(projected_geometry)
          AND ST_IsValidReason(projected_geometry) ~* 'self-intersection'`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
      geometryRefs: [row.geometry_id],
      computed: { expression: 'ring self-intersection', expected: false, actual: true },
      remediationHint: row.reason,
    }));
  },

  'facility.data.geometry.type_mismatch': async (ctx, constraint) =>
    ctx.geometry
      .filter((row) => ROLE_TYPES[row.role] && !ROLE_TYPES[row.role].includes(row.geometry_type))
      .map((row) => finding(constraint, {
        entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
        geometryRefs: [row.geometry_id],
        sourceValues: [{ field: 'geometry_type', value: row.geometry_type }, { field: 'role', value: row.role }],
        computed: { expression: `geometry_type for ${row.role}`, expected: ROLE_TYPES[row.role].join('|'), actual: row.geometry_type },
      })),

  'facility.data.geometry.role_missing': async (ctx, constraint) => {
    const byEntity = new Map();
    for (const geometry of ctx.geometry) {
      if (!byEntity.has(geometry.entity_id)) byEntity.set(geometry.entity_id, new Set());
      byEntity.get(geometry.entity_id).add(geometry.role);
    }
    return ctx.entities
      .filter((entity) => REQUIRED_ROLE[entity.entity_type])
      .filter((entity) => !byEntity.get(entity.entity_id)?.has(REQUIRED_ROLE[entity.entity_type]))
      .map((entity) => finding(constraint, {
        entityRefs: [{ entity_type: entity.entity_type, entity_id: entity.entity_id }],
        sourceValues: [{ field: 'role', value: REQUIRED_ROLE[entity.entity_type] }],
        computed: { expression: `geometry role for ${entity.entity_type}`, expected: REQUIRED_ROLE[entity.entity_type], actual: null },
        remediationHint: `${entity.display_name ?? entity.entity_type} has no ${REQUIRED_ROLE[entity.entity_type]} geometry.`,
      }));
  },

  /** Building-local geometry needs a reviewed transform to the project CRS. */
  'facility.data.transform.unreviewed': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT g.geometry_id, g.entity_id, g.entity_type, g.role, g.parent_transform_id,
              t.review_state
         FROM geometry_records g
         LEFT JOIN spatial_transforms t
           ON t.transform_id = g.parent_transform_id AND t.project_id = g.project_id
        WHERE g.project_id = $1 AND g.revision_id = $2
          -- Only building-local geometry (a floor or room boundary) is expressed in
          -- a local CRS; site geometry is already in the project CRS. A geometry
          -- that does name a transform must name a reviewed one.
          AND (g.role IN ('FLOOR_BOUNDARY', 'ROOM_BOUNDARY') OR g.parent_transform_id IS NOT NULL)
          AND (t.review_state IS DISTINCT FROM 'REVIEWED')`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
      geometryRefs: [row.geometry_id],
      sourceValues: [{ field: 'parent_transform_id', value: row.parent_transform_id }],
      computed: { expression: 'transform review_state', expected: 'REVIEWED', actual: row.review_state ?? 'no transform' },
    }));
  },

  'facility.data.provenance.missing': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT 'geometry' AS subject, geometry_id::text AS id, entity_id, entity_type::text AS entity_type, provenance
         FROM geometry_records
        WHERE project_id = $1 AND revision_id = $2
          AND (provenance = '{}'::jsonb OR provenance->>'source_ref' IS NULL)
        UNION ALL
       SELECT 'utility_source', utility_source_id::text, utility_source_id, 'UTILITY_SOURCE', provenance
         FROM utility_sources
        WHERE project_id = $1 AND revision_id = $2
          AND (provenance = '{}'::jsonb OR provenance->>'source_ref' IS NULL)
        UNION ALL
       SELECT 'facility_container', container_id::text, container_id, entity_type::text, provenance
         FROM facility_containers
        WHERE project_id = $1 AND revision_id = $2
          AND (provenance = '{}'::jsonb OR provenance->>'source_ref' IS NULL)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
      sourceValues: [{ field: 'provenance', value: row.provenance }],
      computed: { expression: `${row.subject} provenance.source_ref`, expected: 'declared', actual: null },
    }));
  },

  'facility.data.provenance.stale': async (ctx, constraint) => {
    const stalenessDays = ctx.policies.tolerances.stalenessDays;
    const { rows } = await ctx.client.query(
      `SELECT geometry_id, entity_id, entity_type, provenance->>'effective_at' AS effective_at
         FROM geometry_records
        WHERE project_id = $1 AND revision_id = $2
          AND provenance->>'effective_at' IS NOT NULL
          AND (provenance->>'effective_at')::timestamptz < now() - ($3::int * interval '1 day')`,
      [ctx.projectId, ctx.revisionId, stalenessDays],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
      geometryRefs: [row.geometry_id],
      sourceValues: [{ field: 'effective_at', value: row.effective_at }],
      computed: { expression: 'age of effective_at', expected: `<= ${stalenessDays} days`, actual: row.effective_at },
    }));
  },

  /** An active assumption caps every touched capability at PROVISIONAL. */
  'facility.data.assumption.unresolved': async (ctx, constraint) =>
    ctx.assumptions
      .filter((assumption) => assumption.status === 'OPEN')
      .map((assumption) => finding(constraint, {
        entityRefs: [{ entity_type: 'ASSUMPTION', entity_id: assumption.assumption_id }],
        sourceValues: [{ field: 'statement', value: assumption.statement }, { field: 'owner', value: assumption.owner }],
        computed: { expression: 'assumption.status', expected: 'RESOLVED', actual: assumption.status },
        remediationHint: `Resolve or expire "${assumption.statement}".`,
      })),

  'facility.data.entity.parent_cycle': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `WITH RECURSIVE walk AS (
         SELECT container_id, parent_container_id, ARRAY[container_id] AS path,
                (parent_container_id = container_id) AS cycle
           FROM facility_containers
          WHERE project_id = $1 AND revision_id = $2
         UNION ALL
         SELECT c.container_id, c.parent_container_id, w.path || c.container_id,
                (c.parent_container_id = ANY(w.path))
           FROM facility_containers c
           JOIN walk w ON w.parent_container_id = c.container_id
          WHERE c.project_id = $1 AND c.revision_id = $2 AND NOT w.cycle
       )
       SELECT DISTINCT container_id FROM walk WHERE cycle`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.container_id }],
      computed: { expression: 'container parent chain', expected: 'acyclic', actual: 'cycle' },
    }));
  },

  'facility.data.entity.parent_cross_scope': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT c.container_id, c.scope_id AS child_scope, p.scope_id AS parent_scope,
              c.parent_container_id, c.revision_id, p.revision_id AS parent_revision
         FROM facility_containers c
         JOIN facility_containers p ON p.container_id = c.parent_container_id AND p.project_id = c.project_id
        WHERE c.project_id = $1 AND c.revision_id = $2
          AND (p.scope_id <> c.scope_id OR p.revision_id <> c.revision_id)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.container_id }, { entity_type: 'ENTITY', entity_id: row.parent_container_id }],
      computed: {
        expression: 'parent scope and revision',
        expected: row.child_scope,
        actual: `${row.parent_scope} @ ${row.parent_revision}`,
      },
    }));
  },
};

export { ROLE_TYPES, REQUIRED_ROLE };
export const dataCheckIds = Object.keys(dataChecks);
export { ids };
