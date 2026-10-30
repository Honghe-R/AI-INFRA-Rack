import {
  ApiError,
  CORRELATION_ID_HEADER,
  createLogger,
  errorPayload,
  errors,
  resolveCorrelationId,
  successPayload,
} from '@ai-infra/core';
import { createRouter } from './router.js';

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * The request pipeline: correlation, routing, authentication, authorization, the
 * response envelope, and the error contract.
 *
 * Order matters. Authentication attaches the user; the permission guard then
 * answers "may this user do this, at this scope". They are separate middleware
 * because they fail differently — a missing token is 401, a rejected one is 403.
 *
 * Every response carries `meta.correlation_id`, including errors, and echoes it
 * in the `x-correlation-id` header so a caller can join its logs to ours.
 * Unexpected failures are logged with detail and returned as a generic
 * `INTERNAL_ERROR`; a stack trace never reaches a client.
 */
export function createApp({
  config = {},
  logger,
  pool = null,
  secrets = null,
  router = createRouter(),
  authenticator = null,
  guard = null,
  unavailableReason = null,
} = {}) {
  const log = logger ?? createLogger();
  const bodyLimitBytes = config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;

  return async function handle(request, response) {
    const correlationId = resolveCorrelationId(request.headers[CORRELATION_ID_HEADER]);
    const startedAt = process.hrtime.bigint();
    let status = 500;
    let path = request.url;

    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    applyCors(response, config.corsOrigin);

    try {
      if (request.method === 'OPTIONS') {
        status = 204;
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      path = url.pathname;
      // Rack plans can be deleted and restored at the same URL. A cached 410
      // must not hide a restored plan; this also covers authorization/errors.
      if (/^\/api\/v1\/projects\/[^/]+\/rack(?:\/|$)/.test(path) || path.startsWith('/api/v1/assistant/')) {
        response.setHeader('Cache-Control', 'no-store');
      }

      const match = router.match(request.method, path);
      if (!match.found) {
        // A missing dependency leaves the route table incomplete. Saying "not
        // found" for a documented endpoint sends a developer hunting for a typo;
        // name the real cause instead. The reason may depend on the path, because
        // different dependencies disable different route groups.
        const reason = typeof unavailableReason === 'function' ? unavailableReason(path) : unavailableReason;
        if (reason && path.startsWith('/api/v1/')) {
          throw new ApiError('SERVICE_UNAVAILABLE', reason, { status: 503 });
        }
        throw errors.notFound();
      }
      if (match.allowed) throw errors.methodNotAllowed(request.method, match.allowed);

      // The body is read at most once and shared, because the guard may need it
      // to resolve the scope the route declared.
      let bodyPromise = null;
      const readBody = () => {
        if (!bodyPromise) bodyPromise = readJsonBody(request, bodyLimitBytes);
        return bodyPromise;
      };

      const ctx = {
        request,
        response,
        url,
        correlationId,
        logger: log,
        config,
        pool,
        secrets,
        params: match.params ?? {},
        query: Object.fromEntries(url.searchParams),
        // Lower-cased request headers, so a route can read a protocol header such as
        // `Idempotency-Key` without reaching into the Node request object.
        headers: request.headers,
        user: null,
        json: readBody,
      };

      const routeOptions = match.route.options ?? {};
      if (!routeOptions.public) {
        if (!authenticator) {
          throw new ApiError('SERVICE_UNAVAILABLE', 'Authentication is not configured.', { status: 503 });
        }
        await authenticator.authenticate(ctx);
      }

      if (routeOptions.permission) {
        if (!guard) {
          throw new ApiError('SERVICE_UNAVAILABLE', 'Authorization is not configured.', { status: 503 });
        }
        // A streaming route (asset intake) owns its body: reading it here as JSON
        // would buffer the whole upload before the handler could hash it, which
        // is the opposite of D23. The route declares `streamBody` and the handler
        // consumes `ctx.request` directly.
        if (methodHasBody(request.method) && !routeOptions.streamBody) ctx.body = await readBody();
        await guard.check(routeOptions.permission, ctx, routeOptions);
      }

      const result = await match.route.handler(ctx);

      if (response.writableEnded) {
        status = response.statusCode;
        return;
      }

      status = result?.status ?? 200;
      const body = result?.raw ?? successPayload(result?.data ?? null, { correlationId, meta: result?.meta });
      sendJson(response, status, body, result?.headers);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : errors.internal();
      if (!(error instanceof ApiError)) {
        log.error(
          'request.unhandled_error',
          { error: error?.message, stack: error?.stack, name: error?.name },
          correlationId,
        );
      }
      status = apiError.status;
      sendJson(response, status, errorPayload(apiError, correlationId));
    } finally {
      log.info(
        'request.completed',
        {
          method: request.method,
          path,
          status,
          duration_ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
        },
        correlationId,
      );
    }
  };
}

function methodHasBody(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}

async function readJsonBody(request, limitBytes) {
  const declared = Number.parseInt(request.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declared) && declared > limitBytes) throw errors.payloadTooLarge(limitBytes);

  // Drain to the end so a clean 413 can be written, but stop buffering as soon as
  // the limit is passed and cut the connection if the sender keeps going anyway.
  // An upstream proxy enforces the hard cap; this is the application backstop.
  const hardLimit = limitBytes * 8;
  const chunks = [];
  let size = 0;
  let exceeded = false;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      exceeded = true;
      chunks.length = 0;
    } else {
      chunks.push(chunk);
    }
    if (size > hardLimit) {
      request.destroy();
      throw errors.payloadTooLarge(limitBytes);
    }
  }

  if (exceeded) throw errors.payloadTooLarge(limitBytes);
  if (size === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw errors.malformedJson();
  }
}

function sendJson(response, status, body, headers = {}) {
  if (response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function applyCors(response, origin) {
  if (!origin) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'origin');
  response.setHeader(
    'access-control-allow-headers',
    'content-type, if-match, idempotency-key, authorization, x-correlation-id',
  );
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.setHeader('access-control-expose-headers', CORRELATION_ID_HEADER);
}
