# Project Workspace UI Specification

This document defines the master application shell for the AI Infrastructure Planner. It applies to all design tools and cross-cutting workspaces described in the [platform blueprint](../architecture/ai_infrastructure_planner_blueprint.md).

## Purpose

The application is project-first. Users enter through a project list, then work within one project and revision using specialized tools. The shell preserves project, scenario, revision, and validation context while a user moves between tools; individual editors provide their own focused work surfaces within the shell.

## Information Architecture

```text
Sign in
  -> Projects
       -> Project workspace
            -> Design tools
            -> Supporting workspaces
```

| Route or state | Purpose | Project context |
| --- | --- | --- |
| `Projects` | Default destination after sign-in; browse, create, and open projects | None selected |
| `Project workspace` | Shared shell for one selected project, scenario, and revision | Required and persistent |
| `Tool view` | Active work surface for an editor or workspace | Inherits the workspace context |

The user cannot open a design tool without selecting a project. Direct links to tools resolve their project and revision first; unavailable, archived, or unauthorized revisions show an explanatory state rather than an empty tool.

## Workspace Shell

```text
+------------------+---------------------------------------------------------------+
| Product mark     | Project: Northern DC / Revision: Draft                       |
| Projects         +---------------------------------------------------------------+
|                  | Open-view tabs: Site & Facility | Floorplan | Rack | Verify    |
|                  +---------------------------------------------------------------+
|                  | Active tool toolbar: tool-provided commands                  |
| Design flow      +---------------------------------------------------------------+
|  v Site & Facility|                                                              |
|    Overview      |                                                               |
|    Import & Map  |                                                               |
|    Constraints   |                 Active tool work surface                     |
|    Utilities     |                                                               |
|  > Floorplan     |                                                               |
|  > Rack          |                                                               |
|  Network         |                                                               |
|  Route & Pathway |                                                               |
|  Cabling         |                                                               |
|  Power           |                                                               |
|  Thermal & HVAC  |                                                               |
|  Verify          |                                                               |
|                  |                                                               |
| Supporting       |                                                               |
|  Assets          |                                                               |
|  Catalog         |                                                               |
|  Workload        |                                                               |
|  Simulation      |                                                               |
|  Cost & Schedule |                                                               |
|  Deployment      |                                                               |
|  Changes         |                                                               |
|                  |                                                               |
|                  |    +---------------------------------------------+            |
|                  |    | Context: Site & Facility · Revision: Draft  |            |
|                  |    | Ask about the active tool...                |            |
|                  |    |                                             |            |
|                  |    | [ Upload ]             [ Tokens ]  [ Send ] |            |
|                  |    +---------------------------------------------+            |
| Settings         |                                                               |
+------------------+---------------------------------------------------------------+
| Bottom drawer: Findings | Activity | Jobs | Dependencies | Logs             |
+------------------+---------------------------------------------------------------+
```

The shell has six stable regions:

| Region | Responsibility |
| --- | --- |
| Global sidebar | Project entry point, tool navigation, supporting-workspace navigation, settings, and per-tool status badges |
| Project marker | The open project, as a static label leading the tab row |
| Open-view tabs | Currently open tool views within the selected project context |
| Active-tool toolbar | A stable shell-owned slot whose commands are supplied by the active tool; tool commands, dirty-state actions, and tool-level validation/publish actions live here |
| Main view | The active tool's complete work surface; the shell does not duplicate tool-local controls here. The shell-owned assistant composer floats above the bottom of this region |
| Bottom drawer | Cross-cutting, contextual panels that remain available while the active tool is open |

## UI Context

UI Context is the shared presentation-state contract for the workspace. Its purpose is to let the shell and every tool render a consistent interface without passing layout, visibility, theme, or interaction preferences through tool-specific props and routes.

UI Context contains presentation state only. It must not contain authoritative project entities, authorization decisions, active revision data, validation results, or unsaved tool mutations. Those belong respectively to Workspace Context, permission services, validation services, and the owning tool's draft state.

### Shared Context Shape

