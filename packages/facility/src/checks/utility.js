import { finding } from './shared.js';

/** Non-firm supply states (interchange-contract.md, SupplyState). */
const NON_FIRM = ['CONTRACTUAL', 'PLANNED'];

export const utilityChecks = {
  'facility.utility.source.capacity_missing': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT utility_source_id, kind, capacity_value, capacity_unit, capacity_basis, capacity_state
         FROM utility_sources
        WHERE project_id = $1 AND revision_id = $2
          AND (capacity_value IS NULL OR capacity_unit IS NULL OR btrim(coalesce(capacity_unit, '')) = ''
               OR capacity_basis IS NULL OR capacity_state IS NULL)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'UTILITY_SOURCE', entity_id: row.utility_source_id }],
      computed: { expression: 'capacity tuple', expected: 'value + unit + basis + state', actual: 'incomplete' },
      resourceKind: row.kind,
    }));
  },

  'facility.utility.source.negative_capacity': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT utility_source_id, kind, capacity_value, capacity_unit
         FROM utility_sources
        WHERE project_id = $1 AND revision_id = $2 AND capacity_value <= 0`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'UTILITY_SOURCE', entity_id: row.utility_source_id }],
      sourceValues: [{ field: 'capacity_value', value: row.capacity_value, unit: row.capacity_unit }],
      computed: { expression: 'capacity_value', expected: '> 0', actual: row.capacity_value },
      resourceKind: row.kind,
    }));
  },

  /** A claim that rests on CONTRACTUAL or PLANNED capacity is not firm. */
  'facility.utility.source.state_not_firm': async (ctx, constraint) =>
    ctx.sources
      .filter((source) => NON_FIRM.includes(source.capacity_state))
      .map((source) => finding(constraint, {
        entityRefs: [{ entity_type: 'UTILITY_SOURCE', entity_id: source.utility_source_id }],
        sourceValues: [{ field: 'capacity_state', value: source.capacity_state }],
        computed: { expression: 'capacity_state', expected: 'FIRM or COMMISSIONED', actual: source.capacity_state },
        remediationHint: `Capacity state ${source.capacity_state} does not contribute to firm availability.`,
        resourceKind: source.kind,
      })),

  'facility.utility.source.availability_after_phase': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT s.utility_source_id, s.kind, s.available_from, p.phase_id, p.name AS phase_name,
              COALESCE(
                (SELECT min(a.available_from) FROM phase_capability_availability a
                  WHERE a.phase_id = p.phase_id AND a.project_id = p.project_id AND a.available),
                p.activation_date::timestamptz
              ) AS phase_available_from
         FROM utility_sources s
         JOIN facility_phases p ON p.phase_id = s.phase_id AND p.project_id = s.project_id
        WHERE s.project_id = $1 AND s.revision_id = $2
          AND s.available_from IS NOT NULL
          AND COALESCE(
                (SELECT min(a.available_from) FROM phase_capability_availability a
                  WHERE a.phase_id = p.phase_id AND a.project_id = p.project_id AND a.available),
                p.activation_date::timestamptz
              ) IS NOT NULL
          AND s.available_from > COALESCE(
                (SELECT min(a.available_from) FROM phase_capability_availability a
                  WHERE a.phase_id = p.phase_id AND a.project_id = p.project_id AND a.available),
                p.activation_date::timestamptz
              )`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'UTILITY_SOURCE', entity_id: row.utility_source_id }, { entity_type: 'FACILITY_PHASE', entity_id: row.phase_id }],
      sourceValues: [{ field: 'available_from', value: row.available_from }],
      computed: { expression: 'source availability vs phase availability', expected: `<= ${row.phase_available_from}`, actual: row.available_from },
      remediationHint: `${row.kind} source becomes available after ${row.phase_name}.`,
      resourceKind: row.kind,
    }));
  },

  'facility.utility.interface.source_undefined': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT i.interface_id, i.utility_source_id
         FROM utility_interfaces i
        WHERE i.project_id = $1 AND i.revision_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM utility_sources s
             WHERE s.utility_source_id = i.utility_source_id AND s.project_id = i.project_id)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'UTILITY_INTERFACE', entity_id: row.interface_id }],
      sourceValues: [{ field: 'utility_source_id', value: row.utility_source_id }],
      computed: { expression: 'source resolves in revision', expected: true, actual: false },
    }));
  },

  'facility.utility.interface.connectivity_missing': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT i.interface_id, s.kind
         FROM utility_interfaces i
         LEFT JOIN utility_sources s
           ON s.utility_source_id = i.utility_source_id AND s.project_id = i.project_id
        WHERE i.project_id = $1 AND i.revision_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM geometry_records g
             WHERE g.entity_id = i.interface_id AND g.project_id = i.project_id
               AND g.role = 'CONNECTION_POINT')`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'UTILITY_INTERFACE', entity_id: row.interface_id }],
      computed: { expression: 'CONNECTION_POINT geometry', expected: '>= 1', actual: 0 },
      remediationHint: 'An interface without a connection point cannot be handed to a downstream tool.',
      resourceKind: row.kind ?? null,
    }));
  },

  /** Downstream may add equipment; it may not redefine the source it attaches to. */
  'facility.utility.interface.redefines_source': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT i.interface_id, s.utility_source_id, s.kind,
              i.failure_domain_id AS interface_domain, s.failure_domain_id AS source_domain,
              i.capacity_basis AS interface_basis, s.capacity_basis AS source_basis,
              i.capacity_state AS interface_state, s.capacity_state AS source_state
         FROM utility_interfaces i
         JOIN utility_sources s
           ON s.utility_source_id = i.utility_source_id AND s.project_id = i.project_id
        WHERE i.project_id = $1 AND i.revision_id = $2
          AND (i.failure_domain_id <> s.failure_domain_id
               OR i.capacity_basis <> s.capacity_basis
               OR (i.capacity_state IS NOT NULL AND i.capacity_state <> s.capacity_state))`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'UTILITY_INTERFACE', entity_id: row.interface_id }, { entity_type: 'UTILITY_SOURCE', entity_id: row.utility_source_id }],
      computed: {
        expression: 'interface vs source',
        expected: `basis ${row.source_basis}, state ${row.source_state}, domain ${row.source_domain}`,
        actual: `basis ${row.interface_basis}, state ${row.interface_state ?? 'undeclared'}, domain ${row.interface_domain}`,
      },
      resourceKind: row.kind,
    }));
  },

  /** A site corridor that reaches no connection point connects nothing. */
  'facility.utility.route.disconnected': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT r.geometry_id AS route_id, r.entity_id AS route_entity
         FROM geometry_records r
        WHERE r.project_id = $1 AND r.revision_id = $2 AND r.role = 'ROUTE'
          AND NOT EXISTS (
            SELECT 1 FROM geometry_records p
             WHERE p.project_id = r.project_id AND p.revision_id = r.revision_id
               AND p.role = 'CONNECTION_POINT'
               AND ST_DWithin(r.projected_geometry, p.projected_geometry, 0.01))`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'UTILITY_ROUTE', entity_id: row.route_entity }],
      geometryRefs: [row.route_id],
      computed: { expression: 'route reaches a connection point', expected: true, actual: false },
    }));
  },
};

export const utilityCheckIds = Object.keys(utilityChecks);
