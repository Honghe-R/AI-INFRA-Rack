# Rack domain foundation

This package contains data-shape validation, local-coordinate geometry, empty in-memory
plans, rectangular room/obstacle checks, and pairwise rack collisions in a supplied layout.
It does not implement persistence, HTTP routes, maintenance clearance, capacity checks,
authorization, planning or Assistant tools.

```powershell
npm ci
npm run test --workspace @ai-infra/rack
node packages/rack/examples/spatial-demo.mjs
node packages/rack/examples/layout-demo.mjs
```

Public exports:

- `CONTRACT_VERSION`: current foundation contract version (1).
- `createRackModel(input)`: immutable model specification with explicit provenance and unknown limits.
- `createRackPlacement(input)`: immutable rack instance identity and centre-position record.
- `rackFootprint(model, placement)`: four corners, front edge and bounds in room-local metres.
- `createFacilityInputReference(input)`: immutable project/scenario/revision/room pointer with an opaque revision ETag.
- `createRackPlan(input)`: empty in-memory draft, independent version 1, `validationState: NOT_RUN`.
- `assessFacilityInput(previous, current)`: `UNCHANGED`, `STALE` or `DIFFERENT_SOURCE`, comparing supplied pointers only.
- `createRoomSnapshot(input)`: immutable rectangular room input with metre/local-frame declarations, origin description, source reference and explicit obstacle coverage.
- `checkRackPlacement(room, model, placement)`: single-rack room/obstacle checks with rule IDs, evidence and unchecked scope.
- `checkRackLayout(input)`: checks supplied rack/model inventories in one declared project/plan, reuses single-rack rules and reports each overlapping pair once.
- `MAX_LAYOUT_RACKS` / `MAX_LAYOUT_MODELS`: explicit inventory limits (256 each).
- `MAX_EQUIPMENT_DEVICES` / `MAX_EQUIPMENT_RACK_LIMITS`: saved inventory limits (2,048 devices/256 records), defined in `src/limits.js`. Regenerate the browser mirror with `node scripts/rack-sync-limits.mjs` from the repository root; `--check` verifies parity without runtime frontend-to-backend imports. Algorithm search budgets and HTTP body bounds are independent.
- `MAX_ROOM_OBSTACLES`: input bound (256); larger inventories must not be silently truncated.
- `SPATIAL_RULES`: stable identifiers for the two implemented spatial rules.
- `RackInputError`: stable `RACK_INPUT_INVALID` code and a field/reason detail for invalid input.

The [example](examples/basic-rack.json) is synthetic course data. Its dimensions are
illustrative and all engineering capacity limits are unknown (`null`). A successful
constructor or footprint calculation does **not** certify feasibility.

[Empty plan input](examples/empty-plan.json) uses synthetic identifiers and a synthetic
ETag. Plan creation does not check database ownership, retrieve geometry, assign a real
room, save anything or authorize access. A future service must read the authoritative
facility token before comparing it; a client-supplied token is not evidence of freshness.
The plan constructor accepts creation input, not a saved plan document.

[Room example](examples/rectangular-room.json) is synthetic. A room boundary is explicitly
an axis-aligned rectangle, never a polygon's bounding box. Real nonrectangular rooms,
georeferencing and projected-to-local conversion need an adapter that is not implemented.
Room-wall contact is contained; obstacle edge/corner contact is a conflict. Comparisons
use JavaScript doubles without a hidden tolerance, so rounding can conservatively flag
near-boundary positions. These rules do not establish maintenance clearance.

Obstacle input is mandatory: `obstacleCoverage: COMPLETE` is an explicit declaration;
`UNKNOWN` means the inventory may be incomplete. With no known conflict, unknown coverage
returns `INCOMPLETE` with an obstacle check of `NOT_CHECKED`. Known conflicts still return
`ISSUES_FOUND`. `CHECKED_SCOPE_CLEAR` only covers the two declared spatial rules.
Every report includes `uncheckedRules`; none is a whole-plan feasibility verdict.
The snapshot is an in-memory input copy, not a stored or verified content-hash snapshot.

Batch input is `{ projectId, planId, room, models, placements, placementCoverage }`.
Both inventories are mandatory arrays. Rack/model IDs must be unique after normalization;
each placement must match the declared project/plan and resolve to a supplied model.
`placementCoverage: COMPLETE | UNKNOWN` declares whether all room racks were supplied.
Unknown coverage cannot yield `CHECKED_SCOPE_CLEAR`; an empty inventory is `NOT_CHECKED`.
These declarations do not establish authoritative ownership, completeness or freshness.

Rack-pair conflicts require positive interior overlap on both axes. Edge/corner contact is
allowed by this footprint rule; obstacle contact remains conservative conflict handling.
Clearance/aisles remain unchecked. Batch `diagnostics` contains both per-rack findings and
one `RACK_PAIR_OVERLAP` finding per colliding pair, with `rackIds` and overlap bounds in metres.
`rackReports` retains the unchanged single-rack reports; pair findings live at batch level.

See [foundation decisions](../../RACK_FOUNDATION.md), [progress](../../PROGRESS.md)
and the [implementation checklist](../../RACK_PROJECT_TODO.md) before extending the package.
