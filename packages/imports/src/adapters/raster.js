import { stat } from 'node:fs/promises';
import { defineAdapter, emptyResult, reconcileCounts } from '../adapter-contract.js';
import { IMPORT_DIAGNOSTICS } from '../diagnostics.js';

/**
 * GeoTIFF and raster reference.
 *
 * A raster is a preview underlay: it produces no vector features and never
 * satisfies a geometry role (doc/workspace/import-adapters.md, "GeoTIFF and
 * Raster Reference"). GeoTIFF georeferencing tags are reported as candidates for
 * a reviewer; the adapter does not claim a CRS it has not read.
 */
export const descriptor = {
  adapter_id: 'geotiff',
  adapter_version: '1.0.0',
  media_types: ['image/tiff'],
  extensions: ['.tif', '.tiff'],
  extraction_capabilities: [
    { name: 'georeferencing', level: 'PARTIAL' },
    { name: 'attributes', level: 'NONE' },
  ],
  source_crs_declarations: ['EPSG', 'LOCAL'],
  source_unit_declarations: ['m', 'ft', 'unknown'],
  fidelity_level: 'REFERENCE_ONLY',
  supported_range: { min_version: '1', max_version: '1', tested_versions: ['1'] },
  release_level: 'R1',
  status: 'ACTIVE',
  entry_point: new URL('./raster.js', import.meta.url).href,
  isolation: 'WORKER_SANDBOX',
  conformance_fixtures: ['packages/imports/src/tests/fixtures/tiny.tif'],
  required_diagnostics: [
    IMPORT_DIAGNOSTICS.FEATURE_UNSUPPORTED.constraintId,
    IMPORT_DIAGNOSTICS.UNITS_UNCONFIRMED.constraintId,
  ],
};

export async function extract({ path, filename = null, mediaType = 'image/tiff' }) {
  const info = await stat(path);
  const feature = {
    featureId: 'raster-1',
    sourceSelector: 'feature:Raster',
    disposition: 'REFERENCE_ONLY',
    geometryType: null,
    geojson: null,
    localGeometry: null,
    attributes: { filename: filename ?? null, mediaType, sizeBytes: info.size },
  };

  const result = emptyResult({ sourceCrs: null, sourceUnits: null, confidence: 'LOW', evidence: ['GeoTIFF tags not interpreted in R1'] });
  result.features = [feature];
  result.counts = reconcileCounts(result.features);
  result.diagnostics = [
    { constraintId: IMPORT_DIAGNOSTICS.FEATURE_UNSUPPORTED.constraintId, message: 'Raster content is a preview underlay and is reference-only.' },
    { constraintId: IMPORT_DIAGNOSTICS.UNITS_UNCONFIRMED.constraintId, message: 'Raster georeferencing tags are not interpreted in R1.' },
  ];
  return result;
}

export default defineAdapter({ descriptor, extract });
