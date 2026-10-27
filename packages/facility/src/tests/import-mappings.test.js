import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { withTenant } from '@ai-infra/db';
import {
  ENTITY_GEOMETRY_ROLES,
  MAPPING_CARDINALITIES,
  TRANSFORM_METHODS,
  W4_TO_TRANSFORM_METHOD,
  W4_TRANSFORM_METHODS,
  allowedGeometryRoles,
  createImportMapping,
  createSpatialTransform,
  loadBindingDetail,
  requiresGeometryRole,
  resolveGeometryRole,
  reviewImportMapping,
  reviewSpatialTransform,
  toTransformMethod,
  updateImportMapping,
  updateSpatialTransform,
} from '../import-mappings.js';
import { ensureEtag } from '../etags.js';
import { seedBaseline } from './fixtures.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';
const { default: pg } = await import('pg');
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
test.after(() => pool?.end());

/* ==================================================== pure contract tables */

test('toTransformMethod is the whole documented vocabulary delta', () => {
  assert.deepEqual(Object.keys(W4_TO_TRANSFORM_METHOD).sort(), [...W4_TRANSFORM_METHODS].sort());
  assert.equal(toTransformMethod('IDENTITY'), 'DECLARED_CRS');
  assert.equal(toTransformMethod('UNIT_SCALE'), 'DECLARED_CRS');
  assert.equal(toTransformMethod('PROJECTION_CHANGE'), 'DECLARED_CRS');
  assert.equal(toTransformMethod('HELMERT_7_PARAM'), 'CONTROL_POINTS_HELMERT');
  assert.equal(toTransformMethod('AFFINE_2D'), 'CONTROL_POINTS_AFFINE');
  // Both fitted local methods need a residual, which the store's value for that is
  // FITTED_RESIDUAL (the schema check requires the residual for exactly this value).
  assert.equal(toTransformMethod('SIMILARITY_2D'), 'FITTED_RESIDUAL');
  assert.equal(toTransformMethod('CONTROL_POINT_LOCAL'), 'FITTED_RESIDUAL');
  assert.throws(() => toTransformMethod('MERCATOR_MAGIC'), /workspace framework/);
});

test('the store vocabulary is the enum the schema declares', () => {
  assert.deepEqual([...TRANSFORM_METHODS], ['DECLARED_CRS', 'CONTROL_POINTS_HELMERT', 'CONTROL_POINTS_AFFINE', 'FITTED_RESIDUAL', 'MANUAL']);
  // MANUAL is store-only: it has no framework counterpart, which is the other half
  // of the delta and the reason the mapping is not a bijection.
  assert.equal(W4_TRANSFORM_METHODS.includes('MANUAL'), false);
});

test('the entity-type to geometry-role table is the facility contract', () => {
  assert.deepEqual([...ENTITY_GEOMETRY_ROLES.BUILDING], ['FOOTPRINT']);
  assert.deepEqual([...ENTITY_GEOMETRY_ROLES.HALL], ['FLOOR_BOUNDARY', 'ROOM_BOUNDARY']);
  assert.deepEqual([...ENTITY_GEOMETRY_ROLES.EQUIPMENT_YARD], ['BOUNDARY', 'FOOTPRINT']);
  assert.deepEqual([...ENTITY_GEOMETRY_ROLES.ENVIRONMENTAL_PROFILE], []);
  assert.deepEqual([...ENTITY_GEOMETRY_ROLES.DOCUMENT], ['REFERENCE_POINT']);
  assert.equal(allowedGeometryRoles('NOT_A_TYPE'), null);
});

test('resolveGeometryRole refuses a mismatch and a missing role with the catalog ids', () => {
  assert.equal(resolveGeometryRole('BUILDING', 'FOOTPRINT'), 'FOOTPRINT');
  assert.equal(resolveGeometryRole('ENVIRONMENTAL_PROFILE', null), null);
  assert.equal(resolveGeometryRole('DOCUMENT', null), null, 'the one optional role');

  const mismatch = (() => {
    try {
      resolveGeometryRole('BUILDING', 'BOUNDARY');
    } catch (error) {
      return error;
    }
    return null;
  })();
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.details[0].constraint_id, 'facility.data.geometry.type_mismatch');

  const missing = (() => {
    try {
      resolveGeometryRole('BUILDING', null);
    } catch (error) {
      return error;
    }
    return null;
  })();
  assert.equal(missing.details[0].reason, 'role_missing');
  assert.equal(missing.details[0].constraint_id, 'facility.data.geometry.role_missing');

  // Attribute-only types carry no geometry at all, so a role is not a refinement.
  assert.throws(() => resolveGeometryRole('CAPACITY_BUDGET', 'BOUNDARY'), /geometry role/);
  assert.equal(requiresGeometryRole('BUILDING'), true);
  assert.equal(requiresGeometryRole('DOCUMENT'), false);
  assert.equal(requiresGeometryRole('ASSUMPTION'), false);
});

