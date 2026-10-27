import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { ApiError, errors } from '@ai-infra/core';
import { assertUuid, withTenant } from '@ai-infra/db';
import { assetRepository, representationKey, sha256HexOf } from '@ai-infra/assets';
import { reconcileCounts } from './adapter-contract.js';
import { IMPORT_DIAGNOSTICS } from './diagnostics.js';
import { AdapterResolutionError, extensionOf, normalizeMediaType } from './registry.js';
import { effectiveLimits } from './limits.js';

/**
 * The import pipeline.
 *
 * Format-agnostic by construction: it resolves an adapter from the registry,
 * hands the bytes to the sandbox, and stores whatever comes back as
 * representations. It contains no format-specific branch, so a new format is a
 * descriptor plus an implementation (doc/workspace/import-adapters.md,
 * "Extensibility Model").
 *
 * Idempotent per `(asset_version_id, kind, producer, producer_version)`. A forced
 * re-run marks the previous representations of that producer `STALE` and writes
 * new ones; nothing is ever mutated in place.
 */
export function createImportPipeline({
  pool,
  storage,
  registry,
  sandbox,
  limits = {},
  logger = null,
} = {}) {
  if (!pool) throw new Error('createImportPipeline requires a database pool.');
  if (!storage) throw new Error('createImportPipeline requires a storage adapter.');
  if (!registry) throw new Error('createImportPipeline requires an adapter registry.');
  if (!sandbox) throw new Error('createImportPipeline requires a sandbox runner.');
  const effective = effectiveLimits(limits);

  async function processAssetVersion({ projectId, assetVersionId, actorId = null, force = false, correlationId = null }) {
    assertUuid(projectId);
    assertUuid(assetVersionId, 'asset_version_id');

    const context = await withTenant(
      pool,
      projectId,
      async (client) => {
        const version = await assetRepository.getVersion(client, projectId, assetVersionId);
        if (!version) return null;
        const asset = await assetRepository.getAsset(client, projectId, version.assetId);
        const representations = await assetRepository.listRepresentations(client, projectId, assetVersionId);
        return { version, asset, representations };
      },
      { readOnly: true },
    );
    if (!context) throw errors.notFound('The requested resource was not found.');

    // Acceptance criterion 5: a version that is not scan-clean is never processed.
    if (context.version.intakeState !== 'COMPLETE') {
      throw new ApiError('IMPORT_ASSET_NOT_READY', 'The asset version has no stored content yet.', { status: 409 });
    }
    if (context.version.malwareScanState !== 'CLEAN') {
      throw new ApiError('ASSET_QUARANTINED', 'The asset version is not scan-clean and cannot be processed.', { status: 409 });
    }

    let resolved;
    try {
      resolved = registry.resolve({
        mediaType: normalizeMediaType(context.version.mediaType),
        extension: extensionOf(context.version.filename),
      });
    } catch (error) {
      if (error instanceof AdapterResolutionError) {
        throw new ApiError(error.code, error.message, { status: 422, details: [{ constraint_id: error.constraintId, ...error.details[0] }] });
      }
      throw error;
    }
    const { descriptor } = resolved;

    // Idempotent: an already-produced representation for this producer and
    // producer version is a no-op unless the caller forces a re-run.
    const existing = context.representations.find(
      (representation) =>
        representation.kind === 'FEATURES' &&
        representation.status === 'READY' &&
        representation.producerId === descriptor.adapter_id &&
        representation.producerVersion === descriptor.adapter_version,
    );
    if (existing && !force) {
      // Report the whole producer's output, not just the row that proved the run
      // already happened, so a caller can still fetch the georeference.
      const produced = context.representations
        .filter(
          (representation) =>
            representation.status === 'READY' &&
            representation.producerId === descriptor.adapter_id &&
            representation.producerVersion === descriptor.adapter_version &&
            (representation.kind === 'FEATURES' || representation.kind === 'GEOREFERENCE'),
        )
        .map((representation) => representation.representationId);
      return {
        assetVersionId,
        adapter: { adapterId: descriptor.adapter_id, adapterVersion: descriptor.adapter_version },
        skipped: true,
        reason: 'already-processed',
        representationIds: produced,
        notices: resolved.notices,
      };
    }

    const jobId = randomUUID();
    await withTenant(pool, projectId, (client) =>
      assetRepository.insertJob(client, {
        jobId,
        projectId,
        assetVersionId,
        jobType: 'PROCESS',
        payload: { adapter_id: descriptor.adapter_id, adapter_version: descriptor.adapter_version, force },
        actorId,
      }),
    );

    let workDir = null;
    try {
      workDir = await mkdtemp(join(tmpdir(), 'ai-infra-import-'));
      const sourcePath = join(workDir, 'source');
      await downloadToFile(storage, context.version.storageKey, sourcePath, effective.maxBytes);

      const result = await sandbox.run({
        entryPoint: descriptor.entry_point,
        mediaType: context.version.mediaType,
        path: sourcePath,
        filename: context.version.filename,
        limits: {
          ...effective,
          maxAttributeColumns: effective.maxAttributeColumns,
          blockNestingDepth: effective.blockNestingDepth,
          kmlFolderDepth: effective.kmlFolderDepth,
        },
      });

      const features = Array.isArray(result?.features) ? result.features : [];
      const counts = result?.counts ?? reconcileCounts(features);
      const diagnostics = [...(result?.diagnostics ?? []), ...resolved.notices.map((entry) => ({ constraintId: entry.constraintId, message: entry.rule }))];
      const georeference = result?.georeference ?? null;

      const report = await withTenant(pool, projectId, async (client) => {
        // A representation is unique per producer version (D25). A newer producer
        // version supersedes the older one, which is kept and marked STALE; a
        // forced re-run of the same version replaces its content in place.
        const supersedesOlder = context.representations.some(
          (representation) =>
            representation.status === 'READY' &&
            representation.producerId === descriptor.adapter_id &&
            representation.producerVersion !== descriptor.adapter_version,
        );
        if (supersedesOlder) {
          await assetRepository.markRepresentationsStale(client, {
            projectId,
            assetVersionId,
            producerId: descriptor.adapter_id,
          });
        }

        const written = [];
        written.push(
          await writeRepresentation(client, {
            projectId,
            assetId: context.version.assetId,
            assetVersionId,
            kind: 'FEATURES',
            mediaType: 'application/json',
            body: { features, counts, diagnostics },
            producerId: descriptor.adapter_id,
            producerVersion: descriptor.adapter_version,
            actorId,
          }),
        );

        if (georeference && (georeference.sourceCrs || georeference.sourceUnits || georeference.verticalCrs)) {
          written.push(
            await writeRepresentation(client, {
              projectId,
              assetId: context.version.assetId,
              assetVersionId,
              kind: 'GEOREFERENCE',
              mediaType: 'application/json',
              body: georeference,
              producerId: descriptor.adapter_id,
              producerVersion: descriptor.adapter_version,
              actorId,
            }),
          );
        }

        await assetRepository.completeJob(client, {
          projectId,
          jobId,
          state: 'SUCCEEDED',
          result: { counts, diagnostics, representations: written.map((item) => item.representationId) },
        });
        await assetRepository.insertOutboxEvent(client, {
          projectId,
          eventId: randomUUID(),
          eventType: 'asset.processed.v1',
          aggregateType: 'asset_version',
          aggregateId: assetVersionId,
          payload: {
            asset_id: context.version.assetId,
            asset_version_id: assetVersionId,
            adapter_id: descriptor.adapter_id,
            adapter_version: descriptor.adapter_version,
            counts,
          },
          correlationId,
          actorId,
        });

        return { representations: written, counts, diagnostics, georeference };
      });

      return {
        assetVersionId,
        jobId,
        adapter: { adapterId: descriptor.adapter_id, adapterVersion: descriptor.adapter_version },
        skipped: false,
        counts: report.counts,
        diagnostics: report.diagnostics,
        representationIds: report.representations.map((item) => item.representationId),
        georeference: report.georeference,
        notices: resolved.notices,
      };
    } catch (error) {
      const diagnostic = IMPORT_DIAGNOSTICS.CONVERSION_INCOMPLETE.constraintId;
      await withTenant(pool, projectId, (client) =>
        assetRepository.completeJob(client, {
          projectId,
          jobId,
          state: 'FAILED',
          result: { diagnostics: [{ constraintId: diagnostic, message: error?.message ?? 'The adapter failed.' }] },
          errorMessage: error?.message ?? 'The adapter failed.',
        }),
      ).catch(() => {});
      logger?.warn?.('import.processing_failed', { assetVersionId, adapterId: descriptor.adapter_id, error: error?.message });
      throw new ApiError('IMPORT_CONVERSION_FAILED', error?.message ?? 'The adapter failed.', {
        status: 422,
        details: [{ constraint_id: diagnostic }],
      });
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  async function writeRepresentation(client, {
    projectId,
    assetId,
    assetVersionId,
    kind,
    mediaType,
    body,
    producerId,
    producerVersion,
    actorId,
  }) {
    const representationId = randomUUID();
    const bytes = Buffer.from(JSON.stringify(body));
    const checksum = sha256HexOf(bytes);
    const key = representationKey({ projectId, assetId, assetVersionId, representationId });
    await storage.putObject({ key, body: bytes, contentType: mediaType, contentLength: bytes.length });
    return assetRepository.upsertRepresentation(client, {
      representationId,
      projectId,
      assetVersionId,
      kind,
      mediaType,
      checksum,
      storageKey: key,
      producerId,
      producerVersion,
      status: 'READY',
      actorId,
    });
  }

  return { processAssetVersion, limits: effective };
}

async function downloadToFile(storage, storageKey, targetPath, maxBytes) {
  const object = await storage.getObject({ key: storageKey });
  if (!object) throw new Error('The stored object for this version is missing.');

  let written = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      if (written > maxBytes) {
        callback(new Error('The document exceeds the configured size limit.'));
        return;
      }
      callback(null, chunk);
    },
  });

  await streamPipeline(object.body, counter, createWriteStream(targetPath));
  return written;
}
