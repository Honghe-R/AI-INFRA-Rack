import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

/**
 * Streaming SHA-256 with a size guard.
 *
 * Intake must compute the checksum from the bytes it receives, never from a
 * client-supplied value (D23), and it must enforce the declared size while the
 * stream is in flight rather than after a multi-gigabyte body has been buffered.
 * A single Transform does both: it hashes each chunk, counts bytes, and fails
 * the stream the moment the limit is crossed, so the storage write is aborted
 * and nothing is retained.
 *
 * `digest()` is valid only after the stream has ended without error.
 */
export class AssetTooLargeError extends Error {
  constructor(limitBytes, observedBytes) {
    super('The upload exceeds the configured asset size limit.');
    this.name = 'AssetTooLargeError';
    this.code = 'ASSET_TOO_LARGE';
    this.limitBytes = limitBytes;
    this.observedBytes = observedBytes;
  }
}

export function createHashingCounter({ maxBytes = null } = {}) {
  const hash = createHash('sha256');
  let size = 0;
  let ended = false;

  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (maxBytes !== null && size > maxBytes) {
        callback(new AssetTooLargeError(maxBytes, size));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      ended = true;
      callback();
    },
  });

  return {
    stream,
    digest() {
      if (!ended) throw new Error('The checksum is only available after the stream has ended.');
      return { checksum: hash.digest('hex'), sizeBytes: size };
    },
    get observedBytes() {
      return size;
    },
  };
}

export function sha256HexOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
