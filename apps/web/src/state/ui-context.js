import { contextKey } from './workspace-context.js';

/**
 * UI Context: presentation state only.
 *
 * It must never hold authoritative project entities, authorization decisions,
 * revision data, validation results, or unsaved mutations (ui-pattern.md,
 * "UI Context"). Appearance is per user, layout is per user and workspace
 * context.
 *
 * Two invariants are enforced in the reducer rather than trusted to callers:
 *  * the project context bar cannot be hidden by a stored preference, in any
 *    mode — a surface may render that context itself instead, which the shell
 *    decides from what is mounted, never from this field;
 *  * focus mode may collapse nonessential regions but cannot hide the context
 *    bar, the route back to navigation, or error status.
 */

export const COLOR_SCHEMES = Object.freeze(['SYSTEM', 'LIGHT', 'DARK']);
export const CONTRAST_MODES = Object.freeze(['STANDARD', 'HIGH']);
export const DENSITIES = Object.freeze(['COMPACT', 'COMFORTABLE']);
export const MOTIONS = Object.freeze(['FULL', 'REDUCED']);
export const SIDEBAR_MODES = Object.freeze(['EXPANDED', 'MINIATURE']);
export const MAIN_VIEW_MODES = Object.freeze(['DEFAULT', 'FOCUS']);

/** Regions the shell refuses to hide, whatever a caller asks for. */
export const PROTECTED_VISIBILITY = Object.freeze(['statusBadges']);

export const DEFAULT_UI_CONTEXT = Object.freeze({
  colorScheme: 'SYSTEM',
  contrastMode: 'STANDARD',
  density: 'COMFORTABLE',
  motion: 'FULL',
  locale: 'en',
  layout: Object.freeze({
    sidebarMode: 'EXPANDED',
    sidebarPinned: false,
    sidebarWidthPx: 264,
    bottomDrawerOpen: false,
    bottomDrawerHeightPx: 240,
    mainViewMode: 'DEFAULT',
    assistantOpen: false,
    assistantWidthPx: 720,
  }),
  visibility: Object.freeze({
    sidebar: true,
    openViewTabs: true,
    bottomDrawer: true,
    assistantComposer: true,
    statusBadges: true,
    tooltips: true,
  }),
  interaction: Object.freeze({
    hoverExpandSidebar: true,
    confirmContextSwitch: true,
    restoreOpenViews: true,
    restoreDrawerState: true,
  }),
});

const SIDEBAR_MIN_PX = 200;
const SIDEBAR_MAX_PX = 420;
const DRAWER_MIN_PX = 120;
const DRAWER_MAX_PX = 480;
/* The composer floats over the work surface, so its width is a reading measure rather
   than a layout constraint: narrow enough to leave the canvas visible, wide enough for a
   paragraph and a long message. */
export const ASSISTANT_MIN_PX = 320;
export const ASSISTANT_MAX_PX = 1100;

export function createUiContext(overrides = {}) {
  return {
    ...DEFAULT_UI_CONTEXT,
    ...pick(overrides, ['colorScheme', 'contrastMode', 'density', 'motion', 'locale']),
    layout: { ...DEFAULT_UI_CONTEXT.layout, ...(overrides.layout ?? {}) },
    visibility: { ...DEFAULT_UI_CONTEXT.visibility, ...(overrides.visibility ?? {}) },
    interaction: { ...DEFAULT_UI_CONTEXT.interaction, ...(overrides.interaction ?? {}) },
  };
}

