import { randomUUID } from 'node:crypto';
import { ApiError } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { TransformError, normalizeSelector, resolveTransform } from '@ai-infra/imports';
import { REVIEW_STATES } from './asset-bindings.js';
import { requireDraft } from './etags.js';
import { projectStore } from './tools/mappers.js';

/**
 * Spatial transforms and import mappings (T3).
 *
 * The schema has carried `spatial_transforms` and `import_mappings` since the first
 * migration and the three `facility.import.*` checks have read them since T4, but
 * nothing wrote either table. This module is the authoring half of the import
 * mapping layer; `import-apply.js` is the normalizing half.
 *
 * The workspace framework (doc/workspace/import-adapters.md) and this tool's
 * specialization (doc/tools/site-and-facility/import-adapters.md) split the work
 * cleanly: the framework owns adapters, extraction, and CRS resolution, and this
 * tool owns what the extracted content *means*. Two consequences shape this file:
 *
 *   * The transform method the framework names and the method the store accepts are
 *     different vocabularies. The framework speaks in what the fit *is*
 *     (`SIMILARITY_2D`, `AFFINE_2D`, `HELMERT_7_PARAM`); the store speaks in what the
 *     evidence *is* (`CONTROL_POINTS_AFFINE`, `FITTED_RESIDUAL`, `DECLARED_CRS`).
 *     `toTransformMethod` is the one translation, exported so the delta is a fact in
 *     code rather than a comment someone has to rediscover.
 *   * Authority is graduated. A transform or mapping is created `UNREVIEWED` and only
 *     a reviewer moves it. Nothing here writes a design entity; apply is the only
 *     command that does, and it lives next door.
 *
 * The geometry-bearing target table is the other contract this file owns. It is a
 * literal transcription of "Target Entity Types and Geometry Roles"
 * (import-adapters.md) so a mapping cannot declare `BUILDING / BOUNDARY` and only
 * discover the mismatch when a check reports it.
 *
 * [D1]: ../../doc/tools/site-and-facility/decisions.md
 */

/* ------------------------------------------------------------------ the tables */

/**
 * The target entity-type to allowed geometry-role pairing (import-adapters.md,
 * "Target Entity Types and Geometry Roles").
 *
 * An empty array means "attribute-only": the type carries no geometry and a mapping
 * that declares a role for it is a mismatch, not a refinement. `DOCUMENT` is the one
 * optional role, which is why the table alone is not enough to decide whether a role
 * is *required*; `requiresGeometryRole` answers that.
 */
export const ENTITY_GEOMETRY_ROLES = Object.freeze({
  SITE: Object.freeze(['BOUNDARY']),
  PARCEL: Object.freeze(['BOUNDARY']),
  BUILDING: Object.freeze(['FOOTPRINT']),
  FLOOR: Object.freeze(['FLOOR_BOUNDARY']),
  HALL: Object.freeze(['FLOOR_BOUNDARY', 'ROOM_BOUNDARY']),
  SUPPORT_SPACE: Object.freeze(['ROOM_BOUNDARY']),
  EQUIPMENT_YARD: Object.freeze(['BOUNDARY', 'FOOTPRINT']),
  RESERVED_AREA: Object.freeze(['BOUNDARY']),
  UTILITY_SOURCE: Object.freeze(['CONNECTION_POINT']),
  UTILITY_INTERFACE: Object.freeze(['CONNECTION_POINT']),
  UTILITY_ROUTE: Object.freeze(['ROUTE']),
  SPATIAL_CONSTRAINT: Object.freeze(['CONSTRAINT_AREA']),
  ENVIRONMENTAL_PROFILE: Object.freeze([]),
  ENVIRONMENTAL_CONSTRAINT: Object.freeze(['CONSTRAINT_AREA']),
  FACILITY_PHASE: Object.freeze([]),
  FAILURE_DOMAIN: Object.freeze([]),
  RESILIENCE_REQUIREMENT: Object.freeze([]),
  FUEL_STORAGE: Object.freeze(['BOUNDARY', 'FOOTPRINT']),
  WATER_STORAGE: Object.freeze(['BOUNDARY', 'FOOTPRINT']),
  CAPACITY_BUDGET: Object.freeze([]),
  ASSUMPTION: Object.freeze([]),
  WAIVER: Object.freeze([]),
  DOCUMENT: Object.freeze(['REFERENCE_POINT']),
});

/** Types whose role is genuinely optional: the only one today is `DOCUMENT`. */
const OPTIONAL_GEOMETRY_ROLES = Object.freeze(['DOCUMENT']);

