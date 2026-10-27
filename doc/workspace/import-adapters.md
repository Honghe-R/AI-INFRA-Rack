# Workspace Import and Conversion Framework

This document defines the shared, cross-tool import and conversion framework for the AI Infrastructure Planner. It is workspace-level infrastructure ([D19](../tools/site-and-facility/decisions.md)): adapters, extraction, unit and coordinate resolution, representation handling, limits, and processing diagnostics are owned once here and consumed by every map-bearing or geometry-bearing editor, including the [Site and Facility Editor](../tools/site-and-facility/Overview.md), the Floorplan Editor, the Route and Pathway Editor, and the Cabling Editor.

The framework operates on [project assets](project-assets.md). An imported file is a project-scoped asset version, not a per-tool document; this framework produces derived **representations** of that version and never owns, copies, or re-uploads the file.

Each tool keeps its own specification for what extracted content means in that tool's model. This document never names a tool's entity types.

## Two-Layer Model

Import separates a shared adapter layer from a tool-owned mapping layer.

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Adapter layer | Workspace framework (this document) | Resolve media type and extension to an adapter, extract features and metadata, invoke converters, detect units and CRS, fit transforms, store artifacts, enforce limits, and emit framework diagnostics. |
| Mapping layer | Consuming tool | Map selected source content to that tool's entity types and geometry roles, review the mapping, apply it to a draft, and emit tool-specific mapping diagnostics. |

The boundary between the layers is a normalized **import feature record** plus a reviewed `SpatialTransform`. The adapter layer MUST NOT create a tool's domain entities; only the tool's apply command does.

## Purpose and Authority Model

A project asset version is an immutable artifact owned by [Project Assets](project-assets.md). Extracted content is reference-only until a reviewed `SpatialTransform` and a reviewed tool mapping link it to normalized entities.

| Stage | Object | Authority | Rule |
| --- | --- | --- | --- |
| Asset version | `AssetVersion` (owned by [Project Assets](project-assets.md)) | Not authoritative | Immutable bytes in object storage with checksum, media type, adapter identity, malware-scan state, and provenance. |
| Represent | `AssetRepresentation` | Derived | Conversion, extraction, georeference, preview, tile, mesh, or text output produced by a named producer version. Never authoritative design data. |
| Extract | import feature records | Reference-only | Feature, layer, block, attribute, text, and property metadata queryable in the source CRS. Unmapped content stays reference-only. |
| Transform | `SpatialTransform` | Provisional | Declares source and target units and CRS, method, control points, residual error, and `review_state`. |
| Map | tool mapping | Provisional | Declares the tool's selector, target entity type, target geometry role, attribute mapping, and `review_state`. |
| Normalize | tool domain entities and geometry records | Authoritative per revision | Created only from a `REVIEWED` transform and `REVIEWED` required mappings applied to a draft. |
| Report | `ImportReport` | Auditable evidence | Records counts, review state, converter identity and version, and diagnostic references for the revision. |

Every normalized entity produced by import MUST carry provenance with `source_ref`, `effective_at` as RFC 3339 UTC, `confidence`, `owner`, the pinned `asset_version_id`, and the tool's binding identifier.

## Adapter Registry Contract

An adapter is registered by descriptor. The registry is the shared resolution point for media type, extension, version range, and converter dependency.

```text
ImportAdapterDescriptor
  adapter_id: string                                  [required; stable, never reused]
  adapter_version: string                             [required; semantic version]
  media_types[]: string                               [required; IANA media type]
  extensions[]: string                                [required; lowercase, leading dot]
  extraction_capabilities[]: ExtractionCapability     [required; one or more]
  source_crs_declarations[]: string                   [required; CRS the adapter can report]
  source_unit_declarations[]: string                  [required; units the adapter can report]
  fidelity_level: FULL | PARTIAL | REFERENCE_ONLY     [required]
  converter_dependency: ConverterDependency           [conditional; required when an
                                                       external converter is invoked]
  supported_range: SupportedRange                     [required]
  release_level: R1 | R2 | R3                         [required]
  status: ACTIVE | DEPRECATED | RETIRED               [required]
  entry_point: string                                 [required; stable registration reference]
  isolation: IN_PROCESS | WORKER_SANDBOX              [required]
  conformance_fixtures[]: string                      [required; one per supported version]
  required_diagnostics[]: string                      [required; import.* identifiers emitted]

ExtractionCapability
  name: layers | blocks | block_attributes | text | dimensions |
        hatches | feature_groups | styles | georeferencing | attributes |
        spatial_structure | property_sets | quantities
  level: FULL | PARTIAL | NONE

ConverterDependency
  identity: string
  version: string
  licence: string
  licence_class: PERMISSIVE | COMMERCIAL | PROPRIETARY | INTERNAL
  output_media_type: string
  output_adapter_id: string

SupportedRange
  min_version: string
  max_version: string
  tested_versions[]: string
```

