import {
  createAssistantHost,
  createDefaultCatalog,
  createProviderFromConfig,
  createRedactor,
  LlmError,
  redactDeep,
} from '@ai-infra/assistant';
import { ApiError, errors } from '@ai-infra/core';
import { createAssistantSurface } from '@ai-infra/facility';
import { createStorage } from '@ai-infra/storage';
import { createRackAssistantSurface } from './services/rack-assistant.js';
import { createRackLayoutService } from './services/rack-layout.js';
import { createRackPlanService } from './services/rack-plans.js';
import { createRackAssistantEdits } from './services/rack-assistant-edits.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Assistant host assembly (chatbox blueprint §4.1 and §4.2).
 *
 * The API owns three things the assistant package deliberately does not: where the
 * provider configuration comes from, what a context key resolves to in this
 * application, and how an authorization question reaches RBAC. Everything else —
 * the provider loop, bounding, entity references, prompt composition, session and
 * usage persistence — belongs to `@ai-infra/assistant`.
 */
export async function createAssistantHostFor({ config, pool, secrets, guard, logger = null, toolSurface = null, connections = null }) {
  // Personal setup remains available without a deployment-wide model.
  const factory = connections && !config.llmEndpoint ? null : createProviderFromConfig({ config, secrets });
  const redact = createRedactor([await resolveCredentialValue(config, secrets)]);

  // The facility surface is the tool's own declaration of what the model may call.
  // It is bound to the same executor the HTTP routes use, so a model turn and a UI
  // request cannot take different code paths through permissions, concurrency,
  // bounding, redaction, or audit.
  const projection = toolSurface ? createAssistantSurface({ execute: toolSurface.execute }) : null;
  const catalog = createDefaultCatalog({
    capabilities: projection?.capabilities ?? [],
    uiActions: projection?.uiActions ?? [],
    guide: projection?.guide ?? null,
  });
  const authorize = createPermissionAuthorizer({ guard });
  if (pool) {
    const layouts = createRackLayoutService({ pool });
    const rack = createRackAssistantSurface({ layouts, plans: createRackPlanService({ pool }), authorize,
      edits: createRackAssistantEdits({ pool, layouts, authorize }) });
    catalog.surfaces.push(rack.surface);
    catalog.guides.push(rack.guide);
    catalog.capabilities = [...catalog.capabilities, ...rack.capabilities];
  }
  const storage = createStorageOrNull(config, logger);

  const assemble = (provider, connectionRedact) => createAssistantHost({
    provider,
    pool,
    storage,
    surfaces: catalog.surfaces,
    guides: catalog.guides,
    capabilities: catalog.capabilities,
    uiActions: catalog.uiActions,
    resolveScope: createAssistantScopeResolver({ pool, authorize }),
    authorize,
    // The site_facility surface declares no digest, so the orchestrator performs
    // no context query and `buildDigest` stays null.
    buildDigest: null,
    limits: {
      maxIterations: config.assistantMaxIterations,
      maxMessages: config.assistantMaxMessages,
      maxInputBytes: config.assistantMaxInputBytes,
      resultBytes: config.assistantResultBytes,
      digestBytes: config.assistantDigestBytes,
      quota: {
        userMonthlyTokens: config.assistantUserMonthlyTokens,
        workspaceMonthlyTokens: config.assistantWorkspaceMonthlyTokens,
        organisationMonthlyTokens: config.assistantOrganisationMonthlyTokens,
      },
    },
    logger,
    redact: connectionRedact,
  });
  const host = assemble(factory ? lazyProvider(factory, config) : {
    name: 'openai-compatible', model: null,
    async complete() { throw new LlmError('ASSISTANT_SETUP_REQUIRED', 'Set up your model connection before chatting.', { status: 503 }); },
  }, redact);

  // What the composer labels itself with. Read from the same factory the turn uses, so
  // the label cannot drift from the provider that actually answers: a deployment that
  // switches gateway or model reports the new one without a client change.
  //
  // `host` is the endpoint's hostname — the actual *provider*, as a reader means it
  // ("models.sjtu.edu.cn"). `name` is the protocol the gateway speaks, which is a fact
  // about the client, not about who is answering, so the composer shows the host.
  return {
    ...host,
    redact,
    connections,
    ...(connections ? {
      async resolveTurn({ userId, connectionId, connectionVersion }) {
        const personal = await connections.get(userId);
        if (!personal) {
          if (connectionId != null) throw new ApiError('ASSISTANT_CONNECTION_CHANGED', 'Your model connection was deleted. Reload the connection settings.', { status: 412 });
          return { orchestrator: host.orchestrator, models: config.llmModels ?? [], redact, release() {} };
        }
        const connection = await connections.open(userId, connectionId, connectionVersion);
        try {
          return { ...assemble(connection.provider, connection.redact), models: connection.models,
            redact: connection.redact, signal: connection.signal, connectionId: connection.connectionId,
            connectionVersion: connection.version, model: connection.model, release: connection.release };
        } catch (error) { connection.release(); throw error; }
      },
    } : {}),
    // The menu the route validates against. Empty means the deployment offers no choice.
    models: config.llmModels ?? [],
    provider: {
      name: factory?.providerName ?? config.llmProvider ?? null,
      model: config.llmModel ?? null,
      host: endpointHost(config.llmEndpoint),
    },
  };
}

