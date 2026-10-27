# Workspace Project Assets

This document defines **project assets**: every file imported anywhere in the workspace becomes a first-class, project-scoped asset that tools consume. Import is not a feature of one tool. A user can add files from the project workspace, from any editor, from the assistant composer, or through the API, and the resulting asset is available to every authorized tool and revision in that project.

Adapters and conversion are the processing pipeline for assets and are specified in [Import and Conversion Framework](import-adapters.md). A tool that reads an asset records a **binding** to an exact asset version and representation; a tool never owns, copies, or re-uploads the file.

## Principles

1. **Project scope.** An asset belongs to a project, not to a tool, scenario, or revision. Assets outlive revisions and are shared across scenarios.
2. **Immutable versions.** Asset bytes and representations are immutable. A new upload is a new version that supersedes the previous one; it never overwrites it.
3. **Consume, do not own.** Tools create bindings and derived entities. The asset remains the single source artifact for provenance and re-derivation.
4. **Deterministic derivation.** Representations are produced by a named adapter or converter version and are rebuildable from the asset version.
5. **Pinned consumption.** A binding names an exact asset version and representation. A later asset version never silently changes a design.
6. **One intake path.** Every entry point uses the same intake sequence, checksum, malware scan, and authorization. There is no tool-private upload path.

## Asset Model

```text
ProjectAsset
  asset_id: UUID                                  [required; stable, project-scoped]
  project_id: UUID                                [required]
  name: string                                    [required; user-facing]
  kind: CAD | BIM | GIS | RASTER | DOCUMENT | DATASET | OTHER   [required]
  media_type: string                              [required; IANA]
  status: ACTIVE | ARCHIVED | QUARANTINED | DELETED            [required]
  access_classification: PROJECT | RESTRICTED     [required]
  current_version_id: UUID                        [required]
  version_count: uint32                           [required]
  tags[]: string
  retention_class: string                         [required]
  owner: string                                   [required]
  created_at, created_by                          [required]

AssetVersion
  asset_version_id: UUID                          [required; immutable]
  asset_id: UUID                                  [required]
  version_number: uint32                          [required; monotonic per asset]
  intake_state: PENDING | COMPLETE                [required; PENDING until bytes are received]
  content_checksum?: string                       [required once COMPLETE; SHA-256 of the bytes]
  size_bytes?: uint64                             [required once COMPLETE]
  storage_key?: string                            [required once COMPLETE; object-store address]
  filename: string                                [required; as uploaded]
  media_type: string                              [required]
  malware_scan_state: PENDING | CLEAN | INFECTED | FAILED       [required]
  status: CURRENT | SUPERSEDED | QUARANTINED      [required]
  supersedes_asset_version_id?: UUID
  source_ref: string                              [required]
  provenance: Provenance                          [required]
  uploaded_at, uploaded_by                        [required]

AssetRepresentation
  representation_id: UUID                         [required]
  asset_version_id: UUID                          [required]
  kind: ORIGINAL | CONVERTED | FEATURES | PREVIEW | TILES | MESH | TEXT | GEOREFERENCE
  media_type: string                              [required]
  content_checksum: string                        [required]
  storage_key?: string                            [required for stored kinds]
  producer: { producer_id, producer_version }     [required; adapter or converter]
  status: READY | STALE | FAILED                  [required]
  created_at                                      [required]

AssetBinding
  binding_id: UUID                                [required]
  project_id, scenario_id, revision_id            [required]
  asset_version_id: UUID                          [required; pinned]
  representation_id?: UUID                        [pinned when the tool consumes a derivative]
  tool_id: string                                 [required]
  role: SOURCE | EVIDENCE | REFERENCE | ATTACHMENT              [required]
  status: DRAFT | REVIEWED | APPLIED | SUPERSEDED               [required]
  payload_ref?: string                            [tool-specific detail record]
  created_at, created_by                          [required]
```

**`AssetBinding.status` as implemented is the shared `review_state` enum** — `UNREVIEWED | IN_REVIEW | REVIEWED | REJECTED` — not the four values sketched above. The facility schema uses that one enum for bindings and for the transforms and mappings under them, which is what lets "is this imported value authoritative yet" be one question rather than three, and `get_asset_binding` derives `authoritative` from exactly that. The sketch above is stale; the enum is the implementation.