| Field | Contract |
| --- | --- |
| `adapter_id` | Stable identifier recorded on every `AssetVersion` and import report. Identifiers are never reassigned. |
| `adapter_version` | Semantic version of the extraction contract. A published version is immutable; a behavior change is a new version. |
| `media_types[]` | IANA media types the adapter accepts. Sniffed `application/octet-stream` is accepted only when the extension also matches. |
| `extensions[]` | Lowercase extensions used with media type for deterministic resolution. |
| `extraction_capabilities[]` | Per-capability extraction level. A `FULL` overall fidelity requires `FULL` for every capability the format claims. |
| `source_crs_declarations[]` | CRS families the adapter can detect or report, such as EPSG codes, ESRI projections, or `LOCAL`. |
| `source_unit_declarations[]` | Source units the adapter can detect or report, such as m, mm, ft, US survey ft, or degrees. |
| `fidelity_level` | `FULL` preserves every mapped feature and attribute. `PARTIAL` converts a documented subset. `REFERENCE_ONLY` extracts metadata and previews but no authoritative geometry. |
| `converter_dependency` | Converter identity, version, licence text, licence class, output media type, and the adapter that consumes the output. |
| `supported_range` | Minimum, maximum, and explicitly tested source versions. Values outside the range are rejected. |
| `release_level` | `R1` is release-blocking for the format claim; `R2` and `R3` are contract-defined and targeted for a later release. |
| `status` | `ACTIVE` is selectable for new imports. `DEPRECATED` stays resolvable but is not offered. `RETIRED` is read-only for historical reproducibility. |
| `entry_point` | Stable registration reference for the adapter implementation or plugin manifest. The core resolves it without format-specific branching. |
| `isolation` | `WORKER_SANDBOX` is required for any adapter that parses untrusted input, invokes a converter, or holds a licence entitlement. |
| `conformance_fixtures[]` | One fixture set per version in `supported_range`, plus a negative fixture per declared limit and diagnostic. |
| `required_diagnostics[]` | Every `import.*` identifier the adapter can emit. Registration is rejected if any identifier is not in the shared diagnostic registry below. |

Registry rules:

* Resolution failure for media type and extension MUST produce `import.adapter.unsupported` and MUST stop extraction.
* An adapter or converter version outside `supported_range` MUST produce `import.adapter.version_unsupported` and MUST stop extraction.
* A converter whose licence forbids server-side or commercial use MUST NOT be registered. A licence change requires a new `adapter_version`.
* Adapters emit extracted features, transform candidates, and diagnostics. They MUST NOT create tool domain entities.
* Adapter capability claims MUST be verifiable by a conformance fixture per supported version. A claim without a fixture is not registrable.
* A descriptor whose `required_diagnostics[]` names an identifier outside the shared registry MUST be rejected at registration with `import.adapter.registration_invalid`.
* A `DEPRECATED` or `RETIRED` adapter MUST remain resolvable for source documents that already reference it.

## Extensibility Model

The adapter layer is an open, plugin-style framework ([D19](../tools/site-and-facility/decisions.md)); the core import pipeline is format-agnostic.

* An adapter is registered by descriptor through a stable registration interface. Registering, upgrading, deprecating, or retiring an adapter MUST NOT require a change to the core pipeline, the persistence layer, the API surface, or any consuming tool.
* The pipeline reads only descriptor and feature data: media type and extension resolution, `extraction_capabilities[]`, `fidelity_level`, `supported_range`, `isolation`, and `converter_dependency`. Format-specific parsing, unit detection, and geometry conversion live inside the adapter, never in core code.
* Registration is configuration-driven. A newly registered adapter becomes selectable once the registry reloads, and enabling it MUST NOT require redeploying the core service.
* Adapters MUST run in a `WORKER_SANDBOX` when they parse untrusted input, invoke a converter, or hold a licence entitlement. The sandbox has bounded memory, CPU, wall-clock, and temporary storage, no ambient credentials, and restricted network egress.
* An adapter MUST declare every diagnostic it can emit in `required_diagnostics[]`, and each identifier MUST already exist in the shared registry. An adapter MUST NOT emit an unregistered identifier.
* Descriptor evolution is additive-only; removing, renaming, or repurposing a field requires a new contract version.
* A third party MUST be able to add a format by shipping a descriptor, an adapter implementation, and its fixture set, without modifying this document or any core service.

