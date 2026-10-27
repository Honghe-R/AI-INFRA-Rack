# Site and Facility Editor Entity Model

## Purpose and Scope

This document defines the canonical entity model for the entities the Site and Facility Editor owns: their terminology, full value and entity shapes, relationships, cross-entity invariants, and persistence models. It is the reference for how entities relate, what constraints hold across them, and how the graph maps to stored tables.

In scope:

* The terminology used across the bundle.
* Common value shapes and the complete attribute shape of each entity.
* Ownership boundaries between this tool and the other tools in the platform.
* Required geometry roles and level and elevation semantics.
* Entity relationships, cardinality, and cross-entity invariants.
* The persistence models (tables, identities, reference fields) reconciled with [Storage Shape](storage-shape.md).

Out of scope, owned by the named document:

* Which entities and fields cross the tool boundary, and the canonical enumerations: [Interchange Contract](interchange-contract.md). This document never redefines a boundary message, an enumeration, the capacity formula, or a lifecycle state name.
* Storage engine, durability, retention, and partitioning: [Storage Shape](storage-shape.md) and [Non-Functional Requirements](non-functional-requirements.md).
* Diagnostic identifiers and severities: [Constraint Catalog](constraint-catalog.md).
* Validation procedure and coverage derivation: [Verification Requirements](verification-requirements.md).

Enumerations are defined once in [Interchange Contract](interchange-contract.md) and referenced here by name. Where this document and [Interchange Contract](interchange-contract.md) disagree, the interchange contract wins for boundary membership, required fields, and enumerations, and [Decisions](decisions.md) wins for a recorded decision.

## Terminology

| Term | Meaning in this document |
| --- | --- |
| **Entity** | A persistent, addressable domain object with an immutable UUID, such as a building, utility source, phase, or spatial constraint. |
| **Design context** | The minimum spatial scope and constraints needed for downstream authoring. It can exist without complete power, cooling, environmental, or phasing data. |
| **Facility container** | A spatially bounded physical object in the facility hierarchy, such as a parcel, building, floor, hall, equipment yard, or reserved area. Containers form a parent-child tree. The site itself is a `DesignScope`, not a container. |
| **Geometry record** | A first-class, revisioned spatial record linked to exactly one domain entity by stable `entity_id` and `entity_type`. An entity may own multiple geometry records with distinct semantic roles. |
| **Geometry role** | The meaning of a geometry for its entity, such as `BOUNDARY`, `FOOTPRINT`, `FLOOR_BOUNDARY`, `ROUTE`, `CONNECTION_POINT`, or `CONSTRAINT_AREA`. |
| **Scope** | The boundary of the design being described, for example a site-wide, building-wide, or building-local context. |
| **Envelope** | An immutable, revisioned snapshot of the facility context and the capabilities it declares. A Facility Envelope is a handoff artifact, not a mutable working document. |
| **Revision** | A project/scenario-specific version of the design. A draft is mutable in place under optimistic concurrency; a published revision is immutable. See [D1](decisions.md). |
| **Snapshot** | A frozen representation of data at a particular revision, source version, or validation run. |
| **Capability coverage** | An explicit, derived statement of whether a capability is `NOT_PROVIDED`, `PROVISIONAL`, or `VALIDATED`; absence never means unlimited capacity. |
| **Authoritative** | Accepted as the source of truth for its entity type within a revision. Project assets and reference-only geometry are not authoritative by themselves. |
| **Provisional** | Usable for exploration or downstream authoring but not sufficient to satisfy a hard validation or publication gate. |
| **Validated** | All checks applicable to the declared capability coverage passed for the referenced revision and pinned asset versions. It does not imply that undeclared capabilities were checked. |
| **Project asset** | A project-scoped, versioned external file such as CAD, KML/KMZ, DWG, BIM, raster, or a vendor study, retained in object storage with provenance and consumed by tools through bindings. Defined in [Project Assets](../../workspace/project-assets.md). |
| **Asset binding** | This tool's consumption of one exact asset version and representation, carrying the reviewed transform and mappings. |
| **Spatial transform** | The reviewed conversion from a pinned asset version's units and coordinate reference system into the project's coordinate reference system. |
| **Import mapping** | The rule that maps source layers, blocks, feature groups, or attributes to normalized entity types. |
| **Import feature** | A single extracted source feature with its selector, raw attributes, and reference-only or mapped status. |
| **Utility source** | A planning-level provider of power, cooling, water, fuel, or network-entry capacity. |
| **Utility interface** | A downstream handoff point connected to exactly one utility source; downstream tools may add equipment but cannot redefine the source. |
| **Capacity budget** | A resource allowance owned by an entity and phase, partitioned into commissioned, planned, reserved, allocated, and available quantities. |
| **Capacity allocation** | The editor's decision responding to one downstream capacity-demand request. |
| **Failure domain** | A named set of components sharing a common failure cause, optionally nested under a parent domain. Resilience checks require independent paths not to share a prohibited domain. |
| **Resilience requirement** | A planning-level availability policy plus optional autonomy duration that the facility must satisfy for named resource kinds. |
| **Storage reserve** | Planning-level fuel or water storage with a capacity and an autonomy duration, evaluated against the resilience requirement. |
| **Assumption** | A recorded unresolved input with an owner, confidence, and status. An active assumption caps coverage at `PROVISIONAL`. |
| **Document** | An operational, permit, or reference artifact linked to entities. A document is metadata, never a source of authoritative geometry. |
| **Diagnostic** | An append-only validation finding with a stable constraint ID, affected entities, evidence, severity, and remediation category. |
| **Waiver** | A separately authorized governance record that suppresses the gating effect of named diagnostics for a scope and revision without altering them. |
| **Approval attestation** | A separate immutable authorization record targeting one validated revision; it does not mutate the Facility Envelope. |

