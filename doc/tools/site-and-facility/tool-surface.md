# Site and Facility Editor Tool Surface

This document defines the Site and Facility Editor's **tool surface**: the named, permission-scoped, bounded, deterministic operations over facility data that every consumer of this tool shares. It is the layer between the domain packages (`@ai-infra/facility`, `@ai-infra/db`) and the transports that expose them.

The assistant is **one consumer** of this surface, not its purpose. The same tool implementation serves the browser-facing API, the [workspace assistant](../../workspace/chatbox-llm-architecture-blueprint.md), the validation worker, and any integration client. The assistant's own declaration — capabilities, UI actions, entity kinds, and attachment policy — is the model-facing **projection** of this surface and is specified separately in [Assistant Integration](assistant-integration.md).

Why the surface exists as its own layer: today the canonical facility read is written as raw SQL inside `apps/api/src/routes/facility.js`. A second consumer would write a second version of the same query, and a third a third. Every rule this document states — permission assertion, bounding, deterministic ordering, redaction, audit — is a rule that must hold **once**, not once per transport.

## Design Axes

A tool earns its place by serving at least one axis of the domain. Evidence and remediation are two *projections* of these axes, not the organizing principle.

| Axis | The question it answers | Example |
| --- | --- | --- |
| `STATE` | What is true in this revision now? | `list_phases` |
| `RULE` | What does the system require, and why? | `explain_constraint` |
| `COMPUTATION` | What is not stored but is deterministically derivable? | `spatial_query` |
| `PROVENANCE` | Where did this value come from, and is it authoritative? | `get_asset_binding` |
| `IMPACT` | What does a change invalidate or block? | `list_impact_notices` |
| `ACTION` | What may change, under which permission and concurrency control? | `set_geometry` |

Two consequences follow, and both are deliberate:

* A tool declares which **evidence buckets** it can read and which **remediation category** it serves. Those declarations are projections used for routing, coverage linting, and prompt composition; they are never the reason a tool exists.
* A tool is registered **per store**, not per evidence bucket. Two buckets sit in this surface as projections rather than stores — `routes` (geometry rows with role `ROUTE`) and `quantities` (a union over sources, budgets, reserves, and environmental constraints). Neither gets a tool, because neither is a store. Inventing one would put a second implementation of a derived fact behind an API.

## Tool Contract

Every tool in this surface satisfies all of the following. A tool that cannot is not admitted, however useful it looks.

1. **Identity.** A stable `name@version`. A change to the wire shape of a tool increments its version; the registry version increments when the descriptor set changes.
2. **Description, not code.** Tools expose a descriptor for composition (`name`, `description`, `access`, `requiredFunctions`, `inputSchema`, `confirmation`). Executable handlers never reach a prompt or a model-facing payload.
3. **Canonical addressing.** A tool takes identifiers, never names. Every read takes `revision_id`; `project_id` and `scenario_id` MAY be present and, when present, MUST equal the resolved context (a mismatch is a `403`, never a silent rewrite). No tool resolves a display name to an identity.
4. **Permission-scoped.** `requiredFunctions` lists the permission keys the operation needs. Selection drops a tool whose keys are not all authorized; the handler **re-asserts** them. Selection protects the model path; the handler check protects every other caller.
5. **Bounded.** Every list and query result is capped (200 items, 32768 serialized bytes) and an over-budget result degrades to a self-describing digest with a notice rather than failing. A truncated result MUST NOT be presentable as complete.
6. **Deterministic.** A stable ordering is part of the contract, so two callers reading the same state receive the same sequence.
7. **Read/write separated.** A read never mutates. A write is proposal-shaped, requires `base_revision_id` and `if_match` ([D2](decisions.md)), and declares `confirmation: required`.
8. **Audited.** Every invocation emits one credential-free audit record: tool name, access, principal, project, scenario, revision, confirmation state, outcome, duration, correlation id. Argument audit records a digest and named scope identifiers, never geometry payloads.
9. **Redacted.** Credentials, object-store keys, signed URLs, and adapter paths are removed from every user-visible string and never appear in a tool result.
10. **No raw bytes.** A result contains normalized entities and metadata. Never source CAD, DWG, KML, or PDF bytes.

## Read Tools

`revision_id` is required on every read and is elided from the tables below. `limit` defaults to 50 and caps at 200 unless stated.

### Context

| `name` | Axis | Store | `inputSchema` properties | `requiredFunctions` |
| --- | --- | --- | --- | --- |
| `get_revision_context` | STATE, RULE | `facility_envelopes`, `capability_coverage`, `validation_runs`, `revisions` | `{ revision_id, include_coverage: bool = true, include_validation: bool = true }` | `facility.read` |
| `get_revision_activity` | STATE | `outbox_events` | `{ revision_id, event_type?: string, change_kind?: string, cursor?: string, limit?: int 1-200 = 50 }` | `facility.read` |

Returns envelope identity, lifecycle and approval state, the **draft ETag** and content checksum, the read-only flag, derived `capability_coverage[]`, and the `validation_summary`. This supersedes the narrower `get_facility_envelope` in [Assistant Integration](assistant-integration.md) by adding the two fields that document's own signature omits.

Freshness is always returned rather than being switchable: it is three scalars, and a caller that has to ask for it is a caller that can forget to.

`get_revision_activity` is the revision's **history**: one committed change set is one `facility.revision.changed.v1` event carrying its change kinds, changed entity references, and the draft ETag version it produced, and this read returns those newest first along with any other event recorded against the revision. It exists because `compare_revisions` structurally cannot answer "what changed": a `DRAFT` is mutable in place, so there are no per-edit revisions to diff, and the transactional outbox is the only change history the store keeps ([Authoring Plan](../../authoring-plan.md), D-A). It **reads** the outbox; it does not deliver it — there is no dispatcher, no consumer, and no publication in this path, so D-B's deferral of event delivery is untouched.

### Structure

