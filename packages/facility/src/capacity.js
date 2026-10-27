import { randomUUID } from 'node:crypto';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { RESOURCE_CAPABILITIES } from './catalog.js';
import { advanceEtag, requireBaseRevision, requireDraft } from './etags.js';

/**
 * Capacity allocation (T6).
 *
 * The schema has carried `capacity_budgets`, `capacity_demand_requests`, and
 * `capacity_allocations` since the first migration and the checks have read them
 * since T4, but **nothing wrote an allocation**: `available_value` was a column a
 * client filled in by hand and every capacity conclusion rested on it. This module
 * is the missing command half.
 *
 * Two operations, and they are deliberately not the same one:
 *
 *   * `requestCapacityAllocation` records a downstream demand request and answers it
 *     with a `PROVISIONAL` allocation when the budget has headroom, or a `REJECTED`
 *     one when it does not. Competing pending requests are ordered by [D6] before any
 *     of them is satisfied, so a later high-priority request cannot take capacity an
 *     earlier reserved one was waiting for.
 *   * `decideAllocation` is the authorized allocator's accept/reject/revoke/expire.
 *     Only `ACCEPTED` allocations reduce availability ([D5]); a `PROVISIONAL` one is a
 *     promise, not a commitment, which is exactly why the catalog gates on it.
 *
 * Availability is never trusted from a stored column: it is recomputed from the
 * budget's own terms and the accepted allocations in the same transaction that moves
 * an allocation, and the stored `allocated_value`/`available_value` are refreshed from
 * that answer. The formula is [D5]:
 *
 *     available = commissioned * (1 - derating_factor) - reserved - accepted
 *
 * `CONTRACTUAL`, `PLANNED`, `ASSUMED`, and `MEASURED` quantities never enter it, and
 * planned budget capacity never does either ([D5], interchange-contract.md).
 *
 * [D5]: ../../../doc/tools/site-and-facility/decisions.md
 * [D6]: ../../../doc/tools/site-and-facility/decisions.md
 */

/** D6 contention order. Lower rank is satisfied first. */
export const PRIORITY_ORDER = Object.freeze(['RESERVED', 'CRITICAL', 'HIGH', 'NORMAL', 'LOW']);

/** The allocator's decisions. A provisional allocation may be accepted or rejected. */
export const ALLOCATION_DECISIONS = Object.freeze(['ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED']);

/** States that end a request's participation in contention. */
export const TERMINAL_ALLOCATION_STATES = Object.freeze(['ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED']);

const CONSUMER_TYPES = Object.freeze([
  'FLOORPLAN', 'RACK', 'POWER', 'THERMAL', 'NETWORK', 'CABLING', 'VERIFY', 'SIMULATION', 'COST_SCHEDULE', 'DEPLOYMENT',
]);

const QUANTITY_STATES = Object.freeze(['MEASURED', 'CONTRACTUAL', 'FIRM', 'PLANNED', 'COMMISSIONED', 'ASSUMED']);

const CAPACITY_BASES = Object.freeze([
  'IT_LOAD', 'FACILITY_INPUT', 'HEAT_REJECTION', 'WATER_FLOW', 'USABLE_FLOOR_AREA',
  'NETWORK_ENTRY_COUNT', 'FUEL_VOLUME', 'AUTONOMY_DURATION',
]);

/**
 * [D5]. The one formula, in one place, so a command and a check cannot disagree.
 * `accepted` is the sum of `ACCEPTED` allocations only.
 */
export function availableCapacity({ commissioned, deratingFactor = 0, reserved = 0, accepted = 0 }) {
  return Number(commissioned) * (1 - Number(deratingFactor)) - Number(reserved) - Number(accepted);
}

/**
 * Orders open demand requests by [D6]: `RESERVED`, `CRITICAL`, `HIGH`, `NORMAL`, `LOW`,
 * then earliest `required_from`, then earliest request. Two requests that agree on all
 * three are a **tie**, which the contract refuses rather than resolving by an arbitrary
 * pick — so the tie set is returned for the caller to reject.
 *
 * The comparison is on the full triple and not on the priority alone, because two
 * `CRITICAL` requests the same day are not ordered by either of the remaining keys and
 * picking one would be the arbitrary pick D6 forbids.
 */
