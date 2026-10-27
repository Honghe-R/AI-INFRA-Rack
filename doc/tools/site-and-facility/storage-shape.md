# Site and Facility Editor Storage Shape

This document defines where Site and Facility Editor data is persisted. The canonical shape of each entity is defined in [Entity Model](entity-model.md); the persistence model list there is the single reconciliation point for table names. Durability, retention, and recovery targets are quantified in [Non-Functional Requirements](non-functional-requirements.md).

## Storage Responsibilities

| Store | Purpose | Authoritative data |
| --- | --- | --- |
| Transactional relational store | Transactional metadata, relationships, revision lineage, geometry queries, authorization, and diagnostics | Entity metadata, normalized geometry, mappings, transforms, budgets, phases, diagnostics, governance records, and approval attestations |
| Object store | Large immutable binary artifacts and frozen payloads | Original CAD/KML/KMZ/DWG files, converted intermediates, import extracts, rendered previews, protobuf snapshots, and generated reports |
| Search/index projection | Optional fast text and map discovery | Derived searchable project, site, document, and feature metadata only |
| Cache and job store | Ephemeral performance and asynchronous processing | Short-lived map tiles, sessions, import/validation job state, and idempotency records |

The transactional relational store and object store together are the system of record. Search indexes and caches are disposable projections and must be rebuildable from authoritative revisions and artifacts.

### Storage Plane Terminology

Three planes are deliberately distinct, and the transactional plane is fixed by [D15](decisions.md):

| Plane | Holds | Scope |
| --- | --- | --- |
| Object store (artifact store) | Every large immutable payload, spatial or not: CAD, KML/KMZ, DWG, BIM, PDF studies, permits, previews, exports, frozen protobufs | All projects; addressed by project and content checksum |
| Transactional relational store | Normalized metadata, entity relationships, revision lineage, budget and diagnostic state, and queryable geometry | All projects; a relational database with ACID transactions and a native spatial extension (reference implementation: PostgreSQL 16 with PostGIS) |
| Search/index projection and cache | Derived discovery, tiles, sessions, and job state | Disposable and rebuildable |

A source document, permit, or study is an **artifact**, not a stored record: it lives in the object store and is referenced by checksum. The term **transactional store** in this bundle means the relational metadata and geometry database, never the object store.

## Transactional Store

Use a relational database with a native spatial extension that provides every capability in the table below. PostgreSQL 16 with PostGIS is the reference implementation; an equivalent product is acceptable only if it satisfies the same list.

| Required capability | Use in this tool |
| --- | --- |
| ACID transactions | Commit one change set's entity versions, geometry, budgets, diagnostics, the new draft ETag, and the outbox event together. |
| Native spatial indexing over geometry | Serve containment, intersection, distance, and bounding-box queries for geometry validation and canvas reads. |
| Unique and check constraints | Enforce envelope, geometry, coverage, budget, and idempotency uniqueness, and reject invalid field values, enums, or units before they are stored. |
| Change data capture or logical replication | Feed index projections, notifications, and derived read models from committed changes. |
| Streaming replication with point-in-time recovery, and partitioning or horizontal sharding | Meet the availability, RPO, and scale targets in [Non-Functional Requirements](non-functional-requirements.md). |

Store normalized geometry in native spatial columns with spatial indexes, not as opaque strings or object-store blobs, so the system can evaluate containment, intersection, distance, and route constraints. WGS 84 GeoJSON remains the interchange representation and is retained alongside the spatial column. A product that lacks transactional writes or a native spatial index does not satisfy [D15](decisions.md) and must not be substituted.

| Table family | Main tables | Notes |
| --- | --- | --- |
| Project context | `projects`, `scenarios`, `revisions`, `revision_lineage`, `revision_etags` | Revision lineage records branch ancestry and the immutable publication boundary. `revision_etags` holds the current draft concurrency token. |
| Facility graph | `facility_envelopes`, `entity_registry`, `design_scopes`, `facility_containers`, `spatial_constraints`, `geometry_records` | Geometry is versioned with the entity revision and indexed for spatial queries. |
| Import and binding metadata | `asset_bindings`, `spatial_transforms`, `import_mappings`, `import_features`, `import_reports` | `asset_bindings` pins an `asset_version_id` that lives in the project-level asset tables; extracted feature metadata is queryable. |
| Utilities and resilience | `failure_domains`, `resilience_requirements`, `storage_reserves`, `utility_sources`, `utility_interfaces` | Failure-domain containment is validated as an acyclic tree; storage reserves carry autonomy duration in seconds. |
| Capacity | `capacity_budgets`, `capacity_allocations`, `capacity_demand_requests` | Quantity values use normalized SI fields plus basis and state fields. |
| Environment and phase | `environmental_profiles`, `environmental_constraints`, `facility_phases`, `phase_dependencies`, `phase_capability_availability` | Dependency edges are validated as acyclic before publish; capability availability is explicit per phase. |
| Verification and governance | `validation_runs`, `facility_diagnostics`, `capability_coverage`, `assumptions`, `waivers`, `documents`, `impact_notices`, `approval_attestations` | Append-only audit records reference a revision and stable entity IDs. Coverage is derived per run. |
| Platform support | `jobs`, `outbox_events`, `idempotency_records`, `map_tile_usage` | Job state, transactional outbox, duplicate-safe command results, and authoritative tile-usage counters. |