```text
UIContext
  color_scheme: SYSTEM | LIGHT | DARK
  contrast_mode: STANDARD | HIGH
  density: COMPACT | COMFORTABLE
  motion: FULL | REDUCED
  locale
  layout: WorkspaceLayout
  visibility: ElementVisibility
  interaction: InteractionPreferences

WorkspaceLayout
  sidebar_mode: EXPANDED | MINIATURE
  sidebar_pinned: boolean
  sidebar_width_px
  bottom_drawer_open: boolean
  bottom_drawer_height_px
  main_view_mode: DEFAULT | FOCUS
  assistant_open: boolean

ElementVisibility
  sidebar: boolean
  open_view_tabs: boolean
  bottom_drawer: boolean
  assistant_composer: boolean
  status_badges: boolean
  tooltips: boolean

InteractionPreferences
  hover_expand_sidebar: boolean
  confirm_context_switch: boolean
  restore_open_views: boolean
  restore_drawer_state: boolean
```

| Context area | Purpose | Constraints |
| --- | --- | --- |
| Color scheme and contrast | Select system, light, or dark appearance and standard/high contrast variants | Color never carries meaning alone. Semantic error, warning, success, and selection tokens remain available in every scheme. Every text token meets WCAG AA (4.5:1) against **every** surface it can sit on, tinted ones included — the tinted surfaces are the worst case and the one nobody checks. |
| Density and motion | Control information density and animation behavior | Compact density may reduce spacing but cannot hide required labels, keyboard targets, validation counts, or primary actions. Reduced motion honors system preference unless a user explicitly chooses otherwise. |
| Layout | Coordinate sidebar mode/width, bottom-drawer state/height, assistant-composer state, and optional focus mode | A layout change cannot remove required project context, hide unsaved changes, or prevent access to a tool's primary save/validate action. Expanding or collapsing the assistant composer cannot cover that action or the project marker. |
| Element visibility | Express whether shell regions and nonessential affordances are currently shown | There is no `project_context_bar` region to hide — it was removed from every view. The project marker leads the tab row and is governed by `open_view_tabs`. Critical validation states remain discoverable even if badges or the drawer are hidden. Hiding `assistant_composer` leaves the assistant reachable from the shell command surface rather than making it unavailable. |
| Interaction preferences | Coordinate hover expansion, context-switch confirmation, and safe state restoration | Keyboard and touch alternatives must remain available when hover behavior is disabled. |

### Text Contrast

Three text steps, each about 1.7x the last in contrast against the surfaces it sits on. Measured against `--surface` in the light scheme the ladder is 18.2 : 9.3 : 5.7, and every one of them clears 4.5:1 on the tinted surfaces as well as the plain ones.

The rule matters because the failure it prevents is invisible to review. `--text-subtle` spent its life at 3.1:1 on white and 2.7:1 on the tinted fills while carrying captions, meta, and hints — small text that needs 4.5:1. Nothing in the app looked broken; it read as "washed out", which is a taste complaint until you compute the ratio and find it is an accessibility defect. A hex code does not announce its ratio, so the numbers live in `apps/web/src/tests/text-contrast.test.js`, which recomputes them from the stylesheet and fails on any surface that drops below the floor.

Hierarchy is the reason there are two greys rather than one, so darkening them until they meet the floor is only half the fix: the step between them must survive. The test asserts each step is at least 1.4x the next, which catches the other way to pass — darkening both until they are the same colour and the hierarchy has nothing left to say.

The dark scheme is not covered by that test, and that is a decision rather than an oversight: its `--text-subtle` measures 3.96:1, the same class of defect, and it is left alone because darkening the light scheme is not a request to restyle the dark one.

### Ownership and Persistence

| State class | Owner | Persistence scope |
| --- | --- | --- |
| Appearance preferences | UI Context provider | Per user and device class; `color_scheme`, contrast, density, motion, locale, sidebar preference |
| Workspace layout session | UI Context provider | Per user, project, scenario, and revision where compatible; drawer state, dimensions, active shell regions, focus mode |
| Tool-local presentation state | Owning tool | Tool route/session state; selection, viewport, inspector tab, and tool-specific panel visibility |
| Domain and workflow state | Domain service or owning tool | Never stored in UI Context |
| Assistant conversation, attachments, and token usage | Assistant and usage services | Scoped to the workspace context; never stored in UI Context |

When a user changes project, scenario, or revision, UI Context retains user preferences but restores workspace layout only when the saved state is compatible with the new context. Contextual tabs, selections, and entity-specific layout state are discarded or marked stale when their referenced revision changes.

### Update Rules

