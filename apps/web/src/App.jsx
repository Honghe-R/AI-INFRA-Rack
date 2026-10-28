import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PermissionProvider } from './permissions/usePermission.jsx';
import { useEffectiveKeys } from './permissions/useEffectiveKeys.js';
import { useAssets } from './api/useAssets.js';
import { scopeLabel } from './assistant/assistant-state.js';
import { useAssistantSession } from './assistant/useAssistantSession.js';
import { ProjectListEntry } from './projects/ProjectListEntry.jsx';
import { openProjectInWorkspace } from './projects/open-project.js';
import { AssetsSurface } from './assets/AssetsSurface.jsx';
import { RackSurface } from './rack/RackSurface.jsx';
import { CatalogSurface } from './catalog/CatalogSurface.jsx';
import { FacilityImport } from './facility/FacilityImport.jsx';
import { FacilityVerification } from './facility/FacilityVerification.jsx';
import { SiteFacilityCanvas } from './map/SiteFacilityCanvas.jsx';
import { ProjectsShell, WorkspaceShell } from './shell/WorkspaceShell.jsx';
import { Icon, toolIcon } from './shell/icons.jsx';
import { shortId } from './shell/format.js';
import {
  describeIdentity,
  loadDevIdentities,
  rememberDevIdentity,
  currentDevIdentity,
} from './app/dev-identity.js';
import { getTool } from './state/tool-registry.js';
import { contextKey } from './state/workspace-context.js';
import { createWorkspaceEffects, WorkspaceEffectsProvider } from './facility/workspace-effects.js';
import { UiContextProvider, WorkspaceProvider, useUiContext, useWorkspace } from './app/providers.jsx';

/**
 * The application root.
 *
 * Two screens, one shell: `Projects` after sign-in and the project workspace once
 * a project is open (ui-pattern.md, "Information Architecture"). A design tool
 * cannot render without a workspace context, which is why the context lives above
 * the shell rather than inside a tool.
 */
export function App({
  projects = [],
  projectsPending = false,
  projectsError = null,
  projectsNotice = null,
  scenarios = [],
  revisions = [],
  initialUi = null,
  initialContext = null,
  initialViews = null,
  permissionClient = null,
  unscopedKeys = null,
  accountLabel = null,
  badges = {},
  onCreateProject = () => {},
  // Left null so the shell opens the project through the workspace store it owns.
  // Supplied only by tests and embedders that drive navigation themselves.
  onOpenProject = null,
  loadProjectScenarios = null,
  onCommand = () => {},
  assets = [],
  toolLabels = {},
  assetHandlers = {},
  assetClient = null,
  viewport = null,
}) {
  return (
    <UiContextProvider initialUi={initialUi} viewport={viewport}>
      <PermissionProvider client={permissionClient} unscopedKeys={unscopedKeys}>
        <WorkspaceProvider initialContext={initialContext} initialViews={initialViews}>
          <AppBody
            projects={projects}
            projectsPending={projectsPending}
            projectsError={projectsError}
            projectsNotice={projectsNotice}
            scenarios={scenarios}
            revisions={revisions}
            accountLabel={accountLabel}
            badges={badges}
            assets={assets}
            toolLabels={toolLabels}
            assetHandlers={assetHandlers}
            assetClient={assetClient}
            onCreateProject={onCreateProject}
            onOpenProject={onOpenProject}
            loadProjectScenarios={loadProjectScenarios}
            onCommand={onCommand}
          />
        </WorkspaceProvider>
      </PermissionProvider>
    </UiContextProvider>
  );
}