All tenant-scoped tables carry `project_id` and are protected by row-level security; access policy additionally enforces organization membership. Every command commits in one SQL transaction that writes the entity versions, geometry, the new draft ETag, and the outbox event, and validates every cross-table reference in the same transaction. Published revisions and their referenced entity versions are immutable.

### Geometry and CRS Storage

* Store `geojson_4326` and `projected_geometry` as native spatial columns, not as opaque text or object-store blobs. `geojson_4326` carries SRID 4326 and serves the geographic spatial index; `projected_geometry` carries the project CRS and serves planar measurement. Both are indexed with GiST.
* Store `projected_coordinate_reference_system` and the optional `vertical_coordinate_reference_system` as explicit codes (EPSG identifiers where available). Never infer the CRS from index metadata or an engine default alone.
* Building-local geometry is stored in the building's local CRS together with `parent_transform_id`; containment and distance checks materialize the project-CRS representation at write time so a spatial index can serve them without a per-read transform.
* Reject geometry whose declared type does not match its role, whose CRS is undeclared, or whose coordinates exceed project bounds. Default linear and areal tolerances are 0.01 m and 0.01 m².
* Store elevation and height in meters as `elevation_base_m`, `elevation_top_m`, and `height_m`; a level's identity is `(building_id, level_number)`.

### Key Constraints and Indexes

* Unique constraint on `(project_id, scenario_id, revision_id)` for each Facility Envelope.
* Unique constraint on `(revision_id, capability)` for capability coverage.
* Unique constraint on `(entity_id, entity_type, revision_id, role, ordinal)` for geometry records.
* Unique constraint on `(owner_entity_id, phase_id, resource_kind, basis)` for capacity budgets.
* Unique constraint on `(budget_id, demand_request_id)` for allocations.
* Unique constraint on `(scope, idempotency_key)` for idempotency records.
* Unique source-document checksum within a project to support deduplication without overwriting provenance.
* Unique constraint on `(asset_version_id, source_selector, revision_id)` for an import mapping.
* Foreign keys enforce the references the schema declares. References a foreign key cannot express, including cross-project references and the polymorphic `(entity_id, entity_type)` reference, are validated inside the writing transaction, and a scheduled integrity check re-validates every reference and reports orphans.
* A GiST spatial index on `geojson_4326` for containment, intersection, and near queries, plus a GiST index on `projected_geometry` for planar measurement. Index parcel, container, constraint, route, and connection-point geometry.
* Composite indexes on `(revision_id, severity, status)` for diagnostics and on `(revision_id, entity_id)` for entity-scoped reads.
* Optimistic concurrency is enforced by a conditional update on the revision's ETag record: a mutating request must match the current ETag, and the write advances it. `base_revision_id` is validated in the same transaction.

### Partitioning and Growth

* **Tenant-key discipline.** `project_id` is part of every primary key, every unique constraint, and every foreign key, so a stored reference cannot cross projects ([D22](decisions.md)). This is also what makes a graph table partitionable later without a data remodel.
* **Time partitioning for append-only classes.** `outbox_events` and `import_features` are range-partitioned by time, so retention expiry ([D21](decisions.md)) is a partition detach or drop instead of a mass delete. They are chosen because nothing references them by foreign key: a partitioned table cannot be the target of a foreign key unless the reference also carries the partition key. `facility_diagnostics` is the exception: its self-referencing `supersedes_diagnostic_id` foreign key cannot survive time partitioning, so it stays an unpartitioned append-only table with the full tenant-key treatment.
* **Graph tables.** `facility_envelopes`, `revisions`, `geometry_records`, and the other mutable graph tables are unpartitioned in the first release. Their identities already include `project_id`, so they can be hash-partitioned by `project_id` later as a metadata operation.
* **Horizontal target.** Scale-out, when required, is hash partitioning by `project_id` or Citus-style sharding with `project_id` as the distribution column. List-partitioning one partition per project is rejected: a deployment holds thousands of projects, and per-project partitions would bloat the catalog and the planner.
* Draft revisions are hot; published revisions are read-mostly and may be moved to cheaper storage after the retention window defined in [Non-Functional Requirements](non-functional-requirements.md).
* Import feature rows are retained only while their source asset version is retained, subject to the audit exception for mapped features.

### Map Tile Cache and Usage Metering