export const MAPPING_CARDINALITIES = Object.freeze(['ONE_TO_ONE', 'ONE_TO_MANY']);

export function allowedGeometryRoles(targetEntityType) {
  return ENTITY_GEOMETRY_ROLES[targetEntityType] ?? null;
}

/** A type that must declare exactly one allowed role to be meaningful. */
export function requiresGeometryRole(targetEntityType) {
  const allowed = allowedGeometryRoles(targetEntityType);
  return Array.isArray(allowed) && allowed.length > 0 && !OPTIONAL_GEOMETRY_ROLES.includes(targetEntityType);
}

/**
 * Validates one `target_entity_type` / `target_geometry_role` pair and returns the
 * role to store. Pure, so the tool layer and a caller can ask the same question
 * without a transaction.
 */
export function resolveGeometryRole(targetEntityType, targetGeometryRole = null) {
  const allowed = allowedGeometryRoles(targetEntityType);
  if (!allowed) {
    throw new ApiError('VALIDATION_FAILED', 'The target entity type is not a facility entity type.', {
      status: 422,
      details: [{ field: 'target_entity_type', reason: 'not_allowed', actual: targetEntityType }],
    });
  }
  const role = targetGeometryRole ?? null;
  if (role !== null && !allowed.includes(role)) {
    throw new ApiError('VALIDATION_FAILED', 'The geometry role is not one this target entity type accepts.', {
      status: 422,
      details: [
        {
          field: 'target_geometry_role',
          reason: allowed.length === 0 ? 'not_a_geometry_type' : 'not_allowed_for_type',
          actual: role,
          allowed,
          constraint_id: 'facility.data.geometry.type_mismatch',
        },
      ],
    });
  }
  if (role === null && requiresGeometryRole(targetEntityType)) {
    throw new ApiError('VALIDATION_FAILED', 'A geometry-bearing mapping must declare exactly one geometry role.', {
      status: 422,
      details: [
        {
          field: 'target_geometry_role',
          reason: 'role_missing',
          allowed,
          constraint_id: 'facility.data.geometry.role_missing',
        },
      ],
    });
  }
  return role;
}

/* ---------------------------------------------------------- transform methods */

/** The workspace framework's vocabulary (import-adapters.md, "Transform Methods"). */
export const W4_TRANSFORM_METHODS = Object.freeze([
  'IDENTITY',
  'UNIT_SCALE',
  'SIMILARITY_2D',
  'AFFINE_2D',
  'HELMERT_7_PARAM',
  'PROJECTION_CHANGE',
  'CONTROL_POINT_LOCAL',
]);

/** The store's vocabulary (`CREATE TYPE transform_method`). */
export const TRANSFORM_METHODS = Object.freeze([
  'DECLARED_CRS',
  'CONTROL_POINTS_HELMERT',
  'CONTROL_POINTS_AFFINE',
  'FITTED_RESIDUAL',
  'MANUAL',
]);

/**
 * The documented delta: the framework names a *fit*, the store names the *evidence*
 * that justifies it. `SIMILARITY_2D` and `CONTROL_POINT_LOCAL` both produce a fitted
 * residual, so both land on `FITTED_RESIDUAL`; a bare CRS declaration and a
 * projection change both rely on the declared CRS, so both land on `DECLARED_CRS`.
 * `MANUAL` is the store's escape hatch and has no framework counterpart.
 */
export const W4_TO_TRANSFORM_METHOD = Object.freeze({
  IDENTITY: 'DECLARED_CRS',
  UNIT_SCALE: 'DECLARED_CRS',
  PROJECTION_CHANGE: 'DECLARED_CRS',
  HELMERT_7_PARAM: 'CONTROL_POINTS_HELMERT',
  AFFINE_2D: 'CONTROL_POINTS_AFFINE',
  SIMILARITY_2D: 'FITTED_RESIDUAL',
  CONTROL_POINT_LOCAL: 'FITTED_RESIDUAL',
});

export function toTransformMethod(w4Method) {
  const stored = W4_TO_TRANSFORM_METHOD[w4Method];
  if (!stored) {
    throw new ApiError('VALIDATION_FAILED', 'The transform method is not one the workspace framework defines.', {
      status: 422,
      details: [
        {
          field: 'method',
          reason: 'not_allowed',
          actual: w4Method ?? null,
          allowed: [...W4_TRANSFORM_METHODS],
        },
      ],
    });
  }
  return stored;
}

/* -------------------------------------------------------------------- helpers */

