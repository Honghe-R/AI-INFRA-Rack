import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_UI_CONTEXT,
  createUiContext,
  isRegionVisible,
  loadAppearance,
  loadLayout,
  resolveColorScheme,
  resolveResponsive,
  saveAppearance,
  saveLayout,
  uiActions,
  uiContextReducer,
} from '../state/ui-context.js';
import { createWorkspaceContext } from '../state/workspace-context.js';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
  };
}

const CONTEXT = createWorkspaceContext({ projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-1' });

test('defaults match the shared context shape', () => {
  const context = createUiContext();
  assert.equal(context.colorScheme, 'SYSTEM');
  assert.equal(context.layout.sidebarMode, 'EXPANDED');
  assert.equal(context.layout.bottomDrawerOpen, false);
  // `projectContextBar` was a visibility field for a region that no longer exists; the
  // bar was removed from every view, so the field went with it rather than lingering as a
  // switch that governs nothing.
  assert.equal('projectContextBar' in context.visibility, false);
  assert.equal(context.interaction.confirmContextSwitch, true);
  assert.deepEqual(Object.keys(DEFAULT_UI_CONTEXT).sort(), ['colorScheme', 'contrastMode', 'density', 'interaction', 'layout', 'locale', 'motion', 'visibility']);
});

test('appearance actions validate their enum values', () => {
  const state = createUiContext();
  assert.equal(uiContextReducer(state, uiActions.setColorScheme('DARK')).colorScheme, 'DARK');
  assert.throws(() => uiContextReducer(state, uiActions.setDensity('HUGE')), /Unknown density/);
  assert.throws(() => uiContextReducer(state, uiActions.setSidebarMode('WIDE')), /Unknown sidebarMode/);
});

test('resizing clamps to the configured bounds', () => {
  const state = createUiContext();
  assert.equal(uiContextReducer(state, uiActions.setSidebarWidth(50)).layout.sidebarWidthPx, 200);
  assert.equal(uiContextReducer(state, uiActions.setSidebarWidth(9999)).layout.sidebarWidthPx, 420);
  assert.equal(uiContextReducer(state, uiActions.setBottomDrawerHeight(10)).layout.bottomDrawerHeightPx, 120);
  assert.equal(uiContextReducer(state, uiActions.setBottomDrawerHeight(9999)).layout.bottomDrawerHeightPx, 480);
  assert.equal(uiContextReducer(state, uiActions.setSidebarWidth('abc')).layout.sidebarWidthPx, 200);
});

test('protected regions cannot be hidden', () => {
  const state = createUiContext();
  assert.throws(() => uiContextReducer(state, uiActions.setVisibility('statusBadges', false)), /cannot be hidden/);
  assert.equal(isRegionVisible(createUiContext({ visibility: { statusBadges: false } }), 'statusBadges'), true);
});

test('ordinary regions can be hidden', () => {
  const state = uiContextReducer(createUiContext(), uiActions.setVisibility('tooltips', false));
  assert.equal(state.visibility.tooltips, false);
  assert.equal(state.visibility.openViewTabs, true);
});

test('focus mode collapses nonessential regions but keeps status', () => {
  let state = createUiContext({ layout: { bottomDrawerOpen: true, assistantOpen: true } });
  state = uiContextReducer(state, uiActions.setMainViewMode('FOCUS'));

  assert.equal(state.layout.mainViewMode, 'FOCUS');
  assert.equal(state.layout.bottomDrawerOpen, false);
  assert.equal(state.layout.assistantOpen, false);
  assert.equal(state.layout.sidebarMode, 'MINIATURE', 'navigation stays reachable');
  assert.equal(state.visibility.statusBadges, true, 'error status is never suppressed');
});

test('leaving focus restores the previous layout', () => {
  let state = createUiContext({ layout: { sidebarMode: 'EXPANDED', bottomDrawerOpen: true, assistantOpen: true } });
  state = uiContextReducer(state, uiActions.setMainViewMode('FOCUS'));
  state = uiContextReducer(state, uiActions.setMainViewMode('DEFAULT'));

  assert.equal(state.layout.mainViewMode, 'DEFAULT');
  assert.equal(state.layout.bottomDrawerOpen, true);
  assert.equal(state.layout.assistantOpen, true);
  assert.equal('preFocusLayout' in state, false);
});

test('responsive overrides are resolved after user preference', () => {
  const preference = createUiContext({ layout: { sidebarMode: 'EXPANDED', sidebarPinned: true } });

  const desktop = resolveResponsive(preference, { widthPx: 1600 });
  assert.equal(desktop.breakpoint, 'desktop');
  assert.equal(desktop.sidebar, 'EXPANDED');
  assert.equal(desktop.tabs, 'STRIP');
  assert.equal(desktop.bottomDrawer, 'PANEL');

  const tablet = resolveResponsive(preference, { widthPx: 900 });
  assert.equal(tablet.breakpoint, 'tablet');
  assert.equal(tablet.sidebar, 'MINIATURE', 'a preference does not survive a narrow viewport');
  assert.equal(tablet.sidebarPinned, false);
  assert.equal(tablet.tabs, 'SCROLL');

  const mobile = resolveResponsive(preference, { widthPx: 480 });
  assert.equal(mobile.sidebar, 'DRAWER');
  assert.equal(mobile.bottomDrawer, 'SHEET');
  assert.equal(mobile.assistant, 'SHEET');
});

test('hover expansion is an enhancement that touch disables', () => {
  const preference = createUiContext({ layout: { sidebarMode: 'MINIATURE' } });
  assert.equal(resolveResponsive(preference, { widthPx: 1600 }).hoverExpand, true);
  assert.equal(resolveResponsive(preference, { widthPx: 1600, touch: true }).hoverExpand, false);
  assert.equal(resolveResponsive(preference, { widthPx: 480 }).hoverExpand, false);
});

test('appearance persists per user and layout per workspace context', () => {
  const storage = fakeStorage();
  const context = createUiContext({ colorScheme: 'DARK', density: 'COMPACT', layout: { sidebarMode: 'MINIATURE' } });

  assert.equal(saveAppearance(storage, context), true);
  const appearance = loadAppearance(storage);
  assert.equal(appearance.colorScheme, 'DARK');
  assert.equal(appearance.density, 'COMPACT');
  assert.equal(appearance.layout.sidebarMode, 'MINIATURE');

  assert.equal(saveLayout(storage, CONTEXT, createUiContext({ layout: { bottomDrawerOpen: true, bottomDrawerHeightPx: 300 } })), true);
  assert.equal(loadLayout(storage, CONTEXT).layout.bottomDrawerOpen, true);
  assert.equal(loadLayout(storage, CONTEXT).layout.bottomDrawerHeightPx, 300);

  const otherContext = createWorkspaceContext({ projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-2' });
  assert.equal(loadLayout(storage, otherContext).layout.bottomDrawerOpen, false, 'layout is not shared across revisions');
});

test('a corrupt or unavailable store falls back to defaults', () => {
  const corrupt = fakeStorage({ 'ai-infra.ui.appearance.v1': '{not json' });
  assert.equal(loadAppearance(corrupt).colorScheme, 'SYSTEM');

  const broken = {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('quota exceeded');
    },
  };
  assert.equal(loadAppearance(broken).colorScheme, 'SYSTEM');
  assert.equal(saveAppearance(broken, createUiContext()), false);
});

test('SYSTEM resolves to the scheme the operating system is set to', () => {
  // `SYSTEM` is a preference, not a scheme. Without this the default preference
  // rendered light on every machine, including one asking for dark.
  assert.equal(resolveColorScheme('SYSTEM', true), 'DARK');
  assert.equal(resolveColorScheme('SYSTEM', false), 'LIGHT');
});

test('an explicit scheme wins over the operating system', () => {
  assert.equal(resolveColorScheme('DARK', false), 'DARK');
  assert.equal(resolveColorScheme('LIGHT', true), 'LIGHT');
});

test('an unknown scheme falls back to light rather than throwing', () => {
  assert.equal(resolveColorScheme('NEON', true), 'LIGHT');
  assert.equal(resolveColorScheme(undefined, true), 'LIGHT');
});
