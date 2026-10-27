import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLogger } from '@ai-infra/core';
import { createApp } from '../app.js';
import { createRouter } from '../router.js';
import { registerHealthRoutes } from '../routes/health.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function captureLogger() {
  const lines = [];
  const sink = {
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
  return { lines, logger: createLogger({ service: 'test', sink, level: 'debug' }) };
}

function buildRouter() {
  const router = createRouter();
  registerHealthRoutes(router);
  router.post('/echo', async ({ json }) => ({ data: await json() }));
  router.get('/boom', async () => {
    throw new Error('kaboom');
  });
  return router;
}

/** A permissive stand-in, so these tests exercise the transport, not the policy. */
function stubAuthenticator() {
  return {
    async authenticate(ctx) {
      ctx.user = { userId: 'u-test' };
      ctx.authStrength = { mfa: false, authenticatedAt: null };
      return ctx.user;
    },
  };
}

async function withServer(fn, { pool = null, bodyLimitBytes = 1024, capture = captureLogger(), authenticator = stubAuthenticator(), guard = null, router = null, unavailableReason = null } = {}) {
  const app = createApp({
    config: { bodyLimitBytes },
    logger: capture.logger,
    pool,
    router: router ?? buildRouter(),
    authenticator,
    guard,
    unavailableReason,
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, capture);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health returns the success envelope with a minted correlation id', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('x-correlation-id'), UUID);
    const body = await response.json();
    assert.equal(body.data.status, 'ok');
    assert.match(body.meta.correlation_id, UUID);
    assert.equal(body.meta.correlation_id, response.headers.get('x-correlation-id'));
  });
});

test('an inbound correlation id is honoured', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/healthz`, { headers: { 'x-correlation-id': 'caller-supplied-1234' } });
    assert.equal(response.headers.get('x-correlation-id'), 'caller-supplied-1234');
    assert.equal((await response.json()).meta.correlation_id, 'caller-supplied-1234');
  });
});

test('an invalid inbound correlation id is replaced, not echoed', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/healthz`, { headers: { 'x-correlation-id': 'x' } });
    assert.notEqual(response.headers.get('x-correlation-id'), 'x');
    assert.match(response.headers.get('x-correlation-id'), UUID);
  });
});

test('a missing dependency reports its cause instead of pretending the route does not exist', async () => {
  const reason = 'The API is running without a database, so this endpoint is unavailable.';
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/api/v1/me/permissions/check`);
      assert.equal(response.status, 503, 'a documented endpoint must not answer 404 when the cause is a missing database');
      const body = await response.json();
      assert.equal(body.error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(body.error.message, reason);

      const outsideApi = await fetch(`${base}/nope`);
      assert.equal(outsideApi.status, 404, 'non-API paths still behave normally');
    },
    { unavailableReason: reason },
  );
});

test('an unknown route returns the documented error envelope', async () => {
  await withServer(async (base, capture) => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.deepEqual(body.error.details, []);
    assert.match(body.meta.correlation_id, UUID);
    assert.ok(capture.lines.length >= 1);
  });
});

test('a wrong method returns 405 with the allowed methods', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/healthz`, { method: 'POST' });
    assert.equal(response.status, 405);
    const body = await response.json();
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
    assert.deepEqual(body.error.details[0].allowed_methods, ['GET']);
  });
});

test('malformed JSON returns 400', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'MALFORMED_JSON');
  });
});

test('a valid JSON body round-trips', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { hello: 'world' });
  });
});

test('a body over the limit returns 413', async () => {
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(500) }),
      });
      assert.equal(response.status, 413);
      assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');
    },
    { bodyLimitBytes: 64 },
  );
});

test('an unhandled error returns a generic 500 and is logged with detail', async () => {
  await withServer(async (base, capture) => {
    const response = await fetch(`${base}/boom`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred.');
    assert.ok(!JSON.stringify(body).includes('kaboom'), 'the internal message must not reach the client');

    const logged = capture.lines.map((line) => JSON.parse(line)).find((record) => record.message === 'request.unhandled_error');
    assert.ok(logged, 'the unhandled error must be logged');
    assert.equal(logged.error, 'kaboom');
  });
});

test('readiness fails closed without a database', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/readyz`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'SERVICE_UNAVAILABLE');
  });
});

test('readiness succeeds when the database answers', async () => {
  const pool = { query: async () => ({ rows: [{ '?column?': 1 }] }) };
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/readyz`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.status, 'ready');
    },
    { pool },
  );
});

test('readiness fails closed when the database throws', async () => {
  const pool = {
    query: async () => {
      throw new Error('connection refused');
    },
  };
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/readyz`);
      assert.equal(response.status, 503);
    },
    { pool },
  );
});

test('OPTIONS is answered for CORS preflight', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/healthz`, { method: 'OPTIONS' });
    assert.equal(response.status, 204);
  });
});

test('every request is logged with method, path, status, and correlation id', async () => {
  await withServer(async (base, capture) => {
    await fetch(`${base}/healthz`, { headers: { 'x-correlation-id': 'trace-me-123456' } });
    const completed = capture.lines
      .map((line) => JSON.parse(line))
      .find((record) => record.message === 'request.completed');
    assert.ok(completed);
    assert.equal(completed.method, 'GET');
    assert.equal(completed.path, '/healthz');
    assert.equal(completed.status, 200);
    assert.equal(completed.correlation_id, 'trace-me-123456');
    assert.equal(typeof completed.duration_ms, 'number');
  });
});
