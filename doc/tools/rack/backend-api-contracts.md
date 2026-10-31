# Rack Planner Backend API Contracts

## API Conventions

Implemented routes are in `apps/api/src/routes/rack.js`, backed by plan/layout services. Base path is `/api/v1/projects/:projectId/rack`; `:planId` is a UUID in that project. Requests are authenticated. Bodies reject unexpected fields and use contract_version 1. JSON errors contain code/message/details and correlation metadata.

Rack responses follow `{data,meta?}`; command metadata includes replay/applied-version information. Layout/lifecycle responses expose a quoted integer ETag such as `"3"`. The opaque Facility revision_etag is a different token. Planning POSTs are computations, not persistence. Current Rack API/client caching behavior is no-store.

## Authorization and Permissions

| Operation | Route permission | Additional requirement |
| --- | --- | --- |
| Catalog, plan list/detail | rack.read | Authorized project scope |
| Room view/layout/check/options/allocation/design | rack.read | facility.read checked explicitly |
| Create plan | rack.write | Valid project/scenario/HALL/source contract |
| Capture snapshot/save layout | rack.write | facility.read and unchanged mutable source |
| Rename | rack.write | Matching plan version and lifecycle |
| Delete | rack.delete | Matching plan version and lifecycle |
| Restore | rack.restore | Matching plan version and lifecycle |
| Record saved checks | rack.write | facility.read, version/snapshot and unchanged source |
| Check history/detail/planning report | rack.read | facility.read; deleted plans return410 |

Tenant transactions/RLS supplement route guards. IDs and UI read-only hints cannot authorize a request. Services are internal and expect authorized callers. Model tools reauthorize independently.

Project membership administration is outside the `/rack` base, under `/api/v1/projects/:projectId/members` and `/member-candidates`. It requires `project.member.manage`, fresh transactional actor checks and versioned commands; see [Authentication and Access Control](access-control.md) for the complete workflow, request shape and inherited-grant caveats.

## Resource Reads

| Method/path relative to base | Input | Result |
| --- | --- | --- |
| GET /catalog | No filters | Versioned synthetic equipment catalog and examples |
| GET /plans | scenario_id?, revision_id?, cursor?, limit?, deleted? | items and nextCursor |
| GET /plans/:planId | Identity | Plan metadata, placements, source status; deleted detail remains inspectable |
| GET /plans/:planId/room-view | Identity | Supported live source view or unavailable/unsupported reason |
| GET /plans/:planId/layout | Identity | Coherent saved snapshot, models, placements, constraints, equipment, source status and version |
| GET /plans/:planId/check-runs | No query parameters | Latest20 summaries with current/historical freshness |
| GET /plans/:planId/check-runs/:runId | Scoped run UUID | Immutable reports plus computed freshness |
| GET /plans/:planId/report | No query parameters | Fresh saved planning snapshot and latest matching check, if any |

List defaults to 20, permits 1–50; cursor is a UUID resolved inside the same scope/filters, ordered newest by creation time and ID. deleted is `true`/`false`, default active. Deleted layout access returns 410 while plan metadata still supports restore.

POST `/plans/:planId/check-runs` records saved inputs only, with
`{contract_version:1,base_version:3,snapshot_id:"<uuid>"}` and UUID
`Idempotency-Key`. New recording returns201; exact retry200 with `meta.replayed`.
No layout version is advanced. See [Saved Checks and Reports](check-history-and-reports.md)
for locking, fingerprints, freshness, retry and download boundaries.

## Creation and Lifecycle Commands

Creation: POST /plans with Idempotency-Key UUID, no Rack If-Match yet:

```json
{
  "contract_version": 1,
  "name": "GPU Hall Plan",
  "scenario_id": "11111111-1111-4111-8111-111111111111",
  "facility_input": {
    "revision_id": "22222222-2222-4222-8222-222222222222",
    "container_id": "33333333-3333-4333-8333-333333333333",
    "revision_etag": "opaque-facility-token"
  }
}
```

These UUIDs are illustrative and must be replaced with actual authorized source IDs. New creation returns 201/Location; exact replay returns 200. Unsupported room input must not fabricate a snapshot.

| Method/path | Body | Preconditions |
| --- | --- | --- |
| PATCH /plans/:planId | `{contract_version:1,name}` | Active plan |
| DELETE /plans/:planId | `{contract_version:1}` | Active plan; soft delete |
| POST /plans/:planId/restore | `{contract_version:1}` | Deleted plan |
| POST /plans/:planId/room-snapshot | `{contract_version:1}` | Compatible source; capture if absent |