## Review Workflow

Adapters MUST NOT set `review_state`; only a reviewer transitions it, through the consuming tool's command and permission model.

| `review_state` | Meaning | Allowed transitions |
| --- | --- | --- |
| `UNREVIEWED` | Default after extraction or after any edit to the selector, transform, or attribute mapping. | `IN_REVIEW`, `REJECTED` |
| `IN_REVIEW` | A reviewer has claimed the record; review is incomplete. | `REVIEWED`, `REJECTED`, `UNREVIEWED` |
| `REVIEWED` | Accepted; import apply may use the record. | `UNREVIEWED` on edit, `REJECTED` |
| `REJECTED` | Refused; MUST NOT generate normalized entities. | `UNREVIEWED` after correction |

## Units and CRS Resolution

| Concern | Rule |
| --- | --- |
| Unit authority | The adapter reports candidate source units with evidence. A unit is authoritative only after review. Ambiguity produces `import.units.unconfirmed`. |
| CRS authority | The source CRS is reported in EPSG form where available. `LOCAL` is valid only with a control-point transform. |
| Conversion | All normalized values are SI. Source value, source unit, and conversion are retained. |
| Rounding | Conversion MUST NOT round beyond the declared precision, and MUST record the factor used. |

When the source CRS is absent, unknown, or not authoritative, the transform MUST be fitted from at least two `REVIEWED` control points with known target positions.

* Fewer than two `REVIEWED` control points MUST produce `import.transform.control_points_insufficient` and MUST block authoritative geometry.
* Control points MUST be recorded as source coordinate, source CRS or `LOCAL`, source units, target coordinate, and target CRS. Where they correspond to physical markers, they SHOULD also exist as reference-point geometry.
* Control points MUST NOT be collinear within the project length tolerance; a degenerate set is an insufficient set.
* Two points define a similarity fit. Three or more points enable a least-squares fit and residual reporting.

### Transform Methods

| Method | Use | Required evidence | Residual |
| --- | --- | --- | --- |
| `IDENTITY` | Source and target CRS and units already match. | Declared source CRS equal to target CRS. | Not required. |
| `UNIT_SCALE` | Same CRS, different units. | Confirmed source unit and conversion factor. | Reported when nonzero. |
| `SIMILARITY_2D` | Local plan with no source CRS. | At least two `REVIEWED` control points. | Required. |
| `AFFINE_2D` | Anisotropic scan or shear. | At least three `REVIEWED` control points. | Required. |
| `HELMERT_7_PARAM` | Geodetic datum change. | Declared source CRS with datum. | Required when policy mandates it. |
| `PROJECTION_CHANGE` | Projected source CRS to project CRS. | Declared source CRS in EPSG form. | Not required. |
| `CONTROL_POINT_LOCAL` | Building-local or arbitrary CAD origin. | At least two `REVIEWED` control points. | Required. |

Residual error is computed as the root mean square of control-point residuals and reported in metres. The default residual tolerance is 0.05 m, and a project policy may override it. A fitted transform with residual above tolerance MUST produce `import.transform.residual_exceeded`; the affected geometry remains provisional. Any edit to units, CRS, method, or control points MUST return `review_state` to `UNREVIEWED`.

## Source Selector Grammar

Selectors are a deterministic subset with no unbounded backtracking. The grammar is shared; each consuming tool defines which target entity types and geometry roles a clause may map to.

```text
selector    := disjunction
disjunction := conjunction { "OR" conjunction }
conjunction := term { "AND" term }
term        := "NOT" term | "(" disjunction ")" | clause
clause      := key ":" pattern
key         := "layer" | "block" | "attrib" | "entity" | "group" | "feature" | "attr" | "file"
pattern     := literal | glob | predicate
predicate   := field operator value
operator    := "=" | "!=" | "~" | "<" | "<=" | ">" | ">="
```

| Clause key | Applies to | Meaning | Example |
| --- | --- | --- | --- |
| `layer:` | DXF, DWG | Layer name, glob supported. | `layer:ELEC-*` |
| `entity:` | DXF, DWG, IFC | Source entity family. | `entity:LWPOLYLINE` |
| `block:` | DXF, DWG | Block name, glob supported. | `block:SUBSTATION-*` |
| `attrib:` | DXF, DWG | Block attribute tag and value predicate. | `attrib:VOLTAGE=13.8kV` |
| `group:` | KML, KMZ | Folder or feature-group path, glob supported. | `group:Site/Parcels/*` |
| `feature:` | KML, GeoJSON, Shapefile | Feature geometry or type name. | `feature:Polygon` |
| `attr:` | KML, GeoJSON, Shapefile, CSV, IFC property sets | Attribute field predicate. | `attr:use=utility` |
| `file:` | Any multi-file document | Source file or archive entry name. | `file:*.dbf` |