| `name` | Axis | Store | `inputSchema` properties | `requiredFunctions` |
| --- | --- | --- | --- | --- |
| `list_entities` | STATE | `entity_registry` | `{ revision_id, entity_type?: EntityType, status?: IMPORTED_REFERENCE,PROVISIONAL,VALIDATED,SUPERSEDED, name?: string, entity_id?: uuid, cursor?: string, limit?: int 1-200 = 50 }` | `facility.read` |
| `list_containers` | STATE | `facility_containers` | `{ revision_id, parent_entity_id?: uuid, entity_type?: ContainerType, cursor?: string, limit?: int 1-200 = 50 }` | `facility.read` |
| `get_entity` | STATE, PROVENANCE | `entity_registry`, `geometry_records` | `{ revision_id, entity_id: uuid, entity_type: EntityType, include_geometry_metadata: bool = false, include_provenance: bool = true }` | `facility.read` |
| `list_phases` | STATE, RULE | `facility_phases`, `phase_dependencies`, `phase_capability_availability` | `{ revision_id, phase_id?: uuid, include_dependencies: bool = true, include_capability_availability: bool = true, limit?: int 1-200 = 50 }` | `facility.read` |

`list_phases` is the reader for the `phases` and `phaseDeps` evidence buckets. Without it, all six `facility.phase.*` checks raise findings nothing can explain.

### Geometry and Spatial

| `name` | Axis | Store | `inputSchema` properties | `requiredFunctions` |
| --- | --- | --- | --- | --- |
| `query_geometry` | STATE | `geometry_records` | `{ revision_id, entity_id?: uuid, bbox?: [double,double,double,double], entity_type?: EntityType, geometry_role?: GeometryRole, include_geojson: bool = false, cursor?: string, limit?: int 1-200 = 50 }` — every record returns `vertexCount` and `bbox4326`, and a page without coordinates returns `coordinates_omitted` naming the argument that would include them | `facility.read` |
| `spatial_query` | COMPUTATION | `geometry_records` | `{ revision_id, predicate: WITHIN,CONTAINS,INTERSECTS,WITHIN_DISTANCE,DISTANCE, subject: GeometrySelector, target: GeometrySelector, distance_m?: double, crs: string = "EPSG:32618" }` | `facility.read` |
| `geometry_point` | COMPUTATION | `geometry_records` | `{ revision_id, entity_id: uuid, geometry_role: GeometryRole, ordinal?: int = 0 }` | `facility.read` |
| `list_spatial_constraints` | STATE, RULE | `spatial_constraints` | `{ revision_id, constraint_id?: uuid, kind?: string, severity?: ERROR,WARNING,INFO, container_id?: uuid, applies_to_geometry_id?: uuid, limit?: int 1-200 = 50 }` | `facility.read` |

`query_geometry` accepts `entity_id` directly. Addressing geometry only by bounding box forces every caller to reconstruct the box for an entity it already identified.

`spatial_query` is the surface's only **derived** read: it computes what the schema stores rather than what it asserts. `GeometrySelector` is one of `{ entity_id }`, `{ geometry_id }`, `{ bbox }`, or `{ geometry, crs }`. It executes through PostGIS under the revision's tenant GUC ([D15](decisions.md)) and returns measured values with the CRS they were measured in. It MUST NOT be used to pre-compute a stored constraint result: a stored diagnostic and a live measurement answer different questions, and a caller MUST NOT present one as the other.

A `bbox` selector is expressed in WGS 84 degrees and transformed into the projected CRS before any predicate touches it, because the interoperable representation is what a caller holds.

### Resources

| `name` | Axis | Store | `inputSchema` properties | `requiredFunctions` |
| --- | --- | --- | --- | --- |
| `list_utility_sources` | STATE | `utility_sources` | `{ revision_id, utility_source_id?: uuid, kind?: ResourceKind, phase_id?: uuid, failure_domain_id?: uuid, limit?: int 1-200 = 50 }` | `facility.read` |
| `list_utility_interfaces` | STATE | `utility_interfaces` | `{ revision_id, utility_interface_id?: uuid, utility_source_id?: uuid, resource_kind?: ResourceKind, phase_id?: uuid, limit?: int 1-200 = 50 }` | `facility.read`, `asset.read` |
| `get_capacity_budget` | STATE | `capacity_budgets`, `capacity_allocations`, `capacity_demand_requests` | `{ revision_id, budget_id?: uuid, owner_entity_id?: uuid, phase_id?: uuid, resource_kind?: ResourceKind, basis?: string, include_allocations: bool = true, include_demand: bool = true, limit?: int 1-200 = 50 }` | `facility.read` |
| `list_storage_reserves` | STATE | `storage_reserves` | `{ revision_id, storage_id?: uuid, kind?: FUEL,WATER, phase_id?: uuid, limit?: int 1-200 = 50 }` | `facility.read` |

`get_capacity_budget` returns commissioned, planned, reserved, allocated, and available quantities with their basis, plus the allocations and demand requests that consume them. Every capacity finding names a budget; without the allocations and demand in the same read, "overcommit" cannot be explained, only asserted.

### Resilience, Environment, and Assumptions

| `name` | Axis | Store | `inputSchema` properties | `requiredFunctions` |
| --- | --- | --- | --- | --- |
| `list_failure_domains` | STATE | `failure_domains` | `{ revision_id, failure_domain_id?: uuid, include_tree: bool = true, limit?: int 1-200 = 50 }` | `facility.read` |
| `list_resilience_requirements` | STATE, RULE | `resilience_requirements` | `{ revision_id, requirement_id?: uuid, active_only: bool = true, limit?: int 1-200 = 50 }` | `facility.read` |
| `get_environmental_profile` | STATE | `environmental_profiles` | `{ revision_id, profile_id?: uuid, site_scope_id?: uuid }` | `facility.read` |
| `list_environmental_constraints` | STATE | `environmental_constraints` | `{ revision_id, constraint_id?: uuid, kind?: string, limit?: int 1-200 = 50 }` | `facility.read` |
| `list_assumptions` | STATE | `assumptions` | `{ revision_id, assumption_id?: uuid, status?: OPEN,RESOLVED,SUPERSEDED, limit?: int 1-200 = 50 }` | `facility.read` |

