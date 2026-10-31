# Rack Planner Decisions and Open Questions

## Decision Register

These records describe the inspected implementation and its rationale. They are not invented teacher approvals or a substitute for source tests. IDs are local documentation references, not runtime constraint IDs.

| ID | Decision / status | Rationale and consequence |
| --- | --- | --- |
| R-D01 | Implemented: one independently versioned plan per Facility HALL | Keeps equipment/layout ownership explicit and makes version conflict review manageable |
| R-D02 | Implemented: fixed snapshot plus live source-status comparison | Avoids silently moving old layouts when upstream geometry/token changes; no automatic rebase |
| R-D03 | Implemented: translated supported UTM Polygon with holes | Preserves real topology/local metre units without pretending arbitrary CRS conversion |
| R-D04 | Implemented: pure domain proposals plus authoritative PostGIS adapter | Reuses algorithms/tests without importing SQL/network dependencies into the domain package |
| R-D05 | Implemented: one shared draft and one atomic aggregate save | Placement, inventory and constraints cannot partially commit or diverge across sections |
| R-D06 | Implemented: explicit unknowns and assumed provenance | No missing value becomes zero, unlimited or engineering evidence |
| R-D07 | Implemented: deterministic bounded heuristics and baseline comparison | Reproducible course explanation; no global-optimum or infeasibility guarantee |
| R-D08 | Implemented: saved lock requires separate unlock/save | Prevents incidental movement/model change/deletion; allocator avoids locked targets |
| R-D09 | Implemented: soft delete/restore shares plan version domain | Recoverable lifecycle without orphaning content or allowing stale layout overwrite |
| R-D10 | Implemented: five read/computation Assistant tools only | Reuses real services while leaving review/staging/save explicit in the UI |
| R-D11 | Implemented: one personal model connection per authenticated user | Simple first-use setup/reuse, owner/version/session isolation; no global provider mutation |
| R-D12 | Implemented first adapter: external encrypted single-instance connection files | Avoids credentials in Git/browser; centralized metadata/KMS needed before multi-instance deployment |
| R-D13 | Implemented: default public HTTPS endpoints with checked DNS/socket | Limits SSRF; internal gateway exception is exact-origin administrator policy |
| R-D14 | Implemented: English built-in UI/examples/specification bundle | Matches platform presentation; historic progress/evidence remain unaltered |
| R-D15 | Implemented: no formal Rack validation/publication yet | Whole-plan state remains NOT_RUN; local clearance is not engineering approval |
| R-D16 | Current boundary: Rack owns course plan-local placement | Does not settle all inherited platform Floorplan/row ownership questions |

## Open Questions Requiring Design Resolution

### Floorplan and Cross-Tool Identity

Which tool owns canonical rows, rack identity and imported physical placements when a real Floorplan tool is implemented? Resolve single-writer ownership, stable references, accepted upstream versions and migration before sharing records. Do not merge by names. Network endpoint, Power feed and global-asset identities also need explicit mapping.

### Effective Rack Limit Policy

The general equipment checker uses a plan limit record when present, falling back to model values when absent. Demand packing takes the minimum of user-declared and known model limits. Should all writes enforce model maxima as hard limits, or are some model values provisional assumptions? Resolve authority and backward compatibility before changing behavior; documentation must not claim this is already uniform.

### Coverage and Save Versus Validation

A local report can be clear while a separate room budget remains unrecorded. Current save rejects known conflicts, not every incomplete scope. Define which future publication/validation gates require known budgets, complete surveyed obstacles, installed inventory and authoritative source evidence. Preserve partial draft authoring rather than disguising incomplete data as failure-free validation.

### Continuous Access and Engineering Scope

Define aisle width/connectivity endpoints, egress criteria, maintenance-band semantics, side clearance, floor loading, rail compatibility and airflow inputs. Who supplies requirements and validates them? Rectangular reservations alone cannot answer connectivity or code compliance.

### Formal Validation and Candidate History

Saved scoped checks now bind version/snapshot/canonical SHA-256/ruleset and compute
historical invalidation; JSON/CSV planning downloads are implemented. See
[Saved Checks and Reports](check-history-and-reports.md). Formal validation gates,
record retention, durable candidate reproducibility, comparison and worker/job
semantics remain open. A saved scoped check cannot approve or publish a plan.

### Model Connections and Agent Expansion

Multi-connection/shared-team providers, administrator quotas, audit/retention and centralized encrypted storage require further work. A new Assistant demand/allocation capability needs strict bounded schemas, saved-state binding, no-write semantics and tests; existence of browser APIs alone is insufficient authorization to register it.

### Concurrency, Performance and Recovery

Before larger limits, measure query/geometry/serialization/UI costs. Before production, separate migration/application roles, verify RLS, test backup/restore, define RPO/RTO and adopt a real identity provider. Current local Docker development and dev token bridge do not answer these questions.

## Change and Evidence Discipline

For each resolved item: update owning schema/document, identify compatibility effects, implement a reviewable slice, run relevant domain/API/UI/integration checks and record actual evidence. If scope changes, rewrite the contract around final behavior rather than appending contradictory promises. Documentation-only changes must not claim tests were rerun or a live deployment was altered.
