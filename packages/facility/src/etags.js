import { ApiError, errors } from '@ai-infra/core';

/**
 * The draft concurrency token.
 *
 * `revision_etags` exists in the schema and was written by no code, so every
 * draft-mutating precondition in the specification ("a mutating request must match
 * the current ETag, and the write advances it", [D2]) was unimplementable. This
 * module is that missing half: one opaque token per revision, advanced by a
 * conditional update in the same transaction as the change it guards.
 *
 * The token is deliberately not the content checksum. A checksum exists only once
 * a revision is `VALIDATED` — a draft has no immutable content to hash — so using
 * it as the concurrency token would leave every draft unpinnable, which is exactly
 * the state this replaces. The two answer different questions:
 *
 *   * `etag`          — "is this the draft state I read?"  Changes on every commit.
 *   * `content_checksum` — "is this the frozen revision I validated?"  Exists only
 *                      once the revision is no longer a draft.
 *
 * [D1](../../doc/tools/site-and-facility/decisions.md) makes the draft mutable in
 * place, so the token is the only thing standing between two editors and a lost
 * update. It is opaque, revision-bound, and advances on every commit.
 */

export const READ_ETAG_SQL = `
  SELECT etag, etag_version, updated_at
    FROM revision_etags
   WHERE project_id = $1 AND revision_id = $2`;

/**
 * Creates the token row if it is missing.
 *
 * Idempotent, so a backfill and a first commit can both call it. The `etag` column
 * defaults to `gen_random_uuid()`, which is what makes the token unguessable
 * without a sequence that would leak how many times a revision has been edited.
 */
export const ENSURE_ETAG_SQL = `
  INSERT INTO revision_etags (revision_id, project_id, scenario_id, created_by)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (revision_id, project_id) DO NOTHING`;

/**
 * Advances the token, but only from the value the caller last read.
 *
 * The conditional update *is* the concurrency control: two commits presenting the
 * same token cannot both match, and the loser learns the current value rather than
 * silently overwriting the winner. Doing this in the commit's transaction is what
 * makes "the change and the token advance together" true rather than aspirational.
 */
export const ADVANCE_ETAG_SQL = `
  UPDATE revision_etags
     SET etag = gen_random_uuid(),
         etag_version = etag_version + 1,
         updated_at = now(),
         updated_by = $4
   WHERE project_id = $1 AND revision_id = $2 AND etag = $3
  RETURNING etag, etag_version, updated_at`;

/** Reads the current token, or null when the revision has none. */
export async function readEtag({ client, projectId, revisionId }) {
  const { rows } = await client.query(READ_ETAG_SQL, [projectId, revisionId]);
  const row = rows[0];
  if (!row) return null;
  return { etag: row.etag, etagVersion: Number(row.etag_version), updatedAt: row.updated_at };
}

/**
 * Returns the revision's token, creating it if the revision predates this module.
 *
 * A revision created before the token existed has no row, and a read must not
 * invent one: reads run in read-only transactions, and a write there would be
 * both a lie about the read and a surprise under row-level security. So creation
 * is explicit here and called by the writers and the seeds.
 */
export async function ensureEtag({ client, projectId, revisionId, scenarioId, actorId = null }) {
  await client.query(ENSURE_ETAG_SQL, [revisionId, projectId, scenarioId, actorId]);
  return readEtag({ client, projectId, revisionId });
}

/**
 * Advances the token or refuses the write.
 *
 * A stale token is a `409` carrying `facility.revision.current`, the catalog
 * identifier the specification names for this condition, so a client can branch on
 * a machine code instead of a sentence. The current value travels with the error,
 * because a client that must re-read to retry has been told half of what it needs.
 */
export async function advanceEtag({ client, projectId, revisionId, expectedEtag, actorId = null }) {
  if (!expectedEtag) {
    throw new ApiError('REVISION_ETAG_REQUIRED', 'A draft write requires the revision ETag it was prepared against.', {
      status: 428,
      details: [{ field: 'etag', reason: 'required', constraint_id: 'facility.revision.current' }],
    });
  }

  const { rows } = await client.query(ADVANCE_ETAG_SQL, [projectId, revisionId, expectedEtag, actorId]);
  if (rows[0]) {
    return { etag: rows[0].etag, etagVersion: Number(rows[0].etag_version), updatedAt: rows[0].updated_at };
  }

  const current = await readEtag({ client, projectId, revisionId });
  if (!current) {
    throw new ApiError('REVISION_ETAG_MISSING', 'The revision has no draft ETag, so no write can be conditioned on it.', {
      status: 409,
      details: [{ constraint_id: 'facility.revision.current', reason: 'no_etag_row', expected_etag: expectedEtag }],
    });
  }
  throw new ApiError('REVISION_ETAG_STALE', 'The draft has changed since this write was prepared.', {
    status: 409,
    details: [
      {
        constraint_id: 'facility.revision.current',
        reason: 'etag_mismatch',
        expected_etag: expectedEtag,
        current_etag: current.etag,
        current_etag_version: current.etagVersion,
      },
    ],
  });
}

/**
 * The lifecycle guard every draft write needs.
 *
 * Only the validation service checks this today, and it does so on its own path.
 * A write that skipped the check would mutate a revision the specification freezes,
 * so the guard lives with the concurrency token rather than being repeated by each
 * command.
 */
export async function requireDraft({ client, projectId, revisionId }) {
  const { rows } = await client.query(
    `SELECT revision_id, scenario_id, lifecycle_state, name, base_revision_id
       FROM revisions WHERE project_id = $1 AND revision_id = $2`,
    [projectId, revisionId],
  );
  const revision = rows[0];
  if (!revision) throw errors.notFound('The requested resource was not found.');
  if (revision.lifecycle_state !== 'DRAFT') {
    throw new ApiError('REVISION_IMMUTABLE', 'A validated or published revision cannot be edited; branch a draft.', {
      status: 409,
      details: [
        {
          constraint_id: 'facility.revision.writes_immutable',
          lifecycle_state: revision.lifecycle_state,
          revision_id: revisionId,
        },
      ],
    });
  }
  return revision;
}

/**
 * Validates the branch the draft was prepared against.
 *
 * [D2]: a matching ETag never excuses a stale or unrelated base revision. They are
 * independent preconditions, and a caller that has the token but the wrong base is
 * editing a draft it never read.
 */
export function requireBaseRevision({ revision, baseRevisionId }) {
  if (!baseRevisionId) {
    throw new ApiError('REVISION_BASE_REQUIRED', 'A draft write requires the base revision it was prepared against.', {
      status: 428,
      details: [{ field: 'base_revision_id', reason: 'required', constraint_id: 'facility.revision.current' }],
    });
  }
  if (revision.base_revision_id && revision.base_revision_id !== baseRevisionId) {
    throw new ApiError('REVISION_BASE_MISMATCH', 'The write names a different base revision than the draft records.', {
      status: 409,
      details: [
        {
          constraint_id: 'facility.revision.current',
          reason: 'base_revision_mismatch',
          expected_base_revision_id: revision.base_revision_id,
          supplied_base_revision_id: baseRevisionId,
        },
      ],
    });
  }
  return true;
}
