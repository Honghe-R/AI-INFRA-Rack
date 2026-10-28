import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAssistantSession } from './assistant-session.js';
import { DEFAULT_ATTACHMENT_POLICY, addAttachments } from './assistant-state.js';
import { createEffectHandlers, createUiActionDispatcher, describeAvailableActions } from './ui-actions.js';
import { createEntityHoverPreview, resolveEntityReference } from './entity-resolver.js';
import { routeFunctionName } from '../facility/workspace-effects.js';
import { contextKey as workspaceContextKey } from '../state/workspace-context.js';

export const RACK_ATTACHMENT_POLICY = Object.freeze({
  accept: [], maxBytes: 0, maxCount: 0, accepted_media_types: [], max_file_size_bytes: 0,
  max_attachments_per_message: 0, required_permission: 'rack.read', binds_to_entity: false,
});

/**
 * The shell's connection to the assistant.
 *
 * The controller in `assistant-session.js` holds all the logic; this hook only
 * adapts it to React and to the API client. The transport is built once per
 * client, and a workspace-context change starts a fresh conversation with a fresh
 * context key — the persisted sessions of the previous context are untouched.
 *
 * Two things arrive from outside and are threaded through refs on purpose: the
 * workspace-effects handle (which changes every render, because it closes over the
 * live selection) and the wire context (which must be read at send time, not at
 * conversation-build time, or a selection made after the composer opened would
 * never reach the model).
 */