const TRANSFORM_COLUMNS = `
  transform_id, binding_id, asset_version_id, source_units, target_units, source_crs, target_crs,
  vertical_crs, method, control_points, residual_error_m, review_state, reviewer_id, reviewed_at`;

const MAPPING_COLUMNS = `
  mapping_id, binding_id, asset_version_id, transform_id, source_selector, target_entity_type,
  target_geometry_role, attribute_mapping, cardinality, required, review_state, reviewer_id, reviewed_at`;

function fieldError(field, reason, extra = {}) {
  return new ApiError('VALIDATION_FAILED', `The field ${field} is not valid.`, {
    status: 422,
    details: [{ field, reason, ...extra }],
  });
}

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw fieldError(field, 'not_allowed', { allowed: [...allowed], actual: value ?? null });
  return value;
}

function required(value, field) {
  if (value === undefined || value === null || value === '') throw fieldError(field, 'required');
  return value;
}

function inTenant(providedClient, pool, projectId, fn) {
  if (!providedClient && !pool) throw new Error('An import authoring command requires a database pool or client.');
  return providedClient ? fn(providedClient) : withTenant(pool, projectId, fn);
}

/**
 * The binding this transform or mapping hangs off, validated inside the writing
 * transaction. `asset_version_id` is deliberately not a foreign key in this tool's
 * schema (the asset layer is a different bounded context), so the reference is
 * resolved here rather than trusted.
 */
async function requireBinding({ client, projectId, revisionId, bindingId }) {
  const { rows } = await client.query(
    `SELECT binding_id, asset_version_id, representation_id, transform_id, role, status
       FROM asset_bindings
      WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3`,
    [projectId, revisionId, bindingId],
  );
  if (!rows[0]) throw fieldError('binding_id', 'not_found', { value: bindingId });
  return rows[0];
}

function isPair(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
}

/** Control points are stored verbatim but shaped: a source and a target pair. */
function normalizeControlPoints(controlPoints) {
  if (!Array.isArray(controlPoints)) throw fieldError('control_points', 'not_an_array');
  return controlPoints.map((point, index) => {
    if (!isPair(point?.source) || !isPair(point?.target)) {
      throw fieldError(`control_points[${index}]`, 'needs_source_and_target_pairs', {
        expected: '{ source: [x, y], target: [x, y] }',
      });
    }
    return {
      ...point,
      source: [Number(point.source[0]), Number(point.source[1])],
      target: [Number(point.target[0]), Number(point.target[1])],
    };
  });
}

/**
 * Resolves the requested method to the store's method plus its parameters.
 *
 * The method may be named in either vocabulary: a workspace method is resolved
 * through `resolveTransform` (the framework is the authority on what evidence a fit
 * needs), and a stored method is mapped back to its framework equivalent first.
 * `DECLARED_CRS` and `MANUAL` are declaration-only and never fitted.
 */
function resolveTransformMethod({ method, sourceCrs, targetCrs, sourceUnits, targetUnits, controlPoints }) {
  if (!W4_TRANSFORM_METHODS.includes(method) && !TRANSFORM_METHODS.includes(method)) {
    throw fieldError('method', 'not_allowed', {
      actual: method ?? null,
      allowed: [...W4_TRANSFORM_METHODS, ...TRANSFORM_METHODS],
    });
  }

  if (TRANSFORM_METHODS.includes(method)) {
    // `DECLARED_CRS` and `MANUAL` are declaration-only: they carry no fit and no
    // residual, and the store does not require one for them.
    if (method === 'DECLARED_CRS' || method === 'MANUAL') return { storedMethod: method, resolved: null };
    // FITTED_RESIDUAL: the store does not say which fit, so the control points do.
    const w4 = method === 'FITTED_RESIDUAL'
      ? (controlPoints.length >= 3 ? 'AFFINE_2D' : 'SIMILARITY_2D')
      : method === 'CONTROL_POINTS_HELMERT'
        ? 'HELMERT_7_PARAM'
        : method === 'CONTROL_POINTS_AFFINE'
          ? 'AFFINE_2D'
          : null;
    if (w4 === null) throw fieldError('method', 'not_allowed', { actual: method });
    return { storedMethod: method, resolved: fitOrRefuse({ method: w4, sourceCrs, targetCrs, sourceUnits, targetUnits, controlPoints }) };
  }

  const resolved = fitOrRefuse({ method, sourceCrs, targetCrs, sourceUnits, targetUnits, controlPoints });
  return { storedMethod: toTransformMethod(method), resolved };
}