## Common Value Shapes

```text
ContractHeader
  contract_version
  project_id, scenario_id, base_revision_id
  producer, issued_at, correlation_id

EntityRef
  entity_type: EntityType
  entity_id: UUID

Quantity
  value: decimal
  unit: string
  basis: CapacityBasis
  state: QuantityState

Provenance
  source_ref: string
  effective_at: timestamp
  confidence: HIGH | MEDIUM | LOW
  owner: string
  asset_version_id?: UUID
  binding_id?: UUID

GeometryRecord
  geometry_id: UUID
  revision_id: UUID
  entity_id: UUID
  entity_type: EntityType
  role: GeometryRole
  ordinal: uint32
  geometry_type: GeometryType
  geojson_4326: GeoJSON Feature
  projected_geometry: geometry
  projected_coordinate_reference_system: string
  vertical_coordinate_reference_system?: string
  parent_transform_id?: UUID
  elevation_base_m?: decimal
  elevation_top_m?: decimal
  height_m?: decimal
  asset_version_id?: UUID
  binding_id?: UUID
```

All persistent entities have `id`, `project_id`, `scenario_id`, `created_at`, `created_by`, and provenance. Entities in a published Facility Envelope also retain the `revision_id` that froze them. Quantities are stored in normalized SI units, while source-unit values and conversions are preserved in import metadata.

Geometry is never embedded in a `SiteReference`, `Parcel`, `Building`, `FacilityContainer`, route, or constraint record. Each such entity is linked to one or more `GeometryRecord` objects by stable `entity_id` and `entity_type`. `geojson_4326` is the interoperable GeoJSON representation using WGS 84 coordinates; `projected_geometry` is the authoritative projected representation used for local measurements and spatial checks. A building's 3D envelope is represented by a `FOOTPRINT` polygon plus `elevation_base_m` and `height_m` or `elevation_top_m`; detailed BIM/mesh assets remain separate object-store artifacts.

### Entity Ownership Boundaries

This tool writes only the entity types below. Other tool-owned entity types are referenced, never created here. See [D8](decisions.md).

| Entity type | Owned here | Referenced only |
| --- | --- | --- |
| `SITE`, `PARCEL`, `BUILDING`, `FLOOR`, `HALL`, `SUPPORT_SPACE`, `EQUIPMENT_YARD`, `RESERVED_AREA` | yes | |
| `UTILITY_SOURCE`, `UTILITY_INTERFACE`, `UTILITY_ROUTE` | yes | |
| `SPATIAL_CONSTRAINT`, `ENVIRONMENTAL_PROFILE`, `ENVIRONMENTAL_CONSTRAINT` | yes | |
| `FACILITY_PHASE`, `FAILURE_DOMAIN`, `RESILIENCE_REQUIREMENT`, `FUEL_STORAGE`, `WATER_STORAGE`, `CAPACITY_BUDGET` | yes | |
| `ASSUMPTION`, `WAIVER`, `DOCUMENT` | yes | |
| Cost, schedule, and sustainability values | | Cost, Schedule, and Sustainability workspace (attached here as read-only `CostScheduleReference` links) |
| UPS, generator, switchgear, transformer, PDU, branch circuits | | Power Supplier Editor |
| Room, zone, row, rack, containment, in-building tray and conduit | | Floorplan Editor / Route and Pathway Editor |
| Switch, port, link, optics payload | | Network Topology Editor |
| Cable assembly, patch panel, connector end | | Cabling Editor |