1. The shell exposes typed UI Context actions such as `setColorScheme`, `setDensity`, `setSidebarMode`, `setBottomDrawerState`, and `setFocusMode`.
2. Tools consume read-only UI Context and request changes through these actions; they do not mutate context internals or another tool's presentation state.
3. The shell resolves responsive overrides after applying user preference. For example, a miniature sidebar may become a closed navigation drawer on a small viewport.
4. Focus mode may collapse nonessential shell regions, but it cannot hide the project marker, leave the user without a route back to navigation, or suppress error status.
5. UI Context changes are local presentation events. They do not create project revisions, mark a design dirty, or emit engineering-change events.

## Project List Entry

After sign-in, the main view shows `Projects`. The project list is centered in a readable constrained content area, while the global sidebar remains available.

```text
+------------------+---------------------------------------------------------------+
| Product mark     | Projects                                             New project |
| Projects         +---------------------------------------------------------------+
|                  | Search projects...              Filter: All status             |
|                  |                                                               |
|                  | Northern DC       Shanghai     Draft       3 findings          |
|                  | Training Campus   Oregon       Validated   Updated 2h ago      |
|                  | Edge Expansion    Tokyo        Approved    Updated yesterday   |
|                  |                                                               |
+------------------+---------------------------------------------------------------+
```

Each project row or card provides its name, primary site or region, active revision lifecycle state, validation summary, last-updated time, and access state. Creating or opening a project enters its workspace and opens the default landing view: Site and Facility when no facility context exists, otherwise the most recently used permitted tool. The project list itself never opens a tool tab.

## Sidebar Navigation

### Two-level navigation model

The sidebar is an elastic two-level collection:

* **Outer level — workspace tools.** These are the design and supporting workspaces that own a domain, such as Site and Facility, Floorplan, Rack, Network, Cabling, Power, Thermal and HVAC, Verify, Assets, Catalog, Simulation, or Changes.
* **Inner level — tool functions.** These are the active tool's subviews or modes, such as Site and Facility Overview, Import and Map, Constraints, Utilities, Capacity, Phasing, and Validate. Each tool declares its own inner collection; the shell does not hard-code those functions.

Only one outer tool is expanded at a time. Selecting an outer tool activates its existing open view (or opens one), expands its inner functions, and collapses the previously expanded tool. Selecting an inner function keeps the same outer tool active and changes that tool's route state or subview; it does not create a second global tab. A tool may expose a function in its active-tool toolbar, context menu, or inspector as well, but the sidebar remains the stable entry point for navigation.

Sidebar selection follows the active open-view tab rather than maintaining a competing navigation state. When a tab is activated—by clicking the tab, opening a deep link, or following a drawer finding—the shell reads its `tool_id` and `route_state`, activates that outer tool, expands it, collapses all other outer tools, and highlights the matching inner function. If the route has no matching inner function, the tool's default function (normally Overview) is highlighted.

The sidebar does not create duplicated tabs for the same singleton tool and project context. Tool-local subviews, such as a particular rack or a validation finding, are represented in the tool's own state or URL parameters, not as separate global tabs unless a future tool explicitly requires multi-document behavior.

### Outer tool order and groups

The outer level orders design tools by their intended workflow: Site and Facility, Floorplan, Rack, Network, Route and Pathway, Cabling, Power, Thermal and HVAC, and Verify. After a visual divider, it lists Assets, Catalog, Workload and Capacity, Simulation, Cost and Schedule, Deployment and Commissioning, and Constraints and Changes. `Projects` remains fixed above these groups; Settings remains fixed at the bottom.

This order guides normal work but never blocks navigation. A user may enter any authorized tool; tool-specific prerequisites and validation findings explain incomplete inputs.

### Expanded and Miniature States

| State | Behavior |
| --- | --- |
| Expanded | Default desktop state. Shows each outer tool with icon, label, active state, and compact status badge. The active outer tool alone reveals its inner function list beneath it; the sidebar height adapts to that list. |
| Miniature | Shows outer-tool icons at a stable narrow width. Inner functions appear in an adjacent flyout on hover/focus or in an explicit keyboard/touch expansion; labels and active function remain available. |
| Hover expansion | A miniature sidebar expands while pointer hover is within it and collapses after pointer exit, unless pinned. Hover expansion reveals the active outer tool's inner functions but never changes the active tool. |
| Pinned expansion | A persistent toggle lets users keep either state. The current preference is stored per user and device class. |
| Keyboard and touch | Outer tools and inner functions use nested disclosure semantics and are fully keyboard accessible. On touch or narrow screens, the sidebar opens as an explicit overlay or drawer; no workflow depends on hover. |