```text
AssetLink
  link_id: UUID
  asset_version_id: UUID
  target: { project | scenario | revision | entity }
  role: SOURCE | EVIDENCE | REFERENCE | ATTACHMENT
  created_at, created_by

AssetAccessGrant
  grant_id: UUID
  asset_id: UUID
  project_id: UUID
  grantee_id: UUID
  granted_by: UUID
  granted_at: timestamp
  revoked_at?: timestamp
  revoked_by?: UUID
```

`Provenance` carries `source_ref`, `effective_at`, `confidence`, and `owner`. `ProjectAsset` is the logical file; `AssetVersion` is one immutable byte set; `AssetRepresentation` is a derived artifact; `AssetBinding` is a tool's consumption of a version; `AssetLink` is a lightweight association that does not consume the asset into a design.

`intake_state` exists because intake creates a pending version before any bytes arrive (see "Intake Sequence"): `content_checksum`, `size_bytes`, and `storage_key` are absent while a version is `PENDING` and present once it is `COMPLETE`. An aborted intake removes the pending version and records nothing, so a failed upload never leaves a half-version behind.

## Identity, Versioning, and Deduplication

* `asset_id` is stable for the life of the project. A version is addressed by `asset_version_id`; a design records the version it consumed, never only the asset.
* Uploading a new file as a new version of an existing asset sets `supersedes_asset_version_id`, increments `version_number`, and advances `current_version_id`. The prior version remains addressable and immutable.
* Within a project, identical bytes are deduplicated by `content_checksum` **after intake**: the bytes are stored once, and a later version with the same checksum reuses that stored object. Versions stay per-asset, so each asset keeps its own version row and provenance and only the object is shared ([D24](../tools/site-and-facility/decisions.md)). A repeat upload to the same asset reuses its existing version instead of creating a second one, and because the checksum is server-observed, a client cannot assert it to skip storing different bytes.
* A binding to a superseded version remains valid and is flagged `asset.version.superseded` as a warning, never rewritten. Upgrading a binding is an explicit tool action that re-runs the tool's mapping review.
* Representations are keyed by `(asset_version_id, kind, producer, producer_version)`. A change in producer version creates a new representation and marks the previous one `STALE`; it never mutates it.
* Assets are not revision-scoped. A published revision references the exact asset versions its bindings pinned, so the revision stays reproducible even after the asset gains new versions.

## Import Entry Points

Import happens in many places; all of them create project assets through one intake path.

| Entry point | Who starts it | Result |
| --- | --- | --- |
| Assets surface | Any authorized project member | A project asset with no tool binding. |
| Project list or project workspace drop zone | Any authorized project member | A project asset attached to the project. |
| Any editor's Import command | Tool user | A project asset plus a draft binding in that tool's active revision. |
| Canvas or inspector drop | Tool user | A project asset plus a binding, with the drop target offered as the initial mapping hint. |
| Assistant composer attachment | Tool user | A project asset after explicit promotion, then optionally a proposed binding. |
| API or integration client | Service principal | A project asset created through the asset API. |
| Bulk or folder upload | Any authorized project member | One project asset per file, reported as a batch. |

Rules:

* A tool import command MUST reuse the same intake API. It MUST NOT store bytes in a tool-private location.
* Creating an asset and binding it are separate steps. A failed or abandoned binding leaves a valid, unbound asset.
* An asset created from a tool is immediately available to every other authorized tool in the project.

## Intake Sequence

1. The client requests an asset upload and declares filename, media type, size, intended kind, and access classification.
2. The service authorizes the request against the project, creates `ProjectAsset` and a pending `AssetVersion` when needed, validates the declared size and media type against the project and platform limits, and returns the version resource with the limits that apply to it. Nothing is stored yet.
3. The client streams the bytes to the version's content resource. The service streams them to object storage **without buffering the whole object**, computes the SHA-256 checksum incrementally, and enforces the declared size and media type as the bytes arrive. An aborted request aborts the upload and records nothing.
4. On completion the service records the server-observed `content_checksum` and byte size, stores provenance, and starts malware scanning. An unscanned or infected artifact is quarantined (`asset.malware.quarantined`) and cannot be processed, previewed, bound, or downloaded.
5. On a clean scan, the service starts an asset processing job that runs registered adapters to produce representations (see [Import and Conversion Framework](import-adapters.md)).
6. Identical bytes are deduplicated by `content_checksum` after intake. A checksum supplied by the client is a hint that a version may already be held, never evidence of content identity.

