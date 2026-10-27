import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from 'react';
import { createOpenViewsState, hasDirtyTabs, openViewsReducer } from '../state/open-views.js';
import { createBottomDrawerState, bottomDrawerReducer, drawerActions } from '../state/bottom-drawer.js';
import {
  createUiContext,
  loadAppearance,
  loadLayout,
  resolveColorScheme,
  resolveResponsive,
  saveAppearance,
  saveLayout,
  uiActions,
  uiContextReducer,
} from '../state/ui-context.js';
import { contextKey, contextSwitchRequiresConfirmation, createWorkspaceContext } from '../state/workspace-context.js';

/**
 * The shell providers.
 *
 * Three stores, kept separate on purpose (ui-pattern.md, "Interaction and State
 * Contract"): UI Context is presentation only, the workspace context is
 * authoritative domain state, and open views are the shell's working set.
 *
 * Every browser-only API is reached inside an effect, so the same components
 * render under `react-dom/server` in tests.
 */

// --- viewport ---------------------------------------------------------------

export function useViewport() {
  const [viewport, setViewport] = useState({ widthPx: 1440, touch: false });

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const update = () =>
      setViewport({
        widthPx: window.innerWidth,
        touch: window.matchMedia?.('(pointer: coarse)').matches ?? false,
      });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return viewport;
}

/**
 * Whether the operating system asks for a dark interface. `SYSTEM` is the default
 * scheme, so without this the default preference would silently mean "light".
 */
