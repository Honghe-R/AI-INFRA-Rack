import { finding } from './shared.js';

export const importChecks = {
  /** A mapping marked required that matches no extracted feature mapped nothing. */
  'facility.import.mapping.unresolved': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT m.mapping_id, m.binding_id, m.source_selector, m.target_entity_type
         FROM import_mappings m
        WHERE m.project_id = $1 AND m.revision_id = $2 AND m.required
          AND NOT EXISTS (
            SELECT 1 FROM import_features f
             WHERE f.project_id = m.project_id AND f.revision_id = m.revision_id
               AND f.binding_id = m.binding_id AND f.source_selector = m.source_selector)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.mapping_id }],
      sourceValues: [{ field: 'source_selector', value: row.source_selector }],
      computed: { expression: 'features matching the required selector', expected: '>= 1', actual: 0 },
      remediationHint: `Required mapping for "${row.source_selector}" matches no source feature.`,
    }));
  },

  'facility.import.mapping.ambiguous': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT m.mapping_id, m.source_selector, m.cardinality, count(f.import_feature_id)::int AS matches
         FROM import_mappings m
         JOIN import_features f
           ON f.project_id = m.project_id AND f.revision_id = m.revision_id
          AND f.binding_id = m.binding_id AND f.source_selector = m.source_selector
        WHERE m.project_id = $1 AND m.revision_id = $2 AND m.cardinality = 'ONE_TO_ONE'
        GROUP BY m.mapping_id, m.source_selector, m.cardinality
       HAVING count(f.import_feature_id) > 1`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.mapping_id }],
      sourceValues: [{ field: 'source_selector', value: row.source_selector }],
      computed: { expression: 'features per ONE_TO_ONE selector', expected: 1, actual: row.matches },
    }));
  },

  /** A mapped feature whose entity falls outside the design scope is not in the design. */
  'facility.import.geometry.out_of_bounds': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT DISTINCT f.import_feature_id, f.normalized_entity_id, g.geometry_id, g.entity_type
         FROM import_features f
         JOIN geometry_records g
           ON g.entity_id = f.normalized_entity_id AND g.project_id = f.project_id AND g.revision_id = f.revision_id
         JOIN geometry_records b
           ON b.project_id = f.project_id AND b.revision_id = f.revision_id AND b.role = 'BOUNDARY'
          AND b.entity_id IN (
            SELECT scope_id FROM design_scopes WHERE project_id = f.project_id AND revision_id = f.revision_id)
        WHERE f.project_id = $1 AND f.revision_id = $2
          AND f.normalized_entity_id IS NOT NULL
          AND NOT ST_Within(g.projected_geometry, b.projected_geometry)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: row.entity_type, entity_id: row.normalized_entity_id }],
      geometryRefs: [row.geometry_id],
      computed: { expression: 'ST_Within(imported geometry, scope boundary)', expected: true, actual: false },
      remediationHint: `Imported feature ${row.import_feature_id} lies outside the design scope.`,
    }));
  },
};

export const importCheckIds = Object.keys(importChecks);
