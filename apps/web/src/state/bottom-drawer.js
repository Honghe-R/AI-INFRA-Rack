import { isCompatible } from './workspace-context.js';

/**
 * The bottom drawer: a shell-level workspace for information that spans tools.
 *
 * It is not a tool panel and does not replace the open-view tab set. The shell
 * owns the frame, tab ordering, active tab, and persistence; a tab provider owns
 * only its content (ui-pattern.md, "Bottom Drawer").
 */

export const DRAWER_MIN_PX = 120;
export const DRAWER_MAX_PX = 480;
export const DRAWER_DEFAULT_PX = 240;

export const SEVERITIES = Object.freeze(['NONE', 'INFO', 'WARNING', 'ERROR']);

function globalTab(tabId, label) {
  return Object.freeze({
    tabId,
    kind: 'GLOBAL',
    label,
    icon: null,
    toolId: null,
    workspaceContext: null,
    entityRefs: Object.freeze([]),
    jobId: null,
    closeable: false,
    unreadCount: 0,
    severity: 'NONE',
    routeState: null,
  });
}

export const GLOBAL_DRAWER_TABS = Object.freeze([
  globalTab('findings', 'Findings'),
  globalTab('activity', 'Activity'),
  globalTab('jobs', 'Jobs'),
  globalTab('dependencies', 'Dependencies'),
  globalTab('logs', 'Logs'),
]);

export function createBottomDrawerState() {
  return {
    open: false,
    heightPx: DRAWER_DEFAULT_PX,
    activeTabId: GLOBAL_DRAWER_TABS[0].tabId,
    tabs: [...GLOBAL_DRAWER_TABS],
  };
}

export const drawerActions = {
  open: () => ({ type: 'OPEN' }),
  close: () => ({ type: 'CLOSE' }),
  toggle: () => ({ type: 'TOGGLE' }),
  selectTab: (tabId) => ({ type: 'SELECT_TAB', tabId }),
  setHeight: (heightPx) => ({ type: 'SET_HEIGHT', heightPx }),
  registerContextual: (tab) => ({ type: 'REGISTER_CONTEXTUAL', tab }),
  closeTab: (tabId) => ({ type: 'CLOSE_TAB', tabId }),
  setBadge: (tabId, { unreadCount, severity }) => ({ type: 'SET_BADGE', tabId, unreadCount, severity }),
  dropStale: (workspaceContext) => ({ type: 'DROP_STALE', workspaceContext }),
};

export function bottomDrawerReducer(state, action) {
  switch (action.type) {
    case 'OPEN':
      return { ...state, open: true };
    case 'CLOSE':
      return { ...state, open: false };
    case 'TOGGLE':
      return { ...state, open: !state.open };

    case 'SELECT_TAB': {
      if (!state.tabs.some((tab) => tab.tabId === action.tabId)) return state;
      // Selecting a tab expands the drawer; it is an explicit user action.
      return { ...state, activeTabId: action.tabId, open: true };
    }

    case 'SET_HEIGHT':
      return { ...state, heightPx: clamp(action.heightPx) };

    case 'REGISTER_CONTEXTUAL': {
      const tab = normaliseContextual(action.tab);
      const existing = state.tabs.find((item) => item.tabId === tab.tabId);
      const tabs = existing
        ? state.tabs.map((item) => (item.tabId === tab.tabId ? { ...item, ...tab } : item))
        : [...state.tabs, tab];
      return { ...state, tabs };
    }

    case 'CLOSE_TAB': {
      const tab = state.tabs.find((item) => item.tabId === action.tabId);
      // Global tabs remain available; only contextual tabs may be closed, and
      // closing one does not delete the finding, job, or log behind it.
      if (!tab || !tab.closeable) return state;

      const tabs = state.tabs.filter((item) => item.tabId !== action.tabId);
      const activeTabId = state.activeTabId === action.tabId ? (tabs[0]?.tabId ?? null) : state.activeTabId;
      return { ...state, tabs, activeTabId };
    }

    case 'SET_BADGE': {
      if (!SEVERITIES.includes(action.severity ?? 'NONE')) throw new Error(`Unknown severity "${action.severity}".`);
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.tabId === action.tabId
            ? { ...tab, unreadCount: Math.max(0, action.unreadCount ?? tab.unreadCount), severity: action.severity ?? tab.severity }
            : tab,
        ),
      };
    }

    case 'DROP_STALE': {
      // Contextual tabs are scoped to a workspace context; an incompatible
      // revision marks them stale rather than showing another revision's data.
      const tabs = state.tabs.filter(
        (tab) => tab.kind === 'GLOBAL' || isCompatible(tab.workspaceContext, action.workspaceContext),
      );
      if (tabs.length === state.tabs.length) return state;
      const activeTabId = tabs.some((tab) => tab.tabId === state.activeTabId) ? state.activeTabId : (tabs[0]?.tabId ?? null);
      return { ...state, tabs, activeTabId };
    }

    default:
      return state;
  }
}

function normaliseContextual(tab) {
  if (!tab?.tabId) throw new Error('A contextual drawer tab requires a tab_id.');
  if (tab.kind !== 'CONTEXTUAL') throw new Error('Only contextual tabs may be registered.');
  if (!tab.workspaceContext) throw new Error('A contextual drawer tab requires a workspace context.');
  return {
    tabId: tab.tabId,
    kind: 'CONTEXTUAL',
    label: tab.label ?? tab.tabId,
    icon: tab.icon ?? null,
    toolId: tab.toolId ?? null,
    workspaceContext: tab.workspaceContext,
    entityRefs: tab.entityRefs ?? [],
    jobId: tab.jobId ?? null,
    closeable: tab.closeable !== false,
    unreadCount: tab.unreadCount ?? 0,
    severity: SEVERITIES.includes(tab.severity) ? tab.severity : 'NONE',
    routeState: tab.routeState ?? null,
  };
}

function clamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DRAWER_DEFAULT_PX;
  return Math.min(Math.max(Math.round(numeric), DRAWER_MIN_PX), DRAWER_MAX_PX);
}

// --- selectors --------------------------------------------------------------

export function activeDrawerTab(state) {
  return state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? null;
}

/**
 * The drawer is collapsed by default unless something is waiting for attention:
 * unread findings, an active job, or a pinned contextual tab.
 */
export function shouldOpenByDefault(state) {
  return state.tabs.some(
    (tab) => tab.unreadCount > 0 || tab.severity === 'WARNING' || tab.severity === 'ERROR' || tab.kind === 'CONTEXTUAL',
  );
}

export function drawerBadge(state) {
  const unread = state.tabs.reduce((total, tab) => total + (tab.unreadCount ?? 0), 0);
  const worst = state.tabs.reduce(
    (level, tab) => Math.max(level, SEVERITIES.indexOf(tab.severity ?? 'NONE')),
    SEVERITIES.indexOf('NONE'),
  );
  return { unreadCount: unread, severity: SEVERITIES[worst] };
}