## Geometry Requirements by Entity Kind

Required roles are normative. A missing required role is `facility.data.geometry.role_missing`; a type mismatch is `facility.data.geometry.type_mismatch`.

| Entity kind | Required role | Geometry type | Notes |
| --- | --- | --- | --- |
| `SITE` (`DesignScope`) | `BOUNDARY` | `POLYGON` or `MULTIPOLYGON` | Required when a site-level geographic, jurisdictional, hazard, or regulatory claim is made. |
| `PARCEL` | `BOUNDARY` | `POLYGON` or `MULTIPOLYGON` | Georeferenced. |
| `BUILDING` | `FOOTPRINT` | `POLYGON` | 3D envelope uses footprint plus `elevation_base_m` and `height_m` or `elevation_top_m`. |
| `FLOOR`, `HALL` | `FLOOR_BOUNDARY` | `POLYGON` | Carries `level_number` and elevation; parent is a `BUILDING`. |
| `SUPPORT_SPACE` | `ROOM_BOUNDARY` | `POLYGON` | Parent is a building or floor. |
| `EQUIPMENT_YARD`, `RESERVED_AREA` | `BOUNDARY` | `POLYGON` or `MULTIPOLYGON` | |
| `UTILITY_SOURCE`, `UTILITY_INTERFACE` | `CONNECTION_POINT` | `POINT` | One or more points; each interface point must resolve to a source point. |
| `UTILITY_ROUTE` | `ROUTE` | `LINESTRING` | Site access or utility corridor only; in-building pathways are Route and Pathway entities. |
| `SPATIAL_CONSTRAINT` | none mandatory | `CONSTRAINT_AREA` or `ROUTE` where spatial | Area, route, and regulatory overlays carry geometry. Numeric rules (setback distance, height limit) carry a rule value and reference the geometry they apply to. |
| `ENVIRONMENTAL_CONSTRAINT` | none mandatory | `CONSTRAINT_AREA` where spatial | May be envelope-level rather than geometric. |
| Survey or control marker (`REFERENCE_POINT`) | n/a | `POINT` | Attaches to any container. |

### Level and Elevation Semantics

* A `FLOOR` or `HALL` carries `level_number` (signed integer, negative below grade), `elevation_base_m`, and `elevation_top_m`. `level_number` is unique within a building.
* Building-local geometry (floors, halls, support spaces, and their contents) is expressed in the building's local CRS with a reviewed `parent_transform_id` to the project CRS. Unreviewed or missing transforms leave the geometry `PROVISIONAL` (`facility.data.transform.unreviewed`).
* `ordinal` distinguishes multiple geometry records of the same role on one entity; `(entity_id, entity_type, revision_id, role, ordinal)` is unique.

## Facility Envelope Graph

```text
FacilityEnvelope
  -> FacilityDesignContext
       -> DesignScope
       -> FacilityContainer [one or more]
       -> SpatialConstraint [zero or more]
  -> GeometryRecord [owned by stable entity ID and role]
  -> CapabilityCoverage [one per capability]
  -> ValidationSummary
  -> AssetVersionRef [one or more]
  -> AssetBinding [conditional]
  -> SiteContext [conditional]
  -> UtilityInterface [conditional]
  -> FailureDomain [conditional]
  -> ResilienceAssessment [conditional]
  -> CapacityBudget [conditional]
  -> EnvironmentalConstraint [conditional]
  -> FacilityPhasePlan [conditional]
  -> ImportReport [conditional]
  -> Assumption [conditional]
  -> Document [conditional]
  -> CostScheduleReference [optional; reference only]
```

