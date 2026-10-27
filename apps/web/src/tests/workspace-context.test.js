import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  contextKey,
  contextSwitchRequiresConfirmation,
  createWorkspaceContext,
  describeContext,
  dirtyTabs,
  isCompatible,
  staleTabs,
} from '../state/workspace-context.js';

const BASE = {
  projectId: 'p-1',
  scenarioId: 's-1',
  revisionId: 'rev-11111111',
  projectName: 'Northern DC',
};

test('a context requires a project, scenario, and revision', () => {
  assert.throws(() => createWorkspaceContext({}), /project id/);
  assert.throws(() => createWorkspaceContext({ ...BASE, scenarioId: null }), /scenario id/);
  assert.throws(() => createWorkspaceContext({ ...BASE, revisionId: null }), /revision id/);
  assert.throws(() => createWorkspaceContext({ ...BASE, lifecycleState: 'NOPE' }), /Unknown lifecycle state/);
});

test('validation summary defaults and is captured', () => {
  const context = createWorkspaceContext(BASE);
  assert.deepEqual(context.validationSummary, { errors: 0, warnings: 0 });
  const withCounts = createWorkspaceContext({ ...BASE, validationSummary: { errors: 2, warnings: 5 } });
  assert.deepEqual(withCounts.validationSummary, { errors: 2, warnings: 5 });
});

test('compatibility is decided by project, scenario, and revision together', () => {
  const active = createWorkspaceContext(BASE);
  assert.equal(contextKey(active), 'p-1|s-1|rev-11111111');
  assert.equal(isCompatible(active, createWorkspaceContext(BASE)), true);

  assert.equal(isCompatible(active, createWorkspaceContext({ ...BASE, revisionId: 'rev-2' })), false, 'a new revision is a new context');
  assert.equal(isCompatible(active, createWorkspaceContext({ ...BASE, scenarioId: 's-2' })), false);
  assert.equal(isCompatible(active, createWorkspaceContext({ ...BASE, projectId: 'p-2' })), false);
  assert.equal(isCompatible(active, null), false);
});

test('stale tabs are the ones belonging to another context', () => {
  const active = createWorkspaceContext(BASE);
  const tabs = [
    { tabId: 'a', workspaceContext: active },
    { tabId: 'b', workspaceContext: createWorkspaceContext({ ...BASE, revisionId: 'rev-2' }) },
  ];
  assert.deepEqual(staleTabs(tabs, active).map((tab) => tab.tabId), ['b']);
});

test('switching context asks before discarding unsaved work', () => {
  const clean = [{ tabId: 'a', dirtyState: { dirty: false } }];
  const dirty = [{ tabId: 'a', dirtyState: { dirty: true } }];

  assert.equal(contextSwitchRequiresConfirmation(clean), false);
  assert.equal(contextSwitchRequiresConfirmation(dirty), true);
  assert.equal(contextSwitchRequiresConfirmation(dirty, { confirmContextSwitch: false }), false, 'the user may turn the prompt off');
  assert.deepEqual(dirtyTabs([...clean, ...dirty]).map((tab) => tab.tabId), ['a']);
});

test('the context description names the project and revision', () => {
  assert.equal(describeContext(createWorkspaceContext(BASE)), 'Northern DC · Revision: rev-1111');
});
