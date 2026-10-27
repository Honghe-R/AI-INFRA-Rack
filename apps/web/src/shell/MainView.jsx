import { getTool, resolveFunctionId } from '../state/tool-registry.js';
import { Icon, toolIcon } from './icons.jsx';
import { Watermark } from './Watermark.jsx';
import { shortId } from './format.js';

/**
 * The main view: the active tool's complete work surface, or the project
 * overview when no tab is open.
 *
 * The shell does not duplicate tool-local controls here. Until a tool ships its
 * own surface, this renders an attributed placeholder that names the tool,
 * function, and revision, so every view stays traceable to an immutable revision
 * even before the editors exist.
 *
 * An empty region explains itself: a title, what to do next, and the context the
 * view is scoped to. A blank canvas reads as a failure, not as an invitation.
 */
export function MainView({ tab = null, workspaceContext = null, children = null, mainRef = null }) {
  if (!tab) {
    return (
      <main className="main-view main-view--overview" aria-label="Project overview" ref={mainRef} tabIndex={-1}>
        <div className="surface-empty">
          <span className="surface-empty__icon">
            <Icon name={workspaceContext ? 'grid' : 'map'} size={22} />
          </span>
          <h1 className="surface-empty__title">{workspaceContext ? 'Project overview' : 'Projects'}</h1>
          <p className="surface-empty__text">
            {workspaceContext
              ? 'Select a tool from the navigation to open its work surface. Panels open along the bottom when something needs attention.'
              : 'Select a project to begin.'}
          </p>

          {workspaceContext ? (
            <dl className="surface-empty__meta">
              <div className="chip">
                <span className="visually-hidden">Project:</span>
                {workspaceContext.projectName ?? shortId(workspaceContext.projectId)}
              </div>
              <div className="chip" title={workspaceContext.revisionId}>
                <span className="visually-hidden">Revision:</span>
                {shortId(workspaceContext.revisionId)}
              </div>
              <div className="chip">
                <span className="visually-hidden">Lifecycle:</span>
                {workspaceContext.lifecycleState}
              </div>
            </dl>
          ) : null}
        </div>
      </main>
    );
  }

  const tool = getTool(tab.toolId);
  const functionId = resolveFunctionId(tab.toolId, tab.routeState);
  const functionLabel = tool?.functions.find((item) => item.functionId === functionId)?.label ?? functionId;

  return (
    <main
      className="main-view"
      // Programmatically focusable so focus lands on the tool surface after
      // navigation completes, rather than being lost with the clicked control.
      tabIndex={-1}
      ref={mainRef}
      aria-label={`${tool?.label ?? tab.toolId}: ${functionLabel}`}
      data-tool-id={tab.toolId}
      data-function-id={functionId}
    >
      <Watermark />
      <div className="main-view__body">{children}</div>
    </main>
  );
}
