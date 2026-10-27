import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  activeFunctionId,
  activeTab,
  createOpenViewsState,
  hasDirtyTabs,
  openViewsReducer,
  tabForTool,
} from '../state/open-views.js';
import { createWorkspaceContext } from '../state/workspace-context.js';

const CONTEXT = createWorkspaceContext({ projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-1' });
const OTHER_REVISION = createWorkspaceContext({ projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-2' });

function open(state, toolId, overrides = {}) {
  return openViewsReducer(state, {
    type: 'OPEN',
    tabId: overrides.tabId ?? `tab-${toolId}`,
    toolId,
    workspaceContext: overrides.workspaceContext ?? CONTEXT,
    routeState: overrides.routeState,
  });
}

test('opening a tool creates exactly one tab and activates it', () => {
  let state = createOpenViewsState();
  state = open(state, 'site_facility');

  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeTabId, 'tab-site_facility');
  assert.equal(activeTab(state).toolId, 'site_facility');
});

test('the same tool in the same context never gets a second tab', () => {
  let state = open(createOpenViewsState(), 'site_facility');
  state = openViewsReducer(state, {
    type: 'OPEN',
    tabId: 'tab-duplicate',
    toolId: 'site_facility',
    workspaceContext: CONTEXT,
    routeState: { functionId: 'capacity' },
  });

  assert.equal(state.tabs.length, 1, 'opening an existing view activates it');
  assert.equal(state.activeTabId, 'tab-site_facility');
  assert.equal(activeTab(state).routeState.functionId, 'capacity', 'the requested function is applied');
});

test('the same tool in a different revision is a different tab', () => {
  let state = open(createOpenViewsState(), 'site_facility');
  state = open(state, 'site_facility', { tabId: 'tab-other', workspaceContext: OTHER_REVISION });

  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeTabId, 'tab-other');
});

test('inner-function navigation updates route state without adding a tab', () => {
  let state = open(createOpenViewsState(), 'site_facility');
  state = openViewsReducer(state, { type: 'SET_ROUTE_STATE', routeState: { functionId: 'utilities' } });

  assert.equal(state.tabs.length, 1);
  assert.equal(activeTab(state).routeState.functionId, 'utilities');
  assert.equal(activeFunctionId(state), 'utilities');
});

test('an unknown inner function falls back to the tool default', () => {
  let state = open(createOpenViewsState(), 'site_facility');
  state = openViewsReducer(state, { type: 'SET_ROUTE_STATE', routeState: { functionId: 'nope' } });
  assert.equal(activeFunctionId(state), 'overview');
});

test('closing the active tab activates the most recently used remaining tab', () => {
  let state = createOpenViewsState();
  state = open(state, 'site_facility');
  state = open(state, 'floorplan', { tabId: 'tab-floorplan' });
  state = open(state, 'verify', { tabId: 'tab-verify' });

  state = openViewsReducer(state, { type: 'CLOSE', tabId: 'tab-verify' });
  assert.equal(state.activeTabId, 'tab-floorplan', 'falls back to the previously used tab');

  state = openViewsReducer(state, { type: 'CLOSE', tabId: 'tab-floorplan' });
  assert.equal(state.activeTabId, 'tab-site_facility');
});

test('closing the last tab returns the workspace to its overview', () => {
  let state = open(createOpenViewsState(), 'site_facility');
  state = openViewsReducer(state, { type: 'CLOSE', tabId: 'tab-site_facility' });

  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, null);
  assert.equal(activeTab(state), null);
});

test('a dirty tab is not closed without force', () => {
  let state = open(createOpenViewsState(), 'site_facility');
  state = openViewsReducer(state, { type: 'SET_DIRTY', tabId: 'tab-site_facility', dirty: true, reason: 'unsaved geometry' });
  assert.equal(hasDirtyTabs(state), true);

  const refused = openViewsReducer(state, { type: 'CLOSE', tabId: 'tab-site_facility' });
  assert.equal(refused.tabs.length, 1, 'unsaved work is never discarded silently');

  const forced = openViewsReducer(state, { type: 'CLOSE', tabId: 'tab-site_facility', force: true });
  assert.equal(forced.tabs.length, 0);
});

test('activating an unknown or missing tab is a no-op', () => {
  const state = open(createOpenViewsState(), 'site_facility');
  assert.equal(openViewsReducer(state, { type: 'ACTIVATE', tabId: 'nope' }), state);
  assert.equal(openViewsReducer(state, { type: 'ACTIVATE', tabId: null }), state);
});

test('restoring drops tabs from an incompatible revision', () => {
  const persisted = [
    { tabId: 'keep', toolId: 'site_facility', workspaceContext: CONTEXT, routeState: { functionId: 'capacity' }, dirtyState: { dirty: false } },
    { tabId: 'stale', toolId: 'floorplan', workspaceContext: OTHER_REVISION, routeState: {}, dirtyState: { dirty: false } },
  ];

  const state = openViewsReducer(createOpenViewsState(), {
    type: 'RESTORE',
    tabs: persisted,
    activeTabId: 'stale',
    workspaceContext: CONTEXT,
  });

  assert.deepEqual(state.tabs.map((tab) => tab.tabId), ['keep'], 'a stale tab is dropped, not repointed');
  assert.equal(state.activeTabId, 'keep', 'the active tab is re-chosen when the persisted one is gone');
});

test('tabs and badges are addressable per tool and context', () => {
  let state = open(createOpenViewsState(), 'site_facility');
  state = openViewsReducer(state, { type: 'SET_BADGE', tabId: 'tab-site_facility', badge: { errors: 2, warnings: 1 } });

  assert.deepEqual(tabForTool(state, 'site_facility', CONTEXT).badge, { errors: 2, warnings: 1 });
  assert.equal(tabForTool(state, 'site_facility', OTHER_REVISION), null, 'a badge never leaks across revisions');
});

test('RESET returns an empty workspace', () => {
  const state = open(createOpenViewsState(), 'site_facility');
  assert.deepEqual(openViewsReducer(state, { type: 'RESET' }), createOpenViewsState());
});

test('reporting the same dirtiness twice is not a state change', () => {
  // A surface reports its dirtiness from an effect, and the shell's callback identity
  // changes on every render. If an identical report produced new state, the effect would
  // dispatch, re-render, and dispatch again — an unbounded loop rather than a redundant
  // update. This is the guard that makes the loop impossible rather than unlikely.
  let state = open(createOpenViewsState(), 'site_facility');
  state = openViewsReducer(state, { type: 'SET_DIRTY', tabId: 'tab-site_facility', dirty: true, reason: 'uncommitted changes.' });

  const again = openViewsReducer(state, { type: 'SET_DIRTY', tabId: 'tab-site_facility', dirty: true, reason: 'uncommitted changes.' });
  assert.equal(again, state, 'the same report returns the identical state object');

  const cleared = openViewsReducer(state, { type: 'SET_DIRTY', tabId: 'tab-site_facility', dirty: false });
  assert.notEqual(cleared, state, 'a real change still updates');
  assert.equal(hasDirtyTabs(cleared), false);

  const clearedAgain = openViewsReducer(cleared, { type: 'SET_DIRTY', tabId: 'tab-site_facility', dirty: false });
  assert.equal(clearedAgain, cleared, 'and clearing twice is also a no-op');
  assert.equal(hasDirtyTabs(clearedAgain), false);
});

test('dirtiness reported for a tab that is gone is ignored', () => {
  const state = createOpenViewsState();
  assert.equal(openViewsReducer(state, { type: 'SET_DIRTY', tabId: 'missing', dirty: true }), state);
});
