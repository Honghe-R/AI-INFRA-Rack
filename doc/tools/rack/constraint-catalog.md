# Rack Planner Constraint Catalog

## Identifier and Evidence Convention

The current implementation uses stable diagnostic codes and scope labels rather than a complete Facility-style constraint registry. Codes below are implemented; proposed rules are explicitly separate. `rack.capacity.room_budget` is an actual room diagnostic ruleId, while many spatial/equipment findings primarily expose code. Do not invent rule IDs or claim registry migration is complete.

Diagnostics include severity, referenced rack/device/obstacle IDs, message and relevant evidence such as side, U interval, dimension, knownSubtotal, limit and unit. Spatial diagnostics are ERROR; equipment conflicts are ERROR. Unknown coverage/resources are generally status/unchecked evidence rather than fabricated ERROR findings.

## Severity, Status and Remediation

| Status | Meaning | Consequence |
| --- | --- | --- |
| ISSUES_FOUND | Actual checked conflict | Save rejected for blocking diagnostics |
| NOT_CHECKED | No relevant racks/devices were checked | No successful-check claim |
| INCOMPLETE | No known conflict but inputs/coverage/unassigned work incomplete | Show missing scope; not automatically an unconditional save rejection |
| CHECKED_SCOPE_CLEAR | Reported checks clear with required local inputs | No whole-plan engineering claim |

Resource status is separately WITHIN_LIMIT, UNKNOWN or EXCEEDED. A known subtotal already exceeding a known limit is EXCEEDED even if additional demands are unknown. `null` is unknown and zero is a real value. Equipment aggregate status and room-budget subreport can differ; consumers must retain both.

## Geometry and Spatial Checks

| Code | Trigger | Evidence / remediation |
| --- | --- | --- |
| RACK_OUTSIDE_ROOM | Footprint not covered by actual room Polygon | Rack ID; move/rotate to a feasible location |
| RACK_HOLE_CONFLICT | Footprint touches/intersects an interior hole | Rack ID; move away from hole |
| RACK_PAIR_OVERLAP | Rack interiors overlap | Two IDs; separate footprints |
| OBSTACLE_OUTSIDE_ROOM | Declared rectangle leaves room/touches a hole | Obstacle ID; correct assumed rectangle |
| RACK_OBSTACLE_CONFLICT | Footprint touches/intersects a declared obstacle | Rack and obstacle IDs |
| CLEARANCE_OUTSIDE_ROOM | Front/rear band leaves room/touches a hole | Rack/side; revise position or justified input |
| CLEARANCE_RACK_CONFLICT | Another rack intrudes into a band | Both rack IDs and side |
| CLEARANCE_OBSTACLE_CONFLICT | Band touches/intersects obstacle | Rack/obstacle/side |

Containment uses ST_Covers; rack collision requires positive intersection area. Rack/obstacle/hole and band/obstacle contacts use intersection semantics. A rack touching the exterior boundary may satisfy containment, while touching a hole/obstacle is forbidden. The checker does not infer side clearance. Maintenance bands overlapping one another are not a continuous-aisle proof; no general band-band evacuation rule is implemented.

Spatial scope names include POLYGON_CONTAINMENT, INTERIOR_HOLES, RACK_PAIR_OVERLAP, DECLARED_OBSTACLES and FRONT_REAR_CLEARANCE when supplied. UNKNOWN obstacle coverage or absent clearance yields incomplete coverage even without conflicts. With zero racks, the report remains NOT_CHECKED unless actual supplied-obstacle conflicts are found.

## Equipment and Capacity Checks

| Code | Trigger | Evidence / remediation |
| --- | --- | --- |
| DEVICE_U_OUT_OF_BOUNDS | Inclusive device interval exceeds rack height | startU/endU/heightU; relocate or use appropriate rack |
| DEVICE_U_OVERLAP | Installed intervals overlap | Rack and device IDs; choose a free contiguous interval |
| RACK_CAPACITY_EXCEEDED | Installed known subtotal exceeds effective rack limit | Dimension/unit/subtotal/limit; reduce demand or justify appropriate limits |
| ROOM_BUDGET_EXCEEDED | Installed total exceeds plan-local room assumption | ruleId rack.capacity.room_budget; dimension and participating devices |

Resources are summed with compensated arithmetic; comparison tolerates four machine epsilons relative to demand/limit. This handles binary arithmetic such as 0.1+0.2; it is not a safety margin. Capacity cannot be inferred from unrelated electrical kVA values or a synthetic catalog name.

Unknown installed demand makes total/remaining unknown while preserving knownSubtotal. Unassigned equipment is not installed load, but its inventory demand and allocation impact remain visible. Model versus plan-limit source is explicit. Demand packing caps assumptions by known model limits; the general checker currently selects plan limits when present (see [decisions](decisions.md)).

## Structural and Dependency Preconditions

Malformed UUIDs, unsupported versions/fields, duplicate IDs, missing rack/model references, invalid quantities, catalog/spec mismatch, illegal lock changes and unsupported geometry are input/contract errors rather than spatial findings. Source/version/snapshot/deletion conflicts are state preconditions, not physical infeasibility.

Before rack deletion, devices and limits must not become dangling references. Auto allocation preserves installed assignments and excludes locked targets. Source freshness is checked before layout mutation/planning; an unchanged token does not make assumed data authoritative.

## Planner Reasons and Remediation

| Operation | Representative reasons | Interpretation |
| --- | --- | --- |
| Demand packing | UNKNOWN_DEVICE_DEMAND, DEVICE_EXCEEDS_RACK, RACK_COUNT_LIMIT | Retained demand needs known inputs, suitable rack limits or additional racks |
| Compact search | NO_COMPACT_LAYOUT | Bounded matrix search failed; try other input/manual placement |
| Relocation | NO_GRID_POSITION, SEARCH_LIMIT | No accepted sampled position / budget exhausted |
| Allocation | UNKNOWN_DEVICE_RESOURCE, UNKNOWN_ROOM_BUDGET, ROOM_BUDGET_EXCEEDED, NO_ELIGIBLE_POSITION | Retain pending device and inspect resource/U evidence |

Reason codes describe candidate completeness, not persisted diagnostic history. They must survive summaries and must never justify dropping devices.

## Unchecked and Planned Scope

Explicit unchecked categories include side clearances, access connectivity, aisles, depth/rail compatibility, global asset identity, floor load, power feeds/redundancy, airflow/thermal accuracy, other-plan shared room budgets, Facility budget authority and idle rack power. Spatial and equipment reports have separate lists; combine them only while retaining scope provenance.

Planned rules require explicit input ownership, geometry/engineering basis, tolerances, severity, evidence schema and tests before implementation. Formal validation must bind saved version/input checksum and coverage; no empty diagnostics array can stand in for a completed Validation Run.
