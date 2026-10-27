# Site and Facility Editor Interchange Contract

## Purpose and Scope

This document is the tool-level interchange contract for the Site and Facility Editor. It defines what crosses the tool boundary: the versioned protobuf messages the tool consumes and produces, the canonical enumerations those messages use, and the lifecycle and handoff semantics attached to them. It is the contract referenced by the [platform blueprint](../../architecture/ai_infrastructure_planner_blueprint.md).

In scope:

* The service boundary package `infrastructure.planner.facility.v1` and the `FacilityEditorInput` and `FacilityEditorResult` messages.
* The canonical enumerations. These are binding on every other document in this bundle; [Constraint Catalog](constraint-catalog.md) and [Decisions](decisions.md) extend them but may not redefine them.
* Boundary conventions, capacity and firm-availability semantics, lifecycle transitions, and command and handoff rules.
* The platform interchange linkage for `FacilityEnvelope`.

Out of scope, owned by the named document:

* Entity attributes, relationships, cardinality, invariants, and persistence models of the messages named here: [Entity Model](entity-model.md). This document states which entities are boundary-visible and which fields are required on the boundary; it does not restate their full shape.
* Collection names, indexes, storage engine, durability, and retention: [Entity Model](entity-model.md), [Storage Shape](storage-shape.md), and [Non-Functional Requirements](non-functional-requirements.md).
* Diagnostic identifiers and severities: [Constraint Catalog](constraint-catalog.md).
* Validation procedure and coverage derivation: [Verification Requirements](verification-requirements.md).

Where the same concept appears in both this document and [Entity Model](entity-model.md), this document is canonical for message membership, required boundary fields, enumerations, the capacity formula, and lifecycle state names. [Entity Model](entity-model.md) is canonical for entity attributes, relationship cardinality, cross-entity invariants, and table names; a shape or value list it shows is illustrative and must match this document.

## Contract Conventions

The service boundary uses versioned protobuf messages in `infrastructure.planner.facility.v1`. CAD, BIM, GIS, CSV, and vendor-study files enter only through the shared [workspace import and conversion framework](../../workspace/import-adapters.md) and its registered adapters, then normalize into this contract through the facility [Import Mapping](import-adapters.md).

| Convention | Requirement |
| --- | --- |
| Identity | Every persistent entity has an immutable UUID. Runtime offsets and display names are not cross-contract references. |
| Revision | Every request names `project_id`, `scenario_id`, and `base_revision_id`. A `DRAFT` revision is mutable in place under optimistic concurrency; every output is an immutable snapshot with a `revision_id` and `content_checksum`. |
| Concurrency | A mutating request carries `If-Match` with the draft ETag and `base_revision_id` with the branch origin. Both are validated. See [D2](decisions.md). |
| Time | Timestamps use RFC 3339 UTC. Phase dates declare their precision. |
| Units | Normalized values use SI base and derived units: W, K, m, m², m³, s, and count. Source-unit values and conversion records are retained. See [D10](decisions.md). |
| Geometry | Every geometry record declares a coordinate reference system in EPSG form, plus an optional compound vertical CRS. WGS 84 GeoJSON is mandatory as the interoperable representation; the projected representation is authoritative for measurement. See [D9](decisions.md). |
| Provenance | Imported, studied, catalog, and assumed values carry `source_ref`, `effective_at`, `confidence`, and `owner`. Values derived from an asset also carry the pinned `asset_version_id` and `binding_id`. |
| Coverage | `CapabilityCoverage` is derived from validation evidence, never asserted directly. See [D11](decisions.md). |
| Lifecycle | `DRAFT` is editable. `VALIDATED` is immutable and has no applicable `ERROR` diagnostic. `PUBLISHED` is an immutable published snapshot. Publishing is a one-way `VALIDATED` to `PUBLISHED` transition; a change requires a new draft branched from the published revision. An `ApprovalAttestation` authorizes one validated or published revision without changing it. |
| Extensibility | Field numbers are never reused; removed fields and enum values are reserved. Unknown enum values are preserved and treated as unknown-safe by consumers. |

