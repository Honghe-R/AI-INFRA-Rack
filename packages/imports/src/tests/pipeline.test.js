import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAssetService } from '@ai-infra/assets';
import { createPool } from '@ai-infra/db';
import { createFilesystemStorage } from '@ai-infra/storage';
import geojsonAdapter from '../adapters/geojson.js';
import { createAdapterRegistry, createDefaultRegistry, defineAdapter } from '../index.js';
import { createImportPipeline } from '../pipeline.js';
import { createSandbox } from '../sandbox.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;
let root;
let storage;
let registry;
let sandbox;

before(async () => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
  root = await mkdtemp(join(tmpdir(), 'ai-infra-imports-'));
  storage = createFilesystemStorage({ root });
  registry = createDefaultRegistry();
  sandbox = createSandbox({ timeoutMs: 30_000 });
});

after(async () => {
  if (pool) await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const { createRbacRepository } = await import('@ai-infra/rbac');
  const repository = createRbacRepository({ pool });
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `imports-member-${suffix}` });
  const organization = await repository.createOrganization({ name: `Imports Org ${suffix}`, ownerUserId: member.userId });
  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Imports Project',
  ]);
  return {
    member,
    organizationId: organization.organizationId,
    projectId,
    async cleanup() {
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id = $1', [member.userId]);
    },
  };
}

/** Stores a scan-clean asset version and returns its identifiers. */
async function storedAsset(f, { name, mediaType, bytes, kind = 'GIS' }) {
  const assets = createAssetService({ pool, storage });
  const reserved = await assets.reserveAsset({
    projectId: f.projectId,
    actorId: f.member.userId,
    name,
    kind,
    mediaType,
  });
  const intake = await assets.intakeContent({
    projectId: f.projectId,
    actorId: f.member.userId,
    assetId: reserved.asset.assetId,
    assetVersionId: reserved.version.assetVersionId,
    body: bytes,
  });
  assert.equal(intake.scan.verdict, 'CLEAN');
  return { assetId: reserved.asset.assetId, assetVersionId: reserved.version.assetVersionId };
}

const GEOJSON = Buffer.from(
  JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'p1', properties: { use: 'utility' }, geometry: { type: 'Point', coordinates: [121.47, 31.23] } },
      { type: 'Feature', id: 'p2', properties: { use: 'office' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    ],
  }),
);

test('the pipeline produces FEATURES and GEOREFERENCE representations through the sandbox', { skip }, async () => {
  const f = await fixture();
  try {
    const { assetId, assetVersionId } = await storedAsset(f, {
      name: 'points.geojson',
      mediaType: 'application/geo+json',
      bytes: GEOJSON,
    });
    const pipeline = createImportPipeline({ pool, storage, registry, sandbox });

    const report = await pipeline.processAssetVersion({ projectId: f.projectId, assetVersionId, actorId: f.member.userId });
    assert.equal(report.skipped, false);
    assert.equal(report.adapter.adapterId, 'geojson');
    assert.equal(report.counts.extracted, 2);
    assert.equal(report.counts.mapped, 2);
    assert.equal(report.georeference.sourceCrs, 'EPSG:4326');

    const assets = createAssetService({ pool, storage });
    const asset = await assets.getAsset({ projectId: f.projectId, assetId });
    const kinds = asset.representations.map((representation) => representation.kind).sort();
    assert.deepEqual(kinds, ['FEATURES', 'GEOREFERENCE', 'ORIGINAL']);
    assert.equal(asset.representations.find((row) => row.kind === 'FEATURES').producerId, 'geojson');

    // The FEATURES representation is real and readable.
    const features = asset.representations.find((representation) => representation.kind === 'FEATURES');
    assert.ok(features, 'a FEATURES representation exists');
    const object = await storage.getObject({ key: features.storageKey });
    const chunks = [];
    for await (const chunk of object.body) chunks.push(chunk);
    const stored = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(stored.features.length, 2);
    assert.equal(stored.features[0].geojson.coordinates[0], 121.47);
  } finally {
    await f.cleanup();
  }
});

