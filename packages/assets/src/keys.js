/**
 * Object-store key layout for project assets.
 *
 * The specification's layout (doc/workspace/project-assets.md, "Object Store
 * Layout") places a content checksum in the path. Intake cannot use it: the key
 * must exist before the first byte is read, and the checksum is only known once
 * the last byte has been hashed. The specification also states that object keys
 * are implementation details, so the key is version-addressed instead and the
 * checksum is recorded on the version and representation rows, where it is
 * queryable and unique per asset.
 *
 * Deduplication does not need a content-addressed key: when a version reuses an
 * already-stored object it reuses that object's `storage_key` verbatim, so the
 * bytes are stored once regardless of which version wrote them (D24).
 */
export function originalKey({ projectId, assetId, assetVersionId }) {
  return `projects/${projectId}/assets/${assetId}/versions/${assetVersionId}/original`;
}

export function representationKey({ projectId, assetId, assetVersionId, representationId }) {
  return `projects/${projectId}/assets/${assetId}/versions/${assetVersionId}/representations/${representationId}`;
}

export function previewKey({ projectId, assetId, assetVersionId, producerVersion }) {
  return `projects/${projectId}/assets/${assetId}/versions/${assetVersionId}/preview/${producerVersion}`;
}