All four require Idempotency-Key and quoted integer If-Match. Rename/delete/restore increment version; capture increments only when a snapshot is newly stored. Restore preserves layout/equipment and does not rebase the Facility input.

## Layout Check and Save

POST /plans/:planId/layout/check computes current spatial/equipment reports without saving. PUT to the same layout path saves the normal body:

```json
{
  "contract_version": 1,
  "snapshot_id": "44444444-4444-4444-8444-444444444444",
  "placements": [],
  "constraints": {
    "obstacleCoverage": "UNKNOWN",
    "source": {"kind": "ASSUMED", "reference": "Planning inputs not recorded."},
    "obstacles": [],
    "clearance": null
  },
  "equipment": {
    "coverage": "UNKNOWN",
    "source": {"kind": "ASSUMED", "reference": "Equipment inputs not recorded."},
    "devices": [],
    "rackLimits": []
  }
}
```

Save additionally requires If-Match/Idempotency-Key; check does not authorize persistence. Omitting constraints/equipment retains saved values; an equipment object without roomBudget preserves an existing budget. Explicit roomBudget:null clears it. Array members obey [Entity Model](entity-model.md).

Save locks plan and upstream token/state, rejects stale source/snapshot/version or illegal locked-object changes and reruns actual spatial/equipment checks. Known conflicts return 422; incomplete coverage alone is not a universal save rejection. All writes are atomic.

## Candidate Computation

| POST suffix under /plans/:planId | Body beyond contract_version | Scope |
| --- | --- | --- |
| /layout/options | base_version, snapshot_id, options | Relocate saved existing racks |
| /layout/equipment-options | base_version, snapshot_id | Assign saved unassigned inventory |
| /layout/design-options | base_version, snapshot_id, demand | Generate racks and assignments for an empty saved plan |

Options contain grid_step_m 0.1–5 (default 0.5), allow_rotation (default true), strategy COMPARE/INPUT_ORDER/LARGEST_FIRST (default COMPARE). Demand is defined in [Demand Planning](demand-planning.md).

Result envelopes carry baseVersion, snapshotId, source identity, fingerprint, algorithm/candidate metrics, unplaced reasons, reports, normal save bodies, persisted:false and validationState:NOT_RUN. Generation requires unchanged source and matching snapshot/version. Design additionally rejects existing racks/devices/rack-limit records. No write headers are required for computation, and computation has no side effects. `canStage` never replaces ordinary save authorization.

## Error Codes and Recovery

| Code/category | Status | Caller response |
| --- | --- | --- |
| Invalid contract/body/domain field | 400 | Correct input; do not retry unchanged |
| UNAUTHENTICATED / forbidden | 401/403 | Establish identity/permission |
| NOT_FOUND | 404 | Re-resolve authorized scope |
| RACK_PLAN_DELETED | 410 on layout | Restore via lifecycle path |
| RACK_SOURCE_STALE / RACK_SNAPSHOT_MISMATCH | 409 | Inspect source/snapshot; do not force old content |
| RACK_VERSION_CONFLICT | 412 | Preserve draft, reload and review |
| PRECONDITION_REQUIRED / missing idempotency key | 428 | Supply headers |
| IDEMPOTENCY_KEY_REUSED | 409 | Recover original request identity; do not change a retained attempt |
| RACK_LAYOUT_CONFLICT / RACK_EQUIPMENT_CONFLICT | 422 | Inspect returned report and resolve errors |
| RACK_DESIGN_REQUIRES_EMPTY_PLAN | 409 | Create a separate empty plan |
| RACK_PLANNING_TIMEOUT / RACK_ALLOCATION_TIMEOUT | 503 | Reduce workload/adjust search; no result was saved |

Network uncertainty differs from explicit rejection: retry the exact original command/body/key after uncertainty. Existing command logs store hash/applied version, not durable candidate reports.

## Shared Assistant APIs and Internal Events

Personal connection/provider/chat endpoints belong to the shared Assistant host; see [Assistant Integration](assistant-integration.md) for their actual shapes and owner/version rules. Rack does not add a parallel chat API, expose raw SQL or accept provider credentials in a layout command.

No Rack-specific published event/outbox subscription or service-to-service export contract is implemented. Formal validation, publish, import-job and candidate-history endpoints are planned, not omitted hidden routes. Acceptance must test the actual route matrix and deny all unsupported operations rather than inventing them in clients.
