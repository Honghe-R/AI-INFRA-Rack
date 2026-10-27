import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  createLogger,
  errorPayload,
  errors,
  isCorrelationId,
  loadConfig,
  redact,
  REDACTED,
  resolveCorrelationId,
  successPayload,
} from '../index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('correlation: honours a valid inbound identifier', () => {
  assert.equal(resolveCorrelationId('abc12345-6789'), 'abc12345-6789');
  assert.equal(resolveCorrelationId(['abc12345-6789']), 'abc12345-6789');
});

test('correlation: replaces an invalid inbound identifier', () => {
  assert.notEqual(resolveCorrelationId('short'), 'short');
  assert.match(resolveCorrelationId('short'), UUID);
  assert.match(resolveCorrelationId(undefined), UUID);
  assert.match(resolveCorrelationId('has spaces in it'), UUID);
  assert.equal(isCorrelationId('abc12345-6789'), true);
  assert.equal(isCorrelationId('x'), false);
});

test('error payload matches the documented shape', () => {
  const payload = errorPayload(
    new ApiError('REVISION_CONFLICT', 'The draft is based on an older revision.', {
      status: 409,
      details: [{ field: 'base_revision_id' }],
    }),
    'corr-1234',
  );
  assert.deepEqual(payload, {
    error: {
      code: 'REVISION_CONFLICT',
      message: 'The draft is based on an older revision.',
      details: [{ field: 'base_revision_id' }],
    },
    meta: { correlation_id: 'corr-1234' },
  });
});

test('error payload defaults details to an empty array', () => {
  assert.deepEqual(errorPayload(errors.notFound(), 'corr-1234').error.details, []);
});

test('success payload nests data and carries correlation id', () => {
  assert.deepEqual(successPayload({ id: 1 }, { correlationId: 'corr-1234', meta: { etag: 'e1' } }), {
    data: { id: 1 },
    meta: { etag: 'e1', correlation_id: 'corr-1234' },
  });
});

test('redact: credential-shaped keys are replaced at any depth', () => {
  const output = redact({
    name: 'keep',
    password: 'hunter2',
    nested: { api_key: 'k', licence_key: 'l', private_key: 'p', list: [{ token: 't' }] },
  });
  assert.equal(output.name, 'keep');
  assert.equal(output.password, REDACTED);
  assert.equal(output.nested.api_key, REDACTED);
  assert.equal(output.nested.licence_key, REDACTED);
  assert.equal(output.nested.private_key, REDACTED);
  assert.equal(output.nested.list[0].token, REDACTED);
});

test('redact: signed-URL query parameters are stripped from strings', () => {
  const url = 'https://objects.example/b/k?X-Amz-Signature=deadbeef&X-Amz-Credential=abc&part=1';
  const output = redact({ url });
  assert.ok(!output.url.includes('deadbeef'));
  assert.ok(!output.url.includes('abc'));
  assert.ok(output.url.includes('part=1'));
});

test('redact: survives cycles and excessive depth', () => {
  const cyclic = { name: 'a' };
  cyclic.self = cyclic;
  assert.equal(redact(cyclic).self, '[CIRCULAR]');

  let deep = {};
  const root = deep;
  for (let i = 0; i < 20; i += 1) deep = deep.next = {};
  assert.equal(JSON.stringify(redact(root)).includes('[TRUNCATED]'), true);
});

test('logger: emits one redacted JSON line with correlation id', () => {
  const lines = [];
  const logger = createLogger({
    service: 'svc',
    version: '9.9.9',
    sink: { log: (line) => lines.push(line), warn: () => {}, error: () => {} },
  });
  logger.info('thing.happened', { password: 'hunter2', ok: true }, 'corr-1234');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, 'info');
  assert.equal(record.service, 'svc');
  assert.equal(record.service_version, '9.9.9');
  assert.equal(record.correlation_id, 'corr-1234');
  assert.equal(record.password, REDACTED);
  assert.equal(record.ok, true);
});

test('logger: respects the configured level', () => {
  const lines = [];
  const logger = createLogger({ level: 'warn', sink: { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) } });
  logger.debug('nope');
  logger.info('nope');
  logger.warn('yes');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).message, 'yes');
});

test('config: applies defaults and reads overrides', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.port, 8787);
  assert.equal(defaults.databaseUrl, null);
  assert.equal(defaults.secretSource, 'env');

  const overridden = loadConfig({ PORT: '9999', DATABASE_URL: 'postgres://x', LOG_LEVEL: 'debug', SECRET_SOURCE: 'file' });
  assert.equal(overridden.port, 9999);
  assert.equal(overridden.databaseUrl, 'postgres://x');
  assert.equal(overridden.logLevel, 'debug');
  assert.equal(overridden.secretSource, 'file');
});

test('config: storage defaults suit a local S3-compatible store', () => {
  const local = loadConfig({ STORAGE_ENDPOINT: 'http://127.0.0.1:59000', STORAGE_BUCKET: 'ai-infra-assets' });
  assert.equal(local.storageDriver, 's3');
  assert.equal(local.storageBucket, 'ai-infra-assets');
  assert.equal(local.storageRegion, 'us-east-1');
  // A custom endpoint means path-style addressing, which is what a local store needs.
  assert.equal(local.storageForcePathStyle, true);

  // No endpoint means real S3, where virtual-host addressing is the default.
  const cloud = loadConfig({ STORAGE_BUCKET: 'ai-infra-assets' });
  assert.equal(cloud.storageForcePathStyle, false);
  assert.equal(cloud.storageEndpoint, null);

  // And an explicit choice always wins.
  assert.equal(loadConfig({ STORAGE_ENDPOINT: 'http://x', STORAGE_FORCE_PATH_STYLE: 'false' }).storageForcePathStyle, false);
  assert.equal(loadConfig({ STORAGE_DRIVER: 'filesystem', STORAGE_ROOT: '/tmp/objects' }).storageDriver, 'filesystem');
});

test('config: rejects a non-numeric port rather than producing NaN', () => {
  assert.equal(loadConfig({ PORT: 'not-a-port' }).port, 8787);
});