| Entity | Core shape | Relationships |
| --- | --- | --- |
| `FacilityEnvelope` | `id`, `revision_id`, lifecycle state (`DRAFT`, `VALIDATED`, or `PUBLISHED`), content checksum, `published_at?`, design context, coverage, validation summary, pinned asset versions, `cost_schedule_refs[]?` | One immutable project/scenario snapshot. It references only entity versions belonging to the same revision. Only a `DRAFT` envelope is mutable; `VALIDATED` and `PUBLISHED` are immutable. Cost, schedule, and sustainability entries are reference-only links owned elsewhere. |
| `DesignScope` | `id` (entity type `SITE`), `name`, `scope_kind`, parent context | Defines the area of intent, such as campus, site, parcel, building, or building-local planning scope. Its boundary is a linked `GeometryRecord`. |
| `FacilityContainer` | `id`, `kind`, `name`, parent container ID, phase ID, status, `level_number?` | `kind` is a `ContainerKind`. Parent relationships form a tree; footprints and boundaries are linked `GeometryRecord` objects. |
| `SpatialConstraint` | `id`, `kind`, severity, `rule_kind?`, `rule_value?`, `rule_unit?`, `applies_to_geometry_id?`, provenance | `kind` is a `ConstraintKind`. Setback, easement, and exclusion constraints use geometry; height and distance rules carry a value and reference the geometry they constrain. |
| `CapabilityCoverage` | capability, status, evidence references, reviewed-at time | Exactly one record exists for geometry, power, cooling, water, fuel, network entry, environment, and phasing. Status is derived; see [D11](decisions.md). |
| `ValidationSummary` | run ID, revision ID, checked/not-checked capabilities, counts, completed time | Summarizes a complete or affected-subgraph validation run; individual diagnostics remain separate records. |

## Site and Import Shapes

```text
AssetBinding
  id, binding_id, asset_version_id, representation_id?, role,
  tool_id = "site_facility", status,
  transform_id?, mapping_ids[], payload_ref?

SpatialTransform
  id, binding_id, asset_version_id, source_units, target_units,
  source_crs?, target_crs, vertical_crs?, method, control_points[],
  residual_error_m?, review_state, reviewer_id?, reviewed_at?

ImportMapping
  id, binding_id, asset_version_id, transform_id, source_selector, target_entity_type,
  target_geometry_role?, attribute_mapping, cardinality, required,
  review_state, reviewer_id?, reviewed_at?

ImportFeature
  id, asset_version_id, representation_id?, source_selector, source_feature_id,
  geometry_type?, raw_attributes, vertex_count,
  status: REFERENCE_ONLY | MAPPED | UNSUPPORTED,
  import_mapping_id?, normalized_entity_id?

ImportReport
  id, asset_version_ids[], binding_ids[], transform_ids[], mapping_ids[],
  mapped_feature_count, unmapped_feature_count, unsupported_feature_count,
  diagnostic_ids[], review_state, created_at
```

A project asset version ([Project Assets](../../workspace/project-assets.md)) is immutable and owned by the asset layer; this tool never stores file bytes. `AssetBinding` pins the exact asset version and representation this revision consumes. `SpatialTransform` records the exact conversion into the project CRS. `ImportMapping` turns selected source content into normalized facility entities. A source feature remains reference-only until its transform and mapping are reviewed. Adapter behavior, per-format fidelity, and the selector grammar are specified in the shared [workspace import and conversion framework](../../workspace/import-adapters.md); the mapping to facility entities is specified in [Import Mapping](import-adapters.md).

## Utility, Resilience, Capacity, Environment, and Phase Shapes

