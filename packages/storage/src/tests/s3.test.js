import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createS3Storage } from '../s3.js';
import { StorageError } from '../errors.js';

/**
 * Two different questions, answered by two different tests.
 *
 *  * Is the **signature** correct? Answered by `sigv4.test.js`, against vectors produced by
 *    botocore. This file deliberately does not re-derive cryptography.
 *  * Is the **request** shaped correctly? Answered here, against a local server that
 *    records exactly what arrived: method, path-style addressing, header set, streamed body.
 *
 * A real S3 implementation is the third check, and it runs where one exists: the
 * integration test at the bottom is skipped unless `STORAGE_ENDPOINT` points at a store, and
 * CI provides one. MinIO verifying our signature is evidence no local mock can give.
 */

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

/** A stand-in S3: records requests and replies with whatever the test scripted. */
async function withFakeS3(handler, fn) {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const record = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    seen.push(record);
    const scripted = handler(record) ?? { status: 200, body: '' };
    response.writeHead(scripted.status, scripted.headers ?? { 'content-type': 'application/xml' });
    response.end(scripted.body ?? '');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const storage = createS3Storage({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'test-bucket',
      ...CREDENTIALS,
    });
    return await fn(storage, seen, port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('a streaming upload is path-style, signed, and unbuffered', async () => {
  await withFakeS3(() => ({ status: 200 }), async (storage, seen) => {
    await storage.putObject({
      key: 'projects/p1/assets/a1/versions/v1/checksum/original',
      body: 'the bytes',
      contentType: 'application/octet-stream',
      contentLength: 9,
    });

    const [request] = seen;
    assert.equal(request.method, 'PUT');
    // Path-style: the bucket is in the path, which is what a local store and a
    // custom-endpoint deployment both need.
    assert.equal(request.url, '/test-bucket/projects/p1/assets/a1/versions/v1/checksum/original');
    assert.equal(request.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
    assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=/);
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    assert.equal(request.body, 'the bytes');
  });
});

test('virtual-host addressing is available for real S3', async () => {
  // Without an endpoint the driver targets S3 itself, and the bucket moves into the host.
  const storage = createS3Storage({ region: 'eu-west-1', bucket: 'my-bucket', forcePathStyle: false, ...CREDENTIALS });
  const url = storage.signedDownloadUrl({ key: 'a/b.txt', date: new Date('2026-09-17T07:48:44Z') });
  assert.match(url, /^https:\/\/my-bucket\.s3\.eu-west-1\.amazonaws\.com\/a\/b\.txt\?/);
});

test('metadata reads report absence as null rather than throwing', async () => {
  await withFakeS3(
    (request) => (request.url.includes('missing') ? { status: 404, body: '<Error><Code>NoSuchKey</Code><Message>gone</Message></Error>' } : { status: 200, headers: { 'content-length': '42', 'content-type': 'text/plain', etag: '"abc"' } }),
    async (storage) => {
      const head = await storage.headObject({ key: 'present.bin' });
      assert.deepEqual(head, { key: 'present.bin', size: 42, contentType: 'text/plain', etag: 'abc' });
      assert.equal(await storage.headObject({ key: 'missing.bin' }), null);
    },
  );
});

test('a provider rejection surfaces its own code and status', async () => {
  await withFakeS3(
    () => ({ status: 403, body: '<Error><Code>AccessDenied</Code><Message>nope</Message></Error>' }),
    async (storage) => {
      await assert.rejects(
        () => storage.putObject({ key: 'x.bin', body: 'x' }),
        (error) => {
          assert.ok(error instanceof StorageError);
          assert.equal(error.code, 'STORAGE_REQUEST_FAILED');
          // The provider's own words survive: an operator needs "AccessDenied", not our prose.
          assert.equal(error.detail.code, 'AccessDenied');
          assert.equal(error.detail.status, 403);
          return true;
        },
      );
    },
  );
});

test('creating a bucket that already exists is not a failure', async () => {
  await withFakeS3(
    () => ({ status: 409, body: '<Error><Code>BucketAlreadyOwnedByYou</Code><Message>exists</Message></Error>' }),
    async (storage, seen) => {
      assert.deepEqual(await storage.ensureBucket(), { created: false });
      assert.equal(seen[0].method, 'PUT');
      assert.equal(seen[0].url, '/test-bucket');
    },
  );
});

test('a download URL is time-limited and read-only', async () => {
  await withFakeS3(() => ({ status: 200 }), async (storage) => {
    const url = storage.signedDownloadUrl({
      key: 'projects/p1/assets/a1/original',
      expiresIn: 900,
      filename: 'site plan.dwg',
      date: new Date('2026-09-17T07:47:57Z'),
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/test-bucket\/projects\/p1\/assets\/a1\/original\?/);
    assert.match(url, /X-Amz-Expires=900/);
    assert.match(url, /response-content-disposition=attachment%3B%20filename%3D%22site%20plan\.dwg%22/);
    // Never list-capable, and carrying no write.
    assert.doesNotMatch(url, /list-type|X-Amz-Signature=.*&.*put/i);
  });
});

test('missing credentials fail with an actionable message', async () => {
  const storage = createS3Storage({ region: 'us-east-1', bucket: 'b' });
  await assert.rejects(
    () => storage.headObject({ key: 'k' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_NOT_CONFIGURED');
      assert.match(error.detail.detail, /STORAGE_ACCESS_KEY_ID/);
      return true;
    },
  );
});

// --- against a real store, when one is reachable -------------------------------------
const endpoint = process.env.STORAGE_ENDPOINT;
const skip = endpoint ? false : 'STORAGE_ENDPOINT is not set';

test('a real S3-compatible store accepts the signature, the stream, and the URL', { skip }, async () => {
  const storage = createS3Storage({
    endpoint,
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    bucket: process.env.STORAGE_BUCKET ?? 'ai-infra-assets',
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  });
  await storage.ensureBucket();

  const key = `test/${Date.now()}/round-trip.txt`;
  const body = 'verified against a real object store';
  await storage.putObject({ key, body, contentType: 'text/plain' });

  const head = await storage.headObject({ key });
  assert.equal(head.size, Buffer.byteLength(body), 'the store reports the bytes we sent');

  // An independent implementation accepting our presigned URL is the end-to-end proof that
  // the signature is right: no credentials are sent here, only the URL.
  const url = storage.signedDownloadUrl({ key, expiresIn: 60 });
  const fetched = await fetch(url);
  assert.equal(fetched.status, 200);
  assert.equal(await fetched.text(), body);

  await storage.deleteObject({ key });
  assert.equal(await storage.headObject({ key }), null);
});
