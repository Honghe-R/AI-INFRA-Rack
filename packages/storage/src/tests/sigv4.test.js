import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalQueryString, encodeKey, presignUrl, signRequest, uriEncode } from '../sigv4.js';

/**
 * Signature Version 4 against an independent implementation.
 *
 * Every expected signature below was produced by the AWS CLI (v2.35.4, which embeds
 * botocore) against a local endpoint, so this is a cross-implementation check rather than
 * two copies of the same reasoning. The vectors were generated with:
 *
 *   AWS_ACCESS_KEY_ID=AKIDEXAMPLE \
 *   AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' \
 *   AWS_DEFAULT_REGION=us-east-1 \
 *   aws s3 presign "s3://test-bucket/<key>" --endpoint-url http://127.0.0.1:9000 --expires-in <n>
 *
 * and, for the header-signed request, by capturing what `aws s3api put-object` sent to a
 * local echo server. Regenerating them is a documentation exercise, not guesswork, which
 * is why the parameters are recorded in full.
 */
const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const REGION = 'us-east-1';

function presign(key, { host = '127.0.0.1:9000', expiresIn, date }) {
  return presignUrl({
    path: `/test-bucket/${encodeKey(key)}`,
    host,
    credentials: CREDENTIALS,
    region: REGION,
    expiresIn,
    date,
    scheme: 'http',
  });
}

test('a presigned GET reproduces botocore\'s signature', () => {
  const { url, signature } = presign('path/to an object.txt', {
    expiresIn: 900,
    date: '2026-09-17T07:47:57Z',
  });
  assert.equal(signature, 'f43504e690f200a12383d27f08aefbbbf842138eaaac3bba52e463ff7ef9804c');
  // Space is %20 in a path, never "+", and the credential's slashes are encoded.
  assert.match(url, /\/test-bucket\/path\/to%20an%20object\.txt\?/);
  assert.match(url, /X-Amz-Credential=AKIDEXAMPLE%2F20260917%2Fus-east-1%2Fs3%2Faws4_request/);
  assert.match(url, /X-Amz-SignedHeaders=host/);
  assert.match(url, /X-Amz-Expires=900/);
});

test('every character that needs encoding is encoded the SigV4 way', () => {
  // `+`, `=`, and `&` are the ones `encodeURIComponent` and a naive `escape` get wrong,
  // and a space must not become `+`.
  assert.equal(uriEncode('a+b c=d&e'), 'a%2Bb%20c%3Dd%26e');
  // `encodeURIComponent` leaves these alone; SigV4 does not.
  assert.equal(uriEncode("!*'()"), '%21%2A%27%28%29');
  assert.equal(uriEncode('ÅÄÖ文件'), '%C3%85%C3%84%C3%96%E6%96%87%E4%BB%B6');
  // A path keeps its separators; a query value does not.
  assert.equal(encodeKey('a/b c/d'), 'a/b%20c/d');
  assert.equal(uriEncode('a/b'), 'a%2Fb');
});

test('a key with reserved and non-ASCII characters reproduces botocore\'s signature', () => {
  const reserved = presign('a+b c=d&e.txt', { expiresIn: 60, date: '2026-09-17T07:48:44Z' });
  assert.equal(reserved.signature, '38c5a8c1f34fc9dde05a5b9eca0778788f31c09b0979c81d9f828cdba6565eb4');
  assert.match(reserved.url, /\/test-bucket\/a%2Bb%20c%3Dd%26e\.txt\?/);

  const unicode = presign('unicode-ÅÄÖ-文件.bin', { expiresIn: 60, date: '2026-09-17T07:48:44Z' });
  assert.equal(unicode.signature, '4bd264aa61028695cb7d0924d17361b881a0fdd1b2070d46a07ce5d24af29f1d');
  assert.match(unicode.url, /unicode-%C3%85%C3%84%C3%96-%E6%96%87%E4%BB%B6\.bin/);
});

test('a header-signed PUT reproduces what the AWS CLI sent', () => {
  // Captured from `aws s3api put-object --body payload.bin` against a local echo server:
  // PUT /test-bucket/dir/file.bin, and the CLI signed the four extra headers it sends.
  const payloadHash = 'db849ca59f9c1acbfc62797fbb1bd4c48790f10f654ea55d1e44ba33718ff8c6';
  const result = signRequest({
    method: 'PUT',
    path: '/test-bucket/dir/file.bin',
    host: '127.0.0.1:9099',
    // Exactly the headers botocore chose to sign. `content-length`, `expect`, and
    // `user-agent` were present on the wire but deliberately outside the signature, and
    // adding one here changes the signature — which is how this test first failed.
    headers: {
      'x-amz-checksum-crc64nvme': 'HfzZ+7Ozjs8=',
      'x-amz-sdk-checksum-algorithm': 'CRC64NVME',
    },
    payloadHash,
    credentials: CREDENTIALS,
    region: REGION,
    date: '2026-09-17T07:48:16Z',
  });

  assert.equal(result.signature, '32e51dc93c9f0a9bfc0075ff3177ccd82b4455868fcf0b7e239f4df58e3319b2');
  assert.equal(
    result.headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260917/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;x-amz-checksum-crc64nvme;x-amz-content-sha256;x-amz-date;x-amz-sdk-checksum-algorithm, ' +
      'Signature=32e51dc93c9f0a9bfc0075ff3177ccd82b4455868fcf0b7e239f4df58e3319b2',
  );
  assert.equal(result.headers['x-amz-date'], '20260917T074816Z');
  assert.equal(result.headers['x-amz-content-sha256'], payloadHash);
});

test('signing a streaming body uses UNSIGNED-PAYLOAD', () => {
  // A stream cannot carry a hash computed in advance, which is why D23's intake path signs
  // UNSIGNED-PAYLOAD and depends on TLS for transport integrity.
  const result = signRequest({
    method: 'PUT',
    path: '/test-bucket/dir/file.bin',
    host: 'object-store.local',
    credentials: CREDENTIALS,
    region: REGION,
    date: '2026-09-17T07:48:16Z',
  });
  assert.equal(result.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
});

test('query parameters are canonicalized by encoded name', () => {
  // The shape AWS specifies: encoded, then sorted by name and value.
  assert.equal(canonicalQueryString([['b', '2'], ['a', '1']]), 'a=1&b=2');
  assert.equal(canonicalQueryString([['a', 'b c'], ['a', 'b+c']]), 'a=b%20c&a=b%2Bc');
  assert.equal(canonicalQueryString([['Zebra', '1'], ['apple', '2']]), 'Zebra=1&apple=2');
});

test('the default is https and a caller can override it for a local store', () => {
  const { url } = presignUrl({
    path: '/test-bucket/k',
    host: 'objects.example.com',
    credentials: CREDENTIALS,
    region: REGION,
    date: '2026-09-17T07:48:44Z',
  });
  assert.match(url, /^https:\/\/objects\.example\.com\/test-bucket\/k\?/);
});
