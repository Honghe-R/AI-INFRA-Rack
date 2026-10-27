import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPool } from '@ai-infra/db';
import { createFilesystemStorage } from '@ai-infra/storage';
import { createAssetService, createPassThroughScanner } from '../service.js';
import { sha256HexOf } from '../checksum.js';
import { ASSET_DIAGNOSTICS } from '../diagnostics.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;
let root;
let storage;

before(async () => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
  root = await mkdtemp(join(tmpdir(), 'ai-infra-assets-'));
  storage = createFilesystemStorage({ root });
});

after(async () => {
  if (pool) await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});

/** A project owned by a user, with asset permissions from organisation-admin. */
async function fixture() {
  const { createRbacRepository } = await import('@ai-infra/rbac');
  const repository = createRbacRepository({ pool });
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `assets-member-${suffix}` });
  const viewer = await repository.createUser({ subject: `assets-viewer-${suffix}` });
  const organization = await repository.createOrganization({
    name: `Assets Org ${suffix}`,
    ownerUserId: member.userId,
  });
  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Asset Project',
  ]);

  return {
    member,
    viewer,
    organizationId: organization.organizationId,
    projectId,
    service: createAssetService({ pool, storage }),
    async cleanup() {
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      await pool.query('DELETE FROM users WHERE user_id IN ($1, $2)', [member.userId, viewer.userId]);
    },
  };
}

async function upload(service, projectId, actorId, name, bytes, { kind = 'CAD', mediaType = 'image/vnd.dxf', maxBytes } = {}) {
  const reserved = await service.reserveAsset({
    projectId,
    actorId,
    name,
    kind,
    mediaType,
    declaredSizeBytes: bytes.length,
    ...(maxBytes ? {} : {}),
  });
  const intake = await service.intakeContent({
    projectId,
    actorId,
    assetId: reserved.asset.assetId,
    assetVersionId: reserved.version.assetVersionId,
    body: bytes,
    declaredSizeBytes: bytes.length,
  });
  return { reserved, intake };
}

test('intake streams bytes, observes the checksum, and creates the ORIGINAL representation', { skip }, async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('SITE PLAN v1');
    const { reserved, intake } = await upload(f.service, f.projectId, f.member.userId, 'site-plan.dxf', bytes);

    assert.equal(reserved.version.intakeState, 'PENDING', 'reserve records no bytes');
    assert.equal(intake.version.intakeState, 'COMPLETE');
    assert.equal(intake.version.contentChecksum, sha256HexOf(bytes));
    assert.equal(intake.version.sizeBytes, bytes.length);
    assert.equal(intake.version.status, 'CURRENT');
    assert.equal(intake.deduplicated, false);
    assert.equal(intake.scan.verdict, 'CLEAN');

    const representation = await intake;
    assert.ok(representation.representation, 'an ORIGINAL representation exists');
    assert.equal(representation.representation.kind, 'ORIGINAL');
    assert.equal(representation.representation.contentChecksum, sha256HexOf(bytes));

    const stored = await readFile(join(root, intake.version.storageKey));
    assert.equal(stored.toString('utf8'), 'SITE PLAN v1', 'the exact bytes reached storage');

    const asset = await f.service.getAsset({ projectId: f.projectId, assetId: reserved.asset.assetId });
    assert.equal(asset.currentVersionId, intake.version.assetVersionId);
    assert.equal(asset.versionCount, 1);
    assert.equal(asset.versions[0].malwareScanState, 'CLEAN');
    assert.equal(asset.representations.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('identical bytes in one asset reuse the existing version and store one object', { skip }, async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('IDENTICAL-BYTES');
    const first = await upload(f.service, f.projectId, f.member.userId, 'a.dxf', bytes);

    const second = await f.service.reserveVersion({
      projectId: f.projectId,
      actorId: f.member.userId,
      assetId: first.reserved.asset.assetId,
      filename: 'a.dxf',
    });
    const replayed = await f.service.intakeContent({
      projectId: f.projectId,
      actorId: f.member.userId,
      assetId: first.reserved.asset.assetId,
      assetVersionId: second.version.assetVersionId,
      body: bytes,
    });

    assert.equal(replayed.deduplicated, true);
    assert.equal(replayed.version.assetVersionId, first.intake.version.assetVersionId, 'the existing version is reused');

    const asset = await f.service.getAsset({ projectId: f.projectId, assetId: first.reserved.asset.assetId });
    assert.equal(asset.versionCount, 1, 'no second version is recorded');
  } finally {
    await f.cleanup();
  }
});

