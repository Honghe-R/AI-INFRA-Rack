import { randomUUID } from 'node:crypto';
import { defaultPolicyRegistry } from './policies.js';

/**
 * What every change kind shares: the two refusal shapes, the enumerated values the
 * store accepts, and the small checks that more than one kind needs.
 *
 * The refusals are separate types because the contract distinguishes them, and the
 * distinction is what a caller acts on:
 *
 *   * `ChangeRejected` — the change itself is malformed. `422`, with per-change
 *     diagnostics naming the field.
 *   * `ChangeConflict` — the change is well formed and the current graph refuses it:
 *     a duplicate budget, a phase dependency that would close a cycle, an entity
 *     something else still references. `409`, naming what it conflicts with.
 *
 * A third rule runs through every kind, and it is the one that keeps the
 * verification surface honest: **a structural requirement is refused, a domain
 * violation is accepted**. A capacity of zero is not rejected here — the catalog has
 * `facility.utility.source.negative_capacity` to report it, and a write path that
 * refused it would suppress a diagnostic. What is refused is what the store cannot
 * hold: a missing column, a value outside an enum, a reference that does not resolve.
 */

export class ChangeRejected extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ChangeRejected';
    this.details = details;
  }
}

export class ChangeConflict extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ChangeConflict';
    this.details = details;
  }
}

/* --------------------------------------------------------------- enumerations */

export const CONTAINER_KINDS = Object.freeze([
  'PARCEL',
  'BUILDING',
  'FLOOR',
  'HALL',
  'SUPPORT_SPACE',
  'EQUIPMENT_YARD',
  'RESERVED_AREA',
]);

export const GEOMETRY_TYPE = Object.freeze({
  BOUNDARY: 'POLYGON',
  FOOTPRINT: 'POLYGON',
  FLOOR_BOUNDARY: 'POLYGON',
  ROOM_BOUNDARY: 'POLYGON',
  CONNECTION_POINT: 'POINT',
  CONSTRAINT_AREA: 'POLYGON',
  ROUTE: 'LINESTRING',
  REFERENCE_POINT: 'POINT',
});

export const RESOURCE_KINDS = Object.freeze(['POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY']);
export const SUPPLY_STATES = Object.freeze(['CONTRACTUAL', 'FIRM', 'PLANNED', 'COMMISSIONED']);
export const SERVICE_STATES = Object.freeze(['AVAILABLE', 'PLANNED', 'SUSPENDED', 'RETIRED']);
export const QUANTITY_STATES = Object.freeze(['MEASURED', 'CONTRACTUAL', 'FIRM', 'PLANNED', 'COMMISSIONED', 'ASSUMED']);
export const CAPACITY_BASES = Object.freeze([
  'IT_LOAD',
  'FACILITY_INPUT',
  'HEAT_REJECTION',
  'WATER_FLOW',
  'USABLE_FLOOR_AREA',
  'NETWORK_ENTRY_COUNT',
  'FUEL_VOLUME',
  'AUTONOMY_DURATION',
]);
export const AVAILABILITY_POLICIES = Object.freeze(['N', 'N_PLUS_1', 'TWO_N', 'TWO_N_PLUS_1', 'N_PLUS_2']);
export const RESERVE_KINDS = Object.freeze(['FUEL', 'WATER']);
export const PHASE_STATUSES = Object.freeze([
  'PLANNED',
  'UNDER_CONSTRUCTION',
  'COMMISSIONING',
  'AVAILABLE',
  'RETIRED',
]);
export const CONSTRAINT_KINDS = Object.freeze([
  'SETBACK',
  'EASEMENT',
  'ACCESS_ROUTE',
  'HEIGHT_LIMIT',
  'HAZARD_ZONE',
  'EXCLUSION_ZONE',
  'REGULATORY_LIMIT',
]);
export const SEVERITIES = Object.freeze(['ERROR', 'WARNING', 'INFO']);
export const CONFIDENCES = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);
export const DOCUMENT_KINDS = Object.freeze([
  'CAD_DRAWING',
  'GIS_DATASET',
  'KML',
  'BIM_MODEL',
  'VENDOR_STUDY',
  'PERMIT',
  'SURVEY',
  'CONTACT_RECORD',
  'OTHER',
]);

