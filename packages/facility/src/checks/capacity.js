import { finding } from './shared.js';
import { parsePolicyRef } from '../policies.js';

/** States that contribute to firm availability (D5). */
const FIRM_STATES = ['FIRM', 'COMMISSIONED'];

export const capacityChecks = {
  /**
   * D5: `available = firm * (1 - derating) - reserved - accepted`.
   * A budget with no derating policy is treated as zero derating here; the
   * missing policy is its own warning.
   */
  'facility.capacity.budget.overcommit': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT b.budget_id, b.resource_kind, b.basis, b.unit, b.commissioned_value, b.reserved_value,
              b.derating_factor,
              COALESCE((
                SELECT sum(a.quantity_value) FROM capacity_allocations a
                 WHERE a.budget_id = b.budget_id AND a.project_id = b.project_id AND a.state = 'ACCEPTED'
              ), 0) AS accepted
         FROM capacity_budgets b
        WHERE b.project_id = $1 AND b.revision_id = $2`,
      [ctx.projectId, ctx.revisionId],
    );
    const tolerance = ctx.policies.tolerances.capacityOvercommit;
    const findings = [];
    for (const row of rows) {
      const firm = Number(row.commissioned_value);
      const available = firm * (1 - Number(row.derating_factor)) - Number(row.reserved_value) - Number(row.accepted);
      if (available < -tolerance) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'CAPACITY_BUDGET', entity_id: row.budget_id }],
          computed: {
            expression: 'firm * (1 - derating) - reserved - accepted',
            expected: '>= 0',
            actual: `${available} ${row.unit}`,
            tolerance,
          },
          resourceKind: row.resource_kind,
        }));
      }
    }
    return findings;
  },

  'facility.capacity.budget.duplicate': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT owner_entity_id, phase_id, resource_kind, basis, count(*)::int AS budgets,
              array_agg(budget_id) AS budget_ids
         FROM capacity_budgets
        WHERE project_id = $1 AND revision_id = $2
        GROUP BY owner_entity_id, phase_id, resource_kind, basis
       HAVING count(*) > 1`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.owner_entity_id }, { entity_type: 'FACILITY_PHASE', entity_id: row.phase_id }],
      computed: { expression: 'budgets per owner/phase/kind/basis', expected: 1, actual: row.budgets },
      remediationHint: `Budgets ${row.budget_ids.join(', ')} share one identity.`,
      resourceKind: row.resource_kind,
    }));
  },

  'facility.capacity.allocation.basis_mismatch': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT a.allocation_id, a.quantity_basis, a.budget_id, b.basis AS budget_basis, b.resource_kind
         FROM capacity_allocations a
         JOIN capacity_budgets b ON b.budget_id = a.budget_id AND b.project_id = a.project_id
        WHERE a.project_id = $1 AND a.revision_id = $2
          AND a.quantity_basis <> b.basis`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.allocation_id }, { entity_type: 'ENTITY', entity_id: row.budget_id }],
      computed: { expression: 'allocation basis vs budget basis', expected: row.budget_basis, actual: row.quantity_basis },
      resourceKind: row.resource_kind,
    }));
  },

  'facility.capacity.allocation.phase_mismatch': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT a.allocation_id, a.budget_id, b.phase_id AS budget_phase, r.phase_id AS request_phase,
              b.resource_kind
         FROM capacity_allocations a
         JOIN capacity_budgets b ON b.budget_id = a.budget_id AND b.project_id = a.project_id
         JOIN capacity_demand_requests r ON r.request_id = a.demand_request_id AND r.project_id = a.project_id
        WHERE a.project_id = $1 AND a.revision_id = $2
          AND b.phase_id <> r.phase_id`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.allocation_id }, { entity_type: 'ENTITY', entity_id: row.budget_id }],
      computed: { expression: 'allocation phase vs budget phase', expected: row.budget_phase, actual: row.request_phase },
      resourceKind: row.resource_kind,
    }));
  },

  /**
   * A PROVISIONAL allocation holding a budget at or below zero is the only thing
   * keeping the gate open, so it is gating: only ACCEPTED allocations reduce
   * available capacity (D6).
   */
  'facility.capacity.allocation.provisional_gate': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT a.allocation_id, a.budget_id, b.resource_kind, b.unit, b.available_value
         FROM capacity_allocations a
         JOIN capacity_budgets b ON b.budget_id = a.budget_id AND b.project_id = a.project_id
        WHERE a.project_id = $1 AND a.revision_id = $2
          AND a.state = 'PROVISIONAL'
          AND b.available_value <= 0`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.allocation_id }, { entity_type: 'ENTITY', entity_id: row.budget_id }],
      computed: { expression: 'provisional allocation vs available capacity', expected: '> 0 without it', actual: row.available_value },
      remediationHint: 'Accept, reject, or revoke the provisional allocation before relying on this capacity.',
      resourceKind: row.resource_kind,
    }));
  },

  'facility.capacity.reserve.eroded': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT b.budget_id, b.resource_kind, b.unit, b.commissioned_value, b.reserved_value, b.derating_factor,
              b.provenance
         FROM capacity_budgets b
        WHERE b.project_id = $1 AND b.revision_id = $2`,
      [ctx.projectId, ctx.revisionId],
    );
    const findings = [];
    for (const row of rows) {
      const policyRef = policyReference(row.provenance);
      const policy = policyRef ? ctx.policies.resolve(policyRef.policy_id, policyRef.version) : null;
      const fraction = policy?.reserveFraction ?? null;
      if (fraction === null) continue;
      const firm = Number(row.commissioned_value) * (1 - Number(row.derating_factor));
      const required = firm * fraction;
      if (Number(row.reserved_value) + ctx.policies.tolerances.capacityOvercommit < required) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'CAPACITY_BUDGET', entity_id: row.budget_id }],
          sourceValues: [{ field: 'reserved_value', value: row.reserved_value, unit: row.unit }],
          computed: { expression: 'reserved vs policy reserve', expected: `>= ${required}`, actual: row.reserved_value },
          policyRef: policyRef ? `${policyRef.policy_id}@${policyRef.version}` : null,
          resourceKind: row.resource_kind,
        }));
      }
    }
    return findings;
  },

  /** Derating without a policy reference is an unexplained discount on firm capacity. */
  'facility.capacity.derating.undefined': async (ctx, constraint) =>
    ctx.budgets
      .filter((budget) => Number(budget.derating_factor) > 0)
      .filter((budget) => policyReference(budget.provenance) === null)
      .map((budget) => finding(constraint, {
        entityRefs: [{ entity_type: 'CAPACITY_BUDGET', entity_id: budget.budget_id }],
        sourceValues: [{ field: 'derating_factor', value: budget.derating_factor }],
        computed: { expression: 'policy reference for derating', expected: 'declared', actual: null },
        resourceKind: budget.resource_kind,
      })),

  'facility.capacity.planned.firm_claim': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT b.budget_id, b.resource_kind, b.unit, b.commissioned_value, b.planned_value, b.reserved_value,
              b.derating_factor, b.available_value
         FROM capacity_budgets b
        WHERE b.project_id = $1 AND b.revision_id = $2 AND b.planned_value > 0`,
      [ctx.projectId, ctx.revisionId],
    );
    const findings = [];
    for (const row of rows) {
      const firmAvailable = Number(row.commissioned_value) * (1 - Number(row.derating_factor)) - Number(row.reserved_value);
      if (Number(row.available_value) > firmAvailable + ctx.policies.tolerances.capacityOvercommit) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'CAPACITY_BUDGET', entity_id: row.budget_id }],
          sourceValues: [{ field: 'planned_value', value: row.planned_value, unit: row.unit }],
          computed: { expression: 'available vs firm-only availability', expected: `<= ${firmAvailable}`, actual: row.available_value },
          resourceKind: row.resource_kind,
        }));
      }
    }
    return findings;
  },

  'facility.interface.allocation.exceeded': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT r.request_id, r.resource_kind, r.requested_value, r.requested_unit,
              COALESCE(sum(a.quantity_value) FILTER (WHERE a.state = 'ACCEPTED'), 0) AS accepted
         FROM capacity_demand_requests r
         LEFT JOIN capacity_allocations a
           ON a.demand_request_id = r.request_id AND a.project_id = r.project_id
        WHERE r.project_id = $1 AND r.revision_id = $2
        GROUP BY r.request_id, r.resource_kind, r.requested_value, r.requested_unit
       HAVING COALESCE(sum(a.quantity_value) FILTER (WHERE a.state = 'ACCEPTED'), 0) > r.requested_value`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.request_id }],
      computed: { expression: 'accepted allocations vs requested envelope', expected: `<= ${row.requested_value} ${row.requested_unit}`, actual: row.accepted },
      resourceKind: row.resource_kind,
    }));
  },

  'facility.interface.entity_invalid': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT r.request_id, r.consumer_type, r.consumer_id, r.resource_kind
         FROM capacity_demand_requests r
        WHERE r.project_id = $1 AND r.revision_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM entity_registry e
             WHERE e.entity_id = r.consumer_id AND e.project_id = r.project_id AND e.revision_id = r.revision_id)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'ENTITY', entity_id: row.request_id }],
      sourceValues: [{ field: 'consumer_id', value: row.consumer_id }],
      computed: { expression: 'consumer resolves in revision', expected: true, actual: false },
      remediationHint: `${row.consumer_type} consumer ${row.consumer_id} is not a facility entity in this revision.`,
      resourceKind: row.resource_kind,
    }));
  },

  'facility.interface.request.provisional': async (ctx, constraint) =>
    ctx.demand
      .filter((request) => !FIRM_STATES.includes(request.requested_state))
      .map((request) => finding(constraint, {
        entityRefs: [{ entity_type: 'ENTITY', entity_id: request.request_id }],
        sourceValues: [{ field: 'requested_state', value: request.requested_state }],
        computed: { expression: 'requested_state', expected: 'FIRM or COMMISSIONED', actual: request.requested_state },
        resourceKind: request.resource_kind,
      })),
};

/** `provenance.policy_ref` is `policy_id@version`, or `{ policy_id, version }`. */
export function policyReference(provenance) {
  const raw = provenance?.policy_ref;
  if (!raw) return null;
  if (typeof raw === 'string') {
    const parsed = parsePolicyRef(raw);
    return parsed ? { policy_id: parsed.policyId, version: parsed.version } : null;
  }
  if (typeof raw === 'object' && raw.policy_id) return { policy_id: raw.policy_id, version: raw.version ?? null };
  return null;
}

export const capacityCheckIds = Object.keys(capacityChecks);