function fitOrRefuse({ method, sourceCrs, targetCrs, sourceUnits, targetUnits, controlPoints }) {
  try {
    return resolveTransform({ method, sourceCrs, targetCrs, sourceUnits, targetUnits, controlPoints });
  } catch (error) {
    if (error instanceof TransformError) {
      // The framework's refusal is a real 422 with a documented constraint id; the
      // tool does not re-word it, because the identifier is what a client branches on.
      throw new ApiError('IMPORT_TRANSFORM_INVALID', error.message, {
        status: 422,
        details: [{ constraint_id: error.constraintId, method, ...(error.details?.[0] ?? {}) }],
      });
    }
    throw error;
  }
}

function transformShape(row) {
  return {
    transformId: row.transform_id,
    bindingId: row.binding_id,
    assetVersionId: row.asset_version_id,
    sourceUnits: row.source_units,
    targetUnits: row.target_units,
    sourceCrs: row.source_crs,
    targetCrs: row.target_crs,
    verticalCrs: row.vertical_crs,
    method: row.method,
    controlPoints: row.control_points ?? [],
    residualErrorM: row.residual_error_m === null ? null : Number(row.residual_error_m),
    reviewState: row.review_state,
    reviewerId: row.reviewer_id,
    reviewedAt: row.reviewed_at,
  };
}

/**
 * A mapping row in the surface's shape.
 *
 * `projectStore('mappings', ...)` deliberately exposes the review-relevant fields
 * only; apply also needs the attribute mapping and the reviewer, so this one shape
 * is used everywhere a mapping is returned rather than two shapes that could drift.
 */
function mappingShape(row) {
  return {
    mappingId: row.mapping_id,
    bindingId: row.binding_id,
    assetVersionId: row.asset_version_id,
    transformId: row.transform_id,
    sourceSelector: row.source_selector,
    targetEntityType: row.target_entity_type,
    targetGeometryRole: row.target_geometry_role,
    attributeMapping: row.attribute_mapping ?? {},
    cardinality: row.cardinality,
    required: row.required,
    reviewState: row.review_state,
    reviewerId: row.reviewer_id,
    reviewedAt: row.reviewed_at,
  };
}

/* ------------------------------------------------------ create/review: transform */

/**
 * Declares a transform from a source representation into the project CRS.
 *
 * The schema has two checks that a caller should never see as a constraint name, so
 * both are answered here first: a transform needs a declared source CRS or at least
 * two control points, and a fitted transform needs a residual. The row is written
 * `UNREVIEWED` because a transform is provisional until a reviewer accepts it
 * (import-adapters.md, "Authority Model in This Tool").
 */