These five close the evidence buckets for which no reader exists today: `domains` and `requirements` (all eight `facility.resilience.*` checks), `profiles` and `envConstraints` (all seven `facility.environment.*` checks), and `assumptions`. Twenty-one of the seventy-four catalog constraints are currently nameable but not explainable; these tools close that gap.

### Rules

| `name` | Axis | Store | `inputSchema` properties | `requiredFunctions` |
| --- | --- | --- | --- | --- |
| `explain_constraint` | RULE | constraint catalog | `{ constraint_id: string, revision_id?: uuid }` | `facility.read` |
| `list_policies` | RULE | policy registry | `{ policy_id?: string, kind?: AVAILABILITY,APPROVAL,DERATING,WAIVER }` | `facility.read` |
| `resolve_policy_ref` | RULE | policy registry | `{ policy_ref: string }` | `facility.read` |

`explain_constraint` returns the catalog entry — rule text, default severity, gating capability, evidence model, scope, phase, remediation category, and policy references — and, when `revision_id` is supplied, the **applicability** of that constraint to the revision: whether its evidence bucket is populated, whether it was checked, and what would satisfy it. It reads the catalog; it MUST NOT carry a hand-written copy of any rule.

`list_policies` and `resolve_policy_ref` expose the versioned policy registry. A policy reference is `policy_id@version` and is only meaningful pinned: a bare name resolves to nothing. These tools MUST report whether a resolved policy declares `coveragePromotingWaivers` and whether it is waiver-eligible, because those are the facts a waiver decision turns on and neither is derivable from a diagnostic.

### Verification

| `name` | Axis | Store | `inputSchema` properties | `requiredFunctions` |
| --- | --- | --- | --- | --- |
| `list_diagnostics` | STATE, RULE | `facility_diagnostics` | `{ revision_id, diagnostic_id?: uuid, severity?: ERROR,WARNING,INFO, status?: DiagnosticStatus, constraint_id?: string, capability?: Capability, entity_id?: uuid, validation_run_id?: uuid, include_superseded: bool = false, cursor?: string, limit?: int 1-200 = 50 }` | `facility.read` |
| `get_validation_run` | STATE | `validation_runs`, `facility_diagnostics`, `capability_coverage` | `{ revision_id, validation_run_id?: uuid }` | `facility.read` |
| `get_coverage` | STATE | `capability_coverage` | `{ revision_id }` | `facility.read` |
| `list_waivers` | STATE | `waivers` | `{ revision_id, waiver_id?: uuid, status?: GRANTED,EXPIRED,REVOKED, limit?: int 1-200 = 50 }` | `facility.read` |
| `list_attestations` | STATE | `approval_attestations` | `{ revision_id, attestation_id?: uuid, decision?: APPROVED,REJECTED,REVOKED, limit?: int 1-200 = 50 }` | `facility.read` |
| `list_impact_notices` | IMPACT | `impact_notices` | `{ revision_id, validation_run_id?: uuid, since?: timestamp, limit?: int 1-200 = 50 }` | `facility.read` |

`list_diagnostics` is specified with four properties its current equivalent lacks, each of which is load-bearing:

* **`diagnostic_id`** — a diagnostic is addressed by identity. Filtering by `constraint_id` and hoping to find the same row is not addressing, and it is how a caller answers about a different finding than the one it was shown.
* **`capability`** — the unit users think in and the unit coverage is expressed in. The catalog maps a constraint to its gating capabilities; that mapping MUST be applied by the tool, not approximated by prefix matching on `constraint_id`.
* **`evidence`** and **`capability`** on each returned diagnostic — the routing keys. A diagnostic already reports `remediation_category`, so *what to do* about it is self-describing. It does not report its evidence model or gating capability, so *which reader explains it* is not. Both MUST be present on every returned diagnostic, derived from the catalog rather than stored, so a fresh result and a re-read result are identical in shape.
* **`include_superseded`** — default `false`. Diagnostics are append-only, and a superseded record is history. A caller that counts it as a current finding inflates every number it reports.

`list_diagnostics` therefore depends on the catalog at the boundary. This is a derivation, not a schema change: `evidence` comes from the catalog entry and `capability` from its gating rule combined with the diagnostic's resource kind. Because that gating rule fans out for resource constraints, `capability` is a **set**: one diagnostic may gate POWER, COOLING, and NETWORK_ENTRY together, and any grouping or count built on it MUST handle that.

### Provenance and Imports

| `name` | Axis | Store | `inputSchema` properties | `requiredFunctions` |
| --- | --- | --- | --- | --- |
| `get_asset_binding` | PROVENANCE | `asset_bindings`, `import_mappings` | `{ binding_id: uuid, include_diagnostics: bool = true, include_mappings: bool = false }` | `facility.read`, `asset.read` |
| `list_asset_bindings` | PROVENANCE | `asset_bindings` | `{ revision_id, asset_version_id?: uuid, asset_id?: uuid, role?: SOURCE,EVIDENCE,REFERENCE,ATTACHMENT, status?: UNREVIEWED,IN_REVIEW,REVIEWED,REJECTED, limit?: int 1-200 = 50 }` | `facility.read`, `asset.read` |
| `list_import_sessions` | PROVENANCE | `import_mappings`, `import_features` | `{ revision_id, binding_id?: uuid, review_state?: UNREVIEWED,IN_REVIEW,REVIEWED,REJECTED, limit?: int 1-200 = 50 }` | `facility.read` |
| `compare_revisions` | STATE, IMPACT | all revision-scoped stores | `{ base_revision_id: uuid, target_revision_id: uuid, max_changes: int 1-200 = 50 }` | `facility.read` |

An imported value is not authoritative until its transform and mapping are reviewed. Provenance reads MUST report the pinned asset version, the transform's review state, and each mapping's review state, and MUST NOT return source bytes or object-store keys.