test('identical bytes in a different asset keep per-asset versions and share one object', { skip }, async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('SHARED-CONTENT');
    const first = await upload(f.service, f.projectId, f.member.userId, 'first.dxf', bytes);
    const second = await upload(f.service, f.projectId, f.member.userId, 'second.dxf', bytes);

    assert.equal(second.intake.deduplicated, false, 'the second asset owns its own version');
    assert.notEqual(second.intake.version.assetVersionId, first.intake.version.assetVersionId);
    assert.equal(
      second.intake.version.storageKey,
      first.intake.version.storageKey,
      'the stored object is reused (D24)',
    );
    assert.equal(second.intake.version.contentChecksum, first.intake.version.contentChecksum);
  } finally {
    await f.cleanup();
  }
});

test('a body over the limit aborts intake and records nothing', { skip }, async () => {
  const f = await fixture();
  try {
    const bounded = createAssetService({ pool, storage, limits: { maxBytes: 8 } });

    // A declared size over the limit is refused before a byte is stored.
    await assert.rejects(
      bounded.reserveAsset({
        projectId: f.projectId,
        actorId: f.member.userId,
        name: 'declared-too-big.dxf',
        kind: 'CAD',
        mediaType: 'image/vnd.dxf',
        declaredSizeBytes: 9,
      }),
      (error) => error.code === 'PAYLOAD_TOO_LARGE',
    );

    // An undeclared size is caught in flight: the stream is failed the moment the
    // limit is crossed, not after the whole body has been read.
    const reserved = await bounded.reserveAsset({
      projectId: f.projectId,
      actorId: f.member.userId,
      name: 'too-big.dxf',
      kind: 'CAD',
      mediaType: 'image/vnd.dxf',
    });
    await assert.rejects(
      bounded.intakeContent({
        projectId: f.projectId,
        actorId: f.member.userId,
        assetId: reserved.asset.assetId,
        assetVersionId: reserved.version.assetVersionId,
        body: Buffer.from('0123456789'),
      }),
      (error) => {
        assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
        assert.equal(error.status, 413);
        return true;
      },
    );

    assert.equal(
      await f.service.getAsset({ projectId: f.projectId, assetId: reserved.asset.assetId }),
      null,
      'the abandoned asset is not left behind',
    );
  } finally {
    await f.cleanup();
  }
});

test('an infected verdict quarantines the version and the asset', { skip }, async () => {
  const f = await fixture();
  try {
    const infected = createAssetService({
      pool,
      storage,
      scanner: { async scan() { return { verdict: 'INFECTED' }; } },
    });
    const bytes = Buffer.from('MALWARE');
    const { intake } = await upload(infected, f.projectId, f.member.userId, 'infected.dxf', bytes);

    assert.equal(intake.scan.quarantined, true);
    assert.equal(intake.version.malwareScanState, 'INFECTED');
    assert.equal(intake.version.status, 'QUARANTINED');
    assert.equal(intake.asset.status, 'QUARANTINED');

    const downloaded = infected.createDownloadUrl({
      projectId: f.projectId,
      assetId: intake.asset.assetId,
      assetVersionId: intake.version.assetVersionId,
    });
    await assert.rejects(downloaded, (error) => error.code === 'ASSET_QUARANTINED');
  } finally {
    await f.cleanup();
  }
});

