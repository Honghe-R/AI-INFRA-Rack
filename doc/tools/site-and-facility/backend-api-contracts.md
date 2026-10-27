# Site and Facility Editor Backend API Contracts

This document defines the API surface for the Site and Facility Editor. Browser-facing APIs use JSON over HTTPS. Internal service boundaries use the versioned protobuf contract from [Interchange Contract](interchange-contract.md). The API does not expose stored documents or object-store keys as its public contract. Permission keys used here are defined in "Authorization and Permissions" below.

## API Conventions

| Concern | Contract |
| --- | --- |
| Versioning | Browser routes are prefixed `/api/v1`. Additive fields are allowed; breaking changes require a new version. Internal protobuf uses `infrastructure.planner.facility.v1`. Unknown contract versions are rejected with `UNSUPPORTED_CONTRACT_VERSION`. |
| Authorization | Every request is authenticated and authorized for organization, project, scenario, revision, and operation. Each endpoint declares its required permission key. Signed object URLs are time- and object-scoped. |
| Concurrency | Every draft-mutating request includes `If-Match: <revision-etag>` and `base_revision_id`. The ETag must equal the current draft ETag; the base revision must be an ancestor of that draft. A mismatch returns `409 REVISION_CONFLICT` with current revision metadata. A write to a `VALIDATED` or `PUBLISHED` revision returns `409 IMMUTABLE_REVISION`. |
| Idempotency | Commands with externally visible effects accept `Idempotency-Key`. A duplicate key returns the original result. Reusing a key with a different payload returns `409 IDEMPOTENCY_CONFLICT`. Records are retained per [D21](decisions.md). |
| Time and units | Timestamps are RFC 3339 UTC. API payloads use normalized SI values and declare quantity basis and state. Display units are never accepted as authoritative input. |
| Pagination | Collection reads accept `page_size` (default 50, maximum 200) and an opaque `cursor`. Responses carry `meta.next_cursor` when more results exist. Cursors are stable within one revision and invalid across revisions. |
| Long-running work | Import, conversion, validation, publish, export, and allocation operations return a job resource and never hold an HTTP request open for completion. |
| Payload limits | Requests are size-capped. Geometry and change-set caps, file-size caps, and array-length caps are defined in [Non-Functional Requirements](non-functional-requirements.md). Exceeding a cap returns `413 PAYLOAD_TOO_LARGE`. |
| Errors | Errors use the standard error shape and a code from the "Error Codes" catalog. Engineering findings are diagnostics, never generic HTTP errors. |

## Authorization and Permissions

Every endpoint requires one permission key; write endpoints additionally require the draft to be editable and the caller to hold the permission at the resolved project and scenario scope.

| Permission key | Grants |
| --- | --- |
| `facility.read` | Read envelopes, entities, geometry, diagnostics, capacity, documents, and jobs. |
| `facility.draft.create` | Create or branch a draft revision. |
| `facility.entity.write` | Create, update, or remove non-geometric entity attributes. |
| `facility.geometry.write` | Create, edit, transform, split, or merge geometry. |
| `facility.import.initiate` | Create an import session and upload a source document. |
| `facility.import.map` | Create or review a spatial transform or import mapping. |
| `facility.import.apply` | Apply reviewed mappings to a draft. |
| `facility.constraint.write` | Create or edit spatial constraints and environmental constraints. |
| `facility.utility.write` | Create or edit utility sources, interfaces, and storage reserves. |
| `facility.capacity.request` | Submit a capacity demand request. |
| `facility.capacity.allocate` | Accept, reject, revoke, or expire a capacity allocation. |
| `facility.phase.write` | Create or edit phases and phase dependencies. |
| `facility.validate.run` | Run affected-subgraph or full validation. |
| `facility.publish` | Publish a validated revision. |
| `facility.approve` | Record an approval attestation. |
| `facility.waiver.grant` | Grant or revoke a waiver. |
| `facility.document.manage` | Attach, update, or detach operational documents. |
| `facility.share` | Share a draft context with a recipient or tool scope. |
| `facility.export` | Generate an export artifact. |
| `map.read` | Request basemap tiles and provider metadata through the server-side tile proxy for an authorized project. |
| `map.usage.read` | Read tile usage, quota, and provider health for an organization or project. |
| `map.manage` | Configure basemap provider selection and project tile quotas. |
| `asset.read` | List, inspect, and download project assets in an authorized project. |
| `asset.write` | Create assets and versions, request processing, reclassify, and archive. |
| `asset.delete` | Delete an asset when no retained reference exists. |

