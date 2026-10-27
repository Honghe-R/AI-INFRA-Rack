# Site and Facility Editor UI Pattern

This workbench runs inside the shared [project workspace shell](../../workspace/ui-pattern.md). It owns only its tool-local work surface. The tool's declarations to the shared assistant are in [Assistant Integration](assistant-integration.md).

## Workbench Layout

```text
+----------------------------------------------------------------------------+
| Workspace project context: Project / Scenario / Revision / Collaboration   |
+----------------------------------------------------------------------------+
| Open tool tabs: Site and Facility | Floorplan | Verify                     |
+----------------------------------------------------------------------------+
| Site and Facility toolbar: Import | Validate | Publish | Compare           |
+--------------------+-----------------------------------+-------------------+
| Hierarchy and      | Site plan / map / floor canvas    | Context inspector |
| layers             |                                   |                   |
| - Site             | [parcel, buildings, utility       | Tabs:             |
| - Parcel           |  routes, equipment yards, hazard  | Overview          |
| - Buildings        |  zones, scale and coordinates]    | Utilities         |
| - Utility feeds    |                                   | Environment       |
| - Cooling sources  |                                   | Phasing           |
| - Phases           |                                   | Assumptions       |
|                    |                                   |                   |
+--------------------+-----------------------------------+-------------------+
| Capacity summary: power | cooling | water | floor area | validation findings |
+----------------------------------------------------------------------------+
```

| Region | Behavior |
| --- | --- |
| Project context bar | Owned by the workspace shell; shows project, scenario, revision, lifecycle, collaboration, and aggregate validation state. |
| Active-tool toolbar | The shell-provided toolbar slot populated by Site and Facility commands such as Import, Validate, and Publish. |
| Hierarchy and layers | Browses facility entities and filters layers by facilities, utilities, hazards, phases, and validation severity. |
| Canvas | Supports map and site-plan modes, selection, snapping, dimensions, layer visibility, and overlays for setbacks, capacity routes, and failure domains. A selected building can hand off its geometry to the Floorplan Editor. |
| Context inspector | Edits only the selected entity through Overview, Utilities, Environment, Phasing, Documents, and Assumptions tabs. Imported values display their source and effective date. |
| Bottom drawer | Shows capacity budgets, import results, validation findings, and downstream impact. Selecting a finding highlights its geometry and opens the owning inspector field. |

## Route States

Sidebar inner functions change the tool's `route_state` without opening a new tab. Every state keeps the hierarchy, canvas, inspector, and bottom drawer available unless stated otherwise.

| `route_state` | Sidebar function | Default canvas mode | Primary panel |
| --- | --- | --- | --- |
| `overview` | Overview | Site plan (fit to site) | Envelope summary, coverage, capability states |
| `import` | Import & Map | Source reference overlay | Binding review (built: steps 1-2 as a route surface, see "Import Flow") |
| `constraints` | Constraints | Constraint overlay visible | Spatial and environmental constraint list and rules |
| `utilities` | Utilities | Utility and failure-domain overlay | Utility sources, interfaces, and reserves |
| `capacity` | Capacity | Capacity route overlay | Budgets, availability, allocations, demand history |
| `phasing` | Phasing | Phase-colored containers | Phase list, dependencies, capability availability |
| `validate` | Validate | Finding overlay | Validation runs, findings, coverage derivation |

Additional route parameters do not create new sidebar entries: `?entity=<uuid>` selects an entity, `?geometry=<uuid>` selects a geometry record, `?finding=<constraint_id>` focuses a diagnostic, `?compare=<revisionId>` enters compare mode, and `?binding=<bindingId>` reopens an asset binding. Sidebar highlight follows the active tab's `route_state`; an unknown route state falls back to `overview`.

## Import Flow

Import opens in a focused side sheet:

1. Choose an existing project asset version, or add a new file. Adding uses the shared intake path and produces a [project asset](../../workspace/project-assets.md) available to every tool in the project.
2. Inspect the selected asset representation: layers, blocks, KML feature groups, or the IFC spatial structure and property sets.
3. Confirm source units and coordinate reference system, or define a reviewed transform.
4. Map source features to normalized facility entity types.
5. Resolve ambiguities and review import diagnostics.
6. Preview the merge against the current draft, resolve conflicts, and apply.
7. The draft is updated and the binding records the exact asset version; the asset and its original bytes remain immutable and shared.

