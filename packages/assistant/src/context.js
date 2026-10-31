import { LlmError } from './errors.js';

/**
 * Context, guides, and authorization (chatbox blueprint §4.5).
 *
 * The resolver turns a client context key into a canonical object with a
 * display name and a read-only flag. Guides are versioned policy records; their
 * prose is prompt material, and the **permission keys** are the authorization
 * decision, never the prose.
 */
export function createGuide(descriptor) {
  if (!descriptor?.key || !descriptor?.surface) throw new Error('A guide requires a key and a surface.');
  return Object.freeze({
    key: descriptor.key,
    version: descriptor.version ?? 1,
    surface: descriptor.surface,
    requiredEntryFunctions: Object.freeze([...(descriptor.requiredEntryFunctions ?? [])]),
    instructions: Object.freeze([...(descriptor.instructions ?? [])]),
    operatingPrinciples: Object.freeze([...(descriptor.operatingPrinciples ?? [])]),
    workflow: Object.freeze([...(descriptor.workflow ?? [])]),
    stateSignals: Object.freeze([...(descriptor.stateSignals ?? [])]),
    guardrails: Object.freeze([...(descriptor.guardrails ?? [])]),
  });
}

export function createContextResolver({
  guides = [],
  surfaces = [],
  resolveScope,
  requiresWorkspace = true,
} = {}) {
  if (typeof resolveScope !== 'function') throw new Error('createContextResolver requires a resolveScope function.');
  const guideBySurface = new Map(guides.map((guide) => [guide.surface, guide]));
  const surfaceByKey = new Map(surfaces.map((surface) => [surface.key, surface]));

  async function resolve({ contextKey, context = {} } = {}) {
    if (typeof contextKey !== 'string' || contextKey.length === 0) {
      throw new LlmError('ASSISTANT_CONTEXT_UNKNOWN', 'A context key is required.', { status: 400 });
    }
    const scope = await resolveScope({ contextKey, context });
    if (!scope) throw new LlmError('ASSISTANT_CONTEXT_UNKNOWN', `Unknown context "${contextKey}".`, { status: 400 });

    const surfaceKey = scope.surface ?? context.surface ?? null;
    const surface = surfaceByKey.get(surfaceKey) ?? null;
    if (!surface) throw new LlmError('ASSISTANT_CONTEXT_UNKNOWN', `Unknown surface "${surfaceKey}".`, { status: 400 });

    if (requiresWorkspace && surface.digest !== null && !scope.workspaceId) {
      // A context that needs a workspace but lacks one is a 4xx, never a fallback
      // to a privileged default.
      throw new LlmError('ASSISTANT_CONTEXT_UNKNOWN', 'This context requires a workspace.', { status: 400 });
    }

    return Object.freeze({
      contextKey,
      surface: surface.key,
      surfaceVersion: surface.version,
      digestAvailable: surface.digest !== null,
      guide: guideBySurface.get(surface.key) ?? null,
      workspaceId: scope.workspaceId ?? null,
      organisationId: scope.organisationId ?? null,
      // A tool call is scoped to a project, a scenario, and a revision. The resolver
      // carries them from the resolved scope so a handler never invents one, and so a
      // scope identifier in the model's arguments can be compared against the real one.
      scenarioId: scope.scenarioId ?? context.scenarioId ?? null,
      revisionId: scope.revisionId ?? context.revisionId ?? null,
      // The resolved revision's lifecycle, so the prompt can state it and a write can
      // be seen to target an immutable revision before it is attempted.
      lifecycleState: scope.lifecycleState ?? null,
      // The write preconditions. `baseRevisionId` is the revision's own base — the server
      // knows it and the model cannot reconstruct it. `ifMatch` is the draft token the editor
      // last read, so it can only come from the turn's draft summary.
      baseRevisionId: scope.baseRevisionId ?? context.baseRevisionId ?? null,
      ifMatch: scope.ifMatch ?? context.ifMatch ?? null,
      scopeKind: scope.scopeKind ?? null,
      displayName: scope.displayName ?? surface.key,
      readOnly: scope.readOnly === true || context.readOnly === true,
      // Tool-specific scope has already been canonicalised by the API resolver.
      ...(scope.surface === 'rack' ? { rackContext: Object.freeze({ ...scope.rackContext }) } : {}),
    });
  }

  /** Every required entry permission must hold; one denial refuses the turn. */
  async function authorize({ context, authorize: isAuthorized }) {
    const required = context.guide?.requiredEntryFunctions ?? [];
    for (const key of required) {
      if (!(await isAuthorized(key))) {
        throw new LlmError('ASSISTANT_FORBIDDEN', 'You do not have access to this context.', {
          status: 403,
          details: [{ permission_key: key }],
        });
      }
    }
    return true;
  }

  return { resolve, authorize, guides: () => [...guideBySurface.values()], surfaces: () => [...surfaceByKey.values()] };
}

/**
 * Builds the execution context handed to every tool call. It carries identity and
 * scope only — never credentials.
 *
 * `baseRevisionId` and `ifMatch` are the write preconditions. They travel here because
 * they are the same class of value as the scope: a uuid the model cannot reproduce and
 * that the server (or the turn's draft summary) already holds.
 */
export function createExecutionContext({
  principalName = 'assistant',
  userId,
  publicId = null,
  workspaceId = null,
  organisationId = null,
  scenarioId = null,
  revisionId = null,
  baseRevisionId = null,
  ifMatch = null,
  requestId,
  sessionId,
  readOnly = false,
  rackContext = null,
  signal = null,
}) {
  if (!userId) throw new LlmError('ASSISTANT_CONTEXT_INVALID', 'An initiating user is required.', { status: 500 });
  if (!requestId) throw new LlmError('ASSISTANT_CONTEXT_INVALID', 'A request id is required.', { status: 500 });
  return Object.freeze({
    principal: Object.freeze({ type: 'service', name: principalName }),
    initiatedBy: Object.freeze({ type: 'user', userId, publicId }),
    workspaceId,
    organisationId,
    scenarioId,
    revisionId,
    baseRevisionId,
    ifMatch,
    readOnly: readOnly === true,
    ...(rackContext ? { rackContext: Object.freeze({ ...rackContext }) } : {}),
    requestId,
    sessionId,
    signal,
  });
}