Role bundles are an application concern, not a contract concern; the API authorizes individual keys. The assistant's `requiredFunctions` values use the same keys. The `map.*` and `asset.*` keys are platform permission keys consumed by this tool and shared with every tool.

## Resource Reads

| Method and path | Permission | Purpose | Success response |
| --- | --- | --- | --- |
| `GET /api/v1/projects` | `facility.read` | List accessible projects | Project summaries, active revision state, validation counts, cursor |
| `GET /api/v1/projects/{projectId}/scenarios` | `facility.read` | List scenarios | Scenario summaries, active revision, lifecycle |
| `GET /api/v1/projects/{projectId}/facility/revisions` | `facility.read` | List Facility Envelope revisions for a scenario (`scenario_id` required) | Revision summaries, coverage, lifecycle, approval state, cursor |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}` | `facility.read` | Fetch a normalized Facility Envelope | `FacilityEnvelope`, validation summary, ETag |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/entities` | `facility.read` | List entities by type, parent, phase, or status | Paginated entity summaries |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/entities/{entityId}` | `facility.read` | Fetch one entity with its geometry references | Entity, geometry records, provenance |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/geometry` | `facility.read` | Query geometry by bounding box, layer, entity type, or role | Normalized geometry records, never raw CAD bytes |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/constraints` | `facility.read` | List spatial constraints with rule metadata | Constraint records and linked geometry |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/utilities` | `facility.read` | List utility sources and interfaces | Sources, interfaces, service state |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/capacity` | `facility.read` | List budgets and allocations | Budgets with derived availability, allocations |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/phases` | `facility.read` | List phases and capability availability | Phase plan, dependencies, availability |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/documents` | `facility.read` | List attached documents | Document metadata, cursor |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/diagnostics` | `facility.read` | Fetch diagnostics with filters (severity, status, capability, entity) | Paginated diagnostics and run metadata |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/assumptions` | `facility.read` | List assumptions and their status | Assumption records |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/waivers` | `facility.read` | List waivers and their scope | Waiver records |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/approval-attestations` | `facility.read` | List approval, rejection, and revocation attestations | Attestation records, cursor |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/impact-notices` | `facility.read` | List supersession and invalidation notices | Impact notices |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/dependencies` | `facility.read` | Report upstream and downstream impact for a draft or entity | Dependency edges, invalidated consumer types |
| `GET /api/v1/projects/{projectId}/facility/compare` | `facility.read` | Diff two revisions (`from`, `to`, optional capability or entity type) | Entity, geometry, coverage, capacity, and diagnostic diffs |
| `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}/asset-bindings` | `facility.read` | List this revision's bindings to project assets | Binding summaries with pinned asset version, tool, status, cursor |
| `GET /api/v1/projects/{projectId}/facility/asset-bindings/{bindingId}` | `facility.read` | Fetch one binding with transform, mappings, features, report, and diagnostics | Binding detail, pinned asset version, diagnostics |
| `GET /api/v1/projects/{projectId}/facility/exports/{artifactId}` | `facility.export` | Issue a signed URL for a generated export | Signed URL, producer/version metadata |
| `GET /api/v1/jobs/{jobId}` | `facility.read` | Poll asynchronous work | Job state, progress, result references, diagnostics |
| `GET /api/v1/jobs` | `facility.read` | List jobs for the current context | Paginated job summaries |

Reads accept `scenario_id` where the path does not imply it. Geometry queries support bounding-box, layer, entity-type, and role filters and return normalized entities, never raw CAD/DWG bytes.

### Map Tile Proxy

Basemap tiles are served only through the server-side proxy ([D16](decisions.md)). The client never contacts a tile provider and never receives a provider credential.

| Method and path | Permission | Purpose | Success response |
| --- | --- | --- | --- |
| `GET /api/v1/map/providers` | `map.read` | List configured basemap providers with attribution text, style list, cache policy, and availability | Provider descriptors |
| `PUT /api/v1/projects/{projectId}/map/provider` | `map.manage` | Select the active provider, style, and tile quota for the project | Updated project map settings |
| `GET /api/v1/map/tiles/{provider}/{z}/{x}/{y}` | `map.read` | Fetch one proxied basemap tile; `project_id` is required, `style` and `scale` are optional | Tile bytes with cache, expiry, and attribution headers |
| `GET /api/v1/projects/{projectId}/map/usage` | `map.usage.read` | Read tile usage and quota by provider and period | Usage counters, quota, period, provider health |

Rules:

* Provider credentials are held in the secret manager, injected at the proxy, and MUST NOT appear in the client, URLs visible to the client, logs, traces, or error messages.
* Every tile request MUST be authenticated, scoped to an authorized project, metered by organization, project, user, and provider, and rate-limited.
* The proxy MUST honor each provider's cache directives. A tile MUST NOT be cached or retained longer than the provider permits, and the proxy MUST NOT be used as a general-purpose tile mirror.
* Provider descriptors MUST return the attribution text the client is required to render, and the client MUST render it whenever basemap tiles are visible.
* Tile requests MUST be bounded by the project viewport and session; bulk or systematic tile harvesting MUST be rejected.
* A provider that is unlicensed, over quota, or unavailable MUST degrade the canvas to the plan-only grid rather than fail the editing session.

## Draft and Change Sets

Draft edits are submitted as one typed change set and committed atomically. A commit advances the draft ETag and emits `facility.revision.changed.v1`; it does not create a child revision.

```text
ChangeSet
  base_revision_id: UUID
  etag: string
  changes[]: Change

