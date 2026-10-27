import { readFile } from 'node:fs/promises';
import { defineAdapter, emptyResult, reconcileCounts } from '../adapter-contract.js';
import { IMPORT_DIAGNOSTICS } from '../diagnostics.js';
import { capAttributes, referenceOnly } from './shared.js';

/**
 * GeoJSON (RFC 7946).
 *
 * WGS 84 is the format's own CRS, so georeferencing is confirmed rather than
 * inferred. Geometry is preserved verbatim; unknown or missing geometry is
 * reference-only.
 */
const SUPPORTED = new Set(['Point', 'LineString', 'Polygon', 'MultiPolygon']);

export const descriptor = {
  adapter_id: 'geojson',
  adapter_version: '1.0.0',
  media_types: ['application/geo+json', 'application/json'],
  extensions: ['.geojson', '.json'],
  extraction_capabilities: [
    { name: 'georeferencing', level: 'FULL' },
    { name: 'attributes', level: 'FULL' },
  ],
  source_crs_declarations: ['EPSG:4326'],
  source_unit_declarations: ['deg'],
  fidelity_level: 'FULL',
  supported_range: { min_version: '1', max_version: '1', tested_versions: ['1'] },
  release_level: 'R1',
  status: 'ACTIVE',
  entry_point: new URL('./geojson.js', import.meta.url).href,
  isolation: 'WORKER_SANDBOX',
  conformance_fixtures: ['packages/imports/src/tests/fixtures/sample.geojson'],
  required_diagnostics: [
    IMPORT_DIAGNOSTICS.FEATURE_UNSUPPORTED.constraintId,
    IMPORT_DIAGNOSTICS.CONVERSION_INCOMPLETE.constraintId,
  ],
};

export async function extract({ path, limits = {} }) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const diagnostics = [];
  const maxColumns = limits.maxAttributeColumns ?? 512;

  const collection = parsed?.type === 'FeatureCollection' ? parsed.features ?? [] : [parsed];
  const features = [];
  let index = 0;

  for (const item of collection) {
    index += 1;
    const geometry = item?.type === 'Feature' ? item.geometry : item?.type ? item : null;
    const featureId = item?.id !== undefined && item?.id !== null ? String(item.id) : `geojson-${index}`;

    if (!geometry || !SUPPORTED.has(geometry.type)) {
      features.push(referenceOnly(featureId, { ...(item?.properties ?? {}), type: geometry?.type ?? 'Missing' }, diagnostics, `Unsupported or missing geometry "${geometry?.type ?? 'none'}".`));
      continue;
    }

    const { attributes } = capAttributes(item?.properties ?? {}, maxColumns, diagnostics);
    features.push({
      featureId,
      sourceSelector: `feature:${geometry.type}`,
      disposition: 'MAPPED',
      geometryType: geometry.type.toUpperCase(),
      geojson: geometry,
      localGeometry: null,
      attributes,
    });
  }

  const result = emptyResult({ sourceCrs: 'EPSG:4326', sourceUnits: 'deg', confidence: 'HIGH', evidence: ['RFC 7946'] });
  result.features = features;
  result.counts = reconcileCounts(features);
  result.diagnostics = diagnostics;
  return result;
}

export default defineAdapter({ descriptor, extract });