## Canonical Enumerations

| Enum | Values | Notes |
| --- | --- | --- |
| `Capability` | `GEOMETRY`, `POWER`, `COOLING`, `WATER`, `FUEL`, `NETWORK_ENTRY`, `ENVIRONMENT`, `PHASING` | Exactly one coverage record exists per capability. |
| `CapabilityStatus` | `NOT_PROVIDED`, `PROVISIONAL`, `VALIDATED` | Derived from validation; see D11. |
| `LifecycleState` | `DRAFT`, `VALIDATED`, `PUBLISHED` | Transitions are one-way: `DRAFT` to `VALIDATED` on a clean full validation run, `VALIDATED` to `PUBLISHED` on publish. |
| `EntityType` | `SITE`, `PARCEL`, `BUILDING`, `FLOOR`, `HALL`, `SUPPORT_SPACE`, `EQUIPMENT_YARD`, `RESERVED_AREA`, `UTILITY_SOURCE`, `UTILITY_INTERFACE`, `UTILITY_ROUTE`, `SPATIAL_CONSTRAINT`, `ENVIRONMENTAL_PROFILE`, `ENVIRONMENTAL_CONSTRAINT`, `FACILITY_PHASE`, `FAILURE_DOMAIN`, `RESILIENCE_REQUIREMENT`, `FUEL_STORAGE`, `WATER_STORAGE`, `CAPACITY_BUDGET`, `ASSUMPTION`, `WAIVER`, `DOCUMENT` | `entity_registry.entity_type` uses these values. Ownership boundaries are in [Overview](Overview.md). |
| `GeometryRole` | `BOUNDARY`, `FOOTPRINT`, `FLOOR_BOUNDARY`, `ROOM_BOUNDARY`, `ROUTE`, `CONNECTION_POINT`, `CONSTRAINT_AREA`, `REFERENCE_POINT` | Required roles per entity kind are normative in [Entity Model](entity-model.md). |
| `GeometryType` | `POINT`, `LINESTRING`, `POLYGON`, `MULTIPOLYGON` | |
| `ScopeKind` | `CAMPUS`, `SITE`, `PARCEL`, `BUILDING`, `BUILDING_LOCAL` | |
| `ContainerKind` | `PARCEL`, `BUILDING`, `FLOOR`, `HALL`, `SUPPORT_SPACE`, `EQUIPMENT_YARD`, `RESERVED_AREA` | |
| `ConstraintKind` | `SETBACK`, `EASEMENT`, `ACCESS_ROUTE`, `HEIGHT_LIMIT`, `HAZARD_ZONE`, `EXCLUSION_ZONE`, `REGULATORY_LIMIT` | |
| `ResourceKind` | `POWER`, `COOLING`, `WATER`, `FUEL`, `NETWORK_ENTRY` | |
| `CapacityBasis` | `IT_LOAD`, `FACILITY_INPUT`, `HEAT_REJECTION`, `WATER_FLOW`, `USABLE_FLOOR_AREA`, `NETWORK_ENTRY_COUNT`, `FUEL_VOLUME`, `AUTONOMY_DURATION` | Comparisons require matching resource kind, basis, phase, and normalized unit. |
| `QuantityState` | `MEASURED`, `CONTRACTUAL`, `FIRM`, `PLANNED`, `COMMISSIONED`, `ASSUMED` | Only `FIRM` and `COMMISSIONED` contribute to firm availability; see D5. |
| `SupplyState` | `CONTRACTUAL`, `FIRM`, `PLANNED`, `COMMISSIONED` | The subset of `QuantityState` valid for a utility source capacity claim. |
| `ServiceState` | `AVAILABLE`, `PLANNED`, `SUSPENDED`, `RETIRED` | |
| `AllocationState` | `PROVISIONAL`, `ACCEPTED`, `REJECTED`, `EXPIRED`, `REVOKED` | Only `ACCEPTED` reduces available capacity. |
| `Priority` | `RESERVED`, `CRITICAL`, `HIGH`, `NORMAL`, `LOW` | Contention order is defined in D6. |
| `ConsumerType` | `FLOORPLAN`, `RACK`, `POWER`, `THERMAL`, `NETWORK`, `CABLING`, `VERIFY`, `SIMULATION`, `COST_SCHEDULE`, `DEPLOYMENT` | Used by `ImpactNotice.invalidated_consumer_types`. |
| `PhaseStatus` | `PLANNED`, `UNDER_CONSTRUCTION`, `COMMISSIONING`, `AVAILABLE`, `RETIRED` | |
| `AvailabilityPolicy` | `N`, `N_PLUS_1`, `TWO_N`, `TWO_N_PLUS_1`, `N_PLUS_2` | Referenced by a `PolicyReference`; see D7. |
| `ReviewState` | `UNREVIEWED`, `IN_REVIEW`, `REVIEWED`, `REJECTED` | |
| `TransformMethod` | `DECLARED_CRS`, `CONTROL_POINTS_HELMERT`, `CONTROL_POINTS_AFFINE`, `FITTED_RESIDUAL`, `MANUAL` | |
| `DiagnosticStatus` | `OPEN`, `ACKNOWLEDGED`, `WAIVED`, `RESOLVED`, `SUPERSEDED` | |
| `Severity` | `ERROR`, `WARNING`, `INFO` | |
| `RemediationCategory` | `ADD_DATA`, `CORRECT_GEOMETRY`, `RESOLVE_CONFLICT`, `UPDATE_CAPACITY`, `ADJUST_PHASE`, `OBTAIN_APPROVAL`, `REVIEW_IMPORT`, `RECONFIGURE_RESILIENCE`, `CONTACT_RESPONSIBLE_PARTY`, `REVIEW_POLICY` | |
| `ApprovalDecision` | `APPROVED`, `REJECTED`, `REVOKED` | |
| `ApprovalState` | `NOT_REQUIRED`, `PENDING`, `APPROVED`, `REJECTED`, `REVOKED` | |
| `EntityStatus` | `IMPORTED_REFERENCE`, `PROVISIONAL`, `VALIDATED`, `SUPERSEDED` | Presentation and trust state of a normalized entity. |
| `DocumentKind` | `CAD_DRAWING`, `GIS_DATASET`, `KML`, `BIM_MODEL`, `VENDOR_STUDY`, `PERMIT`, `SURVEY`, `CONTACT_RECORD`, `OTHER` | |
| `CostScheduleKind` | `COST`, `SCHEDULE`, `SUSTAINABILITY` | Reference-only kinds owned by the Cost, Schedule, and Sustainability workspace. |