Change (one variant per entry)
  kind, target_ref: EntityRef, payload
```

| Change kind | Required permission | Payload | Effects |
| --- | --- | --- | --- |
| `create_container` | `facility.entity.write` | `kind`, `name`, `parent_ref`, `phase_id?`, `level_number?` | Creates a container and registers its stable ID. |
| `update_entity` | `facility.entity.write` | field patch, `provenance` | Creates a new entity version in the draft. |
| `remove_entity` | `facility.entity.write` | `entity_ref`, `cascade: NONE \| CHILDREN` | Marks the entity removed; cascading removal is previewed and confirmed. |
| `set_geometry` | `facility.geometry.write` | `role`, `ordinal`, `geometry_type`, `geojson_4326` or `projected_geometry`, `crs`, `elevation?`, `parent_transform_id?` | Creates or replaces one geometry record; preserves the prior version. |
| `transform_geometry` | `facility.geometry.write` | `geometry_id`, `transform_id` or inline transform | Re-projects a geometry and records the transform used. |
| `assign_constraint` | `facility.constraint.write` | `constraint_kind`, `geometry_id?`, `rule_kind?`, `rule_value?`, `rule_unit?`, `severity`, `policy_id?` | Attaches a spatial constraint. |
| `assign_phase` | `facility.phase.write` | `entity_ref`, `phase_id` | Assigns an entity to a phase. |
| `set_phase_dependency` | `facility.phase.write` | `predecessor_phase_id`, `successor_phase_id` | Adds a dependency edge; cycles are rejected. |
| `set_utility_source` | `facility.utility.write` | source fields, `capacity`, `capacity_state`, `failure_domain_id`, `available_from` | Creates or updates a utility source. |
| `set_utility_interface` | `facility.utility.write` | `interface_id?`, `utility_source_id`, `phase_id`, `capacity`, `service_state` | Creates or updates an interface. |
| `set_failure_domain` | `facility.utility.write` | `failure_domain_id?`, `name`, `kind`, `parent_failure_domain_id?` | Creates or updates a failure domain; cycles are rejected. |
| `set_resilience_requirement` | `facility.utility.write` | `availability_policy`, `policy_id`, `applies_to[]`, `autonomy_duration?` | Replaces the active resilience requirement. |
| `set_storage_reserve` | `facility.utility.write` | `kind`, `capacity`, `autonomy_duration`, `failure_domain_id`, `phase_id` | Creates or updates a fuel or water reserve. |
| `set_capacity_budget` | `facility.capacity.allocate` | `owner_ref`, `phase_id`, `resource_kind`, `basis`, `commissioned`, `planned`, `reserved` | Creates or updates a budget; duplicate owner/phase/resource/basis is rejected. |
| `set_environmental_constraint` | `facility.constraint.write` | `profile_id`, `constraint_kind`, `threshold`, `unit`, `basis`, `affected_ref?` | Creates or updates an environmental constraint. |
| `record_assumption` | `facility.entity.write` | `statement`, `owner`, `confidence`, `effective_at`, `entity_refs[]` | Creates an assumption and caps touched capability coverage. |
| `resolve_assumption` | `facility.entity.write` | `assumption_id`, `resolution` | Closes an assumption; does not silently upgrade coverage. |
| `attach_document` | `facility.document.manage` | `kind`, `title`, `media_type`, `content_checksum`, `entity_refs[]` | Attaches document metadata. |
| `detach_document` | `facility.document.manage` | `document_id` | Removes the document reference for this revision. |

Change-set rules:

* The whole change set commits or fails as one transaction. A single invalid change rejects the set with a `422` and per-change diagnostics.
* Changes are applied in dependency order: containers and entities, then geometry, then constraints, phases, utilities, resilience, capacity, and environment.
* A geometry change that would violate a hard spatial constraint is still accepted into the draft but returns the resulting `ERROR` diagnostics in the response, so the UI can preview before commit when practical. Diagnostics can never be suppressed by a change set.
* Removing an entity that another entity references returns `409` with the referencing entities unless `cascade: CHILDREN` is explicit.
* Every change entry echoes its resolved `entity_ref` and stable ID in the response.
* Cost, schedule, and sustainability values are reference-only ([D18](decisions.md)): no change kind and no permission key creates, edits, or deletes them, and no validation check consumes them. They appear in the envelope only as `CostScheduleReference` links owned by the Cost, Schedule, and Sustainability workspace.

## Draft, Asset Binding, and Export Commands

A binding consumes a project asset version; the file itself is created and versioned through the workspace [asset API](../../workspace/project-assets.md). A tool MUST NOT accept uploaded bytes directly.

| Method and path | Permission | Request | Result |
| --- | --- | --- | --- |
| `POST /api/v1/projects/{projectId}/facility/revisions` | `facility.draft.create` | `base_revision_id`, scenario ID, initial design context | New `DRAFT` revision and ETag |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/branches` | `facility.draft.create` | New scenario or revision name | New independent `DRAFT` recording `base_revision_id`; branching from a `VALIDATED` or `PUBLISHED` revision is the correction path |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/changes` | per change kind | `ChangeSet` | Updated draft ETag, resolved entity IDs, resulting diagnostics, impact notice |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/asset-bindings` | `facility.import.initiate` | `asset_version_id`, `representation_id?`, role, scenario/base revision | Draft binding pinned to that asset version, plus a processing job when the representation is not ready |
| `POST /api/v1/projects/{projectId}/facility/asset-bindings/{bindingId}/transform` | `facility.import.map` | Source units, CRS/transform method, control points | Draft transform plus review diagnostics |
| `POST /api/v1/projects/{projectId}/facility/asset-bindings/{bindingId}/mappings` | `facility.import.map` | Source selector, target entity type, target geometry role, attribute mapping | Draft mapping plus normalized-entity preview |
| `POST /api/v1/projects/{projectId}/facility/asset-bindings/{bindingId}/mappings/{mappingId}/review` | `facility.import.map` | `review_state`, comment | Reviewed mapping record |
| `POST /api/v1/projects/{projectId}/facility/asset-bindings/{bindingId}/preview-merge` | `facility.import.apply` | Reviewed transform/mapping IDs, target draft revision | Conflict preview listing created, updated, and conflicting entities |
| `POST /api/v1/projects/{projectId}/facility/asset-bindings/{bindingId}/apply` | `facility.import.apply` | Reviewed transform/mapping IDs, target draft revision, conflict resolutions | Updated draft ETag, import report, diagnostics, binding status `APPLIED` |
| `POST /api/v1/projects/{projectId}/facility/asset-bindings/{bindingId}/upgrade` | `facility.import.map` | Target `asset_version_id` | New draft binding to the newer version; the prior binding and its entities are unchanged |
| `DELETE /api/v1/projects/{projectId}/facility/asset-bindings/{bindingId}` | `facility.import.apply` | none | Removes the binding; the asset and every other tool's binding are untouched |