export const uiActions = {
  setColorScheme: (value) => ({ type: 'SET_APPEARANCE', field: 'colorScheme', value, allowed: COLOR_SCHEMES }),
  setContrastMode: (value) => ({ type: 'SET_APPEARANCE', field: 'contrastMode', value, allowed: CONTRAST_MODES }),
  setDensity: (value) => ({ type: 'SET_APPEARANCE', field: 'density', value, allowed: DENSITIES }),
  setMotion: (value) => ({ type: 'SET_APPEARANCE', field: 'motion', value, allowed: MOTIONS }),
  setLocale: (value) => ({ type: 'SET_APPEARANCE', field: 'locale', value, allowed: null }),
  setSidebarMode: (value) => ({ type: 'SET_LAYOUT', field: 'sidebarMode', value, allowed: SIDEBAR_MODES }),
  setSidebarPinned: (value) => ({ type: 'SET_LAYOUT', field: 'sidebarPinned', value: value === true }),
  setSidebarWidth: (value) => ({ type: 'SET_SIDEBAR_WIDTH', value }),
  setBottomDrawerOpen: (value) => ({ type: 'SET_LAYOUT', field: 'bottomDrawerOpen', value: value === true }),
  setBottomDrawerHeight: (value) => ({ type: 'SET_DRAWER_HEIGHT', value }),
  setAssistantWidth: (value) => ({ type: 'SET_ASSISTANT_WIDTH', value }),
  setMainViewMode: (value) => ({ type: 'SET_MAIN_VIEW_MODE', value }),
  setAssistantOpen: (value) => ({ type: 'SET_LAYOUT', field: 'assistantOpen', value: value === true }),
  setVisibility: (field, value) => ({ type: 'SET_VISIBILITY', field, value: value === true }),
  setInteraction: (field, value) => ({ type: 'SET_INTERACTION', field, value: value === true }),
};

export function uiContextReducer(state, action) {
  switch (action.type) {
    case 'SET_APPEARANCE': {
      if (action.allowed && !action.allowed.includes(action.value)) {
        throw new Error(`Unknown ${action.field} value "${action.value}".`);
      }
      return { ...state, [action.field]: action.value };
    }

    case 'SET_LAYOUT': {
      if (action.allowed && !action.allowed.includes(action.value)) {
        throw new Error(`Unknown ${action.field} value "${action.value}".`);
      }
      return { ...state, layout: { ...state.layout, [action.field]: action.value } };
    }

    case 'SET_SIDEBAR_WIDTH':
      return { ...state, layout: { ...state.layout, sidebarWidthPx: clamp(action.value, SIDEBAR_MIN_PX, SIDEBAR_MAX_PX) } };

    case 'SET_DRAWER_HEIGHT':
      return { ...state, layout: { ...state.layout, bottomDrawerHeightPx: clamp(action.value, DRAWER_MIN_PX, DRAWER_MAX_PX) } };

    case 'SET_ASSISTANT_WIDTH':
      return { ...state, layout: { ...state.layout, assistantWidthPx: clamp(action.value, ASSISTANT_MIN_PX, ASSISTANT_MAX_PX) } };

    case 'SET_VISIBILITY': {
      if (PROTECTED_VISIBILITY.includes(action.field)) {
        throw new Error(`The "${action.field}" region cannot be hidden.`);
      }
      return { ...state, visibility: { ...state.visibility, [action.field]: action.value } };
    }

    case 'SET_INTERACTION':
      return { ...state, interaction: { ...state.interaction, [action.field]: action.value } };

    case 'SET_MAIN_VIEW_MODE':
      return setMainViewMode(state, action.value);

    case 'RESTORE':
      // Hydration from persisted state. Only known fields survive, so a stale
      // stored payload cannot inject an unknown preference.
      return createUiContext(action.context ?? {});

    default:
      return state;
  }
}

/**
 * Focus mode collapses nonessential regions and restores the previous layout on
 * exit. It never hides the project context bar, the route back to navigation
 * (the sidebar stays, miniature), or error status (badges stay).
 */
function setMainViewMode(state, value) {
  if (!MAIN_VIEW_MODES.includes(value)) throw new Error(`Unknown main view mode "${value}".`);
  if (value === state.layout.mainViewMode) return state;

  if (value === 'FOCUS') {
    return {
      ...state,
      preFocusLayout: state.layout,
      layout: {
        ...state.layout,
        mainViewMode: 'FOCUS',
        bottomDrawerOpen: false,
        assistantOpen: false,
        sidebarMode: 'MINIATURE',
      },
    };
  }

  const { preFocusLayout, ...rest } = state;
  return {
    ...rest,
    layout: {
      ...(preFocusLayout ?? state.layout),
      mainViewMode: 'DEFAULT',
      sidebarMode: state.layout.sidebarMode,
    },
  };
}