The import side sheet lists assets already in the project, so a user can bind a file that another tool imported. When a newer version of a bound asset exists, the sheet and the affected entities show an upgrade affordance; upgrading is explicit and re-runs transform and mapping review.

**As built, steps 1 and 2 are a route surface rather than a side sheet.** `Import & Map` is declared in the function table below as a navigation target and the sidebar highlights it as a page, so it renders in the main view exactly as `Validate` does, with `import` on the toolbar opening it. The sheet-versus-route question is a presentation choice, and the route is the one that lets the two halves of a binding decision — what to bind on the left, what the revision already consumes on the right — be read against each other. Steps 3 to 7 (transform review, mapping, preview, apply) have no command behind them yet and are not offered; the surface says so rather than showing controls that would do nothing.

The canvas may show an imported document as a visual reference before mapping. Unreviewed source features are visually distinct from provisional and validated normalized geometry. Adapter support, fidelity limits, and per-format behavior are listed in the shared [workspace import and conversion framework](../../workspace/import-adapters.md); the facility mapping is in [Import Mapping](import-adapters.md).

The merge preview is mandatory. It lists created entities, field-level updates, and conflicts with user-authored entities, including containers and levels proposed from a BIM spatial structure. Applying never overwrites user-authored values; the user resolves each conflict as keep-existing, take-imported, or create-alongside before the change set is submitted.

## Compare and Diff

Compare is a read-only canvas mode entered from the toolbar or `?compare=`:

* Two revisions are rendered side by side or as an overlay; the user chooses the mode.
* Entity, geometry, coverage, capacity, phase, and diagnostic differences are listed in the bottom drawer and can be filtered by capability and entity type.
* Changed entities are visually distinct by addition, modification, or removal; validation state is never conveyed by color alone.
* Selecting a difference navigates the inspector to the owning entity in the corresponding revision context.
* Compare never creates a revision, marks the draft dirty, or emits a change event.

## UI Editing Tool Palette

The workspace sidebar is reserved for entering or switching between workflow-level editors. The workspace shell provides the active-tool toolbar slot; this editor supplies its tool-level commands there. Actions that depend on a canvas target remain in the canvas context menu or inspector. Availability is determined by selection, active layer, lifecycle state, permissions, and whether a feature is imported or normalized.

### Sidebar functions

When **Site and Facility** is the active outer workspace tool, it expands these inner functions: **Overview**, **Import and Map**, **Constraints**, **Utilities**, **Capacity**, **Phasing**, and **Validate**. Selecting one changes the editor's subview or route state while keeping the same tool tab active. These entries are navigation targets, not duplicate command palettes; their actions continue to follow the toolbar, context-menu, and inspector rules below.

### Toolbar

The active-tool toolbar exposes workflow-level commands:

* Import/map, Validate, Publish, and Compare revisions, with dirty-state and permission handling supplied by the workspace shell.
* Each command declares its required permission key from [Backend API Contracts](backend-api-contracts.md), its disabled reason, and its lifecycle precondition. `Publish` is disabled unless the revision is `VALIDATED` by a clean full run and the caller holds `facility.publish`.

The row holds two groups, and the split is the point of it. The **leading** group holds the tools that add to the design — Add interface, Draw footprint, Import — and sits where the eye starts. The **trailing** group holds the governance pair, Validate and Publish: both judge or freeze the whole revision rather than author it, and both end a workflow, so they are pushed to the far end of the row where they cannot be mistaken for another authoring tool. The trailing group is laid out with `margin-left: auto`, not by a separator, so the split survives a role that holds none of the leading commands.

**Each command carries its own icon, and the icon is the tool's identity.** The first version wore `map`, `upload`, and `send` — which were the basemap control, Add files, and Share, before those two left the context bar. A toolbar drawn with another control's glyphs names the wrong tool, so the five are a set of their own, drawn as a schematic of what each does: a connection point is a node on a supply line, a footprint is a shape whose corners are handles, and import and publish are the same tray with the arrow reversed, which makes them legible as a pair. The icon is the one part of a command drawn in colour while the label stays in text ink, and it is stroked heavier than body text — 1.9px rather than 1.6px, which reads as hairline beside a 550-weight label.