Grammar rules:

* Operators combine with `AND`, `OR`, and `NOT`; parentheses group clauses. `AND` binds tighter than `OR`.
* Glob patterns support `*`, `?`, and `[ ]` character classes only. Regular expressions are not supported.
* Keys and field names are case-insensitive. Values are case-sensitive unless the predicate is suffixed with `i`.
* Values containing reserved characters MUST be single-quoted; a backslash escapes a quote or backslash.
* A selector MUST evaluate identically in the preview, apply, and re-import paths, and its normalized form MUST be stored with the mapping.

## Representations, Provenance, and Object Store

Asset keys are owned by [Project Assets](project-assets.md); this framework writes representation objects beneath the asset version and a per-revision import report. Object keys are implementation details; clients receive signed URLs for downloads only, and uploads are streamed to the API ([D23](../tools/site-and-facility/decisions.md)).

```text
projects/{project_id}/assets/{asset_id}/versions/{asset_version_id}/representations/{representation_id}/{checksum}
projects/{project_id}/revisions/{revision_id}/import-report.json
```

| Object | Treatment |
| --- | --- |
| `ORIGINAL` representation | Owned by the asset layer; never rewritten by this framework. |
| `CONVERTED` representation | Immutable output of a named converter version; never replaces the original. |
| `FEATURES` representation | Extracted feature and attribute records, queryable and regenerable. |
| `GEOREFERENCE` representation | Detected CRS, unit, and control-point candidates with evidence. |
| `PREVIEW`, `TILES`, `MESH` representation | Derived, cacheable, and regenerable. A 3D mesh or glTF preview is never authoritative geometry. |
| Import report | Immutable record of counts, review state, converter identity and version, residual error, and diagnostics. |

Processing MUST NOT modify or overwrite the asset version bytes, and MUST NOT process a version whose malware-scan state is not `CLEAN`. Producing a representation is idempotent per `(asset_version_id, kind, producer, producer_version)`: re-running the same producer version replaces that representation's content in place, and a new producer version creates a new representation while the previous producer version's record is kept and marked `STALE` ([D25](../tools/site-and-facility/decisions.md)).

## Per-Format Extraction Rules

These rules are format-generic and shared. How extracted features map to a tool's entities is specified by that tool.

### CAD: DXF and DWG

DXF extraction MUST retain layer, block, attribute, and style metadata before geometric normalization.

| DXF content | Disposition |
| --- | --- |
| `LWPOLYLINE`, `POLYLINE`, `LINE`, `ARC`, `CIRCLE`, `ELLIPSE` | Convertible to geometry when a tool mapping names the target entity and role. |
| `INSERT` and nested block expansion | Expanded to source features up to the nesting limit; block name and insertion transform are retained. |
| `ATTRIB` and `ATTDEF` | Exposed as attribute predicates and attribute-mapping inputs. |
| `TEXT` and `MTEXT` | Reference-only text with position and height; never an authoritative attribute unless mapped. |
| `DIMENSION` | Reference-only with measured value, unit, and associated geometry. |
| `HATCH` | Reference-only pattern metadata; its boundary MAY seed a constraint area only through an explicit `REVIEWED` mapping. |
| `SPLINE`, `3DFACE`, `MESH`, `BODY`, `REGION`, proxy, and custom objects | Reference-only; approximation requires recorded method and tolerance. |
| `XREF` and raster images | External references are not followed by default; a resolved reference is a separate project asset. |

DWG conversion rule:

1. DWG MUST NOT be parsed directly. The adapter MUST invoke a registered, licensed or managed converter that emits DXF or IFC.
2. The converter MUST produce a documented intermediate form consumed by the matching adapter; converter identity, version, licence, and output checksum are recorded.
3. The original DWG artifact MUST be retained and MUST never be replaced by the converted intermediate.
4. Converter failure or partial output MUST leave the import failed with diagnostics and no publishable envelope.
5. The adapter MUST NOT claim complete feature parity, regardless of converter output.

Licence constraints: the DWG format specification is proprietary, so a deployment MUST hold a licence entitlement for the converter and MUST record it in the registry. A converter invocation outside its licence scope is not registrable.