export function contentionOrder(requests = []) {
  const rank = new Map(PRIORITY_ORDER.map((priority, index) => [priority, index]));
  const entries = requests.map((request) => ({
    request,
    // The tie key is the ordered triple D6 names. `required_from` and `created_at` are
    // normalised to their millisecond value so two timestamptz spellings of one instant
    // compare equal.
    key: [
      rank.get(request.priority) ?? PRIORITY_ORDER.length,
      instant(request.requiredFrom ?? request.required_from),
      instant(request.createdAt ?? request.created_at),
    ],
  }));

  const ordered = [...entries].sort((left, right) => compareKey(left.key, right.key) || String(idOf(left.request)).localeCompare(String(idOf(right.request))));

  const byKey = new Map();
  for (const entry of ordered) {
    const serialized = entry.key.join('|');
    if (!byKey.has(serialized)) byKey.set(serialized, []);
    byKey.get(serialized).push(idOf(entry.request));
  }
  const ties = new Set();
  for (const ids of byKey.values()) {
    if (ids.length > 1) for (const id of ids) ties.add(id);
  }

  return { ordered: ordered.map((entry) => entry.request), ties };
}

function compareKey(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function instant(value) {
  if (value === null || value === undefined) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function idOf(request) {
  return request?.requestId ?? request?.request_id ?? '';
}

/**
 * Records one `CapacityDemandRequest` and answers it.
 *
 * The request is a draft mutation, so it carries the same concurrency preconditions as
 * every other draft write ([D2]): `base_revision_id` and the current ETag. The token
 * advances on success, because the allocation state the request produced is part of the
 * revision's capacity accounting.
 */
export async function requestCapacityAllocation({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  actorId = null,
  correlationId = null,
  consumerType,
  consumerId,
  phaseId,
  resourceKind,
  requestedCapacity = {},
  requiredFrom,
  priority = 'NORMAL',
  baseRevisionId = null,
  etag = null,
  logger = null,
} = {}) {
  if (!pool && !providedClient) throw new Error('requestCapacityAllocation requires a database pool.');
  assertEnum(consumerType, CONSUMER_TYPES, 'consumer_type');
  assertEnum(resourceKind, RESOURCE_CAPABILITIES, 'resource_kind');
  assertEnum(priority, PRIORITY_ORDER, 'priority');
  if (!consumerId) throw fieldError('consumer_id', 'required');
  if (!phaseId) throw fieldError('phase_id', 'required');
  if (!requiredFrom || Number.isNaN(Date.parse(requiredFrom))) throw fieldError('required_from', 'not_a_timestamp');
  const value = Number(requestedCapacity.value);
  if (!Number.isFinite(value) || value < 0) throw fieldError('requested_capacity.value', 'not_a_non_negative_number');
  const unit = requestedCapacity.unit;
  if (!unit) throw fieldError('requested_capacity.unit', 'required');
  assertEnum(requestedCapacity.basis, CAPACITY_BASES, 'requested_capacity.basis');
  const requestedState = requestedCapacity.state ?? 'PLANNED';
  assertEnum(requestedState, QUANTITY_STATES, 'requested_capacity.state');

  return inTenant(providedClient, pool, projectId, async (client) => {
    const revision = await requireDraft({ client, projectId, revisionId });
    requireBaseRevision({ revision, baseRevisionId });
    const envelopeId = await requireEnvelope({ client, projectId, revisionId });

    await requireConsumer({ client, projectId, revisionId, consumerId });
    await requirePhase({ client, projectId, revisionId, phaseId });

    const requestId = randomUUID();
    await client.query(
      `INSERT INTO capacity_demand_requests
         (request_id, project_id, scenario_id, revision_id, envelope_id, consumer_type, consumer_id, phase_id,
          resource_kind, requested_value, requested_unit, requested_basis, requested_state, required_from,
          priority, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17)`,
      [
        requestId, projectId, revision.scenario_id, revisionId, envelopeId, consumerType, consumerId, phaseId,
        resourceKind, value, unit, requestedCapacity.basis, requestedState, requiredFrom,
        priority, JSON.stringify({ source_ref: 'capacity_request' }), actorId,
      ],
    );

    const decision = await decideRequest({
      client,
      projectId,
      scenarioId: revision.scenario_id,
      revisionId,
      envelopeId,
      request: {
        requestId,
        consumerType,
        consumerId,
        phaseId,
        resourceKind,
        requestedValue: value,
        requestedUnit: unit,
        requestedBasis: requestedCapacity.basis,
        requestedState,
        requiredFrom,
        priority,
        createdAt: new Date(),
      },
      actorId,
      correlationId,
    });

    const token = await advanceEtag({ client, projectId, revisionId, expectedEtag: etag, actorId });

    const result = {
      requestId,
      revisionId,
      etag: token.etag,
      etagVersion: token.etagVersion,
      state: decision.state,
      reason: decision.reason,
      allocations: decision.allocations,
      budgets: decision.budgets,
      shortfall: decision.shortfall,
      contention: decision.contention,
      effect: decision.effect,
    };

    logger?.info?.('capacity.request.decided', {
      projectId,
      revisionId,
      requestId,
      resourceKind,
      state: decision.state,
      reason: decision.reason,
      allocations: decision.allocations.length,
    });

    return result;
  });
}

/**
 * The allocator over one request group: every open request for the same revision,
 * phase, resource kind, and basis is ordered by D6 and satisfied in turn from the
 * budgets that can serve it.
 *
 * Only the newly recorded request can change here. An earlier request's provisional
 * allocation is already a recorded decision, and re-deciding it on every subsequent
 * request would make the ledger move under a caller that is not looking. What the
 * earlier request *does* is consume headroom: provisional quantities are commitments
 * for this pass even though [D5] excludes them from `available_capacity`.
 */
async function decideRequest({ client, projectId, scenarioId, revisionId, envelopeId, request, actorId, correlationId }) {
  const open = await loadOpenRequests({ client, projectId, revisionId, phaseId: request.phaseId, resourceKind: request.resourceKind, basis: request.requestedBasis });
  const { ordered, ties } = contentionOrder(open.map(toRequestShape));

  if (ties.has(request.requestId)) {
    const budgets = await loadBudgets({ client, projectId, revisionId, phaseId: request.phaseId, resourceKind: request.resourceKind, basis: request.requestedBasis });
    const rejected = await recordAllocation({
      client, projectId, scenarioId, revisionId, request, budgetId: budgets[0]?.budgetId ?? null,
      quantity: 0, state: 'REJECTED', actorId,
    });
    return {
      state: 'REJECTED',
      reason: 'contention_tie',
      allocations: rejected ? [rejected] : [],
      budgets: budgets.map(toBudgetShape),
      shortfall: request.requestedValue,
      contention: ordered.map((entry) => ({ requestId: idOf(entry), priority: entry.priority, requiredFrom: entry.requiredFrom })),
      effect: 'Two demand requests share a priority and a required-from instant, so the contention order cannot separate them. D6 refuses to pick one; re-submit with a distinguishing priority or required-from date.',
    };
  }

  const budgets = await loadBudgets({ client, projectId, revisionId, phaseId: request.phaseId, resourceKind: request.resourceKind, basis: request.requestedBasis });
  if (budgets.length === 0) {
    // Nothing to allocate from. The demand request is recorded either way — a request
    // with no budget is a real finding, not a client error.
    await recordAllocationEvent({ client, projectId, scenarioId, revisionId, request, allocationId: null, budgetId: null, state: 'REJECTED', delta: 0, actorId, correlationId });
    return {
      state: 'REJECTED',
      reason: 'no_budget',
      allocations: [],
      budgets: [],
      shortfall: request.requestedValue,
      contention: ordered.map((entry) => ({ requestId: idOf(entry), priority: entry.priority, requiredFrom: entry.requiredFrom })),
      effect: `No capacity budget exists for ${request.resourceKind} / ${request.requestedBasis} in this phase, so the request cannot be satisfied. Add a budget for the owning entity and phase.`,
    };
  }

  // Headroom excludes what open (provisional) allocations already promise.
  const provisional = await loadProvisionalTotals({ client, projectId, revisionId, budgetIds: budgets.map((budget) => budget.budgetId) });
  const plans = [];
  let remaining = request.requestedValue;

  for (const budget of budgets) {
    if (remaining <= 0) break;
    const headroom = Number(budget.available) - (provisional.get(budget.budgetId) ?? 0);
    if (headroom <= 0) continue;
    const take = Math.min(remaining, headroom);
    plans.push({ budget, quantity: take });
    remaining -= take;
  }

  const allocations = [];
  if (remaining > 0) {
    // Partial capacity is not an allocation the contract can express, so the request is
    // rejected whole and the shortfall is stated. The budget that would have served it
    // is recorded on the rejected row so the finding names a real budget.
    const rejected = await recordAllocation({
      client, projectId, scenarioId, revisionId, request, budgetId: budgets[0].budgetId,
      quantity: 0, state: 'REJECTED', actorId,
    });
    if (rejected) allocations.push(rejected);
    await recordAllocationEvent({ client, projectId, scenarioId, revisionId, request, allocationId: rejected?.allocationId ?? null, budgetId: budgets[0].budgetId, state: 'REJECTED', delta: 0, actorId, correlationId });
    return {
      state: 'REJECTED',
      reason: 'insufficient_capacity',
      allocations,
      budgets: budgets.map(toBudgetShape),
      shortfall: remaining,
      contention: ordered.map((entry) => ({ requestId: idOf(entry), priority: entry.priority, requiredFrom: entry.requiredFrom })),
      effect: `Only ${request.requestedValue - remaining} ${request.requestedUnit} of the requested ${request.requestedValue} ${request.requestedUnit} is uncommitted, a shortfall of ${remaining}. No provisional allocation was recorded.`,
    };
  }

  for (const plan of plans) {
    const allocation = await recordAllocation({
      client, projectId, scenarioId, revisionId, request, budgetId: plan.budget.budgetId,
      quantity: plan.quantity, state: 'PROVISIONAL', actorId,
    });
    allocations.push(allocation);
    await recordAllocationEvent({ client, projectId, scenarioId, revisionId, request, allocationId: allocation.allocationId, budgetId: plan.budget.budgetId, state: 'PROVISIONAL', delta: plan.quantity, actorId, correlationId });
  }

  return {
    state: 'PROVISIONAL',
    reason: null,
    allocations,
    budgets: budgets.map(toBudgetShape),
    shortfall: 0,
    contention: ordered.map((entry) => ({ requestId: idOf(entry), priority: entry.priority, requiredFrom: entry.requiredFrom })),
    effect: `A PROVISIONAL allocation of ${request.requestedValue} ${request.requestedUnit} was recorded across ${allocations.length} budget(s). Only an ACCEPTED allocation reduces available capacity; accept it with decideAllocation when the demand is committed.`,
  };
}

/**
 * The authorized allocator's decision.
 *
 * `accepted` reduces the budget's availability in the same transaction, and the
 * acceptance is bounded by what the request asked for: an allocator may not accept more
 * than the demand envelope, which is the invariant `facility.interface.allocation.exceeded`
 * checks after the fact.
 */
export async function decideAllocation({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  allocationId,
  state,
  comment = null,
  actorId = null,
  correlationId = null,
  baseRevisionId = null,
  etag = null,
  logger = null,
} = {}) {
  if (!pool && !providedClient) throw new Error('decideAllocation requires a database pool.');
  assertEnum(state, ALLOCATION_DECISIONS, 'state');

  return inTenant(providedClient, pool, projectId, async (client) => {
    const revision = await requireDraft({ client, projectId, revisionId });
    requireBaseRevision({ revision, baseRevisionId });

    const allocation = (
      await client.query(
        `SELECT a.allocation_id, a.budget_id, a.demand_request_id, a.quantity_value, a.quantity_unit,
                a.quantity_basis, a.state, r.requested_value, r.resource_kind, r.phase_id
           FROM capacity_allocations a
           JOIN capacity_demand_requests r
             ON r.request_id = a.demand_request_id AND r.project_id = a.project_id
          WHERE a.project_id = $1 AND a.revision_id = $2 AND a.allocation_id = $3
            FOR UPDATE OF a`,
        [projectId, revisionId, allocationId],
      )
    ).rows[0];
    if (!allocation) throw errors.notFound('The requested resource was not found.');

    assertTransition(allocation.state, state);

    if (state === 'ACCEPTED') {
      const accepted = Number(
        (
          await client.query(
            `SELECT COALESCE(sum(quantity_value), 0) AS total
               FROM capacity_allocations
              WHERE project_id = $1 AND demand_request_id = $2 AND state = 'ACCEPTED' AND allocation_id <> $3`,
            [projectId, allocation.demand_request_id, allocationId],
          )
        ).rows[0].total,
      );
      if (accepted + Number(allocation.quantity_value) > Number(allocation.requested_value) + 1e-9) {
        throw new ApiError('CAPACITY_REQUEST_EXCEEDED', 'Accepting this allocation would exceed the demand request envelope.', {
          status: 422,
          details: [
            {
              field: 'allocation_id',
              reason: 'request_envelope_exceeded',
              requested_value: Number(allocation.requested_value),
              already_accepted: accepted,
              this_allocation: Number(allocation.quantity_value),
            },
          ],
        });
      }
    }

    await client.query(
      `UPDATE capacity_allocations
          SET state = $4, updated_at = now(), updated_by = $5
        WHERE project_id = $1 AND revision_id = $2 AND allocation_id = $3`,
      [projectId, revisionId, allocationId, state, actorId],
    );

    const budget = await syncBudget({ client, projectId, budgetId: allocation.budget_id });

    await client.query(
      `INSERT INTO outbox_events
         (event_id, project_id, scenario_id, revision_id, event_type, aggregate_type, aggregate_id, payload,
          correlation_id, created_by)
       VALUES ($1, $2, $3, $4, 'facility.allocation.decided.v1', 'capacity_allocation', $5, $6::jsonb, $7, $8)`,
      [
        randomUUID(), projectId, revision.scenario_id, revisionId, allocationId,
        JSON.stringify({
          allocation_id: allocationId,
          demand_request_id: allocation.demand_request_id,
          budget_id: allocation.budget_id,
          resource_kind: allocation.resource_kind,
          state,
          availability: budget?.availableValue ?? null,
        }),
        correlationId, actorId,
      ],
    );

    const token = await advanceEtag({ client, projectId, revisionId, expectedEtag: etag, actorId });

    logger?.info?.('capacity.allocation.decided', {
      projectId, revisionId, allocationId, state, budgetId: allocation.budget_id,
    });

    return {
      allocationId,
      revisionId,
      state,
      comment,
      etag: token.etag,
      etagVersion: token.etagVersion,
      budget,
      effect:
        state === 'ACCEPTED'
          ? `The allocation is ACCEPTED and now reduces the budget's available capacity by ${allocation.quantity_value} ${allocation.quantity_unit}.`
          : state === 'REJECTED'
            ? 'The allocation is REJECTED and releases no committed capacity; the budget is unchanged.'
            : state === 'REVOKED'
              ? `The allocation is REVOKED and the ${allocation.quantity_value} ${allocation.quantity_unit} it held is returned to the budget.`
              : `The allocation is EXPIRED and the ${allocation.quantity_value} ${allocation.quantity_unit} it held is returned to the budget.`,
    };
  });
}

/**
 * Recomputes a budget's `allocated_value` and `available_value` from its own terms and
 * its accepted allocations, and returns the row. [D5] has one formula, and this is where
 * the stored projection of it is refreshed.
 */
export async function syncBudget({ client, projectId, budgetId }) {
  const row = (
    await client.query(
      `SELECT b.budget_id, b.owner_entity_id, b.phase_id, b.utility_interface_id, b.resource_kind, b.basis, b.unit,
              b.commissioned_value, b.planned_value, b.reserved_value, b.allocated_value, b.available_value,
              b.derating_factor,
              COALESCE((
                SELECT sum(a.quantity_value) FROM capacity_allocations a
                 WHERE a.budget_id = b.budget_id AND a.project_id = b.project_id AND a.state = 'ACCEPTED'
              ), 0) AS accepted
         FROM capacity_budgets b
        WHERE b.project_id = $1 AND b.budget_id = $2`,
      [projectId, budgetId],
    )
  ).rows[0];
  if (!row) return null;

  const accepted = Number(row.accepted);
  const available = availableCapacity({
    commissioned: row.commissioned_value,
    deratingFactor: row.derating_factor,
    reserved: row.reserved_value,
    accepted,
  });

  await client.query(
    `UPDATE capacity_budgets
        SET allocated_value = $3, available_value = $4, updated_at = now()
      WHERE project_id = $1 AND budget_id = $2`,
    [projectId, budgetId, accepted, available],
  );

  return { ...toBudgetShape(row), acceptedValue: accepted, availableValue: available };
}

async function requireEnvelope({ client, projectId, revisionId }) {
  const { rows } = await client.query(
    `SELECT envelope_id FROM facility_envelopes WHERE project_id = $1 AND revision_id = $2`,
    [projectId, revisionId],
  );
  if (rows.length === 0) {
    throw new ApiError('FACILITY_ENVELOPE_NOT_FOUND', 'The revision has no facility envelope.', { status: 409 });
  }
  return rows[0].envelope_id;
}

async function requireConsumer({ client, projectId, revisionId, consumerId }) {
  const { rows } = await client.query(
    `SELECT 1 FROM entity_registry WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`,
    [projectId, revisionId, consumerId],
  );
  if (rows.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'The consumer is not an entity in this revision.', {
      status: 422,
      details: [{ field: 'consumer_id', reason: 'not_in_revision' }],
    });
  }
}

async function requirePhase({ client, projectId, revisionId, phaseId }) {
  const { rows } = await client.query(
    `SELECT 1 FROM facility_phases WHERE project_id = $1 AND revision_id = $2 AND phase_id = $3`,
    [projectId, revisionId, phaseId],
  );
  if (rows.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'The phase does not exist in this revision.', {
      status: 422,
      details: [{ field: 'phase_id', reason: 'not_in_revision' }],
    });
  }
}