**The label drops before the command does.** When the row runs out of width the labels are hidden and the icons remain, so the tools stay reachable rather than scrolling out of the row. The threshold is a container query on the workspace column, measured from the rendered commands rather than estimated — the five labelled commands need 599px including their gaps and the row's insets — and it follows the context bar's disclosure for the same reason: the sidebar is 256px, 64px, or an overlay depending on mode, so a viewport query would have to guess which. The accessible name is stated on the button rather than inherited from the label, because hiding text that a name depends on is how an icon-only toolbar becomes five unnamed buttons.

**The toolbar does not repeat the tool's name.** The open-view tab directly above already says which tool is active, so a second copy on the row below says nothing and costs the width the commands need. The name survives as the toolbar's accessible label, `"{tool} commands"`, which is where it does work — a screen reader announcing a toolbar should hear whose commands they are, and that is not duplication but the only place the information is carried for a listener.

The editor's compact canvas toolbar exposes transient view and drawing modes:

* Select/inspect, pan, zoom, fit, measure, snapping, and layer/source visibility — all of them overlaid on the map rather than in a row above it.
* Draw point, line, or polygon after the user chooses an entity and geometry role.

**Nothing sits above the map.** Every control it offers is overlaid on it, because a row above the canvas costs vertical space on every visit and — the reason this is a rule rather than a preference — resizing the map moves every feature the user is about to click on, since screen points are unprojected against the map's current pixel size. The overlay is laid out by what each control is a property of:

* **Top left, what is drawn.** The basemap choice and the layer switches. The layer control folds to a single button stating the visible count out of the total, so a canvas being read rather than edited is not carrying four switches it is not using. Unfolded it is a **column** of name tags: a horizontal row is the right shape for a row of glyphs, which is how a map's layer switcher is usually drawn, but these tags carry the layer's name and its feature count, and names laid side by side read as a sentence to be parsed where the same names in a column read as a list to be picked from. The list is bounded because the layer set is — `OVERLAY_LAYERS` is a fixed enum of five — so it never needs a scroll that could hide a layer below the fold. The overlays are capped to the width of the map they float on, and a long layer name truncates rather than pushing the control outside the surface.
* **Top centre, what is happening.** The drawing or placing mode, and the plan-only state with its retry. Centred deliberately: entering a mode must not shift a corner the user is reaching for.
* **Right, how it is viewed.** Fit, zoom in, zoom out, and reset, stacked on the edge — which is where every map puts zoom, and it leaves the left corner to the controls about content.

**Every floating control is marked as an overlay, and the map's pan handler ignores a press that lands on one.** This is not tidiness. The map pans by capturing the pointer on a press, and `setPointerCapture` retargets the rest of the gesture to the capturing element — while a `click` is dispatched to the nearest common ancestor of the press and the release. Capturing from a press that landed on an overlay therefore moves the click onto the map, and the control's own handler never runs: every control silently stopped responding the moment they were overlaid, and hit testing, the handlers, and `element.click()` all reported success. The features in the SVG overlay already avoid this by stopping propagation on `pointerdown`; the floating controls carry an attribute the surface checks instead, so a new overlay cannot reintroduce the defect by being forgotten.

Two consequences for how this is verified. A synthetic `element.click()` dispatches straight to the element and skips hit testing and pointer capture entirely, so it passes on a control a user cannot click — `scripts/ui-shot.mjs` grows `--real-click` and `--real-drag`, which drive the browser's input pipeline, and any claim that a control works should be made with them. And the canvas exposes its viewport as `data-zoom` and `data-centre`, because a frozen map and a map that is simply not being clicked look identical from the outside.

The overlay column takes no pointer input of its own; only the controls do. A full-width column that captured events would swallow every pan that began beside a control, which is the map's primary gesture.

Each cluster carries a raised surface and a shadow so it reads over real imagery as well as over the plan-only grid, and the basemap pill's width is capped because a `<select>` is as wide as its widest option — the disabled providers carry an unavailability reason, and the pill must not be sized by text nobody selected. The canvas exposes no `banner` slot: it was the mechanism that inserted a row above the map, which is what the rule above exists to prevent.

Neither toolbar contains entity property fields or detailed downstream design operations. Drawing and import commands create a typed draft command; they never mutate an immutable source artifact.