/* -------------------------------------------------------------------- helpers */

/** A required scalar. Empty strings count as absent, which is how a form submits them. */
export function requireField(payload, field, label = field) {
  const value = payload?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ChangeRejected(`The change requires "${label}".`, { field: `payload.${field}`, reason: 'required' });
  }
  return value;
}

export function requireEnum(payload, field, allowed, label = field) {
  const value = requireField(payload, field, label);
  if (!allowed.includes(value)) {
    throw new ChangeRejected(`"${label}" is not one of the values this field accepts.`, {
      field: `payload.${field}`,
      reason: 'not_allowed',
      allowed: [...allowed],
      actual: value,
    });
  }
  return value;
}

/**
 * A required finite number.
 *
 * Sign and magnitude are deliberately unchecked: a negative capacity is a *finding*
 * (`facility.utility.source.negative_capacity`), and refusing it here would mean the
 * validator never gets to report it.
 */
export function requireNumber(payload, field, label = field) {
  const value = requireField(payload, field, label);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ChangeRejected(`"${label}" must be a number.`, {
      field: `payload.${field}`,
      reason: 'not_a_number',
      actual: value,
    });
  }
  return value;
}

export function optionalEnum(payload, field, allowed) {
  const value = payload?.[field];
  if (value === undefined || value === null || value === '') return null;
  if (!allowed.includes(value)) {
    throw new ChangeRejected(`"${field}" is not one of the values this field accepts.`, {
      field: `payload.${field}`,
      reason: 'not_allowed',
      allowed: [...allowed],
    });
  }
  return value;
}

/** The optional identity fields every upsert-style kind accepts. */
export function optionalId(payload, field) {
  const value = payload?.[field];
  return value === undefined || value === null || value === '' ? null : value;
}

export async function assertBelongsToRevision({ client, projectId, revisionId, table, idColumn, id, field }) {
  const { rows } = await client.query(
    `SELECT 1 FROM ${table} WHERE project_id = $1 AND revision_id = $2 AND ${idColumn} = $3`,
    [projectId, revisionId, id],
  );
  if (rows.length === 0) {
    throw new ChangeRejected(`The referenced ${field} does not belong to this revision.`, {
      field: `payload.${field}`,
      reason: 'not_found',
    });
  }
}

export async function resolveEntity({ client, projectId, revisionId, entityRef }) {
  if (!entityRef?.entity_id) {
    throw new ChangeRejected('The change requires an entity reference.', { field: 'entity_ref.entity_id', reason: 'required' });
  }
  const { rows } = await client.query(
    `SELECT entity_id, entity_type, status, display_name
       FROM entity_registry
      WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3`,
    [projectId, revisionId, entityRef.entity_id],
  );
  const entity = rows[0];
  if (!entity) {
    throw new ChangeRejected('The entity does not exist in this revision.', {
      field: 'entity_ref.entity_id',
      reason: 'not_found',
    });
  }
  if (entityRef.entity_type && entity.entity_type !== entityRef.entity_type) {
    throw new ChangeRejected('The entity exists but not with the declared type.', {
      field: 'entity_ref.entity_type',
      reason: 'type_mismatch',
      actual: entity.entity_type,
    });
  }
  return entity;
}

/**
 * Registers a new design object's stable identity.
 *
 * Every design object is an entity, and the registry is what lets it be referenced by
 * id from another change in the same set — or by a diagnostic later. The row and the
 * object are written together, so an identity without an object is not reachable.
 */
export async function registerEntity({
  client,
  projectId,
  scenarioId,
  revisionId,
  entityId,
  entityType,
  displayName,
  actorId,
}) {
  await client.query(
    `INSERT INTO entity_registry
       (entity_id, revision_id, project_id, scenario_id, entity_type, status, display_name, created_by)
     VALUES ($1, $2, $3, $4, $5, 'PROVISIONAL', $6, $7)`,
    [entityId, revisionId, projectId, scenarioId, entityType, displayName, actorId],
  );
}