Permission keys used by the API, the UI, and the assistant are cataloged in [Backend API Contracts](backend-api-contracts.md).

## Input Contract

```text
FacilityEditorInput
  header: ContractHeader
  asset_bindings[]: AssetBinding
  spatial_transforms[]: SpatialTransform
  import_mappings[]: ImportMapping
  project_context: ProjectContext
  site_references[]: SiteReference
  geometry_records[]: GeometryRecord
  facility_program: FacilityProgram
  utility_sources[]: UtilitySource
  failure_domains[]: FailureDomain
  resilience_requirement: ResilienceRequirement
  storage_reserves[]: StorageReserve
  environmental_profiles[]: EnvironmentalProfile
  policies[]: PolicyReference
  assumptions[]: Assumption
  documents[]: Document
  demand_requests[]: CapacityDemandRequest
```

`ContractHeader` contains `contract_version`, `project_id`, `scenario_id`, `base_revision_id`, `producer`, `issued_at`, and `correlation_id`. Unknown versions, missing base revisions, and cross-project references are rejected before domain validation.

Imported content enters as an `AssetBinding` to an exact project asset version ([Project Assets](../../workspace/project-assets.md)). `SpatialTransform`, `ImportMapping`, and the normalized entities are the facility detail of that binding. This contract does not define the file record; the asset layer owns it.