`list_asset_bindings` is not the generic list-over-a-store shape, and the difference is the point. A binding stores an `asset_version_id`, and which asset that version is a version *of* lives in the project asset layer, so the tool resolves the identity in one bounded query over the ids on the page. A provenance read that returned only a version identifier would report that something was imported without saying what. A version that no longer resolves is reported as `null`, never as a guess.

## Evidence Coverage

The catalog declares 24 evidence buckets. Each is readable by at least one tool in this surface, which is the property that makes every catalog constraint explainable from tool results rather than only nameable.

| Evidence bucket | Reader |
| --- | --- |
| `envelope` | `get_revision_context` |
| `entities` | `list_entities`, `get_entity` |
| `containers` | `list_containers` |
| `geometry` | `query_geometry` |
| `routes` | `query_geometry` (`geometry_role = ROUTE`) — projection, no store |
| `spatialConstraints` | `list_spatial_constraints` |
| `quantities` | `list_utility_sources`, `get_capacity_budget`, `list_storage_reserves`, `list_environmental_constraints` — projection, no store |
| `sources` | `list_utility_sources` |
| `interfaces` | `list_utility_interfaces` |
| `budgets` | `get_capacity_budget` |
| `allocations` | `get_capacity_budget` |
| `demand` | `get_capacity_budget` |
| `reserves` | `list_storage_reserves` |
| `requirements` | `list_resilience_requirements` |
| `domains` | `list_failure_domains` |
| `phases` | `list_phases` |
| `phaseDeps` | `list_phases` |
| `profiles` | `get_environmental_profile` |
| `envConstraints` | `list_environmental_constraints` |
| `assumptions` | `list_assumptions` |
| `waivers` | `list_waivers` |
| `attestations` | `list_attestations` |
| `bindings` | `get_asset_binding` |
| `mappings` | `list_import_sessions`, `get_asset_binding` |

This table is checkable and MUST be enforced by a contract test: **a catalog entry whose `evidence` bucket has no reader fails the build.** Without that test the property decays the moment a constraint is added.

A constraint with `implemented: false` has no evaluator, so it is recorded as not checked. It still requires a reader, because explaining why it cannot run is itself an answer.

## Action Tools

Actions come in two shapes, and the difference is not cosmetic. An operation that
edits the design graph is a **change-set kind**, applied by the one
`apply_change_set` tool: a user edit is rarely one field, and the specification's
contract is that a set of changes commits or fails as one transaction, in dependency
order, with the resulting diagnostics returned. Exposing nineteen separate mutation
tools would make that atomicity the caller's problem and let a caller reach
intermediate states the contract does not permit. Everything else — governance,
publication, capacity requests — stays a tool of its own.

### The change-set command

| `name` | Covers | `requiredFunctions` |
| --- | --- | --- |
| `apply_change_set` | Every design-graph change kind | computed per set — the union of the kinds it contains |

Its requirements are **computed from the arguments**, which is the one place the
surface departs from a static declaration: a set that moves geometry needs
`facility.geometry.write` and a set that renames a building does not. Declaring every
key statically would make the command unusable for anyone but a project
administrator, and declaring none would be a hole. The tool is offered on its entry
keys and the executor refuses a specific set on the keys that set needs, so the single
choke point is preserved.

`apply_change_set` takes `{ revision_id, base_revision_id, etag, changes[], preview_diagnostics?, idempotency_key? }`.
It is idempotent by key, and the replay is answered **before** the concurrency
precondition: a retry of a commit that already succeeded necessarily presents a stale
ETag, so checking the token first would refuse the replay of a successful write.

### Change kinds

| `kind` | Required permission | Payload |
| --- | --- | --- |
| `create_container` | `facility.entity.write` | `container_kind`, `name`, `scope_id`, `parent_container_id?`, `phase_id?`, `level_number?`, `elevation_base_m?`, `elevation_top_m?` |
| `update_entity` | `facility.entity.write` | `entity_ref` plus `patch` of editable fields |
| `set_geometry` | `facility.geometry.write` | `entity_ref` plus `role`, `ordinal?`, `geojson_4326`, elevations (an omitted height keeps the stored one) |
| `remove_entity` | `facility.entity.write` | `entity_ref` plus `cascade: NONE \| CHILDREN` |
| `set_utility_source` | `facility.utility.write` | `kind`, `name`, capacity, `capacity_state`, `failure_domain_id`, `phase_id` |
| `set_utility_interface` | `facility.utility.write` | `utility_source_id`, capacity (all or none), `service_state`, `failure_domain_id`, `phase_id` |
| `set_failure_domain` | `facility.utility.write` | `name`, `kind`, `parent_failure_domain_id?` (cycle-checked) |
| `set_storage_reserve` | `facility.utility.write` | `kind`, `capacity_*`, `autonomy_duration_seconds?`, `failure_domain_id`, `phase_id` |
| `set_resilience_requirement` | `facility.utility.write` | `availability_policy`, pinned `policy_id`, `applies_to[]`, autonomy |
| `set_capacity_budget` | `facility.capacity.allocate` | `owner_entity_id`, `phase_id`, `resource_kind`, `basis`, quantities |
| `set_environmental_constraint` | `facility.constraint.write` | `profile_id`, `constraint_kind`, threshold, `basis`, `affected_entity_id?` |
| `assign_constraint` | `facility.constraint.write` | `constraint_kind`, one anchor of `scope_id`/`container_id`, rule |
| `assign_phase` | `facility.phase.write` | `entity_ref`, `phase_id` |
| `set_phase` | `facility.phase.write` | `name`, `phase_order` (unique), activation, status |
| `set_phase_dependency` | `facility.phase.write` | `predecessor_phase_id`, `successor_phase_id` (acyclic, not duplicated) |
| `set_phase_capability` | `facility.phase.write` | `phase_id`, `capability`, `available`, `available_from` when available |
| `record_assumption` | `facility.entity.write` | `statement`, `owner`, `confidence`, `effective_at`, `entity_refs[]` |
| `resolve_assumption` | `facility.entity.write` | `assumption_id`, `resolution?` |
| `attach_document` | `facility.document.manage` | `kind`, `title`, `media_type`, `content_checksum`, `storage_key`, `owner` |
| `detach_document` | `facility.document.manage` | `document_id` |