export async function createSpatialTransform({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  actorId = null,
  bindingId,
  sourceUnits,
  targetUnits,
  sourceCrs = null,
  targetCrs,
  verticalCrs = null,
  method,
  controlPoints = [],
} = {}) {
  required(sourceUnits, 'source_units');
  required(targetUnits, 'target_units');
  required(targetCrs, 'target_crs');
  required(method, 'method');
  const points = normalizeControlPoints(controlPoints);

  return inTenant(providedClient, pool, projectId, async (client) => {
    const revision = await requireDraft({ client, projectId, revisionId });
    const binding = await requireBinding({ client, projectId, revisionId, bindingId });

    // The store's `spatial_transforms_source_crs_check`, answered with the rule.
    if (!sourceCrs && points.length < 2) {
      throw new ApiError('IMPORT_TRANSFORM_INVALID', 'A transform needs a declared source CRS or at least two control points.', {
        status: 422,
        details: [
          {
            constraint_id: 'import.transform.control_points_insufficient',
            field: 'source_crs',
            reason: 'required_without_control_points',
            control_points: points.length,
          },
        ],
      });
    }

    const { storedMethod, resolved } = resolveTransformMethod({
      method,
      sourceCrs,
      targetCrs,
      sourceUnits,
      targetUnits,
      controlPoints: points,
    });
    const residualErrorM = resolved?.residualErrorM ?? null;

    // The store's `spatial_transforms_residual_check`, answered with the rule.
    if (storedMethod === 'FITTED_RESIDUAL' && residualErrorM === null) {
      throw new ApiError('IMPORT_TRANSFORM_INVALID', 'A fitted transform requires a computed residual error.', {
        status: 422,
        details: [
          {
            constraint_id: 'spatial_transforms_residual_check',
            field: 'residual_error_m',
            reason: 'required_for_fitted_method',
            method: storedMethod,
          },
        ],
      });
    }

    const transformId = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO spatial_transforms
         (transform_id, project_id, scenario_id, revision_id, binding_id, asset_version_id, source_units,
          target_units, source_crs, target_crs, vertical_crs, method, control_points, residual_error_m,
          review_state, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, 'UNREVIEWED', $15)
       RETURNING ${TRANSFORM_COLUMNS}`,
      [
        transformId, projectId, revision.scenario_id, revisionId, bindingId, binding.asset_version_id,
        sourceUnits, targetUnits, sourceCrs ?? null, targetCrs, verticalCrs ?? null, storedMethod,
        JSON.stringify(points), residualErrorM, actorId,
      ],
    );

    return {
      ...transformShape(rows[0]),
      // The framework method the caller named is part of the answer: the stored enum
      // is coarser than the request and a client should see both, not a silent collapse.
      requestedMethod: method,
      w4Method: W4_TRANSFORM_METHODS.includes(method) ? method : resolved?.method ?? null,
      parameters: resolved?.parameters ?? null,
      requiresProvider: resolved?.requiresProvider ?? false,
      diagnostics: resolved?.diagnostics ?? [],
      // The caller can see whether the fit needs a geodetic provider before it tries
      // to normalize anything.
      effect:
        'The transform is recorded UNREVIEWED. Review it before any mapping that depends on it may be applied.',
    };
  });
}

/**
 * Updates the parts of a transform a reviewer is allowed to change.
 *
 * import-adapters.md is explicit: "Any edit to units, CRS, method, or control points
 * MUST return `review_state` to `UNREVIEWED`." The reset lives here, in the only
 * command that can make such an edit, so there is no second path that forgets it.
 */
export async function updateSpatialTransform({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  actorId = null,
  transformId,
  sourceUnits,
  targetUnits,
  sourceCrs,
  targetCrs,
  verticalCrs,
  method,
  controlPoints,
} = {}) {
  required(transformId, 'transform_id');
  return inTenant(providedClient, pool, projectId, async (client) => {
    await requireDraft({ client, projectId, revisionId });
    const current = (
      await client.query(
        `SELECT ${TRANSFORM_COLUMNS} FROM spatial_transforms
          WHERE project_id = $1 AND revision_id = $2 AND transform_id = $3 FOR UPDATE`,
        [projectId, revisionId, transformId],
      )
    ).rows[0];
    if (!current) throw fieldError('transform_id', 'not_found', { value: transformId });

    const next = {
      sourceUnits: sourceUnits ?? current.source_units,
      targetUnits: targetUnits ?? current.target_units,
      sourceCrs: sourceCrs === undefined ? current.source_crs : sourceCrs,
      targetCrs: targetCrs ?? current.target_crs,
      verticalCrs: verticalCrs === undefined ? current.vertical_crs : verticalCrs,
      method: method ?? current.method,
      controlPoints: controlPoints === undefined ? current.control_points ?? [] : controlPoints,
    };
    const points = normalizeControlPoints(next.controlPoints);
    if (!next.sourceCrs && points.length < 2) {
      throw new ApiError('IMPORT_TRANSFORM_INVALID', 'A transform needs a declared source CRS or at least two control points.', {
        status: 422,
        details: [{ constraint_id: 'import.transform.control_points_insufficient', field: 'source_crs', reason: 'required_without_control_points' }],
      });
    }
    const { storedMethod, resolved } = resolveTransformMethod({ ...next, controlPoints: points });
    const residualErrorM = resolved?.residualErrorM ?? null;
    if (storedMethod === 'FITTED_RESIDUAL' && residualErrorM === null) {
      throw new ApiError('IMPORT_TRANSFORM_INVALID', 'A fitted transform requires a computed residual error.', {
        status: 422,
        details: [{ constraint_id: 'spatial_transforms_residual_check', field: 'residual_error_m', reason: 'required_for_fitted_method' }],
      });
    }

    const { rows } = await client.query(
      `UPDATE spatial_transforms
          SET source_units = $4, target_units = $5, source_crs = $6, target_crs = $7, vertical_crs = $8,
              method = $9, control_points = $10::jsonb, residual_error_m = $11,
              review_state = 'UNREVIEWED', reviewer_id = NULL, reviewed_at = NULL,
              updated_at = now(), updated_by = $12
        WHERE project_id = $1 AND revision_id = $2 AND transform_id = $3
      RETURNING ${TRANSFORM_COLUMNS}`,
      [
        projectId, revisionId, transformId, next.sourceUnits, next.targetUnits, next.sourceCrs, next.targetCrs,
        next.verticalCrs, storedMethod, JSON.stringify(points), residualErrorM, actorId,
      ],
    );
    return {
      ...transformShape(rows[0]),
      w4Method: resolved?.method ?? null,
      parameters: resolved?.parameters ?? null,
      requiresProvider: resolved?.requiresProvider ?? false,
      diagnostics: resolved?.diagnostics ?? [],
      effect: 'The edit returned the transform to UNREVIEWED; review it again before applying its mappings.',
    };
  });
}

/**
 * The reviewer's decision over one transform.
 *
 * The store requires a reviewer whenever `reviewed_at` is set, so the two move
 * together: a decision by an identified reviewer records both, and a reset records
 * neither.
 */
export async function reviewSpatialTransform({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  actorId = null,
  transformId,
  reviewState,
  comment = null,
} = {}) {
  required(transformId, 'transform_id');
  assertEnum(reviewState, REVIEW_STATES, 'review_state');
  return inTenant(providedClient, pool, projectId, async (client) => {
    await requireDraft({ client, projectId, revisionId });
    const reviewed = reviewState === 'UNREVIEWED';
    const { rows } = await client.query(
      `UPDATE spatial_transforms
          SET review_state = $4, reviewer_id = $5, reviewed_at = $6, updated_at = now(), updated_by = $5
        WHERE project_id = $1 AND revision_id = $2 AND transform_id = $3
      RETURNING ${TRANSFORM_COLUMNS}`,
      [projectId, revisionId, transformId, reviewState, reviewed ? null : actorId, reviewed ? null : new Date()],
    );
    if (!rows[0]) throw fieldError('transform_id', 'not_found', { value: transformId });
    return {
      ...transformShape(rows[0]),
      comment: comment ?? null,
      authoritative: reviewState === 'REVIEWED',
      effect:
        reviewState === 'REVIEWED'
          ? 'The transform is REVIEWED; mappings that reference it may be applied.'
          : `The transform review state is ${reviewState}.`,
    };
  });
}

/* -------------------------------------------------------- create/review: mapping */

/**
 * Declares one mapping rule from selected source content to a facility entity type
 * and geometry role.
 *
 * The selector is normalized with the framework's own serializer so the stored
 * string is the one the preview, apply, and re-import paths all evaluate. The
 * entity/role pairing is validated against `ENTITY_GEOMETRY_ROLES` and the
 * `(asset_version_id, source_selector, revision_id)` uniqueness key is answered with
 * a 409 naming the existing mapping rather than a raw constraint name.
 */
export async function createImportMapping({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  actorId = null,
  bindingId,
  transformId,
  sourceSelector,
  targetEntityType,
  targetGeometryRole = null,
  attributeMapping = {},
  cardinality = 'ONE_TO_ONE',
  required: isRequired = false,
} = {}) {
  required(sourceSelector, 'source_selector');
  required(targetEntityType, 'target_entity_type');
  assertEnum(cardinality, MAPPING_CARDINALITIES, 'cardinality');

  return inTenant(providedClient, pool, projectId, async (client) => {
    const revision = await requireDraft({ client, projectId, revisionId });
    const binding = await requireBinding({ client, projectId, revisionId, bindingId });
    const role = resolveGeometryRole(targetEntityType, targetGeometryRole);

    // The transform must belong to the same binding; a mapping that names another
    // binding's transform is a cross-source rule, which the model does not express.
    const transform = (
      await client.query(
        `SELECT transform_id, binding_id FROM spatial_transforms
          WHERE project_id = $1 AND revision_id = $2 AND transform_id = $3`,
        [projectId, revisionId, transformId],
      )
    ).rows[0];
    if (!transform) throw fieldError('transform_id', 'not_found', { value: transformId });
    if (transform.binding_id !== bindingId) {
      throw fieldError('transform_id', 'not_of_binding', { value: transformId, binding_id: bindingId });
    }

    let normalized;
    try {
      normalized = normalizeSelector(sourceSelector);
    } catch (error) {
      throw new ApiError('IMPORT_SELECTOR_INVALID', error.message, {
        status: 422,
        details: [{ field: 'source_selector', reason: 'invalid_selector', code: error.code ?? null }],
      });
    }

    const duplicate = (
      await client.query(
        `SELECT mapping_id FROM import_mappings
          WHERE project_id = $1 AND revision_id = $2 AND asset_version_id = $3 AND source_selector = $4`,
        [projectId, revisionId, binding.asset_version_id, normalized],
      )
    ).rows[0];
    if (duplicate) {
      throw new ApiError('CONFLICT', 'A mapping for that selector already exists on this asset version.', {
        status: 409,
        details: [
          {
            field: 'source_selector',
            reason: 'duplicate_selector',
            existing_mapping_id: duplicate.mapping_id,
            asset_version_id: binding.asset_version_id,
          },
        ],
      });
    }

    const mappingId = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO import_mappings
         (mapping_id, project_id, scenario_id, revision_id, binding_id, asset_version_id, transform_id,
          source_selector, target_entity_type, target_geometry_role, attribute_mapping, cardinality, required,
          review_state, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, 'UNREVIEWED', $14)
       RETURNING ${MAPPING_COLUMNS}`,
      [
        mappingId, projectId, revision.scenario_id, revisionId, bindingId, binding.asset_version_id, transformId,
        normalized, targetEntityType, role, JSON.stringify(attributeMapping ?? {}), cardinality, isRequired === true, actorId,
      ],
    );

    return {
      ...mappingShape(rows[0]),
      effect: 'The mapping is recorded UNREVIEWED. A reviewer must accept it before apply may normalize anything from it.',
    };
  });
}