| Message | Required fields | Rules |
| --- | --- | --- |
| `ProjectContext` | `target_it_load_w`, `availability_policy_id`, `growth_horizon`, `catalog_version`, `approval_state` | Defines intent. The editor allocates against it but does not silently change it. |
| `AssetBinding` | `binding_id`, `asset_version_id`, `representation_id?`, `role`, `status`, `tool_id` | Binds one exact asset version from the project asset store; the tool never owns or re-uploads the file. Defined in [Project Assets](../../workspace/project-assets.md). |
| `SpatialTransform` | `transform_id`, `binding_id`, `asset_version_id`, `source_units`, `target_units`, `target_coordinate_reference_system`, `method`, `review_state` | Source CRS is required unless at least two reviewed control points define the transform. Fitted transforms require residual error. |
| `ImportMapping` | `mapping_id`, `binding_id`, `asset_version_id`, `transform_id`, `source_selector`, `target_entity_type`, `attribute_mapping`, `review_state` | Selects a CAD layer/block/attribute rule, a KML feature group, or a BIM spatial element. Ambiguous or unmapped required source content produces an import diagnostic. |
| `SiteReference` | `site_id`, `name`, `boundary_geometry_id`, `coordinate_reference_system`, `jurisdiction`, `source_ref` | Parcel geometry is valid and georeferenced. Geometry is referenced by a `GeometryRecord`, never embedded. Regulatory overlays are distinct geometry records. |
| `GeometryRecord` | `geometry_id`, `entity_id`, `entity_type`, `role`, `ordinal`, `geometry_type`, `geojson_4326`, `projected_geometry`, `projected_coordinate_reference_system` | Defined in full in [Entity Model](entity-model.md). |
| `FacilityProgram` | `containers[]`, `phases[]` | Containers reference one parent or one site; phases form an acyclic graph. `spaces` is no longer a separate table; a shop floor, hall, or support space is a `FacilityContainer.kind`. |
| `UtilitySource` | `utility_source_id`, `kind`, `connection_point`, `capacity`, `capacity_state`, `failure_domain_id`, `available_from`, `source_ref` | `kind` is power, cooling, water, fuel, or network entry. Capacity declares contractual, firm, planned, or commissioned state. |
| `FailureDomain` | `failure_domain_id`, `name`, `kind`, `source_ref` | `parent_failure_domain_id?` nests domains; containment must be acyclic and within one revision. Independence claims are evaluated against prohibited shared ancestors. |
| `ResilienceRequirement` | `requirement_id`, `availability_policy`, `policy_id`, `applies_to[]`, `source_ref` | `applies_to[]` names resource kinds. Optional `autonomy_duration` declares the required fuel or water runtime. On-site power equipment is owned by the Power Supplier Editor; this tool records only the requirement. |
| `StorageReserve` | `storage_id`, `kind`, `capacity`, `autonomy_duration`, `failure_domain_id`, `phase_id`, `source_ref` | `kind` is `FUEL` or `WATER`. `capacity` uses basis `FUEL_VOLUME` or `WATER_FLOW`; `autonomy_duration` uses `AUTONOMY_DURATION` and is compared against the resilience requirement. |
| `EnvironmentalProfile` | `profile_id`, `site_id`, `design_weather_ref`, `hazard_classifications[]`, `permit_constraints[]`, `effective_at` | Reusable only within its declared site and climate scope. |
| `PolicyReference` | `policy_id`, `version`, `kind`, `source_ref` | Covers availability, reserve, derating, code, environmental, and staleness policy. Policy text is not copied into tool state; only the pinned reference is stored. |
| `Assumption` | `assumption_id`, `statement`, `owner`, `confidence`, `effective_at`, `status` | An unresolved assumption forces `PROVISIONAL` coverage and emits `facility.data.assumption.unresolved`. |
| `Document` | `document_id`, `kind`, `title`, `media_type`, `content_checksum`, `owner` | Operational and permit metadata. A document never substitutes for a project asset or a normalized entity. |
| `CapacityDemandRequest` | `request_id`, `consumer_type`, `consumer_id`, `phase_id`, `resource_kind`, `requested_capacity`, `required_from`, `priority` | A downstream request for allocation. It cannot modify facility entities or utility sources. |

