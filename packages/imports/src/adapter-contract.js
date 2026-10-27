/**
 * The adapter contract.
 *
 * An adapter is a descriptor plus one `extract` function. The core pipeline reads
 * only descriptor fields and the extracted result, so registering a format never
 * requires a pipeline, storage, API, or tool change (doc/workspace/import-adapters.md,
 * "Extensibility Model").
 *
 * Adapter modules are loaded by `entry_point` and executed inside the sandbox, so
 * `extract` receives a plain, JSON-serializable context and must return a plain,
 * JSON-serializable result: no class instances, no streams, no functions.
 *
 * Result shape:
 *
 *   {
 *     features: [{
 *       featureId, sourceSelector, disposition: MAPPED | UNMAPPED | REFERENCE_ONLY | REJECTED,
 *       geometryType: POINT | LINESTRING | POLYGON | MULTIPOLYGON | null,
 *       geojson: GeoJSON geometry in WGS 84 when the source CRS is known, else null,
 *       localGeometry: { type, coordinates } in source units when no CRS is known, else null,
 *       attributes: {}, elevationM?, sourceSrid?
 *     }],
 *     georeference: { sourceCrs?, sourceUnits?, verticalCrs?, confidence, evidence },
 *     counts: { extracted, mapped, unmapped, referenceOnly, rejected },
 *     diagnostics: [{ constraintId, message, entityRef? }]
 *   }
 */
export const EXTRACTION_CAPABILITIES = Object.freeze([
  'layers', 'blocks', 'block_attributes', 'text', 'dimensions', 'hatches',
  'feature_groups', 'styles', 'georeferencing', 'attributes', 'spatial_structure',
  'property_sets', 'quantities',
]);

export const CAPABILITY_LEVELS = Object.freeze(['FULL', 'PARTIAL', 'NONE']);
export const FIDELITY_LEVELS = Object.freeze(['FULL', 'PARTIAL', 'REFERENCE_ONLY']);
export const RELEASE_LEVELS = Object.freeze(['R1', 'R2', 'R3']);
export const ADAPTER_STATUSES = Object.freeze(['ACTIVE', 'DEPRECATED', 'RETIRED']);
export const ISOLATION_LEVELS = Object.freeze(['IN_PROCESS', 'WORKER_SANDBOX']);
export const FEATURE_DISPOSITIONS = Object.freeze(['MAPPED', 'UNMAPPED', 'REFERENCE_ONLY', 'REJECTED']);

export function defineAdapter({ descriptor, extract }) {
  if (typeof extract !== 'function') throw new Error('defineAdapter requires an extract function.');
  return Object.freeze({ descriptor: Object.freeze({ ...descriptor }), extract });
}

/** An empty, well-formed result, so an adapter never has to spell every field. */
export function emptyResult({ sourceCrs = null, sourceUnits = null, confidence = 'LOW', evidence = [] } = {}) {
  return {
    features: [],
    georeference: { sourceCrs, sourceUnits, confidence, evidence },
    counts: { extracted: 0, mapped: 0, unmapped: 0, referenceOnly: 0, rejected: 0 },
    diagnostics: [],
  };
}

/**
 * The reconciliation rule: every extracted feature ends in exactly one
 * disposition, and the counts must add up (doc/workspace/import-adapters.md,
 * acceptance criterion 8). A mismatch is a conversion failure, never silent.
 */
export function reconcileCounts(features) {
  const counts = { extracted: features.length, mapped: 0, unmapped: 0, referenceOnly: 0, rejected: 0 };
  for (const feature of features) {
    switch (feature.disposition) {
      case 'MAPPED':
        counts.mapped += 1;
        break;
      case 'REFERENCE_ONLY':
        counts.referenceOnly += 1;
        break;
      case 'REJECTED':
        counts.rejected += 1;
        break;
      case 'UNMAPPED':
      default:
        counts.unmapped += 1;
        break;
    }
  }
  return counts;
}