Only `transform_geometry` remains unbuilt, and it is recorded in `PENDING_CHANGE_KINDS`
with its blocker rather than omitted: `spatial_transforms` requires an asset binding that
no command can create yet.

`set_geometry` is an upsert on `(entity_id, entity_type, revision_id, role, ordinal, project_id)`,
so a **move** is the same change with different coordinates rather than an operation of its own —
which is why both the canvas drag and an assistant placement compose it through the same
`placementPlan`/`placementChanges` (`packages/facility/src/geometry-move.js`), moving every part
of the entity together and carrying each record's heights. On conflict the elevations are
`COALESCE(EXCLUDED.…, stored)`: a height the caller supplies wins and one it omits keeps what the
revision already stored, so a caller that re-writes only the position cannot flatten a stored
geometry. Clearing a height is therefore not expressible through this kind; it would be its own
change rather than a side effect of a move.

Two kinds are additions rather than declarations: `set_phase` and `set_phase_capability`.
The specification's change-kind table has `assign_phase` and `set_phase_dependency` but no
way to create a phase or to record when it offers a capability, so a phase could be
assigned to but never created and `facility.phase.capability.before_commissioned` could
never be satisfied. That is a gap in the contract, not a design choice.

An edit answers with **both halves**: `diagnostics` is what it broke, and
`resolvedDiagnosticIds` is what it cleared. A run marks a live diagnostic `RESOLVED` when
a constraint that ran did not re-emit it ([Verification Requirements](verification-requirements.md),
"Diagnostics and Gating"); before that, an edit that fixed a problem could not clear it,
because supersession only fires when a finding is re-issued.

Three rules govern this set:

1. **A category may route out rather than mutate.** `OBTAIN_APPROVAL` is a governance act; `request_approval` records a request and MUST NOT fabricate an approval. `ADJUST_PHASE` may be a schedule decision owned elsewhere. A caller that cannot act on a finding MUST say so rather than manufacture a fix.
2. **A waiver changes gating, never evidence** ([D12](decisions.md)). `grant_waiver` and `revoke_waiver` MUST NOT alter or delete a diagnostic, and coverage changes only through a subsequent run.
3. **`run_validation` has the same consequence as the toolbar button.** A clean `FULL` run freezes the revision as `VALIDATED`, and a validated revision is immutable. Every caller — human or model — MUST state that consequence before the run, not after.

### Action tools that are not change-set kinds

| `name` | Remediation category | `requiredFunctions` |
| --- | --- | --- |
| `request_capacity_allocation` | `UPDATE_CAPACITY` | `facility.capacity.request` |
| `pin_policy_reference` | `REVIEW_POLICY` | `facility.constraint.write` |
| `review_import_mapping` | `REVIEW_IMPORT` | `facility.import.map` |
| `apply_asset_binding` | `REVIEW_IMPORT` | `facility.import.map`, `facility.import.apply` |
| `request_approval` | `OBTAIN_APPROVAL` | `facility.approve` |
| `run_validation` | — | `facility.validate.run` |
| `publish_revision` | — | `facility.publish` |
| `grant_waiver` | — | `facility.waiver.grant` |
| `revoke_waiver` | — | `facility.waiver.grant` |
| `create_asset_binding` | `REVIEW_IMPORT` | `facility.import.initiate` |

`create_asset_binding` is the first step of the import flow and nothing beyond it: it pins an asset version, and it does not create a transform, a mapping, or a single normalized entity. It is therefore **not** a change-set kind and it does **not** advance the draft ETag — applying an import is one typed change set and that is what advances the token and emits `facility.revision.changed.v1` ([Import Adapters](import-adapters.md), "Facility Mapping Rules"). `apply_asset_binding` above stays pending and means the later step, so the two names do not overlap.

## Relationship to Assistant Integration

[Assistant Integration](assistant-integration.md) declares a surface key `site_facility` version `2` with 22 capability descriptors. That declaration is a **projection** of this surface, not a parallel definition:

* This document specifies **48 tools** — 32 reads and 16 actions — plus 19 change-set kinds carried by `apply_change_set`. The assistant surface exposes a subset chosen for reasoning value. Tools that are expensive, governance-only, or presentationally redundant MAY exist here and not be exposed there.
* The subset exposed to the model is chosen per tool. This document fixes only that the projection is a subset, and that it shares names.
* `OBTAIN_APPROVAL`, `facility.capacity.allocate`, `facility.share`, `facility.export`, `facility.document.manage`, and `facility.import.initiate` are valid here and MUST NOT be exposed as assistant capabilities in surface version `2`, per that document's "Capabilities Not Declared".
* Adding a tool here does **not** widen the assistant's authority. Widening it requires a change to Assistant Integration and, by that document's own rule, a surface version increment.
* Tool **names are shared**. The projection MUST NOT rename a tool, or the two registries stop being comparable and the contract test that compares them becomes meaningless.

### Reconciling the counts

Three counts for "assistant tools" circulate in the specification bundle. Two are now reconciled; none of them is a count of the same thing.

**Snapshot.** The figures below are the state at the time this reconciliation was written. Two reads have since been added to the tool surface — `get_revision_activity` and `geometry_point` — and one more (`list_entities`) to the assistant projection, so the current figures are **32** reads here and **22** assistant capability descriptors (12 read + 10 write); every count moves by the number of reads, and nothing in the argument changes, so the original numbers are left below as the record of the discrepancy they resolved.

| Count | Source | What it actually counts | Status |
| --- | --- | --- | --- |
| 19 | [Assistant Integration](assistant-integration.md) | 9 read + 10 write capability descriptors | Verified against its two capability tables and acceptance criterion 1 |
| 33 | [Implementation Plan](../../implementation-plan.md) | summed rows across three *different* registries | Reconciled below; not a tool count |
| 35 | this document | 30 reads + 5 actions, plus 19 change-set kinds | Verified against the tables above |