/**
 * The hostname of the configured provider endpoint, or null.
 *
 * Only the host is reported. A reader asking "which provider is this" means the service
 * being called, not the path it is called at, and reporting the whole URL would put the
 * gateway's route layout into every browser for no gain. A malformed endpoint yields
 * null rather than throwing: a misconfigured gateway already fails loudly on the first
 * turn, and the label must not be the thing that breaks startup.
 */
function endpointHost(endpoint) {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host || null;
  } catch {
    return null;
  }
}

/**
 * The provider is built on first use because resolving the credential is a secret
 * manager call. A failed build is not cached: a later turn retries it, so a
 * transient outage does not require a restart.
 */
function lazyProvider(factory, config) {
  let built = null;
  return {
    name: factory.providerName,
    model: config.llmModel ?? null,
    async complete(args) {
      if (!built) {
        built = factory.build().catch((error) => {
          built = null;
          throw error;
        });
      }
      return (await built).complete(args);
    },
  };
}

/**
 * Turns a context key plus the client's context into the canonical scope. The
 * project is the authorization unit: it is resolved against the database, so a
 * foreign or malformed project id is a 404 and never a widened scope. The
 * organisation comes from the project row, not from the request.
 *
 * The revision is canonicalised the same way, and that is what makes `readOnly`
 * authoritative rather than client-declared (T8): a named revision is looked up in
 * this project, a scenario with no named revision resolves to its newest draft, and a
 * revision that is not `DRAFT` marks the scope read-only. The client's own readOnly
 * flag is a hint the server never widens: it can ask for less, not for more.
 */
