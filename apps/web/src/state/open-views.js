import { defaultFunctionId, resolveFunctionId } from './tool-registry.js';
import { isCompatible } from './workspace-context.js';

/**
 * The open-view tab set: a working set, not a second navigation tree.
 *
 * Reducers are pure, and tab ids are supplied by the caller, so the model is
 * testable without a DOM and the shell keeps control of identity.
 *
 * Rules encoded here (ui-pattern.md, "Open-View Tabs"):
 *  * a tool and workspace context has **exactly one** tab (`OPEN` activates the
 *    existing tab instead of creating a second);
 *  * selecting an inner function updates route state and never adds a tab;
 *  * closing the active tab activates the most recently used remaining tab, and
 *    closing the last one returns the workspace to its overview;
 *  * a dirty tab is never closed without `force`, because unsaved work must not
 *    be discarded silently.
 */

export function createOpenViewsState() {
  return { tabs: [], activeTabId: null, activationOrder: [] };
}

export function openViewsReducer(state, action) {
  switch (action.type) {
    case 'OPEN':
      return openTab(state, action);
    case 'ACTIVATE':
      return activateTab(state, action.tabId);
    case 'CLOSE':
      return closeTab(state, action.tabId, action.force === true);
    case 'SET_ROUTE_STATE':
      return setRouteState(state, action.tabId, action.routeState);
    case 'SET_DIRTY':
      return setDirty(state, action.tabId, action.dirty, action.reason);
    case 'SET_BADGE':
      return setBadge(state, action.tabId, action.badge);
    case 'RESTORE':
      return restore(state, action.tabs, action.activeTabId, action.workspaceContext);
    case 'RESET':
      return createOpenViewsState();
    default:
      return state;
  }
}

function openTab(state, { tabId, toolId, workspaceContext, routeState }) {
  const existing = tabForTool(state, toolId, workspaceContext);
  const resolvedRoute = { ...(routeState ?? {}), functionId: resolveFunctionId(toolId, routeState) };

  if (existing) {
    const tabs = state.tabs.map((tab) =>
      tab.tabId === existing.tabId
        ? { ...tab, routeState: resolvedRoute, lastActivatedAt: Date.now() }
        : tab,
    );
    return activateTab({ ...state, tabs }, existing.tabId);
  }

  const tab = {
    tabId,
    toolId,
    workspaceContext,
    routeState: resolvedRoute,
    dirtyState: { dirty: false },
    badge: null,
    lastActivatedAt: Date.now(),
  };

  return activateTab({ ...state, tabs: [...state.tabs, tab] }, tabId);
}

function activateTab(state, tabId) {
  if (!tabId || !state.tabs.some((tab) => tab.tabId === tabId)) return state;
  const activationOrder = [...state.activationOrder.filter((id) => id !== tabId), tabId];
  const tabs = state.tabs.map((tab) => (tab.tabId === tabId ? { ...tab, lastActivatedAt: Date.now() } : tab));
  return { ...state, tabs, activeTabId: tabId, activationOrder };
}

function closeTab(state, tabId, force) {
  const tab = state.tabs.find((item) => item.tabId === tabId);
  if (!tab) return state;

  // Unsaved work is never discarded silently: the shell confirms first and then
  // re-issues the close with `force`.
  if (tab.dirtyState?.dirty === true && !force) return state;

  const remaining = state.tabs.filter((item) => item.tabId !== tabId);
  const activationOrder = state.activationOrder.filter((id) => id !== tabId);

  let activeTabId = state.activeTabId;
  if (state.activeTabId === tabId) {
    // Most recently used among the tabs that remain; null returns to the overview.
    activeTabId = [...activationOrder].reverse().find((id) => remaining.some((item) => item.tabId === id)) ?? null;
  }

  return { ...state, tabs: remaining, activeTabId, activationOrder };
}

function setRouteState(state, tabId, routeState) {
  const target = tabId ?? state.activeTabId;
  if (!target) return state;
  const tab = state.tabs.find((item) => item.tabId === target);
  if (!tab) return state;

  const merged = { ...tab.routeState, ...(routeState ?? {}) };
  merged.functionId = resolveFunctionId(tab.toolId, merged);
  return { ...state, tabs: state.tabs.map((item) => (item.tabId === target ? { ...item, routeState: merged } : item)) };
}

function setDirty(state, tabId, dirty, reason) {
  const next = { dirty: dirty === true, reason: reason ?? null };
  const tab = state.tabs.find((item) => item.tabId === tabId);
  // Reporting the same state must not produce a new state object. A surface that reports
  // its dirtiness from an effect would otherwise dispatch on every render, and each
  // dispatch re-renders — an unbounded loop rather than a redundant update.
  if (!tab || (tab.dirtyState?.dirty === next.dirty && (tab.dirtyState?.reason ?? null) === next.reason)) {
    return state;
  }
  return {
    ...state,
    tabs: state.tabs.map((item) => (item.tabId === tabId ? { ...item, dirtyState: next } : item)),
  };
}

function setBadge(state, tabId, badge) {
  return { ...state, tabs: state.tabs.map((tab) => (tab.tabId === tabId ? { ...tab, badge } : tab)) };
}

/**
 * Restores persisted tabs, keeping only those belonging to the current context.
 * Stale tabs are dropped rather than silently repointed at a different revision.
 */
function restore(state, tabs, activeTabId, workspaceContext) {
  const compatible = (tabs ?? [])
    .filter((tab) => isCompatible(tab.workspaceContext, workspaceContext))
    .map((tab) => ({
      ...tab,
      routeState: { ...tab.routeState, functionId: resolveFunctionId(tab.toolId, tab.routeState) },
    }));

  const activationOrder = [...(state.activationOrder ?? []), ...compatible.map((tab) => tab.tabId)];
  const active = compatible.some((tab) => tab.tabId === activeTabId)
    ? activeTabId
    : (compatible.at(-1)?.tabId ?? null);

  return { tabs: compatible, activeTabId: active, activationOrder };
}

// --- selectors --------------------------------------------------------------

export function activeTab(state) {
  return state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? null;
}

export function tabForTool(state, toolId, workspaceContext) {
  return (
    state.tabs.find(
      (tab) => tab.toolId === toolId && isCompatible(tab.workspaceContext, workspaceContext),
    ) ?? null
  );
}

export function hasDirtyTabs(state) {
  return state.tabs.some((tab) => tab.dirtyState?.dirty === true);
}

/** The inner function the sidebar should highlight for the active tab. */
export function activeFunctionId(state) {
  const tab = activeTab(state);
  if (!tab) return null;
  return tab.routeState?.functionId ?? defaultFunctionId(tab.toolId);
}
