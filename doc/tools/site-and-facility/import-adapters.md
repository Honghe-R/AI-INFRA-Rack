# Site and Facility Editor Import Mapping

This document is the Site and Facility Editor's specialization of the shared [workspace import and conversion framework](../../workspace/import-adapters.md). The framework owns adapters, extraction, converters, units and coordinate resolution, representations, limits, and processing diagnostics; [Project Assets](../../workspace/project-assets.md) owns the file, its versions, and its access and retention. This document owns only what the extracted content means in the facility model: which adapters this tool enables, how source content maps to facility entity types and geometry roles, how a BIM model becomes a facility hierarchy, and the facility-specific import diagnostics.

Files are project assets. This tool binds an exact asset version and representation and never owns, copies, or re-uploads the file.

Everything not stated here is inherited unchanged from the workspace framework and the asset model, including the adapter registry contract, the extensibility model, the review workflow, the source selector grammar, the per-format extraction rules, the adapter limits, the shared `asset.*` and `import.*` diagnostics, and asset intake.

## Authority Model in This Tool

| Stage | Object | Authority | Rule |
| --- | --- | --- | --- |
| Asset version | `AssetVersion` (owned by [Project Assets](../../workspace/project-assets.md)) | Not authoritative | Immutable bytes in object storage with checksum, media type, adapter identity, malware-scan state, and provenance. |
| Represent | `AssetRepresentation` | Derived | Conversion, extraction, georeference, preview, tile, mesh, or text output produced by a named producer version. |
| Extract | import feature records | Reference-only | Source geometry, attributes, spatial structure, and property sets, queryable in the source CRS. |
| Transform | `SpatialTransform` | Provisional | Reviewed conversion into the project CRS before geometry may be authoritative. |
| Map | `ImportMapping` on an `AssetBinding` | Provisional | Selects source content and names a facility `target_entity_type` and `target_geometry_role`. |
| Normalize | facility containers, `GeometryRecord`, and attributes | Authoritative per revision | Created only from a `REVIEWED` transform and `REVIEWED` required mappings applied to a draft. |
| Report | `ImportReport` | Auditable evidence | Counts, review state, converter identity and version, and diagnostic references for the revision. |

An adapter MUST NOT write facility entities, utility capacity, capacity budgets, or phase state. Only the facility import-apply command does, against a draft.

## Adapters Enabled for This Tool

All formats below are enabled in R1 for this tool. Extraction and fidelity behavior is defined once in the [workspace framework](../../workspace/import-adapters.md); the table states only what this tool normalizes from each format.

| Format | Facility normalization |
| --- | --- |
| KML, KMZ | Placemarks to parcel, building, equipment-yard, constraint, utility-connection, or reference-point geometry; folders to feature groups. |
| DXF | Layers, blocks, and supported entities to containers, constraint areas, utility routes, and connection points; text, dimensions, and hatches remain reference-only unless mapped. |
| DWG | Through the registered DXF or IFC converter, then treated as DXF or IFC. |
| IFC | Spatial structure to the facility hierarchy, eligible representations to geometry records, property sets and quantities to attributes. |
| GeoJSON, ESRI Shapefile | Features to containers and constraint areas; DBF and property fields to attributes. |
| CSV and point tables | Coordinate rows to connection points or reference points; remaining columns to attributes. |
| GeoTIFF and raster reference | Preview underlay only; never geometry records and never a constraint input. |
| Vendor study and PDF | Attached as `DOCUMENT` metadata; no automatic extraction. |

Adapter support, fidelity limits, and per-format extraction rules are listed in the [workspace framework](../../workspace/import-adapters.md); this tool does not override them.

## Target Entity Types and Geometry Roles

| `target_entity_type` | Allowed geometry roles |
| --- | --- |
| `SITE` | `BOUNDARY` |
| `PARCEL` | `BOUNDARY` |
| `BUILDING` | `FOOTPRINT` |
| `FLOOR` | `FLOOR_BOUNDARY` |
| `HALL` | `FLOOR_BOUNDARY`, `ROOM_BOUNDARY` |
| `SUPPORT_SPACE` | `ROOM_BOUNDARY` |
| `EQUIPMENT_YARD` | `BOUNDARY`, `FOOTPRINT` |
| `RESERVED_AREA` | `BOUNDARY` |
| `UTILITY_SOURCE` | `CONNECTION_POINT` |
| `UTILITY_INTERFACE` | `CONNECTION_POINT` |
| `UTILITY_ROUTE` | `ROUTE` |
| `SPATIAL_CONSTRAINT` | `CONSTRAINT_AREA` |
| `ENVIRONMENTAL_PROFILE` | None; attribute-only |
| `ENVIRONMENTAL_CONSTRAINT` | `CONSTRAINT_AREA` |
| `FACILITY_PHASE` | None; attribute-only |
| `FAILURE_DOMAIN` | None; attribute-only |
| `RESILIENCE_REQUIREMENT` | None; attribute-only |
| `FUEL_STORAGE` | `BOUNDARY`, `FOOTPRINT` |
| `WATER_STORAGE` | `BOUNDARY`, `FOOTPRINT` |
| `CAPACITY_BUDGET` | None; attribute-only |
| `ASSUMPTION` | None; attribute-only |
| `WAIVER` | None; attribute-only |
| `DOCUMENT` | `REFERENCE_POINT` optional |

