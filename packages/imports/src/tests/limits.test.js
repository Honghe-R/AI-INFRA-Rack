import test from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_LIMITS, effectiveLimits } from '../limits.js';
import { IMPORT_DIAGNOSTIC_IDS, getImportDiagnostic, isImportDiagnostic } from '../diagnostics.js';

test('the shared import diagnostics are exactly the documented thirteen', () => {
  const expected = [
    'import.adapter.unsupported',
    'import.adapter.version_unsupported',
    'import.adapter.registration_invalid',
    'import.adapter.deprecated',
    'import.units.unconfirmed',
    'import.transform.unreviewed',
    'import.transform.residual_exceeded',
    'import.transform.control_points_insufficient',
    'import.conversion.incomplete',
    'import.feature.unsupported',
    'import.ifc.schema_unsupported',
    'import.ifc.spatial_structure_invalid',
    'import.ifc.tessellation_exceeded',
  ];
  assert.deepEqual([...IMPORT_DIAGNOSTIC_IDS].sort(), expected.sort());
  assert.equal(getImportDiagnostic('import.feature.unsupported').severity, 'WARNING');
  assert.equal(getImportDiagnostic('import.adapter.unsupported').severity, 'ERROR');
  assert.equal(isImportDiagnostic('import.made.up'), false);
});

test('effective limits clamp a policy override and never exceed a hard ceiling', () => {
  assert.equal(effectiveLimits().maxBytes, IMPORT_LIMITS.maxBytes);
  assert.equal(effectiveLimits({ maxBytes: 1024 }).maxBytes, 1024);
  assert.equal(effectiveLimits({ maxBytes: IMPORT_LIMITS.maxBytesHard * 10 }).maxBytes, IMPORT_LIMITS.maxBytesHard);
  assert.equal(effectiveLimits({ kmlFolderDepth: IMPORT_LIMITS.kmlFolderDepthHard * 10 }).kmlFolderDepth, IMPORT_LIMITS.kmlFolderDepthHard);
});

test('an unknown limit key is ignored rather than invented', () => {
  const limits = effectiveLimits({ notALimit: 5 });
  assert.equal(limits.notALimit, undefined);
});
