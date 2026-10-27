import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, implemented on `node:crypto`.
 *
 * Two reasons this is hand-written rather than delegated to an SDK. It keeps the
 * workspace free of a large dependency for four operations, and the signer is the one
 * piece of object-store code that cannot be exercised by reading it — so it is verified
 * against vectors produced by an independent implementation (the AWS CLI, which embeds
 * botocore). See `src/tests/sigv4.test.js`.
 *
 * The algorithm has three classic failure modes, all of which are canonicalization:
 * percent-encoding rules, the ordering of query parameters, and the exact set and casing
 * of signed headers. Each is handled explicitly below and covered by a vector.
 *
 * Scope: header-based signing for service requests, and query-based signing for
 * time-limited download URLs. S3 requires the payload hash in a header, and a streaming
 * body cannot carry a hash computed in advance, so streaming uploads sign
 * `UNSIGNED-PAYLOAD` over TLS — which is what production clients do.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * RFC 3986 encoding, which is stricter than `encodeURIComponent`: it keeps only
 * `A-Za-z0-9-_.~` and leaves nothing else alone. `encodeURIComponent` would also keep
 * `!*'()`, and those must be encoded in a signature. Hex digits are uppercase.
 */
export function uriEncode(value, { encodeSlash = true } = {}) {
  let out = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const char = String.fromCharCode(byte);
    if (
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      char === '-' ||
      char === '_' ||
      char === '.' ||
      char === '~'
    ) {
      out += char;
    } else if (char === '/' && !encodeSlash) {
      out += char;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** Encodes an object key path, segment by segment, leaving the separators intact. */
export function encodeKey(key) {
  return String(key)
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** `YYYYMMDDTHHMMSSZ` and its `YYYYMMDD` prefix, as the signature requires. */
export function amzDateParts(date) {
  const iso = new Date(date).toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Canonical query string: every parameter encoded, then sorted by name and, for repeats,
 * by value. Sorting the *encoded* form is what the specification says.
 */
export function canonicalQueryString(params) {
  return params
    .map(([name, value]) => [uriEncode(name), uriEncode(value ?? '')])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** Lower-cased, trimmed headers: `name:value\n` for each, sorted by name. */
export function canonicalHeaders(headers) {
  const entries = Object.entries(headers).map(([name, value]) => [
    name.toLowerCase(),
    String(value).trim().replace(/\s+/g, ' '),
  ]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    signedHeaders: entries.map(([name]) => name).join(';'),
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
  };
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
}

function buildStringToSign(amzDate, scope, canonicalRequest) {
  return [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
}

/**
 * Canonical request, string to sign, scope, and signature for one request. Exported so a
 * test can compare the intermediate strings against a reference, not only the result.
 */
export function canonicalize({
  method,
  path,
  query = [],
  headers,
  payloadHash = UNSIGNED_PAYLOAD,
  accessKeyId,
  secretAccessKey,
  region,
  service = 's3',
  date = new Date(),
}) {
  const { amzDate, dateStamp } = amzDateParts(date);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const { signedHeaders, canonical } = canonicalHeaders(headers);

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQueryString(query),
    canonical,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = buildStringToSign(amzDate, scope, canonicalRequest);
  const signature = hmac(signingKey(secretAccessKey, dateStamp, region, service), stringToSign).toString('hex');

  return { amzDate, dateStamp, scope, signedHeaders, canonicalRequest, stringToSign, signature, accessKeyId };
}

/**
 * Header-based signing for API calls (PUT, HEAD, DELETE, GET of a stream).
 *
 * `path` must already be percent-encoded — callers build it with `encodeKey` — because
 * encoding it here would double-encode a key that legitimately contains `%`.
 */
export function signRequest({
  method,
  path,
  host,
  headers = {},
  payloadHash = UNSIGNED_PAYLOAD,
  credentials,
  region,
  service = 's3',
  date = new Date(),
}) {
  // The date and payload hash must be *in* the header set before canonicalizing, because
  // they are part of what gets signed. Adding them afterwards produced an authorization
  // header that claimed to sign headers the canonical request did not contain — which the
  // botocore vector caught immediately.
  const { amzDate } = amzDateParts(date);
  const signed = {
    ...headers,
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };

  const result = canonicalize({
    method,
    path,
    headers: signed,
    payloadHash,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region,
    service,
    date,
  });

  return {
    ...result,
    headers: {
      ...signed,
      authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${result.scope}, SignedHeaders=${result.signedHeaders}, Signature=${result.signature}`,
    },
  };
}

/**
 * Query-based signing for a time-limited download URL.
 *
 * The signature is computed over the query string *without* `X-Amz-Signature`, then
 * appended, which is why the parameter list is built in one place.
 */
export function presignUrl({
  method = 'GET',
  path,
  host,
  query = [],
  headers = {},
  credentials,
  region,
  service = 's3',
  expiresIn = 900,
  payloadHash = UNSIGNED_PAYLOAD,
  date = new Date(),
  scheme = 'https',
}) {
  const signed = { ...headers, host };
  const { amzDate, dateStamp } = amzDateParts(date);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const params = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', canonicalHeaders(signed).signedHeaders],
    ...query.map(([name, value]) => [name, value]),
  ];

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQueryString(params),
    canonicalHeaders(signed).canonical,
    canonicalHeaders(signed).signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = buildStringToSign(amzDate, scope, canonicalRequest);
  const signature = hmac(signingKey(credentials.secretAccessKey, dateStamp, region, service), stringToSign).toString('hex');

  const finalQuery = [...params, ['X-Amz-Signature', signature]]
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value ?? '')}`)
    .join('&');

  return {
    url: `${scheme}://${host}${path}?${finalQuery}`,
    signature,
    canonicalRequest,
    stringToSign,
  };
}

/** The SHA-256 of an empty body, which S3 expects for requests that carry no payload. */
export const EMPTY_PAYLOAD_SHA256 = sha256Hex('');

export { ALGORITHM, UNSIGNED_PAYLOAD };
