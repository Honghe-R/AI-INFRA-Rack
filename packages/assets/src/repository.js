/**
 * Persistence for project assets (doc/workspace/project-assets.md, "Persistence
 * Models", and D22's tenant-key discipline).
 *
 * Every function takes an open transaction client. The service owns transaction
 * boundaries because intake is deliberately split into three short transactions:
 * reserve, stream, finalize. Holding a database transaction open for the length
 * of a multi-gigabyte upload would pin a connection and a snapshot for minutes.
 *
 * Every statement names project_id explicitly. Row-level security also filters
 * on it, but the explicit predicate keeps the statement correct where the caller
 * is the table owner and RLS does not apply.
 */

const ASSET_COLUMN_NAMES = [
  'asset_id', 'project_id', 'name', 'kind', 'media_type', 'status',
  'access_classification', 'current_version_id', 'version_count', 'tags',
  'retention_class', 'owner', 'created_at', 'updated_at',
];
const VERSION_COLUMN_NAMES = [
  'asset_version_id', 'project_id', 'asset_id', 'version_number', 'intake_state',
  'content_checksum', 'size_bytes', 'storage_key', 'filename', 'media_type',
  'malware_scan_state', 'status', 'supersedes_asset_version_id', 'source_ref',
  'provenance', 'uploaded_at', 'uploaded_by', 'created_at',
];
const REPRESENTATION_COLUMN_NAMES = [
  'representation_id', 'project_id', 'asset_version_id', 'kind', 'media_type',
  'content_checksum', 'storage_key', 'producer_id', 'producer_version', 'status',
  'created_at',
];

const ASSET_COLUMNS = ASSET_COLUMN_NAMES.join(', ');
const VERSION_COLUMNS = VERSION_COLUMN_NAMES.join(', ');
const REPRESENTATION_COLUMNS = REPRESENTATION_COLUMN_NAMES.join(', ');
const ASSET_COLUMNS_A = ASSET_COLUMN_NAMES.map((column) => `a.${column}`).join(', ');

export async function insertAssetAndPendingVersion(client, {
  assetId,
  assetVersionId,
  projectId,
  name,
  kind,
  mediaType,
  accessClassification,
  retentionClass,
  owner,
  tags,
  filename,
  sourceRef,
  provenance,
  actorId,
}) {
  await client.query(
    `INSERT INTO project_assets
       (asset_id, project_id, name, kind, media_type, access_classification,
        current_version_id, version_count, tags, retention_class, owner, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11)`,
    [assetId, projectId, name, kind, mediaType, accessClassification, assetVersionId, tags, retentionClass, owner, actorId],
  );

  const { rows } = await client.query(
    `INSERT INTO asset_versions
       (asset_version_id, project_id, asset_id, version_number, filename, media_type,
        source_ref, provenance, uploaded_by, created_by)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $8)
     RETURNING ${VERSION_COLUMNS}`,
    [assetVersionId, projectId, assetId, filename, mediaType, sourceRef, provenance, actorId],
  );
  return mapVersion(rows[0]);
}

export async function insertPendingVersion(client, {
  assetVersionId,
  projectId,
  assetId,
  filename,
  mediaType,
  sourceRef,
  provenance,
  actorId,
}) {
  const { rows } = await client.query(
    `INSERT INTO asset_versions
       (asset_version_id, project_id, asset_id, version_number, filename, media_type,
        supersedes_asset_version_id, source_ref, provenance, uploaded_by, created_by)
     SELECT $1, $2, $3, COALESCE(MAX(version_number), 0) + 1, $4, $5,
            (SELECT av.asset_version_id FROM asset_versions av
              WHERE av.asset_id = $3 AND av.project_id = $2 AND av.status = 'CURRENT'
              ORDER BY av.version_number DESC LIMIT 1),
            $6, $7, $8, $8
       FROM asset_versions
      WHERE asset_id = $3 AND project_id = $2
     RETURNING ${VERSION_COLUMNS}`,
    [assetVersionId, projectId, assetId, filename, mediaType, sourceRef, provenance, actorId],
  );
  return mapVersion(rows[0]);
}

