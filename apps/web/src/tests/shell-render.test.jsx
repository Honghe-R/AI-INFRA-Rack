import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPermissionClient } from '../rbac/client.js';
import { App } from '../App.jsx';
import { PlatformApp } from '../app/PlatformApp.jsx';
import { GlobalSidebar } from '../shell/GlobalSidebar.jsx';
import { BuildVersion } from '../shell/BuildVersion.jsx';
import { ActiveToolToolbar } from '../shell/ActiveToolToolbar.jsx';
import { BottomDrawer } from '../shell/BottomDrawer.jsx';
import { ConfirmDialog } from '../shell/WorkspaceShell.jsx';
import { OpenViewTabs } from '../shell/OpenViewTabs.jsx';
import { createBottomDrawerState } from '../state/bottom-drawer.js';
import { createOpenViewsState, openViewsReducer } from '../state/open-views.js';
import { createWorkspaceContext } from '../state/workspace-context.js';

/**
 * Component contracts rendered to static markup.
 *
 * `react-dom/server` renders without a DOM, so these assertions cover structure,
 * accessible names, and ARIA state — the parts a build check cannot verify. They
 * deliberately do not test click behaviour; the state transitions those produce
 * are covered by the reducer suites.
 */

const CONTEXT = createWorkspaceContext({
  projectId: 'p-1',
  projectName: 'Northern DC',
  scenarioId: 's-1',
  revisionId: 'rev-11111111',
  lifecycleState: 'DRAFT',
  validationSummary: { errors: 2, warnings: 1 },
});

function clientWith(keys) {
  const client = createPermissionClient({
    fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } }),
  });
  client.setUnscopedKeys(keys);
  return client;
}

function renderApp(props = {}) {
  return renderToStaticMarkup(
    <App
      projects={[]}
      permissionClient={clientWith(props.keys ?? [])}
      initialUi={props.initialUi ?? null}
      initialContext={props.initialContext ?? null}
      {...props}
    />,
  );
}

test('after sign-in the shell shows the project list, not an empty editor', () => {
  const html = renderApp({ projects: [{ projectId: 'p-1', name: 'Northern DC', site: 'Shanghai', lifecycleState: 'DRAFT', validationSummary: { errors: 3, warnings: 0 }, updatedLabel: '2h ago' }] });
  assert.match(html, /Projects/);
  assert.match(html, /Northern DC/);
  assert.match(html, /Shanghai/);
  assert.match(html, /DRAFT/);
  assert.match(html, /3 errors · 0 warnings/);
  assert.doesNotMatch(html, /context-bar/, 'no project context before one is opened');
});

test('an empty project list explains itself rather than showing a blank editor', () => {
  const html = renderApp({ projects: [] });
  assert.match(html, /No projects yet/);
});