No-silent-data-loss rule: an adapter MUST NOT discard a feature, layer, block, attribute, style, or unsupported object without a recorded disposition. Every extracted source feature MUST end in exactly one disposition of mapped, unmapped, reference-only, or rejected, and the counts MUST reconcile in the report. A reconciliation failure MUST produce `import.conversion.incomplete`.

### KML and KMZ

* KML geometry MUST be interpreted as EPSG:4326 per the OGC KML specification; the original longitude, latitude, and altitude values MUST be retained in the source feature record.
* Folder and Placemark hierarchy MUST be preserved as feature groups for `group:` selectors.
* `ExtendedData` name and value pairs MUST be exposed as attributes without type coercion beyond the declared schema.
* KMZ extraction MUST reject archive entries with absolute paths, parent traversal, symbolic links, or excessive compression ratio, and MUST enforce the entry-count and expansion limits.
* Network links, regions, `gx:` track and tour extensions, and 3D models are reference-only.

### BIM: IFC

IFC is parsed by a registered IFC adapter in `WORKER_SANDBOX` isolation. The core pipeline and consuming tools MUST NOT contain IFC-specific schema parsing.

1. Supported schemas are IFC2X3, IFC4, and IFC4X3. Any other schema version MUST raise `import.ifc.schema_unsupported` and stop extraction. A schema outside the adapter's `supported_range` MUST raise `import.adapter.version_unsupported`.
2. Only footprint, boundary, and explicitly mapped planar representations are eligible to become geometry. Placement transforms MUST be composed through the spatial hierarchy before normalization.
3. Swept solids, breps, and curved geometry MUST be tessellated with a recorded tolerance. A tessellation whose deviation exceeds project tolerance MUST raise `import.ifc.tessellation_exceeded` and leave the geometry provisional.
4. `IfcUnitAssignment` is the unit authority. A length unit other than the metre MUST be converted with the source unit retained. An absent or ambiguous unit assignment MUST raise `import.units.unconfirmed`.
5. Georeferencing comes from `IfcMapConversion` together with `IfcGeometricRepresentationContext` and `IfcSite` latitude, longitude, and elevation. When georeferencing is absent or unreviewed, a control-point transform is required and `import.transform.unreviewed` applies.
6. `IfcBuildingStorey.Elevation` and the ordered storey sequence are exposed as level candidates. A storey claimed by more than one building, a missing building, or a non-monotonic sequence MUST raise `import.ifc.spatial_structure_invalid`.
7. `IfcPropertySet` and `IfcElementQuantity` values are exposed as attributes with source unit and confidence. Types MUST NOT be silently coerced.
8. Openings, MEP and distribution systems, structural analysis models, and parametric kernels are reference-only unless an explicit tool mapping claims a supported role.
9. Every IFC entity MUST end in exactly one disposition of mapped, unmapped, reference-only, or rejected, and the counts MUST reconcile in the report.

### GeoJSON and ESRI Shapefile

* GeoJSON MUST be normalized with ring winding and validity repair recorded; a repair that changes area beyond project tolerance MUST produce `import.feature.unsupported`.
* A Shapefile import MUST require the sidecar set; a missing `.dbf` or `.shx` is a failed import. A missing `.prj` requires a control-point transform.
* DBF field names, codepage, and truncated values MUST be reported when they collide after normalization.
* Shapefile M and Z values MUST be retained as elevation candidates or reference-only values with a diagnostic.

### CSV and Point Tables

* Delimiter, quote character, encoding, decimal separator, and date format MUST be declared or detected with recorded evidence.
* Coordinate columns MUST be identified by header mapping; a coordinate pair is converted to a point and mapped only through a `REVIEWED` tool mapping.
* Rows failing coordinate parsing become reference-only records; they MUST NOT be dropped.
* Column type inference MUST be recorded with `confidence` and MUST NOT silently coerce identifiers to numbers.

### GeoTIFF and Raster Reference

* A raster document is `REFERENCE_ONLY`. It provides a preview underlay and optional measuring backdrop.
* GeoTIFF georeferencing tags MUST be extracted and used to align the preview; reprojection for display MUST NOT create geometry records.
* Raster content MUST NOT satisfy a required geometry role and MUST NOT participate in spatial constraint checks.

### Vendor Study and PDF

* A vendor study or PDF is a document artifact. It MUST be attached with checksum, media type, and malware-scan state.
* Value extraction is manual. A value quoted from a study MUST be authored as a normal entity attribute with `source_ref` and `effective_at`.
* OCR, table extraction, and vector extraction are out of scope and MUST NOT be simulated.