Two of those rows read 33 for unrelated reasons — the plan's summed registries and the document's own tool count as it stood before the two asset-binding tools were added; the coincidence is called out because it is exactly the kind of thing that gets mistaken for corroboration.

**33 is a cross-registry sum.** It resolves exactly as `9 read capabilities + 10 write capabilities + 6 UI-action types + 8 entity-reference kinds = 33`. Only 19 tools are declared anywhere, so 33 has never been a count of tools.

The corroborating detail was an off-by-one inside Assistant Integration itself: its Purpose table declared "Entity-reference kinds | 9 kinds", while the kinds table listed **8**. The missing kind was `facility.import`, which was present in the server's kind mapping (`packages/assistant/src/entity-references.js`) and absent from the table; that row has since been added and the declaration of 9 is now correct. The sum matched the *listed* 8 rather than the declared 9, which is what identifies 33 as a count of table rows rather than of any one registry.

**The 19 is a genuine tool count, but it is verification-incomplete.** It is an authoring-and-summarizing set. Only `list_diagnostics`, `run_validation`, and the coverage and validation summary embedded in `get_facility_envelope` touch verification at all. Two consequences follow, and both are measurable:

* **21 of the 74 catalog constraints had no reader for their evidence.** Every `facility.environment.*`, `facility.phase.*`, and `facility.resilience.*` check could be named and not explained.
* **4 of the 9 remediation categories had no action.** `RESOLVE_CONFLICT`, `RECONFIGURE_RESILIENCE`, `REVIEW_POLICY`, and `OBTAIN_APPROVAL` were unreachable, and `UPDATE_CAPACITY` had only a request operation.

That is the origin of the gap, and it is why this surface is larger. Of the 31 tools here that Assistant Integration does not declare — 21 new reads and 10 new actions — **28 trace to verification**: reading the evidence behind a finding, reading verification and governance state, explaining a rule, or performing a remediation category the original write set did not cover. Three are not verification work: `spatial_query` is general computation, and `list_asset_bindings` and `create_asset_binding` are the import path, which is deliberately outside the assistant's authority — `facility.import.initiate` is one of the keys Assistant Integration says MUST NOT be exposed in surface version `2`.

Assistant Integration's contextual guide referenced `get_import_status`, which no capability list declared; it now names `get_asset_binding`, which is declared and returns the pinned version and the transform and mapping review state — the import state the guide asks about.

## Bounding, Redaction, and Audit

| Concern | Requirement |
| --- | --- |
| Item bound | 200 items per list or query result |
| Result bound | 32768 serialized bytes; over-budget degrades to a self-describing digest with a notice and an audit outcome of `degraded` |
| Argument bound | 8192 serialized bytes; an over-bound argument is rejected before the handler runs |
| Geometry bound | 10000 coordinate positions per geometry |
| Truncation honesty | A truncated or degraded result MUST NOT be presentable as complete, and no caller may assert the absence of an entity or diagnostic from it |
| Incremental reads | A list tool returns a `cursor` when more results exist; a cursor is opaque and revision-bound |
| Redaction | Credentials, object-store keys, signed URLs, and adapter paths are stripped on the server; the client re-applies the same rule before display |
| Audit | One credential-free record per call: name, access, principal, project, scenario, revision, confirmation state, outcome, duration, correlation id |

## Non-Goals

* **Not a query language.** The surface is a fixed, versioned set of operations, one per question class. It MUST NOT grow a general filter or expression grammar, and it MUST NOT accept SQL, JavaScript, or frontend function calls.
* **Not a second source of truth.** `explain_constraint` reads the catalog. `list_diagnostics` derives `evidence` and `capability` from the catalog. No tool MAY embed a hand-written copy of a rule, a policy, or a severity.
* **Not a bypass.** A write through this surface passes the same command, permission, concurrency, and validation rules as the UI. There is no privileged path.
* **Not an evidence registry.** A tool is registered per store. A derived bucket gets a projection, not a tool.
* **Not assistant-specific.** A tool that only the model can call, or that returns prose rather than data, does not belong here.
* **Not a byte pipe.** No result carries source document bytes, and no result carries a storage location.

## Open Items

1. **The projection boundary.** Which tools are exposed to the model, and at which surface version, is a decision per tool. This document fixes only that the projection is a subset that shares names. The decision now has a size: a *verification-complete* assistant surface needs roughly 12 of the 20 new reads (`list_phases`, `list_failure_domains`, `list_resilience_requirements`, `get_environmental_profile`, `list_environmental_constraints`, `list_assumptions`, `explain_constraint`, `resolve_policy_ref`, `get_validation_run`, `get_coverage`, `list_waivers`, `list_impact_notices`) and 5 of the 9 new actions (`delete_entity`, `set_failure_domain`, `pin_policy_reference`, `review_import_mapping`, `request_approval`), taking the assistant surface from 19 to about 36.
2. **`if_match` on reads.** `get_revision_context` returns the draft ETag. Whether a read may accept `if_match` and fail on mismatch, rather than returning the current one, is undecided.
3. **`compare_revisions` cost and its revision preconditions.** It is bounded by `max_changes` and reports per-store counts, but it still reads 21 stores for each of two revisions. Whether it should be one tool or several, and whether it should accept a store filter, is undecided. An `entity_type` filter was declared but never applied — most stores carry no `entity_type` column, and what "changes for this entity type" means for a budget or an interface that belongs to one is unresolved — so the parameter has been **removed** from the contract rather than left silently ignored; a type filter can come back when its scope is decided. A revision that does not exist is refused (`404`), because an empty store reads as "no changes" and a missing base against a real target reads as "everything was added", and the resolved revision identities are echoed back so a caller cannot report a name it did not actually read.
4. **`spatial_query` admission.** The tool is built for five well-defined predicates and remains the most powerful and least bounded operation here. Whether it is exposed to the model at all, or only to the UI and integrations, is undecided.
5. **`resource_kind` is not persisted on a diagnostic.** Recovering the gating capability from the referenced source or budget covers most resource findings, but a resource-gated diagnostic with neither reference reports `capabilityExact: false`. Persisting the resource kind at diagnostic-write time would make `capabilities` exact for every diagnostic, at the cost of a migration.
6. **`explain_constraint` loads the whole revision context.** Reusing the engine's own snapshot is what guarantees applicability has a single answer, but it costs 23 queries per call. A dedicated evidence-count query would be faster and would be a second implementation of the applicability rule.