function AppBody({ projects, projectsPending, projectsError, projectsNotice, scenarios, revisions, accountLabel, badges, assets, toolLabels, assetHandlers, assetClient, onCreateProject, onOpenProject, loadProjectScenarios, onCommand }) {
  const workspace = useWorkspace();
  const { resolved } = useUiContext();
  const context = workspace.workspaceContext;
  const [openError, setOpenError] = useState(null);
  const [openNotice, setOpenNotice] = useState(null);
  // The scenarios read while opening a project stay available, so the context bar
  // offers real choices instead of an empty control.
  const [openScenarios, setOpenScenarios] = useState([]);
  // The toolbar's Validate command is a stamped intent, not a run: the shell owns
  // the button and the Verify surface owns the run, so neither reaches into the
  // other. The surface clears it once it has been consumed.
  const [validateRequest, setValidateRequest] = useState(null);
  // A canvas tool asked for from the toolbar: the surface owns the mode, the shell only asks.
  const [canvasRequest, setCanvasRequest] = useState(null);
  // The identities a dev server offers, and which one this session asked for. Both are
  // empty in a deployment, where the account control is a label rather than a menu.
  const [devIdentities, setDevIdentities] = useState({ available: false, identities: [], defaultSubject: null });
  const [devSubject, setDevSubject] = useState(() => currentDevIdentity());
  const validateNonceRef = useRef(0);
  const canvasNonceRef = useRef(0);

  // The key set only gates what the shell draws. Until it loads, or if it fails,
  // it stays null and nothing is hidden on a guess.
  const { keys } = useEffectiveKeys({
    projectId: context?.projectId ?? null,
    organisationId: null,
  });

  /**
   * Asset wiring. The list is project-scoped, so it follows the workspace context
   * rather than a tool tab. Upload is the one place the shell sends bytes: intake
   * streams the file to the reserved version's content resource (D23), and the
   * hidden input exists because a file picker must be opened from a user gesture.
   */
  const assetList = useAssets({ client: assetClient, projectId: context?.projectId ?? null });
  const surfaceAssets = assets.length > 0 ? assets : assetList.assets;
  const fileInputRef = useRef(null);
  const [assetIntent, setAssetIntent] = useState(null);
  const [assetBusy, setAssetBusy] = useState(false);
  const [assetNotice, setAssetNotice] = useState(null);

  // The assistant conversation belongs to the workspace context: a context switch
  // starts a fresh one and leaves the previous context's stored sessions alone.
  const activeTab = workspace.views.tabs.find((tab) => tab.tabId === workspace.views.activeTabId) ?? null;

  // The seam the assistant dispatches into. It is built once, with navigation read
  // through refs, because its identity is what the conversation and the dispatcher
  // hold; a facade rebuilt on every render would churn both.
  const routeRef = useRef(() => {});
  const toolRef = useRef(() => {});
  const effects = useMemo(
    () =>
      createWorkspaceEffects({
        onRoute: (functionId) => routeRef.current(functionId),
        onOpenTool: (toolId) => toolRef.current(toolId),
      }),
    [],
  );
  routeRef.current = (functionId) => workspace.selectFunction(functionId);
  toolRef.current = (toolId) => workspace.selectTool(toolId);

  const assistant = useAssistantSession({
    client: assetClient,
    workspaceContext: context,
    scopeLabel: scopeLabel({
      toolLabel: getTool(activeTab?.toolId)?.label ?? 'Workspace',
      lifecycleState: context?.lifecycleState,
    }),
    effects,
    // The wire context reports the active tab's function; the canvas reports the
    // selection and the pending change set at send time.
    routeFunctionId: activeTab?.routeState?.functionId ?? null,
  });

  /**
   * Dispatches a settled turn's effects exactly once.
   *
   * A turn is settled when its status is COMPLETE — the STREAMING placeholder that a
   * reply replaces carries no actions — and the idempotency is two-layered: this ref
   * stops a turn being re-dispatched when the transcript re-renders, and the
   * dispatcher's applied-id set stops an individual action being applied twice if a
   * turn is somehow offered again.
   *
   * A turn that committed a write is the one case with no UI action to carry it: the
   * change happened in the database, and the surfaces keep what they read. So the
   * reload is dispatched here, beside the navigation, and for the same reason — the
   * turn is the only thing that knows the design moved.
   */
  const dispatchedTurnsRef = useRef(new Set());
  const uiActionHandler = assistant.uiActionHandler;
  useEffect(() => {
    for (const turn of assistant.turns) {
      if (turn.status !== 'COMPLETE') continue;
      const actions = Array.isArray(turn.uiActions) ? turn.uiActions : [];
      const changed = turn.draftChanged === true;
      if (actions.length === 0 && !changed) continue;
      if (dispatchedTurnsRef.current.has(turn.turnId)) continue;
      dispatchedTurnsRef.current.add(turn.turnId);
      if (changed) effects.reloadEnvelope();
      if (actions.length > 0) uiActionHandler(actions, { currentContextKey: context ? contextKey(context) : null });
    }
  }, [assistant.turns, uiActionHandler, context, effects]);

  const pickFiles = useCallback((intent) => {
    setAssetNotice(null);
    setAssetIntent(intent);
    fileInputRef.current?.click();
  }, []);

  /** The identities a dev server offers. Absent in a deployment, where the read 404s. */
  useEffect(() => {
    let active = true;
    loadDevIdentities().then((result) => {
      if (active) setDevIdentities(result);
    });
    return () => {
      active = false;
    };
  }, []);

  /**
   * Switching identity reloads the page.
   *
   * Everything a session has resolved — permissions, the project list, the open tabs, the
   * revision — was resolved *as somebody*, and patching it in place would leave the shell
   * showing one identity's state under another's name. A reload is the honest way to say
   * the session ended and a new one began, and it is one the user can see.
   */
  const chooseDevIdentity = useCallback((subject) => {
    if (subject === currentDevIdentity()) return;
    rememberDevIdentity(subject);
    globalThis.location?.reload();
  }, []);

  const devIdentity = {
    ...devIdentities,
    current: describeIdentity({
      identities: devIdentities.identities,
      // Nothing chosen yet means the server's default is what this session is acting as,
      // and the control should name it rather than saying "Account" — the point of the
      // menu is to tell you who you are looking at the app as.
      subject: devSubject ?? devIdentities.defaultSubject ?? null,
      fallbackName: accountLabel,
    }),
    choose: chooseDevIdentity,
  };

  const onFilesChosen = useCallback(
    async (fileList) => {
      const files = Array.from(fileList ?? []);
      const projectId = context?.projectId ?? null;
      const intent = assetIntent;
      setAssetIntent(null);
      if (files.length === 0 || !projectId || !assetClient) return;

      setAssetBusy(true);
      setAssetNotice(null);
      try {
        for (const file of files) {
          const declaration = {
            filename: file.name,
            media_type: file.type || 'application/octet-stream',
            size_bytes: file.size,
          };
          if (intent?.mode === 'version' && intent.assetId) {
            const reserved = await assetClient.createAssetVersion(projectId, intent.assetId, declaration);
            await assetClient.uploadAssetContent(
              projectId,
              intent.assetId,
              reserved.data.version.assetVersionId,
              file,
            );
          } else {
            const created = await assetClient.createAsset(projectId, { name: file.name, ...declaration });
            await assetClient.uploadAssetContent(
              projectId,
              created.data.asset.assetId,
              created.data.version.assetVersionId,
              file,
            );
          }
        }
        await assetList.reload();
      } catch (error) {
        setAssetNotice(error.message);
      } finally {
        setAssetBusy(false);
      }
    },
    [assetClient, assetIntent, assetList, context?.projectId],
  );

  const boundAssetHandlers = {
    onUpload: () => pickFiles({ mode: 'asset' }),
    onNewVersion: (asset) => pickFiles({ mode: 'version', assetId: asset?.assetId }),
    onDownload: (asset) => {
      const versionId = asset?.currentVersionId ?? asset?.assetVersionId;
      if (!assetClient || !versionId) return;
      assetClient
        .downloadAsset(context.projectId, asset.assetId, versionId)
        .then(({ data }) => {
          if (typeof window !== 'undefined' && data?.url) window.open(data.url, '_blank', 'noopener');
        })
        .catch((error) => setAssetNotice(error.message));
    },
    onArchive: (asset) => {
      if (!assetClient) return;
      assetClient
        .archiveAsset(context.projectId, asset.assetId, !asset.archived)
        .then(() => assetList.reload())
        .catch((error) => setAssetNotice(error.message));
    },
    onDelete: (asset) => {
      if (!assetClient) return;
      assetClient
        .deleteAsset(context.projectId, asset.assetId)
        .then(() => assetList.reload())
        .catch((error) => setAssetNotice(error.message));
    },
  };
  const mergedAssetHandlers = { ...boundAssetHandlers, ...assetHandlers };

  /**
   * Opening a project means resolving its scenario and active revision, then
   * entering the workspace on the landing view. Failure is reported on the list
   * rather than swallowed, because a click that does nothing reads as a broken
   * screen (ui-pattern.md, "Project List Entry").
   */
  const openFromList = useCallback(
    async (project) => {
      setOpenError(null);
      setOpenNotice(null);

      const outcome = await openProjectInWorkspace({
        project,
        loadScenarios: loadProjectScenarios,
        keys,
        workspace,
      });

      if (outcome.error) setOpenError(outcome.error);
      else if (!outcome.ok) setOpenNotice(outcome.notice);
      else setOpenScenarios(outcome.scenarios ?? []);
    },
    [loadProjectScenarios, keys, workspace],
  );

  const openProject = onOpenProject ?? openFromList;

  /**
   * Tool commands the shell itself answers.
   *
   * Validate opens the Verify route and stamps a run request; it asks for the
   * advisory local run rather than a full one, because a clean full run freezes the
   * revision and a toolbar click must never do that silently.
   *
   * The two canvas tools ask the canvas for a mode rather than owning one: the mode
   * belongs to the surface that has the viewport and the projection, and a shell that
   * kept it would have to duplicate both. Each request carries a nonce so pressing the
   * same tool twice is a new request rather than an identical object React would ignore.
   */
  const handleCommand = useCallback(
    (commandId) => {
      if (commandId === 'validate') {
        workspace.selectFunction('validate');
        validateNonceRef.current += 1;
        setValidateRequest({ scope: 'AFFECTED_SUBGRAPH', nonce: validateNonceRef.current });
      }
      // Import opens the binding review for the active revision (ui-pattern.md, "Import
      // Entry Points": the tool Import command "opens that tool's binding review in the
      // active revision"). The intake half is the shell's Add files path, which creates
      // a project asset with no binding; this surface is where it gets consumed.
      if (commandId === 'import') {
        workspace.selectFunction('import_map');
      }
      if (commandId === 'draw_footprint' || commandId === 'add_interface') {
        // Both act on the map, so the shell first makes sure the map is what is showing.
        workspace.selectFunction('overview');
        canvasNonceRef.current += 1;
        setCanvasRequest({ intent: commandId, nonce: canvasNonceRef.current });
      }
      onCommand(commandId);
    },
    [onCommand, workspace],
  );

  if (!context) {
    return (
      <ProjectsShell grantedKeys={keys} accountLabel={accountLabel} devIdentity={devIdentity}>
        <ProjectListEntry
          projects={projects}
          onCreate={onCreateProject}
          onOpen={openProject}
          pending={projectsPending}
          error={projectsError ?? openError}
          notice={openNotice ?? projectsNotice}
        />
      </ProjectsShell>
    );
  }

  // A caller may supply the lists; otherwise the shell uses what it read while
  // opening the project. Only the active revision is known today, so the revision
  // list holds exactly that one — the control shows where the workspace is rather
  // than offering a choice that does not exist yet.
  const shellScenarios = scenarios.length > 0 ? scenarios : openScenarios;
  const activeScenario = shellScenarios.find((scenario) => scenario.scenarioId === context.scenarioId) ?? null;
  const shellRevisions =
    revisions.length > 0
      ? revisions
      : activeScenario?.activeRevision
        ? [
            {
              revisionId: activeScenario.activeRevision.revisionId,
              name: activeScenario.activeRevision.name ?? null,
              lifecycleState: activeScenario.activeRevision.lifecycleState,
            },
          ]
        : [];

  return (
    <WorkspaceEffectsProvider effects={effects}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          onFilesChosen(event.target.files);
          event.target.value = '';
        }}
      />
      {assetNotice ? (
        <p role="alert" className="visually-hidden">
          {assetNotice}
        </p>
      ) : null}
      <WorkspaceShell
        grantedKeys={keys}
        badges={badges}
        scenarios={shellScenarios}
        revisions={shellRevisions}
        accountLabel={accountLabel}
        assistant={assistant}
        onCommand={handleCommand}
        devIdentity={devIdentity}
        renderToolSurface={({ tab, contextControls }) => {
          if (!tab) return null;
          // Assets is a shell-owned supporting workspace; every other surface is
          // provided by the owning tool.
          if (tab.toolId === 'assets') {
            return (
              <AssetsSurface
                assets={surfaceAssets}
                projectId={tab.workspaceContext.projectId}
                toolLabels={toolLabels}
                busy={assetBusy || assetList.pending}
                onUpload={mergedAssetHandlers.onUpload}
                onNewVersion={mergedAssetHandlers.onNewVersion}
                onDownload={mergedAssetHandlers.onDownload}
                onArchive={mergedAssetHandlers.onArchive}
                onDelete={mergedAssetHandlers.onDelete}
              />
            );
          }
          // The Site & Facility canvas is the first slice of T7 pulled forward:
          // the basemap viewport with the facility graph drawn into it. The graph
          // is read for the revision the shell resolved, never for "the project".
          if (tab.toolId === 'site_facility') {
            // Verify is its own route in the tool (ui-pattern.md, route table): the
            // canvas draws the design, and the findings and coverage that judge it
            // are a different surface rather than a layer on the map.
            if (tab.routeState?.functionId === 'validate') {
              return (
                <FacilityVerification
                  client={assetClient}
                  projectId={tab.workspaceContext.projectId}
                  revisionId={tab.workspaceContext.revisionId}
                  runRequest={validateRequest}
                  onRunRequestConsumed={() => setValidateRequest(null)}
                />
              );
            }
            // Import & Map is the same shape of route: binding a source is a review
            // surface, not a mode of the drawing canvas.
            if (tab.routeState?.functionId === 'import_map') {
              return (
                <FacilityImport
                  client={assetClient}
                  projectId={tab.workspaceContext.projectId}
                  revisionId={tab.workspaceContext.revisionId}
                />
              );
            }
            return (
              <SiteFacilityCanvas
                client={assetClient}
                projectId={tab.workspaceContext.projectId}
                revisionId={tab.workspaceContext.revisionId}
                // The frame's caption. Read from the shell's context rather than
                // re-fetched by the canvas, so the name on the board is the one the
                // workspace was opened with.
                projectName={tab.workspaceContext.projectName}
                lifecycleState={tab.workspaceContext.lifecycleState}
                validationSummary={tab.workspaceContext.validationSummary}
                authorName={devIdentity.current?.name ?? accountLabel ?? null}
                // The frame carries the revision's name, whether the work is saved, and
                // whether it is approved. Scenario and revision are no longer switchable
                // from inside a workspace, so the canvas is told nothing to switch.
                revisions={contextControls.revisions}
                unsaved={contextControls.unsaved}
                cancelToolRequest={contextControls.cancelToolRequest}
                onActiveToolChange={contextControls.onActiveToolChange}
                approvalAttestationId={tab.workspaceContext.approvalAttestationId}
                // A toolbar tool the shell cannot perform itself: the canvas owns the
                // viewport and the projection, so it owns the mode.
                toolRequest={canvasRequest}
                onToolRequestConsumed={() => setCanvasRequest(null)}
                // The canvas owns whether there is unsaved work; the shell owns what to do
                // about it. Reporting it is what makes closing the tab, or switching
                // context, ask before discarding a pending change set.
                onDirtyChange={(dirty) =>
                  workspace.setDirty(tab.tabId, dirty, dirty ? 'This revision has uncommitted changes.' : null)
                }
              />
            );
          }
          if (tab.toolId === 'catalog') {
            return <CatalogSurface key={tab.tabId} client={assetClient} context={tab.workspaceContext} routeState={tab.routeState} />;
          }
          if (tab.toolId === 'rack') {
            return <RackSurface key={tab.tabId} client={assetClient} context={tab.workspaceContext}
              routeState={tab.routeState}
              onRouteChange={patch => workspace.setRouteState(tab.tabId, patch)}
              onDirtyChange={dirty => workspace.setDirty(tab.tabId, dirty, dirty ? 'Rack changes have not been saved.' : null)} />;
          }
          return <ToolSurfacePlaceholder tab={tab} responsive={resolved} />;
        }}
      />
    </WorkspaceEffectsProvider>
  );
}

