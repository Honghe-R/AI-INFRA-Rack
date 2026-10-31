# Rack Delivery Status — 2026-10-31

This is the current review index. Older entries in `RACK_PROJECT_TODO.md` and
`PROGRESS.md` describe their original iteration, not the current feature set.
The implemented scope follows Option2.2 Rack; a general Network/Power simulator
is not required to demonstrate physical cabinet planning.

## Working product

| Course concern | Current implementation | Evidence / next action |
| --- | --- | --- |
| Design and architecture | Facility-owned HALL input; independent Rack aggregate; React → HTTP/service → pure domain → PostgreSQL/PostGIS | [English specifications](doc/tools/rack/Overview.md) |
| Placement and constraints | Actual Polygon/holes, rotations, locks, obstacles, front/rear maintenance bands; shared draft and checked save | [Layout](RACK_LAYOUT.md), [constraints](RACK_CONSTRAINTS.md) |
| Equipment and capacity | Catalog/custom devices, contiguous U, per-cabinet weight/power/cooling, optional assumed room power/cooling budget | [Equipment](RACK_EQUIPMENT.md), [room budget](RACK_ROOM_BUDGET.md) |
| Algorithms | Quantity-driven First Fit/Best Fit packing + bounded physical layout; existing-rack relocation; pending-device allocation | [Demand planning](doc/tools/rack/demand-planning.md) |
| User journey | Create → demand/manual edit → preview → stage/save → reload → rename/delete/restore | [Journey](RACK_USER_JOURNEY.md) |
| Visualization | Room dot grid, placement editing, cabinet/device inspector, U elevations, load coloring and capacity table | Existing workbench;128 racks/944 installed devices in local demo |
| API and contracts | Scoped versioned APIs, snapshot/source guards, exact retries and structured diagnostics | [API contracts](doc/tools/rack/backend-api-contracts.md) |
| Assistant | Five saved-data read/computation tools; per-user persistent encrypted provider connection | [Integration](doc/tools/rack/assistant-integration.md); real-provider acceptance pending |
| Authentication/permissions | Inherited identity/RBAC plus Rack read/write/delete/restore; project member roles, concurrency, last-admin guard and access events | [Access control](doc/tools/rack/access-control.md); dev identity switcher is not production login |
| Check evidence and export | Saved-version check records, current/historical freshness, JSON plan report, equipment CSV | [Saved Checks and Reports](doc/tools/rack/check-history-and-reports.md) |
| Performance/scalability | Explicit input/search ceilings; repeated32/128-cabinet HTTP samples; algorithm/check complexity discussion | [Performance evidence](records/2026-10-31-rack-delivery-gaps/performance.md) |

## Remaining work, ordered by delivery value

1. **Human acceptance and course explanation.** Walk through a new plan and the
   new Checks downloads in the actual browser. This iteration has HTTP, database,
   static-render and build evidence; native browser automation was unavailable.
   Team members should explain packing/ranking, actual versus assumed inputs,
   incomplete checks, source/version guards and permission enforcement themselves.
2. **Report, slides and contribution record.** Assemble the required report and
   presentation from verified design/contract/test evidence, add actual team
   contributions and explain inherited versus new code. No team allocation is
   invented here. Existing specs do not by themselves constitute the submitted
   course report, slides or a rehearsal.
3. **Real Assistant acceptance.** Configure a permitted provider locally and test
   natural-language queries/tool grounding. Scripted-provider tests do not prove
   model quality. No real key/provider call was used in this iteration.
4. **Stronger physical modelling, if required for the chosen demonstration.**
   Continuous aisles/egress, side clearance, depth/rail compatibility, floor load,
   feed redundancy and thermal airflow are unimplemented. Existing front/rear
   rectangles must not be described as an evacuation-network solver.
5. **Governance and cross-tool extension.** Authoritative shared Facility resource
   reservations, durable candidate history/comparison, full engineering validation,
   approval/publication and accepted Network/Power/Thermal interchange remain open.
   Local downloadable JSON/CSV are planning artifacts, not those integrations.
6. **Deployment hardening.** Production OIDC/browser sign-in, multi-instance
   revocation/connection storage, record quotas/retention, backup/restore drills,
   load tests and accessibility acceptance remain deployment work. Saved records
   are append-only through the service, not tamper-proof against database admins.

Items4–6 are boundaries/enhancement choices; this list does not invent new course
requirements. Explain unimplemented features honestly instead of claiming full
engineering certification or production readiness.

## Current acceptance evidence

- Web:65 files /694 tests passed; production build passed with existing toolchain
  and bundle-size warnings. The inherited browser-test backend import was replaced
  with representative API report fixtures, preserving the architecture guard.
- Rack/project-access/gateway API/DB:89 tests passed, zero skipped. New cases cover
  history, exact/concurrent retry, non-mutation, stale inputs, roles, foreign scopes,
  soft-delete recovery, bounded reads and a real restricted database role.
- Only migration013 was applied to the isolated Rack DB, after checking that it
  was the sole pending migration. Existing plan versions/lifecycle were preserved.
- Live128-rack plan has one repeatable saved check: both scopes `INCOMPLETE`, no
  blocking diagnostics; unknown/unchecked rules remain explicit. Its v3 layout
  and the other two active layouts were unchanged. A952-device CSV was serialized.
- [Commands, limitations and raw evidence](records/2026-10-31-rack-delivery-gaps/commands.md).
  This is not a full-repository or production acceptance claim.

Open [the local platform](http://localhost:5193/), choose a Rack plan and open
**Checks → Saved checks & reports**. Save/discard a draft before recording or
exporting. Editors/admins record; viewers can read/download. The local stack must
be running. All edits remain local; no commits, staging, pushes or remote changes.
