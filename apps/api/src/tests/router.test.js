import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../router.js';

const handler = () => 'ok';

test('a fixed path still matches exactly', () => {
  const router = createRouter();
  router.get('/api/v1/projects', handler);

  assert.equal(router.match('GET', '/api/v1/projects').found, true);
  // A trailing slash is a different path, exactly as it was before parameters
  // existed; segment counts must agree.
  assert.equal(router.match('GET', '/api/v1/projects/').found, false);
  assert.equal(router.match('GET', '/api/v1').found, false);
});

test('a parameter captures one path segment', () => {
  const router = createRouter();
  router.get('/api/v1/projects/:projectId/scenarios', handler);

  const match = router.match('GET', '/api/v1/projects/abc-123/scenarios');
  assert.equal(match.found, true);
  assert.deepEqual(match.params, { projectId: 'abc-123' });
});

test('a parameter never matches an empty or multi-segment value', () => {
  const router = createRouter();
  router.get('/api/v1/projects/:projectId/scenarios', handler);

  // No separator swallowing: a parameter is one segment, so a deeper path is a
  // different path and must not resolve to this route.
  assert.equal(router.match('GET', '/api/v1/projects/a/b/scenarios').found, false);
  assert.equal(router.match('GET', '/api/v1/projects//scenarios').found, false);
  assert.equal(router.match('GET', '/api/v1/projects').found, false);
});

test('captured values are percent-decoded, and malformed encoding does not throw', () => {
  const router = createRouter();
  router.get('/api/v1/projects/:projectId/scenarios', handler);

  assert.deepEqual(router.match('GET', '/api/v1/projects/a%2Bb/scenarios').params, { projectId: 'a+b' });
  // A stray percent is not an identifier, so it is a miss (a 404 upstream) rather
  // than an exception escaping the router.
  assert.equal(router.match('GET', '/api/v1/projects/%E0%A4%A/scenarios').found, false);
});

test('the more specific pattern wins regardless of registration order', () => {
  const router = createRouter();
  router.get('/api/v1/projects/:projectId/scenarios', handler);
  router.get('/api/v1/projects/archived/scenarios', handler);

  const fixed = router.match('GET', '/api/v1/projects/archived/scenarios');
  assert.equal(fixed.route.path, '/api/v1/projects/archived/scenarios');
  assert.deepEqual(fixed.params, {}, 'a fixed route captures nothing');

  const parameterized = router.match('GET', '/api/v1/projects/xyz/scenarios');
  assert.equal(parameterized.route.path, '/api/v1/projects/:projectId/scenarios');
  assert.deepEqual(parameterized.params, { projectId: 'xyz' });
});

test('a method mismatch on a parameterized path still reports allowed methods', () => {
  const router = createRouter();
  router.get('/api/v1/projects/:projectId/scenarios', handler);
  router.post('/api/v1/projects/:projectId/scenarios', handler);

  const match = router.match('DELETE', '/api/v1/projects/abc/scenarios');
  assert.equal(match.found, true);
  assert.deepEqual(match.allowed, ['GET', 'POST']);
  assert.equal(match.route, undefined);
});

test('a path that is not absolute is rejected at registration', () => {
  const router = createRouter();
  assert.throws(() => router.get('api/v1/projects', handler), /absolute path/);
});
