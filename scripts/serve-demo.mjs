#!/usr/bin/env node
/**
 * The demo edge.
 *
 * One public origin in front of three things that must not be reachable directly: the
 * static shell, the API, and the object store. It exists because the demo is served by IP
 * on a single open port, and because the shell has no sign-in surface yet.
 *
 * This is the production stand-in for `server.proxy` in `apps/web/vite.config.js`, and it
 * reproduces that file's token bridge deliberately: the browser cannot obtain a token, so
 * the edge mints one per demo identity and attaches it to the requests the shell makes.
 * The secret stays in this process and never reaches the bundle.
 *
 * Routing, in match order:
 *
 *   /__dev/identities   the identities the account control offers
 *   /healthz, /readyz   proxied to the API unchanged; public, no token
 *   /api/*              proxied to the API with a minted bearer token
 *   /<bucket>/*         proxied verbatim to the object store
 *   everything else     static from WEB_DIST, falling back to index.html
 *
 * Three invariants hold this together. Each is a real failure mode, not a preference:
 *
 *  1. **The object-store `Host` header is preserved.** `signRequest` and `presignUrl`
 *     (packages/storage/src/sigv4.js) both sign `host`, and the store re-derives the
 *     signature from the `Host` it receives. Rewriting it to the loopback address breaks
 *     every upload and download with a signature error.
 *  2. **No bearer token is ADDED on the object-store route.** A presigned URL
 *     authenticates via its query string, and a token the edge injected would invalidate
 *     that signature. The client's own `Authorization` header is still forwarded,
 *     untouched: the application's own object I/O is header-signed (`putObject`,
 *     `headObject`, `getObject`, `ensureBucket` all send one), and dropping it turns every
 *     such call into a 403. Not injecting is enough, and `injectToken: false` guarantees it.
 *  3. **`x-dev-subject` never reaches the API.** The API authenticates on the bearer token
 *     alone. Forwarding the header would let any client name its own identity.
 *
 * Bodies are streamed, never buffered, because asset uploads pass through here.
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { SignJWT } from 'jose';
import { createLogger } from '@ai-infra/core';
import { DEFAULT_DEV_SUBJECT, clientIdentities, devSubjects } from './lib/dev-identities.mjs';

const logger = createLogger({
  service: process.env.SERVICE_NAME ?? 'ai-infra-edge',
  version: process.env.SERVICE_VERSION ?? '0.1.0',
  level: process.env.LOG_LEVEL ?? 'info',
});

// --- configuration --------------------------------------------------------------------

function pick(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const PORT = Number(pick('EDGE_PORT', '5500'));
// All interfaces by default, so the site answers on the public IP. Narrow this to
// 127.0.0.1 once Apache fronts it, so the plain-HTTP hop is not reachable from outside.
const HOST = pick('EDGE_HOST', '0.0.0.0');
const API_URL = new URL(pick('API_URL', 'http://127.0.0.1:8787'));
const OBJECT_STORE_URL = new URL(pick('MINIO_ENDPOINT', 'http://127.0.0.1:9000'));
const BUCKET = pick('STORAGE_BUCKET', 'ai-infra-objects');
const WEB_DIST = resolve(pick('WEB_DIST', 'apps/web/dist'));
const TLS_CERT = pick('TLS_CERT', null);
const TLS_KEY = pick('TLS_KEY', null);

const AUTH_DEV_SECRET = pick('AUTH_DEV_SECRET', null);
const AUTH_ISSUER = pick('AUTH_ISSUER', 'https://identity.local');
const AUTH_AUDIENCE = pick('AUTH_AUDIENCE', null);
const DEFAULT_SUBJECT = pick('AUTH_DEV_SUBJECT', DEFAULT_DEV_SUBJECT);

/** The header `apps/web/src/app/dev-identity.js` sends. Stripped before the API sees it. */
const IDENTITY_HEADER = 'x-dev-subject';

const BUCKET_PATH = `/${BUCKET}`;

// --- the token bridge -----------------------------------------------------------------

const DEV_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * One entry per identity: a minter, and the token it last produced.
 *
 * The request path is synchronous — it has to be, the upstream request is already in
 * flight — so a token cannot be minted on demand there. Minting every subject up front
 * and refreshing on a timer keeps that path a map lookup, exactly as the Vite dev server
 * does it. `devSubjects` is the shared list, so a subject can never be reachable by the
 * header without a token existing for it.
 */
