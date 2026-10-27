/**
 * Workspace context: the one project, scenario, and revision the user is working
 * in. It is authoritative domain state, so it never lives in UI Context.
 *
 * Every view must remain attributable to an immutable revision
 * (ui-pattern.md acceptance criterion 7), which is why the context carries the
 * revision id and lifecycle state rather than a display name alone.
 */

export const LIFECYCLE_STATES = Object.freeze(['DRAFT', 'VALIDATED', 'PUBLISHED']);

export function createWorkspaceContext({
  projectId,
  scenarioId,
  revisionId,
  lifecycleState = 'DRAFT',
  validationSummary = { errors: 0, warnings: 0 },
  approvalAttestationId = null,
  projectName = null,
} = {}) {
  if (!projectId) throw new Error('A workspace context requires a project id.');
  if (!scenarioId) throw new Error('A workspace context requires a scenario id.');
  if (!revisionId) throw new Error('A workspace context requires a revision id.');
  if (!LIFECYCLE_STATES.includes(lifecycleState)) {
    throw new Error(`Unknown lifecycle state "${lifecycleState}".`);
  }

  return Object.freeze({
    projectId,
    projectName,
    scenarioId,
    revisionId,
    lifecycleState,
    approvalAttestationId,
    validationSummary: Object.freeze({
      errors: validationSummary.errors ?? 0,
      warnings: validationSummary.warnings ?? 0,
    }),
  });
}

/** Identity of the workspace context: the scope tabs, drawer state, and routes belong to. */
export function contextKey(context) {
  return `${context.projectId}|${context.scenarioId}|${context.revisionId}`;
}

/**
 * Tabs and contextual drawer tabs belong to one project, scenario, and revision.
 * Anything else is stale and must be discarded or marked rather than reused
 * silently (ui-pattern.md, "Open-View Tabs" and "Context Switching").
 */
export function isCompatible(contextA, contextB) {
  if (!contextA || !contextB) return false;
  return contextKey(contextA) === contextKey(contextB);
}

/** Tabs whose context no longer matches the active one. */
export function staleTabs(tabs, context) {
  return tabs.filter((tab) => !isCompatible(tab.workspaceContext, context));
}

/**
 * Switching project, scenario, or revision must not discard unsaved work
 * silently (acceptance criterion 6). The shell asks before switching when any
 * open tab is dirty, unless the user has turned the confirmation off.
 */
export function contextSwitchRequiresConfirmation(tabs, interaction = {}) {
  if (interaction.confirmContextSwitch === false) return false;
  return tabs.some((tab) => tab.dirtyState?.dirty === true);
}

export function dirtyTabs(tabs) {
  return tabs.filter((tab) => tab.dirtyState?.dirty === true);
}

/** A short label for the context bar and the assistant scope label. */
export function describeContext(context) {
  const name = context.projectName ?? context.projectId;
  return `${name} · Revision: ${context.revisionId.slice(0, 8)}`;
}
