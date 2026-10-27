import { RESOURCE_CAPABILITIES } from '../catalog.js';
import { decideAllocation, requestCapacityAllocation } from '../capacity.js';
import { defineTool } from './registry.js';
import { field } from './schema.js';

/**
 * The capacity action tools (T6).
 *
 * `request_capacity_allocation` is the operation the assistant surface declares and the
 * one the API's `capacity-requests` route serves. `decide_allocation` is the allocator's
 * accept/reject/revoke/expire; the API contract requires the route
 * (`POST .../allocations/{allocationId}`) but the tool-surface document's action table
 * omits it, so it is added here as a recorded delta rather than left as a route that
 * would have to re-assert a permission and emit its own audit record outside the one
 * choke point this surface exists to provide.
 *
 * Neither tool re-implements an allocation rule: both delegate to `../capacity.js`, which
 * owns D5 availability and D6 contention.
 */

const CONSUMER_TYPES = Object.freeze([
  'FLOORPLAN', 'RACK', 'POWER', 'THERMAL', 'NETWORK', 'CABLING', 'VERIFY', 'SIMULATION', 'COST_SCHEDULE', 'DEPLOYMENT',
]);

const CAPACITY_BASES = Object.freeze([
  'IT_LOAD', 'FACILITY_INPUT', 'HEAT_REJECTION', 'WATER_FLOW', 'USABLE_FLOOR_AREA',
  'NETWORK_ENTRY_COUNT', 'FUEL_VOLUME', 'AUTONOMY_DURATION',
]);

const QUANTITY_STATES = Object.freeze(['MEASURED', 'CONTRACTUAL', 'FIRM', 'PLANNED', 'COMMISSIONED', 'ASSUMED']);

const PRIORITIES = Object.freeze(['RESERVED', 'CRITICAL', 'HIGH', 'NORMAL', 'LOW']);

const DECISIONS = Object.freeze(['ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED']);

export function createCapacityTools({ logger = null } = {}) {
  const requestCapacity = defineTool({
    name: 'request_capacity_allocation',
    axis: 'ACTION',
    access: 'write',
    description:
      'Submit a downstream capacity demand request and answer it with a PROVISIONAL allocation, or a REJECTED decision with the reason. Competing requests are ordered by the documented contention order (D6) and a tie is refused rather than resolved.',
    stores: ['budgets', 'allocations', 'demand'],
    remediation: ['UPDATE_CAPACITY'],
    requiredFunctions: ['facility.capacity.request'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      // Deliberately not `required`: a missing precondition must reach the domain
      // guard and answer `428 REVISION_ETAG_REQUIRED`, which is the documented
      // concurrency failure, rather than a generic 400 argument error.
      base_revision_id: field.uuid(),
      etag: field.string(),
      consumer_type: field.enum(CONSUMER_TYPES, { required: true }),
      consumer_id: field.uuid({ required: true }),
      phase_id: field.uuid({ required: true }),
      resource_kind: field.enum(RESOURCE_CAPABILITIES, { required: true }),
      requested_capacity: field.object({
        required: true,
        fields: {
          value: field.number({ required: true }),
          unit: field.string({ required: true }),
          basis: field.enum(CAPACITY_BASES, { required: true }),
          state: field.enum(QUANTITY_STATES, { default: 'PLANNED' }),
        },
      }),
      required_from: field.timestamp({ required: true }),
      priority: field.enum(PRIORITIES, { default: 'NORMAL' }),
    },
    handler: async ({ client, args, context }) =>
      requestCapacityAllocation({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        actorId: context.userId ?? null,
        correlationId: context.correlationId ?? null,
        consumerType: args.consumer_type,
        consumerId: args.consumer_id,
        phaseId: args.phase_id,
        resourceKind: args.resource_kind,
        requestedCapacity: args.requested_capacity,
        requiredFrom: args.required_from,
        priority: args.priority,
        baseRevisionId: args.base_revision_id,
        etag: args.etag,
        logger,
      }),
  });

  const decide = defineTool({
    name: 'decide_allocation',
    axis: 'ACTION',
    access: 'write',
    description:
      'Accept, reject, revoke, or expire one capacity allocation. Only an ACCEPTED allocation reduces a budget’s available capacity, and the budget is recomputed in the same transaction.',
    stores: ['budgets', 'allocations'],
    remediation: ['UPDATE_CAPACITY'],
    requiredFunctions: ['facility.capacity.allocate'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      base_revision_id: field.uuid(),
      etag: field.string(),
      allocation_id: field.uuid({ required: true }),
      state: field.enum(DECISIONS, { required: true }),
      comment: field.string({ maxLength: 2048 }),
    },
    handler: async ({ client, args, context }) =>
      decideAllocation({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        allocationId: args.allocation_id,
        state: args.state,
        comment: args.comment ?? null,
        actorId: context.userId ?? null,
        correlationId: context.correlationId ?? null,
        baseRevisionId: args.base_revision_id,
        etag: args.etag,
        logger,
      }),
  });

  return [requestCapacity, decide];
}
