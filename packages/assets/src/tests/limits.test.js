import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_KINDS,
  DEFAULT_MAX_ASSET_BYTES,
  HARD_MAX_ASSET_BYTES,
  isValidMediaType,
  kindForMediaType,
  uploadLimits,
} from '../limits.js';

test('the declared kinds are the documented set', () => {
  assert.deepEqual(ASSET_KINDS, ['CAD', 'BIM', 'GIS', 'RASTER', 'DOCUMENT', 'DATASET', 'OTHER']);
});

test('media types are validated syntactically, not against adapters', () => {
  assert.equal(isValidMediaType('image/vnd.dxf'), true);
  assert.equal(isValidMediaType('application/x-step'), true);
  assert.equal(isValidMediaType('not-a-media-type'), false);
  assert.equal(isValidMediaType(''), false);
  assert.equal(isValidMediaType(null), false);
});

test('a kind is inferred from the media type and defaults to OTHER', () => {
  assert.equal(kindForMediaType('image/vnd.dwg'), 'CAD');
  assert.equal(kindForMediaType('model/ifc'), 'BIM');
  assert.equal(kindForMediaType('application/vnd.google-earth.kml+xml'), 'GIS');
  assert.equal(kindForMediaType('image/tiff'), 'RASTER');
  assert.equal(kindForMediaType('application/pdf'), 'DOCUMENT');
  assert.equal(kindForMediaType('application/x-custom'), 'OTHER');
});

test('project policy may lower the limit but never raise the hard ceiling', () => {
  assert.equal(DEFAULT_MAX_ASSET_BYTES, 2 * 1024 * 1024 * 1024);
  assert.equal(uploadLimits({ maxBytes: 1024 }).maxBytes, 1024);
  assert.equal(uploadLimits({ maxBytes: HARD_MAX_ASSET_BYTES * 10 }).maxBytes, HARD_MAX_ASSET_BYTES);
  assert.equal(uploadLimits({ maxBytes: 0 }).maxBytes, 1);
});