async function loadOpenRequests({ client, projectId, revisionId, phaseId, resourceKind, basis }) {
  const { rows } = await client.query(
    `SELECT r.request_id, r.consumer_type, r.consumer_id, r.phase_id, r.resource_kind, r.requested_value,
            r.requested_unit, r.requested_basis, r.requested_state, r.required_from, r.priority, r.created_at
       FROM capacity_demand_requests r
      WHERE r.project_id = $1 AND r.revision_id = $2 AND r.phase_id = $3 AND r.resource_kind = $4
        AND r.requested_basis = $5
        AND NOT EXISTS (
          SELECT 1 FROM capacity_allocations a
           WHERE a.project_id = r.project_id AND a.demand_request_id = r.request_id
             AND a.state = ANY($6::allocation_state[])
        )
      ORDER BY r.created_at, r.request_id`,
    [projectId, revisionId, phaseId, resourceKind, basis, TERMINAL_ALLOCATION_STATES],
  );
  return rows;
}

async function loadBudgets({ client, projectId, revisionId, phaseId, resourceKind, basis }) {
  const { rows } = await client.query(
    `SELECT b.budget_id, b.owner_entity_id, b.phase_id, b.utility_interface_id, b.resource_kind, b.basis, b.unit,
            b.commissioned_value, b.planned_value, b.reserved_value, b.allocated_value, b.available_value,
            b.derating_factor,
            COALESCE((
              SELECT sum(a.quantity_value) FROM capacity_allocations a
               WHERE a.budget_id = b.budget_id AND a.project_id = b.project_id AND a.state = 'ACCEPTED'
            ), 0) AS accepted
       FROM capacity_budgets b
      WHERE b.project_id = $1 AND b.revision_id = $2 AND b.phase_id = $3
        AND b.resource_kind = $4 AND b.basis = $5`,
    [projectId, revisionId, phaseId, resourceKind, basis],
  );
  return rows
    .map((row) => ({
      ...toBudgetShape(row),
      available: availableCapacity({
        commissioned: row.commissioned_value,
        deratingFactor: row.derating_factor,
        reserved: row.reserved_value,
        accepted: row.accepted,
      }),
    }))
    // Most headroom first, then budget id, so the split is deterministic and the
    // fullest budget is consumed last.
    .sort((left, right) => right.available - left.available || left.budgetId.localeCompare(right.budgetId));
}

