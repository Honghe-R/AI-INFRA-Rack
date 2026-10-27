import { randomUUID } from 'node:crypto';
import { ApiError, errors } from '@ai-infra/core';
import { requireDraft } from './etags.js';
import { projectStore } from './tools/mappers.js';

/**
 * Asset bindings: this tool's consumption of one exact project asset version.
 *
 * The asset, its versions, and its representations live in the project asset
 * layer and are shared by every tool (project-assets.md). A binding pins one
 * version, optionally one representation, and a role, and it is the only thing
 * the facility tool owns about an import — it never stores bytes, never
 * re-uploads, and never copies a representation.
 *
 * What a binding deliberately does *not* do is advance the draft ETag. Applying an
 * import is one typed change set and that is what advances the token and emits
 * `facility.revision.changed.v1` (import-adapters.md, "Facility Mapping Rules");
 * pinning a source is provenance, not a change to the design graph. The binding
 * does have to be created in a draft, because it is part of the revision and a
 * frozen revision's contents cannot grow.
 */

/** `AssetBinding.role` (project-assets.md). The column is text, so this is the only enum. */
export const BINDING_ROLES = Object.freeze(['SOURCE', 'EVIDENCE', 'REFERENCE', 'ATTACHMENT']);

/** The `review_state` enum every binding and mapping review moves through. */
export const REVIEW_STATES = Object.freeze(['UNREVIEWED', 'IN_REVIEW', 'REVIEWED', 'REJECTED']);

/** One revision cannot be a dumping ground for every asset in the project. */
export const MAX_BINDINGS_PER_REVISION = 200;

const BINDING_COLUMNS = `binding_id, asset_version_id, representation_id, transform_id, role, status, mapping_ids`;

function refused(message, details) {
  return new ApiError('VALIDATION_FAILED', message, { status: 422, details });
}

/**
 * Loads the version, its owning asset, and the facts that decide bindability.
 *
 * `asset_version_id` is deliberately not a foreign key in this tool's schema —
 * the project asset layer is a different bounded context — so the reference is
 * validated here, inside the writing transaction, which is what the schema
 * comment requires.
 */
async function loadBindableVersion(client, projectId, assetVersionId) {
  const identity = (await resolveAssetIdentities(client, projectId, [assetVersionId])).get(assetVersionId);
  if (!identity) return null;
  const { rows } = await client.query(
    `SELECT intake_state AS "intakeState", malware_scan_state AS "malwareScanState"
       FROM asset_versions
      WHERE project_id = $1 AND asset_version_id = $2`,
    [projectId, assetVersionId],
  );
  return { ...identity, ...rows[0] };
}

/**
 * Whether a version may be bound, as a verdict rather than a boolean.
 *
 * A blocked version is refused with a reason a client can render, and the
 * reasons mirror the client's own `selectability()` rule so the picker and the
 * server cannot disagree about what is bindable:
 *
 *  * quarantine blocks processing, previewing, **and binding** (project-assets.md);
 *  * `ARCHIVED` is "not offered for new bindings" — restoring it is the way back,
 *    which is what the picker already tells the user;
 *  * a deleted asset has no bytes left to reproduce the revision from;
 *  * a version still being uploaded has no content to pin;
 *  * an infected or unverifiable version is exactly what quarantine is for.
 */
export function bindability(version) {
  if (!version) return { bindable: false, reason: 'no_such_version' };
  if (version.assetStatus === 'DELETED') return { bindable: false, reason: 'asset_deleted' };
  if (version.assetStatus === 'QUARANTINED' || version.versionStatus === 'QUARANTINED') {
    return { bindable: false, reason: 'quarantined' };
  }
  if (version.assetStatus === 'ARCHIVED') return { bindable: false, reason: 'archived' };
  if (version.intakeState !== 'COMPLETE') return { bindable: false, reason: 'intake_incomplete' };
  if (version.malwareScanState === 'INFECTED') return { bindable: false, reason: 'infected' };
  if (version.malwareScanState === 'FAILED') return { bindable: false, reason: 'scan_failed' };
  return { bindable: true, reason: null };
}

const BINDABILITY_MESSAGES = Object.freeze({
  no_such_version: 'That asset version does not exist in this project.',
  asset_deleted: 'The asset has been deleted, so the revision could not be reproduced from it.',
  quarantined: 'A quarantined asset version cannot be bound.',
  archived: 'The asset is archived; restore it before binding.',
  intake_incomplete: 'The asset version has no content yet, so there is nothing to pin.',
  infected: 'The asset version is infected and cannot be bound.',
  scan_failed: 'The malware scan did not complete, so the version cannot be bound.',
});

/**
 * Pins one project asset version to a revision and returns the binding.
 *
 * Runs on the caller's client inside one transaction. The revision row is locked
 * first: the duplicate check is a read followed by an insert, and without the
 * lock two concurrent binds of the same version would both pass the check.
 */
