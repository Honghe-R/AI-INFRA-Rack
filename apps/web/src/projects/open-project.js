import { createWorkspaceContext } from '../state/workspace-context.js';
import { landingTool } from '../state/tool-registry.js';

/**
 * Choosing the workspace context a project opens into.
 *
 * Opening a project enters its workspace (ui-pattern.md, "Project List Entry"), and
 * a workspace context is a project *and* a scenario *and* a revision. The project
 * list carries none of the latter two, so the shell asks the project's scenarios
 * for them and resolves the target here, where the decision is pure and testable.
 *
 * Every outcome is reported. A click that does nothing at all is indistinguishable
 * from a broken application, so a project that cannot be opened says why instead of
 * failing silently.
 */

/**
 * @param {object} project   A project summary row: `{ projectId, name }`.
 * @param {Array}  scenarios Scenario summaries from `GET /projects/:id/scenarios`,
 *                           each with `activeRevision`.
 * @returns {{ok: true, context: object} | {ok: false, notice: string}}
 */
export function resolveOpenTarget(project, scenarios = []) {
  const projectId = project?.projectId ?? null;
  if (!projectId) {
    return { ok: false, notice: 'That project has no identifier, so it cannot be opened.' };
  }

  const list = Array.isArray(scenarios) ? scenarios : [];
  if (list.length === 0) {
    return {
      ok: false,
      notice: `“${project?.name ?? projectId}” has no scenario yet, so there is no workspace to open.`,
    };
  }

  // A scenario without a revision is not openable, but a later scenario may be.
  const openable = list.find((scenario) => scenario?.activeRevision?.revisionId);
  if (!openable) {
    const first = list[0];
    return {
      ok: false,
      notice: `“${first?.name ?? 'The project’s scenario'}” has no revision yet, so there is no workspace to open.`,
    };
  }

  try {
    return {
      ok: true,
      context: createWorkspaceContext({
        projectId,
        projectName: project?.name ?? null,
        scenarioId: openable.scenarioId,
        revisionId: openable.activeRevision.revisionId,
        lifecycleState: openable.activeRevision.lifecycleState,
      }),
    };
  } catch (error) {
    // A context the shell cannot construct is reported, never thrown into a click
    // handler: an unhandled rejection here would leave the list looking inert.
    return {
      ok: false,
      notice: `“${project?.name ?? projectId}” could not be opened: ${error.message}`,
    };
  }
}

/**
 * The whole "open this project" transition, free of React so it can be driven in a
 * test: load the project's scenarios, resolve the target, and enter the workspace
 * on the landing view.
 *
 * Returns `{ok:true}`, `{ok:false, notice}` for a project that cannot be opened, or
 * `{ok:false, error}` when the read itself failed. The caller renders the outcome;
 * nothing here is silent.
 *
 * @param {object}   options.project       The clicked project summary.
 * @param {Function} options.loadScenarios `(projectId) => Promise<{data}>`.
 * @param {Set|Array|null} options.keys    Effective permission keys, for the landing view.
 * @param {object}   options.workspace     The workspace store from `useWorkspace()`.
 */
export async function openProjectInWorkspace({ project, loadScenarios, keys = null, workspace }) {
  if (typeof loadScenarios !== 'function') {
    return { ok: false, notice: 'This build cannot read project scenarios, so a project cannot be opened.' };
  }
  if (!workspace?.requestContextSwitch) {
    return { ok: false, notice: 'The workspace is unavailable, so a project cannot be opened.' };
  }

  let loaded;
  try {
    loaded = (await loadScenarios(project?.projectId))?.data ?? [];
  } catch (error) {
    return { ok: false, error };
  }

  const target = resolveOpenTarget(project, loaded);
  if (!target.ok) return target;

  // Entering the workspace opens the landing view when one is permitted, so the
  // user lands on a work surface rather than an empty frame.
  const landing = landingTool(keys);
  workspace.requestContextSwitch(target.context, {}, { landingToolId: landing?.toolId ?? null });
  // The loaded scenarios travel back with the outcome: the context bar offers them
  // as choices, so the shell does not have to read them a second time.
  return { ok: true, context: target.context, landingToolId: landing?.toolId ?? null, scenarios: loaded };
}