async function loadProvisionalTotals({ client, projectId, revisionId, budgetIds }) {
  const totals = new Map();
  if (budgetIds.length === 0) return totals;
  const { rows } = await client.query(
    `SELECT budget_id, COALESCE(sum(quantity_value), 0) AS total
       FROM capacity_allocations
      WHERE project_id = $1 AND revision_id = $2 AND budget_id = ANY($3::uuid[]) AND state = 'PROVISIONAL'
      GROUP BY budget_id`,
    [projectId, revisionId, budgetIds],
  );
  for (const row of rows) totals.set(row.budget_id, Number(row.total));
  return totals;
}

async function recordAllocation({ client, projectId, scenarioId, revisionId, request, budgetId, quantity, state, actorId }) {
  if (!budgetId) return null;
  const allocationId = randomUUID();
  await client.query(
    `INSERT INTO capacity_allocations
       (allocation_id, project_id, scenario_id, revision_id, budget_id, demand_request_id, quantity_value,
        quantity_unit, quantity_basis, quantity_state, state, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      allocationId, projectId, scenarioId, revisionId, budgetId, request.requestId, quantity,
      request.requestedUnit, request.requestedBasis, request.requestedState, state, actorId,
    ],
  );
  return {
    allocationId,
    budgetId,
    demandRequestId: request.requestId,
    quantityValue: quantity,
    quantityUnit: request.requestedUnit,
    quantityBasis: request.requestedBasis,
    quantityState: request.requestedState,
    state,
  };
}

async function recordAllocationEvent({ client, projectId, scenarioId, revisionId, request, allocationId, budgetId, state, delta, actorId, correlationId }) {
  await client.query(
    `INSERT INTO outbox_events
       (event_id, project_id, scenario_id, revision_id, event_type, aggregate_type, aggregate_id, payload,
        correlation_id, created_by)
     VALUES ($1, $2, $3, $4, 'facility.allocation.decided.v1', 'capacity_allocation', $5, $6::jsonb, $7, $8)`,
    [
      randomUUID(), projectId, scenarioId, revisionId, allocationId ?? request.requestId,
      JSON.stringify({
        demand_request_id: request.requestId,
        allocation_id: allocationId,
        budget_id: budgetId,
        resource_kind: request.resourceKind,
        state,
        delta,
      }),
      correlationId, actorId,
    ],
  );
}

function toRequestShape(row) {
  return {
    requestId: row.request_id,
    consumerType: row.consumer_type,
    consumerId: row.consumer_id,
    phaseId: row.phase_id,
    resourceKind: row.resource_kind,
    requestedValue: Number(row.requested_value),
    requestedUnit: row.requested_unit,
    requestedBasis: row.requested_basis,
    requestedState: row.requested_state,
    requiredFrom: row.required_from,
    priority: row.priority,
    createdAt: row.created_at,
  };
}

function toBudgetShape(row) {
  return {
    budgetId: row.budget_id,
    ownerEntityId: row.owner_entity_id,
    phaseId: row.phase_id,
    utilityInterfaceId: row.utility_interface_id,
    resourceKind: row.resource_kind,
    basis: row.basis,
    unit: row.unit,
    commissionedValue: Number(row.commissioned_value),
    plannedValue: Number(row.planned_value),
    reservedValue: Number(row.reserved_value),
    allocatedValue: Number(row.allocated_value),
    availableValue: Number(row.available_value),
    deratingFactor: Number(row.derating_factor),
  };
}

/**
 * Runs `fn` on the caller's transaction when one was supplied, and opens the
 * tenant-scoped transaction otherwise. The tool executor calls a handler inside a
 * tenant transaction already, so re-opening one there would both pay for a second
 * connection and, in a test that injected its fixture client, read a different
 * snapshot than the one the fixture is writing to.
 */
function inTenant(providedClient, pool, projectId, fn) {
  return providedClient ? fn(providedClient) : withTenant(pool, projectId, fn);
}

/** PROVISIONAL may be accepted or rejected; ACCEPTED may be revoked or expired. */
function assertTransition(from, to) {
  const allowed = from === 'PROVISIONAL' ? ['ACCEPTED', 'REJECTED'] : from === 'ACCEPTED' ? ['REVOKED', 'EXPIRED'] : [];
  if (!allowed.includes(to)) {
    throw new ApiError('ALLOCATION_TRANSITION_INVALID', `An allocation in state ${from} cannot become ${to}.`, {
      status: 409,
      details: [{ field: 'state', reason: 'invalid_transition', from, to, allowed }],
    });
  }
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
