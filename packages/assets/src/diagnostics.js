/**
 * Asset diagnostics.
 *
 * These identifiers are workspace-level and tool-independent (D20). They are the
 * exact set in doc/workspace/project-assets.md, "Asset Diagnostics". A tool MUST
 * surface them unchanged and MUST NOT redefine them; the processing diagnostics
 * in the import framework are a separate namespace.
 */
export const ASSET_DIAGNOSTICS = Object.freeze({
  CHECKSUM_MISSING: diag('asset.checksum.missing', 'ERROR', 'REVIEW_IMPORT', 'An upload is finalized without a verified checksum.'),
  CHECKSUM_MISMATCH: diag('asset.checksum.mismatch', 'ERROR', 'REVIEW_IMPORT', 'Stored bytes do not match the declared checksum.'),
  MALWARE_QUARANTINED: diag('asset.malware.quarantined', 'ERROR', 'REVIEW_IMPORT', 'Malware scan failed or detected a threat.'),
  MEDIA_TYPE_UNSUPPORTED: diag('asset.media_type.unsupported', 'ERROR', 'REVIEW_IMPORT', 'No registered adapter or handler accepts the media type.'),
  VERSION_SUPERSEDED: diag('asset.version.superseded', 'WARNING', 'ADD_DATA', 'A binding or revision consumes a superseded asset version.'),
  REPRESENTATION_STALE: diag('asset.representation.stale', 'WARNING', 'ADD_DATA', 'A consumed representation was produced by an older producer version.'),
  REPRESENTATION_FAILED: diag('asset.representation.failed', 'ERROR', 'REVIEW_IMPORT', 'A required representation failed to process.'),
  RETENTION_HOLD: diag('asset.retention.hold', 'INFO', 'OBTAIN_APPROVAL', 'A retention or legal hold prevents an otherwise permitted deletion.'),
});

function diag(constraintId, severity, remediationCategory, rule) {
  return Object.freeze({ constraintId, severity, remediationCategory, rule });
}

export const ASSET_DIAGNOSTIC_IDS = Object.freeze(
  Object.values(ASSET_DIAGNOSTICS).map((entry) => entry.constraintId),
);

export function getAssetDiagnostic(constraintId) {
  return ASSET_DIAGNOSTIC_IDS.includes(constraintId)
    ? Object.values(ASSET_DIAGNOSTICS).find((entry) => entry.constraintId === constraintId)
    : null;
}