export async function createAssetBinding({
  client,
  projectId,
  revisionId,
  assetVersionId,
  representationId = null,
  role,
  actorId = null,
}) {
  if (!BINDING_ROLES.includes(role)) {
    throw refused('A binding needs a role.', [
      { field: 'role', reason: 'invalid', allowed: [...BINDING_ROLES] },
    ]);
  }

  // The lifecycle guard, and the lock the duplicate check needs. A binding is
  // revision content, so a revision the specification freezes cannot gain one.
  const revision = await requireDraft({ client, projectId, revisionId });
  await client.query(`SELECT 1 FROM revisions WHERE project_id = $1 AND revision_id = $2 FOR UPDATE`, [
    projectId,
    revisionId,
  ]);

  const version = await loadBindableVersion(client, projectId, assetVersionId);
  const verdict = bindability(version);
  if (!verdict.bindable) {
    throw refused(BINDABILITY_MESSAGES[verdict.reason], [
      { field: 'asset_version_id', reason: verdict.reason, value: assetVersionId },
    ]);
  }

  if (representationId) {
    const { rows } = await client.query(
      `SELECT representation_id, kind, status, producer_id
         FROM asset_representations
        WHERE project_id = $1 AND representation_id = $2 AND asset_version_id = $3`,
      [projectId, representationId, assetVersionId],
    );
    const representation = rows[0];
    if (!representation) {
      throw refused('That representation does not belong to the pinned asset version.', [
        { field: 'representation_id', reason: 'not_of_version', value: representationId },
      ]);
    }
    if (representation.status === 'FAILED') {
      throw refused('The representation failed to produce, so it cannot be pinned.', [
        { field: 'representation_id', reason: 'failed', value: representationId },
      ]);
    }
  }

  const { rows: existing } = await client.query(
    `SELECT binding_id FROM asset_bindings
      WHERE project_id = $1 AND revision_id = $2 AND asset_version_id = $3 AND role = $4`,
    [projectId, revisionId, assetVersionId, role],
  );
  if (existing[0]) {
    throw new ApiError('CONFLICT', 'That asset version is already bound to this revision in that role.', {
      status: 409,
      details: [
        {
          field: 'asset_version_id',
          reason: 'already_bound',
          role,
          binding_id: existing[0].binding_id,
        },
      ],
    });
  }

  const { rows: counted } = await client.query(
    `SELECT count(*)::int AS total FROM asset_bindings WHERE project_id = $1 AND revision_id = $2`,
    [projectId, revisionId],
  );
  if (counted[0].total >= MAX_BINDINGS_PER_REVISION) {
    throw new ApiError('CONFLICT', 'This revision has reached its binding limit.', {
      status: 409,
      details: [{ field: 'revision_id', reason: 'too_many_bindings', limit: MAX_BINDINGS_PER_REVISION }],
    });
  }

  const { rows } = await client.query(
    `INSERT INTO asset_bindings
       (binding_id, project_id, scenario_id, revision_id, asset_version_id, representation_id, role, tool_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'site_facility', 'UNREVIEWED')
     RETURNING ${BINDING_COLUMNS}`,
    [randomUUID(), projectId, revision.scenario_id, revisionId, assetVersionId, representationId, role],
  );

  const binding = projectStore('bindings', rows)[0];
  // The pinned version's own facts travel with the binding: the caller has just
  // chosen a file and needs to see which one it actually pinned, not only its id.
  return {
    ...binding,
    assetId: version.assetId,
    assetName: version.assetName,
    assetKind: version.assetKind,
    versionNumber: version.versionNumber,
    filename: version.filename,
    mediaType: version.mediaType,
    isCurrentVersion: version.isCurrentVersion,
    // A binding is authority-bearing only once it has been reviewed; it never is
    // at creation, and saying so here is cheaper than a caller assuming otherwise.
    authoritative: false,
  };
}

/** One binding by id, for the caller that has just created it. */
export async function readAssetBinding({ client, projectId, revisionId, bindingId }) {
  const { rows } = await client.query(
    `SELECT ${BINDING_COLUMNS} FROM asset_bindings
      WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3`,
    [projectId, revisionId, bindingId],
  );
  if (!rows[0]) throw errors.notFound('The requested resource was not found.');
  return projectStore('bindings', rows)[0];
}

/**
 * Resolves pinned asset versions to the asset each one belongs to.
 *
 * A binding stores a version, and nothing in this tool's own tables says which asset
 * that version is a version *of* — that lives in the project asset layer. A
 * provenance read that returned only a version identifier would tell a caller that
 * something was imported without saying what, so the identity is resolved here, in
 * one bounded query over the ids the caller already has.
 *
 * A version that no longer resolves is simply absent from the map rather than an
 * error: the asset tables are a different bounded context, and a read must degrade
 * to "unknown" instead of failing the whole page.
 */
export async function resolveAssetIdentities(client, projectId, assetVersionIds = []) {
  const ids = [...new Set(assetVersionIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const { rows } = await client.query(
    `SELECT v.asset_version_id, v.asset_id, v.version_number, v.filename, v.media_type, v.status,
            a.name AS asset_name, a.kind AS asset_kind, a.status AS asset_status, a.current_version_id
       FROM asset_versions v
       JOIN project_assets a
         ON a.asset_id = v.asset_id AND a.project_id = v.project_id
      WHERE v.project_id = $1 AND v.asset_version_id = ANY($2::uuid[])`,
    [projectId, ids],
  );

  return new Map(
    rows.map((row) => [
      row.asset_version_id,
      {
        assetId: row.asset_id,
        assetName: row.asset_name,
        assetKind: row.asset_kind,
        assetStatus: row.asset_status,
        versionNumber: row.version_number,
        filename: row.filename,
        mediaType: row.media_type,
        versionStatus: row.status,
        isCurrentVersion: row.asset_version_id === row.current_version_id,
      },
    ]),
  );
}

