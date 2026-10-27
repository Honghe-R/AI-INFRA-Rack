import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '@ai-infra/core';
import { advanceEtag, readEtag, requireBaseRevision, requireDraft } from './etags.js';
import { RUN_REASON, executeRun } from './engine.js';
import { defaultPolicyRegistry } from './policies.js';
import { issueImpactNotice } from './publication.js';
import { readEnvelope } from './stores.js';
import {
  CHANGE_KINDS,
  ChangeConflict,
  ChangeRejected,
  KIND_RANK,
  catalogKeysFor,
  permissionsForChanges,
} from './change-kinds.js';

/**
 * The change-set commit.
 *
 * One typed set, one transaction, one ETag advance. The specification's whole
 * authoring contract reduces to this function: apply in dependency order, refuse the
 * set whole if any change is invalid, never let a diagnostic be suppressed by an
 * edit, and advance the draft token so a concurrent editor cannot lose an update.
 *
 * The pipeline is deliberately ignorant of change kinds. It orders them, applies
 * each inside a savepoint so one failure does not abort the sweep before the other
 * changes have been checked, collects the refusals, and only then decides whether the
 * set is refused. A savepoint per change is what makes "422 with per-change
 * diagnostics" a real answer rather than "the first thing that went wrong".
 *
 * Everything here runs on a caller-supplied client inside one transaction, so a
 * throw anywhere — including the diagnostics sweep — rolls back the graph, the token
 * and the outbox event together. That atomicity is the reason the token cannot be
 * advanced by a caller after the fact.
 */

/** A change set is bounded like any other array argument. */
export const MAX_CHANGES = 200;

/** The idempotency scope; one key namespace per command. */
export const IDEMPOTENCY_SCOPE = 'facility.change_set';

/**
 * Applies one change set and returns what changed plus what it broke.
 *
 * `previewDiagnostics` runs an affected-subgraph validation inside the same
 * transaction and returns its findings, which is what turns an edit into a
 * consequence. It is on by default and can be turned off for bulk paths where the
 * caller will validate once at the end.
 */