A geometry-bearing mapping MUST declare exactly one `target_geometry_role` allowed for its entity type. A mismatch MUST produce `facility.data.geometry.type_mismatch` or `facility.data.geometry.role_missing` with remediation `CORRECT_GEOMETRY`, not an import warning. A missing mapped attribute is remediated as `ADD_DATA`. Attribute values MUST be normalized to SI with the source value and conversion preserved.

## Facility Mapping Rules

* A required mapping with zero matches MUST produce `facility.import.mapping.unresolved` with remediation `REVIEW_IMPORT`.
* A selector that matches more than one normalized target where `cardinality` is `ONE_TO_ONE` MUST produce `facility.import.mapping.ambiguous`. The mapping MUST be refined or explicitly changed to `ONE_TO_MANY`.
* Two mappings that claim the same source feature for the same facility entity and role MUST NOT both apply; the conflict MUST be surfaced for review before apply.
* Mapped geometry that falls outside the declared design scope MUST produce `facility.import.geometry.out_of_bounds`; the geometry is not authoritative until the scope or the mapping is corrected.
* Unmapped optional content remains reference-only and is recorded with `import.feature.unsupported` from the shared registry.
* Import apply MUST NOT overwrite user-authored entities. A conflict returns a merge preview requiring an explicit resolution before the change set is submitted.
* Applying an import is one typed change set ([D1](decisions.md)): it advances the draft ETag and emits `facility.revision.changed.v1`. It never creates a child revision and never publishes.
* Inferred attributes MUST carry `source_ref`, `effective_at`, and `confidence`. An imported attribute never becomes `VALIDATED` on its own; the owning facility check decides that.

### BIM to Facility Hierarchy

An IFC model is the richest source for the facility hierarchy, and its mapping is tool-specific. Extraction, schema support, units, tessellation, and georeferencing are defined in the [workspace framework](../../workspace/import-adapters.md); the mapping is:

| IFC construct | Facility target | Rule |
| --- | --- | --- |
| `IfcProject` | `DesignScope` | Becomes the design scope for the imported hierarchy. |
| `IfcSite` | `SITE` scope and optional `BOUNDARY` | One site per model; a second site requires an explicit mapping decision. |
| `IfcBuilding` | `BUILDING` container with `FOOTPRINT` | A missing `IfcBuilding` raises `import.ifc.spatial_structure_invalid`. |
| `IfcBuildingStorey` | `FLOOR` or `HALL` with `FLOOR_BOUNDARY` | `IfcBuildingStorey.Elevation` maps to `elevation_base_m`; the ordered storey sequence maps to `level_number`. |
| `IfcSpace` | `SUPPORT_SPACE` with `ROOM_BOUNDARY`, or reference-only | Reference-only by default; promotion requires an explicit `REVIEWED` mapping. |
| Footprint, boundary, and planar representations | `GeometryRecord` | Placement transforms MUST be composed through the spatial hierarchy before normalization. |
| `IfcPropertySet`, `IfcElementQuantity` | Attributes | Exposed for attribute mapping with source unit and confidence. |
| Openings, MEP, distribution, structural, and analysis content | Reference-only | No facility role unless an explicit mapping claims one. |
| 3D mesh or glTF preview | Derived artifact | Never authoritative geometry and never satisfies a required geometry role. |

A storey claimed by more than one building, a duplicated `level_number`, or a non-monotonic storey sequence raises `import.ifc.spatial_structure_invalid`. A facility mapping MUST NOT infer a building or storey that the model does not declare.

## Diagnostics for This Tool

Facility-specific import diagnostics are owned here and extend the shared registry. They MUST NOT be redefined by an adapter.

| `constraint_id` | Default severity | Gating capability | Remediation | Trigger |
| --- | --- | --- | --- | --- |
| `facility.import.mapping.unresolved` | ERROR | `GEOMETRY` | `REVIEW_IMPORT` | A required mapping matches no source feature. |
| `facility.import.mapping.ambiguous` | WARNING | `GEOMETRY` | `REVIEW_IMPORT` | A selector matches more than one normalized target where cardinality is one-to-one. |
| `facility.import.geometry.out_of_bounds` | ERROR | `GEOMETRY` | `REVIEW_IMPORT` | Imported geometry falls outside the declared design scope. |

Framework failures use the shared `import.*` identifiers and are surfaced unchanged by this tool. A validated import report cannot contain an unresolved required mapping or an out-of-bounds authoritative geometry.

## Acceptance Criteria for the Facility Mapping Layer

1. Every enabled format resolves to a registered adapter from the workspace registry; this tool adds no adapter-specific parsing.
2. A geometry-bearing mapping declares exactly one allowed role for its target entity type, and a mismatch raises the facility geometry diagnostic rather than an import warning.
3. A required mapping that matches nothing raises `facility.import.mapping.unresolved` and blocks authoritative geometry.
4. An ambiguous one-to-one mapping raises `facility.import.mapping.ambiguous` and is not applied until resolved.
5. Geometry outside the design scope raises `facility.import.geometry.out_of_bounds` and remains non-authoritative.
6. IFC spatial structure maps to the facility hierarchy with level numbers and elevations, and an inconsistent model raises `import.ifc.spatial_structure_invalid`.
7. MEP, structural, opening, and analysis content stays reference-only unless an explicit mapping claims a facility role.
8. Import apply is a single draft change set that preserves stable IDs, provenance, and user-authored entities, and never publishes.
9. A 3D mesh or glTF preview never satisfies a required geometry role and never participates in a spatial constraint check.
