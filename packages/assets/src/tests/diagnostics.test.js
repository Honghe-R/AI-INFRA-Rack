import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_DIAGNOSTICS, ASSET_DIAGNOSTIC_IDS, getAssetDiagnostic } from '../diagnostics.js';

/**
 * The catalog fixture for the asset namespace: the exact eight identifiers from
 * project-assets.md, each with the severity, remediation, and rule the document
 * states. A missing or renamed identifier fails here rather than in a surface.
 */
const EXPECTED = [
  ['asset.checksum.missing', 'ERROR', 'REVIEW_IMPORT'],
  ['asset.checksum.mismatch', 'ERROR', 'REVIEW_IMPORT'],
  ['asset.malware.quarantined', 'ERROR', 'REVIEW_IMPORT'],
  ['asset.media_type.unsupported', 'ERROR', 'REVIEW_IMPORT'],
  ['asset.version.superseded', 'WARNING', 'ADD_DATA'],
  ['asset.representation.stale', 'WARNING', 'ADD_DATA'],
  ['asset.representation.failed', 'ERROR', 'REVIEW_IMPORT'],
  ['asset.retention.hold', 'INFO', 'OBTAIN_APPROVAL'],
];

test('the asset diagnostic namespace matches the specification exactly', () => {
  assert.equal(ASSET_DIAGNOSTIC_IDS.length, EXPECTED.length);
  for (const [constraintId, severity, remediationCategory] of EXPECTED) {
    const entry = getAssetDiagnostic(constraintId);
    assert.ok(entry, `${constraintId} is registered`);
    assert.equal(entry.severity, severity);
    assert.equal(entry.remediationCategory, remediationCategory);
    assert.ok(entry.rule.length > 0, `${constraintId} carries a rule`);
  }
});

test('an unknown identifier is not silently accepted', () => {
  assert.equal(getAssetDiagnostic('asset.made.up'), null);
  assert.equal(ASSET_DIAGNOSTICS.CHECKSUM_MISSING.constraintId, 'asset.checksum.missing');
});