export async function applyChangeSet({
  client,
  projectId,
  revisionId,
  scenarioId = null,
  actorId = null,
  baseRevisionId = null,
  etag = null,
  changes = [],
  previewDiagnostics = true,
  idempotencyKey = null,
  correlationId = null,
  policies = defaultPolicyRegistry,
  maxDiagnostics = 100_000,
  logger = null,
}) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new ApiError('CHANGE_SET_EMPTY', 'A change set requires at least one change.', {
      status: 422,
      details: [{ field: 'changes', reason: 'required' }],
    });
  }
  if (changes.length > MAX_CHANGES) {
    throw new ApiError('CHANGE_SET_TOO_LARGE', 'The change set exceeds the documented cap.', {
      status: 422,
      details: [{ field: 'changes', reason: 'too_many_items', max_items: MAX_CHANGES }],
    });
  }

  // Idempotency is answered *before* the concurrency preconditions, and that order is
  // load-bearing: a retry of a commit that already succeeded necessarily presents a
  // stale ETag, so checking the token first would refuse the replay of a successful
  // write instead of returning its recorded result.
  const requestHash = hashRequest({ baseRevisionId, changes });
  if (idempotencyKey) {
    const replay = await findIdempotentResult({ client, projectId, idempotencyKey, requestHash });
    if (replay) return replay;
  }

  const revision = await requireDraft({ client, projectId, revisionId });
  requireBaseRevision({ revision, baseRevisionId });
  const resolvedScenarioId = revision.scenario_id ?? scenarioId;

  const envelope = await readEnvelope({ client, projectId, revisionId });
  if (!envelope) {
    throw new ApiError('FACILITY_ENVELOPE_NOT_FOUND', 'The revision has no facility envelope to edit.', { status: 409 });
  }

  const ordered = orderChanges(changes);

  // The set's own savepoint, wrapping every write this command makes — the applied
  // changes, the token advance, the outbox event, the previewed run and the
  // idempotency record — so that a refused set leaves nothing behind *inside the
  // caller's transaction*.
  //
  // Relying on the caller to roll back on the throw would be enough for the HTTP
  // route and wrong for any other caller: a caller that caught the error and
  // continued would commit a partially applied set, and the contract says the set
  // commits or fails as one. The rollback is therefore the command's own.
  await client.query('SAVEPOINT change_set_body');
  try {
    return await applyWithinSavepoint();
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT change_set_body');
    await client.query('RELEASE SAVEPOINT change_set_body');
    throw error;
  }

  async function applyWithinSavepoint() {
  const applied = [];
  const rejections = [];
  const conflicts = [];
  let sequence = 0;

  for (const { change, index } of ordered) {
    const definition = CHANGE_KINDS[change?.kind];
    if (!definition) {
      rejections.push({
        index,
        kind: change?.kind ?? null,
        reason: 'unknown_change_kind',
        message: 'The change kind is not registered.',
        known: Object.keys(CHANGE_KINDS),
      });
      continue;
    }

    sequence += 1;
    const savepoint = `change_${sequence}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await definition.apply({
        client,
        projectId,
        scenarioId: resolvedScenarioId,
        revisionId,
        envelopeId: envelope.envelope_id,
        actorId,
        change,
      });
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      applied.push({ index, kind: change.kind, ...result });
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      const entry = { index, kind: change.kind, reason: error.name, message: error.message, ...error.details };
      if (error instanceof ChangeConflict) conflicts.push(entry);
      else if (error instanceof ChangeRejected) rejections.push(entry);
      // A database refusal — unparseable GeoJSON, a value the column cannot hold — is
      // a rejected change rather than a server fault: the caller sent something the
      // store will not accept, and the set is refused whole either way.
      else rejections.push({ ...entry, reason: 'store_refused' });
    }
  }

  // Conflicts are reported ahead of rejections: a reference problem is something the
  // caller can resolve by changing the set's shape, while an invalid change has to be
  // corrected outright.
  if (conflicts.length > 0) {
    throw new ApiError('CHANGE_SET_CONFLICT', 'The change set conflicts with existing records.', {
      status: 409,
      details: conflicts,
    });
  }
  if (rejections.length > 0) {
    throw new ApiError('CHANGE_SET_REJECTED', 'One or more changes are not valid.', {
      status: 422,
      details: rejections,
    });
  }

  // The token advances only once every change has applied, and it is the conditional
  // update that makes the advance the commit point: a concurrent editor who committed
  // first has already moved it, and this throws instead of overwriting them.
  const token = await advanceEtag({ client, projectId, revisionId, expectedEtag: etag, actorId });

  await client.query(
    `INSERT INTO outbox_events
       (event_id, project_id, scenario_id, revision_id, event_type, aggregate_type, aggregate_id, payload,
        correlation_id, created_by)
     VALUES ($1, $2, $3, $4, 'facility.revision.changed.v1', 'revision', $4, $5::jsonb, $6, $7)`,
    [
      randomUUID(),
      projectId,
      resolvedScenarioId,
      revisionId,
      JSON.stringify({
        previous_etag: etag,
        new_etag: token.etag,
        etag_version: token.etagVersion,
        changed_entity_refs: applied.map((entry) => entry.entityRef).filter(Boolean),
        change_kinds: applied.map((entry) => entry.kind),
      }),
      correlationId,
      actorId,
    ],
  );

  // A commit invalidates what downstream consumers derived from the previous draft
  // state, and the notice is the record of that. It is scoped to the base revision the
  // branch was taken from: a root draft has no predecessor row to name, so a root
  // commit emits the changed event without a notice rather than pointing at nothing.
  const changedEntityRefs = applied.map((entry) => entry.entityRef).filter(Boolean);
  if (revision.base_revision_id) {
    await issueImpactNotice({
      client,
      projectId,
      scenarioId: resolvedScenarioId,
      previousRevisionId: revision.base_revision_id,
      revisionId,
      changedEntityRefs,
      actorId,
    });
  }

  const result = {
    revisionId,
    etag: token.etag,
    etagVersion: token.etagVersion,
    applied,
    diagnostics: null,
    coverage: null,
    incomplete: false,
    lifecycleState: revision.lifecycle_state,
  };

  if (previewDiagnostics) {
    // The same engine the explicit run uses, in this transaction, so the findings
    // describe the graph the change set just produced rather than a stale read.
    //
    // Note what "affected subgraph" currently means: the `BOTH`-scope subset of the
    // catalog over the whole revision, not a walk of the entities this change touched
    // (`constraintsForScope`). It is correct and it is bounded, but it is not yet the
    // cheap targeted sweep the specification describes, so a bulk caller should pass
    // `preview_diagnostics: false` and validate once at the end.
    const run = await executeRun({
      client,
      projectId,
      scenarioId: resolvedScenarioId,
      revisionId,
      scope: 'AFFECTED_SUBGRAPH',
      reason: RUN_REASON.VALIDATION,
      actorId,
      policies,
      maxDiagnostics,
    });
    result.diagnostics = run.diagnostics.map(toDiagnostic);
    result.coverage = run.coverage;
    result.incomplete = run.incomplete;
    result.lifecycleState = run.lifecycleState;
    // What the edit *cleared* is part of its answer, not a detail: a user who fixed a
    // problem needs to see that the finding is gone, and until a run closes it the old
    // row keeps gating coverage.
    result.resolvedDiagnosticIds = run.resolvedDiagnostics ?? [];
  }

  // The consequence is stated rather than left for the caller to infer from a count,
  // because it is the whole reason the preview runs. It is computed here rather than
  // in the tool so a direct caller of the command gets the same answer.
  const errors = result.diagnostics?.filter((entry) => entry.severity === 'ERROR' && entry.status !== 'WAIVED') ?? [];
  const cleared = result.resolvedDiagnosticIds?.length ?? 0;
  const clearedClause = cleared > 0 ? ` It resolved ${cleared} finding(s) that no longer hold.` : '';
  result.effect =
    result.diagnostics === null
      ? 'The change set was applied. No diagnostics were previewed; run validation to see the consequences.'
      : errors.length > 0
        ? `The change set was applied and produced ${errors.length} ERROR diagnostic(s), which now block VALIDATED coverage.${clearedClause}`
        : `The change set was applied with no new ERROR diagnostics.${clearedClause}`;

  if (idempotencyKey) {
    await recordIdempotentResult({ client, projectId, scenarioId: resolvedScenarioId, idempotencyKey, requestHash, result, actorId });
  }

  logger?.info?.('change_set.applied', {
    projectId,
    revisionId,
    etagVersion: token.etagVersion,
    changes: applied.length,
    errorCount: result.diagnostics?.filter((entry) => entry.severity === 'ERROR').length ?? null,
  });

  await client.query('RELEASE SAVEPOINT change_set_body');
  return result;
  }
}

/**
 * The dependency order the contract names: entities, then geometry, then constraints,
 * phases, utilities, resilience, capacity and environment.
 *
 * Submission order is preserved within a rank, so a set that creates a parent and its
 * child in that order keeps that order, and a caller is never surprised by an
 * unrelated reordering.
 */
export function orderChanges(changes) {
  return changes
    .map((change, index) => ({ change, index, rank: KIND_RANK[change?.kind] ?? 999 }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank));
}

/** The permission keys this set will require, so a caller can be refused early. */
export function requiredPermissionsFor(changes) {
  return permissionsForChanges(changes);
}

function hashRequest({ baseRevisionId, changes }) {
  return createHash('sha256')
    .update(JSON.stringify({ base_revision_id: baseRevisionId ?? null, changes }))
    .digest('hex');
}

async function findIdempotentResult({ client, projectId, idempotencyKey, requestHash }) {
  const { rows } = await client.query(
    `SELECT request_hash, response_status, result
       FROM idempotency_records
      WHERE project_id = $1 AND scope = $2 AND idempotency_key = $3`,
    [projectId, IDEMPOTENCY_SCOPE, idempotencyKey],
  );
  const record = rows[0];
  if (!record) return null;
  if (record.request_hash !== requestHash) {
    // The same key for a different body is a client bug, and answering it with the
    // first result would silently discard the second request.
    throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different change set.', {
      status: 409,
      details: [{ field: 'idempotency_key', reason: 'request_hash_mismatch' }],
    });
  }
  return { ...record.result, replayed: true, responseStatus: record.response_status };
}

async function recordIdempotentResult({ client, projectId, scenarioId, idempotencyKey, requestHash, result, actorId }) {
  await client.query(
    `INSERT INTO idempotency_records
       (project_id, scenario_id, scope, idempotency_key, request_hash, response_status, result, created_by)
     VALUES ($1, $2, $3, $4, $5, 200, $6::jsonb, $7)
     ON CONFLICT (scope, idempotency_key, project_id) DO NOTHING`,
    [projectId, scenarioId, IDEMPOTENCY_SCOPE, idempotencyKey, requestHash, JSON.stringify(result), actorId],
  );
}

/**
 * The engine's in-memory finding, shaped like a persisted diagnostic.
 *
 * A finding is richer than a stored row — it still carries the resource kind the check
 * knew — so it is enriched with the catalog keys here and returned in the same shape
 * `list_diagnostics` uses. A caller must not be able to tell a previewed finding from
 * a re-read one.
 */
export function toDiagnostic(finding) {
  return {
    constraintId: finding.constraintId,
    severity: finding.severity,
    status: finding.status ?? 'OPEN',
    entityRefs: finding.entityRefs ?? [],
    geometryRefs: finding.geometryRefs ?? [],
    sourceValues: finding.sourceValues ?? [],
    computed: finding.computed ?? {},
    remediationCategory: finding.remediationCategory ?? null,
    remediationHint: finding.remediationHint ?? null,
    policyRef: finding.policyRef ?? null,
    resourceKind: finding.resourceKind ?? null,
    ...catalogKeysFor(finding.constraintId, finding.resourceKind ?? null),
  };
}

export { ChangeConflict, ChangeRejected, CHANGE_KINDS, readEtag };
