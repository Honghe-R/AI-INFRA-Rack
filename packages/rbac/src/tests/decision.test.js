import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionError, REASON, allowed, assertAllowed, denied, httpStatusFor, toResult } from '../index.js';

test('non-throwing result echoes scope and states a reason on denial', () => {
  const allowedResult = toResult(allowed('project', { functionId: 'k1', projectId: 'p1', organisationId: 'o1' }), 'facility.read');
  assert.deepEqual(allowedResult, {
    allowed: true,
    grant: 'project',
    functionId: 'k1',
    functionKey: 'facility.read',
    projectId: 'p1',
    organisationId: 'o1',
  });
  assert.equal('reason' in allowedResult, false, 'an allowed result carries no reason');

  const deniedResult = toResult(denied(REASON.UNKNOWN_FUNCTION, { projectId: 'p1' }), 'facility.nope');
  assert.equal(deniedResult.allowed, false);
  assert.equal(deniedResult.reason, REASON.UNKNOWN_FUNCTION);
  assert.equal(deniedResult.functionKey, 'facility.nope');
  assert.equal(deniedResult.grant, null);
});

test('showcase and read-only flags survive the non-throwing wrapper', () => {
  const result = toResult(allowed('showcase', { projectId: 'p1', showcase: true, readOnly: true }), 'facility.read');
  assert.equal(result.showcase, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.grant, 'showcase');
});

test('the throwing wrapper maps reasons to codes and statuses', () => {
  const cases = [
    [REASON.UNAUTHENTICATED, 401, 'UNAUTHENTICATED'],
    [REASON.FUNCTION_REQUIRED, 403, 'FUNCTION_REQUIRED'],
    [REASON.INSUFFICIENT_PERMISSION, 403, 'INSUFFICIENT_PERMISSION'],
    [REASON.UNKNOWN_FUNCTION, 403, 'UNKNOWN_FUNCTION'],
  ];
  for (const [reason, status, code] of cases) {
    try {
      assertAllowed(denied(reason), 'facility.read');
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error instanceof PermissionError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.functionKey, 'facility.read');
      assert.deepEqual(error.details, [{ function_key: 'facility.read' }]);
    }
  }
});

test('the throwing wrapper returns the decision when allowed', () => {
  const decision = allowed('global', { functionId: 'k1' });
  assert.equal(assertAllowed(decision, 'facility.read'), decision);
});

test('http status maps an allowed decision to 200', () => {
  assert.equal(httpStatusFor(allowed('global')), 200);
  assert.equal(httpStatusFor(denied(REASON.UNAUTHENTICATED)), 401);
  assert.equal(httpStatusFor(denied(REASON.INSUFFICIENT_PERMISSION)), 403);
});