test('a project the read carries no lifecycle for is not given a fabricated state', () => {
  // The project list read returns identity and access only: lifecycle lives on a
  // revision. Mapping it blindly put an `undefined` key in the status filter and warned
  // on every render, and the row defaulted to a state the server never sent.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  let html;
  try {
    html = renderApp({ projects: [{ projectId: 'p-1', name: 'Northern DC' }] });
  } finally {
    spy.mockRestore();
  }

  assert.match(html, /project-row__state[^>]*>—</, 'an unset state renders as —, not DRAFT');
  assert.doesNotMatch(html, /Lifecycle: DRAFT/);
  assert.doesNotMatch(html, /projects__status"/, 'a status filter with nothing to choose is not drawn');
  assert.equal(
    spy.mock.calls.filter((call) => String(call[0]).includes('unique "key"')).length,
    0,
    'no list in the project entry renders a key-less child',
  );
});

test('opening a project leads the tab row with its name, before any tool renders', () => {
  const html = renderApp({ initialContext: CONTEXT, keys: ['facility.read'] });
  // The context bar is gone from every view, so the tab row's static project marker is
  // what says which project the workspace is on.
  assert.doesNotMatch(html, /aria-label="Project context"/, 'there is no context bar to render');
  assert.match(html, /class="tabs__project"[^>]*>/);
  assert.match(html, /tabs__project-name">Northern DC</);
  assert.match(html, /Project overview/, 'no tool renders until one is opened');
});

test('the Site & Facility tool opens on the basemap canvas, not a placeholder', () => {
  const views = {
    tabs: [{ tabId: 't1', toolId: 'site_facility', workspaceContext: CONTEXT, routeState: { functionId: 'overview' } }],
    activeTabId: 't1',
    activationOrder: ['t1'],
  };
  const html = renderApp({ initialContext: CONTEXT, keys: ['facility.read'], initialViews: views });

  assert.match(html, /aria-label="Basemap canvas"/);
  assert.match(html, /class="canvas__surface/, 'the canvas viewport is the tool surface');
  assert.doesNotMatch(html, /Tool work surface/, 'the placeholder is gone for this tool');
});

test('the assistant is wired into the workspace, scoped to the open project', () => {
  const html = renderApp({
    initialContext: CONTEXT,
    keys: ['facility.read'],
    assetClient: { async getAssistantUsage() { return { data: null }; } },
    initialUi: { layout: { assistantOpen: true } },
  });

  assert.match(html, /aria-label="Workspace assistant"/);
  assert.match(html, /Context: Workspace · Revision: Draft/);
  assert.doesNotMatch(html, /Ask a question about the active tool/, 'an empty conversation says nothing');
});

test('the drawer is present in the workspace, collapsed by default', () => {
  const html = renderApp({ initialContext: CONTEXT, keys: ['facility.read'] });
  assert.match(html, /aria-label="Workspace panels"/, 'the drawer is a workspace region');
  assert.match(html, /aria-expanded="false"/, 'collapsed by default, as the spec requires when nothing needs attention');
  assert.match(html, />Panels</, 'the handle names the region so it is discoverable');
  // The tabs share the handle's row rather than sitting under a separate title
  // bar, and they stay visible while collapsed: ui-pattern.md, "Drawer Behavior"
  // makes selecting a drawer tab an expansion gesture.
  assert.match(html, /class="drawer__bar"/, 'the drawer is a single row');
  assert.match(html, /role="tablist"[^>]*Panel tabs/, 'the tabs are the panel switcher and an expansion gesture');
  assert.doesNotMatch(html, /drawer__body/, 'the panel body only renders once expanded');
});

test('the colour mode lives in the sidebar settings, and the context bar no longer carries it', () => {
  const sidebar = renderToStaticMarkup(<GlobalSidebar activeToolId="site_facility" colorScheme="LIGHT" />);

  // A menu, not a two-state toggle: "System" is the default and the state a user most often
  // wants back, and a toggle can only ever move between light and dark.
  assert.match(sidebar, /title="Settings"/);
  assert.match(sidebar, /aria-haspopup="menu"/, 'the settings control opens a menu');

  // The context bar is project context now. Appearance is not a property of the project.
  const contextBar = renderApp({ initialContext: CONTEXT, keys: ['facility.read'] });
  assert.doesNotMatch(contextBar, /aria-label="Dark theme"/);
  assert.doesNotMatch(contextBar, />Share</, 'sharing had no handler and was never supplied');
  assert.doesNotMatch(contextBar, />Add files</, 'intake lives in Assets');
});

test('the project list has no drawer, because it is not a project workspace', () => {
  const html = renderApp({ projects: [] });
  assert.doesNotMatch(html, /aria-label="Workspace panels"/);
});

test('the settings menu names the build the browser is running', () => {
  const full = '4f0b4e2a1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f';
  const html = renderToStaticMarkup(<BuildVersion commit={full} />);

  // The short form is what is drawn and the whole value is what is kept: a commit is read
  // as an identifier, and a reader quoting it needs the part that identifies it.
  assert.match(html, /Build <code>4f0b4e2<\/code>/);
  assert.match(html, new RegExp(`title="${full}"`));

  // A build that resolved no commit draws nothing. "Build" with nothing after it reports a
  // fact that is not there.
  assert.equal(renderToStaticMarkup(<BuildVersion commit={null} />), '');
  assert.equal(renderToStaticMarkup(<BuildVersion commit="" />), '');
  assert.equal(renderToStaticMarkup(<BuildVersion commit="   " />), '');
});

test('the persisted drawer height reaches the shell as a CSS variable', () => {
  const html = renderApp({
    initialContext: CONTEXT,
    initialUi: { layout: { bottomDrawerHeightPx: 320 } },
    keys: ['facility.read'],
  });
  assert.match(html, /--drawer-height:320px/, 'resizing the drawer must change the rendered height');
});

test('the removed context bar leaves no trace in any view, whatever the stored preference says', () => {
  // The bar is gone from every surface, so the visibility flag it used to answer to has
  // nothing left to govern — and the project is still identifiable, from the tab row.
  for (const stored of [false, true]) {
    const html = renderApp({
      initialContext: CONTEXT,
      initialUi: { visibility: { projectContextBar: stored } },
      keys: ['facility.read'],
    });
    assert.doesNotMatch(html, /aria-label="Project context"/, `no bar for projectContextBar: ${stored}`);
    assert.doesNotMatch(html, /context-bar/, `no bar markup for projectContextBar: ${stored}`);
    assert.match(html, /tabs__project-name/, 'and the project is still named');
  }
});

test('UI context attributes drive appearance on the shell root', () => {
  const html = renderApp({
    initialContext: CONTEXT,
    initialUi: { colorScheme: 'DARK', contrastMode: 'HIGH', density: 'COMPACT', motion: 'REDUCED' },
    keys: ['facility.read'],
  });
  assert.match(html, /data-color-scheme="DARK"/);
  assert.match(html, /data-contrast="HIGH"/);
  assert.match(html, /data-density="COMPACT"/);
  assert.match(html, /data-motion="REDUCED"/);
});

test('the sidebar exposes disclosure, current state, and text badges', () => {
  const html = renderToStaticMarkup(
    <GlobalSidebar
      activeToolId="site_facility"
      activeFunctionId="capacity"
      badges={{ site_facility: { errors: 2, warnings: 1 } }}
      grantedKeys={null}
    />,
  );
  assert.match(html, /aria-label="Workspace navigation"/);
  assert.match(html, /aria-expanded="true"/, 'the active outer tool reveals its functions');
  assert.match(html, /aria-current="page"/, 'the active inner function is marked');
  assert.match(html, /aria-current="true"/, 'the active outer tool is marked');
  assert.match(html, /aria-label="2 errors"/, 'a badge carries its meaning as text');
  assert.match(html, />Capacity</);
  // The bottom band holds the account and settings; the pin toggle that used to sit here
  // is gone, and the account is a label in a deployment rather than a menu.
  assert.match(html, /sidebar__account/, 'the account control is in the bottom band');
  assert.match(html, /Signed in as Account/, 'and names who is signed in');
  assert.match(html, /title="Settings"/);
});

test('a miniature sidebar keeps every label available to assistive technology', () => {
  const html = renderToStaticMarkup(<GlobalSidebar mode="MINIATURE" activeToolId="site_facility" />);
  assert.match(html, /sidebar--miniature/);
  assert.match(html, /class="visually-hidden">Site &amp; Facility</);
  assert.match(html, /class="visually-hidden">Projects</);
});

test('hover expansion is additive and does not change the active tool at rest', () => {
  const html = renderToStaticMarkup(
    <GlobalSidebar mode="MINIATURE" hoverExpand activeToolId="site_facility" activeFunctionId="utilities" />,
  );
  // At rest the sidebar is still compact; hover only widens it, and the active
  // tool and function are unchanged, so nothing depends on the pointer.
  assert.match(html, /sidebar--miniature/);
  assert.doesNotMatch(html, /data-hover-expanded="true"/);
  assert.match(html, /aria-current="true"/, 'the active tool is unchanged');
  // The rail renders no inner list: measured at 64px, a labelled sub-list clipped
  // "Overview" to "o." and overflowed the rail by 21px. The active function is still
  // tracked and is marked as soon as the sidebar has room to show it, which is what
  // the next assertion checks — so hover still changes nothing about active state.
  assert.doesNotMatch(html, /sidebar__functions/, 'a 64px rail cannot hold a labelled sub-list');

  const expanded = renderToStaticMarkup(
    <GlobalSidebar mode="EXPANDED" activeToolId="site_facility" activeFunctionId="utilities" />,
  );
  assert.match(expanded, /aria-current="page"/, 'the active function is marked when the list is shown');
  assert.match(expanded, />Utilities</);

  const pinned = renderToStaticMarkup(<GlobalSidebar mode="MINIATURE" hoverExpand pinned />);
  assert.match(pinned, /sidebar--miniature/, 'a pinned sidebar does not hover-expand');
});

test('tools without a declared permission are never hidden by the key set filter', () => {
  const html = renderToStaticMarkup(<GlobalSidebar grantedKeys={['asset.read']} />);
  assert.match(html, /Assets/);
  assert.match(html, /Floorplan/, 'a tool with no declared key stays reachable');
  assert.doesNotMatch(html, /Site &amp; Facility/, 'a tool whose key is absent is hidden');
});

test('tabs expose selection, unsaved state, and an accessible close control', () => {
  const html = renderToStaticMarkup(
    <OpenViewTabs
      tabs={[
        { tabId: 't1', toolId: 'site_facility', routeState: { functionId: 'overview' }, dirtyState: { dirty: true }, badge: { errors: 1, warnings: 0 } },
        { tabId: 't2', toolId: 'floorplan', routeState: {}, dirtyState: { dirty: false }, badge: null },
      ]}
      activeTabId="t1"
    />,
  );
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /aria-label="Unsaved changes"/);
  assert.match(html, /aria-label="Close Site &amp; Facility"/);
  assert.match(html, /aria-label="1 error"/);
});

test('the open project leads the tab row, and is a label rather than a control', () => {
  const html = renderToStaticMarkup(
    <OpenViewTabs
      tabs={[{ tabId: 't1', toolId: 'site_facility', routeState: {}, dirtyState: { dirty: false } }]}
      activeTabId="t1"
      projectName="Northern DC Campus"
    />,
  );

  assert.match(html, /class="tabs__project"/);
  assert.match(html, /tabs__project-name">Northern DC Campus</);
  // First in the row: the scope every tab beneath it shares. Matching `<div class="tab`
  // rather than `class="tab`, which is also a prefix of the container's own `class="tabs"`.
  // Matched by the tab's own role, not by `class="tab"` — that string is also a prefix of
  // the container's `class="tabs"`, so it matches at index 0 and the comparison is
  // meaningless. The first `role="tab"` is unambiguously a tool tab.
  assert.ok(
    html.indexOf('tabs__project') < html.indexOf('role="tab"'),
    'the project marker comes before the tool tabs',
  );

  // Not a control. The project is chosen on the Projects list, so a clickable label here
  // would be a second, quieter route to a context switch — and it must not be picked up by
  // the tablist's arrow-key movement, which reads `role="tab"` children.
  const marker = html.slice(html.indexOf('tabs__project') - 40, html.indexOf('</span>', html.indexOf('tabs__project-name')));
  assert.doesNotMatch(marker, /role="tab"/);
  assert.doesNotMatch(marker, /<button/);
  assert.match(marker, /<span/);

  // No project open means no marker, rather than an empty pill.
  const none = renderToStaticMarkup(
    <OpenViewTabs tabs={[{ tabId: 't1', toolId: 'site_facility', routeState: {}, dirtyState: { dirty: false } }]} activeTabId="t1" />,
  );
  assert.doesNotMatch(none, /tabs__project/);
});

test('the project marker is prominent and truncates rather than pushing tabs out', () => {
  // Its colour is what makes it read as the scope rather than as another tab, and the
  // truncation is what keeps a long project name from crowding the tool tabs off the row.
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.notEqual(start, -1, `expected a rule for ${selector}`);
    return css.slice(start, css.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  };

  const marker = rule('.tabs__project');
  assert.match(marker, /background: var\(--accent\)/, 'the accent fill is what distinguishes it');
  assert.match(marker, /color: var\(--surface\)/);
  assert.match(marker, /border-radius: var\(--radius-full\)/);

  const name = rule('.tabs__project-name');
  assert.match(name, /text-overflow: ellipsis/);
  assert.match(name, /overflow: hidden/);
});

test('the toolbar marks the active tool, and says how to put it down', () => {
  // Granted so that Validate — a `--primary` action — is on the row as well. The point is
  // that a mode and an action can be present at once without being confused for each other:
  // both are accent-filled, so what separates them is the class and the pressed state.
  const granted = ['facility.read', 'facility.entity.write', 'facility.validate.run'];
  const idle = renderToStaticMarkup(<ActiveToolToolbar toolId="site_facility" grantedKeys={granted} />);
  const running = renderToStaticMarkup(
    <ActiveToolToolbar toolId="site_facility" grantedKeys={granted} activeCommandId="draw_footprint" />,
  );

  // A tool that stays active while you use it is a toggle, so its state is announced as
  // one: the colour marks which command is on, and colour alone is not an announcement.
  assert.match(running, /toolbar__command--active/);
  assert.match(running, /aria-pressed="true"/);
  assert.doesNotMatch(idle, /toolbar__command--active/, 'nothing is marked active when no tool runs');
  assert.doesNotMatch(idle, /aria-pressed/, 'and no command claims a pressed state');

  // It lands on the command that was asked for, not merely the first button in the row.
  // Asserted forwards from the class: React renders `class` before the data attribute, so
  // searching backwards from it would look in the wrong half of the element.
  const activeAt = running.indexOf('toolbar__command--active');
  const element = running.slice(activeAt, running.indexOf('</button>', activeAt));
  assert.match(element, /data-command-id="draw_footprint"/, 'the active class lands on the draw command');

  // Escape is the way out, and the reader has to be told.
  assert.match(running, /Escape to stop/);

  // The mode must not be drawn as a primary command: that fill marks Validate and Publish,
  // which are actions, and a mode wearing it would read as "press me to finish". Validate
  // is on this row, so this is the place the two could actually collide.
  assert.match(running, /toolbar__command--primary/, 'the action is on the same row');
  assert.doesNotMatch(running, /toolbar__command--primary toolbar__command--active/);
  assert.doesNotMatch(running, /toolbar__command--active toolbar__command--primary/);
});

test('the toolbar hides commands the caller cannot run and explains blocked ones', () => {
  const shared = renderToStaticMarkup(
    <ActiveToolToolbar toolId="site_facility" grantedKeys={['facility.read', 'facility.import.initiate']} />,
  );
  assert.match(shared, /aria-label="Site &amp; Facility commands"/);
  assert.match(shared, /Import/);
  assert.doesNotMatch(shared, /Publish/, 'a command whose permission is absent is not drawn');

  const blocked = renderToStaticMarkup(
    <ActiveToolToolbar
      toolId="site_facility"
      grantedKeys={['facility.read', 'facility.publish']}
      disabledReasons={{ publish: 'the revision is not validated' }}
    />,
  );
  assert.match(blocked, /aria-disabled="true"/);
  assert.match(blocked, /title="the revision is not validated"/);
  assert.match(blocked, /unavailable: the revision is not validated/, 'the reason reaches assistive technology');
});

test('the toolbar slot stays present with no active tool', () => {
  const html = renderToStaticMarkup(<ActiveToolToolbar toolId={null} />);
  assert.match(html, /role="toolbar"/);
});

test('the drawer exposes its handle state and never closes a global tab', () => {
  const drawer = createBottomDrawerState();
  const closed = renderToStaticMarkup(<BottomDrawer drawer={drawer} />);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /aria-label="Workspace panels"/);

  const open = renderToStaticMarkup(<BottomDrawer drawer={{ ...drawer, open: true }} />);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /role="tablist"/);
  assert.match(open, /aria-label="Findings"/);
  assert.doesNotMatch(open, /Close Findings/, 'global tabs remain available');
});

test('confirm dialogs are modal and offer both outcomes', () => {
  const html = renderToStaticMarkup(
    <ConfirmDialog title="Discard unsaved changes?" body="Geometry was edited." confirmLabel="Discard and close" onConfirm={() => {}} onCancel={() => {}} />,
  );
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /Discard and close/);
  assert.match(html, /Keep editing/);
});

