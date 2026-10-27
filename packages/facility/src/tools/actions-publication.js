import { recordApproval, publishRevision } from '../publication.js';
import { defineTool } from './registry.js';
import { field } from './schema.js';

/**
 * The lifecycle action tools (T5).
 *
 * `publish_revision` is the assistant surface's publication capability and the API's
 * `POST …/publish` route. `request_approval` records an attestation, which the
 * publication gate reads; it is a governance record rather than a design mutation, so
 * it does not advance the draft token.
 *
 * Both delegate to `../publication.js`, which owns the gate and the one-way
 * transition. Neither re-implements a rule, and neither invents a mutation path.
 */
export function createPublicationTools({ storage = null, logger = null } = {}) {
  const publish = defineTool({
    name: 'publish_revision',
    axis: 'ACTION',
    access: 'write',
    description:
      'Publish a VALIDATED revision: evaluate the publication gate in a PUBLISH run, and on a clean gate transition it to PUBLISHED atomically with the frozen envelope object, the impact notice, and the published event. A PUBLISHED revision is never reopened.',
    stores: ['facility_envelopes'],
    remediation: [],
    requiredFunctions: ['facility.publish'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      validation_run_id: field.uuid(),
      // The capability contract carries the draft preconditions on every write, and
      // a caller that supplies them gets the same concurrency check as any other
      // write; publish itself targets a VALIDATED revision rather than a draft.
      base_revision_id: field.uuid(),
      if_match: field.string(),
    },
    handler: async ({ client, args, context }) =>
      publishRevision({
        client,
        storage,
        projectId: context.projectId,
        revisionId: context.revisionId,
        validationRunId: args.validation_run_id ?? null,
        actorId: context.userId ?? null,
        correlationId: context.correlationId ?? null,
        logger,
      }),
  });

  const approve = defineTool({
    name: 'request_approval',
    axis: 'ACTION',
    access: 'write',
    description:
      'Record an immutable approval, rejection, or revocation attestation for a revision and project the envelope’s approval state from it. It never changes a diagnostic, coverage, or the envelope’s content.',
    stores: ['attestations'],
    remediation: ['OBTAIN_APPROVAL'],
    requiredFunctions: ['facility.approve'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      policy_id: field.string({ required: true }),
      decision: field.enum(['APPROVED', 'REJECTED', 'REVOKED'], { required: true }),
      comment: field.string({ maxLength: 2048 }),
    },
    handler: async ({ client, args, context }) =>
      recordApproval({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        policyId: args.policy_id,
        decision: args.decision,
        comment: args.comment ?? null,
        actorId: context.userId ?? null,
        correlationId: context.correlationId ?? null,
      }),
  });

  return [publish, approve];
}
