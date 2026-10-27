import { ApiError } from '@ai-infra/core';
import { BINDING_ROLES, createAssetBinding } from '../asset-bindings.js';
import { CAPABILITIES } from '../catalog.js';
import { allChangePermissions } from '../change-kinds.js';
import { MAX_CHANGES, applyChangeSet, requiredPermissionsFor } from '../changes.js';
import { defaultPolicyRegistry } from '../policies.js';
import { createCapacityTools } from './actions-capacity.js';
import { createImportTools } from './actions-import.js';
import { createPublicationTools } from './actions-publication.js';
import { field } from './schema.js';
import { defineTool } from './registry.js';

/**
 * The action tools.
 *
 * Only the operations that already have a domain implementation behind them are
 * declared here. An action with no command is not a thin tool, it is a tool that
 * would have to invent the command — and a fabricated mutation path is the one
 * thing this surface must not ship. The actions that a tier has not yet built are
 * absent by design rather than absent by omission; [Tool Surface](../../../../doc/tools/site-and-facility/tool-surface.md)
 * records which tier owns each.
 *
 * Every action delegates to the existing domain service. The tool layer adds the
 * contract — validated arguments, authorization, tenant scoping, confirmation,
 * audit — and never re-implements the mutation.
 */

const RUN_SCOPES = Object.freeze(['FULL', 'AFFECTED_SUBGRAPH']);
const WAIVER_SCOPES = Object.freeze(['REVISION', 'DIAGNOSTIC', 'ENTITY']);

/**
 * The change-set commit.
 *
 * This is the one tool whose permission requirement depends on its arguments: a set
 * that moves geometry needs `facility.geometry.write`, a set that only renames a
 * building does not. Declaring every key statically would make the tool unusable for
 * anyone who is not a project administrator, and declaring none would be a hole — so
 * the requirement is computed from the set, and the executor still enforces it at the
 * single choke point.
 *
 * It is offered on the baseline authoring keys rather than on the union: a caller who
 * cannot author anything has no use for it, and a caller who can should see it.
 */
function createApplyChangeSetTool({ logger = null } = {}) {
  return defineTool({
    name: 'apply_change_set',
    axis: 'ACTION',
    access: 'write',
    description:
      'Apply one typed change set to a draft, atomically, in dependency order. Returns what changed and the validation findings the change produced. The draft ETag advances on success.',
    requiredFunctions: (args) => requiredPermissionsFor(args?.changes ?? []),
    entryFunctions: ['facility.read', 'facility.entity.write'],
    possibleFunctions: allChangePermissions(),
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      base_revision_id: field.uuid({ required: true }),
      etag: field.string({ required: true }),
      changes: field.array(field.object(), { required: true, maxItems: MAX_CHANGES }),
      preview_diagnostics: field.bool({ default: true }),
      idempotency_key: field.string(),
    },
    handler: async ({ client, args, context }) => {
      // The command composes its own `effect` sentence, so the tool adds nothing to
      // the answer and a direct caller of the command sees the same one.
      return applyChangeSet({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        scenarioId: context.scenarioId ?? null,
        actorId: context.userId ?? null,
        baseRevisionId: args.base_revision_id,
        etag: args.etag,
        changes: args.changes,
        previewDiagnostics: args.preview_diagnostics !== false,
        idempotencyKey: args.idempotency_key ?? null,
        correlationId: context.correlationId ?? null,
        logger,
      });
    },
  });
}