Icons use familiar symbols and every icon-only control has a tooltip and accessible name. The active outer tool and inner function must be visually distinct without relying only on color. Sidebar badges show only compact status: error count, warning count, processing state, or a completion check. Detailed findings remain in Verify or the owning tool.

## Active-Tool Toolbar

The shell renders one consistent toolbar slot below the open-view tabs. The active tool supplies the commands in that slot through a typed tool-toolbar contract; the shell owns placement, overflow, focus behavior, and responsive treatment.

There is no context bar. The project is named by a static marker leading the tab strip, and the revision's state — lifecycle, validation, approval, unsaved — is carried by the surface that shows the work, so it sits beside the revision it describes rather than in a bar above every tool. Tool-level actions such as Site and Facility `Import`, `Validate`, or `Publish` appear in the active-tool toolbar, subject to that tool's permissions and lifecycle rules.

Each tool toolbar declares primary commands, secondary overflow commands, disabled reasons, dirty-state behavior, and required context. Commands that operate on a selected entity remain in the tool's canvas context menu or inspector; they do not become global shell controls. A tool may also render a compact canvas-navigation toolbar inside its main view for selection, pan/zoom, measure, snapping, and drawing modes.

When no tool is active, the slot is empty or shows project-level actions only. On narrow screens, the slot becomes horizontally scrollable or an overflow menu; it must retain the active tool identity and access to its primary save/validate action.

## Open-View Tabs

Tabs are a working set, not a second navigation tree.

| Rule | Behavior |
| --- | --- |
| Scope | Tabs belong to exactly one project, scenario, and revision. Changing that context resolves to the matching tab set or opens a clean workspace. |
| Opening | Sidebar outer-tool selection activates an existing tab or opens one new tab, expands that tool, and selects its default or requested inner function. |
| Tab activation | Clicking a tab, opening a deep link, or navigating from a drawer finding synchronizes the sidebar to the tab's `tool_id` and `route_state`: that outer tool expands, all others collapse, and the matching inner function is highlighted. |
| Inner-function navigation | Selecting an inner function updates the active tab's route state without creating another global tab. |
| Closing | Users can close inactive tabs. Closing the active tab activates the most recently used remaining tab; if none remain, the workspace opens its project overview. |
| Persistence | Restore open tabs and their ordering per user and project context. Do not restore unsaved tool-local mutations without that tool's explicit draft-recovery support. |
| Dirty state | A modified draft shows a non-color-only unsaved indicator. Closing it requires the tool to save, discard, or cancel according to its own draft contract. |
| Overflow | When space is insufficient, tabs use horizontal scrolling and an overflow menu. Tabs do not compress labels until they become unreadable. |

## Project Assets and Import Entry Points

Files are project assets, not tool documents ([project-assets.md](project-assets.md)). The shell owns the asset surface and the shared import entry points; tools consume assets through bindings.

### Assets Surface

`Assets` is a supporting workspace, not a design tool. It lists project assets with kind, media type, version, size, uploader, scan state, access classification, and the tools that bind them. It supports search, filtering, upload, new version, download, archive, and delete subject to permissions and reference checks. It never edits design entities.

### Import Entry Points

| Entry point | Behavior |
| --- | --- |
| Project-level `Add files` | Creates a project asset with no tool binding. Available from the Assets surface and the shell's own file intake. |
| Drop on the project workspace or Assets surface | Same as `Add files`; a multi-file drop is a batch. |
| Tool Import command | Creates a project asset through the same intake path, then opens that tool's binding review in the active revision. |
| Drop on a tool canvas or inspector | Creates the asset and offers the drop target as the initial mapping hint. |
| Assistant composer attachment | Uploads as a temporary attachment; promotion to a project asset requires explicit confirmation and the asset permission. |
| API or integration client | Creates an asset through the asset API. |

Rules:

1. Every entry point uses the same intake API, checksum verification, malware scan, and authorization. No tool may store imported bytes privately.
2. Creating an asset and binding it are separate operations; a failed binding leaves a valid unbound asset.
3. The asset picker lets a tool select an existing project asset and an exact version and representation. A tool never re-uploads an asset that already exists.
4. When a newer version of a bound asset exists, the tool shows an upgrade affordance; upgrading is explicit and re-enters that tool's review workflow.
5. Quarantined, archived, or unauthorized assets are not selectable, and the reason is shown as text.
6. The Assets surface and every import entry point are keyboard reachable; scan and processing state are conveyed as text plus icon, never color alone.