| Entity | Core shape | Invariants |
| --- | --- | --- |
| `UtilitySource` | ID, resource kind, capacity, capacity state, failure-domain ID, available-from, provenance | Resource kind is power, cooling, water, fuel, or network entry. Its handoff location is a linked `CONNECTION_POINT` geometry record. |
| `UtilityInterface` | ID, utility source ID, capacity, service state, failure domain, phase | References an existing source; downstream tools may connect to it but cannot redefine the source. Its handoff location is a linked `CONNECTION_POINT` geometry record. |
| `FailureDomain` | ID, name, kind, `parent_failure_domain_id?`, provenance | Containment is acyclic and stays within one revision. A missing domain on a required independent path is `facility.resilience.failure_domain.missing`. |
| `ResilienceRequirement` | ID, availability policy, policy ID, `applies_to[]` resource kinds, `autonomy_duration?` | Evaluated against interface and failure-domain evidence; unmet requirements are `ERROR` diagnostics, incomplete evidence is `WARNING`. |
| `StorageReserve` | ID, kind (`FUEL`/`WATER`), capacity, autonomy duration, failure-domain ID, phase, provenance | Autonomy duration is compared with the resilience requirement. Insufficient duration is `facility.resilience.fuel_duration.insufficient` or `facility.resilience.water_duration.insufficient`. |
| `CapacityBudget` | ID, owner entity, phase, resource kind, basis, commissioned, planned, reserved, allocated, available quantities | `available_capacity = firm_capacity * (1 - derating_factor) - reserve - accepted_allocations`; planned and assumed capacity never contribute to firm availability. |
| `CapacityAllocation` | ID, demand request ID, budget ID, quantity, state, valid-from, revision ID | `PROVISIONAL` allocations do not satisfy hard validation gates; only `ACCEPTED` reduces availability. Contention order is [D6](decisions.md). |
| `CapacityDemandRequest` | ID, consumer type, consumer ID, phase, resource kind, requested capacity, required-from, priority | A downstream request cannot modify facility entities, sources, or budgets. |
| `EnvironmentalProfile` | ID, design-weather reference, operating ranges, permit constraints, hazards, effective date, provenance | Scoped to a site and climate context and to an effective period. |
| `EnvironmentalConstraint` | ID, profile ID, constraint kind, threshold, units, affected geometry/entity, provenance | Required when a constraint is declared or evaluated; must declare a unit and basis. |
| `FacilityPhase` | ID, name, order, activation date/precision, status | Dependencies form an acyclic graph; status is a `PhaseStatus`. |
| `FacilityPhasePlan` | phases, dependency edges, capability availability | Required when a later phase changes available capacity or commissioning state. |

## Diagnostic and Governance Shapes

```text
FacilityDiagnostic
  id, revision_id, constraint_id, severity, status,
  entity_refs[], geometry_refs[], source_values[], computed,
  remediation_category, remediation_hint, policy_ref?,
  validation_run_id, created_at, supersedes_diagnostic_id?

ValidationRun
  id, revision_id, scope: FULL | AFFECTED_SUBGRAPH,
  base_etag?, requested_capabilities[], checked_capabilities[],
  error_count, warning_count, started_at, completed_at

Assumption
  id, statement, owner, confidence, effective_at, expires_at?,
  status: OPEN | RESOLVED | SUPERSEDED, entity_refs[], provenance

Waiver
  id, revision_id, diagnostic_ids[], scope, granted_by,
  policy_id, reason, granted_at, expires_at?, status

Document
  id, kind, title, media_type, content_checksum, object_storage_artifact_id,
  owner, issued_at?, expires_at?, entity_refs[], provenance

CostScheduleReference
  id, kind: COST | SCHEDULE | SUSTAINABILITY
  provider, external_entity_ref, label,
  effective_at?, source_ref, linked_entity_refs[]

ImpactNotice
  id, project_id, previous_revision_id, revision_id,
  changed_entity_refs[], invalidated_consumer_types[], issued_at

ApprovalAttestation
  id, envelope_id, revision_id, approver_id,
  policy_id, decision, approved_at, comment?
```

Diagnostics, waivers, and approval attestations are append-only. A waiver references diagnostics; it does not modify or delete a diagnostic. Document kinds are enumerated in [Interchange Contract](interchange-contract.md); a `DOCUMENT` entity never supplies authoritative geometry. A `CostScheduleReference` is a read-only link owned by the Cost, Schedule, and Sustainability workspace ([D18](decisions.md)); it is never created, edited, or deleted by a facility command and never participates in a validation check.

## Persistence Models

The canonical graph maps to relational tables in the transactional store ([D15](decisions.md)) for transactional persistence and spatial querying. Each model includes `project_id`, `scenario_id`, audit fields, and a revision/version reference where it participates in a Facility Envelope snapshot. `project_id` is part of every primary key, every unique constraint, and every foreign key ([D22](decisions.md)), so a stored reference cannot cross projects. "Identity" names the primary key or unique constraint; "Reference fields" are foreign keys where the schema declares them and are otherwise validated by the application inside the writing transaction. This table is the single reconciliation point between this document and [Storage Shape](storage-shape.md).

