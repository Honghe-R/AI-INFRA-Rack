import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { StorageCapabilityError } from './errors.js';

/**
 * A filesystem driver, for tests and for a developer who has no container runtime.
 *
 * It exists so the storage *interface* can be exercised without a network, and so unit
 * tests do not depend on a running object store. It is deliberately not a substitute for
 * the S3 driver in a deployed environment: it cannot mint a download URL, which is the
 * whole point of `signedDownloadUrl`, so it says so instead of returning something that
 * would silently behave differently.
 *
 * Writes are staged to a temporary name and renamed, so a reader never observes a partial
 * object and an interrupted upload leaves nothing behind.
 */
export function createFilesystemStorage({ root } = {}) {
  if (!root) throw new Error('createFilesystemStorage requires a root directory.');
  const base = resolve(root);

  /** Resolves a key inside the root, refusing anything that would escape it. */
  function pathFor(key) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('A storage key is required.');
    const target = resolve(base, key);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return target;
  }

  return {
    driver: 'filesystem',
    root: base,

    async ensureBucket() {
      await mkdir(base, { recursive: true });
      return { created: true };
    },

    async putObject({ key, body, contentType = null, contentLength = null }) {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      const staging = `${target}.upload-${randomUUID()}`;
      try {
        await pipeline(toReadable(body), createWriteStream(staging));
        await rename(staging, target);
      } catch (error) {
        await rm(staging, { force: true });
        throw error;
      }
      const written = await stat(target);
      return { key, size: written.size, contentType, declaredLength: contentLength };
    },

    async headObject({ key }) {
      try {
        const info = await stat(pathFor(key));
        if (!info.isFile()) return null;
        return { key, size: info.size, contentType: null, etag: null };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },

    async getObject({ key }) {
      const target = pathFor(key);
      try {
        const info = await stat(target);
        if (!info.isFile()) return null;
        return { key, body: createReadStream(target), size: info.size, contentType: null, etag: null };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },

    async deleteObject({ key }) {
      await rm(pathFor(key), { force: true });
      return { key, deleted: true };
    },

    signedDownloadUrl() {
      throw new StorageCapabilityError(
        'The filesystem driver cannot mint a download URL.',
        { detail: 'Use STORAGE_DRIVER=s3 against a local S3-compatible store (npm run dev:up) when a download URL is required.' },
      );
    },
  };
}

export { join };

/**
 * Normalises the three bodies a caller may hand `putObject`: a Node stream is
 * passed through, a web stream is adapted, and a string, Buffer, or iterable is
 * wrapped. `Readable.fromWeb` exists on every supported Node, so it cannot be
 * used as a capability test — testing the body itself is what distinguishes a
 * web stream from a Buffer, which would otherwise be written one byte per chunk.
 */
function toReadable(body) {
  if (body && typeof body.pipe === 'function') return body;
  if (body && typeof body.getReader === 'function') return Readable.fromWeb(body);
  return Readable.from(body);
}
