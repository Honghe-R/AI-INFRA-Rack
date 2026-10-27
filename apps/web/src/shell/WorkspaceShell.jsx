import { useEffect, useRef, useState } from 'react';
import { useUiContext, useWorkspace } from '../app/providers.jsx';
import { Icon } from './icons.jsx';
import { activeTab, hasDirtyTabs } from '../state/open-views.js';
import { getTool } from '../state/tool-registry.js';
import { scopeLabel } from '../assistant/assistant-state.js';
import { AssistantComposer } from '../assistant/AssistantComposer.jsx';
import { ActiveToolToolbar } from './ActiveToolToolbar.jsx';
import { BottomDrawer } from './BottomDrawer.jsx';
import { GlobalSidebar } from './GlobalSidebar.jsx';
import { MainView } from './MainView.jsx';
import { Watermark } from './Watermark.jsx';
import { AboutDialog } from './AboutDialog.jsx';
import { OpenViewTabs } from './OpenViewTabs.jsx';

/**
 * The six-region shell: global sidebar, project context bar, open-view tabs,
 * active-tool toolbar, main view, and bottom drawer.
 *
 * Responsive behaviour follows the resolved context, not the raw preference: on
 * a small viewport the sidebar becomes an explicit overlay drawer, reachable from
 * a labelled toggle, so no workflow depends on hover.
 */