export function createActionTools({ validationService, logger = null, storage = null } = {}) {
  if (!validationService) throw new Error('The action tools require the facility validation service.');

  const runValidation = defineTool({
    name: 'run_validation',
    axis: 'ACTION',
    access: 'write',
    description:
      'Run validation for a revision. AFFECTED_SUBGRAPH answers inline and is advisory; a FULL run is a job and a clean one freezes the revision as VALIDATED, which is irreversible.',
    requiredFunctions: ['facility.validate.run'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      scope: field.enum(RUN_SCOPES, { default: 'AFFECTED_SUBGRAPH' }),
      base_etag: field.string(),
      capabilities: field.array(field.enum(CAPABILITIES), { maxItems: 8 }),
    },
    handler: async ({ args, context }) => {
      const result = await validationService.requestValidation({
        projectId: context.projectId,
        revisionId: context.revisionId,
        scope: args.scope,
        baseEtag: args.base_etag ?? null,
        requestedCapabilities: args.capabilities ?? null,
        actorId: context.userId ?? null,
        correlationId: context.correlationId ?? null,
      });
      return {
        ...result,
        // The consequence travels with the result, because a caller that learns it
        // only afterwards has already frozen the revision.
        consequence:
          args.scope === 'FULL'
            ? 'A clean FULL run freezes this revision as VALIDATED. A validated revision cannot be edited or revalidated.'
            : 'Advisory local run: it never sets lifecycle state, and a full run is still required before publication.',
      };
    },
  });

  const grantWaiver = defineTool({
    name: 'grant_waiver',
    axis: 'ACTION',
    access: 'write',
    description:
      'Record a waiver over named diagnostics. It changes their status and gating only; evidence and the envelope are unchanged, and coverage moves only through a later run.',
    requiredFunctions: ['facility.waiver.grant'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      diagnostic_ids: field.array(field.uuid(), { required: true, maxItems: 100 }),
      policy_id: field.string({ required: true }),
      reason: field.string({ required: true, maxLength: 2048 }),
      scope: field.enum(WAIVER_SCOPES, { default: 'REVISION' }),
      expires_at: field.timestamp(),
    },
    handler: async ({ args, context }) => {
      // A waiver is only as meaningful as the policy that permits it, and an
      // unresolvable reference is a governance record that cannot be audited. The
      // design decision not to fabricate a policy reference starts here.
      const resolved = defaultPolicyRegistry.resolveReference(args.policy_id);
      if (!resolved?.policy) {
        throw new ApiError('VALIDATION_FAILED', 'The waiver policy reference does not resolve.', {
          status: 400,
          details: [
            {
              field: 'policy_id',
              reason: resolved?.reference?.version ? 'unknown_policy_version' : 'policy_reference_not_pinned',
              expected: 'policy_id@version',
            },
          ],
        });
      }

      const waiver = await validationService.grantWaiver({
        projectId: context.projectId,
        revisionId: context.revisionId,
        diagnosticIds: args.diagnostic_ids,
        policyId: args.policy_id,
        reason: args.reason,
        scope: args.scope,
        expiresAt: args.expires_at ?? null,
        actorId: context.userId ?? null,
        correlationId: context.correlationId ?? null,
      });
      logger?.info?.('tool.grant_waiver.recorded', {
        projectId: context.projectId,
        revisionId: context.revisionId,
        waiverId: waiver?.waiverId ?? null,
        policyId: args.policy_id,
        coveragePromoting: resolved.policy.coveragePromotingWaivers === true,
      });
      return {
        ...waiver,
        policy: {
          policyId: resolved.policy.policyId,
          version: resolved.policy.version,
          coveragePromotingWaivers: resolved.policy.coveragePromotingWaivers === true,
        },
        effect:
          'The named diagnostics are now WAIVED. Their evidence is unchanged and they remain listed; coverage changes only through a subsequent validation run.',
      };
    },
  });

  const revokeWaiver = defineTool({
    name: 'revoke_waiver',
    axis: 'ACTION',
    access: 'write',
    description: 'Revoke a recorded waiver, restoring the gate it suppressed without altering the diagnostics it referenced.',
    requiredFunctions: ['facility.waiver.grant'],
    confirmation: 'required',
    // A waiver is identified by its own id and scoped by project, so a revision is
    // not required to address one. Requiring it would force a caller to look up a
    // fact the operation does not need.
    requiresRevision: false,
    input: {
      revision_id: field.uuid(),
      waiver_id: field.uuid({ required: true }),
      reason: field.string({ maxLength: 2048 }),
    },
    handler: async ({ args, context }) => {
      const revoked = await validationService.revokeWaiver({
        projectId: context.projectId,
        waiverId: args.waiver_id,
        reason: args.reason ?? null,
        actorId: context.userId ?? null,
        correlationId: context.correlationId ?? null,
      });
      return {
        ...revoked,
        effect: 'The waiver is REVOKED and the diagnostics it held are released back to their prior gating status.',
      };
    },
  });

  /**
   * Pins an existing project asset version to this revision.
   *
   * The first step of the import flow (ui-pattern.md, "Import Flow" 1) and nothing
   * beyond it: it creates the binding, not a transform, not a mapping, and not a
   * single normalized entity. The tool never re-uploads and never copies bytes —
   * the asset, its versions, and its representations stay in the project asset
   * layer where every other tool can consume them (project-assets.md).
   *
   * It does not advance the draft ETag, because applying an import is what does
   * that (import-adapters.md, "Facility Mapping Rules").
   */
  const createAssetBindingTool = defineTool({
    name: 'create_asset_binding',
    axis: 'ACTION',
    access: 'write',
    description:
      'Bind one exact project asset version, and optionally one of its representations, to a draft revision in a role. Creates provenance only: no transform, no mapping, and no imported entity, and the draft ETag is unchanged.',
    stores: ['bindings'],
    remediation: ['REVIEW_IMPORT'],
    requiredFunctions: ['facility.import.initiate'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      asset_version_id: field.uuid({ required: true }),
      representation_id: field.uuid(),
      role: field.enum(BINDING_ROLES, { required: true }),
    },
    handler: async ({ client, args, context }) => {
      const binding = await createAssetBinding({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        assetVersionId: args.asset_version_id,
        representationId: args.representation_id ?? null,
        role: args.role,
        actorId: context.userId ?? null,
      });
      return {
        ...binding,
        next:
          'Review the transform and the mappings, then preview the merge, before anything is applied to the draft.',
      };
    },
  });

  return [
    runValidation,
    grantWaiver,
    revokeWaiver,
    createAssetBindingTool,
    createApplyChangeSetTool({ logger }),
    ...createCapacityTools({ logger }),
    ...createPublicationTools({ storage, logger }),
    ...createImportTools({ storage, logger }),
  ];
}

/**
 * What the specification declares but no tier has built yet.
 *
 * Change kinds are listed separately from commands because they are delivered through
 * one tool (`apply_change_set`) rather than one tool each. Every declared kind is now
 * built, so this list is empty and the `transform_geometry` kind it used to hold lives
 * in `change-kinds-imports.js`, registered with the other kinds. The list stays as the
 * recorded place a future gap would appear rather than a hole someone rediscovers.
 */
export const PENDING_CHANGE_KINDS = Object.freeze([]);

export const PENDING_ACTIONS = Object.freeze([
  // `pin_policy_reference` has no store: the schema stores pinned policy references on
  // the rows that use them (`resilience_requirements.policy_id`, `waivers.policy_id`),
  // and there is no revision-level policy-pin table for it to write.
  { name: 'pin_policy_reference', remediation: 'REVIEW_POLICY', store: 'revision policy pins', tier: 'T5' },
]);
