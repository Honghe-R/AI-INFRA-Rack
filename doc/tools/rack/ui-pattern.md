# Rack Planner UI Pattern

## Workbench Layout

Rack uses the shared shell: project/scenario/Facility revision context, Rack sidebar, toolbar, central workbench, findings panels and **Ask about Rack**. Current plan, dirty state and read-only status must be understandable without interpreting colors.

The workbench contains title/counts, plan commands, view controls, canvas/table, rack inventory and one inspector. The canvas is a metre-scaled dot grid. Dots are a visual guide, not validated tile sizes or aisle geometry. Fit and expanded views change the camera only; the actual Polygon and holes remain intact.

## Route States and Sidebar Functions

| Section | Purpose | Content |
| --- | --- | --- |
| Overview | Understand totals and next steps | Room/context, coverage and inventory summary |
| Plans | Create/select/manage lifecycle | HALL/name, pagination, rename, delete, deleted list, restore |
| Inputs & impact | Inspect fixed inputs and changes | Snapshot/source identities and stale/unavailable reasons |
| Rack layout | Main physical workspace | Manual editing, empty-plan demand form and save |
| Space rules | Declare exclusions/clearance | Rectangles, source statement and coverage |
| Devices & U slots | Manage inventory/installations | Catalog versions, custom assumptions and allocation |
| Capacity | Inspect resources | U, kg, kW and room budgets |
| Layout options | Compare algorithm candidates | Relocation and demand-driven previews |
| Checks | Explain local findings | Diagnostics, coverage and unchecked rules |

Project/scenario/revision changes invalidate incompatible selections. Deleted plans have inspectable metadata but require restoration before layout/planning access. A name-prefix group is a browsing convenience, not a physical zone, electrical domain or network topology.

## Primary User Journey

1. Enter a project and Rack under an available Facility revision.
2. Create a named plan for a real HALL. Explain missing permissions or unsupported geometry.
3. Choose quantity-based Auto design for an empty plan, or add objects incrementally.
4. Enter pinned equipment quantities, rack limits, clearance, spacing and assumption source. Save exclusion edits before generating from them.
5. Compare completeness, rack count, envelope area, unplaced reasons and local reports. Limited search failure is not proof of infeasibility.
6. Inspect racks/devices, acknowledge assumptions and stage one candidate.
7. Adjust the shared draft if needed, resolve errors, Save layout and reload.
8. Rename/delete in Plans. Confirm deletion; use Show deleted plans → Restore plan to recover the same content and identity.

## UI Editing Tool Palette

### Toolbar and Dialogs

Commands include Add rack, Add equipment, Add exclusion zone and links to design/space/capacity/options/checks. Commands explain disabled reasons. Editing depends on `rack.write` and compatible plan/source state; whole-plan deletion and recovery require `rack.delete` and `rack.restore` respectively. The backend remains authoritative. The header shows granted Rack capabilities and exposes **Project access** only with `project.member.manage`; see [Access Control](access-control.md) for the member workflow and inheritance limits.

Add dialogs contribute to the shared draft. Equipment is version-pinned and initially unassigned. Canceling before apply does not change the draft. An immutable in-flight save attempt blocks conflicting editing until resolved.

### Canvas and Inspector

- Select a rack for model, position, orientation, capacities and installed devices.
- Select an elevation/list device for host, U interval, resources and provenance.
- Drag unlocked racks in edit mode; snap uses metres. Arrow-key nudge and rotation affect the selected rack.
- A previously locked rack must be unlocked and saved before movement/model change/deletion. Auto allocation excludes locked target racks.
- An occupied rack cannot be removed until equipment and limit references are handled. Never silently orphan inventory.
- Findings focus associated objects. Use textual status and lists alongside colors.

### Bulk rack and device removal

Rack layout/Overview and Devices & U slots expose separate bulk-removal panels.
Users can search, filter, select individual rows or select all eligible filtered
results across pages, review counts, then confirm removal into the shared draft.
Lists render at most50 rows per page. Selection remains explicit across filters.
Cancel changes no data. Save layout persists the resulting aggregate; Discard
changes restores the saved state. No new delete API or database migration is used.

Device removal deletes selected inventory entries, whether installed or pending.
Rack removal deletes selected unlocked placements and their capacity-limit records,
and unassigns their devices by clearing both rackId and startU. The review states
the affected device count; it never silently deletes equipment. Locks in either
the current draft or saved layout block rack removal, including an unsaved unlock.
Unknown/stale selected IDs reject the whole action. Review becomes invalid if
its underlying layout/equipment changes. Existing permission, source/version,
in-flight command, normalization and atomic-save checks remain authoritative.