export function WorkspaceShell({
  grantedKeys = null,
  badges = {},
  scenarios = [],
  revisions = [],
  toolbarDisabledReasons = {},
  onCommand = () => {},
  onAddFiles = () => {},
  onShare = () => {},
  accountLabel = null,
  assistant = {},
  devIdentity = null,
  renderToolSurface = null,
}) {
  const { ui, resolved, resolvedColorScheme, actions, shellAttributes } = useUiContext();
  const workspace = useWorkspace();
  const [navOpen, setNavOpen] = useState(false);
  // Owned by the shell rather than the settings menu: the sidebar is mounted twice on a
  // narrow viewport, once in the layout and once inside the overlay, so a dialog owned by
  // the menu could be open in both at once.
  const [aboutOpen, setAboutOpen] = useState(false);
  /**
   * The canvas tool that is currently active, and a request to end it.
   *
   * Held here because the toolbar is the shell's: it marks the command that started the
   * tool and is where the tool is put down again. The mode itself stays with the surface
   * that owns the viewport and the draft — the shell holds no mode of its own, only the
   * report of which one is running.
   */
  const [activeToolCommandId, setActiveToolCommandId] = useState(null);
  const [cancelToolRequest, setCancelToolRequest] = useState(null);
  const mainRef = useRef(null);
  const activeTabId = workspace.views.activeTabId;

  // Opening a tool, switching tools, and switching tabs must preserve focus
  // predictably: after navigation completes, the tool content owns focus.
  useEffect(() => {
    if (activeTabId) mainRef.current?.focus();
  }, [activeTabId]);

  const tab = activeTab(workspace.views);
  const context = workspace.workspaceContext;
  const asOverlay = resolved.sidebar === 'DRAWER';
  const activeToolLabel = getTool(tab?.toolId)?.label ?? 'Workspace';
  const unsaved = hasDirtyTabs(workspace.views);

  const sidebar = (
    <GlobalSidebar
      mode={asOverlay ? 'EXPANDED' : resolved.sidebar}
      pinned={resolved.sidebarPinned}
      hoverExpand={resolved.hoverExpand}
      activeToolId={tab?.toolId ?? null}
      activeFunctionId={tab?.routeState?.functionId ?? null}
      badges={badges}
      grantedKeys={grantedKeys}
      onSelectTool={(toolId) => {
        workspace.selectTool(toolId);
        setNavOpen(false);
      }}
      onSelectFunction={(functionId) => {
        // A tool cannot stay active on a route that is not the map. Cancelling here rather
        // than relying on the surface's unmount cleanup makes the mode end as the reader
        // navigates, and means coming back to Overview starts idle instead of resuming a
        // half-finished shape they abandoned by leaving.
        if (activeToolCommandId) {
          setCancelToolRequest((current) => ({ nonce: (current?.nonce ?? 0) + 1 }));
        }
        workspace.selectFunction(functionId);
      }}
      onOpenProjects={workspace.closeWorkspace}
      accountLabel={accountLabel}
      devIdentity={devIdentity}
      colorScheme={ui.colorScheme}
      resolvedColorScheme={resolvedColorScheme}
      onSetColorScheme={actions.setColorScheme}
      onTogglePin={() => actions.setSidebarPinned(!ui.layout.sidebarPinned)}
      onAbout={() => setAboutOpen(true)}
      onClose={asOverlay ? () => setNavOpen(false) : null}
    />
  );

  return (
    <div
      className="shell"
      {...shellAttributes}
      // The persisted drawer height drives CSS rather than a fixed token, so the
      // resize affordance actually changes what it claims to change.
      style={{ '--drawer-height': `${ui.layout.bottomDrawerHeightPx}px` }}
    >
      <a className="skip-link" href="#main-view">
        Skip to main content
      </a>

      {asOverlay ? (
        <>
          <button
            type="button"
            className="shell__nav-toggle"
            aria-expanded={navOpen}
            aria-controls="shell-sidebar"
            onClick={() => setNavOpen((open) => !open)}
          >
            <Icon name="grid" size={15} />
            Navigation
          </button>
          {navOpen ? (
            <div className="shell__nav-overlay" id="shell-sidebar" role="dialog" aria-modal="true" aria-label="Workspace navigation">
              {sidebar}
            </div>
          ) : null}
        </>
      ) : (
        <div className="shell__sidebar" id="shell-sidebar">
          {sidebar}
        </div>
      )}

      <div className="shell__main">
        {ui.visibility.openViewTabs ? (
          <OpenViewTabs
            tabs={workspace.views.tabs}
            activeTabId={workspace.views.activeTabId}
            projectName={context?.projectName ?? context?.projectId ?? null}
            onActivate={workspace.activateTab}
            onClose={workspace.requestCloseTab}
          />
        ) : null}

        <ActiveToolToolbar
          toolId={tab?.toolId ?? null}
          grantedKeys={grantedKeys}
          disabledReasons={toolbarDisabledReasons}
          onCommand={onCommand}
          activeCommandId={activeToolCommandId}
        />

        {/*
          The composer floats over the work surface inside this wrapper, so it
          sits above the bottom drawer by construction. The wrapper itself does
          not capture pointer input; only the composer's own footprint does, and
          the main view keeps a bottom inset so the collapsed launcher never
          covers the tool's primary save or validate action.

          The canvas is the one exception: its lower band is empty map rather
          than a command, so the inset there only cost the frame height. On that
          surface the inset is removed and the composer is lifted onto the map
          (see the `.canvas-layout` rules in the composer's stylesheet), which is
          what makes the drawing area reach the bottom of the surface.
        */}
        <div className="shell__surface">
          <MainView tab={tab} workspaceContext={context} mainRef={mainRef}>
            {renderToolSurface
              ? renderToolSurface({
                  tab,
                  context,
                  // The frame carries what a surface needs to describe the revision it is
                  // on. There is no context to switch from here any more: the project is
                  // chosen on the Projects list, and the workspace stays on it.
                  contextControls: {
                    revisions,
                    unsaved,
                    cancelToolRequest,
                    // Stable identities, both: the surface reports the active tool from an
                    // effect, so a new callback each render would re-run it every render.
                    onActiveToolChange: setActiveToolCommandId,
                  },
                })
              : null}
          </MainView>

          {ui.visibility.assistantComposer ? (
            <AssistantComposer
              {...assistant}
              toolLabel={activeToolLabel}
              scopeLabelText={scopeLabel({ toolLabel: activeToolLabel, lifecycleState: context.lifecycleState })}
              open={ui.layout.assistantOpen}
              onToggleOpen={actions.setAssistantOpen}
              width={ui.layout.assistantWidthPx}
              onResize={actions.setAssistantWidth}
            />
          ) : null}
        </div>

        {ui.visibility.bottomDrawer ? (
          <BottomDrawer
            drawer={workspace.drawer}
            onOpen={() => workspace.setDrawerOpen(true)}
            onClose={() => workspace.setDrawerOpen(false)}
            // ui-pattern.md, "Drawer Behavior": selecting a drawer tab expands the
            // drawer, because that tab's content is the reason it was selected.
            onSelectTab={(tabId) => {
              workspace.openDrawerTab(tabId);
              workspace.setDrawerOpen(true);
            }}
            onCloseTab={workspace.closeDrawerTab}
            onResize={workspace.setDrawerHeight}
          />
        ) : null}
      </div>

      {workspace.pendingClose ? (
        <ConfirmDialog
          title="Discard unsaved changes?"
          body={workspace.pendingClose.reason ?? 'This view has unsaved changes.'}
          confirmLabel="Discard and close"
          onConfirm={workspace.confirmCloseTab}
          onCancel={workspace.cancelCloseTab}
        />
      ) : null}

      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}

      {workspace.pendingSwitch ? (
        <ConfirmDialog
          title="Switch context and discard unsaved changes?"
          body="An open view has unsaved changes. Saving or discarding them is required before switching."
          confirmLabel="Discard and switch"
          onConfirm={workspace.confirmContextSwitch}
          onCancel={workspace.cancelContextSwitch}
        />
      ) : null}
    </div>
  );
}

