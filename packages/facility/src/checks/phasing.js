import { finding } from './shared.js';

/** Resource kind to the capability a phase must have commissioned first. */
const CAPABILITY_BY_RESOURCE = Object.freeze({
  POWER: 'POWER',
  COOLING: 'COOLING',
  WATER: 'WATER',
  FUEL: 'FUEL',
  NETWORK_ENTRY: 'NETWORK_ENTRY',
});

export const phasingChecks = {
  'facility.phase.dependency.cycle': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `WITH RECURSIVE walk AS (
         SELECT predecessor_phase_id, successor_phase_id,
                ARRAY[predecessor_phase_id, successor_phase_id] AS path, false AS cycle
           FROM phase_dependencies WHERE project_id = $1 AND revision_id = $2
         UNION ALL
         SELECT w.predecessor_phase_id, d.successor_phase_id,
                w.path || d.successor_phase_id, (d.successor_phase_id = ANY(w.path))
           FROM phase_dependencies d
           JOIN walk w ON w.successor_phase_id = d.predecessor_phase_id
          WHERE d.project_id = $1 AND d.revision_id = $2 AND NOT w.cycle
       )
       SELECT DISTINCT predecessor_phase_id, successor_phase_id FROM walk WHERE cycle`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [
        { entity_type: 'FACILITY_PHASE', entity_id: row.predecessor_phase_id },
        { entity_type: 'FACILITY_PHASE', entity_id: row.successor_phase_id },
      ],
      computed: { expression: 'phase dependency graph', expected: 'acyclic', actual: 'cycle' },
    }));
  },

  'facility.phase.dependency.duplicate': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT predecessor_phase_id, successor_phase_id, count(*)::int AS edges
         FROM phase_dependencies
        WHERE project_id = $1 AND revision_id = $2
        GROUP BY predecessor_phase_id, successor_phase_id
       HAVING count(*) > 1`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [
        { entity_type: 'FACILITY_PHASE', entity_id: row.predecessor_phase_id },
        { entity_type: 'FACILITY_PHASE', entity_id: row.successor_phase_id },
      ],
      computed: { expression: 'edges per phase pair', expected: 1, actual: row.edges },
    }));
  },

  'facility.phase.dependency.self': async (ctx, constraint) =>
    ctx.phaseDeps
      .filter((edge) => edge.predecessor_phase_id === edge.successor_phase_id)
      .map((edge) => finding(constraint, {
        entityRefs: [{ entity_type: 'FACILITY_PHASE', entity_id: edge.predecessor_phase_id }],
        computed: { expression: 'predecessor <> successor', expected: true, actual: false },
      })),

  /**
   * A phase that consumes a resource kind must be commissioned for that
   * capability no later than its own activation: an unavailable capability with a
   * later availability date is a sequence that cannot be built.
   */
  'facility.phase.capability.before_commissioned': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT p.phase_id, p.name, p.phase_order, p.activation_date, a.capability,
              a.available, a.available_from
         FROM facility_phases p
         JOIN phase_capability_availability a
           ON a.phase_id = p.phase_id AND a.project_id = p.project_id
        WHERE p.project_id = $1 AND p.revision_id = $2
          AND p.activation_date IS NOT NULL
          AND (a.capability = 'GEOMETRY' OR a.capability = 'PHASING' OR a.capability = 'ENVIRONMENT'
               OR a.capability = 'POWER' OR a.capability = 'COOLING' OR a.capability = 'WATER'
               OR a.capability = 'FUEL' OR a.capability = 'NETWORK_ENTRY')
          AND (a.available = false OR (a.available_from IS NOT NULL AND a.available_from > p.activation_date::timestamptz))`,
      [ctx.projectId, ctx.revisionId],
    );

    // Only a phase that actually consumes the capability is a violation.
    const consumers = new Set();
    for (const source of ctx.sources) {
      const capability = CAPABILITY_BY_RESOURCE[source.kind];
      if (source.phase_id && capability) consumers.add(`${source.phase_id}:${capability}`);
    }
    for (const request of ctx.demand) {
      const capability = CAPABILITY_BY_RESOURCE[request.resource_kind];
      if (request.phase_id && capability) consumers.add(`${request.phase_id}:${capability}`);
    }

    return rows
      .filter((row) => consumers.has(`${row.phase_id}:${row.capability}`))
      .map((row) => finding(constraint, {
        entityRefs: [{ entity_type: 'FACILITY_PHASE', entity_id: row.phase_id }],
        sourceValues: [{ field: 'activation_date', value: row.activation_date }, { field: 'available_from', value: row.available_from }],
        computed: {
          expression: `${row.capability} availability vs phase activation`,
          expected: `<= ${row.activation_date}`,
          actual: row.available ? row.available_from : 'not available',
        },
        remediationHint: `${row.name} consumes ${row.capability} before it is commissioned.`,
      }));
  },

  /** Reserve held for a later phase must not be consumed by an earlier one. */
  'facility.phase.capacity.future_reserved_consumed': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT a.allocation_id, a.budget_id, b.resource_kind, b.reserved_value, b.phase_id AS budget_phase,
              bp.phase_order AS budget_order, rp.phase_id AS request_phase, rp.phase_order AS request_order
         FROM capacity_allocations a
         JOIN capacity_budgets b ON b.budget_id = a.budget_id AND b.project_id = a.project_id
         JOIN facility_phases bp ON bp.phase_id = b.phase_id AND bp.project_id = b.project_id
         JOIN capacity_demand_requests r ON r.request_id = a.demand_request_id AND r.project_id = a.project_id
         JOIN facility_phases rp ON rp.phase_id = r.phase_id AND rp.project_id = r.project_id
        WHERE a.project_id = $1 AND a.revision_id = $2
          AND a.state = 'ACCEPTED'
          AND b.reserved_value > 0
          AND bp.phase_order > rp.phase_order`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.allocation_id }, { entity_type: 'FACILITY_PHASE', entity_id: row.budget_phase }],
      sourceValues: [{ field: 'reserved_value', value: row.reserved_value }],
      computed: {
        expression: 'consuming phase vs reserving phase',
        expected: `>= ${row.budget_order}`,
        actual: row.request_order,
      },
      resourceKind: row.resource_kind,
    }));
  },

  'facility.phase.date.unconfirmed': async (ctx, constraint) =>
    ctx.phases
      .filter((phase) => !phase.activation_date || !phase.activation_date_precision)
      .map((phase) => finding(constraint, {
        entityRefs: [{ entity_type: 'FACILITY_PHASE', entity_id: phase.phase_id }],
        sourceValues: [
          { field: 'activation_date', value: phase.activation_date },
          { field: 'activation_date_precision', value: phase.activation_date_precision },
        ],
        computed: { expression: 'date and precision', expected: 'both declared', actual: 'incomplete' },
        remediationHint: `Phase "${phase.name}" has no confirmed activation date.`,
      })),
};

export { CAPABILITY_BY_RESOURCE };
export const phasingCheckIds = Object.keys(phasingChecks);
