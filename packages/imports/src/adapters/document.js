import { stat } from 'node:fs/promises';
import { defineAdapter, emptyResult, reconcileCounts } from '../adapter-contract.js';
import { IMPORT_DIAGNOSTICS } from '../diagnostics.js';

/**
 * Vendor study and PDF (and other image documents).
 *
 * Attached as document metadata, never extracted: OCR, table extraction, and
 * vector extraction are out of scope and must not be simulated
 * (doc/workspace/import-adapters.md, "Vendor Study and PDF").
 */
export const descriptor = {
  adapter_id: 'vendor-document',
  adapter_version: '1.0.0',
  media_types: ['application/pdf', 'image/png', 'image/jpeg'],
  extensions: ['.pdf', '.png', '.jpg', '.jpeg'],
  extraction_capabilities: [
    { name: 'attributes', level: 'NONE' },
    { name: 'georeferencing', level: 'NONE' },
  ],
  source_crs_declarations: ['LOCAL'],
  source_unit_declarations: ['unknown'],
  fidelity_level: 'REFERENCE_ONLY',
  supported_range: { min_version: '1', max_version: '1', tested_versions: ['1'] },
  release_level: 'R1',
  status: 'ACTIVE',
  entry_point: new URL('./document.js', import.meta.url).href,
  isolation: 'WORKER_SANDBOX',
  conformance_fixtures: ['packages/imports/src/tests/fixtures/tiny.pdf'],
  required_diagnostics: [IMPORT_DIAGNOSTICS.FEATURE_UNSUPPORTED.constraintId],
};

export async function extract({ path, filename = null, mediaType = 'application/pdf' }) {
  const info = await stat(path);
  const result = emptyResult({ sourceCrs: null, sourceUnits: null, confidence: 'LOW', evidence: ['document metadata only'] });
  result.features = [
    {
      featureId: 'document-1',
      sourceSelector: 'feature:Document',
      disposition: 'REFERENCE_ONLY',
      geometryType: null,
      geojson: null,
      localGeometry: null,
      attributes: { filename: filename ?? null, mediaType, sizeBytes: info.size },
    },
  ];
  result.counts = reconcileCounts(result.features);
  result.diagnostics = [
    { constraintId: IMPORT_DIAGNOSTICS.FEATURE_UNSUPPORTED.constraintId, message: 'A vendor study is reference-only; value extraction is manual.' },
  ];
  return result;
}

export default defineAdapter({ descriptor, extract });