/** The project list keeps the global sidebar but has no context bar or tabs. */
export function ProjectsShell({ grantedKeys = null, accountLabel = null, devIdentity = null, children = null }) {
  const { ui, resolved, resolvedColorScheme, actions, shellAttributes } = useUiContext();
  const [navOpen, setNavOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const asOverlay = resolved.sidebar === 'DRAWER';

  const sidebar = (
    <GlobalSidebar
      mode={asOverlay ? 'EXPANDED' : resolved.sidebar}
      grantedKeys={grantedKeys}
      onSelectTool={() => {}}
      onOpenProjects={() => {}}
      // The account is here as well as in the workspace: switching an identity reloads, so
      // the projects list is where you land, and it is where you want to see who you now are.
      accountLabel={accountLabel}
      devIdentity={devIdentity}
      colorScheme={ui.colorScheme}
      resolvedColorScheme={resolvedColorScheme}
      onSetColorScheme={actions.setColorScheme}
      pinned={ui.layout.sidebarPinned}
      onTogglePin={() => actions.setSidebarPinned(!ui.layout.sidebarPinned)}
      onAbout={() => setAboutOpen(true)}
    />
  );

  return (
    <div className="shell shell--projects" {...shellAttributes}>
      <a className="skip-link" href="#main-view">
        Skip to main content
      </a>

      {asOverlay ? (
        <button type="button" className="shell__nav-toggle" aria-expanded={navOpen} onClick={() => setNavOpen((open) => !open)}>
          <Icon name="grid" size={15} />
          Navigation
        </button>
      ) : (
        <div className="shell__sidebar">{sidebar}</div>
      )}
      {asOverlay && navOpen ? (
        <div className="shell__nav-overlay" role="dialog" aria-modal="true" aria-label="Workspace navigation">
          {sidebar}
        </div>
      ) : null}

      <div className="shell__main">
        <main className="main-view main-view--projects" id="main-view">
          <Watermark />
          {children}
        </main>
      </div>

      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
    </div>
  );
}

function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }) {
  const cancelRef = useRef(null);

  // Focus the safe outcome: this dialog discards unsaved work, so the default
  // action is to keep editing. Escape cancels without touching the draft.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <h2 className="dialog__title">{title}</h2>
      <p className="dialog__body">{body}</p>
      <div className="dialog__actions">
        <button type="button" className="dialog__confirm" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="dialog__cancel" ref={cancelRef} onClick={onCancel}>
          Keep editing
        </button>
      </div>
    </div>
  );
}

export { ConfirmDialog };