## Supported Format Matrix

Release levels: `R1` is supported in the first release and release-blocking for its format claim. `R2` and `R3` are contract-defined and targeted for a later release.

| Format | Media types | Release | Preserved | Extracted | Units and CRS | Known fidelity limits |
| --- | --- | --- | --- | --- | --- | --- |
| KML | `application/vnd.google-earth.kml+xml` | R1 | WGS 84 coordinates, altitude, `altitudeMode`, Folder and Placemark hierarchy, `ExtendedData`, Style and StyleMap | Placemark geometry and folders as feature groups; `ExtendedData` as attributes | EPSG:4326 mandatory; altitude in metres; convert to project CRS while retaining original coordinates | `gx:` extensions, network links, regions, time spans, and 3D models are reference-only |
| KMZ | `application/vnd.google-earth.kmz` | R1 | Archive bytes, root KML, local assets, entry names | Same as KML after safe extraction | Same as KML; asset internal units are display-only | Remote network links and assets are reference-only; traversal, entry-count, and expansion limits are enforced |
| DXF | `image/vnd.dxf`, `application/dxf`, sniffed `application/octet-stream` | R1, versions R12 through 2018 | Layers, blocks and insertions, supported geometry, text, block attributes, dimensions, hatches as metadata, style tables | Supported entities as features; text, dimensions, and hatches remain reference-only unless mapped | `$INSUNITS`, `$MEASUREMENT`, `$LUNITS`, and `$AUNITS` are candidates; CRS only from embedded georeferencing or a control-point transform | Splines, proxies, custom objects, ACIS bodies, and dynamic block parameters are reference-only; unsupported versions are rejected |
| DWG | `image/vnd.dwg`, `application/acad`, sniffed `application/octet-stream` | R1 via a registered converter, versions R12 through 2018 | Original bytes unchanged; converter output; converter identity, version, and licence | Converter output is consumed through the DXF or IFC adapter; DWG is never parsed directly | Units and CRS are read from converter output, not from the DWG header | Complete feature parity is never claimed; proxy and custom objects are expected losses; partial fidelity is reported |
| IFC | `application/x-step`, `model/ifc`, `application/ifc`, sniffed `application/octet-stream` | R1, versions IFC2X3, IFC4, and IFC4X3 | Original file; spatial structure; property sets and quantities; unit assignment; map conversion and georeferencing | Spatial structure, eligible representations, property sets, and quantities as features | `IfcUnitAssignment`, `IfcMapConversion`, `IfcGeometricRepresentationContext`, and `IfcSite` latitude, longitude, and elevation | Swept and curved geometry is tessellated with recorded tolerance; openings, spaces, MEP, and analysis content are reference-only unless mapped |
| GeoJSON | `application/geo+json`, `application/json` | R1 | Feature geometry, properties, feature order, foreign members | `Feature` and `FeatureCollection` geometry; properties as attributes | RFC 7946 WGS 84; a legacy `crs` member is honored only through a recorded transform | No styles, no topology, no vertical datum; mixed geometry types require explicit mapping |
| ESRI Shapefile | `application/x-esri-shape` with `.shp` | R1 as a complete sidecar set | `.shp`, `.dbf`, `.prj`, `.cpg`, `.shx` | Geometry and DBF attributes | `.prj` is authoritative; a missing `.prj` requires a control-point transform | Ten-character DBF field names, no topology, no curves, ring winding requires normalization |
| CSV and point tables | `text/csv`, `text/plain`, `application/vnd.ms-excel` | R1 | Header row, row order, raw values, declared delimiter and quoting | Coordinate columns as points; remaining columns as attributes | Units declared per coordinate column; the source CRS is required or control points are used | Locale decimal separators and date formats MUST be declared; inferred types are recorded |
| GeoTIFF and raster reference | `image/tiff` with GeoTIFF tags | R1 | Raster bytes, GeoTIFF georeferencing tags, band metadata | Preview underlay only; no vector extraction | GeoTIFF tags and EPSG geokeys; reprojection is for display only | Reference-only; pixels are never normalized geometry |
| Vendor study and PDF | `application/pdf`, `image/*` | R1 as a document reference | Original bytes, page count, checksum, malware-scan state | None; attachment with optional page preview | Not applicable; quoted values are manually authored with provenance | Reference-only; no OCR, no vector or table extraction |

## Reference-Only and Unsupported Content