const tokenEntries = new Map();

async function refreshTokens() {
  for (const subject of devSubjects({ include: DEFAULT_SUBJECT })) {
    let entry = tokenEntries.get(subject);
    if (!entry) {
      const key = new TextEncoder().encode(AUTH_DEV_SECRET);
      entry = {
        token: null,
        mint: async () => {
          const now = Math.floor(Date.now() / 1000);
          const builder = new SignJWT({})
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject(subject)
            .setIssuer(AUTH_ISSUER)
            .setIssuedAt(now)
            .setExpirationTime(now + DEV_TOKEN_TTL_SECONDS);
          if (AUTH_AUDIENCE) builder.setAudience(AUTH_AUDIENCE);
          return builder.sign(key);
        },
      };
      tokenEntries.set(subject, entry);
    }
    try {
      entry.token = await entry.mint();
    } catch (error) {
      // Keep the previous token; the next tick tries again.
      logger.warn('edge.token_mint_failed', { subject, reason: error?.message });
    }
  }
}

/**
 * The token for a subject, falling back to the default.
 *
 * An unknown subject resolves to the default identity rather than to nothing: the shell
 * only ever offers subjects from `/__dev/identities`, so an unrecognised one means a stale
 * `localStorage` value, and answering as the default is clearer than a bare 401.
 */
function tokenFor(subject) {
  const entry = tokenEntries.get(subject) ?? tokenEntries.get(DEFAULT_SUBJECT);
  return entry?.token ?? null;
}

// --- proxying -------------------------------------------------------------------------

/** Headers that belong to a single hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function stripHopByHop(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * Streams a request to an upstream and streams the response back.
 *
 * `preserveHost` is the object store's requirement (invariant 1). The API gets the
 * upstream host instead, because it has no opinion about its own name and a deterministic
 * value is easier to reason about than whatever the client sent.
 */
function proxy(request, response, { target, label, injectToken = false, preserveHost = false }) {
  const headers = stripHopByHop(request.headers);
  headers.host = preserveHost ? request.headers.host : target.host;

  // Invariant 3: never forward the identity header, whichever route this is.
  delete headers[IDENTITY_HEADER];

  if (injectToken) {
    const asked = request.headers[IDENTITY_HEADER];
    const token = asked ? tokenFor(asked) : tokenFor(DEFAULT_SUBJECT);
    if (token) headers.authorization = `Bearer ${token}`;
  }
  // No `else`. On the object-store route the client's own `Authorization` header is
  // forwarded as-is — see invariant 2. The only requirement is that the edge adds none,
  // which `injectToken: false` already ensures.

  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = send(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, stripHopByHop(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    },
  );

  upstream.on('error', (error) => {
    logger.error('edge.upstream_error', { label, reason: error?.message });
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendJson(response, 502, {
      error: { code: 'UPSTREAM_UNAVAILABLE', message: `The ${label} is not reachable from the edge.` },
    });
  });

  // Streamed, not buffered: asset intake passes through this path.
  request.pipe(upstream);
}

// --- static files ---------------------------------------------------------------------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Cache policy. Vite emits content-hashed filenames under `assets/`, so those are
 * immutable; `index.html` names them and must never be cached, or a deploy is invisible
 * to a browser that already has it.
 */
