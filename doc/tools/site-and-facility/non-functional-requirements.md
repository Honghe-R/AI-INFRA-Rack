# Site and Facility Editor Non-Functional Requirements

This document defines the quality-of-service envelope for the Site and Facility Editor. It does not restate domain behavior. Scale limits, latency budgets, durability, security, observability, retention, accessibility, localization, and capacity-growth rules apply to the API, storage, and work surfaces defined by the functional documents.

## Purpose and Relationship to the Functional Documents

The functional documents state what the editor does. This document states how much load it must absorb, how fast it must answer, how long data must survive, and which controls MUST hold under failure. Where a functional document defines a behavior and this document defines a bound, both apply.

| Document | What this document takes from it | What this document adds |
| --- | --- | --- |
| [Overview](Overview.md) | Core and peripheral design targets, `DRAFT` and `VALIDATED` lifecycle, capability coverage | Service-level targets for the six declared functions |
| [Interchange Contract](interchange-contract.md) | Protobuf package `infrastructure.planner.facility.v1`, revision identity, capability states `NOT_PROVIDED`, `PROVISIONAL`, `VALIDATED` | Cardinality limits per project, scenario, and revision |
| [Entity Model](entity-model.md) | Entity kinds, geometry roles, diagnostic shape, SI `Quantity` | Vertex, container, geometry, and diagnostic ceilings |
| [Storage Shape](storage-shape.md) | Transactional relational store plus object-store split, object immutability, backup and restore duty | RPO, RTO, versioning, retention, and partitioning |
| [Backend API Contracts](backend-api-contracts.md) | Routes, ETag and `If-Match`, `Idempotency-Key`, job resources, outbox events | Latency budgets, asynchronous boundaries, delivery guarantees |
| [Verification Requirements](verification-requirements.md) and [Constraint Catalog](constraint-catalog.md) | Local and full validation scope, stable `constraint_id` identifiers | Validation batch budget, diagnostic volume, alerting |
| [UI Pattern](ui-pattern.md) and [workspace UI Pattern](../../workspace/ui-pattern.md) | Canvas, hierarchy, inspector, findings, import mapping, UI Context | Keyboard, screen-reader, touch, reduced-motion, and localization rules |
| [Decisions](decisions.md) | D1, D2, D9, D10, D11, D15, D16, D17, D18, D19, D20, D21 | Numeric targets that remain proposals pending approval, plus the retention values approved by D21 |

