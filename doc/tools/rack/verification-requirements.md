# Rack Planner Verification Requirements

## Validation Scope and Target Gating

Verification distinguishes input validity, local spatial/equipment checks, candidate stageability, atomic persistence, Assistant integration and future formal engineering validation. Current state is DRAFT/NOT_RUN. Passing local tests or a green candidate does not create a formal Validation Run or certification.

A save gate rejects actual spatial/U/known resource conflicts and state/permission failures. Incomplete assumptions can be saved when structurally valid; they remain explicit. Stageability is operation-specific: demand design/relocation reject unplaced items, while equipment allocation may stage useful partial assignments and retain the remainder as unassigned inventory. Staging never replaces save checks. Source/model assumptions never become verified merely by a successful transaction.

## Required Evidence Levels

| Level | What it establishes | What it cannot establish |
| --- | --- | --- |
| Domain tests | Shapes, math, deterministic algorithms and unknown behavior | Actual PostGIS, HTTP authorization or browser interaction |
| API/service tests | Schema/route/permission/version behavior with stated fixtures | A real database if fixtures are mocked/skipped |
| Real DB/HTTP | Transaction rollback, geometry, project isolation and persistence | Production RLS role safety or full visual usability |
| Static Web render/state tests | Controls, labels, guards and state transitions | Drag/focus/layout quality in a browser |
| Browser journey | Real navigation, dialog/canvas/inspector and save/reload | Vendor accuracy or scale SLA |
| Scripted model integration | Orchestrator/tool/permission mechanics | Real provider quality, cost or tools compatibility |
| Real provider acceptance | Chosen service behavior on defined scenarios | General model correctness or engineering certification |

Every report must state command, environment, pass/fail/skip count, inspected version and limitations. Historical logs are not automatically revalidated by editing documentation.

## Geometry, Equipment and Coverage Matrix

| Area | Required cases |
| --- | --- |
| Identity | Foreign project/scenario/revision/HALL, duplicate IDs, invalid model binding |
| Boundary | Valid concave Polygon, holes, exterior contact, hole contact, unsupported CRS/dimensions/complexity |
| Collision | Positive-area overlap, shared edge, obstacle contact, rotated racks |
| Clearance | All orientations; rack/obstacle/room intrusion; absent versus zero distances |
| U slots | Lowest/highest valid slot, end beyond height, overlap, fragmented free U, unassignment |
| Resources | Exact limit, excess, zero, null, partial known subtotal, binary arithmetic edge |
| Room budget | Installed versus inventory, unknown demand/limit, cross-rack sum, omitted budget preservation/null clear |
| Locks | Move/model/delete protected; separate saved unlock; allocator skips locked target |
| Coverage | Empty/unknown/declared complete and clear-versus-incomplete distinctions |

## Planning Acceptance

Demand tests retain all requested devices, pin exact catalog versions, derive deterministic IDs/ties and compare both strategies under identical limits. Exercise unknown/oversized demand, maxRacks, irregular boundary/holes, exclusions, room budgets and zero-gap numerical separation. A no-result search must not claim infeasibility or global optimality.

Relocation tests preserve locked racks and inventory/U assignments, enforce search caps and recheck full output. Allocation tests preserve installed devices/positions and retain unknown, oversized, fragmented-U and room-blocked devices with reasons.

Generation tests verify no plan/command writes and normal save-body compatibility. Stale baseVersion/snapshot/source must fail. Save after generation rechecks all ordinary guards rather than trusting canStage.

## Persistence and Concurrency Acceptance

- Two saves from one version permit one success and one 412 conflict.
- Exact retry replays without duplicating objects/version; changed request under one key conflicts.
- A failed equipment/spatial check rolls back all aggregate fields and placements.
- Delete versus layout save shares one version/lock domain; restore retains contents and stale clients stay invalid.
- Unsupported snapshot capture never invents a room or mutates Facility.
- Creation retries use original identity, including uncertain network outcomes.
- RLS tests must name the actual database role; an initialization superuser does not certify production isolation.

## UI Journey and Accessibility Acceptance

Run create → quantities/constraints → compare → inspect floor/elevation/capacity → stage → adjust → save → reload → rename → delete → restore. Verify add equipment/exclusion paths, installed-rack removal protection, dirty-plan navigation, unknown resource display, version conflict recovery and a read-only account. Include empty/unavailable/loading/error states.

Check drag/snap/rotation, keyboard alternatives, object identity after view switches, preserved Polygon holes, dialog focus and narrow viewport overflow. Static rendering alone cannot certify these. Built-in labels/examples and current local demonstration names are English; development logs retain historical language.

## Assistant and Connection Acceptance

Test both permissions at entry and each invocation, scope/version binding, strict schema/pagination/caps, ambiguous rack names, one generation/ten calls, dirty-state guard and saved-only facts. Prove no tools can save/apply/create or fall through to Facility mutations.

Connection tests cover persistence across service instances, owner isolation, optimistic versioning, blank-key retention, authenticated ciphertext tampering, missing master-key protection, cancellation after rotation/deletion, redacted failures and session/model binding. Transport tests cover public/private/mixed DNS, redirects, response cap and exact administrator-origin exception. Synthetic tests send no plan data.

Real model acceptance remains separate: explicitly test actual tools round trip, capacity grounding, unknown explanations, provider timeout/quota/compatibility and whether answers misstate algorithm limits. Never use real keys in fixtures or chat.

## Verification Commands and Historical Baseline

From the Rack repository root:

```powershell
npm run test --workspace @ai-infra/rack
node --test scripts/tests/rack-hall-demo.test.mjs
node --test apps/api/src/tests/rack-assistant.test.js apps/api/src/tests/assistant-connections.test.js apps/api/src/tests/assistant-projection.test.js
npm run test --workspace @ai-infra/web -- src/tests/rack src/tests/assistant src/tests/shell-render src/tests/assistant-tool-surface-render
npm run build --workspace @ai-infra/web
```

Real DB tests must use the isolated Rack environment and the repository's documented fixture setup; do not run seed/reset to manufacture success. Consult [progress](../../../PROGRESS.md) and [connection evidence](../../../records/2026-10-29-rack-assistant-connection/commands.md).

Recorded earlier results include 226 Web/30 API tests and build in the English-UI round; the personal-connection round separately recorded 64 DB/HTTP and 84 Assistant-package tests. These are dated evidence, not results from this documentation round. New numeric claims require rerunning the relevant checks.

## Formal Validation and Publication

Planned formal validation needs a saved plan version/content checksum, pinned source/catalog/algorithm versions, rule-set version, checked/unchecked coverage, timestamps, diagnostics and invalidation after changes. Publication must gate on such a record and explicit authority. Continuous aisles, egress, mechanical/electrical/thermal/floor-load acceptance require their own inputs and qualified criteria. No current publish/approve/waiver command is implemented for Rack.