`capacity` and `requested_capacity` contain `value`, `unit`, `basis`, and `state`. `basis` identifies meanings such as IT load, facility input, heat rejection, water flow, usable floor area, network-entry count, fuel volume, or autonomy duration. Comparisons require matching resource kind, basis, phase, and normalized unit.

### Capacity and Firm-Availability Semantics

| Quantity state | Contributes to firm availability | Meaning |
| --- | --- | --- |
| `COMMISSIONED` | yes | Physically available and accepted. |
| `FIRM` | yes | Contractually firm and not revocable within the planning horizon. |
| `CONTRACTUAL` | no | Contracted but not yet firm. |
| `PLANNED` | no | Planned future capability. |
| `MEASURED` | no | Observed evidence only; not an allocation source. |
| `ASSUMED` | no | Planning assumption; forces `PROVISIONAL`. |

```text
firm_capacity          = sum(capacity where state in {FIRM, COMMISSIONED})
derating_factor        = PolicyReference(kind = DERATING) value, default 0
reserve                = PolicyReference(kind = RESERVE) or redundancy policy result
available_capacity     = firm_capacity * (1 - derating_factor) - reserve - sum(ACCEPTED allocations)
```

A negative `available_capacity` is an `ERROR` diagnostic (`facility.capacity.budget.overcommit`). A claim that depends on `PLANNED` or `ASSUMED` capacity is a `WARNING` (`facility.capacity.planned.firm_claim`) and caps the resource capability at `PROVISIONAL`.

`CapacityAllocation` decisions follow the deterministic contention order in [D6](decisions.md): `RESERVED`, `CRITICAL`, `HIGH`, `NORMAL`, `LOW`, then earliest `required_from`, then earliest request. An allocation is `PROVISIONAL` until an authorized allocator accepts it; only `ACCEPTED` allocations reduce `available_capacity`.

### Document Import Rules

Imported files are first-class project assets ([Project Assets](../../workspace/project-assets.md)); this tool binds an exact asset version and never owns, copies, or re-uploads the file. Adapters, per-format fidelity, unit and CRS detection, the selector grammar, and adapter limits are specified in the shared [workspace import and conversion framework](../../workspace/import-adapters.md). The mapping of extracted content to facility entities is specified in [Import Mapping](import-adapters.md). The contract-level rules are:

| Source format | Import rule |
| --- | --- |
| KML/KMZ | Preserve WGS 84 geometry, altitude mode, feature hierarchy, styles, and attributes. Convert to project CRS while retaining original coordinates. |
| DXF | Retain layers, blocks, geometry, and text. Confirm units and CRS, or define a reviewed transform, before using geometry as authoritative. |
| DWG | Use a licensed or managed conversion adapter to a documented intermediate form such as DXF or IFC. Preserve the original artifact and converter version; do not claim complete feature parity. |
| IFC | Parse with a registered IFC adapter. Preserve the original model; map the spatial structure to facility containers, mapped planar representations to geometry records, and property sets to attribute mapping. Record unit assignment, map conversion, and tessellation tolerance. MEP, structural, and analysis content remains reference-only unless explicitly mapped. |
| Other formats | Use the same artifact, transformation, mapping, review, and provenance requirements. Unsupported features create diagnostics rather than silent data loss. |

The normalized model stores an `AssetBinding`, a `SpatialTransform`, and one or more `ImportMapping` records over a pinned asset version. Source-only labels, dimensions, hatches, styles, and unsupported blocks remain source metadata unless explicitly mapped to an engineering attribute.