All numeric targets in this document are proposals until approved and are marked "(proposed)". The "Governing item" column names the recorded decision from [Decisions](decisions.md) that governs a value, such as D15 for the transactional store or D21 for retention. The retention values in [Retention and Deletion](#retention-and-deletion) are approved by D21 and carry no "(proposed)" marker.

Constraint language follows RFC 2119. MUST and MUST NOT are binding. SHOULD is a strong default. MAY is optional.

## Scale Limits

Limits apply per project aggregate, per revision, per geometry record, per asset version, per validation run, or per session. A scenario inherits its project limits unless an approved policy narrows them. Exceeding a revision limit MUST fail the command with a structured `4xx` error or a recorded partial-import diagnostic; the service MUST NOT truncate silently.

```text
ScaleLimits
  project: parcels, buildings, floors_and_halls, assets, retained_asset_bytes
  revision: containers, geometry_records, spatial_constraints, utility_sources,
            utility_interfaces, capacity_budgets, capacity_allocations, phases,
            environmental_constraints
  geometry_record: vertices
  asset_version: bytes, imported_features
  validation_run: diagnostics
  session: open_tabs, concurrent_editors
```

| Dimension | Scope | Limit | Governing item |
| --- | --- | --- | --- |
| Parcels | Project | 1,000 (proposed) | D15 |
| Buildings | Project | 5,000 (proposed) | D15 |
| Floors and halls | Project | 50,000 (proposed) | D15 |
| Facility containers | Revision | 100,000 (proposed) | D15 |
| Geometry records | Revision | 250,000 (proposed) | D15 |
| Vertices per geometry record | Geometry record | 100,000 (proposed) | D15 |
| Spatial constraints | Revision | 20,000 (proposed) | D15 |
| Utility sources | Revision | 2,000 (proposed) | D15 |
| Utility interfaces | Revision | 10,000 (proposed) | D15 |
| Capacity budgets | Revision | 50,000 (proposed) | D15 |
| Capacity allocations | Revision | 100,000 (proposed) | D15 |
| Phases | Revision | 100 (proposed) | D15 |
| Environmental constraints | Revision | 10,000 (proposed) | D15 |
| Project assets | Project | 20,000 (proposed) | D20, D21 |
| Asset versions | Asset | 500 (proposed) | D20 |
| Asset representations | Asset version | 50 (proposed) | D20 |
| Imported features per asset version | Asset version | 500,000 (proposed) | D15, D19 |
| IFC entities per model | Asset version | 5,000,000 (proposed) | D19 |
| Diagnostics per validation run | Validation run | 100,000 (proposed) | D15 |
| Open editor tabs | User per project | 12 (proposed); at most one Site and Facility tab per project context | D15 |
| Concurrent editors per draft | Draft | 25 (proposed) | D15 |
| Basemap tile requests | Organization per day | 5,000,000 (proposed) | D16 |
| Basemap tile requests | Project per day | 250,000 (proposed) | D16 |
| Basemap providers per project | Project | 4 (proposed) | D16 |

| Import and upload limit | Value | Governing item |
| --- | --- | --- |
| Maximum source-document file size | 2 GiB (2,147,483,648 bytes) (proposed) | D19 |
| Maximum files per import session | 50 (proposed) | D19 |
| Maximum total import size per import session | 20 GiB (proposed) | D19 |
| Maximum retained import bytes per project | 200 GiB (proposed) | D21 |
| Maximum upload duration | 15 min default, 60 min maximum (15 min default per D21; maximum proposed). Bounds one streaming intake, not a URL's lifetime | D21 |
| Maximum single geometry command body | 256 MiB (proposed) | D15 |

Rules:

1. A command that would exceed a revision or project limit MUST be rejected before any write, and the error details MUST name the limit, the current value, and the limit value.
2. An import that would exceed the per-document or per-session limit MUST be rejected at session creation, before any bytes are accepted.
3. Validation that reaches the diagnostics limit MUST stop, preserve partial diagnostics, and mark the run incomplete. The revision MUST NOT become `VALIDATED` from that run.
4. A capability at `NOT_PROVIDED` or `PROVISIONAL` MUST NOT relax any scale limit.

## Performance and Latency Budgets

Budgets are server-side measurements at the stated percentile under the load of a single project at 50 percent of the revision limits, with warm caches. A budget breach MUST be observable and alertable, not silently absorbed.

| Operation | Class | Target | Governing item |
| --- | --- | --- | --- |
| `GET` Facility Envelope (`GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}`) | Synchronous read | p95 <= 400 ms, p99 <= 1,200 ms (proposed) | D15 |
| Single-entity read | Synchronous read | p95 <= 150 ms, p99 <= 400 ms (proposed) | D15 |
| Geometry bounding-box query | Synchronous read | p95 <= 300 ms, p99 <= 900 ms for up to 5,000 geometry records per page (proposed) | D15, D16 |
| Revision list and diagnostic list | Synchronous read | p95 <= 300 ms, p99 <= 800 ms per page (proposed) | D15 |
| Job status poll (`GET /api/v1/jobs/{jobId}`) | Synchronous read | p95 <= 200 ms, p99 <= 500 ms (proposed) | D15 |
| Local affected-subgraph validation | Synchronous when the affected subgraph is <= 2,000 entities | p95 <= 500 ms, p99 <= 1,500 ms (proposed) | D15 |
| Full validation batch | Asynchronous job | p95 <= 15 min, p99 <= 45 min at revision scale limits (proposed) | D15 |
| Import conversion | Asynchronous job | p95 <= 2 s per MB for DXF, KML, and KMZ; p95 <= 8 s per MB for IFC and licensed-format conversion (proposed) | D19 |
| Mapping preview | Synchronous up to 10,000 selected features | p95 <= 2 s, p99 <= 5 s (proposed) | D15 |
| Import apply | Asynchronous job | p95 <= 10 min for 500,000 features (proposed) | D15, D19 |
| Capacity allocation decision | Synchronous when the contention set is <= 1,000 requests, otherwise asynchronous | p95 <= 1 s, p99 <= 3 s (proposed) | D15 |
| Publish | Asynchronous job | p95 <= 60 s, p99 <= 180 s (proposed) | D15, D17 |
| Export generation | Asynchronous job | p95 <= 10 min, p99 <= 30 min for a full envelope (proposed) | D15 |
| Envelope listing for a scenario | Synchronous read | p95 <= 300 ms, p99 <= 800 ms per page (proposed) | D15 |
| Basemap tile fetch (cache hit) | Synchronous read | p95 <= 50 ms, p99 <= 150 ms (proposed) | D16 |
| Basemap tile fetch (upstream miss) | Synchronous read | p95 <= 1,200 ms, p99 <= 3,000 ms (proposed) | D16 |
| Map usage and quota read | Synchronous read | p95 <= 300 ms, p99 <= 800 ms (proposed) | D16 |

Rules:

1. Import, conversion, import apply, full validation batch, publish, export generation, and any command whose synchronous work would exceed 10 s at p99 MUST run as a job. These operations MUST NOT hold an HTTP request open for completion.
2. An asynchronous command MUST return a job resource within 500 ms at p95 and MUST include the job identifier, job state, and a poll or subscription reference.
3. The synchronous request timeout MUST be 30 s. A handler that cannot finish MUST convert the work to a job and return the job resource rather than failing on timeout.
4. Local affected-subgraph validation is advisory and MUST be marked with the draft ETag it was computed against. When the affected subgraph exceeds 2,000 entities, the editor MUST submit a full validation job instead.
5. Moving publish to a job MUST NOT relax `facility.revision.publish.requires_validation` or `facility.governance.approval.required`.
6. Returning a capacity decision within the synchronous budget MUST NOT relax `facility.capacity.budget.overcommit` or `facility.resilience.availability_policy.violated`.
7. Every latency budget MUST be reported as a histogram keyed by route, operation class, and outcome, so that `ERROR`, `WARNING`, and `INFO` diagnostic volume is attributable.
8. A read that would exceed its page limit MUST paginate with a stable cursor. The service MUST NOT return a partial page without a continuation token.

## Availability and Durability

| Requirement | Target | Governing item |
| --- | --- | --- |
| Read and draft-write API availability | 99.9 percent per calendar month, excluding announced maintenance (proposed) | D15 |
| Asynchronous job completion availability | 99.5 percent per calendar month within the published job SLO window (proposed) | D15 |
| Transactional store RPO | 5 min (proposed) | D15 |
| Transactional store RTO | 1 h (proposed) | D15 |
| Object store RPO | 0 for committed objects; no acknowledged object is lost (proposed) | D15 |
| Object store RTO | 4 h for full project restore, 1 h for a single object (proposed) | D15 |
| Object durability | 99.999999999 percent annual durability (proposed) | D15 |
| Backup cadence | Continuous point-in-time recovery plus a daily full backup (proposed) | D15 |
| Backup retention | 35 days | D21 |
| Restore test cadence | Full restore quarterly, partial restore of one published revision monthly (proposed) | D21 |
| Restore test record retention | 24 months | D21 |
| Maintenance notice | 5 business days for planned maintenance (proposed) | D15 |

Rules:

1. Object versioning MUST be enabled for every bucket that stores project assets, asset representations, envelopes, or exports.
2. A published Facility Envelope protobuf and its referenced asset versions MUST be placed under an object-lock or equivalent governance retention that prevents deletion and overwrite for the approved retention period.
3. A restore test MUST verify the transactional-store backup, the referenced objects, their checksums, and the spatial index rebuild. A failed or overdue restore test MUST block release and raise a `restore_test_failed` alert.
4. Backup and restore operations MUST be recorded as audit records with the backup identifier, restore point, scope, operator, and outcome.
5. Loss of a search index, tile cache, or session cache MUST be recoverable by rebuild from authoritative revisions and MUST NOT block reads of the transactional store.

## Concurrency

The editor uses optimistic concurrency, not locking. `base_revision_id` identifies the revision a draft was branched from. `If-Match` identifies the exact draft state being edited. Both are validated (D1, D2), and a matching ETag never excuses a stale or unrelated base revision.

| Concern | Requirement |
| --- | --- |
| Draft mutation precondition | Every draft-mutating request MUST include `If-Match: <revision-etag>` and `base_revision_id`. |
| Conflict response | A stale ETag or base revision MUST return `409` with error code `REVISION_CONFLICT`, current revision metadata, current ETag, and `constraint_id` `facility.revision.current`. |
| Immutable target | A write that targets a published or otherwise immutable revision MUST return `409` with `facility.revision.writes_immutable`. |
| Merge policy | The service MUST NOT auto-merge concurrent drafts and MUST NOT apply last-writer-wins. |
| ETag scope | The ETag MUST change on any committed change to the draft aggregate and MUST be stable while the draft is unchanged. |
| Expected conflict rate | Below 2 percent of draft mutations at 25 concurrent editors (proposed). |
| Conflict alert | A conflict rate above 5 percent for 15 min MUST raise a collaboration alert (proposed). |
| Command idempotency | Commands with externally visible effects MUST accept `Idempotency-Key` and MUST return the original result for a duplicate key with an identical request. |
| Duplicate with a different body | The same key with a different request body MUST be rejected with `409` and error code `IDEMPOTENCY_KEY_REUSED`, without executing the command. |
| Idempotency scope | Keyed by project, authenticated actor, operation, and key value. |
| Idempotency retention | 7 days per [D21](decisions.md). |
| Outbox delivery | At-least-once and ordered per aggregate key, committed in the same transaction as the state change. |
| Outbox latency | p95 <= 5 s, p99 <= 60 s from commit to first consumer acknowledgement (proposed). |
| Outbox retry | Exponential backoff, dead-letter after 10 attempts, operator replay supported (proposed). |
| Consumer rule | Consumers MUST be idempotent and MUST treat events as notifications to fetch the canonical revision. |

```text
DraftCommand
  project_id, scenario_id, base_revision_id, if_match_etag, idempotency_key
  operation, entity_refs[], payload
```

Rules:

1. A command with a missing `If-Match` on an editable draft MUST be rejected. Read-only reads do not require it.
2. A conflict MUST return enough state for the client to refetch and reapply, and the server MUST NOT discard the client's uncommitted payload.
3. Idempotency records MUST store the request hash, actor, operation, and original result reference, and MUST NOT store secrets or full request bodies beyond the retention window.
4. Publish, approval, and allocation commands MUST be idempotent even when the client omits `Idempotency-Key`, using the natural key of the operation.
5. Concurrency rules apply identically to browser commands, assistant-proposed commands, and service-to-service commands.

## Security and Privacy

| Area | Requirement | Governing item |
| --- | --- | --- |
| Transport | TLS 1.2 or later for browser and service traffic, TLS 1.3 preferred; HSTS enabled; service-to-service mTLS (proposed) | D15 |
| Encryption at rest | AES-256 or provider equivalent for the transactional store, object store, backups, job store, and cache; keys in a managed KMS with annual rotation (proposed) | D15 |
| Tenant and project isolation | Every tenant-scoped row carries `project_id`; organization membership and project scope are enforced; the database applies a row-level security policy as a final backstop | D15 |
| Cross-project references | Rejected by unique indexes, write-time reference validation inside the transaction, and handler validation; a cross-project read returns `404` or `403` and never partial data | D15 |
| Signed download URLs | Scoped to one object key and one read operation, time-limited, and minted only after an API authorization check | D21 |
| Signed URL lifetime | 15 min default, 60 min maximum (15 min default per D21; maximum proposed) | D21 |
| Upload binding | The intake request MUST declare content type and size, and the service MUST enforce both while streaming. The checksum MUST be computed by the service and never supplied by the client (proposed) | D23 |
| Malware scanning | Every uploaded project asset version MUST be scanned before conversion, preview, or binding apply; scan state is stored on the asset version | D20 |
| Scan latency | p95 <= 5 min for a 2 GiB document (proposed) | D19 |
| Quarantine | An unscanned, failed-scan, or infected object MUST be quarantined and MUST NOT be converted, previewed, or downloaded except by an authorized security role | D15 |
| Converter licences | Licence keys and converter credentials MUST be held in a secret manager, injected at runtime, and MUST NOT appear in the database, logs, traces, object metadata, images, or error messages | D19 |
| Converter isolation | Licensed conversion MUST run in an isolated worker with restricted network egress and no access to project credentials (proposed) | D19 |
| Map provider credentials | Provider API keys MUST be held in the secret manager, injected only at the tile proxy, and MUST NOT reach the client, cache keys, usage records, logs, traces, or error messages | D16 |
| Tile request authorization | Every tile request MUST be authenticated, scoped to an authorized project, metered, and rate-limited; systematic or bulk tile harvesting MUST be rejected | D16 |
| Basemap attribution | Provider attribution text MUST be returned with provider metadata and rendered whenever basemap tiles are visible, including exported and printed views | D16 |
| Tile cache policy | Cached tiles MUST NOT outlive the provider-permitted lifetime; a provider that forbids caching MUST NOT be persisted beyond the request | D16 |
| Audit | Authentication, authorization decisions, revision create and publish, approval, waiver, import apply, export, retention hold, deletion, secret access, and configuration change MUST produce append-only audit records | D21 |
| Audit integrity | Audit records MUST be tamper-evident or write-once and MUST include actor, organization, project, operation, target, outcome, correlation ID, timestamp, and source address | D21 |
| PII minimization | Contacts and documents MUST store only the business fields required for coordination: name, role, organization, business email, and business phone | D15, D21 |
| PII prohibition | National identifiers, personal addresses, biometric data, and special-category data MUST NOT be stored | D15 |
| PII in exports | PII MUST be redacted from an export unless the exporter holds an explicit grant (proposed) | D21 |

Authorization enforcement points:

| Point | Responsibility | Failure behavior |
| --- | --- | --- |
| API gateway | Authentication, coarse scope, rate limit, correlation ID assignment | `401` or `429` before domain work |
| Handler or domain service | Operation permission, lifecycle state, project and scenario scope, revision currency | `403` or `409` before any write |
| Database row policy | Tenant and project boundary on every read and write | Query returns no rows; write fails the policy |
| Object store | Signed URL scope and lifetime only; no ambient credentials | Expired or out-of-scope URL returns an access error |

Rules:

1. Authorization MUST deny by default. A missing policy MUST NOT grant access.
2. A signed download URL MUST NOT be issued before the API authorizes the requested object and operation.
3. Secrets, licence keys, signed URLs, asset contents, and full PII MUST NOT be written to logs or traces.
4. Every administrative or retention action MUST be attributable to an authenticated actor and MUST be audited.
5. Personal data MUST be tagged so that retention and deletion rules apply per class.

## Observability

| Required metric | Type | Key labels | Alert condition |
| --- | --- | --- | --- |
| Request latency | Histogram | route, method, status, operation class | p95 budget breach for 15 min |
| Error rate | Counter | route, status, error code | Above 1 percent for 5 min |
| Draft conflict rate | Counter | project, operation | Above 5 percent for 15 min |
| Job duration | Histogram | job type, outcome | p95 above budget for 30 min |
| Job queue age | Gauge | job type | Oldest queued job above 15 min |
| Job failure rate | Counter | job type, error code | Above 2 percent for 15 min |
| Validation diagnostics | Counter | capability, `constraint_id`, severity | Error spike above baseline for 30 min |
| Import conversion throughput | Histogram | adapter, media type, bytes | Below 0.5 MB per second at p95 for 30 min |
| Outbox lag | Gauge | event type | Above 60 s for 5 min |
| Idempotent replay count | Counter | operation | No alert; capacity review input |
| Object store bytes | Gauge | project, artifact class | Above 85 percent of project quota |
| Limit utilization | Gauge | project, revision, limit name | Above 85 percent warning, 95 percent alert |
| Spatial query duration | Histogram | query kind | p95 budget breach for 15 min |
| Tile cache hit rate | Gauge | provider, project | Below 70 percent for 30 min |
| Upstream tile error rate | Counter | provider, status | Above 2 percent for 15 min |
| Map quota utilization | Gauge | organization, project, provider | Above 85 percent warning, 100 percent alert |
| Database connections and lock waits | Gauge | pool, wait class | Saturation above 90 percent for 10 min |
| Malware detection | Counter | verdict | Any detection pages |
| Restore test age | Gauge | test kind | Older than the required cadence |
| Certificate and key age | Gauge | certificate, key | Expiry within 30 days |
| RPO and RTO breach | Counter | store | Any occurrence pages |

The `capability` label MUST use the canonical values `GEOMETRY`, `POWER`, `COOLING`, `WATER`, `FUEL`, `NETWORK_ENTRY`, `ENVIRONMENT`, and `PHASING`.

```text
StructuredLog
  timestamp, level, service, service_version, environment
  correlation_id, trace_id, span_id
  project_id, scenario_id, revision_id
  actor_id, organization_id
  operation, outcome, duration_ms, error_code, constraint_id
  job_id?, asset_id?, asset_version_id?, binding_id?, idempotency_key_hash?, map_provider?
```

Rules:

1. Every request MUST carry a `correlation_id` minted at the edge, returned in the standard response `meta.correlation_id`, and echoed on errors.
2. Traces MUST propagate W3C Trace Context through the API, workers, and outbox consumers.
3. Sampling MUST be 100 percent for errors and for publish, import, validation, and export jobs, and at least 10 percent for baseline traffic (proposed).
4. Per-job progress reporting MUST expose state, percent complete, current step, processed and total counters, start and update times, an optional estimate, and the diagnostics emitted so far.
5. Progress MUST update at least every 5 s or every 1,000 processed features, whichever is more frequent. A job that stops reporting for 5 min MUST raise a stalled-job alert.
6. Cancellation MUST be supported for import, conversion, and export jobs. Validation and publish MUST NOT be cancellable after their commit point.
7. The error budget for a 99.9 percent monthly target is 43 min 12 s. A fast-burn alert MUST page at 14.4 times burn over 1 h. A slow-burn ticket MUST open at 6 times burn over 6 h. An exhausted error budget MUST freeze non-essential releases until a review.

```text
JobProgress
  job_id, job_type, state, percent_complete, current_step
  processed, total, started_at, updated_at, estimated_remaining_s?
  result_refs[], diagnostic_ids[], cancellable
```

## Retention and Deletion

Retention values below are approved by [D21](decisions.md) and cover classes this tool owns. Workspace-owned classes — project assets and their representations and previews, and the proxied basemap tile cache — are defined in [Workspace Retention](../../workspace/retention.md). A legal or regulatory hold overrides every value in this table, and a value is changed only by a versioned configuration change with an audit record.

| Artifact class | Store | Retention | Deletion rule | Governing item |
| --- | --- | --- | --- | --- |
| Import reports | Object store plus transactional metadata | Life of the referencing revision plus 24 months | Retained while the revision is retained | D21 |
| Validation runs and diagnostics | Transactional relational store | Life of the referencing revision plus 24 months | Append-only; never deleted while the revision is retained | D21 |
| Facility Envelope protobufs | Object store with object lock | Project lifetime plus 7 years | Immutable; deletion only after retention expiry and hold release | D17, D21 |
| Exports and reports | Object store | 90 days, or the export policy lifetime if longer | Deleted on expiry or by an authorized retention action | D21 |
| Job records | Transactional relational store | 90 days | Retained longer when the job produced a retained artifact | D21 |
| Idempotency records | Cache or job store | 7 days | Deleted on expiry | D21 |
| Signed URL grants | Not persisted | Lifetime only | No record retained beyond the URL lifetime | D21 |
| Audit records | Append-only audit store | 7 years | Retained for the full period; no in-place edit | D21 |
| Search and index projections | Index store | Rebuildable; 24 h staleness bound (proposed) | Deleted and rebuilt at will | D15 |

Rules:

1. An object MUST NOT be deleted while a retained revision, asset version, or binding references it.
2. Deletion MUST be logical first and MUST verify references before physical removal. Physical removal occurs after a 30 day grace period unless the class is short-lived (proposed).
3. Every deletion MUST be authorized, recorded as an audit record, and reversible during the grace period.
4. A published Facility Envelope and its referenced entity versions are immutable. A retention action MUST NOT mutate them; it MAY only remove them after the approved period and hold release.
5. A failed import MUST leave its source artifact and diagnostic trail available for audit, and MUST NOT create a publishable envelope.
6. Retention expiry MUST be evaluated per artifact class on a daily schedule, and the resulting deletion plan MUST be reviewable before execution.

## Accessibility and Responsive Behavior

Accessibility requirements apply to the hierarchy, canvas, inspector, findings, and import mapping surfaces defined in [UI Pattern](ui-pattern.md) and the shared [workspace UI Pattern](../../workspace/ui-pattern.md).

| Area | Requirement |
| --- | --- |
| Canvas keyboard reachability | Every canvas entity MUST be reachable from the hierarchy by keyboard, and every canvas command MUST have a keyboard path. Selection, pan, zoom, fit, measure, snapping, and drawing modes MUST be operable without a pointer. |
| Canvas focus | The canvas MUST have an accessible name, an instructions description, and visible focus. Focus MUST NOT be trapped in the canvas, and `Escape` MUST release it. |
| Non-color-only validation | Severity `ERROR`, `WARNING`, and `INFO` and coverage `NOT_PROVIDED`, `PROVISIONAL`, and `VALIDATED` MUST each be rendered with a text or numeric label in addition to color. Map overlays MUST differ by outline, pattern, or icon, not hue alone. |
| Reduced motion | When UI Context `motion` is `REDUCED`, pan, zoom, layer, and panel animations MUST be removed or reduced to an instant state change. Pulsing severity indicators and automatic canvas motion MUST be disabled. |
| Touch | Interactive targets MUST be at least 44 by 44 CSS pixels (proposed). Long press MUST open the context menu. Pan, zoom, and vertex edit MUST work with touch, with an enlarged vertex tolerance. No action may depend on hover. |
| Responsive layout | At 1280 px and above the three-region layout applies. From 768 to 1279 px the inspector MUST collapse to a side sheet. Below 768 px the canvas becomes the single main region and the inspector, findings, and capacity summary become sheets. |
| Toolbar overflow | At narrow widths the active-tool toolbar MUST scroll horizontally or overflow into a menu while keeping Import, Validate, and Publish reachable. |
| Zoom and contrast | The interface MUST remain usable at 200 percent browser zoom and in high-contrast mode (proposed). Text MUST NOT be clipped by density or by a translation string. |

Screen-reader behavior:

| Region | Requirement |
| --- | --- |
| Hierarchy | Expose a tree with level, expanded state, entity kind, name, and validation count. Announce the active function and selection changes. Collapsed branches MUST remain discoverable by keyboard. |
| Canvas | Expose the canvas as a graphic with a concise text summary and provide an equivalent list view of geometry. Announce committed operations, not every pointer movement. A coordinate and measurement readout MUST be available to assistive technology on demand. |
| Inspector | Expose the tab set with correct tab semantics. Every field MUST have a programmatic label. Provenance and effective date MUST be associated with the imported value they describe. A field error MUST be linked to its message and MUST expose its `constraint_id`. |
| Findings | Expose a table or grid with sortable headers and a severity text value. Announce the result count when filters change. Activating a finding MUST move focus to the owning inspector field and announce the destination. |
| Import mapping | Expose mapping rows as a table with source selector, target entity type, review state, and mapped or unmapped count. Announce ambiguous and unresolved required mappings. Announce step progress in the import side sheet. Preview updates MUST be announced politely. |

Rules:

1. Validation state and coverage state MUST be discoverable without color and without opening the bottom drawer.
2. Every icon-only control MUST have an accessible name and a tooltip.
3. A keyboard user MUST be able to complete the import and mapping flow without a pointer.
4. Focus order MUST be predictable across hierarchy, canvas, inspector, and findings, and MUST return to the invoking control when a panel closes.
5. Responsive changes MUST NOT remove access to the primary save, validate, or publish action.

## Localization and Units

| Concern | Requirement |
| --- | --- |
| Storage units | Normalized values MUST be stored in SI base or derived units (W, K, m, m², m³, s, count) per D10. MW, kW, kWh, ft², and similar display units are presentation-only. |
| Display units | A project display-unit profile MAY render SI values as project display units. Rendering MUST be display-only and MUST NOT change the stored value. |
| Basis display | A quantity MUST display its basis, including IT load, facility input, heat rejection, water flow, usable floor area, or `NETWORK_ENTRY_COUNT`. Power units MUST NOT be used for network-entry capacity. |
| Number formatting | Display MUST use locale-aware grouping and decimal separators. Input MAY accept a locale decimal separator and MUST store the SI value. |
| Date and time | Storage and API values MUST be RFC 3339 UTC. Display MUST be locale-aware and MUST name the time zone. Phase dates MUST display their declared precision. |
| Tolerance display | Length, area, and fitted-transform residual tolerances MUST follow D9 defaults (0.01 m, 0.01 m², 0.05 m) unless a project policy overrides them. |
| Locale-aware labels | Enum and field labels MUST come from a message catalog. `constraint_id`, enum values, entity types, geometry roles, and basis identifiers MUST NOT be localized. Missing translations MUST fall back to `en`. |
| Label expansion | Layout MUST tolerate at least 30 percent expansion over the English string without clipping (proposed). |
| Stable sorting | Sorting and collation MUST use stable keys and MUST NOT depend on a localized label. |

Rules:

1. Localized text MUST NOT change a stored value, a constraint identifier, a geometry, or a revision.
2. A locale change MUST NOT alter validation results, capability coverage, or the meaning of a published envelope.
3. A displayed unit MUST always be explicit. A bare number MUST NOT be presented where the unit or basis is ambiguous.
4. A round trip from SI to display units and back MUST preserve the stored value within the declared tolerance.

## Capacity Planning and Growth

| Concern | Requirement |
| --- | --- |
| Limit monitoring | Every scale limit MUST emit a current and maximum utilization gauge per project and per revision. |
| Review thresholds | 70 percent is informational, 85 percent is a warning, and 95 percent is an alert (proposed). |
| Review triggers | Any limit at 85 percent for 7 consecutive days, any limit at 95 percent, a projected 100 percent within 90 days, or sustained growth above 2 percent per day for 14 days MUST trigger a capacity review. |
| Review output | The review MUST update the limit, the quota, the partitioning scheme, or the archive policy, and MUST be recorded as a decision. |
| Backpressure | A command that would exceed a hard limit MUST be rejected with a structured `4xx` error naming the limit, the current value, and the remediation. Import sessions MUST be rejected before any bytes are accepted. |
| Object store partitioning | Objects MUST be partitioned by project and date. Lifecycle rules SHOULD move asset versions not referenced by a current draft to a lower-cost tier after 12 months (proposed). |
| Archive restore | Archived objects MUST be restorable within 24 h (proposed) and MUST retain their checksum and metadata. |
| Partitioning | The tenant-key discipline and the partitioned artifact classes MUST follow [D22](decisions.md): `project_id` is part of every key and reference, and the append-only classes are time-partitioned so retention is a partition operation. Spatial indexes MUST be partitioned with their table. A published envelope MUST be indexed read-only, and superseded revision partitions MUST be detachable and rebuildable. |
| Disposable projections | Search, tile, and cache projections MUST be rebuildable from authoritative revisions and MUST NOT be the sole copy of any retained artifact. |
| Scale test | A load test at the revision scale limits MUST be run before each major release and MUST verify the published latency and job budgets (proposed). |

Rules:

1. A capacity review MUST be completed before a project is allowed to grow past 95 percent of any hard limit.
2. A limit increase MUST be a versioned configuration change with an audit record.
3. Archiving MUST NOT break a retained revision reference. An archived object remains addressable and restorable.

## Open Items

| Item | Governing item | Interim default | Action needed |
| --- | --- | --- | --- |
| Relational store and spatial extension selection | D15 | PostgreSQL 16 with PostGIS is the reference implementation | Confirm the selected product provides every required capability in [Storage Shape](storage-shape.md) before tables are created; confirm the latency, RPO, and partitioning targets in this document |
| Basemap provider contracts and tile licensing | D16 | Google Map Tiles API plus a commercial OSM provider or self-hosted tiles, with a plan-only fallback | Confirm provider contracts, permitted cache lifetime, attribution text, and quota model before enabling the basemap in production |
| `PUBLISHED` state and envelope retention | D17, D21 | `VALIDATED` to `PUBLISHED` is one-way; published envelopes are object-locked for the D21 retention period (project lifetime plus 7 years) | Confirm that no unpublish path is required before enabling publication |
| Cost, schedule, and sustainability references | D18 | Reference-only; values owned by the Cost, Schedule, and Sustainability workspace | Confirm that no requirement applies beyond export redaction and reference integrity |
| IFC and BIM import support | D19 | IFC2X3, IFC4, and IFC4X3 supported in R1 through a registered sandboxed adapter | Confirm IFC model-size limits, tessellation tolerance, and adapter tooling before freezing the import budgets |
| Object-store and spatial partitioning scheme | D15, D21, D22 | `project_id` is part of every key and reference; `outbox_events` and `import_features` are time-partitioned; `facility_diagnostics` stays unpartitioned because its self-reference cannot survive time partitioning; graph tables are unpartitioned in the first release | Approve the archive tier, the archive restore target, and the partition create and detach automation before the first production load |

## Acceptance Criteria

1. A command that would exceed a published scale limit is rejected with a structured error naming the limit, the current value, and the limit value, and no partial write occurs.
2. The `GET` Facility Envelope read meets p95 <= 400 ms and p99 <= 1,200 ms at 50 percent of the revision scale limits under the declared scale test.
3. Import, conversion, import apply, full validation, publish, and export run as jobs and never hold an HTTP request open for completion.
4. A draft mutation without `If-Match` or with a stale `base_revision_id` is rejected with `409` and `constraint_id` `facility.revision.current`.
5. A duplicate command with the same `Idempotency-Key` and the same body returns the original result, and a duplicate with a different body is rejected without execution.
6. The outbox delivers every committed event at least once, in aggregate order, with dead-letter and replay support.
7. Object versioning is enabled, published envelopes are protected by object lock, and a quarterly full restore and a monthly partial restore are performed and recorded.
8. Every uploaded asset version is malware-scanned before conversion or preview, and a failed scan quarantines the object.
9. Converter licence secrets are read from a secret manager and appear in no database row, log, trace, object metadata, or error message.
10. Every authorization decision is enforced at the API gateway, the handler, and the database row policy, and denies by default.
11. Every request carries a correlation ID, traces propagate through workers and outbox consumers, and per-job progress is reported at least every 5 s or every 1,000 processed features.
12. Validation state and capability coverage are rendered with text or numeric labels in addition to color.
13. The hierarchy, canvas, inspector, findings, and import mapping controls are keyboard reachable, and the import and mapping flow is completable without a pointer.
14. A locale or display-unit change does not alter any stored value, constraint identifier, geometry, or published envelope.
15. No object is deleted while a retained revision or asset version references it, and every deletion is authorized and audited.
16. Limit utilization is monitored, and reaching 85 percent for 7 days, 95 percent, or a projected 100 percent within 90 days triggers a recorded capacity review.
17. A failed scale or restore test blocks release until the failure is resolved.