/**
 * Until a tool ships its own surface, the shell renders an explicit placeholder.
 *
 * It names the tool, function, and revision so the view is never unattributable,
 * and it looks like a deliberate empty state rather than a rendering failure.
 */
function ToolSurfacePlaceholder({ tab, responsive }) {
  const tool = getTool(tab.toolId);
  const functionLabel =
    tool?.functions.find((item) => item.functionId === tab.routeState?.functionId)?.label ?? 'Overview';

  return (
    <section className="surface-empty" aria-label="Tool work surface">
      <span className="surface-empty__icon">
        <Icon name={toolIcon(tab.toolId)} size={22} />
      </span>
      <h2 className="surface-empty__title">{tool?.label ?? tab.toolId}</h2>
      <p className="surface-empty__text">
        This tool's work surface is provided by its own editor. Until it ships, the shell shows the context
        every view is scoped to, so nothing here is unattributable.
      </p>

      <dl className="surface-empty__meta">
        <div className="chip">
          <span className="visually-hidden">Function:</span>
          {functionLabel}
        </div>
        <div className="chip">
          <span className="visually-hidden">Lifecycle:</span>
          {tab.workspaceContext.lifecycleState}
        </div>
        <div className="chip" title={tab.workspaceContext.revisionId}>
          <span className="visually-hidden">Revision:</span>
          {shortId(tab.workspaceContext.revisionId)}
        </div>
        <div className="chip">
          <span className="visually-hidden">Layout mode:</span>
          {responsive.breakpoint}
        </div>
      </dl>
    </section>
  );
}

export { ToolSurfacePlaceholder };
