import { createContext, createElement, useCallback, useContext, useSyncExternalStore } from 'react';

/**
 * The cross-component effects channel the assistant dispatches into.
 *
 * The canvas owns its selection, its layer switches, its viewport, and its pending
 * change set as local state; the assistant is shell-owned and must not reach into
 * that state directly. This module is the one seam between them: a plain effects
 * object (DOM-free and unit-testable) that the canvas *registers* an imperative
 * handle with, plus a thin context that hands the object to the components that
 * need it.
 *
 * Two rules shape it:
 *  * every method is a no-op with a stated `delta` when no handle is registered —
 *    the assistant may be answering on the validate route, where no canvas exists,
 *    and a lying success is worse than a small piece of honesty;
 *  * a route or tool request is *published* as well as forwarded, because the
 *    surface that must act on it may only mount after the route changes.
 */

/**
 * The spec's uppercase route functions, mapped from the tool registry's lowercase
 * function ids (assistant-integration.md, `route_state.function`).
 */
export const ROUTE_FUNCTION_NAMES = Object.freeze({
  overview: 'OVERVIEW',
  import_map: 'IMPORT_AND_MAP',
  constraints: 'CONSTRAINTS',
  utilities: 'UTILITIES',
  capacity: 'CAPACITY',
  phasing: 'PHASING',
  validate: 'VALIDATE',
});

/** The uppercase `route_state.function` for a registry function id, or OVERVIEW. */
export function routeFunctionName(functionId) {
  return ROUTE_FUNCTION_NAMES[functionId] ?? 'OVERVIEW';
}

/**
 * The spec's `layer_kind` mapped onto the canvas's fixed overlay layers. PHASES,
 * DIAGNOSTICS, and IMPORT_SOURCE have no overlay yet; they are declared here as
 * having no target rather than being quietly folded into another layer.
 */
export const LAYER_KIND_OVERLAY_LAYERS = Object.freeze({
  FACILITIES: Object.freeze(['site', 'spaces', 'buildings']),
  UTILITIES: Object.freeze(['utilities']),
  HAZARDS: Object.freeze(['constraints']),
});

export const LAYER_KINDS_WITHOUT_TARGET = Object.freeze(['PHASES', 'DIAGNOSTICS', 'IMPORT_SOURCE']);

export const EMPTY_SNAPSHOT = Object.freeze({
  routeState: Object.freeze({
    selectedEntityId: null,
    selectedGeometryId: null,
    inspectorTab: null,
    activeLayer: null,
  }),
  selectionRefs: Object.freeze([]),
  draftSummary: null,
  viewport: null,
});

/**
 * The effects object.
 *
 * `onRoute` and `onOpenTool` are the shell's own navigation; everything else
 * delegates to the canvas handle registered through `register`. The returned
 * object is stable for the life of the shell, so a hook or a memo may hold it.
 */
