import { createHash, randomUUID } from 'node:crypto';
import { CATALOG, CAPABILITIES, constraintsForScope } from './catalog.js';
import { CHECKS } from './checks/index.js';
import { loadRevisionContext } from './context.js';
import { deriveCoverage, resourceEvidence, evidenceByCapability, gatedCapabilities } from './coverage.js';
import { defaultPolicyRegistry } from './policies.js';
import { evidenceKey } from './checks/shared.js';

/**
 * The validation engine.
 *
 * One run is one pass over the catalog for one revision. The engine owns the
 * mechanics the checks must not each reinvent: applicability, append-only
 * diagnostics with supersession, coverage derivation, and the `DRAFT` to
 * `VALIDATED` transition.
 *
 * Applicability is **strict**. A check runs only when the revision actually
 * contains its evidence, and a check that cannot run is recorded as not checked —
 * never as a pass. A capability therefore cannot reach `VALIDATED` while any of
 * its checks have gone unrun, which is the conservative reading of "an empty or
 * partial result is never evidence that a check passed".
 */

/** The catalog by identifier, for coverage derivation. */
const CONSTRAINTS_BY_ID = new Map(CATALOG.map((item) => [item.constraintId, item]));

export const RUN_STATUS = Object.freeze({
  QUEUED: 'QUEUED', RUNNING: 'RUNNING', COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED',
});

export const RUN_REASON = Object.freeze({ VALIDATION: 'VALIDATION', PUBLISH: 'PUBLISH' });

export async function executeRun({
  client,
  projectId,
  scenarioId,
  revisionId,
  scope = 'FULL',
  reason = RUN_REASON.VALIDATION,
  requestedCapabilities = null,
  baseEtag = null,
  actorId = null,
  policies = defaultPolicyRegistry,
  maxDiagnostics = 100_000,
  isCurrentDraft = true,
  approvalPolicy = null,
  runId = randomUUID(),
}) {
  const ctx = await loadRevisionContext({ client, projectId, scenarioId, revisionId });
  if (!ctx.envelope) {
    const error = new Error('The revision has no facility envelope to validate.');
    error.code = 'FACILITY_ENVELOPE_NOT_FOUND';
    throw error;
  }

  Object.assign(ctx, {
    policies,
    isCurrentDraft,
    approvalPolicy,
    lifecycleState: ctx.envelope.lifecycle_state,
    publishGate: reason === RUN_REASON.PUBLISH ? await evaluatePublishGate({ client, ctx }) : null,
  });

  await insertRun(client, { runId, ctx, scope, baseEtag, requestedCapabilities, actorId });

  try {
    const outcome = await evaluateCatalog({ ctx, scope, reason, maxDiagnostics });

    for (const diagnostic of outcome.diagnostics) {
      await persistDiagnostic(client, { ctx, runId, diagnostic, actorId });
    }

    // Diagnostics that no longer hold are closed rather than left gating.
    //
    // Supersession only fires when a later run re-issues the *same* finding. A condition
    // that stopped holding produces no finding at all, so nothing superseded the old row
    // and an edit that fixed a problem could never clear it: the diagnostic stayed OPEN,
    // its capability stayed capped, and the revision could not become VALIDATED. This is
    // the other half of append-only — the record is kept, and its status says it is done.
    const resolved = await resolveClearedDiagnostics(client, {
      ctx,
      runId,
      checkedConstraintIds: outcome.checked,
      findings: outcome.diagnostics,
    });

    const resourceCounts = resourceEvidence(ctx);
    const evidence = { ...ctx.evidence, ...resourceCounts };
    for (const capability of CAPABILITIES) {
      if (evidence[capability] === undefined) evidence[capability] = evidenceByCapability(capability, ctx.evidence);
    }

    const coverage = deriveCoverage({
      diagnostics: outcome.diagnostics,
      notChecked: outcome.notChecked,
      evidence,
      policies,
      constraintsById: CONSTRAINTS_BY_ID,
    });

    const errorCount = outcome.diagnostics.filter((item) => item.severity === 'ERROR').length;
    const warningCount = outcome.diagnostics.filter((item) => item.severity === 'WARNING').length;
    const notCheckedCapabilities = capabilitiesForNotChecked(outcome.notChecked);
    const checkedCapabilities = CAPABILITIES.filter((capability) => !notCheckedCapabilities.includes(capability));

    await completeRun(client, {
      runId,
      ctx,
      errorCount,
      warningCount,
      checkedCapabilities,
      notCheckedCapabilities,
    });

    for (const entry of Object.values(coverage)) {
      await upsertCoverage(client, { ctx, runId, entry, actorId });
    }

    const blocking = outcome.diagnostics.filter((item) => item.severity === 'ERROR' && item.status !== 'WAIVED');
    const validated = scope === 'FULL'
      && reason === RUN_REASON.VALIDATION
      && !outcome.incomplete
      && blocking.length === 0
      && ctx.lifecycleState === 'DRAFT';

    let lifecycleState = ctx.lifecycleState;
    if (validated) {
      lifecycleState = 'VALIDATED';
      await markValidated(client, { ctx, runId, actorId });
    }

    return {
      runId,
      scope,
      reason,
      status: RUN_STATUS.COMPLETED,
      incomplete: outcome.incomplete,
      diagnostics: outcome.diagnostics,
      notChecked: outcome.notChecked,
      coverage,
      errorCount,
      warningCount,
      checkedCapabilities,
      notCheckedCapabilities,
      resolvedDiagnostics: resolved,
      lifecycleState,
      validated,
    };
  } catch (error) {
    await failRun(client, { runId, message: error?.message ?? 'validation failed' });
    throw error;
  }
}