## Output Contract

Every shared result has a mandatory core, explicit coverage, and conditional extensions. Absence of an extension never implies unlimited capacity or a successful verification.

| Requirement level | Object | Rule |
| --- | --- | --- |
| Mandatory | `ContractHeader` and envelope identity | Every result has contract/project/scenario/revision identity, producer, issue time, `envelope_id`, lifecycle state, `content_checksum`, and at least one pinned asset version reference. |
| Mandatory | `FacilityDesignContext` | Contains one design scope, one or more spatially bounded facility containers, coordinate reference systems and parent relationships, plus spatial constraints. This is the minimum safe Floorplan and Route handoff. |
| Mandatory | `CapabilityCoverage` and `ValidationSummary` | Declares coverage for geometry, power, cooling, water, fuel, network entry, environment, and phasing, plus checks actually run. Each state is `NOT_PROVIDED`, `PROVISIONAL`, or `VALIDATED`. |
| Conditional | `SiteContext` | Required for site-level geographic, jurisdictional, hazard, or regulatory claims. |
| Conditional | `UtilityInterface` and `CapacityBudget` | Required together when exposing a utility interface, allocating a resource, or claiming available capacity. |
| Conditional | `FailureDomain` and resilience assessment | Required when a resilience or availability policy is declared or evaluated. |
| Conditional | `EnvironmentalConstraint` | Required when cooling, water, ambient, hazard, emissions, or permit constraints are declared or evaluated. |
| Conditional | `FacilityPhasePlan` | Required for multiple phases, stated commissioning dates, or later capacity availability. |
| Conditional | `CapacityAllocation` | Included only as a response to a `CapacityDemandRequest`. |
| Optional | `Document` and `Assumption` | Included when operational, permit, or assumption records exist. |
| Optional | `CostScheduleReference` | Reference-only link to a cost, schedule, or sustainability record owned by another workspace; included for traceability and never consumed by a validation check. |
| Optional event | `ImpactNotice` | Included when a shared or published revision supersedes an earlier revision. |
| Optional governance | `Waiver` and `ApprovalAttestation` | Included after an authorized decision; deployment policy may require an attestation. |

```text
FacilityEditorResult
  header: ContractHeader                                      [required]
  facility_envelope: FacilityEnvelope                         [required]
  diagnostics[]: FacilityDiagnostic                           [required; may be empty]
  allocation_decisions[]: CapacityAllocation                  [conditional]
  impact_notice: ImpactNotice                                 [optional event]
  waivers[]: Waiver                                           [optional governance]
  approval_attestation: ApprovalAttestation                   [optional governance]

FacilityEnvelope
  envelope_id: UUID                                           [required]
  revision_id: UUID                                           [required]
  lifecycle_state: DRAFT | VALIDATED | PUBLISHED             [required]
  content_checksum: string                                    [required]
  published_at?: timestamp                                    [conditional]
  design_context: FacilityDesignContext                       [required]
  capability_coverage[]: CapabilityCoverage                  [required]
  validation_summary: ValidationSummary                       [required]
  asset_version_refs[]: AssetVersionRef                      [required; min 1]
  asset_bindings[]: AssetBinding                              [conditional]
  import_report: ImportReport                                 [conditional]
  site_context: SiteContext                                   [conditional]
  utility_interfaces[]: UtilityInterface                      [conditional]
  failure_domains[]: FailureDomain                            [conditional]
  resilience_assessment: ResilienceAssessment                 [conditional]
  environmental_constraints[]: EnvironmentalConstraint        [conditional]
  capacity_budgets[]: CapacityBudget                          [conditional]
  phase_plan: FacilityPhasePlan                               [conditional]
  assumptions[]: Assumption                                   [conditional]
  documents[]: Document                                       [conditional]
  cost_schedule_refs[]: CostScheduleReference                  [optional]
```

