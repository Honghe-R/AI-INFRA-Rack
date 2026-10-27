import { IMPORT_DIAGNOSTICS } from '../diagnostics.js';

/**
 * Shared adapter helpers. Kept here so each format module stays about its format.
 */

/** Caps attribute columns per feature; the excess is recorded, never dropped. */
export function capAttributes(attributes, maxColumns, diagnostics) {
  const entries = Object.entries(attributes ?? {});
  if (entries.length <= maxColumns) return { attributes: attributes ?? {}, capped: 0 };
  diagnostics.push({
    constraintId: IMPORT_DIAGNOSTICS.CONVERSION_INCOMPLETE.constraintId,
    message: `Attribute columns capped at ${maxColumns}; ${entries.length - maxColumns} were left reference-only.`,
  });
  return { attributes: Object.fromEntries(entries.slice(0, maxColumns)), capped: entries.length - maxColumns };
}

export function referenceOnly(featureId, attributes, diagnostics, message) {
  diagnostics.push({
    constraintId: IMPORT_DIAGNOSTICS.FEATURE_UNSUPPORTED.constraintId,
    message,
    entityRef: featureId,
  });
  return {
    featureId,
    sourceSelector: `feature:${attributes?.type ?? 'Unknown'}`,
    disposition: 'REFERENCE_ONLY',
    geometryType: null,
    geojson: null,
    localGeometry: null,
    attributes: attributes ?? {},
  };
}
