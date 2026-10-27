import { test } from 'vitest';
import assert from 'node:assert/strict';
import { openProjectInWorkspace, resolveOpenTarget } from '../projects/open-project.js';

const PROJECT = { projectId: 'project-1', name: 'Northern DC Campus' };

function scenario(overrides = {}) {
  return {
    scenarioId: 'scenario-1',
    name: 'Baseline',
    activeRevision: { revisionId: 'revision-1', lifecycleState: 'DRAFT', name: 'Draft 1' },
    ...overrides,
  };
}

/** Records how the workspace was entered. */
function fakeWorkspace() {
  const calls = [];
  return {
    calls,
    requestContextSwitch(...args) {
      calls.push(args);
      return true;
    },
  };
}

test('a scenario with an active revision becomes the workspace context', () => {
  const result = resolveOpenTarget(PROJECT, [scenario()]);

  assert.equal(result.ok, true);
  assert.equal(result.context.projectId, 'project-1');
  assert.equal(result.context.projectName, 'Northern DC Campus');
  assert.equal(result.context.scenarioId, 'scenario-1');
  assert.equal(result.context.revisionId, 'revision-1');
  assert.equal(result.context.lifecycleState, 'DRAFT');
});

test('a project with no scenario says so instead of doing nothing', () => {
  const result = resolveOpenTarget(PROJECT, []);

  assert.equal(result.ok, false);
  assert.match(result.notice, /has no scenario yet/);
  assert.match(result.notice, /Northern DC Campus/);
});

test('a scenario with no revision says so', () => {
  const result = resolveOpenTarget(PROJECT, [scenario({ activeRevision: null })]);

  assert.equal(result.ok, false);
  assert.match(result.notice, /has no revision yet/);
});

test('a later openable scenario is used when the first has no revision', () => {
  const result = resolveOpenTarget(PROJECT, [
    scenario({ scenarioId: 'scenario-empty', activeRevision: null }),
    scenario({ scenarioId: 'scenario-ready' }),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.context.scenarioId, 'scenario-ready');
});

test('an unusable revision state is reported, not thrown at the click handler', () => {
  const result = resolveOpenTarget(PROJECT, [
    scenario({ activeRevision: { revisionId: 'revision-9', lifecycleState: 'RETIRED' } }),
  ]);

  assert.equal(result.ok, false);
  assert.match(result.notice, /could not be opened/);
});

test('a project without an identifier is refused', () => {
  const result = resolveOpenTarget({ name: 'Nameless' }, [scenario()]);

  assert.equal(result.ok, false);
  assert.match(result.notice, /no identifier/);
});

test('opening a project enters the workspace scoped to its scenario and revision', async () => {
  const workspace = fakeWorkspace();
  const outcome = await openProjectInWorkspace({
    project: PROJECT,
    loadScenarios: async (projectId) => {
      assert.equal(projectId, 'project-1', 'the loader is asked for the clicked project');
      return { data: [scenario()] };
    },
    workspace,
  });

  assert.equal(outcome.ok, true);
  assert.equal(workspace.calls.length, 1);

  const [context, interaction, options] = workspace.calls[0];
  assert.equal(context.projectId, 'project-1');
  assert.equal(context.revisionId, 'revision-1');
  assert.deepEqual(interaction, {});
  // The landing view is opened with the context, because opening a project shows a
  // work surface rather than an empty frame (ui-pattern.md, "Project List Entry").
  assert.equal(options.landingToolId, 'site_facility');
});

test('the landing view obeys the same visibility rule as the sidebar', async () => {
  const workspace = fakeWorkspace();
  await openProjectInWorkspace({
    project: PROJECT,
    loadScenarios: async () => ({ data: [scenario()] }),
    keys: ['project.read'],
    workspace,
  });

  // Without facility.read the user may not open Site & Facility, so no landing tab
  // is opened and the shell shows the project overview instead of a hidden view.
  assert.equal(workspace.calls[0][2].landingToolId, null);
});

test('a failed scenario read is surfaced as an error and enters nothing', async () => {
  const workspace = fakeWorkspace();
  const failure = Object.assign(new Error('boom'), { code: 'INTERNAL_ERROR' });

  const outcome = await openProjectInWorkspace({
    project: PROJECT,
    loadScenarios: async () => {
      throw failure;
    },
    workspace,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, failure);
  assert.equal(workspace.calls.length, 0, 'the workspace is not entered on a failed read');
});

test('a refused context switch is still reported as an attempted entry', async () => {
  const calls = [];
  const workspace = {
    requestContextSwitch(...args) {
      calls.push(args);
      return false;
    },
  };

  const outcome = await openProjectInWorkspace({
    project: PROJECT,
    loadScenarios: async () => ({ data: [scenario()] }),
    workspace,
  });

  // A dirty tab makes the store ask for confirmation instead of switching; the
  // request is the shell's job, and the store owns the prompt.
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
});

test('a missing loader or workspace is reported rather than crashing the list', async () => {
  assert.equal((await openProjectInWorkspace({ project: PROJECT, workspace: fakeWorkspace() })).ok, false);
  assert.equal(
    (await openProjectInWorkspace({ project: PROJECT, loadScenarios: async () => ({ data: [] }) })).ok,
    false,
  );
});