/**
 * Closes the live diagnostics a run has shown to be gone.
 *
 * Only a constraint that **ran** can clear its findings: a check that could not run
 * because its evidence is absent has proved nothing, and treating that as a pass is the
 * mistake strict applicability exists to prevent. A `WAIVED` diagnostic is left alone
 * because a waiver is a governance fact that references it, and `RESOLVED` is a
 * terminal status a later run does not reopen — if the condition comes back, the run
 * emits a new finding, which is what an append-only ledger is for.
 */
async function resolveClearedDiagnostics(client, { ctx, runId, checkedConstraintIds, findings }) {
  if (checkedConstraintIds.length === 0) return [];

  const emitted = new Map();
  for (const finding of findings) {
    const key = evidenceKey(finding);
    if (!emitted.has(finding.constraintId)) emitted.set(finding.constraintId, new Set());
    emitted.get(finding.constraintId).add(key);
  }

  const { rows } = await client.query(
    // The stored key is the finding's identity, and it has to be read back rather
    // than rebuilt from the references: a finding's identity includes its resource
    // kind, which the row does not carry anywhere else. Rows written before the key
    // existed fall back to the references they do carry.
    `SELECT diagnostic_id, constraint_id, entity_refs, geometry_refs, computed->>'evidence_key' AS evidence_key
       FROM facility_diagnostics
      WHERE project_id = $1 AND revision_id = $2
        AND constraint_id = ANY($3::text[])
        AND status IN ('OPEN', 'ACKNOWLEDGED')`,
    [ctx.projectId, ctx.revisionId, checkedConstraintIds],
  );

  const cleared = rows
    .filter((row) => {
      const key = row.evidence_key
        ?? evidenceKey({ entityRefs: row.entity_refs ?? [], geometryRefs: row.geometry_refs ?? [] });
      return !(emitted.get(row.constraint_id)?.has(key) ?? false);
    })
    .map((row) => row.diagnostic_id);

  if (cleared.length === 0) return [];

  await client.query(
    `UPDATE facility_diagnostics SET status = 'RESOLVED'
      WHERE project_id = $1 AND diagnostic_id = ANY($2::uuid[])`,
    [ctx.projectId, cleared],
  );
  return cleared;
}