test('the cardinality enum is the two the contract names', () => {
  assert.deepEqual([...MAPPING_CARDINALITIES], ['ONE_TO_ONE', 'ONE_TO_MANY']);
});

/* ==================================================== commands over the store */

class Rollback extends Error {
  constructor(value) {
    super('rollback');
    this.value = value;
  }
}

async function withBaseline(fn) {
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();
  try {
    await withTenant(pool, projectId, async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `import-map-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Import org']);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Import project']);
      await client.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [scenarioId, projectId, 'Baseline']);
      await client.query(
        `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
         VALUES ($1, $2, $3, 'DRAFT', 'Draft 1')`,
        [revisionId, projectId, scenarioId],
      );
      const ids = await seedBaseline(client, { projectId, scenarioId, revisionId, actorId: userId });
      const token = await ensureEtag({ client, projectId, revisionId, scenarioId, actorId: userId });
      throw new Rollback(await fn({ client, ids, projectId, scenarioId, revisionId, userId, token }));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
}

async function refusal(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

const transformArgs = (scope, overrides = {}) => ({
  client: scope.client,
  projectId: scope.projectId,
  revisionId: scope.revisionId,
  actorId: scope.userId,
  bindingId: scope.ids.binding,
  sourceUnits: 'm',
  targetUnits: 'm',
  targetCrs: 'EPSG:32618',
  ...overrides,
});

test('a fitted transform is created UNREVIEWED with its residual computed', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const transform = await createSpatialTransform(transformArgs(scope, {
      method: 'SIMILARITY_2D',
      sourceCrs: null,
      controlPoints: [
        { source: [0, 0], target: [0, 0] },
        { source: [100, 0], target: [100, 0] },
      ],
    }));
    const row = (
      await scope.client.query(
        'SELECT method, review_state, residual_error_m, source_crs, jsonb_array_length(control_points) AS points FROM spatial_transforms WHERE project_id = $1 AND transform_id = $2',
        [scope.projectId, transform.transformId],
      )
    ).rows[0];
    return { transform, row };
  });

  assert.equal(result.transform.reviewState, 'UNREVIEWED');
  assert.equal(result.transform.method, 'FITTED_RESIDUAL');
  assert.equal(result.transform.requestedMethod, 'SIMILARITY_2D');
  assert.equal(result.row.method, 'FITTED_RESIDUAL');
  assert.equal(result.row.review_state, 'UNREVIEWED');
  // The schema's residual check is satisfied because the fit computed one; a fitted
  // method without a residual would be a row the store refuses.
  assert.ok(result.row.residual_error_m !== null);
  assert.equal(result.row.points, 2);
});

test('a declared-CRS transform stores DECLARED_CRS and requires no residual', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    return createSpatialTransform(transformArgs(scope, {
      method: 'IDENTITY',
      sourceCrs: 'EPSG:32618',
      controlPoints: [],
    }));
  });
  assert.equal(result.method, 'DECLARED_CRS');
  assert.equal(result.residualErrorM, null);
  assert.equal(result.requiresProvider, false);
});

test('the source-CRS-or-two-control-points check is answered before the store sees it', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const attempt = await refusal(createSpatialTransform(transformArgs(scope, {
      method: 'IDENTITY',
      sourceCrs: null,
      controlPoints: [{ source: [0, 0], target: [0, 0] }],
    })));
    return attempt.error;
  });
  assert.equal(result.status, 422);
  assert.equal(result.details[0].constraint_id, 'import.transform.control_points_insufficient');
});

test('a method that is neither vocabulary is refused', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const attempt = await refusal(createSpatialTransform(transformArgs(scope, {
      method: 'MERCATOR_MAGIC',
      sourceCrs: 'EPSG:32618',
    })));
    return attempt.error;
  });
  assert.equal(result.status, 422);
  assert.equal(result.details[0].field, 'method');
});

test('review sets the reviewer fields and an edit resets the transform to UNREVIEWED', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const created = await createSpatialTransform(transformArgs(scope, { method: 'IDENTITY', sourceCrs: 'EPSG:32618' }));
    const reviewed = await reviewSpatialTransform({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      transformId: created.transformId,
      reviewState: 'REVIEWED',
      comment: 'Georeference checked.',
    });
    const edited = await updateSpatialTransform({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      transformId: created.transformId,
      sourceUnits: 'ft',
    });
    const row = (
      await scope.client.query(
        'SELECT review_state, reviewer_id, reviewed_at FROM spatial_transforms WHERE project_id = $1 AND transform_id = $2',
        [scope.projectId, created.transformId],
      )
    ).rows[0];
    return { reviewed, edited, row, userId: scope.userId };
  });

  assert.equal(result.reviewed.reviewState, 'REVIEWED');
  assert.equal(result.reviewed.authoritative, true);
  assert.equal(result.reviewed.reviewerId, result.userId);
  assert.ok(result.reviewed.reviewedAt);
  // Any edit to units, CRS, method, or control points returns the record to UNREVIEWED
  // (import-adapters.md), and the reviewer fields clear with it.
  assert.equal(result.edited.reviewState, 'UNREVIEWED');
  assert.equal(result.edited.sourceUnits, 'ft');
  assert.equal(result.row.review_state, 'UNREVIEWED');
  assert.equal(result.row.reviewer_id, null);
  assert.equal(result.row.reviewed_at, null);
});

test('a mapping normalizes its selector and is created UNREVIEWED', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const mapping = await createImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      bindingId: scope.ids.binding,
      transformId: scope.ids.transform,
      // Deliberately messy source: the stored form must be the normalized one the
      // preview, apply, and re-import paths all evaluate.
      sourceSelector: "layer:NEW-*   AND   entity:POLYGON",
      targetEntityType: 'BUILDING',
      targetGeometryRole: 'FOOTPRINT',
      attributeMapping: { name: 'Name' },
      required: true,
    });
    return mapping;
  });

  assert.equal(result.sourceSelector, 'layer:NEW-* AND entity:POLYGON');
  assert.equal(result.reviewState, 'UNREVIEWED');
  assert.equal(result.targetEntityType, 'BUILDING');
  assert.equal(result.targetGeometryRole, 'FOOTPRINT');
  assert.equal(result.required, true);
  assert.deepEqual(result.attributeMapping, { name: 'Name' });
});

test('a duplicate (asset_version_id, source_selector, revision_id) is refused with 409', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const base = {
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      bindingId: scope.ids.binding,
      transformId: scope.ids.transform,
      targetEntityType: 'BUILDING',
      targetGeometryRole: 'FOOTPRINT',
    };
    const first = await createImportMapping({ ...base, sourceSelector: 'layer:DUP', targetEntityType: 'PARCEL', targetGeometryRole: 'BOUNDARY' });
    // A differently-spelled but equivalent selector is the same stored selector.
    const attempt = await refusal(createImportMapping({ ...base, sourceSelector: 'layer:DUP ', targetEntityType: 'PARCEL', targetGeometryRole: 'BOUNDARY' }));
    const second = await createImportMapping({ ...base, sourceSelector: 'layer:OTHER', targetEntityType: 'BUILDING', targetGeometryRole: 'FOOTPRINT' });
    return { first, attempt: attempt.error, second };
  });

  // `layer:DUP ` normalizes to `layer:DUP`, so the uniqueness key catches it.
  assert.equal(result.attempt.code, 'CONFLICT');
  assert.equal(result.attempt.status, 409);
  assert.equal(result.attempt.details[0].reason, 'duplicate_selector');
  assert.equal(result.attempt.details[0].existing_mapping_id, result.first.mappingId);
  assert.notEqual(result.second.mappingId, result.first.mappingId);
});

test('a geometry mismatch and a missing role are refused with the catalog ids', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const base = {
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      bindingId: scope.ids.binding,
      transformId: scope.ids.transform,
    };
    const mismatch = await refusal(createImportMapping({
      ...base, sourceSelector: 'layer:MISMATCH', targetEntityType: 'BUILDING', targetGeometryRole: 'BOUNDARY',
    }));
    const missing = await refusal(createImportMapping({
      ...base, sourceSelector: 'layer:MISSING', targetEntityType: 'BUILDING', targetGeometryRole: null,
    }));
    const attributeOnly = await refusal(createImportMapping({
      ...base, sourceSelector: 'layer:ATTR', targetEntityType: 'CAPACITY_BUDGET', targetGeometryRole: 'BOUNDARY',
    }));
    return { mismatch: mismatch.error, missing: missing.error, attributeOnly: attributeOnly.error };
  });

  assert.equal(result.mismatch.status, 422);
  assert.equal(result.mismatch.details[0].constraint_id, 'facility.data.geometry.type_mismatch');
  assert.equal(result.missing.status, 422);
  assert.equal(result.missing.details[0].reason, 'role_missing');
  assert.equal(result.attributeOnly.status, 422);
});

test('an invalid selector is refused before anything is written', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const attempt = await refusal(createImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      bindingId: scope.ids.binding,
      transformId: scope.ids.transform,
      sourceSelector: 'not-a-selector',
      targetEntityType: 'BUILDING',
      targetGeometryRole: 'FOOTPRINT',
    }));
    const { rows } = await scope.client.query(
      'SELECT count(*)::int AS n FROM import_mappings WHERE project_id = $1',
      [scope.projectId],
    );
    return { error: attempt.error, written: rows[0].n };
  });
  assert.equal(result.error.status, 422);
  assert.equal(result.written, 1, 'only the seeded mapping exists');
});

test('reviewImportMapping records the reviewer and an edit resets the review', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const reviewed = await reviewImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      mappingId: scope.ids.mapping,
      reviewState: 'REVIEWED',
      comment: 'Looks right.',
    });
    const edited = await updateImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      mappingId: scope.ids.mapping,
      attributeMapping: { name: 'Label' },
    });
    const row = (
      await scope.client.query(
        'SELECT review_state, reviewer_id, reviewed_at FROM import_mappings WHERE project_id = $1 AND mapping_id = $2',
        [scope.projectId, scope.ids.mapping],
      )
    ).rows[0];
    return { reviewed, edited, row };
  });

  assert.equal(result.reviewed.reviewState, 'REVIEWED');
  assert.ok(result.reviewed.reviewedAt);
  assert.equal(result.edited.reviewState, 'UNREVIEWED');
  assert.deepEqual(result.edited.attributeMapping, { name: 'Label' });
  assert.equal(result.row.reviewer_id, null);
  assert.equal(result.row.reviewed_at, null);
});

test('loadBindingDetail reads the binding, transform, mappings, counts, and latest report', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const detail = await loadBindingDetail({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      bindingId: scope.ids.binding,
    });
    return { detail, ids: scope.ids };
  });

  assert.equal(result.detail.binding.bindingId, result.ids.binding);
  assert.equal(result.detail.binding.role, 'SOURCE');
  assert.equal(result.detail.transform.transformId, result.ids.transform);
  assert.equal(result.detail.transform.method, 'DECLARED_CRS');
  assert.equal(result.detail.mappings.length, 1);
  assert.equal(result.detail.mappings[0].mappingId, result.ids.mapping);
  assert.equal(result.detail.mappings[0].targetEntityType, 'BUILDING');
  assert.equal(result.detail.featureCounts.MAPPED, 1);
  assert.equal(result.detail.featureCounts.total, 1);
  // No report has been issued yet, and a read must say "none" rather than invent one.
  assert.equal(result.detail.latestReport, null);
});

test('the binding, transform, and mapping references are validated', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const unknownBinding = await refusal(createSpatialTransform(transformArgs(scope, {
      method: 'IDENTITY', sourceCrs: 'EPSG:32618', bindingId: randomUUID(),
    })));
    const foreignTransform = await refusal(createImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      bindingId: scope.ids.binding,
      transformId: randomUUID(),
      sourceSelector: 'layer:NOPE',
      targetEntityType: 'BUILDING',
      targetGeometryRole: 'FOOTPRINT',
    }));
    return { unknownBinding: unknownBinding.error, foreignTransform: foreignTransform.error };
  });
  assert.equal(result.unknownBinding.status, 422);
  assert.equal(result.unknownBinding.details[0].field, 'binding_id');
  assert.equal(result.foreignTransform.status, 422);
  assert.equal(result.foreignTransform.details[0].field, 'transform_id');
});
