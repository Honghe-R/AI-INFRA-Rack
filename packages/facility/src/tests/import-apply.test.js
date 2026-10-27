import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { withTenant } from '@ai-infra/db';
import { applyAssetBinding, previewImportMerge } from '../import-apply.js';
import { IMPORT_CHANGE_KINDS, IMPORT_KIND_RANK } from '../change-kinds-imports.js';
import { createImportMapping, createSpatialTransform, reviewImportMapping, reviewSpatialTransform } from '../import-mappings.js';
import { ensureEtag } from '../etags.js';
import { seedBaseline } from './fixtures.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';
const { default: pg } = await import('pg');
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
test.after(() => pool?.end());

/* ==================================================== pure/fixture helpers */

const checksum = (seed) => seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a');

const BUILDING_POLYGON = {
  type: 'Polygon',
  coordinates: [[[121.47, 31.23], [121.471, 31.23], [121.471, 31.231], [121.47, 31.231], [121.47, 31.23]]],
};

/**
 * A FEATURES body exactly as the workspace pipeline stores it: features, counts, and
 * diagnostics. The fake storage follows the assistant session tests' pattern of
 * handing back a body the reader can consume.
 */
function storageWith(features, { counts = null, diagnostics = [] } = {}) {
  return {
    putObject: async ({ key }) => ({ key }),
    getObject: async () => ({
      body: JSON.stringify({ features, counts: counts ?? { extracted: features.length }, diagnostics }),
    }),
  };
}

