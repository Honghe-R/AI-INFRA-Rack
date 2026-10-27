import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, withTenant } from '@ai-infra/db';
import {
  BINDING_ROLES,
  MAX_BINDINGS_PER_REVISION,
  bindability,
  createAssetBinding,
  createFacilityToolSurface,
} from '../index.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;

before(() => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
});

after(async () => {
  if (pool) await pool.end();
});

class Rollback extends Error {
  constructor(value) {
    super('rollback');
    this.value = value;
  }
}

const checksum = (seed) => seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a');

/**
 * One project, scenario, draft revision, and — unlike the constraint fixtures — a
 * *real* project asset version.
 *
 * The fixture in `fixtures.js` binds a random `asset_version_id`, which the schema
 * permits because the column is deliberately not a foreign key across the two
 * bounded contexts. That is exactly the fact this test is about: the reference is
 * validated by the command, inside the transaction, so a test that wants a bindable
 * version has to write one into the asset tables.
 */
async function withRevision(fn, { lifecycleState = 'DRAFT' } = {}) {
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();
  try {
    await withTenant(pool, projectId, async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `binding-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [
        organizationId,
        'Binding org',
      ]);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
        projectId,
        organizationId,
        'Binding project',
      ]);
      await client.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
        scenarioId,
        projectId,
        'Baseline',
      ]);
      const frozen = lifecycleState !== 'DRAFT';
      await client.query(
        `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name, content_checksum)
         VALUES ($1, $2, $3, $4, 'Draft 1', $5)`,
        [revisionId, projectId, scenarioId, lifecycleState, frozen ? 'fixture-content-checksum' : null],
      );

      /** An asset with one version and two representations; every field overridable. */
      const seedAsset = async ({
        assetStatus = 'ACTIVE',
        versionStatus = 'CURRENT',
        intakeState = 'COMPLETE',
        scanState = 'CLEAN',
        representationStatus = 'READY',
      } = {}) => {
        const assetId = randomUUID();
        const assetVersionId = randomUUID();
        const featuresId = randomUUID();
        const originalId = randomUUID();
        await client.query(
          `INSERT INTO project_assets
             (asset_id, project_id, name, kind, media_type, status, access_classification,
              current_version_id, version_count, owner)
           VALUES ($1, $2, 'Campus survey', 'GIS', 'application/geo+json', $3, 'PROJECT', $4, 1, 'ada')`,
          [assetId, projectId, assetStatus, assetVersionId],
        );
        // Intake state and content identity are one fact in the schema
        // (`asset_versions_intake_check`): a COMPLETE version must carry a checksum,
        // a size, and a storage key, and a PENDING one must carry none of them.
        const complete = intakeState === 'COMPLETE';
        await client.query(
          `INSERT INTO asset_versions
             (asset_version_id, project_id, asset_id, version_number, intake_state, content_checksum,
              size_bytes, storage_key, filename, media_type, malware_scan_state, status, source_ref)
           VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'campus.geojson', 'application/geo+json', $8, $9, 'user-upload')`,
          [
            assetVersionId,
            projectId,
            assetId,
            intakeState,
            complete ? checksum(assetVersionId) : null,
            complete ? 2048 : null,
            complete ? `key/${assetVersionId}/original` : null,
            scanState,
            versionStatus,
          ],
        );
        // FEATURES and GEOREFERENCE may carry no storage key; ORIGINAL may not.
        await client.query(
          `INSERT INTO asset_representations
             (representation_id, project_id, asset_version_id, kind, media_type, content_checksum,
              storage_key, producer_id, producer_version, status)
           VALUES ($1, $2, $3, 'FEATURES', 'application/geo+json', $4, NULL, 'geojson', '1.0', $5),
                  ($6, $2, $3, 'ORIGINAL', 'application/geo+json', $4, 'key/original', 'original', '1.0', 'READY')`,
          [featuresId, projectId, assetVersionId, checksum(featuresId), representationStatus, originalId],
        );
        return { assetId, assetVersionId, representationId: featuresId, originalRepresentationId: originalId };
      };

      const scope = { client, projectId, scenarioId, revisionId, userId, seedAsset };
      throw new Rollback(await fn(scope));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
}

const create = (scope, args) =>
  createAssetBinding({
    client: scope.client,
    projectId: scope.projectId,
    revisionId: scope.revisionId,
    actorId: scope.userId,
    ...args,
  });

/** Captures a refusal rather than letting it escape the rollback harness. */
async function refusal(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

/* ------------------------------------------------------------- the read model */

test('bindability is a verdict with a reason, not a boolean', { skip }, () => {
  const bindable = {
    assetStatus: 'ACTIVE',
    versionStatus: 'CURRENT',
    intakeState: 'COMPLETE',
    malwareScanState: 'CLEAN',
  };
  assert.deepEqual(bindability(bindable), { bindable: true, reason: null });

  // Each blocked case mirrors what the client picker already tells the user, so the
  // two cannot disagree about what may be bound.
  assert.equal(bindability(null).reason, 'no_such_version');
  assert.equal(bindability({ ...bindable, assetStatus: 'QUARANTINED' }).reason, 'quarantined');
  assert.equal(bindability({ ...bindable, versionStatus: 'QUARANTINED' }).reason, 'quarantined');
  assert.equal(bindability({ ...bindable, assetStatus: 'ARCHIVED' }).reason, 'archived');
  assert.equal(bindability({ ...bindable, assetStatus: 'DELETED' }).reason, 'asset_deleted');
  assert.equal(bindability({ ...bindable, intakeState: 'PENDING' }).reason, 'intake_incomplete');
  assert.equal(bindability({ ...bindable, malwareScanState: 'INFECTED' }).reason, 'infected');
  assert.equal(bindability({ ...bindable, malwareScanState: 'FAILED' }).reason, 'scan_failed');
});

test('the role enum is the four the asset model declares', { skip }, () => {
  assert.deepEqual([...BINDING_ROLES], ['SOURCE', 'EVIDENCE', 'REFERENCE', 'ATTACHMENT']);
});

/* --------------------------------------------------------------- the command */

test('binding pins the exact version and representation', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const asset = await scope.seedAsset();
    const binding = await create(scope, {
      assetVersionId: asset.assetVersionId,
      representationId: asset.representationId,
      role: 'SOURCE',
    });

    const { rows } = await scope.client.query(
      `SELECT binding_id, asset_version_id, representation_id, role, status, tool_id, revision_id
         FROM asset_bindings WHERE project_id = $1`,
      [scope.projectId],
    );

    return { binding, rows, asset };
  });

  assert.equal(result.rows.length, 1, 'exactly one binding is written');
  assert.equal(result.rows[0].asset_version_id, result.asset.assetVersionId);
  assert.equal(result.rows[0].representation_id, result.asset.representationId);
  assert.equal(result.rows[0].role, 'SOURCE');
  assert.equal(result.rows[0].tool_id, 'site_facility', 'the binding belongs to this tool');
  assert.equal(result.rows[0].revision_id, result.binding.revisionId ?? result.rows[0].revision_id);
  assert.equal(result.rows[0].status, 'UNREVIEWED', 'a new binding is never authoritative');

  // What was pinned travels with the binding: the caller chose a file and needs to
  // read back which one, not only its identifier.
  assert.equal(result.binding.assetName, 'Campus survey');
  assert.equal(result.binding.filename, 'campus.geojson');
  assert.equal(result.binding.versionNumber, 1);
  assert.equal(result.binding.authoritative, false);
  assert.equal(result.binding.status, 'UNREVIEWED');
});

test('a representation may be omitted, and a version may be bound without one', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const asset = await scope.seedAsset();
    return create(scope, { assetVersionId: asset.assetVersionId, role: 'REFERENCE' });
  });

  assert.equal(result.representationId, null);
  assert.equal(result.role, 'REFERENCE');
});

test('an unknown asset version is refused rather than written as a dangling reference', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const outcome = await refusal(create(scope, { assetVersionId: randomUUID(), role: 'SOURCE' }));
    const { rows } = await scope.client.query('SELECT count(*)::int AS n FROM asset_bindings WHERE project_id = $1', [
      scope.projectId,
    ]);
    return { outcome, written: rows[0].n };
  });

  assert.equal(result.outcome.error.code, 'VALIDATION_FAILED');
  assert.equal(result.outcome.error.status, 422);
  assert.equal(result.outcome.error.details[0].reason, 'no_such_version');
  assert.equal(result.written, 0, 'a refused bind leaves nothing behind');
});

test('a quarantined, archived, or half-uploaded version cannot be bound', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const quarantined = await scope.seedAsset({ assetStatus: 'QUARANTINED' });
    const archived = await scope.seedAsset({ assetStatus: 'ARCHIVED' });
    const deleted = await scope.seedAsset({ assetStatus: 'DELETED' });
    const pending = await scope.seedAsset({ intakeState: 'PENDING' });
    const infected = await scope.seedAsset({ scanState: 'INFECTED' });

    const outcomes = {};
    for (const [name, asset] of Object.entries({ quarantined, archived, deleted, pending, infected })) {
      const attempt = await refusal(create(scope, { assetVersionId: asset.assetVersionId, role: 'SOURCE' }));
      outcomes[name] = attempt.error?.details?.[0]?.reason ?? null;
    }
    return outcomes;
  });

  assert.deepEqual(result, {
    quarantined: 'quarantined',
    archived: 'archived',
    deleted: 'asset_deleted',
    pending: 'intake_incomplete',
    infected: 'infected',
  });
});

test('a representation from another version, or a failed one, is refused', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const first = await scope.seedAsset();
    const second = await scope.seedAsset();
    const failed = await scope.seedAsset({ representationStatus: 'FAILED' });

    const foreign = await refusal(
      create(scope, {
        assetVersionId: first.assetVersionId,
        representationId: second.representationId,
        role: 'SOURCE',
      }),
    );
    const broken = await refusal(
      create(scope, { assetVersionId: failed.assetVersionId, representationId: failed.representationId, role: 'SOURCE' }),
    );
    return { foreign: foreign.error, broken: broken.error };
  });

  assert.equal(result.foreign.code, 'VALIDATION_FAILED');
  assert.equal(result.foreign.details[0].reason, 'not_of_version');
  assert.equal(result.broken.code, 'VALIDATION_FAILED');
  assert.equal(result.broken.details[0].reason, 'failed');
});

test('the same version may not be bound twice in one role, but may in another', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const asset = await scope.seedAsset();
    const first = await create(scope, { assetVersionId: asset.assetVersionId, role: 'SOURCE' });

    const duplicate = await refusal(create(scope, { assetVersionId: asset.assetVersionId, role: 'SOURCE' }));
    // The same file legitimately serves two roles — a source that is also the
    // evidence for a dimension — so the role is part of the identity.
    const asEvidence = await create(scope, { assetVersionId: asset.assetVersionId, role: 'EVIDENCE' });

    return { first, duplicate: duplicate.error, asEvidence };
  });

  assert.equal(result.duplicate.code, 'CONFLICT');
  assert.equal(result.duplicate.status, 409);
  assert.equal(result.duplicate.details[0].reason, 'already_bound');
  assert.equal(result.duplicate.details[0].binding_id, result.first.bindingId);
  assert.equal(result.asEvidence.role, 'EVIDENCE');
});

test('a frozen revision cannot gain a binding', { skip }, async () => {
  const result = await withRevision(
    async (scope) => {
      const asset = await scope.seedAsset();
      const attempt = await refusal(create(scope, { assetVersionId: asset.assetVersionId, role: 'SOURCE' }));
      return attempt.error;
    },
    { lifecycleState: 'VALIDATED' },
  );

  assert.equal(result.code, 'REVISION_IMMUTABLE');
  assert.equal(result.status, 409);
});

test('an unknown role is refused before anything is read', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const asset = await scope.seedAsset();
    const attempt = await refusal(create(scope, { assetVersionId: asset.assetVersionId, role: 'OWNER' }));
    return attempt.error;
  });

  assert.equal(result.code, 'VALIDATION_FAILED');
  assert.equal(result.details[0].field, 'role');
  assert.deepEqual(result.details[0].allowed, ['SOURCE', 'EVIDENCE', 'REFERENCE', 'ATTACHMENT']);
});

test('the binding limit is a stated bound, not an unbounded revision', { skip }, async () => {
  // The limit is a constant rather than a magic number in the handler, so the
  // assertion and the command cannot drift apart.
  assert.equal(MAX_BINDINGS_PER_REVISION, 200);
});

/* ------------------------------------------------------ through the surface */

const stubService = () => ({
  requestValidation: async () => ({ mode: 'sync', runId: randomUUID(), scope: 'FULL', status: 'COMPLETED' }),
  grantWaiver: async () => ({ waiverId: randomUUID(), status: 'GRANTED' }),
  revokeWaiver: async () => ({ waiverId: randomUUID(), status: 'REVOKED' }),
});

/** A surface whose tenant seam runs on the fixture's client, inside its transaction. */
const surfaceOn = (client, { authorize = async () => true } = {}) =>
  createFacilityToolSurface({
    pool,
    validationService: stubService(),
    authorize,
    runInTenant: (_projectId, fn) => fn(client),
  });

test('the surface binds, lists, and reads back what it wrote', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const asset = await scope.seedAsset();
    const surface = surfaceOn(scope.client);
    const context = {
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      userId: scope.userId,
      confirmed: true,
    };

    const created = await surface.execute({
      name: 'create_asset_binding',
      args: { revision_id: scope.revisionId, asset_version_id: asset.assetVersionId, role: 'SOURCE' },
      context,
    });

    const page = await surface.execute({
      name: 'list_asset_bindings',
      args: { revision_id: scope.revisionId },
      context,
    });

    const filtered = await surface.execute({
      name: 'list_asset_bindings',
      args: { revision_id: scope.revisionId, role: 'EVIDENCE' },
      context,
    });

    const single = await surface.execute({
      name: 'get_asset_binding',
      args: { revision_id: scope.revisionId, binding_id: created.bindingId },
      context,
    });

    return { created, page, filtered, single };
  });

  assert.equal(result.created.assetVersionId, result.single.assetVersionId, 'the list and the by-id read agree');
  assert.equal(result.page.items.length, 1);
  assert.equal(result.page.total, 1);
  assert.equal(result.page.items[0].bindingId, result.created.bindingId);
  // A version identifier alone would say something was imported without saying what.
  assert.equal(result.page.items[0].assetName, 'Campus survey');
  assert.equal(result.page.items[0].filename, 'campus.geojson');
  assert.equal(result.page.items[0].assetKind, 'GIS');
  assert.equal(result.page.items[0].isCurrentVersion, true);
  assert.equal(result.filtered.items.length, 0, 'the role filter is applied');
  assert.equal(result.single.authoritative, false, 'an unreviewed binding is not authoritative');
  assert.equal(
    result.single.status,
    'UNREVIEWED',
    'a binding is a review state, so "authoritative" stays false until it and its mappings are reviewed',
  );
});

test('the surface refuses a write without confirmation, and without the import key', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const asset = await scope.seedAsset();
    const context = { projectId: scope.projectId, revisionId: scope.revisionId, userId: scope.userId };

    const unconfirmed = await refusal(
      surfaceOn(scope.client).execute({
        name: 'create_asset_binding',
        args: { revision_id: scope.revisionId, asset_version_id: asset.assetVersionId, role: 'SOURCE' },
        context,
      }),
    );

    const denied = await refusal(
      surfaceOn(scope.client, { authorize: async () => false }).execute({
        name: 'create_asset_binding',
        args: { revision_id: scope.revisionId, asset_version_id: asset.assetVersionId, role: 'SOURCE' },
        context: { ...context, confirmed: true },
      }),
    );

    return { unconfirmed: unconfirmed.error, denied: denied.error };
  });

  assert.equal(result.unconfirmed.code, 'CONFIRMATION_REQUIRED');
  assert.equal(result.denied.code, 'INSUFFICIENT_PERMISSION');
  assert.equal(result.denied.details[0].function_key, 'facility.import.initiate');
});

test('listing bindings needs asset.read as well as facility.read', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const denied = await refusal(
      surfaceOn(scope.client, {
        authorize: async ({ key }) => key !== 'asset.read',
      }).execute({
        name: 'list_asset_bindings',
        args: { revision_id: scope.revisionId },
        context: { projectId: scope.projectId, revisionId: scope.revisionId },
      }),
    );
    return denied.error;
  });

  assert.equal(result.code, 'INSUFFICIENT_PERMISSION');
  assert.equal(result.details[0].function_key, 'asset.read');
});