## Bottom Drawer

The bottom drawer is a shell-level workspace for information that spans tools or benefits from persistent access while editing. It is separate from an editor's right inspector or tool-local panels. The drawer can be collapsed, expanded, resized vertically, and switched between multiple tabs without changing the active main-view tool.

### Drawer Tabs

The default tabs are:

| Tab | Purpose | Owner |
| --- | --- | --- |
| Findings | Aggregate validation errors, warnings, and unresolved capability coverage; filter by active tool, severity, entity, and revision | Verify service and shell presentation |
| Activity | Revision changes, imports, comments, shares, and approvals relevant to the current project context | Collaboration/change-management service |
| Jobs | Import, validation, export, and simulation jobs with progress and retry/cancel actions where authorized | Job service |
| Dependencies | Upstream/downstream impact of the selected entity or current draft change | Shared dependency/impact service |
| Logs | Technical operation and adapter logs for the selected job or import, subject to role-based access | Platform operations service |

Tools may register contextual drawer tabs, for example `Import Mapping` from Site and Facility or `Route Diagnostics` from Cabling. A contextual tab must declare its `tool_id`, `workspace_context`, label, icon, closeability, and the entity/job that it references. It is removed or marked stale when its referenced revision no longer matches the active context.

### Drawer Behavior

| Rule | Behavior |
| --- | --- |
| Visibility | The drawer is collapsed by default when no unread findings, active jobs, or pinned contextual tabs exist. A badge on the drawer handle shows concise counts. |
| Expansion | Clicking the handle, selecting a drawer tab, or invoking the drawer shortcut expands it. It never steals focus from an in-progress main-view edit without an explicit user action. |
| Resizing | Desktop users can drag the top edge within configured minimum and maximum heights. The preference is retained per user and device class. |
| Tab selection | Only one drawer tab is visible at a time. Selecting a finding, job, or dependency may navigate the main view to the owning tool after confirmation when unsaved edits would be affected. |
| Closeability | Global tabs remain available. Contextual tabs may be closed and can be reopened by the owning tool. Closing a tab does not delete its underlying finding, job, or log. |
| Persistence | Selected tab, open contextual tabs, collapsed/expanded state, and height persist per project/scenario/revision where safe. Do not restore stale tabs across incompatible revisions. |
| Overflow | When tabs exceed available width, use horizontal scrolling and an overflow menu. Preserve unread/error badges on both visible and overflowed tabs. |
| Dirty state | Drawer actions that would change a design use the owning tool's draft command and dirty-state rules; viewing a drawer tab is read-only by default. |

### Drawer State Contract

```text
BottomDrawer
  open: boolean
  height_px
  active_tab_id
  tabs[]: DrawerTab

DrawerTab
  tab_id
  kind: GLOBAL | CONTEXTUAL
  label
  icon
  tool_id?
  workspace_context
  entity_refs[]
  job_id?
  closeable
  unread_count
  severity: NONE | INFO | WARNING | ERROR
  route_state
```

The shell owns the drawer frame, tab ordering, active tab, and persistence. A tab provider owns only its tab content and may request open, update, or close operations through the shell API. Providers must not directly resize or replace the drawer, change the active main-view tool, or mutate another provider's tab.

## Workspace Assistant (Context-Aware Chatbox)

The workspace assistant is a shell-owned conversational composer that floats over the active tool's work surface. It is not a tool: it owns no route, no open-view tab, and no domain data. It lets a user ask questions and request actions against whatever tool, selection, and revision is currently active, without leaving that tool.

### Placement and Appearance

* Anchored to the bottom of the main view and horizontally centered within the available work-surface width.
* Keeps a minimum inline padding between itself and the main-view edges (default `--space-6`, `--space-4` at compact density) and caps its width with a content max-width token so the message area stays readable on wide canvases.
* Uses the shared radius and elevation tokens: rounded corners on every side plus a soft border shadow that separates it from the tool canvas.
* Floats above the work surface without capturing it: pointer input outside the composer footprint passes through to the canvas, and the shell keeps a bottom inset so the collapsed composer never covers the active tool's primary save/validate action.
* Collapses to a compact launcher pill that preserves in-progress and unread state. Open and collapsed state is UI Context layout state, persisted per user and device class.