/** Applicability, evaluation, and the diagnostic ceiling. */
async function evaluateCatalog({ ctx, scope, reason, maxDiagnostics }) {
  const diagnostics = [];
  const notChecked = [];
  // A constraint that ran can also be *cleared*. Without this list a run could report a
  // finding and never report its absence, so a condition that stopped holding stayed
  // OPEN and kept gating coverage forever.
  const checked = [];
  let incomplete = false;
  let sequence = 0;

  for (const constraint of constraintsForScope(scope)) {
    if (constraint.phase === 'PUBLISH' && reason !== RUN_REASON.PUBLISH) {
      notChecked.push({ constraintId: constraint.constraintId, reason: 'publish-only' });
      continue;
    }
    if (!constraint.implemented) {
      notChecked.push({ constraintId: constraint.constraintId, reason: 'no evidence model' });
      continue;
    }
    if ((ctx.evidence[constraint.evidence] ?? 0) === 0) {
      notChecked.push({ constraintId: constraint.constraintId, reason: `no ${constraint.evidence} evidence` });
      continue;
    }
    if (diagnostics.length >= maxDiagnostics) {
      incomplete = true;
      notChecked.push({ constraintId: constraint.constraintId, reason: 'diagnostic limit reached' });
      continue;
    }

    const evaluate = CHECKS[constraint.constraintId];
    if (!evaluate) {
      notChecked.push({ constraintId: constraint.constraintId, reason: 'no evaluator registered' });
      continue;
    }

    // A check that fails must not abort the run's transaction. Each check runs
    // inside a savepoint, so a statement that raises (an invalid geometry in a
    // spatial predicate, say) is rolled back to the savepoint, recorded as not
    // checked, and the batch continues. The run is marked incomplete, which by
    // itself prevents the VALIDATED transition.
    sequence += 1;
    checked.push(constraint.constraintId);
    const savepoint = `check_${sequence}`;
    await ctx.client.query(`SAVEPOINT ${savepoint}`);
    let findings;
    try {
      findings = await evaluate(ctx, constraint);
      await ctx.client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      await ctx.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await ctx.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      incomplete = true;
      notChecked.push({ constraintId: constraint.constraintId, reason: `evaluation error: ${error?.message ?? 'unknown'}` });
      continue;
    }
    for (const item of findings) {
      if (diagnostics.length >= maxDiagnostics) {
        incomplete = true;
        break;
      }
      diagnostics.push(item);
    }
    if (incomplete) notChecked.push({ constraintId: constraint.constraintId, reason: 'diagnostic limit reached' });
  }

  return { diagnostics, notChecked, incomplete, checked };
}

function capabilitiesForNotChecked(notChecked) {
  const byId = new Map(CATALOG.map((item) => [item.constraintId, item]));
  const set = new Set();
  for (const entry of notChecked) {
    const constraint = byId.get(entry.constraintId);
    if (!constraint) continue;
    for (const capability of gatedCapabilities(constraint, null)) set.add(capability);
  }
  return CAPABILITIES.filter((capability) => set.has(capability));
}

async function insertRun(client, { runId, ctx, scope, baseEtag, requestedCapabilities, actorId }) {
  await client.query(
    `INSERT INTO validation_runs
       (validation_run_id, project_id, scenario_id, revision_id, envelope_id, scope, status, base_etag,
        requested_capabilities, checked_capabilities, not_checked_capabilities, error_count, warning_count,
        started_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'RUNNING', $7, COALESCE($8::capability[], '{}'), '{}', '{}', 0, 0, now(), $9)`,
    [
      runId, ctx.projectId, ctx.scenarioId, ctx.revisionId, ctx.envelopeId, scope, baseEtag,
      requestedCapabilities, actorId,
    ],
  );
}

async function completeRun(client, { runId, ctx, errorCount, warningCount, checkedCapabilities, notCheckedCapabilities }) {
  await client.query(
    `UPDATE validation_runs
        SET status = 'COMPLETED', error_count = $3, warning_count = $4,
            checked_capabilities = $5::capability[], not_checked_capabilities = $6::capability[],
            completed_at = now()
      WHERE validation_run_id = $1 AND project_id = $2`,
    [runId, ctx.projectId, errorCount, warningCount, checkedCapabilities, notCheckedCapabilities],
  );
}