export const BREAKPOINTS = Object.freeze({ tablet: 768, desktop: 1280 });

/**
 * Resolves the effective presentation after applying user preference
 * (ui-pattern.md, "Update Rules" 3): a preference of EXPANDED still becomes
 * MINIATURE on a tablet and an overlay drawer on a phone.
 */
/**
 * The colour scheme actually rendered.
 *
 * `SYSTEM` is a preference, not a scheme: it means "whatever the operating system
 * is set to". Resolving it here keeps one dark token block in the stylesheet and
 * makes the default preference mean what it says.
 */
export function resolveColorScheme(preference, prefersDark = false) {
  if (preference === 'SYSTEM') return prefersDark ? 'DARK' : 'LIGHT';
  return COLOR_SCHEMES.includes(preference) ? preference : 'LIGHT';
}

export function resolveResponsive(context, { widthPx = 1440, touch = false } = {}) {
  const breakpoint = widthPx >= BREAKPOINTS.desktop ? 'desktop' : widthPx >= BREAKPOINTS.tablet ? 'tablet' : 'mobile';

  const sidebar =
    breakpoint === 'desktop' ? context.layout.sidebarMode : breakpoint === 'tablet' ? 'MINIATURE' : 'DRAWER';

  return {
    breakpoint,
    sidebar,
    sidebarPinned: breakpoint === 'desktop' && context.layout.sidebarPinned,
    tabs: breakpoint === 'desktop' ? 'STRIP' : 'SCROLL',
    bottomDrawer: breakpoint === 'desktop' ? 'PANEL' : 'SHEET',
    assistant: breakpoint === 'mobile' ? 'SHEET' : 'FLOATING',
    density: context.density,
    // Hover is an enhancement only; keyboard and touch must reach the same controls.
    hoverExpand: sidebar === 'MINIATURE' && context.interaction.hoverExpandSidebar && !touch,
  };
}

export function isRegionVisible(context, region) {
  if (PROTECTED_VISIBILITY.includes(region)) return true;
  return context.visibility[region] !== false;
}

// --- persistence ------------------------------------------------------------

const APPEARANCE_KEY = 'ai-infra.ui.appearance.v1';
const LAYOUT_PREFIX = 'ai-infra.ui.layout.v1::';
const APPEARANCE_FIELDS = ['colorScheme', 'contrastMode', 'density', 'motion', 'locale'];

/** Appearance persists per user and device class; layout persists per workspace context. */
export function loadAppearance(storage, fallback = createUiContext()) {
  const stored = readJson(storage, APPEARANCE_KEY);
  if (!stored) return fallback;
  return createUiContext({
    ...pick(stored, APPEARANCE_FIELDS),
    layout: {
      ...fallback.layout,
      ...pick(stored.layout ?? {}, ['sidebarMode', 'sidebarPinned', 'sidebarWidthPx', 'assistantWidthPx']),
    },
    interaction: { ...fallback.interaction, ...(stored.interaction ?? {}) },
  });
}

export function saveAppearance(storage, context) {
  const layout = pick(context.layout, ['sidebarMode', 'sidebarPinned', 'sidebarWidthPx', 'assistantWidthPx']);
  return writeJson(storage, APPEARANCE_KEY, { ...pick(context, APPEARANCE_FIELDS), layout, interaction: { ...context.interaction } });
}

export function loadLayout(storage, context, fallback = createUiContext()) {
  const stored = readJson(storage, `${LAYOUT_PREFIX}${contextKey(context)}`);
  if (!stored) return fallback;
  return { ...fallback, layout: { ...fallback.layout, ...stored } };
}

export function saveLayout(storage, context, uiContext) {
  return writeJson(storage, `${LAYOUT_PREFIX}${contextKey(context)}`, { ...uiContext.layout });
}

function readJson(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // A corrupt or unavailable store falls back to defaults rather than breaking the shell.
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function pick(source, fields) {
  const output = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) output[field] = source[field];
  }
  return output;
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(Math.round(numeric), min), max);
}
