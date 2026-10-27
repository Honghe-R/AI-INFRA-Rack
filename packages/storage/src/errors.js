/**
 * Storage failures.
 *
 * A caller has to distinguish "the store said no" from "we could not ask", and it has to
 * see the provider's own code — an S3 `NoSuchKey` and a network timeout need different
 * handling and different operator messages. `detail` carries the provider code, HTTP
 * status, and message verbatim rather than in a sentence someone has to parse.
 */
export class StorageError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The configured driver cannot do something, and no retry will change that — a filesystem
 * driver cannot mint a signed URL, for instance. Kept distinct so a caller can fall back
 * or fail fast instead of retrying.
 */
export class StorageCapabilityError extends StorageError {
  constructor(message, detail = null) {
    super('STORAGE_UNSUPPORTED', message, detail);
    this.name = 'StorageCapabilityError';
  }
}