### Context Awareness

Context awareness means the composer adapts its scope label, grounding, suggestions, attachment permissions, and action proposals to the active open view.

```text
AssistantComposerContext
  workspace_context
  tool_id
  route_state
  selection_refs[]
  draft_summary
  available_actions[]
  attachment_policy
  context_token
```

| Aspect | Adaptation |
| --- | --- |
| Scope label | Always shows the active tool and active revision, for example `Site & Facility · Revision: Draft`, so a user can never confuse which context an answer describes |
| Grounding | Each turn carries `workspace_context`, `tool_id`, `route_state`, and the current selection, and the assistant cites the revision and entity references it used. The whole workspace is never uploaded implicitly |
| Suggestions | Empty-state prompts and quick actions come from the active tool's declared assistant capabilities |
| Attachments | Accepted file types, size limits, and required permissions come from the active tool's `attachment_policy` |
| Action proposals | The assistant may propose tool actions, but a proposal runs only through the owning tool's command, permission check, and draft/dirty-state rules |
| Context switch | Switching tools re-scopes the composer; switching project, scenario, or revision starts a new conversation thread |

Tools declare these capabilities through the same typed contract family as the active-tool toolbar. They must not own conversation history, token accounting, or the composer frame.

### Message Area

The message area is multi-line and extensible:

* Grows from one line to a configured maximum (default six lines), then scrolls internally; it never displaces the toolbar or the tool surface.
* `Enter` sends and `Shift+Enter` inserts a newline. Modified `Enter` and IME composition are honored: `Enter` never sends while a composition is in progress.
* Supports paste, undo/redo, and file drag-and-drop when the attachment policy permits it.
* Shows a remaining-budget hint as the draft approaches the per-message limit without blocking typing.
* Retains its draft per `(project, scenario, revision, tool)` until it is sent or cleared, consistent with the shell rule that work is never discarded silently.
* Is a labeled textbox whose accessible name includes the active tool.

### Toolbar

The toolbar is one row inside the composer: a leading group, a trailing group, and an optional status strip.

```text
+---------------------------------------------+
| Context: Site & Facility · Revision: Draft  |
| Ask about the active tool...                |
|                                             |
| [ Upload ]             [ Tokens ]  [ Send ] |
+---------------------------------------------+
```

| Control | Alignment | Behavior |
| --- | --- | --- |
| Upload files | Leading (left) | Opens the file picker and accepts only what the active tool's `attachment_policy` allows. Selected files appear as removable chips above the toolbar and attach to the next sent message only; uploading never sends automatically. |
| Token usage | Trailing, immediately before Send | Opens the usage popover described below. Icon-plus-label control with an accessible name and expanded state. |
| Send | Trailing (right) | The composer's primary action. Disabled only when the draft and attachment set are both empty, or while a turn streams; a tooltip states the reason. While streaming it becomes `Stop`, which cancels the in-flight turn and keeps the partial reply. |

### Token Usage

Clicking the token usage button opens a non-modal popover anchored above the toolbar. It separates two scopes explicitly, and lays them out as **two columns** rather than one after another: the only question asked of these numbers is a comparison — how much of the allowance this conversation accounts for — and a comparison cannot be read down a single stack. Both columns carry the same rows in the same order, with grouped digits in tabular figures so they line up digit for digit, and the columns fall back to a single column only when the composer is too narrow to read across.

| Scope | Meaning | Reset |
| --- | --- | --- |
| This chat, since last load | Tokens consumed by the current composer session across every turn since the page loaded, split into input, output, cached, and total | Cleared on reload; a project, scenario, or revision change starts a new conversation and a new counter |
| Overall | Cumulative tokens for the signed-in user across all projects, conversations, and tools, split the same way, with the current period and any plan quota | Never reset by the client |

```text
TokenUsage
  scope: CHAT_SESSION | USER_OVERALL
  input_tokens
  output_tokens
  cached_input_tokens
  cached_output_tokens
  total_tokens
  estimated: boolean
  period_start
  period_end
  quota_tokens?
  remaining_tokens?
```