export async function getAsset(client, projectId, assetId) {
  const { rows } = await client.query(
    `SELECT ${ASSET_COLUMNS} FROM project_assets WHERE asset_id = $1 AND project_id = $2`,
    [assetId, projectId],
  );
  return rows[0] ? mapAsset(rows[0]) : null;
}

export async function listAssets(client, projectId, { kind = null, status = null, mediaType = null, query = null, limit = 100, actorId = null } = {}) {
  const { rows } = await client.query(
    `SELECT ${ASSET_COLUMNS_A},
            v.version_number AS current_version_number,
            v.size_bytes AS current_size_bytes,
            v.malware_scan_state AS current_scan_state,
            (
              a.access_classification = 'PROJECT'
              OR EXISTS (
                SELECT 1 FROM asset_access_grants g
                 WHERE g.asset_id = a.asset_id
                   AND g.project_id = a.project_id
                   AND g.grantee_id = $7::uuid
                   AND g.revoked_at IS NULL
              )
            ) AS authorized,
            COALESCE(
              (SELECT array_agg(DISTINCT b.tool_id)
                 FROM asset_bindings b
                WHERE b.asset_version_id IN (
                  SELECT av.asset_version_id FROM asset_versions av
                   WHERE av.asset_id = a.asset_id AND av.project_id = a.project_id)
                  AND b.project_id = a.project_id),
              '{}'
            ) AS bound_tool_ids
       FROM project_assets a
       LEFT JOIN asset_versions v
         ON v.asset_version_id = a.current_version_id AND v.project_id = a.project_id
      WHERE a.project_id = $1
        AND ($2::asset_kind IS NULL OR a.kind = $2)
        AND ($3::asset_status IS NULL OR a.status = $3)
        AND ($4::text IS NULL OR a.media_type = $4)
        AND ($5::text IS NULL OR a.name ILIKE '%' || $5 || '%' OR a.media_type ILIKE '%' || $5 || '%')
      ORDER BY a.created_at DESC, a.asset_id
      LIMIT $6`,
    [projectId, kind, status, mediaType, query, Math.min(Math.max(limit, 1), 500), actorId],
  );
  return rows.map((row) => ({
    ...mapAsset(row),
    // The Assets surface renders these directly; projecting them here keeps the
    // browser from re-deriving them from a nested version object (ui-pattern.md,
    // "Assets Surface").
    currentVersionNumber: row.current_version_number,
    versionNumber: row.current_version_number,
    sizeBytes: row.current_size_bytes === null ? null : Number(row.current_size_bytes),
    scanState: row.current_scan_state,
    classification: row.access_classification,
    uploader: row.owner,
    boundToolIds: row.bound_tool_ids,
    // A restricted asset the caller has no grant for stays visible and blocked,
    // never silently absent (ui-pattern.md, "Import Entry Points" 5).
    authorized: row.authorized === true,
  }));
}

/**
 * Whether `userId` holds a live grant for one asset. A `PROJECT` asset is
 * readable by any project member, so only a restricted asset consults grants.
 */
