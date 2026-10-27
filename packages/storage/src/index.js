import { createS3Storage } from './s3.js';
import { createFilesystemStorage } from './filesystem.js';
import { StorageCapabilityError, StorageError } from './errors.js';
import { EMPTY_PAYLOAD_SHA256, encodeKey, presignUrl, sha256Hex, signRequest, uriEncode } from './sigv4.js';

/**
 * Object storage, behind one interface.
 *
 * The point of this package is that development and deployment run **the same code path**.
 * A local S3-compatible container and Amazon S3 differ only in configuration — endpoint,
 * credentials, path-style addressing — so an intake bug cannot hide behind a driver
 * difference, and there is no second implementation to keep in step.
 *
 * Interface:
 *
 *   ensureBucket()                                  → { created }
 *   putObject({ key, body, contentType, contentLength }) → { key, size }
 *   headObject({ key })                             → metadata | null
 *   getObject({ key })                              → { body: stream, size, ... } | null
 *   deleteObject({ key })                           → { key, deleted }
 *   signedDownloadUrl({ key, expiresIn, filename })  → string
 *
 * Keys are layout, not behaviour: callers pass the key described by the specification
 * (`projects/{project_id}/assets/...`), and object keys never reach a client — a client
 * receives a signed URL for a download and streams uploads through the API (D23).
 */
export function createStorage(config = {}) {
  const driver = config.storageDriver ?? 's3';

  if (driver === 'filesystem') {
    return createFilesystemStorage({ root: config.storageRoot });
  }

  if (driver === 's3') {
    if (!config.storageBucket) {
      throw new StorageError('STORAGE_NOT_CONFIGURED', 'No storage bucket is configured.', {
        detail: 'Set STORAGE_BUCKET, or set STORAGE_DRIVER=filesystem with STORAGE_ROOT for offline work.',
      });
    }
    return createS3Storage({
      endpoint: config.storageEndpoint,
      region: config.storageRegion,
      bucket: config.storageBucket,
      accessKeyId: config.storageAccessKeyId,
      secretAccessKey: config.storageSecretAccessKey,
      forcePathStyle: config.storageForcePathStyle,
    });
  }

  throw new StorageError('STORAGE_DRIVER_UNKNOWN', `Unknown storage driver "${driver}".`, {
    detail: 'Supported drivers are "s3" and "filesystem".',
  });
}

export { createS3Storage, createFilesystemStorage, StorageError, StorageCapabilityError };
export { EMPTY_PAYLOAD_SHA256, encodeKey, presignUrl, sha256Hex, signRequest, uriEncode };