export function useAssistantSession({
  client,
  workspaceContext = null,
  scopeLabel: scopeLabelText = '',
  effects = null,
  routeFunctionId = null,
  toolId = 'site_facility',
  toolRouteState = null,
  attachmentPolicy = DEFAULT_ATTACHMENT_POLICY,
  contextToken = null,
}) {
  const transport = useMemo(() => createAssistantTransport(client), [client]);
  const effectiveAttachmentPolicy = toolId === 'rack' ? RACK_ATTACHMENT_POLICY : attachmentPolicy;
  const key = assistantSessionKey(workspaceContext, toolId, toolRouteState);

  const effectsRef = useRef(effects);
  effectsRef.current = effects;
  const latest = useRef(null);
  latest.current = { workspaceContext, routeFunctionId, attachmentPolicy: effectiveAttachmentPolicy, contextToken, toolId, toolRouteState };

  const [state, setState] = useState(null);
  const [uiActionNotices, setUiActionNotices] = useState([]);
  const [provider, setProvider] = useState(null);
  const [model, setModel] = useState(readStoredModel);
  // True while a picked file is being stored. The composer blocks Send on it, so this is
  // state the user can see the effect of, not an internal detail.
  const [uploading, setUploading] = useState(false);
  /**
   * Stores picked files and attaches them.
   *
   * The blueprint's order (§3.7): a file is uploaded when it is picked, not when the
   * message is sent, so the turn never waits on a transfer and a failed upload is reported
   * while the reader is still looking at the picker. The policy is checked *before* the
   * upload, so a file the composer would refuse is never written to the project.
   *
   * The attachment id becomes the asset id: the turn references a project asset, and the
   * assistant's tools resolve it from that. Nothing here invents an id the server has not
   * issued.
   */
  const onAttach = useCallback(
    async (files) => {
      const session = sessionRef.current;
      const picked = [...(files ?? [])];
      if (!session || picked.length === 0) return;

      const projectId = latest.current.workspaceContext?.projectId ?? null;
      if (!projectId) {
        session.noteRejections(picked.map((file) => ({ attachmentId: file.name, reason: 'no project is open' })));
        return;
      }

      const candidates = picked.map((file) => ({
        // Identity before upload: the same file picked twice is the same file, and the
        // policy's duplicate check needs an id it can compare.
        attachmentId: `${projectId}:${file.name}:${file.size}`,
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        file,
      }));

      const existing = session.getState()?.attachments ?? [];
      const { attachments: accepted, rejected } = addAttachments(existing, candidates, latest.current.attachmentPolicy);
      if (rejected.length > 0) session.noteRejections(rejected);
      if (accepted.length === 0) return;

      setUploading(true);
      try {
        for (const candidate of accepted) {
          try {
            const created = await client.createAsset(projectId, {
              name: candidate.name,
              media_type: candidate.mediaType,
              filename: candidate.name,
              size_bytes: candidate.sizeBytes,
            });
            const assetId = created?.data?.asset?.assetId ?? null;
            const versionId = created?.data?.version?.assetVersionId ?? null;
            if (!assetId || !versionId) throw new Error('the asset was reserved without a version');

            await client.uploadAssetContent(projectId, assetId, versionId, candidate.file);
            session.attach([
              {
                attachmentId: assetId,
                name: candidate.name,
                mediaType: candidate.mediaType,
                sizeBytes: candidate.sizeBytes,
              },
            ]);
          } catch (error) {
            session.noteRejections([{ attachmentId: candidate.name, reason: error?.message ?? 'the upload failed' }]);
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [client],
  );

  // Read at send time by the session, so switching model mid-conversation takes effect on
  // the next turn without rebuilding anything.
  const modelRef = useRef(model);
  const sessionRef = useRef(null);
  modelRef.current = model;
  const onModelChange = useCallback((next) => {
    setModel(next || null);
    storeModel(next || null);
  }, []);

  /**
   * What is serving this assistant.
   *
   * Read once per client. It is a fact about the deployment rather than about a turn, so
   * there is nothing to refresh it for — and a failure is deliberately silent: the label
   * is decoration, and a composer that refused to render because it could not name the
   * model would trade a cosmetic absence for a functional one.
   *
   * The `getAssistantProvider` guard keeps the existing tests' stubs working, and is the
   * same shape the usage fetch already assumes.
   */
  useEffect(() => {
    if (!client?.getAssistantProvider) return undefined;
    let cancelled = false;
    client
      .getAssistantProvider()
      .then(({ data }) => {
        if (cancelled) return;
        setProvider(data ?? null);
        // A remembered model the deployment no longer offers is forgotten rather than sent
        // and rejected: the menu belongs to the server, so the server narrowing it must not
        // leave the composer unable to send at all.
        const offered = data?.models ?? [];
        setModel((current) => {
          if (current && !offered.includes(current)) {
            storeModel(null);
            return null;
          }
          return current;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  // The effects handle is rebuilt by the canvas on every render, so the dispatcher
  // holds a stable proxy and reads the current handle when it runs.
  const effectsProxy = useMemo(
    () => ({
      selectEntity: (input) => effectsRef.current?.selectEntity?.(input),
      highlightEntity: (input) => effectsRef.current?.highlightEntity?.(input),
      clearHighlight: () => effectsRef.current?.clearHighlight?.(),
      focusGeometry: (input) => effectsRef.current?.focusGeometry?.(input),
      setLayerVisible: (input) => effectsRef.current?.setLayerVisible?.(input),
      revealAssetLayer: (input) => effectsRef.current?.revealAssetLayer?.(input),
      openInspector: (input) => effectsRef.current?.openInspector?.(input),
      showFinding: (input) => effectsRef.current?.showFinding?.(input),
      openRoute: (input) => effectsRef.current?.openRoute?.(input),
      openTool: (input) => effectsRef.current?.openTool?.(input),
    }),
    [],
  );

  const noticeRef = useRef(() => {});
  noticeRef.current = (line) => setUiActionNotices((current) => [...current, line]);
  const dispatcherRef = useRef(null);
  if (!dispatcherRef.current) {
    dispatcherRef.current = createUiActionDispatcher({
      handlers: createEffectHandlers(effectsProxy),
      onNotice: (line) => noticeRef.current(line),
    });
  }

  const hoverRef = useRef(null);
  if (!hoverRef.current) hoverRef.current = createEntityHoverPreview(() => effectsRef.current);

  useEffect(() => {
    if (!transport || !key) {
      sessionRef.current = null;
      setState(null);
      return undefined;
    }
    const session = createAssistantSession({
      transport,
      contextKey: key,
      scopeLabel: scopeLabelText,
      // A function so the scope is read as it stands at send time. The selection and
      // the pending change set are local to the canvas and do not re-render the
      // shell, so a captured value would be the selection from when the composer
      // opened.
      context: () =>
        contextFor(latest.current.workspaceContext, {
          routeFunctionId: latest.current.routeFunctionId,
          snapshot: effectsRef.current?.snapshot?.() ?? null,
          attachmentPolicy: latest.current.attachmentPolicy,
          contextToken: latest.current.contextToken,
          toolId: latest.current.toolId,
          toolRouteState: latest.current.toolRouteState,
        }),
      model: () => modelRef.current,
      sessionCache: sessionPointerCache(),
    });
    sessionRef.current = session;
    setState(session.getState());
    const unsubscribe = session.subscribe(setState);
    // Turn content is in the object store, so a reload rehydrates it from the
    // session this browser last used in this context.
    session.restore();
    session.refreshUsage();
    return () => {
      unsubscribe();
      session.stop();
      sessionRef.current = null;
    };
    // `scopeLabelText` is presentation of the active tool, so it deliberately does
    // not restart the conversation when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, key]);

  /**
   * One entity reference path for both hover preview and click. Hover snapshots and
   * restores; the pin is the real effect. Kept here rather than in the render tree so
   * the transcript only receives plain callbacks.
   */
  const onEntitySelect = useCallback(
    (entity) => resolveEntityReference(entity, effectsRef.current, { transient: false }),
    [],
  );
  const onEntityHover = useCallback((entity) => hoverRef.current.enter(entity), []);
  const onEntityLeave = useCallback(() => hoverRef.current.leave(), []);

  const uiActionHandler = useCallback(
    (actions, executionContext) => dispatcherRef.current.dispatch(actions, executionContext),
    [],
  );

  return {
    draft: state?.draft ?? '',
    turns: state?.turns ?? [],
    attachments: state?.attachments ?? [],
    attachmentRejections: state?.attachmentRejections ?? [],
    streaming: state?.streaming ?? false,
    restoring: state?.restoring ?? false,
    usage: state?.usage ?? [],
    error: state?.error ?? null,
    attachmentPolicy: effectiveAttachmentPolicy,
    provider,
    models: provider?.models ?? [],
    model,
    onModelChange,
    uiActionNotices,
    onEntitySelect,
    onEntityHover,
    onEntityLeave,
    uiActionHandler,
    onDraftChange: (value) => sessionRef.current?.setDraft(value),
    onSend: () => sessionRef.current?.send(),
    onStop: () => sessionRef.current?.stop(),
    onNewSession: () => {
      setUiActionNotices([]);
      sessionRef.current?.startNew();
    },
    onDetach: (attachmentId) => sessionRef.current?.detach(attachmentId),
    onRetryTurn: (turnId) => sessionRef.current?.retry(turnId),
    onConfirmTurn: (turnId) => sessionRef.current?.confirm(turnId),
    onDenyTurn: (turnId) => sessionRef.current?.deny(turnId),
    // Attachments upload when picked (blueprint §3.7) through the project asset
    // API; the policy is declared here, the picker is the shell's.
    onAttach,
    uploading,
  };
}

/**
 * Remembers only *which* session belongs to a context key. The turns themselves
 * are content and stay in the store the server owns; a browser copy would be a
 * second, unmanaged copy of the transcript.
 */
export const SESSION_POINTER_PREFIX = 'ai-infra.assistant.session.';

export function sessionPointerCache(storage = typeof window !== 'undefined' ? window.localStorage : null) {
  if (!storage) return null;
  const keyFor = (contextKey) => `${SESSION_POINTER_PREFIX}${contextKey}`;
  return {
    read: (contextKey) => {
      try {
        return storage.getItem(keyFor(contextKey));
      } catch {
        return null;
      }
    },
    write: (contextKey, sessionId) => {
      try {
        storage.setItem(keyFor(contextKey), sessionId);
      } catch {
        // Storage that is full or blocked costs a rehydrated conversation, not a turn.
      }
    },
    clear: (contextKey) => {
      try {
        storage.removeItem(keyFor(contextKey));
      } catch {
        // Ignored for the same reason as write.
      }
    },
  };
}

/**
 * The reader's model choice, remembered across reloads.
 *
 * A preference, not a session fact: it survives a new conversation and an identity switch
 * because it says how this person likes the assistant to answer, not who they are. Reading
 * is defensive for the same reason the session pointer is — storage that is full or blocked
 * costs a remembered choice, never a turn.
 */
const MODEL_STORAGE_KEY = 'ai-infra.assistant-model';

function readStoredModel(storage = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    return storage?.getItem(MODEL_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function storeModel(model, storage = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    if (model) storage?.setItem(MODEL_STORAGE_KEY, model);
    else storage?.removeItem(MODEL_STORAGE_KEY);
  } catch {
    // Ignored: a choice that does not persist is still a choice for this session.
  }
}

/** The browser end of the assistant wire contract. */
export function createAssistantTransport(client) {
  if (!client?.sendAssistantTurn) return null;
  return {
    async sendTurn({ messages, contextKey, sessionId, context, model, signal, onEvent, confirmations = null, confirmedCalls = null, deniedCalls = null }) {
      const body = {
        messages,
        context_key: contextKey,
        session_id: sessionId,
        context,
        // Omitted rather than null when unset: an absent key asks the server for its own
        // configured model, which is what a deployment with no menu should always get.
        ...(model ? { model } : {}),
        // The user's decision about a proposal the server gated. Omitted when there is none, so
        // an ordinary turn does not carry an empty list.
        ...(confirmations && confirmations.length > 0 ? { confirmations } : {}),
        // The call the user confirmed, exactly as it was shown, for the server to execute rather
        // than asking the model to propose it again.
        ...(confirmedCalls && confirmedCalls.length > 0 ? { confirmed_calls: confirmedCalls } : {}),
        // And the call the user declined, so the model is told rather than left to propose it
        // again the moment the turn ends.
        ...(deniedCalls && deniedCalls.length > 0 ? { denied_calls: deniedCalls } : {}),
      };

      // The streamed turn is the same turn — same body, same envelope, same errors — so the
      // only reason to fall back is a client that predates it.
      if (typeof client.streamAssistantTurn === 'function') {
        return client.streamAssistantTurn(body, { signal, onEvent });
      }
      const { data } = await client.sendAssistantTurn(body, { signal });
      return data;
    },
    async listSessions(contextKey) {
      const { data } = await client.listAssistantSessions(contextKey);
      return data?.sessions ?? [];
    },
    async loadHistory({ sessionId, contextKey }) {
      const { data } = await client.loadAssistantHistory(sessionId, contextKey);
      return data ?? { turns: [] };
    },
    async getUsage() {
      const { data } = await client.getAssistantUsage();
      return data ?? null;
    },
  };
}

/**
 * The context the server canonicalises (`AssistantComposerContext`,
 * assistant-integration.md "Grounding and Workspace Digest").
 *
 * All eight documented fields are reported. The four flat camelCase scope keys are
 * kept beside them because the assistant route resolves the project and revision
 * from those spellings; dropping them would break the turn that carries the new
 * shape. `readOnly` is defence in depth only: selection and the entry permission
 * are enforced server-side. `context_token` is omitted until a server mint route
 * exists — an absent token is not an empty one.
 */
export function contextFor(workspaceContext, options = {}) {
  if (!workspaceContext) return null;
  const {
    routeFunctionId = null,
    snapshot = null,
    attachmentPolicy = DEFAULT_ATTACHMENT_POLICY,
    contextToken = null,
    toolId = 'site_facility',
    toolRouteState = null,
  } = options;

  if (toolId === 'rack') {
    const route = toolRouteState ?? {};
    return {
      surface: 'rack', tool_id: 'rack', projectId: workspaceContext.projectId,
      scenarioId: workspaceContext.scenarioId, revisionId: workspaceContext.revisionId,
      readOnly: workspaceContext.lifecycleState !== 'DRAFT',
      rack_context: { planId: route.rackPlanId ?? null,
        clientVersion: route.rackEditDraft?.baseVersion ?? null,
        hasUnsavedDraft: Boolean(route.rackDraft || route.rackEditDraft) },
      route_state: { function: routeFunctionId ?? route.functionId ?? 'overview' },
      // Facility selection/effects may still be mounted in another tab. None of
      // that data or those actions belong to a Rack turn.
      available_actions: [], selection_refs: [],
      attachment_policy: RACK_ATTACHMENT_POLICY,
    };
  }

  const route = snapshot?.routeState ?? {};
  const draft = snapshot?.draftSummary ?? null;

  return {
    surface: 'site_facility',
    projectId: workspaceContext.projectId,
    scenarioId: workspaceContext.scenarioId,
    revisionId: workspaceContext.revisionId,
    readOnly: workspaceContext.lifecycleState !== 'DRAFT',
    workspace_context: {
      project_id: workspaceContext.projectId,
      scenario_id: workspaceContext.scenarioId,
      revision_id: workspaceContext.revisionId,
      lifecycle_state: workspaceContext.lifecycleState,
    },
    tool_id: 'site_facility',
    route_state: {
      function: routeFunctionName(routeFunctionId ?? route.function),
      selected_entity_id: route.selectedEntityId ?? null,
      selected_geometry_id: route.selectedGeometryId ?? null,
      inspector_tab: route.inspectorTab ?? null,
      active_layer: route.activeLayer ?? null,
    },
    selection_refs: snapshot?.selectionRefs ?? [],
    draft_summary: {
      dirty: draft?.dirty === true,
      base_revision_id: draft?.baseRevisionId ?? workspaceContext.revisionId,
      if_match: draft?.etag ?? null,
      pending_change_count: draft?.changeCount ?? 0,
    },
    available_actions: describeAvailableActions(),
    attachment_policy: attachmentPolicy,
    ...(contextToken ? { context_token: contextToken } : {}),
  };
}

export function assistantSessionKey(context, toolId = 'site_facility', route = null) {
  if (!context) return null;
  const base = workspaceContextKey(context);
  return toolId === 'rack' ? `${base}|rack|${route?.rackPlanId ?? 'unselected'}` : base;
}