The backend rejects an unrecognized entity type, cross-project reference, malformed geometry, unsupported media type, quarantined asset version, or unknown contract version with a structured `4xx` error. Binding apply never overwrites user-authored entities; every conflict must be resolved explicitly in `preview-merge`.
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/exports` | `facility.export` | `format`, optional scope and capability subset | Export job resource |

The backend rejects an unrecognized entity type, cross-project reference, malformed geometry, unsupported media type, missing source checksum, or unknown contract version with a structured `4xx` error. Import apply never overwrites user-authored entities; every conflict must be resolved explicitly in `preview-merge`.

**One documented exception to `If-Match` on writes.** `POST .../asset-bindings` carries no `If-Match` and returns no new ETag, because creating a binding does not advance the draft token. Applying an import is one typed change set and that is what advances it ([Import Adapters](import-adapters.md), "Facility Mapping Rules"); pinning a source is provenance, not a change to the design graph. This is a real exception to the Concurrency convention above rather than an omission, so it is recorded here. Two concurrent binds of the same version and role are serialised on the revision row and the second is refused with `409`, so no update is lost; and a change set prepared before a binding is unaffected by it, because the diagnostic preview runs inside the commit's own transaction and therefore sees the binding.

## Capacity, Validation, Publication, Governance, and Approval Commands

| Method and path | Permission | Request | Result |
| --- | --- | --- | --- |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/capacity-requests` | `facility.capacity.request` | `CapacityDemandRequest` | Allocation job or immediate `CapacityAllocation` decision, plus budget effect |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/allocations/{allocationId}` | `facility.capacity.allocate` | `state` (`ACCEPTED`, `REJECTED`, `REVOKED`, `EXPIRED`), comment | Updated allocation and budget availability |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/validate` | `facility.validate.run` | `scope`: `FULL` or `AFFECTED_SUBGRAPH`, optional capability subset, `base_etag` for local runs | Validation job; a clean `FULL` run transitions `DRAFT` to `VALIDATED` and contains the run summary, diagnostics, and derived coverage |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/share` | `facility.share` | Optional recipient or tool scope | Share grant with scope, expiry, and coverage snapshot |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/publish` | `facility.publish` | Expected validation-run ID | Publication job; transitions a `VALIDATED` revision to `PUBLISHED` with pinned sources and policies |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/approval-attestations` | `facility.approve` | Policy ID, `decision`, comment | Immutable approval, rejection, or revocation attestation |
| `POST /api/v1/projects/{projectId}/facility/revisions/{revisionId}/waivers` | `facility.waiver.grant` | `diagnostic_ids[]`, scope, policy ID, reason, `expires_at?` | Immutable waiver; named diagnostics become `WAIVED` |
| `POST /api/v1/projects/{projectId}/facility/waivers/{waiverId}/revoke` | `facility.waiver.grant` | Reason | Revocation record; gating effect is restored |

`publish` does not imply approval. `approval-attestations` cannot change a Facility Envelope or remove diagnostics. A local `AFFECTED_SUBGRAPH` validation run never sets lifecycle state and is always tagged with the `base_etag` it was computed against. Lifecycle transitions are one-way: a `VALIDATED` or `PUBLISHED` revision is never reopened, and every later change is a new `DRAFT` branched from it.

## Standard Response Shapes

```json
{
  "data": {},
  "meta": {
    "project_id": "uuid",
    "scenario_id": "uuid",
    "revision_id": "uuid",
    "lifecycle_state": "DRAFT",
    "etag": "string",
    "correlation_id": "uuid",
    "next_cursor": "opaque-or-null"
  }
}
```

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "The draft is based on an older revision.",
    "details": [
      {
        "field": "base_revision_id",
        "constraint_id": "facility.revision.current",
        "current_revision_id": "uuid",
        "current_etag": "string"
      }
    ]
  },
  "meta": {
    "correlation_id": "uuid"
  }
}
```

