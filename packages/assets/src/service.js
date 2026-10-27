import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant, assertUuid } from '@ai-infra/db';
import { StorageCapabilityError } from '@ai-infra/storage';
import { AssetTooLargeError, createHashingCounter } from './checksum.js';
import { ASSET_DIAGNOSTICS } from './diagnostics.js';
import { isValidMediaType, kindForMediaType, uploadLimits } from './limits.js';
import { originalKey, representationKey } from './keys.js';
import * as repo from './repository.js';

/**
 * Project asset service.
 *
 * Implements doc/workspace/project-assets.md: one project-scoped asset with
 * immutable versions, API-mediated streaming intake (D23), server-observed
 * checksums, project-level object reuse with per-asset version rows (D24),
 * representations, provenance, access classification, retention and legal hold,
 * and the asset diagnostics.
 *
 * Transaction shape. Intake is three short transactions, never one long one:
 *   1. reserve   -- asset and pending version exist, no bytes yet.
 *   2. stream    -- outside any transaction; hash and store the bytes.
 *   3. finalize  -- record the observed checksum, reuse or keep the object,
 *                   create the ORIGINAL representation, enqueue the scan.
 * Holding a transaction across a multi-gigabyte upload would pin a connection
 * and a snapshot for the duration of the transfer.
 *
 * Malware scanning is injected. There is no scanner in development, so the
 * default pass-through reports CLEAN and the scan job still completes; a
 * deployment injects a real scanner and an INFECTED or FAILED verdict
 * quarantines the version and the asset.
 */

export const ASSET_EVENTS = Object.freeze({
  CREATED: 'asset.created.v1',
  PROCESSED: 'asset.processed.v1',
  VERSION_SUPERSEDED: 'asset.version.superseded.v1',
  QUARANTINED: 'asset.quarantined.v1',
  DELETED: 'asset.deleted.v1',
});

export const ORIGINAL_PRODUCER = Object.freeze({ id: 'original', version: '1' });

export function createPassThroughScanner() {
  return {
    async scan() {
      return { verdict: 'CLEAN' };
    },
  };
}

