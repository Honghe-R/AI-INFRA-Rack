import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { AssetTooLargeError, createHashingCounter, sha256HexOf } from '../checksum.js';

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('hashes a streamed body and counts its bytes', async () => {
  const counter = createHashingCounter();
  const source = Readable.from([Buffer.from('abc'), Buffer.from('def')]);
  source.pipe(counter.stream);
  const body = await collect(counter.stream);

  assert.equal(body.toString('utf8'), 'abcdef', 'the transform passes bytes through unchanged');
  const digest = counter.digest();
  assert.equal(digest.checksum, sha256HexOf(Buffer.from('abcdef')));
  assert.equal(digest.sizeBytes, 6);
});

test('rejects a body that crosses the limit while the stream is still in flight', async () => {
  const counter = createHashingCounter({ maxBytes: 4 });
  const source = Readable.from([Buffer.from('abcde')]);

  await assert.rejects(
    async () => {
      source.pipe(counter.stream);
      await collect(counter.stream);
    },
    (error) => {
      assert.ok(error instanceof AssetTooLargeError, 'the failure names the limit');
      assert.equal(error.limitBytes, 4);
      return true;
    },
  );
});

test('the digest is unavailable before the stream ends', () => {
  const counter = createHashingCounter();
  assert.throws(() => counter.digest(), /after the stream has ended/);
});