/**
 * Updates a mapping's rule and returns it to `UNREVIEWED`.
 *
 * A reviewed mapping that was quietly edited would let an unreviewed selector apply,
 * so every content edit resets the review fields — the same rule the transform edit
 * obeys, and the reason the review state is not a field a client may patch directly.
 */
export async function updateImportMapping({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  actorId = null,
  mappingId,
  sourceSelector,
  targetEntityType,
  targetGeometryRole,
  attributeMapping,
  cardinality,
  required: isRequired,
} = {}) {
  required(mappingId, 'mapping_id');
  return inTenant(providedClient, pool, projectId, async (client) => {
    await requireDraft({ client, projectId, revisionId });
    const current = (
      await client.query(
        `SELECT ${MAPPING_COLUMNS} FROM import_mappings
          WHERE project_id = $1 AND revision_id = $2 AND mapping_id = $3 FOR UPDATE`,
        [projectId, revisionId, mappingId],
      )
    ).rows[0];
    if (!current) throw fieldError('mapping_id', 'not_found', { value: mappingId });

    const nextCardinality = cardinality ?? current.cardinality;
    assertEnum(nextCardinality, MAPPING_CARDINALITIES, 'cardinality');
    const nextType = targetEntityType ?? current.target_entity_type;
    const role = resolveGeometryRole(
      nextType,
      targetGeometryRole === undefined ? current.target_geometry_role : targetGeometryRole,
    );
    let normalized = current.source_selector;
    if (sourceSelector !== undefined) {
      try {
        normalized = normalizeSelector(sourceSelector);
      } catch (error) {
        throw new ApiError('IMPORT_SELECTOR_INVALID', error.message, {
          status: 422,
          details: [{ field: 'source_selector', reason: 'invalid_selector', code: error.code ?? null }],
        });
      }
      const duplicate = (
        await client.query(
          `SELECT mapping_id FROM import_mappings
            WHERE project_id = $1 AND revision_id = $2 AND asset_version_id = $3 AND source_selector = $4
              AND mapping_id <> $5`,
          [projectId, revisionId, current.asset_version_id, normalized, mappingId],
        )
      ).rows[0];
      if (duplicate) {
        throw new ApiError('CONFLICT', 'A mapping for that selector already exists on this asset version.', {
          status: 409,
          details: [{ field: 'source_selector', reason: 'duplicate_selector', existing_mapping_id: duplicate.mapping_id }],
        });
      }
    }

    const { rows } = await client.query(
      `UPDATE import_mappings
          SET source_selector = $4, target_entity_type = $5, target_geometry_role = $6,
              attribute_mapping = $7::jsonb, cardinality = $8, required = $9,
              review_state = 'UNREVIEWED', reviewer_id = NULL, reviewed_at = NULL,
              updated_at = now(), updated_by = $10
        WHERE project_id = $1 AND revision_id = $2 AND mapping_id = $3
      RETURNING ${MAPPING_COLUMNS}`,
      [
        projectId, revisionId, mappingId, normalized, nextType, role,
        JSON.stringify(attributeMapping ?? current.attribute_mapping ?? {}), nextCardinality,
        isRequired === undefined ? current.required : isRequired === true, actorId,
      ],
    );
    return {
      ...mappingShape(rows[0]),
      effect: 'The edit returned the mapping to UNREVIEWED; review it again before applying it.',
    };
  });
}

