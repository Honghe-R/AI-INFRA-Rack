import test from 'node:test';
import assert from 'node:assert/strict';
import * as domain from '../../packages/rack/src/limits.js';
import * as browser from '../../apps/web/src/rack/limits.generated.js';

test('browser inventory bounds match authoritative domain bounds without a runtime backend import', () => {
  assert.deepEqual({ ...browser }, { ...domain });
});