Uploads never hand the client a storage credential or a storage write URL, so there is no upload capability to leak and no bucket write path reachable from a browser ([D23](../tools/site-and-facility/decisions.md)). A client-supplied checksum can confirm "already held", but the service still computes the authoritative checksum from the bytes it receives.
7. The asset becomes consumable. Processing failures produce representations with `status = FAILED` and diagnostics, but the asset version itself remains valid evidence.

## Representations and Processing

* An asset version always has an `ORIGINAL` representation, which is the uploaded bytes.
* Registered adapters produce further representations: a converted intermediate, extracted features, georeference candidates, a preview, tiles, a 3D mesh, or extracted text.
* Representations are derived and disposable. Deleting a representation MUST NOT affect the asset version or an applied binding.
* Processing is idempotent per `(asset_version_id, producer, producer_version)`. Re-running a producer that already succeeded is a no-op unless forced, which creates a new representation.
* A tool consumes either the `ORIGINAL` representation or a specific derivative. A tool MUST NOT assume that a representation exists; a missing representation is a normal state that triggers processing or a diagnostic.
* A representation is never authoritative design data. Authority is created only when a tool's binding is reviewed and applied.

## Tool Consumption

A tool consumes an asset by creating an `AssetBinding` in a revision and extending it with tool-specific detail. For the Site and Facility Editor, the detail is a `SpatialTransform`, one or more `ImportMapping` records, and the normalized entities produced by apply; see [Import Mapping](../tools/site-and-facility/import-adapters.md).

| Rule | Requirement |
| --- | --- |
| Pinning | A binding MUST pin `asset_version_id` and, when a derivative is consumed, `representation_id`. |
| Isolation | Two tools MAY bind the same asset version independently; each tool's transform, mapping, and derived entities are its own. |
| No silent change | A new asset version MUST NOT alter an existing binding or any entity derived from it. |
| Supersession | When a newer version exists, the tool surfaces an upgrade affordance; upgrading is explicit and re-enters the tool's review workflow. |
| Reversibility | Removing a binding MUST NOT delete the asset or another tool's binding. |
| Provenance | Every entity derived from a binding MUST carry the asset version identifier and the tool's binding identifier. |

## Provenance and Source Management

* Every version records who uploaded it, when, the declared `source_ref`, the original filename, and the checksum.
* A converted or derived artifact records its producer identity and version, so a value can always be traced to the exact bytes and process that produced it.
* An asset MAY carry `tags` and free-form `source_ref` metadata, but those never substitute for a normalized design entity.
* Editing or annotating an asset never mutates the original bytes; it creates a new version or a derived representation.

## Access Control

| Concern | Requirement |
| --- | --- |
| Authorization | Every asset read, write, and download is authorized against the project and organization boundary. |
| Classification | `PROJECT` assets are readable by any project member; `RESTRICTED` assets require a live per-asset, per-user `AssetAccessGrant` in addition to project membership. The uploader of a `RESTRICTED` asset is granted on creation, so a creator never loses access to what they uploaded. |
| Grant management | Granting and revoking requires `asset.write` at the project. Holding `asset.write` does not by itself authorize reading a restricted asset; the grant is the authorization. |
| Download URLs | Object- and operation-scoped, time-limited, and never list-capable. Uploads are streamed to the API instead, so no storage write capability leaves the service ([D23](../tools/site-and-facility/decisions.md)). |
| Quarantine | A quarantined version is readable only by an authorized security role and is never processed, previewed, or bound. |
| Audit | Create, version, download, classification change, quarantine, and deletion produce append-only audit records. |

## Lifecycle, Retention, and Deletion