async function failRun(client, { runId, message }) {
  await client.query(
    `UPDATE validation_runs
        SET status = 'FAILED', completed_at = now()
      WHERE validation_run_id = $1 AND status = 'RUNNING'`,
    [runId],
  ).catch(() => {});
  void message;
}

/**
 * Diagnostics are append-only. A later run supersedes the previous live
 * diagnostic for the same constraint and evidence, and inherits an active waiver
 * through that chain so a waiver keeps meaning what it meant.
 */
async function persistDiagnostic(client, { ctx, runId, diagnostic, actorId }) {
  const key = evidenceKey(diagnostic);
  const previous = (
    await client.query(
      // The stored key is the finding's identity. Rows written before the key
      // existed fall back to comparing the references they do carry.
      `SELECT diagnostic_id, status, computed
         FROM facility_diagnostics
        WHERE project_id = $1 AND revision_id = $2 AND constraint_id = $3
          AND (
            computed->>'evidence_key' = $4
            OR (computed->>'evidence_key' IS NULL
                AND entity_refs = $5::jsonb AND geometry_refs = $6::jsonb)
          )
          AND status IN ('OPEN', 'ACKNOWLEDGED', 'WAIVED')
        ORDER BY created_at DESC LIMIT 1`,
      [
        ctx.projectId, ctx.revisionId, diagnostic.constraintId, key,
        JSON.stringify(diagnostic.entityRefs), JSON.stringify(diagnostic.geometryRefs),
      ],
    )
  ).rows[0] ?? null;

  let status = 'OPEN';
  // The key rides in `computed` so a later run can match it; the API mapping strips
  // it, because it is plumbing rather than evidence.
  let computed = { ...diagnostic.computed, evidence_key: key };
  if (previous) {
    await client.query(
      `UPDATE facility_diagnostics SET status = 'SUPERSEDED'
        WHERE diagnostic_id = $1 AND project_id = $2`,
      [previous.diagnostic_id, ctx.projectId],
    );
    if (previous.status === 'WAIVED') {
      const waiver = (
        await client.query(
          `SELECT waiver_id, policy_id FROM waivers
            WHERE project_id = $1 AND revision_id = $2 AND status = 'GRANTED'
              AND $3 = ANY(diagnostic_ids)
              AND (expires_at IS NULL OR expires_at > now())
            ORDER BY granted_at DESC LIMIT 1`,
          [ctx.projectId, ctx.revisionId, previous.diagnostic_id],
        )
      ).rows[0] ?? null;
      if (waiver) {
        const resolved = ctx.policies.resolveReference(waiver.policy_id);
        status = 'WAIVED';
        computed = {
          ...computed,
          waiver_id: waiver.waiver_id,
          waiver_policy: waiver.policy_id,
          coverage_promoting: resolved?.policy?.coveragePromotingWaivers === true,
        };
      }
    }
  }

  const diagnosticId = randomUUID();
  await client.query(
    `INSERT INTO facility_diagnostics
       (diagnostic_id, project_id, scenario_id, revision_id, validation_run_id, constraint_id, severity, status,
        entity_refs, geometry_refs, source_values, computed, remediation_category, remediation_hint, policy_ref,
        supersedes_diagnostic_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17)`,
    [
      diagnosticId, ctx.projectId, ctx.scenarioId, ctx.revisionId, runId, diagnostic.constraintId,
      diagnostic.severity, status,
      JSON.stringify(diagnostic.entityRefs), JSON.stringify(diagnostic.geometryRefs),
      JSON.stringify(diagnostic.sourceValues), JSON.stringify(computed),
      diagnostic.remediationCategory, diagnostic.remediationHint, diagnostic.policyRef,
      previous?.diagnostic_id ?? null, actorId,
    ],
  );

  diagnostic.status = status;
  diagnostic.diagnosticId = diagnosticId;
  diagnostic.supersedesDiagnosticId = previous?.diagnostic_id ?? null;
  diagnostic.computed = computed;
  diagnostic.resourceKind = diagnostic.resourceKind ?? null;
  diagnostic.capabilities = gatedCapabilities(
    CATALOG.find((item) => item.constraintId === diagnostic.constraintId) ?? {},
    diagnostic.resourceKind,
  );
  void key;
  return diagnosticId;
}