* An adapter MUST report unsupported content with a disposition; it MUST NOT drop it silently.
* Marking content reference-only is a `REVIEWED` disposition and is recorded in the report. Deleting source content is prohibited.
* Approximation of curves, splines, or arcs MUST record the method and tolerance; the approximated result is provisional.

| Unsupported content | Default disposition |
| --- | --- |
| AutoCAD proxy and custom objects, ACIS bodies, regions, and meshes | Reference-only. |
| Dynamic block parameters and constraints | Reference-only; the static insertion is extracted. |
| External references and unresolved underlays | Not followed; the unresolved reference raises `import.conversion.incomplete`. |
| Embedded raster and OLE objects in CAD | Reference-only preview. |
| KML network links, regions, `gx:` extensions, and 3D models | Reference-only. |
| IFC openings, spaces, MEP and distribution systems, structural analysis models, and parametric kernels | Reference-only until an explicit tool mapping claims a supported role. |
| Shapefile curves, measures, and annotation | Reference-only. |
| Raster pixels and PDF page content | Reference-only; no extraction. |
| Unsupported source version or feature class | Reference-only with `import.feature.unsupported`. |

## Adapter Limits

Limits are enforced per document and per job. Project policy MAY lower a default; it MUST NOT raise a hard ceiling.

| Limit | Default | Hard ceiling | Behavior on breach |
| --- | --- | --- | --- |
| Document size | 2 GiB | 5 GiB | Reject before extraction with a structured `4xx`. |
| Archive entries (KMZ, zip sidecars) | 10,000 | 50,000 | Reject before extraction. |
| Archive expansion ratio | 10:1 | 100:1 or 5 GiB total | Reject before extraction. |
| Extracted features per document | 1,000,000 | 5,000,000 | Stream and cap; excess features are reference-only with `import.conversion.incomplete`. |
| IFC entities per model | 5,000,000 | 20,000,000 | Stream and cap; excess entities are reference-only with `import.conversion.incomplete`. |
| IFC property sets per element | 64 | 256 | Excess property sets are reference-only. |
| IFC spatial hierarchy depth | 16 | 32 | Deeper content is flattened with a diagnostic. |
| IFC tessellation deviation | 0.01 m | 0.05 m | A coarser tessellation marks geometry provisional and raises `import.ifc.tessellation_exceeded`. |
| Vertices per geometry | 100,000 | 1,000,000 | Simplify with recorded tolerance and mark provisional. |
| Vertices per document | 50,000,000 | 200,000,000 | Fail the job with `import.conversion.incomplete`. |
| Block or assembly nesting depth | 16 | 32 | Deeper content is reference-only. |
| KML folder depth | 32 | 64 | Deeper folders are flattened with a diagnostic. |
| JSON or attribute nesting depth | 64 | 128 | Reject the document. |
| Attribute columns per feature | 512 | 2,048 | Excess columns are reference-only. |
| Control points per transform | 100 | 100 | Reject additional control points. |
| Conversion job timeout | 30 min | 2 h | Fail the job, retain artifacts, record diagnostics. |
| Preview generation timeout | 5 min | 15 min | Skip preview; import continues with a diagnostic. |
| Concurrent import jobs per project | 4 | 8 | Queue with backpressure; the client sees job state. |
| Concurrent import jobs per organization | 16 | 32 | Queue with backpressure. |
| Concurrent conversions per document | 1 | 1 | Serialize; later requests are idempotent no-ops. |

Limit rules:

* Soft limits produce partial results with recorded dispositions and never silent truncation. Hard ceilings reject deterministically before extraction.
* A job that exceeds its timeout MUST fail as a unit; partial normalized entities from that job MUST NOT be applied to a draft.
* Per-job memory and temporary storage MUST be bounded and released on completion or failure.
* Limit values are configuration, not contract; the registry descriptor and the API capability response SHOULD publish the effective values.

## Shared Adapter Diagnostics

These identifiers are workspace-level and tool-independent. They are the complete set an adapter may emit, and they are distinct from a consuming tool's own mapping and scope diagnostics and from the asset integrity and lifecycle diagnostics defined in [Project Assets](project-assets.md).