* Values use grouped digits and plain-language labels; meaning is never carried by color alone. Cached tokens are reported beside the totals and never folded into them: a cached prompt is the same tokens at a fraction of the rate, so "how much of this was already warm" and "how much did this cost" are different questions. Only the overall column states a quota, because a single conversation has no allowance of its own.
* When a plan or rate limit applies, the popover shows used, remaining, and reset time, and near-limit state carries text plus an icon.
* It refreshes when a turn completes; while a turn streams it may show an estimate explicitly marked `estimating`.
* Token accounting is owned by the assistant and usage services. The composer renders what the service reports, never computes or caches authoritative usage, and stores nothing in UI Context.
* `Escape` closes the popover and returns focus to the button; the draft is untouched.

### Conversation Surface

The transcript is part of the same shell-owned overlay, not a new open-view tab.

* The composer expands upward into a transcript panel that lists turns oldest to newest and scrolls internally; collapsing returns to the composer-only footprint.
* Each turn is attributed to its side of the conversation: a user turn is aligned right in an accent-tinted bubble, an assistant turn left in a neutral one.
* The composer header states the acting context, so a turn does not repeat it. A turn marks its scope — tool, revision, and referenced entities — only when that scope differs from the previous turn's, which is the case attribution has to survive after the active tool changes; referenced entities always stay attached to the turn that named them.
* Hovering or focusing a turn reveals a copy control that puts the turn's visible text on the clipboard. The control keeps its place in the layout and is keyboard reachable.
* A turn that proposes a design change renders as a proposal card naming the owning tool; it is never applied automatically.
* Applying a proposal requires explicit confirmation and then follows the owning tool's command, permission, validation, and dirty-state contract.
* Failed turns keep the draft and attachments, expose a retry action with a correlation id, and never silently drop a turn.
* Transcripts and attachments respect the access rules of their workspace context; sharing or exporting a transcript is governed by the collaboration service, not the composer.

### Context Switching and Persistence

| Event | Composer behavior |
| --- | --- |
| Active tool changes | Re-scope the label, capabilities, and attachment policy; keep the transcript, but mark each existing turn with the tool context that produced it, and keep each tool's draft separately |
| Selection changes | Update the grounding selection for the next turn; do not resend or rewrite the conversation |
| Scenario, revision, or project changes | Start a new thread bound to the new workspace context; prompt before discarding a streaming turn, and drop attachments that reference the previous revision |
| Reload | The assistant service restores the thread: the client remembers which session belongs to the context and rehydrates its turns from the object store, falling back to the newest session for the context. The draft is restored when the same workspace context returns and the owning tool permits draft recovery; the since-load chat token counter begins fresh, because it counts what this open chat has spent |
| New conversation | Starting a new chat clears the transcript, the since-load chat counter, and the context's remembered session, and leaves the previous sessions stored and listed |

### Accessibility and Responsive Behavior

* All composer controls are keyboard reachable with visible focus and accessible names; the token usage control exposes its expanded state.
* New assistant messages are announced politely; streamed token-by-token updates are never announced.
* Focus order within the composer is message area, upload, token usage, and Send. `Escape` in the empty message area releases focus back to the previously focused tool control.
* On narrow viewports the composer spans the main-view width with reduced inline padding, stays above the bottom drawer handle, and keeps Send reachable; the toolbar never wraps in a way that hides a control.
* The expanded transcript becomes a bottom sheet with a visible drag handle and must not cover the primary save/validate action without an explicit expansion gesture.
* Reduced motion removes the composer's expand/collapse animation but not its state change.

## Project Context and Status

### Where the controls live

There is no project context bar. It was removed from every view, and the project is named
where the reader is already looking — as a **static marker leading the tab row**, ahead of
the open tool tabs.

That marker is a label, not a control: the project is chosen on the `Projects` list, and a
clickable name in the tab strip would be a second, quieter route to a context switch.

The rest of what the bar held moved rather than disappeared:

* **Project name** leads the tab row, filled with `--accent` so it reads as the scope every
  tab beneath it shares rather than as another tab. It truncates rather than pushing the
  tool tabs out of the row.
* **Lifecycle state**, **aggregate validation**, the **approval indicator** and the
  **unsaved indicator** are in the Site & Facility frame's side column, beside the revision
  they describe. `.chip--lifecycle` and `.chip--validation` must not be hidden at narrow
  widths: they are the only place that state is shown.
* **The account** and **the colour scheme** are in the sidebar's bottom band. Both are
  properties of how the workspace looks to *this* person rather than of the project.
