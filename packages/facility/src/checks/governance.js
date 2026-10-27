import { finding } from './shared.js';
import { parsePolicyRef } from '../policies.js';

/**
 * Revision and governance checks. They gate publication, not capability coverage:
 * the engine runs them on a publish evaluation and records them as not checked
 * during a validation run, because a draft that is not being published has
 * nothing to gate.
 */
export const governanceChecks = {
  /** A run or write must target the revision that is the current draft. */
  'facility.revision.current': async (ctx, constraint) => {
    if (ctx.isCurrentDraft !== false) return [];
    return [finding(constraint, {
      sourceValues: [{ field: 'revision_id', value: ctx.revisionId }],
      computed: { expression: 'target is the current draft', expected: true, actual: false },
      remediationHint: 'A later draft exists; re-open the current draft before editing or validating.',
    })];
  },

  /** Publication without a completed clean FULL run is refused. */
  'facility.revision.publish.requires_validation': async (ctx, constraint) => {
    if (ctx.publishGate?.hasCleanRun) return [];
    return [finding(constraint, {
      sourceValues: [{ field: 'validation_run_id', value: ctx.envelope?.validation_run_id ?? null }],
      computed: {
        expression: 'completed FULL run with no open ERROR',
        expected: true,
        actual: ctx.publishGate?.reason ?? 'no clean validation run',
      },
    })];
  },

  /** Every source and policy the revision leans on must be pinned to a version. */
  'facility.revision.publish.source_unpinned': async (ctx, constraint) => {
    const findings = [];
    for (const requirement of ctx.requirements) {
      const reference = parsePolicyRef(requirement.policy_id);
      if (reference && reference.version === null) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'RESILIENCE_REQUIREMENT', entity_id: requirement.requirement_id }],
          sourceValues: [{ field: 'policy_id', value: requirement.policy_id }],
          computed: { expression: 'policy reference is pinned', expected: 'policy_id@version', actual: requirement.policy_id },
        }));
      }
    }
    for (const mapping of ctx.mappings.filter((row) => row.review_state !== 'REVIEWED')) {
      findings.push(finding(constraint, {
        entityRefs: [{ entity_type: 'ENTITY', entity_id: mapping.mapping_id }],
        sourceValues: [{ field: 'review_state', value: mapping.review_state }],
        computed: { expression: 'mapping review state', expected: 'REVIEWED', actual: mapping.review_state },
      }));
    }
    for (const binding of ctx.bindings.filter((row) => row.status !== 'REVIEWED')) {
      findings.push(finding(constraint, {
        entityRefs: [{ entity_type: 'ENTITY', entity_id: binding.binding_id }],
        sourceValues: [{ field: 'status', value: binding.status }],
        computed: { expression: 'binding review state', expected: 'REVIEWED', actual: binding.status },
      }));
    }
    return findings;
  },

  /** A validated or published revision is immutable. */
  'facility.revision.writes_immutable': async (ctx, constraint) => {
    if (!ctx.lifecycleState || ctx.lifecycleState === 'DRAFT') return [];
    return [finding(constraint, {
      sourceValues: [{ field: 'lifecycle_state', value: ctx.lifecycleState }],
      computed: { expression: 'write target is mutable', expected: 'DRAFT', actual: ctx.lifecycleState },
      remediationHint: 'Branch a new draft from the published revision to make a change.',
    })];
  },

  /** A deployment policy that demands an attestation must have an approved one. */
  'facility.governance.approval.required': async (ctx, constraint) => {
    // The deployment approval policy is pinned on the requirement's provenance
    // (`approval_policy`), because the policy store lives outside this tool.
    const policyRefs = [
      ...ctx.requirements.map((requirement) => requirement.provenance?.approval_policy),
      ctx.approvalPolicy ?? null,
    ].filter(Boolean);
    const findings = [];
    for (const referenceRaw of policyRefs) {
      const reference = parsePolicyRef(referenceRaw);
      const policy = reference ? ctx.policies.resolve(reference.policyId, reference.version) : null;
      if (!policy?.approvalRequired) continue;
      const approved = ctx.attestations.some((attestation) => attestation.decision === 'APPROVED');
      if (!approved) {
        findings.push(finding(constraint, {
          sourceValues: [{ field: 'approval_policy', value: referenceRaw }],
          computed: { expression: 'APPROVED attestation exists', expected: true, actual: false },
          policyRef: referenceRaw,
        }));
      }
    }
    return findings;
  },

  'facility.governance.waiver.expired': async (ctx, constraint) => {
    const now = Date.now();
    return ctx.waivers
      .filter((waiver) => waiver.status === 'GRANTED' && waiver.expires_at && new Date(waiver.expires_at).getTime() < now)
      .map((waiver) => finding(constraint, {
        entityRefs: [{ entity_type: 'WAIVER', entity_id: waiver.waiver_id }],
        sourceValues: [{ field: 'expires_at', value: waiver.expires_at }],
        computed: { expression: 'waiver expiry', expected: 'in the future', actual: waiver.expires_at },
      }));
  },

  /** A waiver must cover diagnostics that belong to this revision. */
  'facility.governance.waiver.scope_mismatch': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT w.waiver_id, w.scope, d.diagnostic_id, d.revision_id AS diagnostic_revision
         FROM waivers w
         LEFT JOIN facility_diagnostics d
           ON d.diagnostic_id = ANY(w.diagnostic_ids) AND d.project_id = w.project_id
        WHERE w.project_id = $1 AND w.revision_id = $2
          AND (d.diagnostic_id IS NULL OR d.revision_id <> w.revision_id)`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'WAIVER', entity_id: row.waiver_id }],
      computed: {
        expression: 'waived diagnostics belong to the waiver revision',
        expected: true,
        actual: row.diagnostic_id ? 'different revision' : 'diagnostic missing',
      },
    }));
  },

  /** A revoked attestation does not govern unless a later approval replaced it. */
  'facility.governance.attestation.revoked': async (ctx, constraint) => {
    const ordered = [...ctx.attestations].sort((a, b) => new Date(a.approved_at) - new Date(b.approved_at));
    const revoked = ordered.filter((attestation) => attestation.decision === 'REVOKED');
    return revoked
      .filter((attestation) => !ordered.some(
        (later) => later.decision === 'APPROVED' && new Date(later.approved_at) > new Date(attestation.approved_at),
      ))
      .map((attestation) => finding(constraint, {
        entityRefs: [{ entity_type: 'ENTITY', entity_id: attestation.attestation_id }],
        sourceValues: [{ field: 'decision', value: attestation.decision }],
        computed: { expression: 'governing attestation', expected: 'APPROVED', actual: 'REVOKED' },
      }));
  },
};

export const governanceCheckIds = Object.keys(governanceChecks);