```text
Job
  job_id, type: IMPORT | CONVERSION | VALIDATION | PUBLISH | EXPORT | ALLOCATION
  status: QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED
  progress_percent, phase
  project_id, scenario_id, revision_id, binding_id?, asset_version_id?, allocation_id?
  result_ref?, diagnostics[], error?, cancelable
  created_at, updated_at, completed_at?
```

### Error Codes

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `UNSUPPORTED_CONTRACT_VERSION` | Request contract version is unknown. |
| 401 | `AUTHENTICATION_REQUIRED` | No valid principal. |
| 403 | `PERMISSION_DENIED` | Principal lacks the required permission key. |
| 403 | `SCOPE_MISMATCH` | A project, scenario, or revision identifier does not match the authorized scope. |
| 404 | `NOT_FOUND` | Target resource does not exist in scope. |
| 404 | `BASE_REVISION_NOT_FOUND` | The named base revision does not exist. |
| 409 | `REVISION_CONFLICT` | ETag or base revision is stale. |
| 409 | `IMMUTABLE_REVISION` | A write targeted a `VALIDATED` or `PUBLISHED` revision. |
| 409 | `IDEMPOTENCY_CONFLICT` | Idempotency key reused with a different payload. |
| 409 | `ENTITY_REFERENCED` | Removal would orphan referencing entities. |
| 409 | `IMPORT_CONFLICT` | Import apply conflicts with user-authored entities. |
| 409 | `VALIDATION_REQUIRED` | Publish attempted without a clean validation run. |
| 409 | `APPROVAL_REQUIRED` | Policy requires an attestation that is absent or revoked. |
| 409 | `JOB_NOT_CANCELLABLE` | Job already reached a terminal state. |
| 413 | `PAYLOAD_TOO_LARGE` | Request or upload exceeds a configured cap. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No adapter supports the declared media type. |
| 422 | `MALFORMED_GEOMETRY` | Geometry fails validity or type rules. |
| 422 | `UNKNOWN_ENTITY_TYPE` | Entity type is not in the canonical enumeration. |
| 422 | `CROSS_PROJECT_REFERENCE` | A reference crosses the project or scenario boundary. |
| 422 | `UNRESOLVED_MAPPING` | Required source mapping is unresolved. |
| 429 | `RATE_LIMITED` | Request rate or concurrency limit exceeded. |
| 403 | `MAP_PROVIDER_NOT_LICENSED` | The project has no active licence or entitlement for the requested basemap provider. |
| 429 | `MAP_QUOTA_EXCEEDED` | Tile quota for the organization or project is exhausted for the current period. |
| 503 | `MAP_PROVIDER_UNAVAILABLE` | The upstream tile provider is unavailable or timed out. |
| 403 | `ASSET_ACCESS_DENIED` | The principal lacks access to a restricted asset or lacks a required asset permission. |
| 409 | `ASSET_QUARANTINED` | The asset version is quarantined and cannot be processed, downloaded, or bound. |
| 409 | `ASSET_REFERENCED` | Deletion was refused because a retained revision, binding, or hold references the asset. |
| 422 | `ASSET_CHECKSUM_MISMATCH` | Uploaded bytes do not match the declared checksum. |
| 500 | `INTERNAL_ERROR` | Unexpected failure; correlation ID is returned. |