## Implementation Status

The layer is built in `packages/facility/src/tools/`, with the revision-scoped statements it shares with the validation engine in `packages/facility/src/stores.js`. The engine's `loadRevisionContext` now reads through the same module, so there is one answer to "what is in this revision" rather than one per consumer.

| Piece | State |
| --- | --- |
| The layer (`registry.js`, `schema.js`, `bounds.js`, `mappers.js`) | Built |
| Read tools | **32 of 32 built** |
| Action tools | **16 built**: `run_validation`, `grant_waiver`, `revoke_waiver`, `create_asset_binding`, `apply_change_set`, `request_capacity_allocation`, `decide_allocation`, `create_spatial_transform`, `review_spatial_transform`, `create_import_mapping`, `update_import_mapping`, `review_import_mapping`, `preview_import_merge`, `apply_asset_binding`, `publish_revision`, `request_approval` |
| Change kinds | **21 built**: the specification's 18 applicable kinds, plus `set_phase`, `set_phase_capability`, and `transform_geometry` |
| Evidence coverage | All 24 buckets readable; **0 unexplained constraints** |
| API routes | All facility routes — verification and authoring, import, capacity, governance, lifecycle — are adapters over the surface |
| Assistant projection | **Wired** (T8): the 22 capability descriptors, the six UI actions, and the guide are declared in `assistant-surface.js` and assembled into the host by `apps/api/src/assistant-host.js` |

The unbuilt operations are exported as `PENDING_ACTIONS` and `PENDING_CHANGE_KINDS` with the tier that owns each, so the gap is a recorded fact rather than a hole. `PENDING_CHANGE_KINDS` is empty and `PENDING_ACTIONS` holds one entry: `pin_policy_reference` has no store, because the schema stores a pinned policy reference on the row that uses it (`resilience_requirements.policy_id`, `waivers.policy_id`) and there is no revision-level pin table. `decide_allocation` is the one tool that is an addition to the action table: the API contract requires the allocation-decision route while the table named no operation for it.

### What the capacity work added

T6 made the allocator real. `packages/facility/src/capacity.js` holds it: `availableCapacity` is [D5] in one place (`commissioned × (1 − derating) − reserved − accepted`, where only `ACCEPTED` allocations count), and `contentionOrder` is [D6] (priority, then earliest `required_from`, then earliest request) with the tied group returned so the command can **refuse** it rather than pick a winner. `requestCapacityAllocation` records the demand request and answers it with a `PROVISIONAL` allocation when the budget has headroom or a `REJECTED` one with the shortfall; `decideAllocation` is the authorized accept/reject/revoke/expire and recomputes the budget's stored `allocated_value`/`available_value` in the same transaction. `get_capacity_budget` now recomputes availability from the formula rather than reading the stored projection back, so a budget written with a value of its own cannot make the read assert an availability no allocation supports. Two tools and three routes (`GET …/capacity`, `POST …/capacity-requests`, `POST …/allocations/{allocationId}`) expose it, and `decide_allocation` is a recorded addition to the action table above because the API contract requires the decision route while this document did not name an operation for it.

### What the authoring work added

`packages/facility/src/changes.js` is the commit pipeline and
`packages/facility/src/change-kinds.js` holds the kinds, so the pipeline orders,
applies, collects and commits while knowing nothing about containers or footprints.
`packages/facility/src/etags.js` holds the draft token (P0).

Four decisions came out of building it, each because the obvious version was wrong:

* **The command owns its own rollback.** Applying each change in a savepoint and
  relying on the caller to roll back on the throw is enough for the HTTP route and
  wrong for any other caller: one that caught the error and continued would commit a
  partially applied set. The set is therefore wrapped in its own savepoint, so the
  guarantee is local to the command rather than a property of its callers.
* **Idempotency is answered before the ETag.** A replay of a commit that already
  succeeded necessarily presents a stale token, so checking concurrency first refuses
  the replay of a successful write — the exact case the key exists for.
* **GeoJSON names types in title case and the enum is upper case.** Comparing them
  directly refused every geometry change, which is the kind of defect that looks like
  a validation rule until you read both sides.
* **A domain invariant belongs in the kind, not in a constraint name.** The store
  requires a level number on a `FLOOR` or `HALL` and forbids it elsewhere; surfacing
  that as `facility_containers_level_number_check` tells a caller nothing, so the kind
  answers with the rule instead.

One trade-off is recorded rather than solved: the diagnostics preview runs **inside**
the commit transaction, so a preview failure rolls the edit back. That is deliberate —
the preview writes a validation run, and a run describing a graph that was rolled back
would be a lie — but it does mean a defect in one check can block an edit.

### What the contract enforces in code

`execute` is the single entry point, and it applies the whole contract in one place: argument validation (unknown properties rejected, not ignored), context-identity verification (a mismatch is `403`, never a rewrite), permission re-assertion for every `requiredFunctions` key, a read-only refusal for writes, a `409 CONFIRMATION_REQUIRED` for an unconfirmed write carrying the call it would make, tenant-scoped execution under the GUC, result bounding, and one audit record per call including failed ones.

Two details are worth stating because they were decisions rather than defaults:

* **A page is bounded by bytes as well as by items, and it pages rather than trims.** The first implementation trimmed an over-budget result, which dropped the *tail* of the ordered list — and because diagnostics are ordered by severity and the newest finding of a group sorts last, that silently discarded current findings while keeping superseded history. A page now ends where the size cap requires and hands back a cursor, so nothing is ever dropped without a way to fetch it. `page_limited_by` says which bound applied, and the regression is covered by a test that pages 60 oversized diagnostics and asserts every current finding survives.
* **`grant_waiver` refuses an unresolvable policy reference.** The registry is the authority on whether a reference is pinned, and a governance record citing a policy that does not resolve is not auditable. The tool resolves it before recording anything and reports whether the policy promotes coverage.