### Project and Revision Context

| Model | Identity | Reference fields | Cardinality and purpose |
| --- | --- | --- | --- |
| `projects` | `project_id` | `organization_id` | Tenant-scoped container for scenarios and revisions. |
| `scenarios` | `scenario_id` | `project_id` | One project has many scenarios; each scenario has an independent draft lineage. |
| `revisions` | `revision_id` | `project_id`, `scenario_id`, `base_revision_id?` | One scenario has many revisions. `DRAFT` is mutable under ETag; `VALIDATED` and `PUBLISHED` are immutable, and `PUBLISHED` is a one-way transition from `VALIDATED`. |
| `revision_lineage` | `(revision_id, parent_revision_id)` | both reference `revisions` | Branch ancestry and publication boundaries. |
| `revision_etags` | `revision_id` | `revisions` | Current draft ETag and optimistic-concurrency version. |
| `outbox_events` | `event_id` | `project_id`, `scenario_id`, `revision_id` | Transactional outbox for published domain events. |
| `idempotency_records` | `(scope, idempotency_key)` | `project_id` | Stores the original command result for duplicate-safe retries. |
| `jobs` | `job_id` | `project_id`, `revision_id?`, `binding_id?` | Asynchronous asset processing, binding, validation, publish, and export job state. |

### Facility Graph

| Model | Identity | Reference fields | Cardinality and purpose |
| --- | --- | --- | --- |
| `facility_envelopes` | `envelope_id` | `project_id`, `scenario_id`, `revision_id` | One revision has at most one Facility Envelope. The envelope is the immutable handoff root. |
| `entity_registry` | `(entity_id, revision_id)` | `project_id`, `scenario_id`, `entity_type` | Registry of stable entity IDs that permits cross-entity references, including geometry ownership, without exposing polymorphic rows directly. |
| `design_scopes` | `scope_id` | `envelope_id`, `parent_scope_id?` | One envelope has one or more scopes, including the `SITE` entity. A scope may nest in one parent scope and owns linked geometry. |
| `facility_containers` | `container_id` | `envelope_id`, `scope_id`, `parent_container_id?`, `phase_id?` | One scope has many containers. A container has zero or one parent, many children, and linked geometry. `level_number` is unique per building. |
| `geometry_records` | `geometry_id` | `revision_id`, `(entity_id, entity_type)` via `entity_registry`, `parent_transform_id?`, `asset_version_id?`, `binding_id?` | One record belongs to one revision and exactly one stable entity. `(entity_id, entity_type, revision_id, role, ordinal)` is unique. |
| `spatial_constraints` | `constraint_id` | `envelope_id`, `scope_id?`, `container_id?`, `rule_id?`, `applies_to_geometry_id?` | One envelope has many constraints. A constraint attaches to exactly one scope or container and owns zero or more linked geometry records. |

### Import Metadata

| Model | Identity | Reference fields | Cardinality and purpose |
| --- | --- | --- | --- |
| `asset_bindings` | `binding_id` | `revision_id`, `asset_version_id` (project-level) | This tool's consumption of a project asset version. The asset, its versions, and its representations are stored at project scope, not in this tool's tables. |
| `spatial_transforms` | `transform_id` | `binding_id`, `asset_version_id` | A binding can have many reviewed transforms for different target scopes; local geometry references at most one parent transform. |
| `import_mappings` | `mapping_id` | `binding_id`, `asset_version_id`, `transform_id`, `revision_id` | A binding has many mapping rules; one mapping generates many normalized entities in one revision. |
| `import_features` | `import_feature_id` | `asset_version_id`, `binding_id`, `import_mapping_id?` | Extracted source features with reference-only, mapped, or unsupported status. |
| `import_reports` | `import_report_id` | `asset_version_id`, `binding_id`, `revision_id` | Auditable per-import counts, diagnostics, and review state. |

### Utilities, Resilience, and Capacity