* **The build** closes the Settings menu in that same band. It reports the commit the
  browser is running, and it is a build-time constant rather than a read from the API.
* **Add files** is gone. Intake lives on the Assets surface, and a second entry point that
  had to be permission-gated was a second thing to keep correct.
* **Share** is gone. It was never supplied by any caller, so it rendered, was gated on
  nothing, and did nothing when pressed.

The colour scheme is a **menu**, not the two-state toggle it was. `SYSTEM` is the default and
the state a user most often wants back, and a toggle can only move between light and dark —
once pressed there was no way to return to following the system.

### Scenario and revision are chosen, not switched

There is no scenario or revision selector anywhere in a workspace. Both were removed with the
bar, and the feature was dropped rather than moved: the project is opened from the `Projects`
list, and a surface that can silently move the reader to a different revision is the opposite
of the attribution every view is supposed to carry.

The consequence is deliberate and worth stating: **changing revision means leaving the
workspace.** Every tool view, diagnostic, and export must still display or retain the active
revision ID, so a result can be attributed to an immutable snapshot after the fact.

## Interaction and State Contract

```text
WorkspaceContext
  project_id
  scenario_id
  revision_id
  lifecycle_state
  approval_attestation_id?
  validation_summary

OpenView
  tool_id
  workspace_context
  route_state
  dirty_state
  last_activated_at
```

The shell owns `WorkspaceContext`, `UIContext`, the open-tab set, sidebar state, global navigation, and the assistant composer frame and placement. The assistant and usage services own conversation content, attachments, and token accounting. A tool owns only `route_state`, its internal selection, viewport, inspector panels, and draft state. Tools report dirty state and validation summary changes to the shell; they must not change the active project, scenario, revision, or global navigation directly.

## Responsive and Accessibility Requirements

* Desktop uses the persistent sidebar and tab strip shown above.
* On smaller viewports, the sidebar becomes an explicit drawer, while the project marker and the tabs become a scrollable strip or compact view switcher.
* On smaller viewports, the bottom drawer becomes a full-width bottom sheet with a horizontally scrollable tab strip; it must not cover the primary save/validate action without an explicit expansion gesture.
* All primary actions, tabs, sidebar items, and sidebar pin controls are keyboard reachable with visible focus.
* The drawer handle, drawer tabs, resize affordance, and close buttons are keyboard reachable with visible focus. Tabs expose selected state, unread count, and severity text to assistive technology.
* The assistant composer, its upload, token usage, and Send controls, and the token usage popover are keyboard reachable with visible focus and accessible names; the composer does not trap focus and honors reduced motion.
* Sidebar hover behavior is additive only; equivalent controls exist for keyboard and touch.
* Tooltips name icon-only controls. Validation state uses text or numeric labels in addition to color.
* Opening a project, switching tools, and switching tabs preserve focus predictably. Tool content owns focus after navigation completes.

## Acceptance Criteria

1. After sign-in, users see the project list rather than an empty editor.
2. Opening a project establishes one visible project, scenario, revision, and validation context before any tool renders.
3. Clicking a sidebar tool activates its open tab or opens exactly one tab for the active context.
4. The expanded and miniature sidebar states work with pointer, keyboard, and touch interaction.
5. Tool badges expose concise validation status and link to the owning tool or Verify without hiding the active workspace.
6. Switching project, scenario, or revision cannot discard unsaved work silently.
7. Every view is attributable to an immutable project revision.
8. The bottom drawer supports multiple global and contextual tabs, preserves their state per compatible workspace context, and does not replace the main-view tab set.
9. UI Context shares appearance, layout, visibility, and interaction preferences across the workspace without storing authoritative design or workflow state.
10. The assistant composer is centered in the main view with inline padding, rounded corners, and elevation; it never covers the active tool's primary save/validate action, and it opens, collapses, and takes focus from the keyboard.
11. Composer scope label, grounding context, attachments, and proposed actions follow the active tool and revision; a proposed design change never applies without explicit confirmation through the owning tool's command.
12. The token usage popover reports tokens for the current chat since load and overall user usage as separate scopes, read from the usage service rather than computed or stored by the shell.
13. Any file imported from any entry point becomes a project asset addressable by every authorized tool in the project.
14. The Assets surface lists assets with version, scan state, classification, and bound tools, and never edits design data.
15. A tool binding pins an exact asset version and representation, and a newer asset version never changes it silently.