### Rack capacity template catalog

Capacity exposes a local, versioned **Rack capacity catalog** for the selected
rack, alongside the existing manual limit inputs. These are editable planning
assumptions, not pinned equipment models or vendor/facility ratings.

| Template (v1) | Weight limit (kg) | Power limit (kW) | Cooling limit (kW) |
| --- | ---: | ---: | ---: |
| Light-duty / edge | 600 | 3 | 3 |
| General-purpose servers | 1000 | 8 | 8 |
| Compute-dense | 1200 | 15 | 15 |
| High-density GPU | 1500 | 30 | 30 |
| Liquid-cooled AI | 1800 | 80 | 80 |

Choosing a template previews its values and intended use; **Apply to selected
rack** explicitly creates or replaces all three plan-assumed limits for that
rack. It preserves devices, other racks, room budgets and equipment provenance.
Existing manual fields remain editable, and disabling plan-assumed limits returns
to model limits. Template browsing does not modify data. Write controls follow
the shared draft editability guard; Save layout/Discard changes retain their
ordinary meanings and backend validation remains authoritative.

Equal power and cooling values assume that electrical demand becomes heat, with
no additional cooling margin modeled. The cooling number is a rack heat-removal
budget, not cooling-system electrical consumption. High-density and liquid-cooled
profiles require suitable facilities; values must be adjusted to actual cabinet,
floor, PDU and cooling capabilities. Applying a template does not enlarge room
budgets or imply installed cooling equipment. Only numeric limit snapshots are
saved in existing equipment.rackLimits; template identity/version is a browsing
reference, not a new persisted catalog binding. No API/schema migration is needed.

### View and Metric Semantics

Floor layout, front elevations and capacity table share IDs and selection. U1 is at the bottom. Switching view cannot move objects. Unknown and Not checked are distinct from normal load. The rack-body envelope metric is an axis-aligned area, not certified freed usable floor space. Power/U coloring describes local checks, not circuit or airflow validation.

## Shared Draft and Editing Safety

One plan has one draft across sections. Manual layout, inventory, budgets and staged options compose into that draft. Plan switches/lifecycle changes while dirty require Save/Discard guidance. Browser reload may lose unsaved state; there is no persistent draft history.

Generation reads saved data with a base version and snapshot. Preview is not a write. Staging requires reviewed coverage, compatible identity/version and a stageable option without a competing draft. Save rechecks source, permissions, locks, geometry and equipment. Version conflict retains the draft for review; it never silently replaces another user's edit.

An uncertain request uses Retry original operation with the exact original body/version/key. Do not convert an uncertain write into a new request or mutate its retained payload.

## Assistant Interaction

Ask about Rack is the chat entry. First use shows personal connection setup; saved configuration is reused. The panel supports edit, key retention/replacement, synthetic test and deletion, and explains external model data transmission. Saving configuration does not test or charge a model request.

Tools inspect saved data. Dirty-state hints do not contain the draft itself. Capacity answers must not imply inclusion of unsaved changes. Chat relocation results are summaries; regenerate in Layout options to inspect/stage/save. No Rack-specific model UI actions or writes are registered.

## State Handling

| State | Required response |
| --- | --- |
| No HALL/plan | Explain prerequisites and the creation path |
| Unsupported boundary | Show adapter reason; do not guess a room from area |
| Empty layout | Offer Auto design/Add; never label validated |
| Changed Facility source | Preserve snapshot for inspection; block layout mutation/planning |
| Version conflict | Keep draft and require saved-data review |
| Rule conflict | Show code, objects, units and correction guidance |
| Unknown resources | Preserve unknowns and assumption provenance |
| Deleted plan | Restore before layout access |
| Model failure | Report actual error and keep ordinary planning usable |

## Accessibility and Responsive Requirements

Built-in labels/examples use English. Values keep m/kg/kW/U units and distinguish zero from unknown. Controls, dialogs and selectable SVG objects require accessible labels; view changes must preserve understandable selection. Dialog focus returns to the invoking control. Lists/tables provide alternatives to canvas-only interactions.

Keyboard, focus, narrow-screen and assistive-technology behavior require manual acceptance beyond static render tests. Crowding in narrow canvas/inspector layouts remains an audit item; this document does not certify accessibility compliance.

## Acceptance Criteria

The complete creation-to-restoration chain must work without a hidden mutation channel. Read-only content remains useful without write controls. Source/version/deletion blockers match backend behavior. View changes preserve physical coordinates. Verification reports distinguish browser interaction, static rendering and HTTP-only checks.
