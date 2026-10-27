import { finding } from './shared.js';

/** SI-first unit conversion; an unknown unit is not silently treated as metres. */
const UNIT_TO_M = Object.freeze({ m: 1, cm: 0.01, mm: 0.001, km: 1000, ft: 0.3048, in: 0.0254 });

function metres(value, unit) {
  const factor = UNIT_TO_M[String(unit ?? 'm').toLowerCase()];
  return factor === undefined ? null : Number(value) * factor;
}

/** Constraint kinds whose rule is a regulatory or hazard claim. */
const RULE_BEARING = ['SETBACK', 'EASEMENT', 'ACCESS_ROUTE', 'HEIGHT_LIMIT', 'HAZARD_ZONE', 'EXCLUSION_ZONE', 'REGULATORY_LIMIT'];
/** Constraint kinds that must point at geometry. */
const GEOMETRY_BEARING = ['EASEMENT', 'ACCESS_ROUTE', 'HAZARD_ZONE', 'EXCLUSION_ZONE'];
/** Container kinds whose plan overlap with a same-level sibling is prohibited. */
const NO_OVERLAP = ['BUILDING', 'EQUIPMENT_YARD', 'RESERVED_AREA', 'HALL', 'SUPPORT_SPACE'];

export const siteChecks = {
  /** A building or equipment yard must sit inside the parcel that owns it. */
  'facility.site.container.outside_parent': async (ctx, constraint) => {
    const tolerance = ctx.policies.tolerances.arealM2;
    const { rows } = await ctx.client.query(
      // `ST_Within` is exact, and two rings that share an edge are reconstructed
      // from different vertices, so a container flush with its parent's edge
      // leaves a degenerate sliver. The areal tolerance bounds that comparison
      // and nothing else: real outside area is far larger than 0.01 m2.
      `SELECT c.container_id, c.kind, c.name, p.container_id AS parent_id, p.name AS parent_name,
              ST_Area(ST_Difference(cg.projected_geometry, pg.projected_geometry)) AS outside_m2
         FROM facility_containers c
         JOIN facility_containers p
           ON p.container_id = c.parent_container_id AND p.project_id = c.project_id
         JOIN geometry_records cg
           ON cg.entity_id = c.container_id AND cg.project_id = c.project_id AND cg.revision_id = c.revision_id
         JOIN geometry_records pg
           ON pg.entity_id = p.container_id AND pg.project_id = p.project_id AND pg.revision_id = p.revision_id
        WHERE c.project_id = $1 AND c.revision_id = $2
          AND ST_Area(ST_Difference(cg.projected_geometry, pg.projected_geometry)) > $3`,
      [ctx.projectId, ctx.revisionId, tolerance],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.container_id }],
      computed: {
        expression: 'area outside the parent',
        expected: `<= ${tolerance} m2`,
        actual: `${Number(row.outside_m2).toFixed(2)} m2`,
        tolerance,
      },
      remediationHint: `${row.name} is not fully inside ${row.parent_name}.`,
    }));
  },

  'facility.site.container.overlap': async (ctx, constraint) => {
    const tolerance = ctx.policies.tolerances.arealM2;
    const { rows } = await ctx.client.query(
      `SELECT a.container_id AS left_id, b.container_id AS right_id, a.name AS left_name, b.name AS right_name,
              ST_Area(ST_Intersection(ag.projected_geometry, bg.projected_geometry)) AS overlap_m2
         FROM facility_containers a
         JOIN facility_containers b
           ON b.parent_container_id = a.parent_container_id
          AND b.container_id > a.container_id
          AND b.project_id = a.project_id
          AND b.level_number IS NOT DISTINCT FROM a.level_number
          AND b.kind = ANY($3::container_kind[])
         JOIN geometry_records ag
           ON ag.entity_id = a.container_id AND ag.project_id = a.project_id AND ag.revision_id = a.revision_id
         JOIN geometry_records bg
           ON bg.entity_id = b.container_id AND bg.project_id = b.project_id AND bg.revision_id = b.revision_id
        WHERE a.project_id = $1 AND a.revision_id = $2
          AND a.kind = ANY($3::container_kind[])
          AND ST_Intersects(ag.projected_geometry, bg.projected_geometry)
          AND ST_Area(ST_Intersection(ag.projected_geometry, bg.projected_geometry)) > $4`,
      [ctx.projectId, ctx.revisionId, NO_OVERLAP, tolerance],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.left_id }, { entity_type: 'ENTITY', entity_id: row.right_id }],
      computed: { expression: 'overlap area', expected: `<= ${tolerance} m2`, actual: `${Number(row.overlap_m2).toFixed(2)} m2` },
      remediationHint: `${row.left_name} overlaps ${row.right_name}.`,
    }));
  },

  'facility.site.setback.violated': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `WITH anchor AS (
         SELECT c.constraint_id, c.rule_value, c.rule_unit,
                COALESCE(
                  (SELECT x.projected_geometry FROM geometry_records x
                    WHERE x.geometry_id = c.applies_to_geometry_id AND x.project_id = c.project_id),
                  (SELECT x.projected_geometry FROM geometry_records x
                    WHERE x.entity_id = c.scope_id AND x.project_id = c.project_id AND x.role = 'BOUNDARY' LIMIT 1)
                ) AS geom
           FROM spatial_constraints c
          WHERE c.project_id = $1 AND c.revision_id = $2 AND c.kind = 'SETBACK' AND c.rule_value IS NOT NULL
       )
       SELECT a.constraint_id, a.rule_value, a.rule_unit, g.geometry_id, g.entity_id, g.entity_type,
              -- The distance to a boundary is the distance to its ring: a footprint
              -- inside a polygon is at distance 0 from the polygon itself.
              ST_Distance(g.projected_geometry, ST_Boundary(a.geom)) AS distance
         FROM anchor a
         JOIN geometry_records g
           ON g.project_id = $1 AND g.revision_id = $2 AND g.role = 'FOOTPRINT'
        WHERE a.geom IS NOT NULL`,
      [ctx.projectId, ctx.revisionId],
    );
    const findings = [];
    for (const row of rows) {
      const required = metres(row.rule_value, row.rule_unit);
      if (required === null) continue;
      if (Number(row.distance) + ctx.policies.tolerances.linearM < required) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
          geometryRefs: [row.geometry_id],
          sourceValues: [{ field: 'rule_value', value: row.rule_value, unit: row.rule_unit }],
          computed: {
            expression: 'distance from boundary',
            expected: `>= ${required} m`,
            actual: `${Number(row.distance).toFixed(2)} m`,
            tolerance: ctx.policies.tolerances.linearM,
          },
          remediationHint: `${row.entity_type} is inside the ${required} m setback.`,
        }));
      }
    }
    return findings;
  },

  'facility.site.easement.violated': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `WITH area AS (
         SELECT c.constraint_id,
                COALESCE(
                  c.applies_to_geometry_id,
                  (SELECT x.geometry_id FROM geometry_records x
                    WHERE x.entity_id = c.constraint_id AND x.project_id = c.project_id
                      AND x.role = 'CONSTRAINT_AREA' LIMIT 1)
                ) AS geometry_id
           FROM spatial_constraints c
          WHERE c.project_id = $1 AND c.revision_id = $2 AND c.kind = 'EASEMENT'
       )
       SELECT a.constraint_id, ag.geometry_id AS area_id, g.geometry_id, g.entity_id, g.entity_type
         FROM area a
         JOIN geometry_records ag ON ag.geometry_id = a.geometry_id AND ag.project_id = $1
         JOIN geometry_records g
           ON g.project_id = $1 AND g.revision_id = $2
          -- A placement is a building footprint or a piece of equipment; the site
          -- and parcel boundaries contain the zone and are not placements.
          AND (g.role = 'FOOTPRINT' OR (g.role = 'BOUNDARY' AND g.entity_type IN ('EQUIPMENT_YARD', 'RESERVED_AREA')))
        WHERE ST_Intersects(g.projected_geometry, ag.projected_geometry)
          AND ST_Area(ST_Intersection(g.projected_geometry, ag.projected_geometry)) > $3`,
      [ctx.projectId, ctx.revisionId, ctx.policies.tolerances.arealM2],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
      geometryRefs: [row.geometry_id, row.area_id],
      computed: { expression: 'ST_Intersects(footprint, easement)', expected: false, actual: true },
      remediationHint: `${row.entity_type} falls within an easement.`,
    }));
  },

  'facility.site.access_route.blocked': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT r.geometry_id AS route_id, r.entity_id AS route_entity,
              b.geometry_id AS blocker_id, b.entity_id AS blocker_entity, b.entity_type AS blocker_type
         FROM geometry_records r
         JOIN geometry_records b
           ON b.project_id = r.project_id AND b.revision_id = r.revision_id
          AND b.role IN ('FOOTPRINT', 'FLOOR_BOUNDARY', 'ROOM_BOUNDARY', 'CONSTRAINT_AREA')
        WHERE r.project_id = $1 AND r.revision_id = $2 AND r.role = 'ROUTE'
          AND ST_Intersects(r.projected_geometry, b.projected_geometry)
          AND ST_Length(ST_Intersection(r.projected_geometry, b.projected_geometry)) > $3`,
      [ctx.projectId, ctx.revisionId, ctx.policies.tolerances.linearM],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'UTILITY_ROUTE', entity_id: row.route_entity }],
      geometryRefs: [row.route_id, row.blocker_id],
      computed: { expression: 'ST_Intersects(route, blocker)', expected: false, actual: true },
      remediationHint: `Route is blocked by ${row.blocker_type} ${row.blocker_entity}.`,
    }));
  },

  'facility.site.height.exceeded': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `WITH limits AS (
         SELECT constraint_id, container_id, scope_id, rule_value, rule_unit
           FROM spatial_constraints
          WHERE project_id = $1 AND revision_id = $2 AND kind = 'HEIGHT_LIMIT' AND rule_value IS NOT NULL
       ),
       scoped AS (
         SELECT l.constraint_id, l.rule_value, l.rule_unit, l.container_id AS entity_id
           FROM limits l WHERE l.container_id IS NOT NULL
         UNION ALL
         SELECT l.constraint_id, l.rule_value, l.rule_unit, g.entity_id
           FROM limits l
           JOIN geometry_records g ON g.project_id = $1 AND g.revision_id = $2
          WHERE l.container_id IS NULL AND l.scope_id IS NOT NULL
       )
       SELECT s.constraint_id, s.rule_value, s.rule_unit, g.geometry_id, g.entity_id, g.entity_type,
              COALESCE(g.height_m, g.elevation_top_m) AS actual
         FROM scoped s
         JOIN geometry_records g
           ON g.entity_id = s.entity_id AND g.project_id = $1 AND g.revision_id = $2
        WHERE COALESCE(g.height_m, g.elevation_top_m) IS NOT NULL`,
      [ctx.projectId, ctx.revisionId],
    );
    const findings = [];
    for (const row of rows) {
      const limit = metres(row.rule_value, row.rule_unit);
      if (limit === null) continue;
      // The height tolerance is zero: a limit is never rounded permissively.
      if (Number(row.actual) > limit + ctx.policies.tolerances.heightM) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
          geometryRefs: [row.geometry_id],
          sourceValues: [{ field: 'height_m', value: row.actual }],
          computed: { expression: 'height vs limit', expected: `<= ${limit} m`, actual: `${row.actual} m`, tolerance: 0 },
          remediationHint: `Height ${row.actual} m exceeds the ${limit} m limit.`,
        }));
      }
    }
    return findings;
  },

  'facility.site.hazard.excluded': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `WITH zone AS (
         SELECT c.constraint_id, c.kind,
                COALESCE(
                  c.applies_to_geometry_id,
                  (SELECT x.geometry_id FROM geometry_records x
                    WHERE x.entity_id = c.constraint_id AND x.project_id = c.project_id
                      AND x.role = 'CONSTRAINT_AREA' LIMIT 1)
                ) AS geometry_id
           FROM spatial_constraints c
          WHERE c.project_id = $1 AND c.revision_id = $2 AND c.kind IN ('HAZARD_ZONE', 'EXCLUSION_ZONE')
       )
       SELECT z.constraint_id, z.kind, zg.geometry_id AS zone_id, g.geometry_id, g.entity_id, g.entity_type
         FROM zone z
         JOIN geometry_records zg ON zg.geometry_id = z.geometry_id AND zg.project_id = $1
         JOIN geometry_records g
           ON g.project_id = $1 AND g.revision_id = $2
          AND (g.role = 'FOOTPRINT' OR (g.role = 'BOUNDARY' AND g.entity_type IN ('EQUIPMENT_YARD', 'RESERVED_AREA')))
        WHERE ST_Intersects(g.projected_geometry, zg.projected_geometry)
          AND ST_Area(ST_Intersection(g.projected_geometry, zg.projected_geometry)) > $3`,
      [ctx.projectId, ctx.revisionId, ctx.policies.tolerances.arealM2],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_type, entity_id: row.entity_id }],
      geometryRefs: [row.geometry_id, row.zone_id],
      computed: { expression: `${row.kind} containment`, expected: false, actual: true },
      remediationHint: `${row.entity_type} falls inside a ${row.kind}.`,
    }));
  },

  /** A regulatory or hazard claim with no rule and no provenance is not auditable. */
  'facility.site.constraint.rule_missing': async (ctx, constraint) =>
    ctx.spatialConstraints
      .filter((row) => RULE_BEARING.includes(row.kind))
      .filter((row) => row.rule_kind === null || Object.keys(row.provenance ?? {}).length === 0)
      .map((row) => finding(constraint, {
        entityRefs: [{ entity_type: 'SPATIAL_CONSTRAINT', entity_id: row.constraint_id }],
        sourceValues: [{ field: 'rule_kind', value: row.rule_kind }, { field: 'provenance', value: row.provenance }],
        computed: { expression: 'rule and provenance present', expected: true, actual: false },
        remediationHint: `${row.kind} constraint has no rule kind or no provenance reference.`,
      })),

  'facility.site.constraint.geometry_missing': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT c.constraint_id, c.kind
         FROM spatial_constraints c
        WHERE c.project_id = $1 AND c.revision_id = $2
          AND c.kind = ANY($3::constraint_kind[])
          AND c.applies_to_geometry_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM geometry_records g
             WHERE g.entity_id = c.constraint_id AND g.project_id = c.project_id
               AND g.role = 'CONSTRAINT_AREA')`,
      [ctx.projectId, ctx.revisionId, GEOMETRY_BEARING],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'SPATIAL_CONSTRAINT', entity_id: row.constraint_id }],
      computed: { expression: 'linked constraint geometry', expected: '>= 1', actual: 0 },
      remediationHint: `${row.kind} constraint has no linked geometry.`,
    }));
  },
};

export const NO_OVERLAP_KINDS = NO_OVERLAP;
export const siteCheckIds = Object.keys(siteChecks);