export async function hasGrant(client, projectId, assetId, userId) {
  if (!userId) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM asset_access_grants
      WHERE asset_id = $1 AND project_id = $2 AND grantee_id = $3 AND revoked_at IS NULL
      LIMIT 1`,
    [assetId, projectId, userId],
  );
  return rows.length > 0;
}

export async function insertGrant(client, { grantId, projectId, assetId, granteeId, grantedBy }) {
  const { rows } = await client.query(
    `INSERT INTO asset_access_grants (grant_id, project_id, asset_id, grantee_id, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (asset_id, grantee_id, project_id)
     DO UPDATE SET granted_by = EXCLUDED.granted_by,
                   granted_at = now(),
                   revoked_at = NULL,
                   revoked_by = NULL
     RETURNING grant_id, project_id, asset_id, grantee_id, granted_by, granted_at, revoked_at, revoked_by`,
    [grantId, projectId, assetId, granteeId, grantedBy],
  );
  return mapGrant(rows[0]);
}

export async function revokeGrant(client, { projectId, assetId, granteeId, actorId }) {
  const { rows } = await client.query(
    `UPDATE asset_access_grants
        SET revoked_at = now(), revoked_by = $4
      WHERE asset_id = $1 AND project_id = $2 AND grantee_id = $3 AND revoked_at IS NULL
      RETURNING grant_id, project_id, asset_id, grantee_id, granted_by, granted_at, revoked_at, revoked_by`,
    [assetId, projectId, granteeId, actorId],
  );
  return rows[0] ? mapGrant(rows[0]) : null;
}

export async function listGrants(client, projectId, assetId) {
  const { rows } = await client.query(
    `SELECT grant_id, project_id, asset_id, grantee_id, granted_by, granted_at, revoked_at, revoked_by
       FROM asset_access_grants
      WHERE asset_id = $1 AND project_id = $2 AND revoked_at IS NULL
      ORDER BY granted_at`,
    [assetId, projectId],
  );
  return rows.map(mapGrant);
}

export async function getVersion(client, projectId, assetVersionId) {
  const { rows } = await client.query(
    `SELECT ${VERSION_COLUMNS} FROM asset_versions
      WHERE asset_version_id = $1 AND project_id = $2`,
    [assetVersionId, projectId],
  );
  return rows[0] ? mapVersion(rows[0]) : null;
}

export async function listVersions(client, projectId, assetId) {
  const { rows } = await client.query(
    `SELECT ${VERSION_COLUMNS} FROM asset_versions
      WHERE asset_id = $1 AND project_id = $2
      ORDER BY version_number DESC`,
    [assetId, projectId],
  );
  return rows.map(mapVersion);
}

export async function findCompletedVersionByChecksum(client, projectId, checksum, { excludeVersionId = null } = {}) {
  const { rows } = await client.query(
    `SELECT ${VERSION_COLUMNS} FROM asset_versions
      WHERE project_id = $1 AND content_checksum = $2 AND intake_state = 'COMPLETE'
        AND ($3::uuid IS NULL OR asset_version_id <> $3)
      ORDER BY created_at
      LIMIT 1`,
    [projectId, checksum, excludeVersionId],
  );
  return rows[0] ? mapVersion(rows[0]) : null;
}

export async function completeVersion(client, {
  projectId,
  assetVersionId,
  checksum,
  sizeBytes,
  storageKey,
  actorId,
}) {
  const { rows } = await client.query(
    `UPDATE asset_versions
        SET intake_state = 'COMPLETE',
            content_checksum = $3,
            size_bytes = $4,
            storage_key = $5,
            uploaded_at = now(),
            uploaded_by = $6,
            updated_at = now(),
            updated_by = $6
      WHERE asset_version_id = $1 AND project_id = $2 AND intake_state = 'PENDING'
      RETURNING ${VERSION_COLUMNS}`,
    [assetVersionId, projectId, checksum, sizeBytes, storageKey, actorId],
  );
  return rows[0] ? mapVersion(rows[0]) : null;
}

/** A completed version reuses an already-stored object rather than a new one. */
export async function adoptStorageKey(client, { projectId, assetVersionId, storageKey, actorId }) {
  const { rows } = await client.query(
    `UPDATE asset_versions SET storage_key = $3, updated_at = now(), updated_by = $4
      WHERE asset_version_id = $1 AND project_id = $2
      RETURNING ${VERSION_COLUMNS}`,
    [assetVersionId, projectId, storageKey, actorId],
  );
  return rows[0] ? mapVersion(rows[0]) : null;
}

export async function supersedeOtherVersions(client, { projectId, assetId, keepAssetVersionId }) {
  await client.query(
    `UPDATE asset_versions SET status = 'SUPERSEDED', updated_at = now()
      WHERE asset_id = $1 AND project_id = $2 AND status = 'CURRENT'
        AND asset_version_id <> $3`,
    [assetId, projectId, keepAssetVersionId],
  );
}

export async function refreshAssetCurrentVersion(client, { projectId, assetId, currentVersionId, actorId }) {
  const { rows } = await client.query(
    `UPDATE project_assets a
        SET current_version_id = $3,
            version_count = (SELECT count(*) FROM asset_versions v
                              WHERE v.asset_id = a.asset_id AND v.project_id = a.project_id),
            updated_at = now(),
            updated_by = $4
      WHERE a.asset_id = $1 AND a.project_id = $2
      RETURNING ${ASSET_COLUMNS_A}`,
    [assetId, projectId, currentVersionId, actorId],
  );
  return rows[0] ? mapAsset(rows[0]) : null;
}

export async function deleteVersion(client, projectId, assetVersionId) {
  await client.query(
    'DELETE FROM asset_versions WHERE asset_version_id = $1 AND project_id = $2',
    [assetVersionId, projectId],
  );
}

export async function listRepresentations(client, projectId, assetVersionId) {
  const { rows } = await client.query(
    `SELECT ${REPRESENTATION_COLUMNS} FROM asset_representations
      WHERE asset_version_id = $1 AND project_id = $2
      ORDER BY created_at, kind`,
    [assetVersionId, projectId],
  );
  return rows.map(mapRepresentation);
}

export async function upsertRepresentation(client, {
  representationId,
  projectId,
  assetVersionId,
  kind,
  mediaType,
  checksum,
  storageKey,
  producerId,
  producerVersion,
  status = 'READY',
  actorId,
}) {
  const { rows } = await client.query(
    `INSERT INTO asset_representations
       (representation_id, project_id, asset_version_id, kind, media_type,
        content_checksum, storage_key, producer_id, producer_version, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (asset_version_id, kind, producer_id, producer_version, project_id)
     DO UPDATE SET media_type = EXCLUDED.media_type,
                   content_checksum = EXCLUDED.content_checksum,
                   storage_key = EXCLUDED.storage_key,
                   status = EXCLUDED.status
     RETURNING ${REPRESENTATION_COLUMNS}`,
    [representationId, projectId, assetVersionId, kind, mediaType, checksum, storageKey, producerId, producerVersion, status, actorId],
  );
  return mapRepresentation(rows[0]);
}

export async function markRepresentationsStale(client, { projectId, assetVersionId, producerId }) {
  await client.query(
    `UPDATE asset_representations SET status = 'STALE'
      WHERE asset_version_id = $1 AND project_id = $2 AND producer_id = $3 AND status = 'READY'`,
    [assetVersionId, projectId, producerId],
  );
}

export async function insertJob(client, {
  jobId,
  projectId,
  assetVersionId,
  jobType,
  payload = {},
  actorId,
}) {
  const { rows } = await client.query(
    `INSERT INTO asset_jobs (job_id, project_id, asset_version_id, job_type, payload, requested_by, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING job_id, project_id, asset_version_id, job_type, state, progress_pct,
               payload, result, error_message, started_at, completed_at, created_at`,
    [jobId, projectId, assetVersionId, jobType, payload, actorId],
  );
  return mapJob(rows[0]);
}

export async function getJob(client, projectId, jobId) {
  const { rows } = await client.query(
    `SELECT job_id, project_id, asset_version_id, job_type, state, progress_pct,
            payload, result, error_message, started_at, completed_at, created_at
       FROM asset_jobs WHERE job_id = $1 AND project_id = $2`,
    [jobId, projectId],
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function insertOutboxEvent(client, {
  projectId,
  eventId,
  eventType,
  aggregateType,
  aggregateId,
  payload,
  correlationId,
  actorId,
}) {
  await client.query(
    `INSERT INTO outbox_events
       (event_id, project_id, scenario_id, event_type, aggregate_type, aggregate_id, payload, correlation_id, created_by)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8)`,
    [eventId, projectId, eventType, aggregateType, aggregateId, payload, correlationId, actorId],
  );
}

export async function updateAsset(client, {
  projectId,
  assetId,
  name = null,
  tags = null,
  accessClassification = null,
  retentionClass = null,
  actorId,
}) {
  const { rows } = await client.query(
    `UPDATE project_assets
        SET name = COALESCE($3, name),
            tags = COALESCE($4, tags),
            access_classification = COALESCE($5, access_classification),
            retention_class = COALESCE($6, retention_class),
            updated_at = now(),
            updated_by = $7
      WHERE asset_id = $1 AND project_id = $2
      RETURNING ${ASSET_COLUMNS}`,
    [assetId, projectId, name, tags, accessClassification, retentionClass, actorId],
  );
  return rows[0] ? mapAsset(rows[0]) : null;
}

export async function setAssetStatus(client, { projectId, assetId, status, actorId }) {
  const { rows } = await client.query(
    `UPDATE project_assets
        SET status = $3, updated_at = now(), updated_by = $4
      WHERE asset_id = $1 AND project_id = $2
      RETURNING ${ASSET_COLUMNS}`,
    [assetId, projectId, status, actorId],
  );
  return rows[0] ? mapAsset(rows[0]) : null;
}

/**
 * The deletion guard. A version is referenced by a tool binding, is the current
 * version of its asset, is shared as an object with another version, or is
 * covered by an active hold. Any of these blocks deletion, and the caller is
 * told which.
 */
export async function assetReferences(client, projectId, assetId) {
  const bindings = await client.query(
    `SELECT count(*)::int AS count
       FROM asset_bindings b
      WHERE b.project_id = $1
        AND b.asset_version_id IN (
          SELECT av.asset_version_id FROM asset_versions av
           WHERE av.asset_id = $2 AND av.project_id = $1)`,
    [projectId, assetId],
  );

  const shared = await client.query(
    `SELECT count(*)::int AS count
       FROM asset_versions other
      WHERE other.project_id = $1
        AND other.asset_id <> $2
        AND other.storage_key IN (
          SELECT av.storage_key FROM asset_versions av
           WHERE av.asset_id = $2 AND av.project_id = $1 AND av.storage_key IS NOT NULL)`,
    [projectId, assetId],
  );

  const holds = await client.query(
    `SELECT hold_id, asset_id, asset_version_id, reason, authority
       FROM asset_holds
      WHERE project_id = $1 AND released_at IS NULL
        AND (asset_id = $2 OR asset_version_id IN (
          SELECT av.asset_version_id FROM asset_versions av
           WHERE av.asset_id = $2 AND av.project_id = $1))`,
    [projectId, assetId],
  );

  return {
    bindingCount: bindings.rows[0].count,
    sharedObjectCount: shared.rows[0].count,
    holds: holds.rows.map((row) => ({
      holdId: row.hold_id,
      assetId: row.asset_id,
      assetVersionId: row.asset_version_id,
      reason: row.reason,
      authority: row.authority,
    })),
  };
}

export async function markAssetDeleted(client, { projectId, assetId, actorId }) {
  await client.query(
    `UPDATE project_assets SET status = 'DELETED', updated_at = now(), updated_by = $3
      WHERE asset_id = $1 AND project_id = $2`,
    [assetId, projectId, actorId],
  );
  await client.query(
    'DELETE FROM asset_versions WHERE asset_id = $1 AND project_id = $2',
    [assetId, projectId],
  );
  await client.query(
    'DELETE FROM project_assets WHERE asset_id = $1 AND project_id = $2',
    [assetId, projectId],
  );
}

export async function insertHold(client, {
  holdId,
  projectId,
  assetId = null,
  assetVersionId = null,
  reason,
  authority,
  actorId,
}) {
  const { rows } = await client.query(
    `INSERT INTO asset_holds (hold_id, project_id, asset_id, asset_version_id, reason, authority, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING hold_id, project_id, asset_id, asset_version_id, reason, authority, created_at, released_at`,
    [holdId, projectId, assetId, assetVersionId, reason, authority, actorId],
  );
  return mapHold(rows[0]);
}

export async function releaseHold(client, { projectId, holdId, reason, actorId }) {
  const { rows } = await client.query(
    `UPDATE asset_holds
        SET released_at = now(), released_by = $3, released_reason = $4
      WHERE hold_id = $1 AND project_id = $2 AND released_at IS NULL
      RETURNING hold_id, project_id, asset_id, asset_version_id, reason, authority, created_at, released_at`,
    [holdId, projectId, actorId, reason],
  );
  return rows[0] ? mapHold(rows[0]) : null;
}

export async function setVersionScanState(client, { projectId, assetVersionId, scanState, versionStatus = null, actorId = null }) {
  const { rows } = await client.query(
    `UPDATE asset_versions
        SET malware_scan_state = $3,
            status = COALESCE($4::asset_version_status, status),
            updated_at = now(),
            updated_by = $5
      WHERE asset_version_id = $1 AND project_id = $2
      RETURNING ${VERSION_COLUMNS}`,
    [assetVersionId, projectId, scanState, versionStatus, actorId],
  );
  return rows[0] ? mapVersion(rows[0]) : null;
}

export async function completeJob(client, { projectId, jobId, state, result = null, errorMessage = null }) {
  const { rows } = await client.query(
    `UPDATE asset_jobs
        SET state = $3::job_state,
            progress_pct = CASE WHEN $3::text IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN 100 ELSE progress_pct END,
            result = $4,
            error_message = $5,
            started_at = COALESCE(started_at, now()),
            completed_at = CASE WHEN $3::text IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE job_id = $1 AND project_id = $2
      RETURNING job_id, project_id, asset_version_id, job_type, state, progress_pct,
                payload, result, error_message, started_at, completed_at, created_at`,
    [jobId, projectId, state, result, errorMessage],
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export function mapAsset(row) {
  return {
    assetId: row.asset_id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    mediaType: row.media_type,
    status: row.status,
    accessClassification: row.access_classification,
    currentVersionId: row.current_version_id,
    versionCount: row.version_count,
    tags: row.tags ?? [],
    retentionClass: row.retention_class,
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    quarantined: row.status === 'QUARANTINED',
    archived: row.status === 'ARCHIVED',
  };
}

export function mapVersion(row) {
  return {
    assetVersionId: row.asset_version_id,
    projectId: row.project_id,
    assetId: row.asset_id,
    versionNumber: row.version_number,
    intakeState: row.intake_state,
    contentChecksum: row.content_checksum,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    storageKey: row.storage_key,
    filename: row.filename,
    mediaType: row.media_type,
    malwareScanState: row.malware_scan_state,
    status: row.status,
    supersedesAssetVersionId: row.supersedes_asset_version_id,
    sourceRef: row.source_ref,
    provenance: row.provenance,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  };
}

export function mapRepresentation(row) {
  return {
    representationId: row.representation_id,
    projectId: row.project_id,
    assetVersionId: row.asset_version_id,
    kind: row.kind,
    mediaType: row.media_type,
    contentChecksum: row.content_checksum,
    storageKey: row.storage_key,
    producerId: row.producer_id,
    producerVersion: row.producer_version,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function mapJob(row) {
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    assetVersionId: row.asset_version_id,
    jobType: row.job_type,
    state: row.state,
    progressPct: row.progress_pct,
    payload: row.payload,
    result: row.result,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

export function mapHold(row) {
  return {
    holdId: row.hold_id,
    projectId: row.project_id,
    assetId: row.asset_id,
    assetVersionId: row.asset_version_id,
    reason: row.reason,
    authority: row.authority,
    createdAt: row.created_at,
    releasedAt: row.released_at,
  };
}

export function mapGrant(row) {
  return {
    grantId: row.grant_id,
    projectId: row.project_id,
    assetId: row.asset_id,
    granteeId: row.grantee_id,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}
