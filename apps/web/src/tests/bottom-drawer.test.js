import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DRAWER_DEFAULT_PX,
  GLOBAL_DRAWER_TABS,
  activeDrawerTab,
  bottomDrawerReducer,
  createBottomDrawerState,
  drawerActions,
  drawerBadge,
  shouldOpenByDefault,
} from '../state/bottom-drawer.js';
import { createWorkspaceContext } from '../state/workspace-context.js';

const CONTEXT = createWorkspaceContext({ projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-1' });
const OTHER_REVISION = createWorkspaceContext({ projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-2' });

test('the default drawer carries the five global tabs and starts collapsed', () => {
  const state = createBottomDrawerState();
  assert.deepEqual(state.tabs.map((tab) => tab.tabId), ['findings', 'activity', 'jobs', 'dependencies', 'logs']);
  assert.equal(state.open, false);
  assert.equal(state.heightPx, DRAWER_DEFAULT_PX);
  assert.equal(state.activeTabId, 'findings');
  for (const tab of state.tabs) assert.equal(tab.closeable, false, 'global tabs remain available');
});

test('open, close, and toggle', () => {
  const closed = createBottomDrawerState();
  const opened = bottomDrawerReducer(closed, drawerActions.open());

  assert.equal(opened.open, true);
  assert.equal(bottomDrawerReducer(opened, drawerActions.close()).open, false);
  assert.equal(bottomDrawerReducer(closed, drawerActions.toggle()).open, true);
  assert.equal(bottomDrawerReducer(opened, drawerActions.toggle()).open, false, 'toggle reflects the current state');
});

test('selecting a tab expands the drawer and ignores unknown tabs', () => {
  const state = createBottomDrawerState();
  const selected = bottomDrawerReducer(state, drawerActions.selectTab('jobs'));
  assert.equal(selected.activeTabId, 'jobs');
  assert.equal(selected.open, true, 'selecting a tab is an explicit user action');
  assert.equal(activeDrawerTab(selected).label, 'Jobs');

  assert.equal(bottomDrawerReducer(state, drawerActions.selectTab('nope')), state);
});

test('height is clamped to the configured range', () => {
  const state = createBottomDrawerState();
  assert.equal(bottomDrawerReducer(state, drawerActions.setHeight(10)).heightPx, 120);
  assert.equal(bottomDrawerReducer(state, drawerActions.setHeight(9999)).heightPx, 480);
  assert.equal(bottomDrawerReducer(state, drawerActions.setHeight('abc')).heightPx, DRAWER_DEFAULT_PX);
});

test('a contextual tab registers, updates in place, and requires a context', () => {
  let state = createBottomDrawerState();
  state = bottomDrawerReducer(
    state,
    drawerActions.registerContextual({ tabId: 'import_mapping', kind: 'CONTEXTUAL', label: 'Import Mapping', toolId: 'site_facility', workspaceContext: CONTEXT }),
  );
  assert.equal(state.tabs.length, GLOBAL_DRAWER_TABS.length + 1);

  state = bottomDrawerReducer(
    state,
    drawerActions.registerContextual({ tabId: 'import_mapping', kind: 'CONTEXTUAL', label: 'Import Mapping (reviewed)', toolId: 'site_facility', workspaceContext: CONTEXT }),
  );
  assert.equal(state.tabs.length, GLOBAL_DRAWER_TABS.length + 1, 'registering an existing tab updates it');
  assert.equal(state.tabs.at(-1).label, 'Import Mapping (reviewed)');

  assert.throws(() => bottomDrawerReducer(state, drawerActions.registerContextual({ tabId: 'x', kind: 'GLOBAL' })), /Only contextual tabs/);
  assert.throws(
    () => bottomDrawerReducer(state, drawerActions.registerContextual({ tabId: 'y', kind: 'CONTEXTUAL' })),
    /workspace context/,
  );
});

test('only contextual tabs can be closed, and closing one keeps the global set', () => {
  let state = createBottomDrawerReducerWithContextual();
  assert.equal(bottomDrawerReducer(state, drawerActions.closeTab('findings')), state, 'a global tab is not closeable');

  state = bottomDrawerReducer(state, drawerActions.closeTab('import_mapping'));
  assert.deepEqual(state.tabs.map((tab) => tab.tabId), GLOBAL_DRAWER_TABS.map((tab) => tab.tabId));
  assert.equal(state.activeTabId, 'findings', 'the active tab falls back when the contextual tab closes');
});

test('a contextual tab from another revision is dropped, not repointed', () => {
  let state = createBottomDrawerReducerWithContextual();
  state = bottomDrawerReducer(state, drawerActions.selectTab('import_mapping'));
  assert.equal(state.activeTabId, 'import_mapping');

  const dropped = bottomDrawerReducer(state, drawerActions.dropStale(OTHER_REVISION));
  assert.deepEqual(dropped.tabs.map((tab) => tab.tabId), GLOBAL_DRAWER_TABS.map((tab) => tab.tabId));
  assert.equal(dropped.activeTabId, 'findings');

  assert.equal(bottomDrawerReducer(dropped, drawerActions.dropStale(OTHER_REVISION)), dropped, 'nothing stale left to drop');
});

test('badges aggregate unread counts and the worst severity', () => {
  let state = createBottomDrawerState();
  assert.deepEqual(drawerBadge(state), { unreadCount: 0, severity: 'NONE' });
  assert.equal(shouldOpenByDefault(state), false, 'an empty drawer stays collapsed');

  state = bottomDrawerReducer(state, drawerActions.setBadge('findings', { unreadCount: 3, severity: 'WARNING' }));
  state = bottomDrawerReducer(state, drawerActions.setBadge('jobs', { unreadCount: 1, severity: 'ERROR' }));

  assert.deepEqual(drawerBadge(state), { unreadCount: 4, severity: 'ERROR' });
  assert.equal(shouldOpenByDefault(state), true);

  assert.throws(() => bottomDrawerReducer(state, drawerActions.setBadge('jobs', { severity: 'LOUD' })), /Unknown severity/);
});

test('a pinned contextual tab opens the drawer by default', () => {
  const state = createBottomDrawerReducerWithContextual();
  assert.equal(shouldOpenByDefault(state), true);
});

function createBottomDrawerReducerWithContextual() {
  return bottomDrawerReducer(
    createBottomDrawerState(),
    drawerActions.registerContextual({
      tabId: 'import_mapping',
      kind: 'CONTEXTUAL',
      label: 'Import Mapping',
      toolId: 'site_facility',
      workspaceContext: CONTEXT,
    }),
  );
}