export function createAssistantScopeResolver({ pool, authorize = null }) {
  return async function resolveScope({ context = {} } = {}) {
    const projectId = context.projectId ?? null;
    if (!projectId) {
      throw new ApiError('ASSISTANT_CONTEXT_UNKNOWN', 'A project-scoped assistant context requires a project id.', { status: 400 });
    }
    if (typeof projectId !== 'string' || !UUID.test(projectId)) throw errors.notFound();

    const { rows } = await pool.query('SELECT organization_id, name FROM projects WHERE project_id = $1', [projectId]);
    if (rows.length === 0) throw errors.notFound();

    const scenarioId = context.scenarioId ?? null;
    const revisionId = context.revisionId ?? null;
    let revision = null;
    if (revisionId) {
      if (typeof revisionId !== 'string' || !UUID.test(revisionId)) throw errors.notFound();
      revision = (
        await pool.query(
          `SELECT revision_id, scenario_id, lifecycle_state, base_revision_id
             FROM revisions WHERE project_id = $1 AND revision_id = $2`,
          [projectId, revisionId],
        )
      ).rows[0] ?? null;
      if (!revision) throw errors.notFound();
    } else if (scenarioId) {
      if (typeof scenarioId !== 'string' || !UUID.test(scenarioId)) throw errors.notFound();
      revision = (
        await pool.query(
          `SELECT revision_id, scenario_id, lifecycle_state, base_revision_id
             FROM revisions
            WHERE project_id = $1 AND scenario_id = $2
            ORDER BY (lifecycle_state = 'DRAFT') DESC, created_at DESC
            LIMIT 1`,
          [projectId, scenarioId],
        )
      ).rows[0] ?? null;
      if (!revision) throw errors.notFound();
    }

    let rackContext = null;
    if (context.surface === 'rack') {
      // Entry authorization precedes reading the selected plan; each tool also
      // rechecks it at execution time (the permission may have been revoked).
      for (const key of ['rack.read', 'facility.read']) {
        if (!authorize || !await authorize({ key, userId: context.userId, workspaceId: projectId }))
          throw new ApiError('ASSISTANT_FORBIDDEN', 'Rack and Facility read access are required.', { status: 403 });
      }
      const hint = context.rackContext ?? {};
      if (typeof hint !== 'object' || Array.isArray(hint)) throw new ApiError('ASSISTANT_CONTEXT_INVALID', 'Malformed Rack context.', { status: 400 });
      if (hint.clientVersion != null && (!Number.isSafeInteger(hint.clientVersion) || hint.clientVersion < 1))
        throw new ApiError('ASSISTANT_CONTEXT_INVALID', 'Rack clientVersion must be a positive integer.', { status: 400 });
      rackContext = { planId: null, version: null, clientVersion: hint.clientVersion ?? null, hasUnsavedDraft: hint.hasUnsavedDraft === true };
      if (hint.planId != null) {
        if (typeof hint.planId !== 'string' || !UUID.test(hint.planId)) throw errors.notFound();
        const layout = await createRackLayoutService({ pool }).get({ projectId, planId: hint.planId });
        if (!revision || layout.scenarioId !== revision.scenario_id || layout.facilityInput.revisionId !== revision.revision_id) throw errors.notFound('Rack plan not found in this workspace.');
        rackContext = { ...rackContext, planId: layout.planId, version: layout.version };
      }
    }
    return {
      surface: context.surface ?? 'site_facility',
      workspaceId: projectId,
      organisationId: rows[0].organization_id ?? null,
      // The revision's own scenario wins over the client's, so the pair can never be
      // assembled from two different requests.
      scenarioId: revision?.scenario_id ?? scenarioId ?? null,
      revisionId: revision?.revision_id ?? null,
      lifecycleState: revision?.lifecycle_state ?? null,
      // The base a write is prepared against: the parent a branch was taken from, or the draft
      // itself when it is a root. This is the value `requireBaseRevision` checks, and it is the
      // server's to state — the model was being asked for a uuid it could not reconstruct.
      baseRevisionId: revision ? (revision.base_revision_id ?? revision.revision_id) : null,
      // The draft token the editor last read, carried on the turn's draft summary. It stays the
      // *client's* snapshot, so the lost-update check still means something; a turn with no
      // summary leaves it null and the write presents whatever the caller supplies.
      ifMatch: draftIfMatch(context),
      scopeKind: 'project',
      displayName: rows[0].name ?? projectId,
      // A validated or published revision is immutable, so a scope that names one is
      // read-only whatever the client claimed.
      readOnly: revision ? revision.lifecycle_state !== 'DRAFT' : context.readOnly === true,
      ...(rackContext ? { rackContext } : {}),
    };
  };
}

/**
 * The draft ETag a turn's client reported, from either wire spelling.
 *
 * The web assistant sends `draft_summary: { if_match }` with every turn, evaluated at send time,
 * so it is the token the editor actually last saw. A caller that sends no summary leaves the
 * precondition to the model, which is the pre-existing behaviour.
 */
function draftIfMatch(context) {
  const summary = context.draftSummary ?? null;
  const value = summary?.if_match ?? summary?.ifMatch ?? context.ifMatch ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The bridge from the orchestrator's authorization question to the permission
 * guard. A denial is a boolean here; the orchestrator turns it into the
 * documented 403, so selection and the entry check share one decision path.
 */
export function createPermissionAuthorizer({ guard }) {
  return async function authorize({ key, userId, workspaceId }) {
    if (!key) return true;
    try {
      await guard.check(
        key,
        { user: { userId }, params: {}, body: {}, query: workspaceId ? { project_id: workspaceId } : {} },
        { projectParam: 'project_id' },
      );
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status >= 500) throw error;
      return false;
    }
  };
}

/** Translates the assistant's typed failures into the API error envelope. */
export function toApiError(error, redact = (value) => value) {
  if (!(error instanceof LlmError)) return error;
  return new ApiError(error.code, redact(error.message), {
    status: error.status,
    details: Array.isArray(error.details) ? redactDeep(error.details, redact) : [],
  });
}

async function resolveCredentialValue(config, secrets) {
  if (!config.llmApiKeySecret || !secrets) return null;
  try {
    return (await secrets.get(config.llmApiKeySecret)) ?? null;
  } catch {
    // A missing credential is reported by `build()`; redaction must not fail startup.
    return null;
  }
}

function createStorageOrNull(config, logger) {
  try {
    return createStorage(config);
  } catch (error) {
    // Chat still works without object storage; only history persistence is lost.
    logger?.warn?.('startup.assistant_storage_unavailable', { reason: error?.message });
    return null;
  }
}