export function usePrefersDark() {
  const [prefersDark, setPrefersDark] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setPrefersDark(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return prefersDark;
}

// --- UI context -------------------------------------------------------------

const UiContextValue = createContext(null);

export function useUiContext() {
  const value = useContext(UiContextValue);
  if (!value) throw new Error('useUiContext must be used inside UiContextProvider.');
  return value;
}

export function UiContextProvider({
  children,
  storage = typeof window !== 'undefined' ? window.localStorage : null,
  initialUi = null,
  workspaceContext = null,
  viewport = null,
}) {
  // Hydration is initial state, not an effect.
  //
  // Hydrating in an effect races the save effect below: the first save writes the
  // pre-hydration defaults over the stored payload, and React's StrictMode effect
  // re-invocation then re-reads that clobbered value — silently discarding the
  // user's saved appearance on every load. Reading once, before the first render,
  // removes the race entirely. A caller-supplied `initialUi` still wins.
  const [ui, dispatch] = useReducer(uiContextReducer, undefined, () =>
    createUiContext(initialUi ?? loadAppearance(storage) ?? {}),
  );
  const detected = useViewport();
  const prefersDark = usePrefersDark();
  const resolved = useMemo(() => resolveResponsive(ui, viewport ?? detected), [ui, viewport, detected]);
  // What the shell actually renders, as opposed to the stored preference.
  const resolvedColorScheme = resolveColorScheme(ui.colorScheme, prefersDark);

  // Appearance is per user and device class.
  useEffect(() => {
    if (storage) saveAppearance(storage, ui);
  }, [storage, ui.colorScheme, ui.contrastMode, ui.density, ui.motion, ui.locale, ui.layout.sidebarMode, ui.layout.sidebarPinned, ui.layout.sidebarWidthPx, ui.interaction]);

  // Layout is per workspace context; a context change restores only compatible
  // state. The restore runs once per context key and the save waits for it, for the
  // same reason appearance hydrates before its first save: otherwise one clobbers
  // the other and the stored layout is lost.
  const currentContextKey = workspaceContext ? contextKey(workspaceContext) : null;
  const [layoutHydratedFor, setLayoutHydratedFor] = useState(null);

  useEffect(() => {
    if (!storage || !currentContextKey || layoutHydratedFor === currentContextKey) return;
    dispatch({ type: 'RESTORE', context: { ...ui, layout: loadLayout(storage, workspaceContext, ui).layout } });
    setLayoutHydratedFor(currentContextKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage, currentContextKey, layoutHydratedFor]);

  useEffect(() => {
    if (!storage || !currentContextKey || layoutHydratedFor !== currentContextKey) return;
    saveLayout(storage, workspaceContext, ui);
  }, [storage, workspaceContext, currentContextKey, layoutHydratedFor, ui.layout]);

  const actions = useMemo(() => {
    const dispatchAction = (creator) => (...args) => dispatch(creator(...args));
    return {
      setColorScheme: dispatchAction(uiActions.setColorScheme),
      setContrastMode: dispatchAction(uiActions.setContrastMode),
      setDensity: dispatchAction(uiActions.setDensity),
      setMotion: dispatchAction(uiActions.setMotion),
      setLocale: dispatchAction(uiActions.setLocale),
      setSidebarMode: dispatchAction(uiActions.setSidebarMode),
      setSidebarPinned: dispatchAction(uiActions.setSidebarPinned),
      setSidebarWidth: dispatchAction(uiActions.setSidebarWidth),
      setBottomDrawerOpen: dispatchAction(uiActions.setBottomDrawerOpen),
      setBottomDrawerHeight: dispatchAction(uiActions.setBottomDrawerHeight),
      setMainViewMode: dispatchAction(uiActions.setMainViewMode),
      setAssistantOpen: dispatchAction(uiActions.setAssistantOpen),
      setAssistantWidth: dispatchAction(uiActions.setAssistantWidth),
      setVisibility: dispatchAction(uiActions.setVisibility),
      setInteraction: dispatchAction(uiActions.setInteraction),
    };
  }, []);

  const value = useMemo(
    () => ({
      ui,
      resolved,
      resolvedColorScheme,
      actions,
      // Presentation state plus the resolved responsive view, which is what
      // components actually render from.
      shellAttributes: {
        // The resolved scheme, so `SYSTEM` follows the operating system.
        'data-color-scheme': resolvedColorScheme,
        'data-contrast': ui.contrastMode,
        'data-density': ui.density,
        'data-motion': ui.motion,
      },
    }),
    [ui, resolved, resolvedColorScheme, actions],
  );

  return <UiContextValue.Provider value={value}>{children}</UiContextValue.Provider>;
}

// --- workspace --------------------------------------------------------------

const WorkspaceValue = createContext(null);

export function useWorkspace() {
  const value = useContext(WorkspaceValue);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}

let tabSequence = 0;
export function nextTabId(toolId) {
  tabSequence += 1;
  return `${toolId}:${tabSequence}`;
}

export function WorkspaceProvider({
  children,
  initialContext = null,
  initialViews = null,
  restoreOpenViews = true,
  storage = typeof window !== 'undefined' ? window.localStorage : null,
}) {
  const [workspaceContext, setWorkspaceContext] = useState(
    initialContext ? createWorkspaceContext(initialContext) : null,
  );
  // Seeded views support a deep link that resolves its project and revision
  // before opening the requested tool.
  const [views, dispatchViews] = useReducer(openViewsReducer, initialViews, (seed) => seed ?? createOpenViewsState());
  const [drawer, dispatchDrawer] = useReducer(bottomDrawerReducer, undefined, createBottomDrawerState);
  const [pendingClose, setPendingClose] = useState(null);
  const [pendingSwitch, setPendingSwitch] = useState(null);

  const selectTool = useCallback(
    (toolId, routeState) => {
      if (!workspaceContext) return null;
      const existing = views.tabs.find(
        (tab) => tab.toolId === toolId && contextKey(tab.workspaceContext) === contextKey(workspaceContext),
      );
      const tabId = existing?.tabId ?? nextTabId(toolId);
      dispatchViews({ type: 'OPEN', tabId, toolId, workspaceContext, routeState });
      return tabId;
    },
    [workspaceContext, views.tabs],
  );

  const selectFunction = useCallback((functionId) => {
    dispatchViews({ type: 'SET_ROUTE_STATE', routeState: { functionId } });
  }, []);

  const activateTab = useCallback((tabId) => dispatchViews({ type: 'ACTIVATE', tabId }), []);

  /** A dirty tab is never closed silently: the caller confirms, then forces. */
  const requestCloseTab = useCallback(
    (tabId) => {
      const tab = views.tabs.find((item) => item.tabId === tabId);
      if (tab?.dirtyState?.dirty) {
        setPendingClose({ tabId, reason: tab.dirtyState.reason ?? null });
        return false;
      }
      dispatchViews({ type: 'CLOSE', tabId });
      return true;
    },
    [views.tabs],
  );

  const confirmCloseTab = useCallback(() => {
    if (pendingClose) dispatchViews({ type: 'CLOSE', tabId: pendingClose.tabId, force: true });
    setPendingClose(null);
  }, [pendingClose]);

  const cancelCloseTab = useCallback(() => setPendingClose(null), []);

  const setDirty = useCallback(
    (tabId, dirty, reason) => dispatchViews({ type: 'SET_DIRTY', tabId, dirty, reason }),
    [],
  );

  const setBadge = useCallback((tabId, badge) => dispatchViews({ type: 'SET_BADGE', tabId, badge }), []);

  /** Switching context asks first when a tool holds unsaved work. */
  const requestContextSwitch = useCallback(
    (next, interaction = {}, { landingToolId = null } = {}) => {
      if (contextSwitchRequiresConfirmation(views.tabs, interaction)) {
        // The landing view survives the confirmation: the user asked to enter a
        // project, not merely to abandon the current one.
        setPendingSwitch({ next, landingToolId });
        return false;
      }
      applyContext(next, { landingToolId });
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [views.tabs],
  );

  const applyContext = useCallback((next, { landingToolId = null } = {}) => {
    if (!next) {
      setWorkspaceContext(null);
      dispatchViews({ type: 'RESET' });
      setPendingSwitch(null);
      return;
    }
    const context = createWorkspaceContext(next);
    setWorkspaceContext(context);
    // Every tab belongs to the previous context and is reset with it. The landing
    // tab is opened here, with the fresh context, because the caller's own copy of
    // the context is still the previous one (ui-pattern.md, "Project List Entry").
    dispatchViews({ type: 'RESET' });
    if (landingToolId) {
      dispatchViews({
        type: 'OPEN',
        tabId: nextTabId(landingToolId),
        toolId: landingToolId,
        workspaceContext: context,
      });
    }
    dispatchDrawer(drawerActions.dropStale(context));
    setPendingSwitch(null);
  }, []);

  /** Returns to the project list, asking first when a tool holds unsaved work. */
  const closeWorkspace = useCallback(() => {
    if (contextSwitchRequiresConfirmation(views.tabs, {})) {
      setPendingSwitch({ next: null });
      return false;
    }
    applyContext(null);
    return true;
  }, [views.tabs, applyContext]);

  const confirmContextSwitch = useCallback(() => {
    if (pendingSwitch) applyContext(pendingSwitch.next, { landingToolId: pendingSwitch.landingToolId ?? null });
  }, [pendingSwitch, applyContext]);

  const cancelContextSwitch = useCallback(() => setPendingSwitch(null), []);

  const openDrawerTab = useCallback((tabId) => dispatchDrawer(drawerActions.selectTab(tabId)), []);
  const registerDrawerTab = useCallback((tab) => dispatchDrawer(drawerActions.registerContextual(tab)), []);
  const closeDrawerTab = useCallback((tabId) => dispatchDrawer(drawerActions.closeTab(tabId)), []);
  const setDrawerOpen = useCallback((open) => dispatchDrawer(open ? drawerActions.open() : drawerActions.close()), []);
  const setDrawerHeight = useCallback((heightPx) => dispatchDrawer(drawerActions.setHeight(heightPx)), []);
  const setDrawerBadge = useCallback(
    (tabId, badge) => dispatchDrawer(drawerActions.setBadge(tabId, badge)),
    [],
  );

  const value = useMemo(
    () => ({
      workspaceContext,
      views,
      drawer,
      pendingClose,
      pendingSwitch,
      hasDirtyTabs: hasDirtyTabs(views),
      selectTool,
      selectFunction,
      activateTab,
      requestCloseTab,
      confirmCloseTab,
      cancelCloseTab,
      setDirty,
      setBadge,
      requestContextSwitch,
      confirmContextSwitch,
      cancelContextSwitch,
      closeWorkspace,
      openDrawerTab,
      registerDrawerTab,
      closeDrawerTab,
      setDrawerOpen,
      setDrawerHeight,
      setDrawerBadge,
      restoreOpenViews,
    }),
    [
      workspaceContext,
      views,
      drawer,
      pendingClose,
      pendingSwitch,
      selectTool,
      selectFunction,
      activateTab,
      requestCloseTab,
      confirmCloseTab,
      cancelCloseTab,
      setDirty,
      setBadge,
      requestContextSwitch,
      confirmContextSwitch,
      cancelContextSwitch,
      closeWorkspace,
      openDrawerTab,
      registerDrawerTab,
      closeDrawerTab,
      setDrawerOpen,
      setDrawerHeight,
      setDrawerBadge,
      restoreOpenViews,
    ],
  );

  return <WorkspaceValue.Provider value={value}>{children}</WorkspaceValue.Provider>;
}