| Message | Required fields | Consumer guarantee |
| --- | --- | --- |
| `FacilityEnvelope` | Core identity, `design_context`, coverage, validation summary, pinned asset versions, content checksum | Immutable self-contained facility snapshot with stable IDs. |
| `FacilityDesignContext` | `scope`, `containers[]`, CRS, `spatial_constraints[]` | Enables downstream authoring without asserting utility or environment feasibility. |
| `CapabilityCoverage` | `capability`, `status`, evidence references | Makes absent and provisional data machine-readable. Status is derived, not asserted. |
| `ValidationSummary` | `run_id`, `revision_id`, checked/not-checked capabilities, error/warning counts | States exactly what `VALIDATED` covers. |
| `UtilityInterface` | `interface_id`, source, resource kind, connection point, capacity/state, failure domain, phase, service state | Planning-level handoff. Downstream power and thermal tools cannot redefine the source. |
| `FailureDomain` | ID, name, kind, parent | Makes independence claims machine-checkable. |
| `ResilienceAssessment` | requirement ID, policy, achieved redundancy, autonomy duration, unmet requirements | States whether the declared availability policy is met without redesigning equipment. |
| `CapacityBudget` | ID, owner, phase, resource, commissioned/planned/reserved/allocated/available capacity, basis | `available_capacity` excludes planned capacity and includes only firm commissioned capacity less reserve and accepted allocations. |
| `CapacityAllocation` | ID, request, budget, allocated capacity, state, valid-from, revision | `PROVISIONAL` cannot satisfy a hard gate; `ACCEPTED` is included in the budget. |
| `ImportReport` | asset version, binding, transform, and mapping IDs; mapped/unmapped counts; diagnostics; review state | Auditable conversion of a project asset version. Geometry cannot be claimed validated with an unresolved required mapping. |
| `FacilityDiagnostic` | ID, constraint, severity, entities, evidence, remediation, revision | Supports tool and Verify displays; it is not a waiver. Shape and IDs are in [Constraint Catalog](constraint-catalog.md). |
| `Waiver` | ID, revision, diagnostic IDs, scope, approver, policy, granted/expiry times | Suppresses the gating effect of named diagnostics without deleting them. |
| `CostScheduleReference` | ID, kind, provider, external entity reference, label, source reference, linked entity references | Traceability only. Owned elsewhere ([D18](decisions.md)); never editable here and never gating. |
| `ImpactNotice` | project, previous/current revision, changed entities, invalidated consumer types | Allows dependent tools to invalidate derived data. |
| `ApprovalAttestation` | ID, envelope/revision, approver, timestamp, policy, decision | Authorizes one immutable validated snapshot; rejection or revocation is a new attestation. |

## Input to Output Mapping

| Input | Output | Rule |
| --- | --- | --- |
| `SiteReference` + `GeometryRecord(BOUNDARY)` | `SiteContext`, `FacilityContainer(PARCEL)` | A site reference produces one parcel container and one site context entry; the boundary geometry stays a separate record. |
| `FacilityProgram.containers[]` | `design_context.containers[]` | Container kinds map directly; parent links are validated for cycles and scope. |
| `FacilityProgram.phases[]` | `FacilityPhasePlan`, `FacilityPhase` | Phase order and dependencies produce the acyclic plan; capability availability is derived from interfaces and budgets. |
| `UtilitySource` | `UtilityInterface` and `CapacityBudget` | Each source produces at least one interface per phase it serves and one budget per resource kind, basis, and phase. |
| `FailureDomain[]` + `ResilienceRequirement` + `StorageReserve[]` | `FailureDomain[]`, `ResilienceAssessment` | Independence and autonomy are evaluated against the requirement; unresolved evidence stays `PROVISIONAL`. |
| `EnvironmentalProfile` | `EnvironmentalConstraint[]` | Profiles are expanded into constraints scoped to their site and effective period. |
| `Assumption[]` | `assumptions[]`, coverage `PROVISIONAL` | An unresolved assumption prevents `VALIDATED` coverage for every capability it touches. |
| `Document[]` | `documents[]` | Documents are referenced, never inlined. |
| `CapacityDemandRequest` | `CapacityAllocation` | One decision per request, governed by the contention order in D6. |