### Context Menu

The context menu appears on right-click or equivalent long-press:

* On an entity or geometry: open inspector, edit vertices, transform, split/merge, assign role/entity, add a constraint, assign a phase, or compare with source/revision.
* On empty canvas: create a site object, building box, parcel/constraint polygon, route, utility connection point, or other permitted entity at that location.
* On imported source-only content: inspect, map, transform, or mark reference-only; never edit the original document.

Only actions valid for the target and current lifecycle are shown. Destructive or constraint-affecting actions require preview and confirmation.

### Inspector

The inspector appears when an entity or geometry is selected and is the authoritative place for typed values:

* Identity, parent relationship, geometry role/link, lifecycle, provenance, source mapping, and assumptions.
* Utility attributes and connection capacity; environmental limits; phase assignment; resource/capacity allocations; and approval or waiver references.
* Geometry metadata such as CRS, elevation, dimensions, and vertex-edit controls for the selected `GeometryRecord`.

Inspector edits are validated against applicable constraints, preserve stable IDs and provenance, and are saved as draft revisions. The inspector does not provide general navigation or unrestricted freehand drawing.

Validation findings, capacity totals, import diagnostics, and downstream impact remain in the bottom drawer. Project/scenario/revision selection remains in the shell's project context bar; Site and Facility `Validate` and `Publish` remain in the active-tool toolbar.

### Imported and Derived Value Display

* Every imported or derived value shows its `source_ref`, `effective_at`, and confidence in the inspector, with a link to the owning source document, transform, and mapping.
* An assumed value is labelled as assumed and shows the owning assumption; an assumed value is never rendered with a validated affordance.
* Units are stored in SI and displayed in the project or user display unit with the unit symbol always visible. Changing a display unit never changes the stored value.
* A stale value (past the staleness threshold) or a stale local validation result is marked stale with text and an icon, not reduced opacity alone.

### Governance Actions

Waivers, assumptions, and approvals are governed from their owning surfaces, never from a generic dialog:

* A finding row offers "Waive" only when the caller holds `facility.waiver.grant`, the catalog row is waiverable, and a policy permits it. The waiver form requires a reason, scope, and optional expiry.
* Assumptions are created and resolved from the Assumptions tab or the finding that depends on them; resolving an assumption does not by itself promote coverage.
* Approval is recorded in the project context bar or the Validate state and requires `facility.approve`. The UI always distinguishes "validated" from "approved".
* A waiver never removes a finding from the list; it changes its status and gating annotation.

### Editing Safety Rules

1. Select, measure, inspect, layer visibility, and compare are read-only operations.
2. Create, geometry edit, transform, split/merge, role assignment, phase assignment, and capacity allocation create a typed draft change; they do not create a child revision.
3. Geometry operations preserve the source document, prior geometry version, stable entity IDs, CRS, semantic role, and provenance.
4. Operations that would violate a hard spatial constraint are previewed with the resulting diagnostic before commit when practical; they cannot be hidden by changing the active layer.
5. The palette does not expose detailed rack, network topology, branch-circuit, CFD, or deployment-authoring operations owned by downstream tools.

## State Handling

| State | Required presentation |
| --- | --- |
| Empty | Explain what is missing and the next valid action; never show a blank canvas without context. For a first visit, offer create-site or import-document entry points. |
| Loading | Show a bounded skeleton for the hierarchy, canvas, and inspector; the project context bar and revision identity stay visible. |
| Local validation running | Show a stale marker on previous results until the new run completes; never present a partial run as final. |
| Conflict | Show `REVISION_CONFLICT` with the current revision and ETag and offer reload, compare, or rebase; never silently discard local edits. |
| Permission denied | Explain the missing permission key and the workspace context; do not hide the action without explanation. |
| Import failed | Keep the source artifact, show the adapter diagnostics, and offer retry or re-map; never create a publishable envelope. |
| Unsaved draft | Show a non-color-only unsaved indicator on the tab and the toolbar; closing requires save, discard, or cancel. |
| Validated, not published | Show `VALIDATED` with its validation run and derived coverage, and offer Publish. Mutating commands are disabled; a further change requires branching a new draft from it. |
| Published | Show `PUBLISHED` and its publish timestamp as read-only. Disable every mutating command, explain that a published revision is never reopened, and offer "Branch new draft" as the correction path. |

