import test from 'node:test';
import assert from 'node:assert/strict';
import { originalKey, previewKey, representationKey } from '../keys.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const assetVersionId = '33333333-3333-4333-8333-333333333333';
const representationId = '44444444-4444-4444-8444-444444444444';

test('the original key is project-, asset-, and version-addressed', () => {
  assert.equal(
    originalKey({ projectId, assetId, assetVersionId }),
    `projects/${projectId}/assets/${assetId}/versions/${assetVersionId}/original`,
  );
});

test('representation and preview keys stay under their version', () => {
  assert.equal(
    representationKey({ projectId, assetId, assetVersionId, representationId }),
    `projects/${projectId}/assets/${assetId}/versions/${assetVersionId}/representations/${representationId}`,
  );
  assert.equal(
    previewKey({ projectId, assetId, assetVersionId, producerVersion: 'dxf-1.2' }),
    `projects/${projectId}/assets/${assetId}/versions/${assetVersionId}/preview/dxf-1.2`,
  );
});