/*
 * Only the denial half is asserted here, and that is a property of what a static render can
 * resolve rather than a choice. A permission starts `null` (pending) and is only proven true
 * by the unscoped key set — which is empty in a real session, because every key these
 * controls need is project-scoped — or by a fetch, and effects do not run under
 * `renderToStaticMarkup`. The earlier version of these tests seeded the keys unscoped and so
 * passed for the wrong reason: it "proved" a grant on a gate that asked without a project,
 * which is exactly the bug that hid both controls in the browser. The grant side lives in
 * `asset-permission-scope.test.jsx`, where the gate itself is observable.
 */
test('nothing in the shell chrome needs a permission grant', () => {
  // Add files and the project context bar used to be asserted here. Both are gone rather
  // than gated: intake lives on the Assets surface, and the scenario/revision selectors
  // that needed a grant to populate were removed with the bar. What the test still holds
  // is that the always-present chrome renders for a session with no grants at all, so a
  // control that quietly depends on one cannot hide behind an empty key set.
  const html = renderApp({ initialContext: CONTEXT, keys: [] });
  assert.match(html, /class="tabs__project"/, 'the project marker renders without a grant');
  assert.match(html, /aria-label="Open views"/, 'and so does the tab strip');
  assert.doesNotMatch(html, /context-bar/, 'no context bar remains to carry a gated control');
});