export function createAssetService({
  pool,
  storage,
  scanner = createPassThroughScanner(),
  limits = {},
  logger = null,
  processor = null,
} = {}) {
  if (!pool) throw new Error('createAssetService requires a database pool.');
  if (!storage) throw new Error('createAssetService requires a storage adapter.');
  const effectiveLimits = uploadLimits(limits);

  async function reserveAsset({
    projectId,
    actorId = null,
    name,
    kind = null,
    mediaType,
    filename = null,
    sourceRef = 'user-upload',
    accessClassification = 'PROJECT',
    retentionClass = 'PROJECT_ASSET',
    tags = [],
    declaredSizeBytes = null,
    correlationId = null,
  }) {
    assertUuid(projectId);
    const assetId = randomUUID();
    const assetVersionId = randomUUID();
    const cleanName = requireText(name, 'name');
    const cleanMediaType = requireMediaType(mediaType);
    const cleanKind = kind ?? kindForMediaType(cleanMediaType);
    const cleanFilename = filename ?? cleanName;
    assertDeclaredSize(declaredSizeBytes, effectiveLimits.maxBytes);

    const { asset, version } = await withTenant(pool, projectId, async (client) => {
      const created = await repo.insertAssetAndPendingVersion(client, {
        assetId,
        assetVersionId,
        projectId,
        name: cleanName,
        kind: cleanKind,
        mediaType: cleanMediaType,
        accessClassification,
        retentionClass,
        owner: actorId ?? 'system',
        tags,
        filename: cleanFilename,
        sourceRef,
        provenance: { source_ref: sourceRef, owner: actorId ?? 'system' },
        actorId,
      });

      const assetRow = await repo.getAsset(client, projectId, assetId);
      // A restricted asset grants its creator on creation, so the uploader never
      // loses access to what they just uploaded (project-assets.md, "Access
      // Control").
      if (accessClassification === 'RESTRICTED' && actorId) {
        await repo.insertGrant(client, {
          grantId: randomUUID(),
          projectId,
          assetId,
          granteeId: actorId,
          grantedBy: actorId,
        });
      }
      await repo.insertOutboxEvent(client, {
        projectId,
        eventId: randomUUID(),
        eventType: ASSET_EVENTS.CREATED,
        aggregateType: 'project_asset',
        aggregateId: assetId,
        payload: {
          asset_id: assetId,
          asset_version_id: assetVersionId,
          kind: cleanKind,
          media_type: cleanMediaType,
        },
        correlationId,
        actorId,
      });
      return { asset: assetRow, version: created };
    });

    return { asset, version, limits: effectiveLimits };
  }

  async function reserveVersion({
    projectId,
    actorId = null,
    assetId,
    filename,
    mediaType = null,
    sourceRef = 'user-upload',
    declaredSizeBytes = null,
    correlationId = null,
  }) {
    assertUuid(projectId);
    assertUuid(assetId, 'asset_id');
    const assetVersionId = randomUUID();

    const result = await withTenant(pool, projectId, async (client) => {
      const asset = await repo.getAsset(client, projectId, assetId);
      if (!asset) throw errors.notFound('The requested resource was not found.');
      await assertAccess(client, projectId, asset, actorId);
      if (asset.quarantined) {
        throw new ApiError('ASSET_QUARANTINED', 'A quarantined asset cannot receive a new version.', { status: 409 });
      }
      if (asset.archived) {
        throw new ApiError('ASSET_ARCHIVED', 'An archived asset must be restored before it can receive a new version.', { status: 409 });
      }
      const cleanMediaType = requireMediaType(mediaType ?? asset.mediaType);
      assertDeclaredSize(declaredSizeBytes, effectiveLimits.maxBytes);

      const version = await repo.insertPendingVersion(client, {
        assetVersionId,
        projectId,
        assetId,
        filename: filename ?? asset.name,
        mediaType: cleanMediaType,
        sourceRef,
        provenance: { source_ref: sourceRef, owner: actorId ?? 'system' },
        actorId,
      });

      await repo.insertOutboxEvent(client, {
        projectId,
        eventId: randomUUID(),
        eventType: ASSET_EVENTS.CREATED,
        aggregateType: 'project_asset',
        aggregateId: assetId,
        payload: { asset_id: assetId, asset_version_id: assetVersionId, kind: asset.kind, media_type: cleanMediaType },
        correlationId,
        actorId,
      });
      return { asset, version, limits: effectiveLimits };
    });

    return result;
  }

  /**
   * Streams the bytes of a pending version to object storage, hashing as it goes
   * (D23). On any failure the pending version is removed and the partial object
   * is deleted, so an aborted intake records nothing.
   */
  async function intakeContent({
    projectId,
    actorId = null,
    assetId,
    assetVersionId,
    body,
    contentType = null,
    declaredSizeBytes = null,
    correlationId = null,
  }) {
    assertUuid(projectId);
    assertUuid(assetId, 'asset_id');
    assertUuid(assetVersionId, 'asset_version_id');
    assertDeclaredSize(declaredSizeBytes, effectiveLimits.maxBytes);

    const pending = await withTenant(
      pool,
      projectId,
      async (client) => {
        const version = await repo.getVersion(client, projectId, assetVersionId);
        if (!version || version.assetId !== assetId) return null;
        await assertAccess(client, projectId, await repo.getAsset(client, projectId, assetId), actorId);
        return version;
      },
      { readOnly: true },
    );
    if (!pending) throw errors.notFound('The requested resource was not found.');
    if (pending.intakeState !== 'PENDING') {
      throw new ApiError('ASSET_INTAKE_NOT_PENDING', 'This version already has content.', { status: 409 });
    }

    const key = originalKey({ projectId, assetId, assetVersionId });
    const counter = createHashingCounter({ maxBytes: effectiveLimits.maxBytes });
    const source = toReadable(body);

    // A limit breach is signalled by the transform's own 'error' event, which can
    // fire before the storage pipeline has attached its listener. Recording it
    // here keeps it from becoming an unhandled stream error and lets the failure
    // be reported as the upload error it is.
    let streamError = null;
    counter.stream.once('error', (error) => {
      streamError = error;
    });

    // The bytes flow through the counter on their way to storage, so the write and
    // the hash are the same pass over the data (D23).
    source.pipe(counter.stream);

    try {
      await storage.putObject({
        key,
        body: counter.stream,
        contentType: contentType ?? pending.mediaType,
        contentLength: declaredSizeBytes,
      });
    } catch (error) {
      const failure = streamError ?? error;
      await deleteObjectQuietly(storage, key);
      await discardPendingVersion(projectId, assetId, assetVersionId);
      throw mapIntakeError(failure, effectiveLimits.maxBytes);
    }

    if (streamError) {
      await deleteObjectQuietly(storage, key);
      await discardPendingVersion(projectId, assetId, assetVersionId);
      throw mapIntakeError(streamError, effectiveLimits.maxBytes);
    }

    let digest;
    try {
      digest = counter.digest();
    } catch (error) {
      await deleteObjectQuietly(storage, key);
      await discardPendingVersion(projectId, assetId, assetVersionId);
      throw new ApiError('ASSET_CHECKSUM_MISSING', 'The upload ended without a verifiable checksum.', {
        status: 422,
        details: [{ constraint_id: ASSET_DIAGNOSTICS.CHECKSUM_MISSING.constraintId }],
      });
    }

    const outcome = await withTenant(pool, projectId, async (client) => {
      const existing = await repo.findCompletedVersionByChecksum(client, projectId, digest.checksum, {
        excludeVersionId: assetVersionId,
      });

      // Identical bytes already held. Within one asset the existing version is
      // reused and the pending row is removed; across assets the new asset keeps
      // its own version row and reuses the stored object (D24).
      if (existing && existing.assetId === assetId) {
        await repo.deleteVersion(client, projectId, assetVersionId);
        const asset = await repo.refreshAssetCurrentVersion(client, {
          projectId,
          assetId,
          currentVersionId: existing.assetVersionId,
          actorId,
        });
        return { asset, version: existing, deduplicated: true, orphanKey: key, keptKey: existing.storageKey };
      }

      const storageKey = existing ? existing.storageKey : key;
      const completed = await repo.completeVersion(client, {
        projectId,
        assetVersionId,
        checksum: digest.checksum,
        sizeBytes: digest.sizeBytes,
        storageKey,
        actorId,
      });

      await repo.supersedeOtherVersions(client, { projectId, assetId, keepAssetVersionId: assetVersionId });
      const asset = await repo.refreshAssetCurrentVersion(client, {
        projectId,
        assetId,
        currentVersionId: assetVersionId,
        actorId,
      });

      const representation = await repo.upsertRepresentation(client, {
        representationId: randomUUID(),
        projectId,
        assetVersionId,
        kind: 'ORIGINAL',
        mediaType: completed.mediaType,
        checksum: digest.checksum,
        storageKey,
        producerId: ORIGINAL_PRODUCER.id,
        producerVersion: ORIGINAL_PRODUCER.version,
        status: 'READY',
        actorId,
      });

      const job = await repo.insertJob(client, {
        jobId: randomUUID(),
        projectId,
        assetVersionId,
        jobType: 'SCAN',
        payload: { storage_key: storageKey, media_type: completed.mediaType, size_bytes: digest.sizeBytes },
        actorId,
      });

      return {
        asset,
        version: completed,
        representation,
        job,
        deduplicated: false,
        orphanKey: existing ? key : null,
        keptKey: storageKey,
      };
    });

    if (outcome.orphanKey && outcome.orphanKey !== outcome.keptKey) {
      await deleteObjectQuietly(storage, outcome.orphanKey);
    }

    const scan = outcome.job
      ? await runScanJob({ projectId, actorId, jobId: outcome.job.jobId, assetVersionId, correlationId })
      : null;

    // Representation production is the import framework's job, injected as a
    // processor so the asset layer stays independent of any format. A conversion
    // failure never fails the upload: the asset is stored and can be reprocessed.
    let processing = null;
    if (scan && !scan.quarantined && processor) {
      try {
        processing = await processor.processAssetVersion({ projectId, assetVersionId, actorId, correlationId });
      } catch (error) {
        logger?.warn?.('asset.processing_failed', { assetVersionId, error: error?.message });
        processing = { error: error.message, code: error.code ?? null };
      }
    }

    return {
      asset: scan?.asset ?? outcome.asset,
      version: scan?.version ?? outcome.version,
      representation: outcome.representation ?? null,
      deduplicated: outcome.deduplicated,
      scan,
      processing,
      limits: effectiveLimits,
    };
  }

  /**
   * Runs the scan step of intake. Keeping it as a method (rather than inlining
   * it) is what lets a test inject a scanner that reports INFECTED and assert
   * the quarantine path.
   */
  async function runScanJob({ projectId, actorId = null, jobId, assetVersionId, correlationId = null }) {
    const context = await withTenant(
      pool,
      projectId,
      async (client) => ({
        version: await repo.getVersion(client, projectId, assetVersionId),
        job: await repo.getJob(client, projectId, jobId),
      }),
      { readOnly: true },
    );
    if (!context.version) throw errors.notFound('The requested resource was not found.');

    let verdict = 'FAILED';
    try {
      const result = await scanner.scan({
        projectId,
        assetVersionId,
        storageKey: context.version.storageKey,
        mediaType: context.version.mediaType,
        sizeBytes: context.version.sizeBytes,
      });
      verdict = result?.verdict ?? 'FAILED';
    } catch {
      verdict = 'FAILED';
    }

    return withTenant(pool, projectId, async (client) => {
      if (verdict === 'CLEAN') {
        const version = await repo.setVersionScanState(client, {
          projectId,
          assetVersionId,
          scanState: 'CLEAN',
          actorId,
        });
        const asset = await repo.getAsset(client, projectId, version.assetId);
        await repo.completeJob(client, {
          projectId,
          jobId,
          state: 'SUCCEEDED',
          result: { verdict },
        });
        await repo.insertOutboxEvent(client, {
          projectId,
          eventId: randomUUID(),
          eventType: ASSET_EVENTS.PROCESSED,
          aggregateType: 'asset_version',
          aggregateId: assetVersionId,
          payload: { asset_id: version.assetId, asset_version_id: assetVersionId, verdict },
          correlationId,
          actorId,
        });
        return { verdict, quarantined: false, version, asset };
      }

      const version = await repo.setVersionScanState(client, {
        projectId,
        assetVersionId,
        scanState: verdict === 'INFECTED' ? 'INFECTED' : 'FAILED',
        versionStatus: 'QUARANTINED',
        actorId,
      });
      const asset = await repo.setAssetStatus(client, {
        projectId,
        assetId: version.assetId,
        status: 'QUARANTINED',
        actorId,
      });
      await repo.completeJob(client, { projectId, jobId, state: 'FAILED', result: { verdict }, errorMessage: `scan verdict ${verdict}` });
      await repo.insertOutboxEvent(client, {
        projectId,
        eventId: randomUUID(),
        eventType: ASSET_EVENTS.QUARANTINED,
        aggregateType: 'asset_version',
        aggregateId: assetVersionId,
        payload: { asset_id: version.assetId, asset_version_id: assetVersionId, verdict },
        correlationId,
        actorId,
      });
      return { verdict, quarantined: true, version, asset };
    });
  }

  async function getAsset({ projectId, assetId, actorId = null }) {
    assertUuid(projectId);
    return withTenant(
      pool,
      projectId,
      async (client) => {
        const asset = await repo.getAsset(client, projectId, assetId);
        if (!asset) return null;
        await assertAccess(client, projectId, asset, actorId);
        const versions = await repo.listVersions(client, projectId, assetId);
        // Representations belong to a version, not to an asset, and a tool binds an
        // exact version (ui-pattern.md, "Import Entry Points" 3). Reading them for
        // every version is what lets a picker offer the version and the
        // representation as one choice; reading them for the newest version alone
        // would offer a pair the user cannot make for an older one. Versions per
        // asset are few, so the queries stay bounded.
        const detailed = await Promise.all(
          versions.map(async (version) => ({
            ...version,
            representations: await repo.listRepresentations(client, projectId, version.assetVersionId),
          })),
        );
        return {
          ...asset,
          versions: detailed,
          // Kept for callers that read the newest version's derivatives directly.
          representations: detailed[0]?.representations ?? [],
        };
      },
      { readOnly: true },
    );
  }

  async function listAssets({ projectId, actorId = null, ...filters }) {
    assertUuid(projectId);
    return withTenant(pool, projectId, (client) => repo.listAssets(client, projectId, { ...filters, actorId }), {
      readOnly: true,
    });
  }

  async function getJob({ projectId, jobId }) {
    assertUuid(projectId);
    return withTenant(pool, projectId, (client) => repo.getJob(client, projectId, jobId), { readOnly: true });
  }

  async function patchAsset({ projectId, assetId, actorId = null, ...patch }) {
    assertUuid(projectId);
    const updated = await withTenant(pool, projectId, async (client) => {
      const asset = await repo.getAsset(client, projectId, assetId);
      if (!asset) return null;
      await assertAccess(client, projectId, asset, actorId);
      return repo.updateAsset(client, { projectId, assetId, ...patch, actorId });
    });
    if (!updated) throw errors.notFound('The requested resource was not found.');
    return updated;
  }

  async function setArchived({ projectId, assetId, archived, actorId = null }) {
    assertUuid(projectId);
    const updated = await withTenant(pool, projectId, async (client) => {
      const asset = await repo.getAsset(client, projectId, assetId);
      if (!asset) return null;
      await assertAccess(client, projectId, asset, actorId);
      return repo.setAssetStatus(client, { projectId, assetId, status: archived ? 'ARCHIVED' : 'ACTIVE', actorId });
    });
    if (!updated) throw errors.notFound('The requested resource was not found.');
    return updated;
  }

  async function createDownloadUrl({
    projectId,
    actorId = null,
    assetId,
    assetVersionId = null,
    representationId = null,
    expiresIn = 900,
  }) {
    assertUuid(projectId);
    const target = await withTenant(
      pool,
      projectId,
      async (client) => {
        const asset = await repo.getAsset(client, projectId, assetId);
        if (!asset) return null;
        await assertAccess(client, projectId, asset, actorId);
        const version = assetVersionId
          ? await repo.getVersion(client, projectId, assetVersionId)
          : (await repo.listVersions(client, projectId, assetId))[0] ?? null;
        if (!version) return null;
        const representations = await repo.listRepresentations(client, projectId, version.assetVersionId);
        const representation = representationId
          ? representations.find((item) => item.representationId === representationId)
          : representations.find((item) => item.kind === 'ORIGINAL');
        return { asset, version, representation };
      },
      { readOnly: true },
    );
    if (!target) throw errors.notFound('The requested resource was not found.');
    if (target.asset.quarantined) {
      throw new ApiError('ASSET_QUARANTINED', 'A quarantined asset cannot be downloaded.', { status: 409 });
    }
    const key = target.representation?.storageKey ?? target.version.storageKey;
    if (!key) throw errors.notFound('The requested resource was not found.');

    try {
      const url = await storage.signedDownloadUrl({ key, expiresIn, filename: target.version.filename });
      return { url, expiresIn, assetVersionId: target.version.assetVersionId, representationId: target.representation?.representationId ?? null };
    } catch (error) {
      if (error instanceof StorageCapabilityError) {
        throw new ApiError('SERVICE_UNAVAILABLE', 'Downloads are unavailable with the configured storage driver.', { status: 503 });
      }
      throw error;
    }
  }

  /**
   * Deletion guard (project-assets.md, "Lifecycle"): refused while a tool
   * binding, a shared object, or an active hold references the asset. The
   * refusal names the references rather than failing opaquely.
   */
  async function deleteAsset({ projectId, assetId, actorId = null, correlationId = null }) {
    assertUuid(projectId);
    return withTenant(pool, projectId, async (client) => {
      const asset = await repo.getAsset(client, projectId, assetId);
      if (!asset) throw errors.notFound('The requested resource was not found.');
      await assertAccess(client, projectId, asset, actorId);

      const references = await repo.assetReferences(client, projectId, assetId);
      if (references.bindingCount > 0 || references.sharedObjectCount > 0 || references.holds.length > 0) {
        throw new ApiError('ASSET_REFERENCED', 'The asset is still referenced and cannot be deleted.', {
          status: 409,
          details: [{
            constraint_id: references.holds.length > 0
              ? ASSET_DIAGNOSTICS.RETENTION_HOLD.constraintId
              : null,
            binding_count: references.bindingCount,
            shared_object_count: references.sharedObjectCount,
            holds: references.holds,
          }],
        });
      }

      const versions = await repo.listVersions(client, projectId, assetId);
      await repo.markAssetDeleted(client, { projectId, assetId, actorId });
      await repo.insertOutboxEvent(client, {
        projectId,
        eventId: randomUUID(),
        eventType: ASSET_EVENTS.DELETED,
        aggregateType: 'project_asset',
        aggregateId: assetId,
        payload: { asset_id: assetId, removed_versions: versions.map((version) => version.assetVersionId), reference_check: 'passed' },
        correlationId,
        actorId,
      });
      return { assetId, deleted: true, removedVersions: versions.map((version) => version.assetVersionId) };
    });
  }

  async function createHold({ projectId, assetId = null, assetVersionId = null, reason, authority, actorId = null }) {    assertUuid(projectId);
    if (!assetId && !assetVersionId) throw new ApiError('VALIDATION_FAILED', 'A hold requires an asset or an asset version.', { status: 400 });
    return withTenant(pool, projectId, (client) =>
      repo.insertHold(client, { holdId: randomUUID(), projectId, assetId, assetVersionId, reason, authority, actorId }),
    );
  }

  async function releaseHold({ projectId, holdId, reason, actorId = null }) {
    assertUuid(projectId);
    // The database requires a releaser, because a hold is a governance record and
    // an unattributed release is not auditable.
    if (!actorId) throw new ApiError('VALIDATION_FAILED', 'Releasing a hold requires an actor.', { status: 400 });
    const released = await withTenant(pool, projectId, (client) =>
      repo.releaseHold(client, { projectId, holdId, reason, actorId }),
    );
    if (!released) throw errors.notFound('The requested resource was not found.');
    return released;
  }

  /**
   * Integrity check: re-hash the stored object and compare it with the recorded
   * checksum. This is the one place `asset.checksum.mismatch` can be raised,
   * because intake trusts only the checksum it just computed.
   */
  async function verifyStoredChecksum({ projectId, assetVersionId }) {
    assertUuid(projectId);
    const version = await withTenant(
      pool,
      projectId,
      (client) => repo.getVersion(client, projectId, assetVersionId),
      { readOnly: true },
    );
    if (!version) throw errors.notFound('The requested resource was not found.');

    const object = await storage.getObject({ key: version.storageKey });
    if (!object) {
      return { verified: false, diagnostic: ASSET_DIAGNOSTICS.CHECKSUM_MISSING, expected: version.contentChecksum, observed: null };
    }
    const hash = createHash('sha256');
    for await (const chunk of object.body) hash.update(chunk);
    const observed = hash.digest('hex');
    if (observed === version.contentChecksum) return { verified: true, diagnostic: null, expected: version.contentChecksum, observed };
    return { verified: false, diagnostic: ASSET_DIAGNOSTICS.CHECKSUM_MISMATCH, expected: version.contentChecksum, observed };
  }

  /**
   * A restricted asset requires a live per-asset, per-user grant in addition to
   * project membership (project-assets.md, "Access Control"). A `PROJECT` asset
   * needs no grant.
   */
  async function assertAccess(client, projectId, asset, actorId) {
    if (!asset || asset.accessClassification === 'PROJECT') return;
    if (!actorId || !(await repo.hasGrant(client, projectId, asset.assetId, actorId))) {
      throw new ApiError('ASSET_ACCESS_DENIED', 'The asset is restricted and you do not have a grant for it.', {
        status: 403,
      });
    }
  }

  async function createGrant({ projectId, assetId, granteeId, actorId = null }) {
    assertUuid(projectId);
    assertUuid(assetId, 'asset_id');
    assertUuid(granteeId, 'grantee_id');
    return withTenant(pool, projectId, async (client) => {
      const asset = await repo.getAsset(client, projectId, assetId);
      if (!asset) throw errors.notFound('The requested resource was not found.');
      if (asset.accessClassification !== 'RESTRICTED') {
        throw new ApiError('VALIDATION_FAILED', 'Access grants apply only to RESTRICTED assets.', { status: 400 });
      }
      return repo.insertGrant(client, { grantId: randomUUID(), projectId, assetId, granteeId, grantedBy: actorId });
    });
  }

  async function revokeGrant({ projectId, assetId, granteeId, actorId = null }) {
    assertUuid(projectId);
    assertUuid(assetId, 'asset_id');
    assertUuid(granteeId, 'grantee_id');
    const revoked = await withTenant(pool, projectId, (client) =>
      repo.revokeGrant(client, { projectId, assetId, granteeId, actorId }),
    );
    if (!revoked) throw errors.notFound('The requested resource was not found.');
    return revoked;
  }

  async function listGrants({ projectId, assetId }) {
    assertUuid(projectId);
    assertUuid(assetId, 'asset_id');
    return withTenant(pool, projectId, (client) => repo.listGrants(client, projectId, assetId), { readOnly: true });
  }

  /**
   * Requests representation production for a version. The processor is the import
   * framework (W4); the asset layer only authorizes the caller and hands over the
   * pinned version, so it carries no format knowledge.
   */
  async function requestProcessing({ projectId, assetId, assetVersionId = null, actorId = null, force = false, correlationId = null }) {
    if (!processor) {
      throw new ApiError('SERVICE_UNAVAILABLE', 'No representation producer is registered.', { status: 503 });
    }
    assertUuid(projectId);
    assertUuid(assetId, 'asset_id');
    const target = await withTenant(
      pool,
      projectId,
      async (client) => {
        const asset = await repo.getAsset(client, projectId, assetId);
        if (!asset) return null;
        await assertAccess(client, projectId, asset, actorId);
        const version = assetVersionId
          ? await repo.getVersion(client, projectId, assetVersionId)
          : (await repo.listVersions(client, projectId, assetId))[0] ?? null;
        if (!version || version.assetId !== assetId) return null;
        return version;
      },
      { readOnly: true },
    );
    if (!target) throw errors.notFound('The requested resource was not found.');
    return processor.processAssetVersion({ projectId, assetVersionId: target.assetVersionId, actorId, force, correlationId });
  }

  async function discardPendingVersion(projectId, assetId, assetVersionId) {
    try {
      await withTenant(pool, projectId, async (client) => {
        await repo.deleteVersion(client, projectId, assetVersionId);
        const remaining = await repo.listVersions(client, projectId, assetId);
        if (remaining.length === 0) {
          await repo.markAssetDeleted(client, { projectId, assetId, actorId: null });
        }
      });
    } catch (error) {
      logger?.warn?.('asset.intake.cleanup_failed', { assetVersionId, error: error?.message });
    }
  }

  return {
    limits: effectiveLimits,
    reserveAsset,
    reserveVersion,
    intakeContent,
    runScanJob,
    getAsset,
    listAssets,
    getJob,
    patchAsset,
    setArchived,
    createDownloadUrl,
    deleteAsset,
    createHold,
    releaseHold,
    createGrant,
    revokeGrant,
    listGrants,
    requestProcessing,
    verifyStoredChecksum,
  };
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError('VALIDATION_FAILED', `${field} is required.`, { status: 400, details: [{ field }] });
  }
  return value.trim();
}

function requireMediaType(mediaType) {
  if (!isValidMediaType(mediaType)) {
    throw new ApiError('VALIDATION_FAILED', 'A valid media type is required.', {
      status: 400,
      details: [{ field: 'media_type' }],
    });
  }
  return mediaType.trim().toLowerCase();
}

function assertDeclaredSize(sizeBytes, maxBytes) {
  if (sizeBytes === null || sizeBytes === undefined) return;
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new ApiError('VALIDATION_FAILED', 'size_bytes must be a non-negative number.', { status: 400 });
  }
  if (sizeBytes > maxBytes) throw errors.payloadTooLarge(maxBytes);
}

function mapIntakeError(error, maxBytes) {
  if (error instanceof AssetTooLargeError) return errors.payloadTooLarge(maxBytes);
  return error;
}

async function deleteObjectQuietly(storage, key) {
  try {
    await storage.deleteObject({ key });
  } catch {
    // The object may never have been written; a failed cleanup must not mask the
    // original failure.
  }
}

/** Accepts a Node stream, a web stream, or a buffer/string (tests). */
function toReadable(body) {
  if (body && typeof body.pipe === 'function') return body;
  if (body && typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (body === null || body === undefined) return Readable.from([]);
  return Readable.from([body]);
}