| Model | Identity | Reference fields | Cardinality and purpose |
| --- | --- | --- | --- |
| `failure_domains` | `failure_domain_id` | `envelope_id`, `parent_failure_domain_id?` | An envelope has many failure domains forming an acyclic containment tree. |
| `resilience_requirements` | `requirement_id` | `envelope_id`, `policy_id` | One envelope has at most one active requirement; `applies_to` names resource kinds. |
| `storage_reserves` | `storage_id` | `envelope_id`, `failure_domain_id`, `phase_id` | Fuel and water storage with capacity and autonomy duration. |
| `utility_sources` | `utility_source_id` | `envelope_id`, `failure_domain_id`, `phase_id` | An envelope has many planning-level sources; a source has many interfaces and linked `CONNECTION_POINT` geometry. |
| `utility_interfaces` | `interface_id` | `envelope_id`, `utility_source_id`, `phase_id`, `failure_domain_id` | Each interface references exactly one source and phase; downstream tools attach to interfaces, not sources. |
| `capacity_budgets` | `budget_id` | `envelope_id`, `owner_entity_id`, `phase_id`, `utility_interface_id?` | Unique per owner, phase, resource kind, and basis. |
| `capacity_allocations` | `allocation_id` | `budget_id`, `demand_request_id`, `revision_id` | A budget has many allocations; each satisfies at most one demand request. |
| `capacity_demand_requests` | `request_id` | `envelope_id`, `consumer_id`, `phase_id` | Downstream requests and their decisions; append-only for audit. |

### Environment and Phase

| Model | Identity | Reference fields | Cardinality and purpose |
| --- | --- | --- | --- |
| `environmental_profiles` | `profile_id` | `site_scope_id`, `asset_version_id?` | One site scope has many time-versioned profiles; a profile has many constraints. |
| `environmental_constraints` | `environmental_constraint_id` | `profile_id`, `envelope_id`, `affected_entity_id?` | A profile has many constraints, each targeting an entity or envelope-level condition. |
| `facility_phases` | `phase_id` | `envelope_id` | An envelope has many phases; dependency edges form a directed acyclic graph. |
| `phase_dependencies` | `(predecessor_phase_id, successor_phase_id)` | both reference `facility_phases` | One dependency edge; duplicate and cyclic edges are prohibited. |
| `phase_capability_availability` | `(phase_id, capability)` | `facility_phases` | Declares when a capability becomes available for consumption. |

### Verification and Governance

| Model | Identity | Reference fields | Cardinality and purpose |
| --- | --- | --- | --- |
| `capability_coverage` | `(revision_id, capability)` | `envelope_id`, `revision_id` | Every envelope revision has exactly one derived record per capability. |
| `validation_runs` | `validation_run_id` | `envelope_id`, `revision_id` | One revision has many runs; one clean run provides the summary for a validated envelope. |
| `facility_diagnostics` | `diagnostic_id` | `validation_run_id`, `revision_id` | A run emits many append-only diagnostics. |
| `assumptions` | `assumption_id` | `envelope_id`, `revision_id` | Recorded unresolved inputs; active assumptions cap coverage. |
| `waivers` | `waiver_id` | `revision_id`, `policy_id`, `approver_id` | Suppress gating for named diagnostics without altering them. |
| `documents` | `document_id` | `project_id`, `object_storage_artifact_id` | Operational and permit metadata linked to entities. |
| `impact_notices` | `impact_notice_id` | `project_id`, `previous_revision_id`, `revision_id` | Invalidation notices for downstream consumers. |
| `cost_schedule_references` | `cost_schedule_ref_id` | `project_id`, `envelope_id`, `revision_id` | External cost, schedule, and sustainability links. Reference-only, never gating, and written only by the owning workspace. |
| `approval_attestations` | `attestation_id` | `envelope_id`, `revision_id`, `approver_id`, `policy_id` | A validated revision can have many approval, rejection, or revocation attestations. |

### Constraints