test('the new-project action is hidden when nothing is granted', () => {
  assert.doesNotMatch(renderApp({ projects: [], keys: [] }), /New project/);
});

test('the project list reports loading, failure, and a missing organisation distinctly', () => {
  const loading = renderApp({ projects: [], projectsPending: true });
  assert.match(loading, /role="status"/);
  assert.match(loading, /Loading projects…/);
  assert.doesNotMatch(loading, /No projects yet/, 'a pending list must not read as empty');

  const failed = renderApp({ projects: [], projectsError: { message: 'The database is not reachable.', correlationId: 'corr-7' } });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /correlation corr-7/);

  const noOrganisation = renderApp({ projects: [], projectsNotice: 'No organisation is selected for this session, so projects cannot be listed.' });
  assert.match(noOrganisation, /No organisation is selected/);
});

test('the main view is programmatically focusable so focus can follow navigation', () => {
  const views = openViewsReducer(createOpenViewsState(), {
    type: 'OPEN',
    tabId: 'tab-sf',
    toolId: 'site_facility',
    workspaceContext: CONTEXT,
    routeState: { functionId: 'utilities' },
  });
  const html = renderApp({ initialContext: CONTEXT, initialViews: views, keys: ['facility.read'] });
  assert.match(html, /<main[^>]*tabindex="-1"/i);
  assert.match(html, /aria-label="Site &amp; Facility: Utilities"/);
});

test('icon-only controls are named and carry a tooltip', () => {
  const sidebar = renderToStaticMarkup(<GlobalSidebar activeToolId="site_facility" />);
  assert.match(sidebar, /title="Settings"/);
  assert.match(sidebar, /title="Signed in as Account"/, 'the account control carries its own tooltip');

  const tabs = renderToStaticMarkup(
    <OpenViewTabs tabs={[{ tabId: 't1', toolId: 'floorplan', routeState: {}, dirtyState: { dirty: false } }]} activeTabId="t1" />,
  );
  assert.match(tabs, /title="Close Floorplan"/);
});

test('the platform container asks for an organisation instead of showing a false empty list', () => {
  const withoutOrganisation = renderToStaticMarkup(<PlatformApp organisationId={null} />);
  assert.match(withoutOrganisation, /No organisation is selected/);

  const withOrganisation = renderToStaticMarkup(
    <PlatformApp organisationId="22222222-2222-2222-2222-222222222222" client={{ listProjects: async () => ({ data: [] }) }} />,
  );
  assert.match(withOrganisation, /Loading projects…/, 'the list starts pending, never empty');
});
