import { EMPTY_PAYLOAD_SHA256, encodeKey, presignUrl, sha256Hex, signRequest } from './sigv4.js';
import { StorageError } from './errors.js';

/**
 * An S3-compatible object-store driver.
 *
 * Works against Amazon S3, MinIO, and any other endpoint that speaks the S3 API, so the
 * same code path serves local development and deployment. The only differences are
 * configuration: endpoint, credentials, and path-style addressing.
 *
 * Two behaviours are shaped by real constraints rather than taste:
 *
 *  * **Streaming uploads sign `UNSIGNED-PAYLOAD`.** A body that arrives as a stream has no
 *    hash before it is read, and the whole point of D23's intake path is not to buffer it.
 *    Integrity therefore rests on TLS, plus the checksum the caller computes while
 *    streaming. This is what production S3 clients do.
 *  * **Nothing is buffered.** `putObject` hands the stream to `fetch`; `getObject` returns
 *    the response body as a stream. Memory is bounded by the socket, not the object.
 */

const XML_CODE = /<Code>([^<]+)<\/Code>/;
const XML_MESSAGE = /<Message>([^<]*)<\/Message>/;

function parseProviderError(status, body) {
  const code = body.match(XML_CODE)?.[1] ?? null;
  const message = body.match(XML_MESSAGE)?.[1] ?? null;
  return { code, message, status };
}

export function createS3Storage({
  endpoint = null,
  region = 'us-east-1',
  bucket,
  accessKeyId,
  secretAccessKey,
  forcePathStyle = Boolean(endpoint),
  scheme = endpoint?.startsWith('http://') ? 'http' : 'https',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!bucket) throw new Error('createS3Storage requires a bucket.');

  // An endpoint may arrive with a scheme; the rest of the driver works in host + scheme.
  const endpointUrl = endpoint ? new URL(endpoint.includes('://') ? endpoint : `${scheme}://${endpoint}`) : null;
  const host = endpointUrl
    ? endpointUrl.host
    : forcePathStyle
      ? `s3.${region}.amazonaws.com`
      : `${bucket}.s3.${region}.amazonaws.com`;

  const credentials = { accessKeyId, secretAccessKey };

  function requireCredentials() {
    if (!accessKeyId || !secretAccessKey) {
      throw new StorageError('STORAGE_NOT_CONFIGURED', 'Storage credentials are not configured.', {
        detail: 'Set STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY, or use STORAGE_DRIVER=filesystem.',
      });
    }
  }

  /** Path-style keeps the bucket in the path; virtual-host style puts it in the host. */
  function objectPath(key) {
    const encoded = encodeKey(key);
    return forcePathStyle ? `/${bucket}/${encoded}` : `/${encoded}`;
  }

  function bucketPath() {
    return forcePathStyle ? `/${bucket}` : '/';
  }

  async function send({ method, path, query = [], headers = {}, body = undefined, payloadHash = EMPTY_PAYLOAD_SHA256, accept = 'application/xml' }) {
    requireCredentials();
    const signed = signRequest({ method, path, host, headers: { ...headers, accept }, payloadHash, credentials, region });

    const url = `${scheme}://${host}${path}${query.length ? `?${query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : ''}`;
    const response = await fetchImpl(url, {
      method,
      headers: signed.headers,
      body,
      // Required by Node's fetch when a request has a stream body.
      ...(body && typeof body !== 'string' ? { duplex: 'half' } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const detail = parseProviderError(response.status, text);
      throw new StorageError('STORAGE_REQUEST_FAILED', `Object store rejected ${method} ${path}.`, detail);
    }
    return response;
  }

  return {
    driver: 's3',
    bucket,

    /** Creates the bucket when it is missing. A deployment provisions it; dev does not. */
    async ensureBucket() {
      const response = await fetch(`${scheme}://${host}${bucketPath()}`, {
        method: 'PUT',
        headers: signRequest({
          method: 'PUT',
          path: bucketPath(),
          host,
          headers: { accept: 'application/xml' },
          payloadHash: EMPTY_PAYLOAD_SHA256,
          credentials,
          region,
        }).headers,
      });
      if (response.ok) return { created: true };
      const body = await response.text().catch(() => '');
      const { code } = parseProviderError(response.status, body);
      // MinIO and S3 both answer a repeat create this way; it is not a failure.
      if (code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists' || response.status === 409) {
        return { created: false };
      }
      throw new StorageError('STORAGE_REQUEST_FAILED', 'Could not create the bucket.', { code, status: response.status });
    },

    /**
     * Streams a body to the store. The caller owns the checksum: it computes SHA-256 while
     * the same bytes flow past, which is the arrangement D23 specifies.
     */
    async putObject({ key, body, contentType = 'application/octet-stream', contentLength = null }) {
      const headers = { 'content-type': contentType };
      if (contentLength !== null) headers['content-length'] = String(contentLength);

      await send({
        method: 'PUT',
        path: objectPath(key),
        headers,
        body,
        // No hash is available before a stream is read.
        payloadHash: 'UNSIGNED-PAYLOAD',
      });
      return { key, size: contentLength };
    },

    /** Returns metadata, or null when the key does not exist. */
    async headObject({ key }) {
      let response;
      try {
        response = await send({ method: 'HEAD', path: objectPath(key) });
      } catch (error) {
        if (error.detail?.status === 404) return null;
        throw error;
      }
      return {
        key,
        size: Number.parseInt(response.headers.get('content-length') ?? '0', 10),
        contentType: response.headers.get('content-type') ?? null,
        etag: (response.headers.get('etag') ?? '').replace(/"/g, '') || null,
      };
    },

    /** Returns the object as a stream plus the metadata a caller needs to verify it. */
    async getObject({ key }) {
      try {
        const response = await send({ method: 'GET', path: objectPath(key), accept: '*/*' });
        return {
          key,
          body: response.body,
          size: Number.parseInt(response.headers.get('content-length') ?? '0', 10),
          contentType: response.headers.get('content-type') ?? null,
          etag: (response.headers.get('etag') ?? '').replace(/"/g, '') || null,
        };
      } catch (error) {
        if (error.detail?.status === 404) return null;
        throw error;
      }
    },

    async deleteObject({ key }) {
      await send({ method: 'DELETE', path: objectPath(key) });
      return { key, deleted: true };
    },

    /**
     * A time-limited, single-object, read-only URL. Never list-capable, and never carrying
     * a write operation — the object-store half of D23.
     */
    signedDownloadUrl({ key, expiresIn = 900, filename = null, date = new Date() }) {
      requireCredentials();
      const query = filename
        ? [['response-content-disposition', `attachment; filename="${filename}"`]]
        : [];
      return presignUrl({
        method: 'GET',
        path: objectPath(key),
        host,
        query,
        credentials,
        region,
        expiresIn,
        date,
        scheme,
      }).url;
    },
  };
}

export { sha256Hex };
