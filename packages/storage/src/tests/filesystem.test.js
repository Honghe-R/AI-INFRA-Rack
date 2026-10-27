import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createFilesystemStorage } from '../filesystem.js';
import { StorageCapabilityError } from '../errors.js';

/**
 * The filesystem driver, which is what lets the storage *interface* be tested without a
 * network. It is not a deployment target: it cannot mint a download URL, and it says so.
 */
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'ai-infra-storage-'));
  try {
    return await fn(createFilesystemStorage({ root }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const streamOf = (text) => Readable.from([Buffer.from(text, 'utf8')]);

test('an object round-trips: put, head, get, delete', async () => {
  await withRoot(async (storage) => {
    await storage.ensureBucket();

    const put = await storage.putObject({ key: 'projects/p1/assets/a1/original', body: streamOf('facility bytes') });
    assert.equal(put.size, 14);

    const head = await storage.headObject({ key: 'projects/p1/assets/a1/original' });
    assert.equal(head.size, 14);

    const got = await storage.getObject({ key: 'projects/p1/assets/a1/original' });
    const chunks = [];
    for await (const chunk of got.body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'facility bytes');

    await storage.deleteObject({ key: 'projects/p1/assets/a1/original' });
    assert.equal(await storage.headObject({ key: 'projects/p1/assets/a1/original' }), null);
  });
});

test('a Buffer, a string, and a web stream are all accepted as a body', async () => {
  await withRoot(async (storage) => {
    // A Buffer body must be written as one object, not one byte per chunk: the
    // driver used to test the wrong capability and stream it byte-by-byte.
    await storage.putObject({ key: 'body/buffer.bin', body: Buffer.from('buffer-body') });
    assert.equal((await readFile(join(storage.root, 'body/buffer.bin'))).toString('utf8'), 'buffer-body');

    await storage.putObject({ key: 'body/string.bin', body: 'string-body' });
    assert.equal((await readFile(join(storage.root, 'body/string.bin'))).toString('utf8'), 'string-body');

    const web = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('web-body'));
        controller.close();
      },
    });
    await storage.putObject({ key: 'body/web.bin', body: web });
    assert.equal((await readFile(join(storage.root, 'body/web.bin'))).toString('utf8'), 'web-body');
  });
});

test('a missing object is null, not an exception', async () => {
  await withRoot(async (storage) => {
    assert.equal(await storage.headObject({ key: 'nope/missing.bin' }), null);
    assert.equal(await storage.getObject({ key: 'nope/missing.bin' }), null);
    // Deleting something absent is idempotent: a retry must not fail on it.
    assert.deepEqual(await storage.deleteObject({ key: 'nope/missing.bin' }), { key: 'nope/missing.bin', deleted: true });
  });
});

test('a key cannot escape the storage root', async () => {
  await withRoot(async (storage, root) => {
    await assert.rejects(() => storage.putObject({ key: '../../escaped.bin', body: streamOf('x') }), /escapes the storage root/);
    await assert.rejects(() => storage.headObject({ key: '/etc/passwd' }), /escapes the storage root/);
    // Nothing was written beside the root.
    await assert.rejects(() => readFile(join(root, '..', 'escaped.bin')), /ENOENT/);
  });
});

test('an interrupted write leaves no partial object', async () => {
  await withRoot(async (storage) => {
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('connection lost'));
      },
    });
    await assert.rejects(() => storage.putObject({ key: 'uploads/interrupted.bin', body: failing }), /connection lost/);
    // The staged file is cleaned up and the final name never appears.
    assert.equal(await storage.headObject({ key: 'uploads/interrupted.bin' }), null);
  });
});

test('a capability the driver lacks is reported, not faked', async () => {
  await withRoot(async (storage) => {
    // Returning a file:// path here would look like a working download and then fail in a
    // browser, so the driver refuses instead.
    assert.throws(() => storage.signedDownloadUrl({ key: 'anything' }), StorageCapabilityError);
  });
});