| State or action | Rule |
| --- | --- |
| `ACTIVE` | Consumable. New versions are permitted. |
| `ARCHIVED` | Not offered for new bindings; existing bindings and revisions remain reproducible. Reversible. |
| `QUARANTINED` | Blocked from processing, previewing, binding, and download except by a security role. |
| `DELETED` | Bytes removed only when no retained revision, binding, or legal hold references any version. |
| Version supersession | Old versions remain addressable and are retained for the life of the referencing revisions. |
| Retention class | Each asset version carries a `retention_class`; a legal or regulatory hold overrides every retention rule. |
| Deletion guard | A delete request that would break a retained reference is rejected with the referencing records listed. |

Per-class retention and deletion rules for project assets and their representations are specified in [Workspace Retention](retention.md). That document also records the recovery targets for workspace-owned stores as a platform-level gap.

## Object Store Layout

Asset objects are immutable and addressed by project, asset, version, and checksum.

```text
projects/{project_id}/assets/{asset_id}/versions/{asset_version_id}/{checksum}/original
projects/{project_id}/assets/{asset_id}/versions/{asset_version_id}/representations/{representation_id}/{checksum}
projects/{project_id}/assets/{asset_id}/versions/{asset_version_id}/preview/{producer_version}
```

A converted intermediate, mesh, tile set, or preview is a representation object and never replaces the original. Object keys are implementation details. Clients receive signed URLs for downloads only; uploads are streamed to the API ([D23](../tools/site-and-facility/decisions.md)).

## Persistence Models

| Model | Identity | Reference fields | Cardinality and purpose |
| --- | --- | --- | --- |
| `project_assets` | `asset_id` | `project_id`, `current_version_id` | One project has many assets; each asset has one or more immutable versions. |
| `asset_versions` | `asset_version_id` | `asset_id`, `supersedes_asset_version_id?` | Immutable byte sets; unique `(asset_id, version_number)` and unique `(asset_id, content_checksum)` so an asset never holds the same bytes twice. Identical bytes across assets share one stored object through a project-level content index, not one version row ([D24](../tools/site-and-facility/decisions.md)). |
| `asset_representations` | `representation_id` | `asset_version_id` | Derived artifacts; unique `(asset_version_id, kind, producer, producer_version)`. |
| `asset_bindings` | `binding_id` | `asset_version_id`, `project_id`, `scenario_id`, `revision_id` | Tool consumption records; one asset version may be bound by many tools and revisions. |
| `asset_links` | `link_id` | `asset_version_id` | Lightweight associations to a project, scenario, revision, or entity. |
| `asset_access_grants` | `grant_id` | `asset_id`, `grantee_id`, `project_id` | Explicit grants for restricted assets; unique `(asset_id, grantee_id)` so one live grant exists per user, with revoked rows retained for audit. |
| `asset_jobs` | `job_id` | `asset_version_id`, `project_id` | Scanning and processing job state. |

Constraints:

* Every reference resolves within the same `project_id`.
* `(asset_id, version_number)` and `(asset_version_id, kind, producer, producer_version)` are unique.
* `current_version_id` always points to an existing, non-quarantined version of the same asset.
* A representation cannot exist without its asset version; an asset version cannot be deleted while a binding or retained revision references it.

## Asset API

