import { ApiError, errors } from '@ai-infra/core';
import { toApiError } from '../assistant-host.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Workspace assistant routes (chatbox blueprint §4.1, §4.9, §4.10).
 *
 * These routes are authenticated but carry no route-level permission key: a turn's
 * authorization is the contextual guide's `requiredEntryFunctions` evaluated at
 * the resolved project scope, which the orchestrator performs before the provider
 * is called. A route permission would be a second, weaker answer to the same
 * question.
 *
 * The chat response is the client-facing envelope from blueprint §5 — `choices`,
 * `uiActions`, `entities`, `usage`, `trace` — and `status` distinguishes a
 * completed turn from one that stopped at a confirmation gate.
 */
export function registerAssistantRoutes(router, { orchestrator, sessionService = null, usageService = null, provider = null, models = [], redact = (value) => value, connections = null, resolveTurn = null }) {
  if (!orchestrator) throw new Error('registerAssistantRoutes requires an assistant orchestrator.');

  /**
   * What is serving this assistant.
   *
   * The server owns provider selection, so a client cannot ask for a provider and must
   * not be told a credential — but it may be told *which* one is answering. The composer
   * labels itself with this, and the alternative — a build-time constant in the bundle —
   * would be wrong the moment the gateway or model changed, which is exactly the sort of
   * thing a demo is expected to change.
   */
  router.get('/api/v1/assistant/provider', async ({ user }) => {
    const personal = connections ? await connections.get(user.userId) : null;
    return { data: personal ?? {
      provider: provider?.name ?? null,
      model: provider?.model ?? null,
      host: provider?.host ?? null,
      // The choices this deployment offers, so the composer can render a menu rather than
      // a text box. The client picks from this list and the route below re-checks it.
      models,
      ...(connections ? { configured: Boolean(provider?.host && provider?.model), personalSetup: true } : {}),
    } };
  });

  if (connections) {
    router.get('/api/v1/assistant/connection', async ({ user }) => ({ data: { connection: await connections.get(user.userId) } }));
    router.put('/api/v1/assistant/connection', async ({ user, json }) => ({ data: { connection: await connections.save(user.userId, await json()) } }));
    router.delete('/api/v1/assistant/connection', async ({ user, json }) => {
      await connections.remove(user.userId, (await json()).version);
      return { data: { deleted: true } };
    });
    router.post('/api/v1/assistant/connection/test', async ({ user, json, response }) => {
      const controller = new AbortController();
      const onClose = () => { if (!response.writableEnded) controller.abort(); };
      response.on('close', onClose);
      try { return { data: await connections.test(user.userId, await json(), controller.signal) }; }
      finally { response.off('close', onClose); }
    });
  }

  router.post('/api/v1/assistant/chat', async (ctx) => {
    const { json, user, correlationId, response, query } = ctx;
    const body = await json();
    // Credentials and arbitrary provider URLs belong only to connection management.
    if (['apiKey', 'api_key', 'endpoint', 'provider', 'baseURL'].some((key) => Object.hasOwn(body, key))) {
      throw new ApiError('ASSISTANT_CHAT_INVALID', '聊天请求只能引用已保存的模型连接。', { status: 400 });
    }

    // A caller never supplies its own identity: the authenticated user is stamped
    // over anything the payload claims.
    const clientContext = body.context && typeof body.context === 'object' ? body.context : {};
    const context = {
      surface: clientContext.surface ?? 'site_facility',
      projectId: clientContext.projectId ?? clientContext.project_id ?? null,
      scenarioId: clientContext.scenarioId ?? clientContext.scenario_id ?? null,
      revisionId: clientContext.revisionId ?? clientContext.revision_id ?? null,
      // The editor's draft snapshot: the ETag it last read, which a write must present so a
      // concurrent edit is a 409 rather than a silent overwrite. It was being sent and dropped,
      // leaving the model to reconstruct a uuid it could not know.
      draftSummary: clientContext.draft_summary ?? clientContext.draftSummary ?? null,
      rackContext: clientContext.rack_context ?? clientContext.rackContext ?? null,
      readOnly: clientContext.readOnly === true,
      userId: user.userId,
      publicId: user.publicId ?? null,
    };

    // A disconnect aborts the provider call, so the composer's stop control stops
    // paying for tokens rather than merely hiding the answer.
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.on('close', onClose);

    /**
     * Watching the loop, optionally live.
     *
     * The turn stays request/response: `?stream=1` changes only whether the rounds are
     * written as they complete or returned with the envelope. Everything else — the body,
     * the authorization, the envelope, the errors — is identical, so the two modes cannot
     * drift.
     */
    const streaming = query?.stream === '1';

    let turnHost = null;
    if (streaming) {
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        // Proxies that buffer by default would hold every round until the turn ended,
        // which is the one thing this mode exists to avoid.
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      if (typeof response.flushHeaders === 'function') response.flushHeaders();
    }

    /** One newline-delimited JSON record. */
    const write = (event) => {
      if (!streaming || response.writableEnded) return;
      response.write(`${JSON.stringify(event)}\n`);
    };

    try {
      turnHost = resolveTurn ? await resolveTurn({ userId: user.userId, connectionId: body.connection_id ?? null,
        connectionVersion: body.connection_version ?? null }) : null;
      const selectedModel = requestedModel(body.model, turnHost?.models ?? models);
      let turnContextKey = body.context_key ?? body.contextKey;
      if (turnHost?.connectionId) {
        const suffix = `|connection:${turnHost.connectionId}:${turnHost.connectionVersion}|model:${encodeURIComponent(selectedModel ?? turnHost.model)}`;
        if (typeof turnContextKey !== 'string' || !turnContextKey.endsWith(suffix)) {
          throw new ApiError('ASSISTANT_CONNECTION_CONTEXT_INVALID', '会话与模型连接不匹配，请刷新后开启新会话。', { status: 400 });
        }
      }
      const result = await (turnHost?.orchestrator ?? orchestrator).runTurn({
        messages: body.messages,
        model: selectedModel,
        contextKey: turnContextKey,
        sessionId: body.session_id ?? body.sessionId ?? null,
        context,
        confirmations: Array.isArray(body.confirmations) ? body.confirmations : [],
        // The calls the user confirmed, as they were shown. Executed as given, not re-proposed.
        confirmedCalls: Array.isArray(body.confirmed_calls) ? body.confirmed_calls : [],
        // And the ones they declined. Nothing runs; the model is told, so the turn answers the
        // refusal instead of proposing the same call again.
        deniedCalls: Array.isArray(body.denied_calls) ? body.denied_calls : [],
        userRole: body.user_role ?? body.userRole ?? null,
        requestId: correlationId,
        signal: turnHost?.signal ? AbortSignal.any([controller.signal, turnHost.signal]) : controller.signal,
        onEvent: write,
      });
      // An attachment list needs no server work: the client has already written the
      // reference block into the last user message, and the assistant's attachment
      // tools arrive with the tool surface (T8).
      if (streaming) {
        write({ type: 'turn', data: result });
        response.end();
        return undefined;
      }
      return { data: result };
    } catch (error) {
      const apiError = toApiError(error, turnHost?.redact ?? redact);
      // Once the headers are out a status cannot be revised, so a failure that happens
      // mid-stream is reported as the event the client is already reading. This is what
      // makes a timeout visible rather than empty: the rounds that did complete have
      // already been sent and are kept.
      if (streaming && !response.writableEnded) {
        write({ type: 'error', error: { code: apiError.code, message: apiError.message, details: apiError.details ?? [] } });
        response.end();
        return undefined;
      }
      throw apiError;
    } finally {
      turnHost?.release();
      response.off('close', onClose);
    }
  });

  router.get('/api/v1/assistant/sessions', async ({ query, user }) => {
    const service = requirePersistence(sessionService);
    const sessions = await service.list({ userId: user.userId, contextKey: query.context_key ?? null });
    return { data: { sessions } };
  });

  router.get('/api/v1/assistant/sessions/:sessionId/history', async ({ params, query, user }) => {
    const service = requirePersistence(sessionService);
    // A malformed identifier is a 404, never a query that reaches the database.
    if (!UUID.test(params.sessionId)) throw errors.notFound();
    const history = await service.load({
      sessionId: params.sessionId,
      userId: user.userId,
      contextKey: query.context_key ?? null,
    });
    return { data: history };
  });

  /**
   * The caller's own monthly usage, which is the popover's "overall user usage".
   * Per-session usage rides back on the turn itself; workspace and organisation
   * accounting is deferred with the rest of the tool surface.
   */
  router.get('/api/v1/assistant/usage', async ({ user }) => {
    if (!usageService) throw new ApiError('SERVICE_UNAVAILABLE', 'Assistant usage accounting is unavailable.', { status: 503 });
    const summary = await usageService.userSummary({ userId: user.userId });
    return { data: summary };
  });
}

/**
 * The model a turn asks for, or null for the deployment's own.
 *
 * The client may choose, but only from the menu the deployment published — the endpoint
 * and the credential remain the server's, so "the server owns provider selection" still
 * holds. A model outside the list is a 400 rather than a silent fallback: quietly running
 * a different model than the one asked for would make the composer's label a lie, and the
 * usage audit would attribute the turn to the wrong model.
 */
function requestedModel(requested, allowed) {
  if (requested === undefined || requested === null || requested === '') return null;
  if (typeof requested !== 'string' || !allowed.includes(requested)) {
    throw new ApiError('MODEL_NOT_ALLOWED', `This deployment does not offer the model "${requested}".`, { status: 400 });
  }
  return requested;
}

function requirePersistence(sessionService) {
  if (!sessionService) {
    throw new ApiError('SERVICE_UNAVAILABLE', 'Object storage is not configured, so assistant history is unavailable.', {
      status: 503,
    });
  }
  return sessionService;
}
