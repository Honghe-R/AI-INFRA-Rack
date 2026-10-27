/**
 * Shared adapter diagnostics.
 *
 * The exact set from doc/workspace/import-adapters.md, "Shared Adapter
 * Diagnostics". These are workspace-level and tool-independent; an adapter MUST
 * declare every identifier it can emit and MUST NOT invent one. Registration is
 * rejected when a descriptor names anything outside this registry.
 */
export const IMPORT_DIAGNOSTICS = Object.freeze({
  ADAPTER_UNSUPPORTED: diag('import.adapter.unsupported', 'ERROR', 'REVIEW_IMPORT', 'No adapter resolves the media type and extension.'),
  ADAPTER_VERSION_UNSUPPORTED: diag('import.adapter.version_unsupported', 'ERROR', 'REVIEW_IMPORT', 'Adapter or converter version is outside supported_range.'),
  ADAPTER_REGISTRATION_INVALID: diag('import.adapter.registration_invalid', 'ERROR', 'REVIEW_IMPORT', 'Descriptor is malformed or declares an unknown diagnostic identifier.'),
  ADAPTER_DEPRECATED: diag('import.adapter.deprecated', 'WARNING', 'REVIEW_IMPORT', 'The resolving adapter is DEPRECATED.'),
  UNITS_UNCONFIRMED: diag('import.units.unconfirmed', 'ERROR', 'REVIEW_IMPORT', 'Source units are absent, ambiguous, or unconfirmed.'),
  TRANSFORM_UNREVIEWED: diag('import.transform.unreviewed', 'ERROR', 'REVIEW_IMPORT', 'Spatial transform is not REVIEWED.'),
  TRANSFORM_RESIDUAL_EXCEEDED: diag('import.transform.residual_exceeded', 'WARNING', 'REVIEW_IMPORT', 'Fitted-transform residual exceeds tolerance.'),
  TRANSFORM_CONTROL_POINTS_INSUFFICIENT: diag('import.transform.control_points_insufficient', 'ERROR', 'REVIEW_IMPORT', 'Source CRS is absent and fewer than two reviewed control points exist.'),
  CONVERSION_INCOMPLETE: diag('import.conversion.incomplete', 'WARNING', 'REVIEW_IMPORT', 'Converter reported partial fidelity or a reconciliation failure.'),
  FEATURE_UNSUPPORTED: diag('import.feature.unsupported', 'WARNING', 'REVIEW_IMPORT', 'Source feature is reference-only or unsupported.'),
  IFC_SCHEMA_UNSUPPORTED: diag('import.ifc.schema_unsupported', 'ERROR', 'REVIEW_IMPORT', 'IFC schema is not IFC2X3, IFC4, or IFC4X3, or is outside the supported range.'),
  IFC_SPATIAL_STRUCTURE_INVALID: diag('import.ifc.spatial_structure_invalid', 'ERROR', 'REVIEW_IMPORT', 'IFC spatial structure is missing, duplicated, or has a non-monotonic storey sequence.'),
  IFC_TESSELLATION_EXCEEDED: diag('import.ifc.tessellation_exceeded', 'WARNING', 'REVIEW_IMPORT', 'IFC geometry tessellation deviation exceeds the project tolerance.'),
});

function diag(constraintId, severity, remediationCategory, rule) {
  return Object.freeze({ constraintId, severity, remediationCategory, rule });
}

export const IMPORT_DIAGNOSTIC_IDS = Object.freeze(
  Object.values(IMPORT_DIAGNOSTICS).map((entry) => entry.constraintId),
);

export function getImportDiagnostic(constraintId) {
  return Object.values(IMPORT_DIAGNOSTICS).find((entry) => entry.constraintId === constraintId) ?? null;
}

export function isImportDiagnostic(constraintId) {
  return IMPORT_DIAGNOSTIC_IDS.includes(constraintId);
}