export function createWorkspaceEffects({ onRoute = () => {}, onOpenTool = () => {} } = {}) {
  let handle = null;
  let routeRequest = null;
  let routeNonce = 0;
  const routeListeners = new Set();

  const noHandle = (what) => ({
    applied: false,
    delta: [`No canvas is mounted, so ${what} was not changed.`],
  });

  /** The canvas registers its imperative API here; the returned function detaches it. */
  function register(next) {
    handle = next ?? null;
    return () => {
      if (handle === next) handle = null;
    };
  }

  function publishRoute(request) {
    routeNonce += 1;
    routeRequest = { ...request, nonce: routeNonce };
    for (const listener of routeListeners) listener(routeRequest);
    return routeRequest;
  }

  function selectEntity(input) {
    return handle?.selectEntity?.(input) ?? noHandle('the selection');
  }

  function highlightEntity(input) {
    return handle?.highlightEntity?.(input) ?? noHandle('the highlight');
  }

  function clearHighlight() {
    return handle?.clearHighlight?.() ?? noHandle('the highlight');
  }

  function focusGeometry(input) {
    return handle?.focusGeometry?.(input) ?? noHandle('the viewport');
  }

  /**
   * `layer_kind` → overlay layers. FACILITIES is three layers and UTILITIES one, so
   * the return value names exactly which canvas layers moved; a kind with no canvas
   * layer records a delta and changes nothing.
   */
  function setLayerVisible({ layerKind, visible, geometryRole = null } = {}) {
    const layerIds = LAYER_KIND_OVERLAY_LAYERS[layerKind] ?? null;
    if (!layerIds) {
      return {
        applied: false,
        delta: [`the ${layerKind} layer is not drawn on the canvas yet, so its visibility was not changed`],
      };
    }
    if (!handle?.setVisible) return noHandle(`the ${layerKind} layer visibility`);

    const applied = [];
    const delta = [];
    for (const layerId of layerIds) {
      const outcome = handle.setVisible({ layerId, visible, layerKind, geometryRole });
      applied.push(layerId);
      for (const line of outcome?.delta ?? []) delta.push(line);
    }
    if (geometryRole) {
      delta.push('geometry_role narrowing is not drawn yet; the whole layer was switched');
    }
    return { applied, delta };
  }

  /**
   * Imported source layers are not a canvas layer yet. This is a stated no-op, not
   * a toggle of some other layer that happens to be nearby.
   */
  function revealAssetLayer() {
    return {
      applied: false,
      delta: ['imported source layers are not drawn on the canvas yet, so nothing was revealed'],
    };
  }

  function openInspector(input) {
    return handle?.openInspector?.(input) ?? noHandle('the inspector');
  }

  /** Switches to the validate route and publishes the finding the surface must focus. */
  function showFinding({ revisionId = null, diagnosticId = null, constraintId = null, severity = null } = {}) {
    publishRoute({ functionId: 'validate', revisionId, diagnosticId, constraintId, severity });
    onRoute('validate');
    return { applied: true, route: 'validate' };
  }

  function openRoute(request = {}) {
    if (!request.functionId) return { applied: false, delta: ['no route function was named'] };
    publishRoute(request);
    onRoute(request.functionId);
    return { applied: true, route: request.functionId };
  }

  function openTool(request = {}) {
    if (!request.toolId) return { applied: false, delta: ['no tool was named'] };
    onOpenTool(request.toolId, request);
    return { applied: true, toolId: request.toolId };
  }

  function snapshot() {
    return handle?.snapshot?.() ?? EMPTY_SNAPSHOT;
  }

  /**
   * Re-reads the facility envelope the canvas draws.
   *
   * The canvas owns the read, so it is the canvas that must be asked: a turn that committed
   * a design change left the reader looking at the revision as it was, and until the page was
   * reloaded the change was invisible in the one place it was asked for. The handle performs
   * the read the canvas already knows how to perform; nothing here learns to fetch.
   */
  function reloadEnvelope() {
    if (!handle?.reloadEnvelope) {
      return { applied: false, delta: ['No canvas is mounted, so the facility envelope was not re-read.'] };
    }
    return handle.reloadEnvelope();
  }

  function restoreSnapshot(next) {
    return handle?.restoreSnapshot?.(next);
  }

  return {
    register,
    isMounted: () => handle !== null,
    selectEntity,
    highlightEntity,
    clearHighlight,
    focusGeometry,
    setLayerVisible,
    revealAssetLayer,
    openInspector,
    showFinding,
    openRoute,
    openTool,
    snapshot,
    restoreSnapshot,
    reloadEnvelope,
    getRouteRequest: () => routeRequest,
    subscribeRouteRequest(listener) {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
  };
}

const WorkspaceEffectsContext = createContext(null);

let detachedEffects = null;

/**
 * The effects object for the current tree. A component outside the provider (the
 * canvas rendered alone in a test, say) gets a detached object whose methods are
 * all honest no-ops, so a caller never has to null-check the seam.
 */
export function useWorkspaceEffects() {
  const value = useContext(WorkspaceEffectsContext);
  if (value) return value;
  if (!detachedEffects) detachedEffects = createWorkspaceEffects();
  return detachedEffects;
}

export function WorkspaceEffectsProvider({ effects, children }) {
  return createElement(WorkspaceEffectsContext.Provider, { value: effects }, children);
}

/**
 * The latest route request for one function, as a value the route's own surface can
 * read. `getSnapshot` returns the same object until a new request is published, so
 * it is safe for `useSyncExternalStore`.
 */
export function useRouteRequest(functionId) {
  const effects = useWorkspaceEffects();
  const subscribe = useCallback((listener) => effects.subscribeRouteRequest(listener), [effects]);
  const getSnapshot = useCallback(() => {
    const request = effects.getRouteRequest();
    return request && request.functionId === functionId ? request : null;
  }, [effects, functionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