/** Seeds a real asset version behind the fixture binding so a FEATURES row can exist. */
async function attachFeaturesRepresentation(client, { projectId, bindingId }) {
  const binding = (
    await client.query('SELECT asset_version_id FROM asset_bindings WHERE project_id = $1 AND binding_id = $2', [projectId, bindingId])
  ).rows[0];
  const assetVersionId = binding.asset_version_id;
  const assetId = randomUUID();
  const digest = checksum(assetVersionId);
  await client.query(
    `INSERT INTO project_assets
       (asset_id, project_id, name, kind, media_type, status, access_classification, current_version_id, version_count, owner)
     VALUES ($1, $2, 'Campus model', 'BIM', 'application/x-step', 'ACTIVE', 'PROJECT', $3, 1, 'ada')`,
    [assetId, projectId, assetVersionId],
  );
  await client.query(
    `INSERT INTO asset_versions
       (asset_version_id, project_id, asset_id, version_number, intake_state, content_checksum, size_bytes,
        storage_key, filename, media_type, malware_scan_state, status, source_ref)
     VALUES ($1, $2, $3, 1, 'COMPLETE', $4, 4096, $5, 'campus.ifc', 'application/x-step', 'CLEAN', 'CURRENT', 'user-upload')`,
    [assetVersionId, projectId, assetId, digest, `key/${assetVersionId}/original`],
  );
  const representationId = randomUUID();
  await client.query(
    `INSERT INTO asset_representations
       (representation_id, project_id, asset_version_id, kind, media_type, content_checksum, storage_key,
        producer_id, producer_version, status)
     VALUES ($1, $2, $3, 'FEATURES', 'application/json', $4, $5, 'ifc', '1.0', 'READY')`,
    [representationId, projectId, assetVersionId, digest, `key/${assetVersionId}/features.json`],
  );
  return { assetVersionId, representationId };
}

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
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `import-apply-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Import apply org']);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Import apply project']);
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

const applyArgs = (scope, overrides = {}) => ({
  client: scope.client,
  projectId: scope.projectId,
  revisionId: scope.revisionId,
  actorId: scope.userId,
  bindingId: scope.ids.binding,
  transformId: scope.ids.transform,
  mappingIds: [scope.ids.mapping],
  etag: scope.token.etag,
  baseRevisionId: scope.ids.envelope,
  ...overrides,
});

/* ==================================================== preview (never writes) */

test('preview counts created, conflicting, and unmapped features without writing', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const before = (
      await scope.client.query('SELECT count(*)::int AS n FROM import_features WHERE project_id = $1', [scope.projectId])
    ).rows[0].n;

    const preview = await previewImportMerge({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      bindingId: scope.ids.binding,
      storage: storageWith([
        // A new building: nothing with this identity exists.
        { featureId: 'p-1', sourceSelector: 'layer:BUILDING', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Warehouse' } },
        // The fixture already has a BUILDING named "BUILDING".
        { featureId: 'p-2', sourceSelector: 'layer:BUILDING', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'BUILDING' } },
        // No reviewed mapping claims this selector.
        { featureId: 'p-3', sourceSelector: 'layer:NOTHING', disposition: 'UNMAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Orphan' } },
      ]),
    });

    const after = (
      await scope.client.query('SELECT count(*)::int AS n FROM import_features WHERE project_id = $1', [scope.projectId])
    ).rows[0].n;
    return { preview, before, after };
  });

  assert.equal(result.preview.counts.created, 1);
  assert.equal(result.preview.counts.conflicting, 1);
  assert.equal(result.preview.counts.unmapped, 1);
  assert.equal(result.preview.counts.updated, 0);
  assert.equal(result.preview.counts.unsupported, 0);
  assert.equal(result.preview.conflicts.length, 1);
  assert.equal(result.preview.conflicts[0].constraint_id, 'facility.import.conflict');
  assert.equal(result.preview.conflicts[0].target_entity_type, 'BUILDING');
  // Preview performs reads only; the feature table is a list of what apply produced,
  // and preview produced nothing.
  assert.equal(result.before, result.after);
});

test('preview marks a target type with no projection path as unsupported', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const mapping = await createImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      bindingId: scope.ids.binding,
      transformId: scope.ids.transform,
      sourceSelector: 'attr:kind=environmental',
      targetEntityType: 'ENVIRONMENTAL_PROFILE',
    });
    await reviewImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      mappingId: mapping.mappingId,
      reviewState: 'REVIEWED',
    });
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    return previewImportMerge({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      bindingId: scope.ids.binding,
      mappingIds: [mapping.mappingId],
      storage: storageWith([
        { featureId: 'e-1', sourceSelector: 'attr:kind=environmental', disposition: 'MAPPED', attributes: { kind: 'environmental' } },
      ]),
    });
  });

  assert.equal(result.counts.unsupported, 1);
  assert.equal(result.counts.created, 0);
});

/* ==================================================== apply (one change set) */

test('apply commits one change set, advances the ETag, and records features and a report', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const applied = await applyAssetBinding(applyArgs(scope, {
      storage: storageWith([
        { featureId: 'apply-1', sourceSelector: 'layer:BUILDING', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Warehouse' } },
      ]),
    }));

    const features = (
      await scope.client.query(
        `SELECT source_selector, source_feature_id, status, import_mapping_id, normalized_entity_id, geometry_type
           FROM import_features WHERE project_id = $1 AND binding_id = $2`,
        [scope.projectId, scope.ids.binding],
      )
    ).rows;
    const reports = (
      await scope.client.query(
        `SELECT mapped_feature_count, unmapped_feature_count, unsupported_feature_count, binding_ids, mapping_ids, transform_ids
           FROM import_reports WHERE project_id = $1`,
        [scope.projectId],
      )
    ).rows;
    const events = (
      await scope.client.query(
        `SELECT event_type FROM outbox_events WHERE project_id = $1 ORDER BY created_at`,
        [scope.projectId],
      )
    ).rows.map((row) => row.event_type);
    const binding = (
      await scope.client.query('SELECT status, mapping_ids, transform_id FROM asset_bindings WHERE project_id = $1 AND binding_id = $2', [scope.projectId, scope.ids.binding])
    ).rows[0];
    const created = (
      await scope.client.query(
        `SELECT e.entity_id, e.display_name FROM entity_registry e
          WHERE e.project_id = $1 AND e.revision_id = $2 AND e.entity_type = 'BUILDING'`,
        [scope.projectId, scope.revisionId],
      )
    ).rows;
    return { applied, features, reports, events, binding, created, originalEtag: scope.token.etag, originalVersion: scope.token.etagVersion };
  });

  assert.equal(result.applied.applied, true);
  assert.ok(result.applied.importReportId);
  assert.equal(result.applied.counts.created, 1);
  assert.notEqual(result.applied.etag, result.originalEtag, 'the draft token advanced exactly once');
  assert.equal(result.applied.etagVersion, result.originalVersion + 1);

  // The seeded feature plus the applied one, addressed by the matching mapping's
  // selector so the existing facility.import.* checks can join it.
  assert.equal(result.features.length, 2);
  const appliedFeature = result.features.find((row) => row.source_feature_id === 'apply-1');
  assert.ok(appliedFeature);
  assert.equal(appliedFeature.source_selector, 'layer:BUILDING');
  assert.equal(appliedFeature.status, 'MAPPED');
  assert.equal(appliedFeature.import_mapping_id, result.applied.mappingIds[0]);
  assert.ok(appliedFeature.normalized_entity_id);

  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].mapped_feature_count, 1);
  assert.equal(result.reports[0].unmapped_feature_count, 0);
  assert.equal(result.reports[0].unsupported_feature_count, 0);
  assert.deepEqual(result.reports[0].transform_ids, [result.applied.transformId]);

  // Apply is one change set: the standard revision-changed event plus the import's own.
  assert.ok(result.events.includes('facility.revision.changed.v1'));
  assert.ok(result.events.includes('facility.asset-binding.applied.v1'));

  assert.equal(result.binding.status, 'REVIEWED', 'the review_state enum cannot hold APPLIED');
  assert.deepEqual(result.binding.mapping_ids, result.applied.mappingIds);

  // The fixture building plus the imported one.
  assert.equal(result.created.length, 2);
  assert.ok(result.created.some((row) => row.display_name === 'Warehouse'));
});

test('apply writes every feature, including the ones no mapping claimed', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const applied = await applyAssetBinding(applyArgs(scope, {
      storage: storageWith([
        { featureId: 'a-1', sourceSelector: 'layer:BUILDING', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Warehouse' } },
        { featureId: 'a-2', sourceSelector: 'layer:NOTHING', disposition: 'REFERENCE_ONLY', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Orphan' } },
      ]),
    }));
    const rows = (
      await scope.client.query(
        'SELECT source_feature_id, status FROM import_features WHERE project_id = $1 ORDER BY source_feature_id',
        [scope.projectId],
      )
    ).rows;
    return { applied, rows };
  });

  assert.equal(result.applied.counts.created, 1);
  assert.equal(result.applied.counts.unmapped, 1);
  // The seeded feature plus both applied features.
  assert.equal(result.rows.length, 3);
  const appliedRows = result.rows.filter((row) => row.source_feature_id !== 'f-1');
  assert.deepEqual(appliedRows, [
    { source_feature_id: 'a-1', status: 'MAPPED' },
    { source_feature_id: 'a-2', status: 'REFERENCE_ONLY' },
  ]);
});

test('an unreviewed transform is refused before anything is written', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    await reviewSpatialTransform({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      transformId: scope.ids.transform,
      reviewState: 'UNREVIEWED',
    });
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const attempt = await refusal(applyAssetBinding(applyArgs(scope, {
      storage: storageWith([
        { featureId: 't-1', sourceSelector: 'layer:BUILDING', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Warehouse' } },
      ]),
    })));
    const written = (
      await scope.client.query('SELECT count(*)::int AS n FROM import_features WHERE project_id = $1 AND source_feature_id = $2', [scope.projectId, 't-1'])
    ).rows[0].n;
    return { error: attempt.error, written };
  });

  assert.equal(result.error.status, 409);
  assert.equal(result.error.details[0].constraint_id, 'import.transform.unreviewed');
  assert.equal(result.written, 0);
});

test('an unreviewed mapping is refused', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const mapping = await createImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      bindingId: scope.ids.binding,
      transformId: scope.ids.transform,
      sourceSelector: 'layer:FRESH',
      targetEntityType: 'PARCEL',
      targetGeometryRole: 'BOUNDARY',
    });
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const attempt = await refusal(applyAssetBinding(applyArgs(scope, {
      mappingIds: [mapping.mappingId],
      storage: storageWith([
        { featureId: 'm-1', sourceSelector: 'layer:FRESH', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'New parcel' } },
      ]),
    })));
    return attempt.error;
  });

  assert.equal(result.status, 409);
  assert.equal(result.details[0].constraint_id, 'facility.import.mapping.unreviewed');
  assert.equal(result.details[0].review_state, 'UNREVIEWED');
});

test('a conflicting user-authored target is refused with 409 facility.import.conflict', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const before = (
      await scope.client.query('SELECT count(*)::int AS n FROM entity_registry WHERE project_id = $1 AND entity_type = $2', [scope.projectId, 'BUILDING'])
    ).rows[0].n;
    const attempt = await refusal(applyAssetBinding(applyArgs(scope, {
      storage: storageWith([
        { featureId: 'c-1', sourceSelector: 'layer:BUILDING', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'BUILDING' } },
      ]),
    })));
    const after = (
      await scope.client.query('SELECT count(*)::int AS n FROM entity_registry WHERE project_id = $1 AND entity_type = $2', [scope.projectId, 'BUILDING'])
    ).rows[0].n;
    const features = (
      await scope.client.query('SELECT count(*)::int AS n FROM import_features WHERE project_id = $1 AND source_feature_id = $2', [scope.projectId, 'c-1'])
    ).rows[0].n;
    return { error: attempt.error, before, after, features };
  });

  assert.equal(result.error.status, 409);
  assert.equal(result.error.details[0].constraint_id, 'facility.import.conflict');
  assert.equal(result.error.details[0].reason, 'user_authored_target');
  assert.equal(result.error.details[0].name, 'BUILDING');
  // A refusal leaves the graph and the feature ledger untouched.
  assert.equal(result.before, result.after);
  assert.equal(result.features, 0);
});

test('a conflict resolution is honored and the target is updated instead', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const applied = await applyAssetBinding(applyArgs(scope, {
      storage: storageWith([
        { featureId: 'c-2', sourceSelector: 'layer:BUILDING', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'BUILDING' } },
      ]),
      conflictResolutions: [{ mapping_id: scope.ids.mapping, source_feature_id: 'c-2', resolution: 'UPDATE' }],
    }));
    const feature = (
      await scope.client.query(
        'SELECT status, normalized_entity_id FROM import_features WHERE project_id = $1 AND source_feature_id = $2',
        [scope.projectId, 'c-2'],
      )
    ).rows[0];
    return { applied, feature, ids: scope.ids };
  });

  assert.equal(result.applied.counts.updated, 1);
  assert.equal(result.applied.counts.conflicting, 0);
  assert.equal(result.feature.status, 'MAPPED');
  // The resolution targeted the existing building rather than creating a second one.
  assert.equal(result.feature.normalized_entity_id, result.ids.building);
});

test('a required mapping with no matches blocks the apply', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const attempt = await refusal(applyAssetBinding(applyArgs(scope, {
      storage: storageWith([
        { featureId: 'u-1', sourceSelector: 'layer:NOTHING', disposition: 'UNMAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Orphan' } },
      ]),
    })));
    return attempt.error;
  });

  assert.equal(result.status, 409);
  assert.equal(result.details[0].constraint_id, 'facility.import.mapping.unresolved');
});

test('an ambiguous one-to-one mapping is refused', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const mapping = await createImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      bindingId: scope.ids.binding,
      transformId: scope.ids.transform,
      sourceSelector: 'layer:MULTI',
      targetEntityType: 'RESERVED_AREA',
      targetGeometryRole: 'BOUNDARY',
      cardinality: 'ONE_TO_ONE',
    });
    await reviewImportMapping({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      mappingId: mapping.mappingId,
      reviewState: 'REVIEWED',
    });
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const attempt = await refusal(applyAssetBinding(applyArgs(scope, {
      mappingIds: [mapping.mappingId],
      storage: storageWith([
        { featureId: 'm-1', sourceSelector: 'layer:MULTI', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Area A' } },
        { featureId: 'm-2', sourceSelector: 'layer:MULTI', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Area B' } },
      ]),
    })));
    return attempt.error;
  });

  assert.equal(result.status, 409);
  assert.equal(result.details[0].constraint_id, 'facility.import.mapping.ambiguous');
  assert.equal(result.details[0].matches, 2);
});

test('re-applying the same source feature updates it rather than conflicting', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    await attachFeaturesRepresentation(scope.client, { projectId: scope.projectId, bindingId: scope.ids.binding });
    const features = storageWith([
      { featureId: 'r-1', sourceSelector: 'layer:BUILDING', disposition: 'MAPPED', geometryType: 'POLYGON', geojson: BUILDING_POLYGON, attributes: { name: 'Warehouse' } },
    ]);
    const first = await applyAssetBinding(applyArgs(scope, { storage: features }));
    const second = await applyAssetBinding(applyArgs(scope, {
      storage: features,
      etag: first.etag,
      baseRevisionId: scope.ids.envelope,
    }));
    const buildingCount = (
      await scope.client.query(
        `SELECT count(*)::int AS n FROM entity_registry WHERE project_id = $1 AND entity_type = 'BUILDING'`,
        [scope.projectId],
      )
    ).rows[0].n;
    return { first, second, buildingCount };
  });

  assert.equal(result.first.counts.created, 1);
  // The prior import_features row names the entity this source feature produced, so
  // the second apply targets it instead of seeing it as a user-authored collision.
  assert.equal(result.second.counts.updated, 1);
  assert.equal(result.second.counts.created, 0);
  assert.equal(result.buildingCount, 2, 'no duplicate building was created');
});

/* ============================================== the transform_geometry kind */

test('transform_geometry re-projects a geometry through a reviewed transform', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const geometry = (
      await scope.client.query(
        `SELECT geometry_id FROM geometry_records
          WHERE project_id = $1 AND entity_id = $2 AND role = 'FOOTPRINT'`,
        [scope.projectId, scope.ids.building],
      )
    ).rows[0];
    const applied = await IMPORT_CHANGE_KINDS.transform_geometry.apply({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      change: { kind: 'transform_geometry', payload: { geometry_id: geometry.geometry_id, transform_id: scope.ids.transform } },
    });
    const row = (
      await scope.client.query(
        `SELECT projected_crs, parent_transform_id, binding_id, asset_version_id, ST_SRID(projected_geometry) AS srid
           FROM geometry_records WHERE project_id = $1 AND geometry_id = $2`,
        [scope.projectId, geometry.geometry_id],
      )
    ).rows[0];
    const binding = (
      await scope.client.query('SELECT asset_version_id FROM asset_bindings WHERE project_id = $1 AND binding_id = $2', [scope.projectId, scope.ids.binding])
    ).rows[0];
    const transform = (
      await scope.client.query('SELECT asset_version_id FROM spatial_transforms WHERE project_id = $1 AND transform_id = $2', [scope.projectId, scope.ids.transform])
    ).rows[0];
    return { applied, row, binding, bindingId: scope.ids.binding, transformAssetVersionId: transform.asset_version_id };
  });

  assert.equal(result.applied.method, 'crs');
  assert.equal(result.row.projected_crs, 'EPSG:32618');
  assert.equal(result.row.srid, 32618);
  // Provenance is the point of the kind: the geometry now names the reviewed
  // transform and the binding that produced it.
  assert.equal(result.row.parent_transform_id, result.applied.transformId);
  assert.equal(result.row.binding_id, result.bindingId);
  assert.equal(result.row.asset_version_id, result.transformAssetVersionId);
});

test('transform_geometry refuses an unreviewed transform and a method with no provider', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const geometry = (
      await scope.client.query(
        `SELECT geometry_id FROM geometry_records WHERE project_id = $1 AND entity_id = $2 AND role = 'FOOTPRINT'`,
        [scope.projectId, scope.ids.building],
      )
    ).rows[0];

    await reviewSpatialTransform({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      transformId: scope.ids.transform,
      reviewState: 'UNREVIEWED',
    });
    const unreviewed = await refusal(IMPORT_CHANGE_KINDS.transform_geometry.apply({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      change: { kind: 'transform_geometry', payload: { geometry_id: geometry.geometry_id, transform_id: scope.ids.transform } },
    }));

    const manual = await createSpatialTransform({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      bindingId: scope.ids.binding,
      sourceUnits: 'm',
      targetUnits: 'm',
      sourceCrs: 'LOCAL',
      targetCrs: 'LOCAL',
      method: 'MANUAL',
    });
    await reviewSpatialTransform({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      transformId: manual.transformId,
      reviewState: 'REVIEWED',
    });
    const noProvider = await refusal(IMPORT_CHANGE_KINDS.transform_geometry.apply({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      actorId: scope.userId,
      change: { kind: 'transform_geometry', payload: { geometry_id: geometry.geometry_id, transform_id: manual.transformId } },
    }));
    return { unreviewed: unreviewed.error, noProvider: noProvider.error };
  });

  assert.equal(result.unreviewed.name, 'ChangeConflict');
  assert.equal(result.unreviewed.details.constraint_id, 'import.transform.unreviewed');
  assert.equal(result.noProvider.name, 'ChangeRejected');
  assert.equal(result.noProvider.details.reason, 'provider_required');
  // `transform_geometry` runs after `set_geometry` so a set that writes a geometry and
  // declares its transform writes the geometry first.
  assert.ok(IMPORT_KIND_RANK.transform_geometry > 30);
});
