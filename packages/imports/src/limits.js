/**
 * Adapter limits.
 *
 * The defaults and hard ceilings from doc/workspace/import-adapters.md, "Adapter
 * Limits". Project policy MAY lower a default and MUST NOT raise a hard ceiling,
 * so `effectiveLimits` clamps every override.
 */
export const IMPORT_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxBytesHard: 5 * 1024 * 1024 * 1024,
  archiveEntries: 10_000,
  archiveEntriesHard: 50_000,
  archiveExpansionRatio: 10,
  archiveExpansionRatioHard: 100,
  maxFeatures: 1_000_000,
  maxFeaturesHard: 5_000_000,
  maxVerticesPerGeometry: 100_000,
  maxVerticesPerGeometryHard: 1_000_000,
  maxVerticesPerDocument: 50_000_000,
  maxVerticesPerDocumentHard: 200_000_000,
  blockNestingDepth: 16,
  blockNestingDepthHard: 32,
  kmlFolderDepth: 32,
  kmlFolderDepthHard: 64,
  jsonNestingDepth: 64,
  jsonNestingDepthHard: 128,
  maxAttributeColumns: 512,
  maxAttributeColumnsHard: 2_048,
  maxControlPoints: 100,
  conversionTimeoutMs: 30 * 60 * 1000,
  conversionTimeoutMsHard: 2 * 60 * 60 * 1000,
  previewTimeoutMs: 5 * 60 * 1000,
  previewTimeoutMsHard: 15 * 60 * 1000,
  concurrentJobsPerProject: 4,
  concurrentJobsPerProjectHard: 8,
  concurrentJobsPerOrganization: 16,
  concurrentJobsPerOrganizationHard: 32,
});

export function effectiveLimits(overrides = {}) {
  const effective = { ...IMPORT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    const ceiling = IMPORT_LIMITS[`${key}Hard`];
    if (ceiling === undefined) continue;
    effective[key] = Math.min(Math.max(Number(value), 1), ceiling);
  }
  return Object.freeze(effective);
}

/** A hard breach that must reject the document deterministically. */
export class AdapterLimitError extends Error {
  constructor(limit, observed, ceiling) {
    super(`The document exceeds the ${limit} limit.`);
    this.name = 'AdapterLimitError';
    this.code = 'import.limit.exceeded';
    this.limit = limit;
    this.observed = observed;
    this.ceiling = ceiling;
  }
}

export function assertWithinLimit(limit, observed, ceiling) {
  if (observed > ceiling) throw new AdapterLimitError(limit, observed, ceiling);
}