### What the import work added

`packages/facility/src/asset-bindings.js` holds the binding domain: the role and review-state enums, the bindability verdict, the command, and the cross-context identity resolution. `create_asset_binding` validates the pinned version **inside the writing transaction**, because `asset_version_id` is deliberately not a foreign key across the two bounded contexts — the schema comment says it is validated against the project asset layer at write time, and that is exactly what the command does.

Three decisions are worth stating, because each is a place the obvious implementation is wrong:

* **A binding does not advance the draft ETag and emits no event.** Only *applying* an import is a typed change set, and that is what advances the token and emits `facility.revision.changed.v1` ([Import Adapters](import-adapters.md)). Pinning a source is provenance, not a change to the design graph. The consequence is that the create route carries no `If-Match` and returns no token to echo — a deliberate asymmetry with every other write in this surface, not an omission.
* **The client's bindability rule and the server's are the same rule, written twice.** `selectability()` in the browser and `bindability()` here both refuse quarantined, archived, deleted, unfinished, infected, and unverifiable versions, with the reason as text. The server refuses because a client that skips the picker must still be refused; the client refuses because a control that can only fail is worse than one that is disabled and explained.
* **The duplicate check needs the revision row locked.** Bindability, duplicate, and count are reads followed by an insert, so two concurrent binds of one version would both pass. `SELECT 1 FROM revisions ... FOR UPDATE` serialises them, which is cheaper than a unique index on a table whose identity legitimately includes the role — the same file may be both the source and the evidence.

The client half is `apps/web/src/facility/FacilityImport.jsx` at the tool's `import_map` route, using the shared `AssetPicker` that already existed, with the Import toolbar command opening that route. A version's representations are read per version rather than for the newest alone, because the picker offers version and representation as one choice and reading only the newest version's derivatives would offer a pair the user cannot actually make for an older one.

### Deltas from this specification, discovered while building it

| Change | Why |
| --- | --- |
| `NEAREST` dropped from `spatial_query` | "Nearest to what, over which candidate set, breaking ties how" has no answer the catalog asserts; a made-up tie-break returns a different answer than a reader expects. The other five predicates are well defined. |
| `include_freshness` dropped | Freshness is three scalars and always returned; a caller that must ask can forget to. |
| `list_diagnostics` returns `resourceKind` and `capabilityExact` | A resource-gated diagnostic does not record which resource kind it gated. The kind is recovered from the referenced source or budget where possible, and `capabilityExact: false` says plainly when `capabilities` is the possible set rather than a recorded attribution. |
| `revoke_waiver` does not require a revision | A waiver is addressed by its own id and scoped by project; requiring a revision would force a caller to look up a fact the operation does not need. |
| `AssetBinding.status` reads `UNREVIEWED`, not `DRAFT` | The workspace model lists `DRAFT \| REVIEWED \| APPLIED \| SUPERSEDED`, but the implemented column is the `review_state` enum the whole schema uses for transforms and mappings (`UNREVIEWED \| IN_REVIEW \| REVIEWED \| REJECTED`), and `get_asset_binding` already derived `authoritative` from it. The store is followed and the model is stale. |
| `get_asset_binding` adds `mappingsInReview` and `authoritative` | A binding's status is a review state, so "authoritative" is a derived judgement: the binding and every mapping are `REVIEWED`. |
| Every list returns `{ items, next_cursor, total, returned, truncated, page_limited_by, notice }` | A page must be distinguishable from a whole set, and a truncated result must say so. |
| `list_policies` and `resolve_policy_ref` read the registry, not a store | They carry no tenant data, so they run untenant-scoped. |

### Verification

* `packages/facility/src/tests/tools.test.js` — 34 tests: the coverage property, descriptor and selection rules, the full execution contract (404/400/403/409/`CONFIRMATION_REQUIRED`/degraded), audit emission, and reads exercised against the seeded baseline inside a rolled-back transaction.
* `apps/api/src/tests/facility-validation.test.js` — the routes are tested through the surface, so a route cannot drift from the layer.
* The whole suite: **197 facility tests, 71 API tests, 295 web tests, all passing.**

The capability filter in the Verify surface is now an exact match on the `capabilities` set the API derives from the catalog. It was previously absent because the diagnostic DTO did not carry a gating capability; deriving it at the tool boundary is what made the filter possible without a second mapping in the client.

## Acceptance Criteria

1. Every tool declares an axis, a store, a version, and `requiredFunctions`, and every handler re-asserts its declared permissions.
2. Every read takes `revision_id`; a `project_id`, `scenario_id`, or `revision_id` that differs from the resolved context returns `403`.
3. No tool resolves a display name to an identity.
4. Every list and query result is bounded, deterministically ordered, and self-describing when truncated.
5. For every evidence bucket in the catalog, at least one tool in this surface is a reader, enforced by a contract test.
6. `list_diagnostics` accepts `diagnostic_id` and `capability`, and returns `evidence` and a `capability` **set** on every diagnostic, derived from the catalog.
7. `list_diagnostics` excludes superseded diagnostics by default and includes them only on request.
8. A fresh `run_validation` result and a re-read of the same diagnostics are identical in shape.
9. Every read never mutates; every write declares `confirmation: required` and requires `base_revision_id` and `if_match`.
10. `grant_waiver` and `revoke_waiver` do not alter or delete a diagnostic.
11. `get_revision_context` reports lifecycle, the draft ETag, the content checksum, and the read-only flag.
12. `explain_constraint`, `list_policies`, and `resolve_policy_ref` read the catalog and the policy registry, and carry no duplicated rule text.
13. Every tool invocation emits one credential-free audit record.
14. No tool result contains raw document bytes, an object-store key, or a signed URL.
15. The tool names exposed in the assistant surface are identical to the names here, and a contract test compares the two registries.