| Constraint area | Required rule |
| --- | --- |
| Tenant and project boundary | Every reference resolves to the same `project_id` and `scenario_id`. Foreign keys and unique constraints, write-time reference validation inside the transaction, a row-level security policy, and API authorization all enforce this boundary. |
| Revision lineage | Every draft command references one `base_revision_id` and the current ETag, and writes to that draft. A published envelope references immutable entity versions from one revision; no published row is updated in place. |
| Envelope uniqueness | A project, scenario, and revision can have at most one Facility Envelope. An envelope must reference at least one pinned asset version and exactly one coverage record for every declared capability. |
| Container hierarchy | A facility container has zero or one parent. Parent/child links stay within the same scope and revision, cannot contain cycles, and cannot create a path from a container to itself. `level_number` is unique within a building. |
| Geometry association | Every `GeometryRecord` references exactly one stable `entity_id` and `entity_type` through `entity_registry`, one revision, one semantic role, ordinal, and declared geometry type/CRS. `(entity_id, entity_type, revision_id, role, ordinal)` is unique. Geometry cannot be reused across revisions. |
| Geometry representation | GeoJSON is retained as the interoperable WGS 84 representation. A projected representation is required for measured distances, containment, and engineering checks. Buildings use a footprint polygon plus elevation/height attributes; detailed BIM/mesh assets are separate artifacts. |
| Geometry validity | Polygons are closed, non-self-intersecting, and correctly wound; multipolygons do not contain overlapping members. Default tolerance is 0.01 m linear and 0.01 m² areal unless project policy overrides it. |
| Scope and local geometry | Every spatial entity owns zero or more linked geometry records; required roles are listed in "Geometry Requirements by Entity Kind". Building-local geometry has a reviewed transform to its parent CRS; a missing or unreviewed transform leaves the geometry `PROVISIONAL`. |
| Required geometry roles | A missing required role is an `ERROR`; a type mismatch is an `ERROR`. Optional roles never gate. |
| Spatial constraints | A spatial constraint attaches to exactly one scope or one container and cannot be published with a missing rule or provenance reference when it makes a regulatory or hazard claim. Numeric rules declare `rule_kind`, `rule_value`, and `rule_unit`, and reference the geometry they constrain. |
| Import provenance | Imported geometry must retain its pinned `asset_version_id`, `binding_id`, spatial transform, and import mapping. A feature is reference-only until transform and mapping review is complete; a validated import report cannot have unresolved required mappings. |
| Asset integrity | A project asset version checksum is immutable and owned by the project asset layer ([Project Assets](../../workspace/project-assets.md)). Representations record their asset version, producer identity and version, and checksum; they never replace the original bytes. |
| Utility interfaces | A utility interface references exactly one utility source and one phase, and owns one or more `CONNECTION_POINT` geometry records. It cannot precede the source availability date or redefine source resource kind, capacity state, or failure domain. |
| Failure domains | Failure-domain containment is acyclic and scoped to one revision. Paths required to be independent by the selected resilience policy cannot share a prohibited failure-domain ancestor. Missing evidence results in a warning or incomplete state, never assumed independence. |
| Resilience requirement | At most one active requirement per envelope. Autonomy duration is satisfied only by storage reserves in an independent failure domain that are commissioned in the same or an earlier phase. |
| Capacity accounting | A capacity budget is unique per owner, phase, resource kind, and basis. Allocation resource kind, basis, and phase must match its budget. Availability uses the formula in [Interchange Contract](interchange-contract.md); planned, assumed, contractual, and measured capacity never contribute to firm availability. |
| Allocation decisions | Every allocation decision references one demand request and one budget. `ACCEPTED` allocations reduce availability; `PROVISIONAL` allocations do not satisfy hard gates; `REJECTED`, `EXPIRED`, and `REVOKED` allocations do not. |
| Environment | An environmental constraint must reference a profile and a declared unit and basis. Profile applicability is limited to its site, climate scope, and effective period. |
| Phasing | Phase dependency edges have no self-reference, no duplicate pair, and no cycle. A resource cannot be allocated to a phase before its interface, source, and capability availability permit it. |
| Assumptions and waivers | An active assumption caps every touched capability at `PROVISIONAL`. A waiver references existing diagnostics, is scoped to one revision, and never alters diagnostic evidence. |
| Validation coverage | `VALIDATED` lifecycle state requires a completed validation run with no applicable `ERROR` diagnostic, and `PUBLISHED` requires a prior `VALIDATED` state with pinned sources. Capabilities not checked remain `NOT_PROVIDED` or `PROVISIONAL`; they cannot be inferred from a successful unrelated check. |
| Diagnostics and approvals | Diagnostics, impact notices, waivers, and attestations are append-only. Approval, rejection, waiver, or revocation never changes diagnostic evidence or the underlying Facility Envelope. |
| Cost, schedule, and sustainability references | A reference never participates in validation or gating, and this tool never writes the referenced value. A missing or stale reference is a warning at most and never blocks publication. |
