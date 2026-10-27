import { getConstraint } from '../catalog.js';
import { defaultPolicyRegistry, parsePolicyRef } from '../policies.js';
import { loadRevisionContext } from '../context.js';
import { field } from './schema.js';
import { defineTool } from './registry.js';

/**
 * The RULE tools: what the system requires, and why.
 *
 * These read the constraint catalog and the versioned policy registry — the two
 * registries that decide what a revision must satisfy. Neither is a store, and
 * neither is duplicated here: `explain_constraint` returns the catalog's own
 * entry, and the policy tools return the registry's own entries, so there is no
 * second place for a rule to become wrong.
 */

const READ = 'facility.read';

export const explainConstraint = defineTool({
  name: 'explain_constraint',
  axis: 'RULE',
  access: 'read',
  description:
    'Explain one catalog constraint: its severity, gating capability, evidence model, scope, phase, remediation category, and — when a revision is in context — whether it applies there and why it did or did not run.',
  requiredFunctions: [READ],
  requiresRevision: false,
  input: {
    constraint_id: field.string({ required: true }),
    revision_id: field.uuid(),
  },
  handler: async ({ client, args, context }) => {
    const entry = getConstraint(args.constraint_id);
    if (!entry) return { constraintId: args.constraint_id, known: false, applicability: null };

    const revisionId = args.revision_id ?? context.revisionId ?? null;
    let applicability = null;

    if (revisionId) {
      // The engine's own snapshot loader answers applicability, because "would
      // this check run" must have exactly one answer in the system. Re-deriving it
      // from counts here would be a second implementation of the applicability
      // rule, and the two would disagree eventually.
      const snapshot = await loadRevisionContext({
        client,
        projectId: context.projectId,
        scenarioId: context.scenarioId ?? null,
        revisionId,
      });
      const populated = snapshot.evidence[entry.evidence] ?? 0;
      applicability = {
        revisionId,
        evidenceBucket: entry.evidence,
        evidenceRows: populated,
        evidencePresent: populated > 0,
        wouldRun: entry.implemented && populated > 0 && entry.phase === 'VALIDATION',
        reason: !entry.implemented
          ? 'no evidence model is implemented for this constraint'
          : populated === 0
            ? `no evidence in this revision for the "${entry.evidence}" bucket`
            : entry.phase === 'PUBLISH'
              ? 'publish-time check: not run by a validation run'
              : 'runs during validation',
      };
    }

    return {
      constraintId: entry.constraintId,
      known: true,
      severity: entry.severity,
      gates: entry.gates,
      evidence: entry.evidence,
      scope: entry.scope,
      phase: entry.phase,
      remediationCategory: entry.remediation,
      implemented: entry.implemented,
      rule: entry.rule,
      applicability,
    };
  },
});

export const listPolicies = defineTool({
  name: 'list_policies',
  axis: 'RULE',
  access: 'read',
  description:
    'List the pinned policy registry entries. A policy reference is only meaningful pinned as policy_id@version; these are the references that resolve.',
  requiredFunctions: [READ],
  requiresRevision: false,
  tenantScoped: false,
  input: {
    policy_id: field.string(),
    kind: field.enum(['AVAILABILITY', 'APPROVAL', 'DERATING', 'WAIVER']),
  },
  handler: async ({ args }) => {
    const policies = defaultPolicyRegistry
      .entries()
      .filter((policy) => (!args.policy_id || policy.policyId === args.policy_id) && (!args.kind || policy.kind === args.kind))
      .map((policy) => ({ ...policy, reference: `${policy.policyId}@${policy.version}` }));
    return { registryVersion: defaultPolicyRegistry.version, policies };
  },
});

export const resolvePolicyRef = defineTool({
  name: 'resolve_policy_ref',
  axis: 'RULE',
  access: 'read',
  description:
    'Resolve one pinned policy reference, reporting whether it resolves, whether its waivers promote coverage, and whether it requires an approval.',
  requiredFunctions: [READ],
  requiresRevision: false,
  tenantScoped: false,
  input: { policy_ref: field.string({ required: true }) },
  handler: async ({ args }) => {
    const resolved = defaultPolicyRegistry.resolveReference(args.policy_ref);
    const reference = resolved?.reference ?? parsePolicyRef(args.policy_ref) ?? null;

    if (!resolved?.policy) {
      return {
        policyRef: args.policy_ref,
        reference,
        resolved: false,
        reason: reference?.version
          ? 'no registry entry matches this policy id and version'
          : 'the reference is not pinned to a version, so it resolves to nothing',
        policy: null,
      };
    }

    return {
      policyRef: args.policy_ref,
      reference,
      resolved: true,
      reason: null,
      policy: {
        ...resolved.policy,
        coveragePromotingWaivers: resolved.policy.coveragePromotingWaivers === true,
        approvalRequired: resolved.policy.approvalRequired === true,
      },
    };
  },
});

export const RULE_TOOLS = Object.freeze([explainConstraint, listPolicies, resolvePolicyRef]);