Basemap tiles are fetched through the server-side proxy ([D16](decisions.md)) and cached in the cache store, never in the transactional store or the object store.

* A cached tile is disposable and never authoritative. Losing the tile cache degrades map rendering only, and must not block editing, local validation, publish, or any read.
* The cache key includes provider, style, scale, and zoom/x/y. The cache lifetime is the lesser of the provider-permitted lifetime and the project policy; a provider that forbids caching gets a zero-lifetime entry that is never persisted to disk.
* Provider credentials are resolved from the secret manager at request time and are never written to cache keys, usage records, logs, or traces.
* `map_tile_usage` holds authoritative counters by organization, project, user, provider, and period, together with quota and threshold state. The quota check and the counter increment commit in one transaction so the counter cannot drift from the enforcement decision.
* Usage records are retained per the retention table in [Non-Functional Requirements](non-functional-requirements.md) and produce the `map.usage.threshold.v1` event.

## Object Store Layout

Objects are immutable and addressed by project, asset/revision identity, and content checksum. Object keys are implementation details. Clients never receive direct credentials: asset uploads are streamed to the API ([D23](decisions.md)), and reads use signed download URLs that are time- and object-scoped and never grant list permission.

```text
projects/{project_id}/assets/{asset_id}/versions/{asset_version_id}/{checksum}/original
projects/{project_id}/assets/{asset_id}/versions/{asset_version_id}/representations/{representation_id}/{checksum}
projects/{project_id}/documents/{document_id}/{checksum}/content
projects/{project_id}/revisions/{revision_id}/facility-envelope.pb
projects/{project_id}/revisions/{revision_id}/import-report.json
projects/{project_id}/revisions/{revision_id}/exports/{artifact_id}
projects/{project_id}/validation-runs/{validation_run_id}/diagnostics.json
```

The asset and representation key layout is owned by the shared [workspace project-assets model](../../workspace/project-assets.md) and [import framework](../../workspace/import-adapters.md); this tool adds only its revision-scoped envelope, report, export, and diagnostic keys.

| Artifact | Object-store treatment |
| --- | --- |
| Project asset version | Retained unchanged at project scope with checksum, retention policy, media type, and malware-scan state. Never written by this tool. |
| Asset representation | Immutable output of a named producer version; never replaces the original bytes. |
| Extracted preview/tile | Derived, cacheable, and regenerable from the asset version and transform. |
| BIM mesh or glTF preview | Derived from an IFC representation for display only; never authoritative geometry and never satisfies a required geometry role. |
| Attached `Document` | Immutable content with checksum, media type, and retention class; metadata lives in the transactional store. |
| Facility Envelope protobuf | Frozen at publication and linked from the revision row. |
| Validation diagnostics export | Immutable record of one validation run, addressed by `validation_run_id`. |
| Export/report | Immutable generated artifact with producer/version and source revision metadata. |

## Write and Recovery Flow

1. The API creates a project asset version through the shared asset intake API, or binds an existing asset version to a draft revision.
2. The client streams bytes to the asset version's content resource; the service writes them to the object store, computes the checksum itself, and scans for malware ([D23](decisions.md)).
3. The asset processing worker stores representations; this tool writes bindings, transforms, features, and diagnostics in one transaction.
4. User-reviewed mappings produce normalized draft entities in the transactional store. Applying a binding never overwrites user-authored entities; conflicts return a preview that requires an explicit merge or change command.
5. Draft edits commit entity versions, geometry, and the outbox event in one transaction and advance the ETag. No child revision is created per edit ([D1](decisions.md)).
6. Validation writes a validation run, diagnostics, and derived capability coverage. Publication freezes the validated revision, writes the immutable envelope protobuf, and publishes a revision event through the outbox.

Transactional-store backup, object-store versioning and retention, and periodic restore tests are required. An object is never deleted while a retained revision or binding references it. A failed binding leaves the asset, its representations, and the diagnostic trail available for audit, but does not create a publishable envelope.

## Security and Isolation

| Concern | Requirement |
| --- | --- |
| Tenant boundary | Every query is scoped by `project_id`, and a row-level security policy plus API authorization enforce organization membership. Cross-project references are rejected by write-time validation inside the transaction, rejected by the API, and reported by the scheduled integrity check. |
| Encryption | Data is encrypted in transit and at rest, including object storage and backups. |
| Upload safety | Uploaded artifacts are malware-scanned before conversion; an unscanned artifact cannot be mapped or published. |
| Signed URLs | Time-limited, object-scoped, and never list-capable. Download URLs are issued only to authorized principals. |
| Converter secrets | Converter and licence credentials are held in a secret manager and never stored in import metadata. |
| Audit | Publication, approval, waiver, allocation, and import-apply actions write an immutable audit record with actor, correlation ID, and revision. |

Retention classes, deletion rules, RPO and RTO targets, and restore-test frequency are specified in [Non-Functional Requirements](non-functional-requirements.md).