test('processing is idempotent, a rerun replaces in place, and a producer bump marks the old one stale', { skip }, async () => {
  const f = await fixture();
  try {
    const { assetId, assetVersionId } = await storedAsset(f, { name: 'points.geojson', mediaType: 'application/geo+json', bytes: GEOJSON });
    const pipeline = createImportPipeline({ pool, storage, registry, sandbox });

    const first = await pipeline.processAssetVersion({ projectId: f.projectId, assetVersionId });
    const second = await pipeline.processAssetVersion({ projectId: f.projectId, assetVersionId });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'already-processed');
    assert.deepEqual(second.representationIds, first.representationIds);

    // D25: re-running the same producer version replaces its record in place, so
    // the identifiers are stable and no second row appears.
    const forced = await pipeline.processAssetVersion({ projectId: f.projectId, assetVersionId, force: true });
    assert.equal(forced.skipped, false);
    assert.deepEqual(forced.representationIds, first.representationIds);

    const assets = createAssetService({ pool, storage });
    let asset = await assets.getAsset({ projectId: f.projectId, assetId });
    assert.equal(asset.representations.filter((row) => row.kind === 'FEATURES').length, 1);

    // A newer producer version supersedes the older one, which is kept and stale.
    const upgraded = defineAdapter({
      descriptor: { ...geojsonAdapter.descriptor, adapter_version: '2.0.0' },
      extract: geojsonAdapter.extract,
    });
    const upgradedPipeline = createImportPipeline({
      pool,
      storage,
      registry: createAdapterRegistry({ adapters: [geojsonAdapter, upgraded] }),
      sandbox,
    });
    const bumped = await upgradedPipeline.processAssetVersion({ projectId: f.projectId, assetVersionId });
    assert.equal(bumped.adapter.adapterVersion, '2.0.0');

    asset = await assets.getAsset({ projectId: f.projectId, assetId });
    const featureRows = asset.representations.filter((representation) => representation.kind === 'FEATURES');
    assert.equal(featureRows.length, 2, 'the old producer record is kept, not overwritten');
    assert.deepEqual(featureRows.map((row) => `${row.producerVersion}:${row.status}`).sort(), ['1.0.0:STALE', '2.0.0:READY']);
  } finally {
    await f.cleanup();
  }
});

test('an unsupported media type is refused before any representation is written', { skip }, async () => {
  const f = await fixture();
  try {
    const { assetId, assetVersionId } = await storedAsset(f, {
      name: 'mystery.bin',
      mediaType: 'application/x-unknown',
      bytes: Buffer.from('???'),
      kind: 'OTHER',
    });
    const pipeline = createImportPipeline({ pool, storage, registry, sandbox });
    await assert.rejects(
      pipeline.processAssetVersion({ projectId: f.projectId, assetVersionId }),
      (error) => {
        assert.equal(error.code, 'import.adapter.unsupported');
        assert.equal(error.status, 422);
        return true;
      },
    );

    const assets = createAssetService({ pool, storage });
    const asset = await assets.getAsset({ projectId: f.projectId, assetId });
    assert.deepEqual(asset.representations.map((row) => row.kind), ['ORIGINAL']);
  } finally {
    await f.cleanup();
  }
});

test('a quarantined version is never processed', { skip }, async () => {
  const f = await fixture();
  try {
    const assets = createAssetService({
      pool,
      storage,
      scanner: { async scan() { return { verdict: 'INFECTED' }; } },
    });
    const reserved = await assets.reserveAsset({
      projectId: f.projectId,
      actorId: f.member.userId,
      name: 'bad.geojson',
      kind: 'GIS',
      mediaType: 'application/geo+json',
    });
    const intake = await assets.intakeContent({
      projectId: f.projectId,
      actorId: f.member.userId,
      assetId: reserved.asset.assetId,
      assetVersionId: reserved.version.assetVersionId,
      body: GEOJSON,
    });
    assert.equal(intake.scan.quarantined, true);

    const pipeline = createImportPipeline({ pool, storage, registry, sandbox });
    await assert.rejects(
      pipeline.processAssetVersion({ projectId: f.projectId, assetVersionId: reserved.version.assetVersionId }),
      (error) => error.code === 'ASSET_QUARANTINED',
    );
  } finally {
    await f.cleanup();
  }
});