Diagnostics use the stable `constraint_id`, entity references, severity, evidence, and remediation category specified in [Constraint Catalog](constraint-catalog.md). API error codes describe request, authorization, concurrency, or infrastructure failures; engineering findings remain diagnostics and do not become generic HTTP errors.

## Internal Events

The backend publishes immutable events through the transactional outbox after a committed state change:

| Event | Consumers | Payload minimum |
| --- | --- | --- |
| `facility.asset-binding.bound.v1` | UI, mapping workflow, audit | Project, revision, binding, pinned asset version, representation |
| `facility.asset-binding.applied.v1` | UI, mapping workflow, audit, downstream tools | Project, revision, binding, asset version, transform, mapping, diagnostics references |
| `facility.revision.changed.v1` | Downstream editors, Verify, indexers | Project/scenario, revision, previous/new ETag, changed entity refs, impact notice |
| `facility.validation.completed.v1` | Verify, UI, notifications | Revision, validation run, scope, coverage, diagnostics summary |
| `facility.envelope.published.v1` | Power, Thermal/HVAC, Floorplan, deployment | Immutable envelope revision, protobuf object reference, content checksum, coverage, approval state |
| `facility.allocation.decided.v1` | Power, Thermal/HVAC, Floorplan, Workload | Revision, budget, allocation, decision state, availability delta |
| `facility.approval.recorded.v1` | Deployment, change management | Revision and approval-attestation reference, decision |
| `facility.waiver.recorded.v1` | Verify, audit, change management | Revision, waiver, diagnostic IDs, expiry |
| `map.usage.threshold.v1` | Cost management, notifications, UI | Organization, project, provider, period, usage, quota, threshold crossed |

Every event carries `event_id`, `schema_version`, `correlation_id`, `producer`, `produced_at`, `project_id`, `scenario_id`, `revision_id`, and an idempotency key derived from the committed state change. Consumers are idempotent, discard already-applied event IDs, and treat events as notifications to fetch the canonical revision, not as permission to mutate it. Outbox delivery guarantees, retry, and dead-letter handling are specified in [Non-Functional Requirements](non-functional-requirements.md).