/**
 * Walks a parent chain and refuses an edit that would close it.
 *
 * `facility.data.entity.parent_cycle` exists as a check, but a cycle is not a design
 * question to be reported later — it makes the hierarchy unreadable, so the write
 * refuses it and names the conflict.
 */
export async function assertNoParentCycle({ client, projectId, revisionId, table, idColumn, parentColumn, id, parentId, label }) {
  const seen = new Set();
  let cursor = parentId;
  while (cursor) {
    if (cursor === id) {
      throw new ChangeConflict(`That ${label} change would close a cycle in the hierarchy.`, {
        reason: 'cycle',
        entity_id: id,
        revisited_id: cursor,
      });
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await client.query(
      `SELECT ${parentColumn} AS parent FROM ${table} WHERE project_id = $1 AND revision_id = $2 AND ${idColumn} = $3`,
      [projectId, revisionId, cursor],
    );
    cursor = rows[0]?.parent ?? null;
  }
}

/**
 * Whether adding `predecessor -> successor` would close a phase cycle.
 *
 * A cycle exists when the new predecessor is already reachable from the new successor,
 * which one recursive walk answers without loading the whole edge set.
 */
export async function assertNoPhaseCycle({ client, projectId, revisionId, predecessorId, successorId }) {
  const { rows } = await client.query(
    `WITH RECURSIVE reach AS (
       SELECT successor_phase_id AS id
         FROM phase_dependencies
        WHERE project_id = $1 AND revision_id = $2 AND predecessor_phase_id = $3
       UNION
       SELECT d.successor_phase_id
         FROM phase_dependencies d
         JOIN reach r ON d.predecessor_phase_id = r.id
        WHERE d.project_id = $1 AND d.revision_id = $2
     )
     SELECT 1 FROM reach WHERE id = $4 LIMIT 1`,
    [projectId, revisionId, successorId, predecessorId],
  );
  if (rows.length > 0) {
    throw new ChangeConflict('That dependency would close a cycle in the phase plan.', {
      reason: 'cycle',
      predecessor_phase_id: predecessorId,
      successor_phase_id: successorId,
    });
  }
}

/**
 * A policy reference must be pinned and resolvable.
 *
 * The registry is the authority on what resolves, and a requirement or a waiver citing
 * a policy that resolves to nothing is not auditable. This is the same check the waiver
 * command makes, for the same reason.
 */
export function requirePinnedPolicy(policyId, field = 'policy_id') {
  const resolved = defaultPolicyRegistry.resolveReference(policyId);
  if (!resolved?.policy) {
    throw new ChangeRejected('The policy reference does not resolve.', {
      field: `payload.${field}`,
      reason: resolved?.reference?.version ? 'unknown_policy_version' : 'policy_reference_not_pinned',
      expected: 'policy_id@version',
      actual: policyId ?? null,
    });
  }
  return resolved;
}

/**
 * A time window must run forwards.
 *
 * Several tables carry this as a check constraint; a window that ends before it starts
 * is a malformed change, and the caller is better served by the rule than by the name of
 * the constraint that caught it.
 */
export function assertWindow({ from, to, fromField, toField, label }) {
  if (from && to && Date.parse(to) <= Date.parse(from)) {
    throw new ChangeRejected(`${label} must end after it starts.`, {
      field: `payload.${toField}`,
      reason: 'window_inverted',
      [`payload.${fromField}`]: from,
      [`payload.${toField}`]: to,
    });
  }
}

export function assertRange(value, { min, max, field }) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'number' || value < min || value > max) {
    throw new ChangeRejected(`"${field}" must be between ${min} and ${max}.`, {
      field: `payload.${field}`,
      reason: 'out_of_range',
      min,
      max,
      actual: value,
    });
  }
}

/** A new identity for an object the caller did not name. */
export function newId() {
  return randomUUID();
}
