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
- Manual Add rack and quick-add create position-locked racks by default. The Add
  rack dialog exposes a checked Position lock option that can be turned off.
  The Inspector and selected-rack form expose the current per-rack switch;
  editing it requires the normal editable draft. An unchecked switch with an
  effective saved lock shows Unlock pending until Save layout succeeds. For a
  new unsaved rack, turning the switch off allows placement before its first save.
- Quantity-based Auto design offers Position lock for new racks, checked by
  default when staging the candidate. This applies only to newly created racks;
  algorithm preview geometry and existing-rack rearrangement locks are preserved.
  Existing saved plans and backend/Assistant creation defaults are not rewritten.
- An occupied rack cannot be removed until equipment and limit references are handled. Never silently orphan inventory.
- Findings focus associated objects. Use textual status and lists alongside colors.

### Bulk rack and device removal

Rack layout/Overview and Devices & U slots expose separate bulk-removal panels.
Panels start expanded. A sticky action area above the list exposes **Delete
selected racks/devices (N)**; this opens **Confirm deletion (N)** in the same
area rather than below the long list. Both actions stage the reviewed change,
and Save layout persists it. The first action only opens the review.
Users can search, filter, select individual rows or select all eligible filtered
results across pages, review counts, then confirm removal into the shared draft.
Lists render at most50 rows per page. Selection remains explicit across filters.
Cancel changes no data. Save layout persists the resulting aggregate; Discard
changes restores the saved state. No new delete API or database migration is used.

Device removal deletes selected inventory entries, whether installed or pending.
Rack removal deletes selected unlocked placements and their capacity-limit records,
and deletes all devices currently assigned to those racks from this Plan inventory.
Unassigned devices and devices in other racks remain unchanged, as does the global
catalog. The review explicitly states both the rack count and installed-device deletion
count. Rack placements, installed equipment and capacity limits enter the same draft
and ordinary atomic save; Discard restores them together. Locks in either
the current draft or saved layout block rack removal, including an unsaved unlock.
Unknown/stale selected IDs reject the whole action. Review becomes invalid if
its underlying layout/equipment changes. Existing permission, source/version,
in-flight command, normalization and atomic-save checks remain authoritative.

The Rack panel shows how many filtered racks are excluded by position locks.
**Unlock filtered racks (N)** stages unlocks only for currently locked matching
racks, retaining positions, equipment and all other fields. Users must Save
layout before those racks become eligible for deletion; an unsaved unlock never
bypasses saved-lock protection. Row hints distinguish a current position lock
from an unlock pending save. Device deletion is not blocked by a rack position
lock. Batch unlocking uses the ordinary shared draft/save contract and requires
the same current editability checks as other edits.

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

### Rack naming after creation

Select a rack on the floor layout and edit **Rack name** in the Inspector. Existing saved
layouts require **Edit layout** first; changes use the ordinary shared draft and **Save
layout**, and Discard restores the saved name. The name is required with a160-character
maximum, validated by the existing save path. Position lock protects placement, not naming.
Read-only, busy, stale-source and pending-save states retain the existing editing gate.
Rack identity and device assignments do not change when a display name changes.

### Batch rack creation

The Add rack dialog accepts1–128 racks within the256-rack Plan limit. Automatic numbering
is enabled by default: it suggests the selected rack's prefix, otherwise the last naturally
sorted numbered group (A for an empty plan), and continues after the highest matching suffix.
An optional start number overrides the starting point; existing names are skipped ignoring
case. The live preview shows the generated names. Single racks may disable automatic numbering
for a custom name. Numbers use at least two digits, preserving wider suggested numbering.

Batch racks are staged on a centered grid with optional column count and editable row/column
gaps. Rotated footprints determine pitch. New racks keep the default position lock setting.
Grid proposals do not avoid existing racks/obstacles or prove room fit; existing server checks
and Save layout remain required. Cancel creates nothing. Both the toolbar and canvas Add rack
entry open the dialog. No implicit database save is performed.

### Selected rack position locks in bulk actions

The Bulk remove racks toolbar provides **Lock selected** and **Unlock selected** beside
Delete selected racks. Locked racks are selectable for lock management. Actions affect
only the selected IDs across pages/filters and stage position-lock flags in the shared
draft; Save layout persists them, and Discard reverts them. Selection is retained and
any pending deletion review is cleared after a lock change. Read-only states disable
selection/actions. Delete remains disabled while any selected rack is draft-locked or
saved-locked; saved unlocks must be persisted before moving or deleting those racks.
Equipment assignments, capacity limits and rack geometry are unchanged by lock actions.

### Creation-time capacities, confirmed overrides and custom inventory

Add rack now includes a capacity template plus editable weight/power/cooling limits.
General-purpose servers (1000kg,8kW power,8kW cooling) is the initial local planning
assumption; users may choose another catalog preset, Custom limits or model limits.
The same explicit override is copied to every new rack in a batch in the same draft.
Room budgets and older racks remain unchanged. Add to draft confirms these creation inputs.

The selected rack's Use plan-assumed capacity limits form buffers checkbox/number edits
until **Confirm capacity limits**. Confirm updates the shared draft, then **Save layout**
persists it. Unconfirmed inputs are not part of the save body. Blank is unknown and zero
is explicit; capacity-template Apply remains an explicit draft action. Read-only states
cannot confirm.

Both the Devices Add from catalog picker and Add equipment dialog include **Custom**
inside Equipment model. Custom offers server/switch/GPU/other type, optional name prefix,
heightU, weight/power/cooling and quantity1–128, within the2048-device inventory limit.
Custom entries use explicit plan assumptions with no invented catalog binding. Catalog
batches retain the selected model version/specifications. All new devices are unassigned;
no U slots or physical racks are silently changed. The Custom path works if the catalog
is unavailable. Device type is reflected in its custom name, using the existing device
contract; it is not a new persisted equipment-kind schema field.

Automatic allocation previews now label installed equipment as Rack-Type-Number, e.g.
H05-Server-01 and H05-Switch-02. Numbering is shared across device types within each rack,
ordered by startingU ascending (deviceID breaks ties). All installed devices are relabeled
for consistent numbering; unassigned names remain unchanged. Type uses known catalog
identity or explicit type terms in names; unknown types display Equipment. Names are capped
at160characters. Only display names change: IDs, assignments, demands and catalog refs
remain. The preview includes these names before staging, and Save layout persists them.
This applies to the Web Auto allocation workflow; Assistant/server-generated proposals
are not changed by this UI labeling step.


### Confirmed selected-device properties

Equipment allocation → Selected device exposes editable name, height (U), weight (kg),
power (kW) and cooling (kW), including catalog-created devices. Inputs are buffered until
**Confirm device changes** updates the shared draft; **Save layout** persists the draft.
Unconfirmed property inputs are excluded from saving. Selecting a different device resets
the property form. Assignment and starting-U controls continue to update the shared draft.

Confirmation validates a nonempty name (up to160characters), integer height1–100U and
finite demands0–1000000. Blank demand means unknown; zero is explicit. Changing any
specification detaches the device's catalogRef into custom plan assumptions; name-only
edits preserve the version pin. The catalog model is never edited. Device ID, assignment
and startingU are preserved. Ordinary equipment checks still detect U overlap/overflow
and capacity issues; changing height does not automatically relocate devices. Read-only
users cannot edit or confirm, and backend save authorization remains authoritative.