## Canvas Map and Coordinate Behavior

* Map mode requires a georeferenced project CRS. Basemap tiles are requested from the server-side tile proxy ([D16](decisions.md)); the client never contacts a tile provider directly and never receives a provider key.
* The project selects a configured basemap provider; the provider list, attribution text, and availability come from the map provider endpoint. A plan-only grid with scale, north arrow, and coordinate readout remains available when no provider is licensed, when the project is offline, or when the user turns the basemap off.
* Required attribution for the active provider is always visible on the canvas and in any exported or printed view, and cannot be hidden by a layout, density, or focus-mode change.
* Tile unavailability, quota exhaustion, and provider errors degrade to the plan-only grid with a visible notice; they never block geometry editing, local validation, or publication of an already-valid revision.
* The plan-only fallback states **why** it is showing, and it is never permanent. A run of *consecutive* tile failures is what degrades the canvas, so a tile that arrives ends the run, and changing provider or viewport starts a new one. The failure state is presented as a retry control rather than a bare label, because the degraded canvas requests no tiles at all and the user would otherwise have no way back short of a reload. A missing permission or a project with no provider configured is not offered a retry, since asking again cannot change either.
* Plan mode renders the projected geometry directly and does not require a basemap.
* The canvas always shows the active CRS, the display units, and the current scale. A CRS change is a project-level operation and is never applied silently during an edit.
* Reference-only imported content, provisional normalized geometry, and validated geometry are visually distinct by pattern and label, not by color alone.
* Selection is drawn in a colour of its own, never the layer's. Every layer already owns a hue — accent for site and buildings, success for spaces, error for constraints, warning for utilities — so an outline in the layer colour answers "what is this" when the question is "which one is this". The fill keeps the layer hue, so what the canvas says about the object is unchanged.
* Failure-domain and capacity-route overlays are toggled independently and never replace the base geometry.

## Interaction Requirements

* Geometry edits update the draft and invalidate affected downstream calculations.
* Import mapping, transforms, and source metadata are inspected in the right panel, not hidden in a modal after import completes.
* The user can compare source, provisional, and normalized geometry on the same canvas.
* Capacity and validation summaries remain visible without obscuring the drawing work surface.
* Canvas, hierarchy, inspector, and import mapping controls are keyboard reachable; validation state is never color-only.

## Accessibility and Responsive Requirements

* The hierarchy is a disclosure tree with arrow-key navigation, `Home`/`End`, and type-ahead; the active entity is exposed as selected to assistive technology.
* Every canvas action has a keyboard equivalent and a visible focus indicator. Measure, snapping, and draw modes expose their active state as text.
* Findings expose severity, status, constraint ID, and affected entity as text; severity is never conveyed by color alone.
* Units, CRS, and elevation values use locale-aware number formatting but never localized digits in stored identifiers or constraint IDs.
* Reduced motion removes canvas animation, overlay transitions, and side-sheet animation without removing the state change.
* On narrow viewports the inspector becomes a bottom sheet, the hierarchy becomes a drawer, and the toolbar remains reachable with the primary Validate/Publish action available.
* The assistant composer never covers the primary Validate or Publish action, per the shared workspace rules.

## Acceptance Criteria

1. Every sidebar inner function maps to a `route_state`, and sidebar highlight follows the active tab.
2. Import requires confirm, map, and merge-preview steps before any normalized entity is created.
3. Compare mode is read-only and never marks the draft dirty.
4. Imported and assumed values always display source, effective date, and confidence.
5. Publish is disabled with an explanatory reason until the revision is `VALIDATED` by a clean full validation run.
6. Waiver, assumption, and approval actions are permission-gated and never remove findings.
7. Unsaved work is never discarded without an explicit save, discard, or cancel choice.
8. Validation and lifecycle state are conveyed by text or icon in addition to color.
9. The canvas never receives or displays a basemap provider key, and every tile request is authenticated and attributable to the active project.
10. Provider attribution is always visible, and basemap failure degrades to the plan-only grid without blocking editing or validation.
11. Lifecycle state is visible as `DRAFT`, `VALIDATED`, or `PUBLISHED`; a `PUBLISHED` revision disables every mutating command and offers branching instead.