test('an active hold blocks deletion and releasing it permits the delete', { skip }, async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('HOLD-ME');
    const { reserved, intake } = await upload(f.service, f.projectId, f.member.userId, 'held.dxf', bytes);

    const hold = await f.service.createHold({
      projectId: f.projectId,
      assetId: reserved.asset.assetId,
      reason: 'litigation',
      authority: 'legal',
      actorId: f.member.userId,
    });

    await assert.rejects(
      f.service.deleteAsset({ projectId: f.projectId, assetId: reserved.asset.assetId }),
      (error) => {
        assert.equal(error.code, 'ASSET_REFERENCED');
        assert.equal(error.details[0].constraint_id, ASSET_DIAGNOSTICS.RETENTION_HOLD.constraintId);
        return true;
      },
    );

    await f.service.releaseHold({ projectId: f.projectId, holdId: hold.holdId, reason: 'released', actorId: f.member.userId });
    const deleted = await f.service.deleteAsset({ projectId: f.projectId, assetId: reserved.asset.assetId });
    assert.equal(deleted.deleted, true);
    assert.deepEqual(deleted.removedVersions, [intake.version.assetVersionId]);
    assert.equal(await f.service.getAsset({ projectId: f.projectId, assetId: reserved.asset.assetId }), null);
  } finally {
    await f.cleanup();
  }
});

test('a RESTRICTED asset requires an explicit per-asset grant', { skip }, async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('CONFIDENTIAL');
    const reserved = await f.service.reserveAsset({
      projectId: f.projectId,
      actorId: f.member.userId,
      name: 'secret.dxf',
      kind: 'CAD',
      mediaType: 'image/vnd.dxf',
      accessClassification: 'RESTRICTED',
    });
    await f.service.intakeContent({
      projectId: f.projectId,
      actorId: f.member.userId,
      assetId: reserved.asset.assetId,
      assetVersionId: reserved.version.assetVersionId,
      body: bytes,
    });

    // The uploader is granted on creation, so a creator never loses access.
    assert.ok(await f.service.getAsset({ projectId: f.projectId, assetId: reserved.asset.assetId, actorId: f.member.userId }));

    await assert.rejects(
      f.service.getAsset({ projectId: f.projectId, assetId: reserved.asset.assetId, actorId: f.viewer.userId }),
      (error) => {
        assert.equal(error.code, 'ASSET_ACCESS_DENIED');
        assert.equal(error.status, 403);
        return true;
      },
    );

    const listed = await f.service.listAssets({ projectId: f.projectId, actorId: f.viewer.userId });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].authorized, false, 'a blocked asset stays visible, never silently absent');

    await f.service.createGrant({
      projectId: f.projectId,
      assetId: reserved.asset.assetId,
      granteeId: f.viewer.userId,
      actorId: f.member.userId,
    });
    assert.ok(
      await f.service.getAsset({ projectId: f.projectId, assetId: reserved.asset.assetId, actorId: f.viewer.userId }),
      'the grant authorizes the read',
    );

    await f.service.revokeGrant({
      projectId: f.projectId,
      assetId: reserved.asset.assetId,
      granteeId: f.viewer.userId,
      actorId: f.member.userId,
    });
    await assert.rejects(
      f.service.getAsset({ projectId: f.projectId, assetId: reserved.asset.assetId, actorId: f.viewer.userId }),
      (error) => error.code === 'ASSET_ACCESS_DENIED',
    );

    // A grant on an unrestricted asset is meaningless and is refused.
    const open = await upload(f.service, f.projectId, f.member.userId, 'open.dxf', Buffer.from('OPEN'));
    await assert.rejects(
      f.service.createGrant({
        projectId: f.projectId,
        assetId: open.reserved.asset.assetId,
        granteeId: f.viewer.userId,
        actorId: f.member.userId,
      }),
      (error) => error.code === 'VALIDATION_FAILED',
    );
  } finally {
    await f.cleanup();
  }
});

test('the integrity check reports a mismatch when stored bytes are altered', { skip }, async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('ORIGINAL');
    const { intake } = await upload(f.service, f.projectId, f.member.userId, 'check.dxf', bytes);

    const clean = await f.service.verifyStoredChecksum({
      projectId: f.projectId,
      assetVersionId: intake.version.assetVersionId,
    });
    assert.equal(clean.verified, true);

    await writeFile(join(root, intake.version.storageKey), 'TAMPERED');
    const tampered = await f.service.verifyStoredChecksum({
      projectId: f.projectId,
      assetVersionId: intake.version.assetVersionId,
    });
    assert.equal(tampered.verified, false);
    assert.equal(tampered.diagnostic.constraintId, ASSET_DIAGNOSTICS.CHECKSUM_MISMATCH.constraintId);
  } finally {
    await f.cleanup();
  }
});

test('the pass-through scanner is the development default', () => {
  assert.equal(typeof createPassThroughScanner().scan, 'function');
});