Asset endpoints are workspace-level and shared by every tool. Tool-specific binding detail is added by the owning tool's API.

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /api/v1/projects/{projectId}/assets` | `asset.read` | List and filter assets by kind, media type, tag, status, and bound tool. |
| `POST /api/v1/projects/{projectId}/assets` | `asset.write` | Create an asset and its first version, and return the upload limits that apply to it. |
| `POST /api/v1/projects/{projectId}/assets/{assetId}/versions` | `asset.write` | Create a new superseding version and return its upload limits. |
| `PUT /api/v1/projects/{projectId}/assets/{assetId}/versions/{versionId}/content` | `asset.write` | Stream the bytes of a version. The service enforces the declared size and media type, computes the checksum, and starts scanning and processing on completion. |
| `GET /api/v1/projects/{projectId}/assets/{assetId}` | `asset.read` | Fetch the asset, its versions, and its representations. |
| `GET /api/v1/projects/{projectId}/assets/{assetId}/versions/{versionId}/download` | `asset.read` | Issue a signed download URL for a version or representation. |
| `POST /api/v1/projects/{projectId}/assets/{assetId}/process` | `asset.write` | Request or force processing of a version by a named producer. |
| `PATCH /api/v1/projects/{projectId}/assets/{assetId}` | `asset.write` | Update name, tags, classification, or retention class. |
| `POST /api/v1/projects/{projectId}/assets/{assetId}/archive` | `asset.write` | Archive or restore an asset. |
| `DELETE /api/v1/projects/{projectId}/assets/{assetId}` | `asset.delete` | Delete an asset when no retained reference exists. |
| `GET /api/v1/projects/{projectId}/assets/{assetId}/grants` | `asset.write` | List the live access grants for a restricted asset. |
| `POST /api/v1/projects/{projectId}/assets/{assetId}/grants` | `asset.write` | Grant one user access to a restricted asset. |
| `DELETE /api/v1/projects/{projectId}/assets/{assetId}/grants/{granteeId}` | `asset.write` | Revoke one user's access. |
| `GET /api/v1/jobs/{jobId}` | `asset.read` | Poll scan and processing jobs. |

Permission keys `asset.read`, `asset.write`, and `asset.delete` are platform keys shared by every tool. Error codes follow the shared API conventions: `ASSET_QUARANTINED` (409), `ASSET_CHECKSUM_MISMATCH` (422), `ASSET_REFERENCED` (409), and `ASSET_ACCESS_DENIED` (403).

## Events

| Event | Consumers | Payload minimum |
| --- | --- | --- |
| `asset.created.v1` | Shell, tools, search index | Project, asset, version, kind, media type, checksum |
| `asset.processed.v1` | Tools, UI, jobs drawer | Asset version, representations produced, producer versions, diagnostics |
| `asset.version.superseded.v1` | Tools holding bindings, UI | Asset, previous and current version, affected bindings |
| `asset.quarantined.v1` | Security, tools, audit | Asset version, scan verdict, affected bindings |
| `asset.deleted.v1` | Tools, audit | Asset, removed versions, reference check result |

Events carry a schema version, event ID, correlation ID, producer timestamp, project ID, and the affected asset and version IDs. Consumers are idempotent and fetch the canonical asset; an event is not permission to mutate a binding.

## Asset Diagnostics

These identifiers are workspace-level and tool-independent. They are distinct from the processing diagnostics in the [Import and Conversion Framework](import-adapters.md) and from a tool's own mapping diagnostics.

| `constraint_id` | Default severity | Scope | Remediation | Trigger |
| --- | --- | --- | --- | --- |
| `asset.checksum.missing` | ERROR | Both | `REVIEW_IMPORT` | An upload is finalized without a verified checksum. |
| `asset.checksum.mismatch` | ERROR | Both | `REVIEW_IMPORT` | Stored bytes do not match the declared checksum. |
| `asset.malware.quarantined` | ERROR | Both | `REVIEW_IMPORT` | Malware scan failed or detected a threat. |
| `asset.media_type.unsupported` | ERROR | Both | `REVIEW_IMPORT` | No registered adapter or handler accepts the media type. |
| `asset.version.superseded` | WARNING | Full | `ADD_DATA` | A binding or revision consumes a superseded asset version. |
| `asset.representation.stale` | WARNING | Full | `ADD_DATA` | A consumed representation was produced by an older producer version. |
| `asset.representation.failed` | ERROR | Full | `REVIEW_IMPORT` | A required representation failed to process. |
| `asset.retention.hold` | INFO | Full | `OBTAIN_APPROVAL` | A retention or legal hold prevents an otherwise permitted deletion. |

## Acceptance Criteria

1. A file imported from any entry point becomes a project-scoped asset with a stable `asset_id` and an immutable first version.
2. No tool stores imported bytes in a tool-private location; every import uses the shared intake API.
3. An asset created through one tool is visible and bindable by every other authorized tool in the project.
4. A binding pins the exact asset version and, when used, the representation, and a later asset version never changes the binding or its derived entities.
5. Re-uploading identical bytes deduplicates storage while preserving provenance and version history.
6. A quarantined version cannot be processed, previewed, downloaded, or bound.
7. Representations are derived, versioned by producer, and rebuildable; deleting one never affects the asset version or an applied binding.
8. Deleting an asset is refused while a retained revision, binding, or hold references any version, and the refusal lists the references.
9. Every derived design entity carries the asset version and binding identifiers in its provenance.
10. Asset access is authorized at the project boundary, and `RESTRICTED` assets require an explicit grant.
