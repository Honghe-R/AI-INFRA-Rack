# Rack Planner Tool Surface

## Purpose and Design Axes

The tool surface describes named, permission-scoped, bounded business operations reused by consumers. It is distinct from the model-facing projection in [Assistant Integration](assistant-integration.md). HTTP handlers and model tools reuse plan/layout services and the pure Rack domain package; they must not maintain separate interpretations of geometry or capacity.

| Axis | Question | Current implementation |
| --- | --- | --- |
| STATE | What is saved in this plan? | Plan/layout reads and inventory |
| RULE | Why is a placement/assignment blocked? | Shared spatial/equipment reports and reason codes |
| COMPUTATION | What can be derived/proposed? | Capacity totals, relocation, allocation, demand design |
| PROVENANCE | Which input/version/assumption supports it? | Facility reference, snapshot and pinned catalog versions |
| IMPACT | What makes old work stale? | Source status, snapshot/version/fingerprint checks |
| ACTION | What can change safely? | Create/save/rename/soft-delete/restore |

## Tool Contract

Every exposed operation must establish identity/scope, authorize the principal, validate a strict bounded input, preserve deterministic ordering where promised and return explicit coverage/unknowns. Reads/computations do not persist. Writes use their existing concurrency, source and retry rules. Results never include provider credentials or raw source asset bytes.

The implemented services are not yet a complete migration of all Rack commands into the platform generic registry. Names in the following browser table describe operations, not additional model-callable names. Only the five explicitly registered capabilities below are model tools.

## Browser and Service Operations

| Operation | Service/domain owner | Permission / behavior |
| --- | --- | --- |
| List/read plans | createRackPlanService | rack.read; filtered cursor pagination |
| Create plan | Plan service | rack.write; source/HALL validation and creation retry key |
| Rename/delete/restore | Plan service.manage | rack.write / rack.delete / rack.restore respectively; plan lock/version/idempotency |
| Read live room | Plan service.roomView | rack.read + facility.read |
| Read fixed layout | createRackLayoutService.get | rack.read + facility.read |
| Capture snapshot | Layout service.mutate capture | rack.write + facility.read; source/version guarded |
| Check submitted layout | Layout service.check | rack.read + facility.read; pure read/computation |
| Save submitted layout | Layout service.mutate save | rack.write + facility.read; atomic checks/write |
| Relocate existing racks | Layout service.options + generateRackOptions | Read permissions; version/snapshot/source bound |
| Allocate inventory | equipmentOptions + allocateUnassignedEquipment | Same read guards; preserves installed equipment/positions |
| Design from quantities | designOptions + generateDemandOptions | Same read guards; empty-plan precondition |
| Read catalog | getRackCatalog/getCatalogExamples | rack.read; immutable synthetic versions |

Services normalize inputs; PostGIS adapters check actual Polygon topology. Domain functions have no database/network dependency and accept injected geometry selection callbacks for search.

## Model-Facing Projection

| Capability | Arguments | Result / bounds |
| --- | --- | --- |
| rack_list_plans | cursor? UUID | Active scenario/revision list, 20 per page, nextCursor |
| rack_read_plan | offset? 0–1000 | Selected saved layout, independent 20-item rack/device/obstacle pages |
| rack_query_capacity | offset?, rack? exact name or UUID | Shared checker results; 20 rack summaries, plan-wide room totals |
| rack_check_saved_layout | No properties | Shared spatial/equipment check summaries; diagnostic caps |
| rack_generate_layout_options | grid_step_m?, allow_rotation?, strategy? | Existing-rack relocation summaries; no candidate save body |

The five tools above declare access read, confirmation none, surfaces rack and requiredFunctions rack.read + facility.read. The handler reasserts both permissions. Context scope is resolved by the server; model arguments cannot override plan/project/revision. Exact rack names are a convenience only when unique; ambiguous matches require returned IDs.

## Bounding, Freshness and Determinism

A Rack turn allows at most ten capability calls and one layout generation. Lists use nextOffset/nextCursor rather than claiming complete inventory. Diagnostic summaries cap categories and device identity lists at 20 and preserve counts/truncation signals. The shared host adds configurable model/turn/output limits; Rack's page caps are not a replacement for global serialized-result budgets.

The host binds a saved plan version. Tools re-read/compare it, including after check/generation to detect intervening saves. Unsaved-draft/client-version hints can block generation; they never replace saved contents. Changing the selected plan requires a new compatible context, not a model argument.

Relocation compares deterministic input-order and largest-first strategies. Allocation sorts by height then identity. Demand uses stable input/model ordering, deterministic IDs from an input fingerprint and bounded packing/layout search. Search output is reproducible for a fixed input/catalog/algorithm, not guaranteed optimal.

## Relationship to Assistant Integration

Browser options can return ordinary candidate bodies for explicit staging/save. Chat exposes only summaries, so a model cannot synthesize a write by returning a candidate body. The [Assistant edit tools](assistant-edits.md) add write-authorized previews and confirmed exact-proposal saves for cabinet/assignment/clearance/assumed-budget edits. Quantity-driven design, automatic allocation, plan deletion/publication and formal validation remain unavailable through chat. There are no Rack-specific UI-action types or entity-reference kinds yet.

## Audit, Redaction and Failure

The shared host supplies invocation auditing/redaction. Preserve tool identity, scope, timing, outcome and correlation information without logging API keys or full sensitive payloads. Provider errors must not expose upstream response bodies/credentials. A tool failure is reported honestly; no synthetic fallback answer can masquerade as an actual result.

Read-only computations may consume CPU/database/model quota. They still require budgets and cancellation where available. A user confirmation in prose never grants write permission or bypasses version/source guards.

## Implementation Status and Acceptance Criteria

The five capabilities and current services exist in source; demand/allocation Assistant projection and a complete generic command-registry migration remain planned. Contract tests must prove authorization at invocation, strict schema rejection, saved-version binding, pagination, unknown propagation, tool-call bounds, read-only behavior and no automatic persistence. See [Verification Requirements](verification-requirements.md).