## Lifecycle Transitions

| From | To | Trigger | Constraints |
| --- | --- | --- | --- |
| `DRAFT` | `DRAFT` | Any accepted change set | Advances the draft ETag; never changes lifecycle state. |
| `DRAFT` | `VALIDATED` | A completed `FULL` validation run with no applicable `ERROR` diagnostic | Coverage is derived and written with the run. |
| `VALIDATED` | `PUBLISHED` | Authorized publish command | Sources and policies are pinned; approval is recorded where policy requires it. |
| `VALIDATED` or `PUBLISHED` | none | Any write | Rejected as immutable (`facility.revision.writes_immutable`). |

Every transition is one-way. A `VALIDATED` revision is immutable, so a change after validation is a new `DRAFT` branched from it, never a reversion of the validated snapshot. A `PUBLISHED` revision likewise never returns to `DRAFT` or `VALIDATED`; a correction or extension is a new draft branched from it with a recorded `base_revision_id`. Rejecting or revoking an approval attestation changes only the attestation record, never the lifecycle state.

## Commands and Handoff Rules

| Operation | Preconditions | Result |
| --- | --- | --- |
| Create draft | Valid `base_revision_id` and entity authorization | A new mutable `DRAFT` revision at the branch point, with ETag. |
| Update draft | `If-Match` equals the current draft ETag; entity is not immutable; lifecycle is `DRAFT` | New entity versions within the same draft, new ETag, `facility.revision.changed.v1` event. No child revision is created. |
| Branch revision | A valid source revision and authorization | A new independent `DRAFT` revision that records its `base_revision_id`. |
| Bind external data | A project asset version is selected or imported, with adapter evidence for units, CRS, and source reference | A draft binding, a reviewed transform and mapping, normalized draft entities, and import diagnostics tied to the pinned asset version. |
| Share design context | Mandatory context, coverage, summary, and provenance present | A draft handoff for downstream authoring; `NOT_PROVIDED` and `PROVISIONAL` remain unresolved. |
| Request allocation | Valid facility revision, phase, resource, and consumer | Allocation decision plus budget update, or rejection diagnostic. |
| Validate | Required pinned asset versions resolve and are scan-clean | Complete diagnostic batch; state becomes `VALIDATED` only without applicable `ERROR` diagnostics, and coverage is derived. |
| Publish | Revision is `VALIDATED`; sources and policies are pinned | Lifecycle transitions to `PUBLISHED`; immutable Facility Envelope with `published_at` and `content_checksum`, plus an Impact Notice. |
| Approve | Authorized approver accepts a validated revision | Approval attestation; the envelope is not reissued solely to change approval state. |
| Grant waiver | Authorized waiver approver, named diagnostics, unexpired policy | A `Waiver` record; the diagnostic becomes `WAIVED` without changing its evidence. |

Consumers never write directly to `FacilityEnvelope`, `UtilityInterface`, or `CapacityBudget`. They submit a demand or change request and consume a later published revision.

## Platform Interchange Linkage

`FacilityEnvelope` is a separate versioned sub-contract referenced by the platform `DesignBlueprint`; it is not inlined. See [D3](decisions.md) and [D4](decisions.md).

```text
DesignBlueprint.facility_envelope_ref
  envelope_id: UUID
  revision_id: UUID
  content_checksum: string
  proto_package: "infrastructure.planner.facility.v1"
```

Authoring keeps facility UUIDs. At runtime compilation the verifier assigns `uint32` design IDs and publishes the inverse index registry with the runtime image, so every runtime failure maps back to a facility `entity_id`. The facility contract never exposes `uint32` offsets, and `DesignBlueprint.ContainerNode.x/y/z` is derived from the projected geometry, never the reverse.