/**
 * The reviewer's decision over one mapping.
 *
 * `reviewed_at` and `reviewer_id` move together because the store's check requires a
 * reviewer whenever the time is recorded. A review that carries no actor records the
 * state and nothing else rather than fabricating a reviewer.
 */
export async function reviewImportMapping({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  actorId = null,
  mappingId,
  reviewState,
  comment = null,
} = {}) {
  required(mappingId, 'mapping_id');
  assertEnum(reviewState, REVIEW_STATES, 'review_state');
  return inTenant(providedClient, pool, projectId, async (client) => {
    await requireDraft({ client, projectId, revisionId });
    const reviewed = reviewState === 'UNREVIEWED';
    const { rows } = await client.query(
      `UPDATE import_mappings
          SET review_state = $4, reviewer_id = $5, reviewed_at = $6, updated_at = now(), updated_by = $5
        WHERE project_id = $1 AND revision_id = $2 AND mapping_id = $3
      RETURNING ${MAPPING_COLUMNS}`,
      [projectId, revisionId, mappingId, reviewState, reviewed ? null : actorId, reviewed ? null : new Date()],
    );
    if (!rows[0]) throw fieldError('mapping_id', 'not_found', { value: mappingId });
    return {
      ...mappingShape(rows[0]),
      comment: comment ?? null,
      effect:
        reviewState === 'REVIEWED'
          ? 'The mapping is REVIEWED and may be applied.'
          : `The mapping review state is ${reviewState}.`,
    };
  });
}