async function upsertCoverage(client, { ctx, runId, entry, actorId }) {
  await client.query(
    `INSERT INTO capability_coverage
       (revision_id, capability, project_id, scenario_id, envelope_id, status, evidence_refs, reviewed_at,
        created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), $8)
     ON CONFLICT (revision_id, capability, project_id)
     DO UPDATE SET status = EXCLUDED.status,
                   evidence_refs = EXCLUDED.evidence_refs,
                   envelope_id = EXCLUDED.envelope_id,
                   reviewed_at = now(),
                   updated_at = now()`,
    [
      ctx.revisionId, entry.capability, ctx.projectId, ctx.scenarioId, ctx.envelopeId, entry.status,
      JSON.stringify({ reasons: entry.reasons, validation_run_id: runId }), actorId,
    ],
  );
}

/** A clean FULL run freezes the revision as VALIDATED with a content checksum. */
async function markValidated(client, { ctx, runId, actorId }) {
  const checksum = contentChecksum(ctx);
  await client.query(
    `UPDATE revisions SET lifecycle_state = 'VALIDATED', content_checksum = $3, updated_at = now()
      WHERE revision_id = $1 AND project_id = $2 AND lifecycle_state = 'DRAFT'`,
    [ctx.revisionId, ctx.projectId, checksum],
  );
  await client.query(
    `UPDATE facility_envelopes
        SET lifecycle_state = 'VALIDATED', content_checksum = $3, validation_run_id = $4, updated_at = now()
      WHERE envelope_id = $1 AND project_id = $2`,
    [ctx.envelopeId, ctx.projectId, checksum, runId],
  );
  await client.query(
    `INSERT INTO outbox_events
       (event_id, project_id, scenario_id, revision_id, event_type, aggregate_type, aggregate_id, payload, created_by)
     VALUES ($1, $2, $3, $4, 'facility.validation.completed.v1', 'revision', $4, $5::jsonb, $6)`,
    [
      randomUUID(), ctx.projectId, ctx.scenarioId, ctx.revisionId,
      JSON.stringify({ validation_run_id: runId, lifecycle_state: 'VALIDATED', content_checksum: checksum }),
      actorId,
    ],
  );
}

/**
 * The publish gate, evaluated for a publish run: a completed FULL validation run
 * for this revision with no open ERROR.
 */
export async function evaluatePublishGate({ client, ctx }) {
  const { rows } = await client.query(
    `SELECT validation_run_id, status, error_count
       FROM validation_runs
      WHERE project_id = $1 AND revision_id = $2 AND scope = 'FULL'
      ORDER BY created_at DESC LIMIT 1`,
    [ctx.projectId, ctx.revisionId],
  );
  const run = rows[0] ?? null;
  if (!run) return { hasCleanRun: false, reason: 'no FULL validation run' };
  if (run.status !== 'COMPLETED') return { hasCleanRun: false, reason: `run ${run.status}` };
  if (run.error_count > 0) return { hasCleanRun: false, reason: `${run.error_count} open ERROR diagnostic(s)` };
  return { hasCleanRun: true, reason: null, runId: run.validation_run_id };
}

/** A deterministic checksum over the design context the run froze. */
export function contentChecksum(ctx) {
  const canonical = {
    scopes: ctx.scopes.map((row) => [row.scope_id, row.scope_kind, row.name]).sort(),
    containers: ctx.containers.map((row) => [row.container_id, row.kind, row.name, row.parent_container_id]).sort(),
    geometry: ctx.geometry.map((row) => [row.geometry_id, row.entity_id, row.role, row.geometry_type]).sort(),
    sources: ctx.sources.map((row) => [row.utility_source_id, row.kind, String(row.capacity_value), row.capacity_state]).sort(),
    interfaces: ctx.interfaces.map((row) => [row.interface_id, row.utility_source_id, row.service_state]).sort(),
    phases: ctx.phases.map((row) => [row.phase_id, row.phase_order, row.activation_date]).sort(),
    requirements: ctx.requirements.map((row) => [row.requirement_id, row.availability_policy, row.policy_id]).sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export { CAPABILITIES };