function cacheControlFor(path) {
  return path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store';
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${request.method} is not supported here.` } });
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: { code: 'BAD_REQUEST', message: 'Malformed path.' } });
    return;
  }

  const candidate = resolve(join(WEB_DIST, normalize(decoded)));
  // Path traversal guard: the resolved path must stay inside the build output.
  if (candidate !== WEB_DIST && !candidate.startsWith(WEB_DIST + sep)) {
    sendJson(response, 403, { error: { code: 'FORBIDDEN', message: 'Outside the build output.' } });
    return;
  }

  let filePath = candidate;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // A missing file with an extension is a genuine 404. A missing extensionless path is
    // a client-side route, which the shell resolves, so hand it index.html.
    if (extname(filePath)) {
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'No such file.' } });
      return;
    }
    filePath = join(WEB_DIST, 'index.html');
  }

  let body;
  try {
    body = await readFile(filePath);
  } catch (error) {
    logger.error('edge.static_read_failed', { path: filePath, reason: error?.message });
    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'No such file.' } });
    return;
  }

  response.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': body.length,
    'cache-control': cacheControlFor(filePath),
  });
  // A HEAD carries the headers a GET would, and no body.
  response.end(request.method === 'HEAD' ? undefined : body);
}

// --- routing --------------------------------------------------------------------------

function handle(request, response) {
  const startedAt = Date.now();
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  response.on('finish', () => {
    logger.info('edge.request', {
      method: request.method,
      path: pathname,
      status: response.statusCode,
      duration_ms: Date.now() - startedAt,
    });
  });

  if (request.method === 'OPTIONS') {
    // Same origin throughout, so no preflight should reach here; answer it anyway.
    response.writeHead(204, { 'access-control-allow-origin': request.headers.origin ?? '*' });
    response.end();
    return;
  }

  // The identity list the account control reads. Mirrors the Vite dev server exactly:
  // no secret means no endpoint, so a deployment without the bridge reports no identities
  // rather than offering switches that would fail authentication.
  if (pathname === '/__dev/identities') {
    if (!AUTH_DEV_SECRET) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end('{}');
      return;
    }
    sendJson(response, 200, { data: { defaultSubject: DEFAULT_SUBJECT, identities: clientIdentities() } });
    return;
  }

  if (pathname === '/healthz' || pathname === '/readyz') {
    proxy(request, response, { target: API_URL, label: 'API' });
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    proxy(request, response, { target: API_URL, label: 'API', injectToken: true });
    return;
  }

  // The object store, addressed by bucket name. Matched by that literal prefix rather
  // than by "anything not otherwise handled", so a future shell route cannot be swallowed
  // here. The bucket is named `ai-infra-objects` so it cannot collide with `/assets/`.
  if (pathname === BUCKET_PATH || pathname.startsWith(`${BUCKET_PATH}/`)) {
    proxy(request, response, { target: OBJECT_STORE_URL, label: 'object store', preserveHost: true });
    return;
  }

  serveStatic(request, response, pathname).catch((error) => {
    logger.error('edge.unhandled_error', { path: pathname, reason: error?.message });
    if (response.headersSent) response.destroy();
    else sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Edge failure.' } });
  });
}

// --- startup --------------------------------------------------------------------------

async function start() {
  // Fail loudly at startup rather than serving a broken shell: without the build there is
  // nothing to serve and every browser request would 404 with no explanation.
  try {
    await stat(join(WEB_DIST, 'index.html'));
  } catch {
    throw new Error(`No build found at ${WEB_DIST}. Run the web build first (see the runbook, §6.4).`);
  }

  if (!AUTH_DEV_SECRET) {
    logger.warn('edge.no_dev_secret', {
      reason: 'AUTH_DEV_SECRET is unset; /__dev/identities answers 404 and every API call will be 401.',
    });
  } else {
    await refreshTokens();
    logger.info('edge.tokens_minted', { subjects: tokenEntries.size });
    // Refresh well before expiry so a long demo does not start failing.
    setInterval(() => {
      refreshTokens().catch(() => {});
    }, DEV_TOKEN_TTL_SECONDS * 1000 * 0.75).unref?.();
  }

  let server;
  let scheme = 'http';
  if (TLS_CERT && TLS_KEY) {
    const [cert, key] = await Promise.all([readFile(TLS_CERT), readFile(TLS_KEY)]);
    server = createHttpsServer({ cert, key }, handle);
    scheme = 'https';
  } else {
    // Plain HTTP is the local-test path, and the behind-Apache path where something else
    // terminates TLS.
    server = createHttpServer(handle);
  }

  server.listen(PORT, HOST, () => {
    logger.info('edge.listening', {
      scheme,
      host: HOST,
      port: PORT,
      web_dist: WEB_DIST,
      api: API_URL.origin,
      object_store: OBJECT_STORE_URL.origin,
      bucket: BUCKET,
    });
  });

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('edge.shutdown', { signal });
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}

start().catch((error) => {
  logger.error('edge.startup_failed', { reason: error?.message });
  process.exit(1);
});
