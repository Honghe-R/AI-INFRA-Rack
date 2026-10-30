# Rack Planner Demand Planning

## Purpose, Scope and Input

Demand design starts from an empty saved plan: no placements, devices or rack-limit records, with a supported fixed snapshot and unchanged Facility source. Saved exclusions and room budget can exist. The goal is to derive racks, U assignments and a compact physical candidate from equipment quantities, rather than requiring one-by-one placement.

The browser endpoint is POST `/api/v1/projects/:projectId/rack/plans/:planId/layout/design-options`. It uses read permissions and performs no write. The request wraps contract_version, base_version, snapshot_id and the following demand:

```json
{
  "groups": [{"modelId":"demo-gpu-4u","version":1,"quantity":8}],
  "rackModelId":"10000000-0000-4000-8000-000000000001",
  "maxRacks":16,
  "rackLimits":{"maxWeightKg":800,"maxPowerKw":12,"maxCoolingKw":12},
  "sourceReference":"Course planning assumptions; verify before deployment.",
  "gapM":0.2,
  "constraints":{
    "obstacleCoverage":"UNKNOWN",
    "source":{"kind":"ASSUMED","reference":"User planning assumptions"},
    "obstacles":[],
    "clearance":{"frontM":1,"rearM":0.6}
  }
}
```

Groups require unique exact model/version pairs, positive integer quantities and a server-resolvable catalog entry. Rack limits are explicit finite nonnegative assumptions; demand packing caps each by a known model limit when present. Source reference is required. Optional constraints replace the request's planning input; omission retains saved constraints. Optional roomBudget follows the room-budget contract; omission retains the saved budget.

## Objectives and Comparison

Prefer complete equipment allocation, then fewer racks, then a compact rack-body envelope. The two packing strategies are compared, not presented as a proof of optimality. The geometry stage ranks candidate matrix shapes by rack-body envelope area, longest span and deterministic tie-breakers, but returns the first accepted proposal within its bounded translation schedule. It does not exhaustively optimize all feasible translations.

The displayed envelope is the axis-aligned box around rack bodies. Maintenance bands affect feasibility even though they are excluded from that area metric. A reduced envelope is not an engineering measurement of newly available floor area.

## Stage 1: Deterministic Demand Expansion

Resolve specifications on the server, expand each requested quantity into plan-local device instances, preserve catalogRef and derive stable IDs from the input fingerprint. Identical pinned input/catalog/algorithm produces identical identities. Every requested device remains represented, including unknown or oversized devices. No browser-supplied replacement specification is accepted under a catalog reference.

## Stage 2: Multi-Resource Packing

| Strategy / algorithm ID | Ordering | Bin choice |
| --- | --- | --- |
| Input First Fit / demand-first-fit-v1 | Request group/device order | First existing rack that fits; otherwise create a bin up to maxRacks |
| Dominant Best Fit / demand-dominant-best-fit-v1 | Descending maximum U/weight/power/cooling capacity fraction; stable tie-break | Fit with the smallest summed normalized resource remainder; otherwise create a bin |

Each bin has U and three resource limits. Devices occupy contiguous U intervals from U1 upward. Unknown demand is retained as UNKNOWN_DEVICE_DEMAND; individually oversized demand as DEVICE_EXCEEDS_RACK; exhausted rack-count capacity as RACK_COUNT_LIMIT. Floating-point comparisons use the shared resource tolerance, not an engineering safety allowance.

These are greedy heuristics for multidimensional bin packing. They can miss a better packing. They do not balance network cabling, electrical phases, airflow or equipment affinity.

## Stage 3: Bounded Physical Search

Enumerate compact matrices across column counts and 0/90-degree orientation. Rack spacing includes the requested gap; row spacing conservatively reserves front plus rear clearance. Shape proposals are translated within the real boundary extent using centre/corners then an 8×8 fraction schedule, with fair round-robin exploration of shapes.

The extent only proposes positions. A PostGIS adapter tests complete arrangements against actual Polygon/holes/declared obstacles and maintenance bands. Every resulting candidate receives the ordinary full spatial/equipment recheck before stageability is reported.

A zero requested gap retains one micrometre of numerical separation. This avoids nearly coincident footprint overlap/invalid aggregate geometry; it does not waive clearance or relax checker tolerance. Whole arrangements use GeometryCollection to preserve independent footprints instead of an invalid edge-sharing MultiPolygon.

## Search Budgets and Failure Semantics

| Bound | Implemented value |
| --- | --- |
| Demand groups | 1–16 |
| Total devices | 1–128 |
| Generated racks | 1–32 maximum input |
| Whole-layout proposals | 256 per packing strategy |
| Proposal batch | 16 |
| SQL statement timeout | 5 seconds in the service |
| Cooperative generation deadline | 15 seconds |
| Gap | 0–5m |

NO_COMPACT_LAYOUT means no accepted complete matrix was found under the bounded search. It does not prove the room cannot fit the equipment. Existing-rack relocation separately uses NO_GRID_POSITION/SEARCH_LIMIT. A timeout changes no data. Cooperative deadlines are not a production latency SLA and do not imply interruption inside every synchronous function.

Unknown device resources, unplaced equipment, actual spatial/resource conflicts and an explicitly unknown room budget can prevent staging. Missing room budget remains an explicit unchecked/incomplete scope rather than automatically forbidding all local planning. The candidate must retain the reason and original inventory, not discard difficult items to look successful.

## Other Planning Operations

Existing-rack relocation compares row-scan-v1 and largest-first-v1, preserves devices/U assignments and saved locked rack geometry, and uses a configurable 0.1–5m grid. Bounds: 64 movable racks, 2,048 submitted poses per rack, 16,384 per option, batches of 128.

Automatic equipment allocation changes only unassigned devices. It sorts descending height with stable ID ties, scans contiguous U gaps in unlocked racks and checks weight/power/cooling plus optional room budget. Bounds: 128 pending devices, 64 eligible racks, rack height at most 100U. Installed assignments and all rack positions stay unchanged. Unknown/oversized/room-blocked devices remain unassigned with reasons.

## Output, Review and Persistence

The result pins baseVersion/snapshotId/Facility input/fingerprint and contains algorithm IDs, limits, elapsedMs, metrics, unplaced reasons, reports and ordinary save bodies. It is persisted:false with validationState:NOT_RUN. Browser review → acknowledged stage → shared draft → normal save is mandatory. A stale preview must be regenerated/reviewed; canStage is not authorization.

The Assistant currently exposes existing-rack relocation only. Quantity design and equipment allocation are browser/service functions, not model tools.

## Development and Acceptance Sequence

Keep schema/invariants and ownership documented first; then domain normalization/packing/search; then PostGIS service/HTTP guards; then UI comparison/staging/save; then recorded browser acceptance. Future work should prioritize aisle connectivity, formal validation and measured scale before broader optimization claims.

Tests must cover deterministic IDs/ties, exact catalog versions, unknown/zero/boundary resources, every requested device retained, irregular Polygon/holes/exclusions, numerical zero-gap behavior, stale versions, read-only generation and atomic ordinary save. Compare heuristics with a baseline on identical inputs and report counterexamples rather than cherry-picked improvements. See [Verification Requirements](verification-requirements.md).