| `constraint_id` | Default severity | Scope | Remediation | Trigger |
| --- | --- | --- | --- | --- |
| `import.adapter.unsupported` | ERROR | Both | `REVIEW_IMPORT` | No adapter resolves the media type and extension. |
| `import.adapter.version_unsupported` | ERROR | Both | `REVIEW_IMPORT` | Adapter or converter version is outside `supported_range`. |
| `import.adapter.registration_invalid` | ERROR | Both | `REVIEW_IMPORT` | Descriptor is malformed or declares an unknown diagnostic identifier. |
| `import.adapter.deprecated` | WARNING | Both | `REVIEW_IMPORT` | The resolving adapter is `DEPRECATED`. |
| `import.units.unconfirmed` | ERROR | Both | `REVIEW_IMPORT` | Source units are absent, ambiguous, or unconfirmed. |
| `import.transform.unreviewed` | ERROR | Both | `REVIEW_IMPORT` | Spatial transform is not `REVIEWED`. |
| `import.transform.residual_exceeded` | WARNING | Both | `REVIEW_IMPORT` | Fitted-transform residual exceeds tolerance. |
| `import.transform.control_points_insufficient` | ERROR | Both | `REVIEW_IMPORT` | Source CRS is absent and fewer than two reviewed control points exist. |
| `import.conversion.incomplete` | WARNING | Both | `REVIEW_IMPORT` | Converter reported partial fidelity or a reconciliation failure. |
| `import.feature.unsupported` | WARNING | Both | `REVIEW_IMPORT` | Source feature is reference-only or unsupported. |
| `import.ifc.schema_unsupported` | ERROR | Both | `REVIEW_IMPORT` | IFC schema is not IFC2X3, IFC4, or IFC4X3, or is outside the supported range. |
| `import.ifc.spatial_structure_invalid` | ERROR | Both | `REVIEW_IMPORT` | IFC spatial structure is missing, duplicated, or has a non-monotonic storey sequence. |
| `import.ifc.tessellation_exceeded` | WARNING | Both | `REVIEW_IMPORT` | IFC geometry tessellation deviation exceeds the project tolerance. |

A consuming tool MUST surface these diagnostics unchanged, MUST NOT redefine them, and MAY add its own mapping diagnostics under its own namespace.

## Conformance and Acceptance Criteria

1. Registers an `ImportAdapterDescriptor` with every required field and resolves media type and extension to exactly one adapter.
2. Rejects unknown input with `import.adapter.unsupported` and an out-of-range version with `import.adapter.version_unsupported`.
3. Rejects a descriptor that declares an identifier outside the shared registry with `import.adapter.registration_invalid`.
4. Never writes, modifies, or overwrites the asset version bytes; it produces only new representations.
5. Refuses to process, preview, or apply a version whose malware-scan state is not `CLEAN` (enforced by the asset layer and re-checked here).
6. Invokes a registered, licensed converter for DWG and every converted format, and records converter identity, version, licence, and output checksum.
7. Reports extraction per declared capability and never silently drops a feature, layer, block, attribute, style, or unsupported object.
8. Reconciles `extracted = mapped + unmapped + reference_only + rejected` in the report.
9. Reports source unit and CRS candidates without marking them authoritative; unconfirmed units raise `import.units.unconfirmed`.
10. Requires at least two `REVIEWED` control points when the source CRS is absent and otherwise raises `import.transform.control_points_insufficient`.
11. Computes and reports fitted-transform residual in metres and raises `import.transform.residual_exceeded` above tolerance.
12. Blocks apply until the transform is `REVIEWED` and otherwise raises `import.transform.unreviewed`.
13. Refuses to create normalized entities from `UNREVIEWED`, `IN_REVIEW`, or `REJECTED` mappings.
14. Marks unsupported or non-required content reference-only with `import.feature.unsupported` and keeps it queryable for later promotion.
15. Enforces adapter limits and fails deterministically without partial normalized entities.
16. Emits an `ImportReport` with counts, review state, converter identity and version, residual error, and diagnostic identifiers.
17. Attaches provenance with `source_ref`, `effective_at`, `confidence`, `owner`, the pinned `asset_version_id`, and the binding identifier to every generated entity.
18. Emits only the shared `import.*` identifiers for framework failures and never invents an identifier.
19. Registers through the stable registration interface and becomes selectable without any change to the core pipeline, persistence layer, API surface, or consuming tool.
20. Declares `release_level`, `status`, `entry_point`, `isolation`, `conformance_fixtures[]`, and `required_diagnostics[]`.
21. Runs in `WORKER_SANDBOX` isolation when it parses untrusted input, invokes a converter, or holds a licence entitlement, with bounded resources and no ambient credentials.
22. Remains resolvable after being marked `DEPRECATED` or `RETIRED`, so an existing source document stays reproducible.
23. Passes a golden-fixture conformance test for each supported format and each version in `supported_range`, including a negative fixture for every declared limit and every diagnostic.