/* ------------------------------------------------------------------- read model */

/**
 * Everything a caller needs to see after choosing a binding: the binding, its
 * transform, its mappings, the feature counts it has produced, and the latest import
 * report. One read, because a UI that assembled this from five calls would show five
 * different moments of the same import.
 */
export async function loadBindingDetail({ pool = null, client: providedClient = null, projectId, revisionId, bindingId } = {}) {
  required(bindingId, 'binding_id');
  return inTenant(providedClient, pool, projectId, async (client) => {
    const binding = (
      await client.query(
        `SELECT binding_id, asset_version_id, representation_id, transform_id, role, status, mapping_ids
           FROM asset_bindings
          WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3`,
        [projectId, revisionId, bindingId],
      )
    ).rows[0];
    if (!binding) throw fieldError('binding_id', 'not_found', { value: bindingId });

    const transform = (
      await client.query(
        `SELECT ${TRANSFORM_COLUMNS} FROM spatial_transforms
          WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3
          ORDER BY created_at DESC, transform_id LIMIT 1`,
        [projectId, revisionId, bindingId],
      )
    ).rows[0];

    const mappings = (
      await client.query(
        `SELECT ${MAPPING_COLUMNS} FROM import_mappings
          WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3
          ORDER BY created_at, mapping_id`,
        [projectId, revisionId, bindingId],
      )
    ).rows;

    const counts = (
      await client.query(
        `SELECT status, count(*)::int AS n FROM import_features
          WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3
          GROUP BY status`,
        [projectId, revisionId, bindingId],
      )
    ).rows;
    const featureCounts = { MAPPED: 0, REFERENCE_ONLY: 0, UNSUPPORTED: 0, total: 0 };
    for (const row of counts) {
      featureCounts[row.status] = row.n;
      featureCounts.total += row.n;
    }

    const latestReport = (
      await client.query(
        `SELECT import_report_id, asset_version_ids, binding_ids, transform_ids, mapping_ids, diagnostic_ids,
                mapped_feature_count, unmapped_feature_count, unsupported_feature_count, review_state, created_at
           FROM import_reports
          WHERE project_id = $1 AND revision_id = $2 AND binding_ids && $3::uuid[]
          ORDER BY created_at DESC, import_report_id LIMIT 1`,
        [projectId, revisionId, [bindingId]],
      )
    ).rows[0];

    return {
      binding: projectStore('bindings', [binding])[0],
      transform: transform ? transformShape(transform) : null,
      mappings: mappings.map(mappingShape),
      featureCounts,
      latestReport: latestReport
        ? {
            importReportId: latestReport.import_report_id,
            assetVersionIds: latestReport.asset_version_ids ?? [],
            bindingIds: latestReport.binding_ids ?? [],
            transformIds: latestReport.transform_ids ?? [],
            mappingIds: latestReport.mapping_ids ?? [],
            diagnosticIds: latestReport.diagnostic_ids ?? [],
            mappedFeatureCount: latestReport.mapped_feature_count,
            unmappedFeatureCount: latestReport.unmapped_feature_count,
            unsupportedFeatureCount: latestReport.unsupported_feature_count,
            reviewState: latestReport.review_state,
            createdAt: latestReport.created_at,
          }
        : null,
    };
  });
}

export { TRANSFORM_COLUMNS, MAPPING_COLUMNS };
