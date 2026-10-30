# Rack Planner Storage Shape

## Storage Responsibilities

PostgreSQL/PostGIS holds saved Rack aggregates and fixed source references. Browser state holds the unsaved shared draft. Candidates are request-local. Personal model connections use an external encrypted file adapter. Project asset bytes remain owned by the shared asset subsystem; Rack defines no new plan object-store layout.

Schema comes from immutable migrations 007–011. Existing databases use migrations, not reset/reseed of edited examples.

## Transactional Store

| Table | Key / fields | Responsibility |
| --- | --- | --- |
| rack_plans | `(plan_id,project_id)`; source IDs/token, name, version, lifecycle, creation/update/deletion metadata, JSONB equipment/constraints | Aggregate root and concurrency lock |
| rack_room_snapshots | `(plan_id,project_id)`; unique snapshot/project; document | Captured room/view/source, not a live geometry cache |
| rack_placements | `(rack_id,plan_id,project_id)`; model FK, position, rotation, name, lock | Placement membership |
| rack_models | model_id PK; definition JSONB | Server-owned assumed models |
| rack_layout_commands | `(project_id,plan_id,command_key)`; request hash, applied version, actor/time | Capture/save/lifecycle retry identity |

Devices, rack limits and room budgets live in equipment JSONB; exclusion rectangles/clearance live in spatial_constraints. Equipment catalog versions are read-only code data. There are no candidate-history, aisle-graph, Rack Validation Run or publication tables.

### Geometry and CRS

Facility owns authoritative geometry. The snapshot stores local Polygon/holes, origin, CRS, source references and Facility input. Placement coordinates use that frame. PostGIS checks topology; a room extent, SVG or browser box cannot replace it.

### Keys, Indexes and Isolation

Composite foreign keys prevent foreign-project attachment. Unique `(project_id,creation_key)` prevents duplicate creation. Source/placement indexes and the active-plan list index support current reads. Cursor ordering uses created_at plus plan_id under identical filters.

Tenant tables enable/force RLS with transaction-local app.project_id, using the shared tenant transaction helper. Service callers still authorize separately. Local initialization accounts may bypass ordinary production protections; restricted application roles and RLS require deployment-specific verification. Shared models are server-owned data.

## Write and Recovery Flow

### Create and Capture

Creation validates scope/HALL/source token and serializes a project's creation key with an advisory transaction lock. Supported geometry can be captured during creation; an explicit snapshot route handles an uncaptured plan. Capture fixes input once and does not refresh an existing document in place.

### Atomic Save

1. Authorize and validate body/headers.
2. Lock the plan, check retry record and compare Rack version.
3. Hold shared locks on Facility token/lifecycle and re-read freshness.
4. Match snapshot, normalize placements/constraints/equipment and enforce saved locks.
5. Check real Polygon topology, U occupancy and known resource conflicts.
6. Replace placements and update JSONB aggregate members together.
7. Advance version, record actor/time and command hash/applied version, return saved state.

Any failure rolls back all members. An exact retry returns the current representation plus original applied-version metadata; a reused key with different content conflicts. Incomplete assumptions may save if there is no actual blocking diagnostic. Rename/delete/restore share the plan lock/version, preventing stale layout overwrite.

### Compatibility and Cache

Omitted constraints/equipment preserve saved values. Equipment supplied without roomBudget preserves the saved budget; explicit null clears it. Unknown fields are rejected. Current Rack API/client handling uses no-store behavior to avoid stale deleted-layout responses after restore. Browser drafts and temporary IDs are not durable recovery records.

## Personal Assistant Connection Storage

The first adapter stores one default connection per authenticated user outside the repository in OS user-data directories. Metadata/encrypted credential data and master key are separated. Public responses omit plaintext keys and internal secret references.

AES-256-GCM binds ciphertext to owner/connection/version. Immutable ciphertext precedes atomic metadata replacement; failed writes clean temporary files. Writes serialize within one API process. Rotation/deletion revokes active requests. Missing/corrupt master keys cannot silently replace keys protecting existing ciphertext.

Unix requests 0700/0600; Windows relies on the runtime account ACL. This is not cloud KMS or multi-instance distributed locking. Both directories need backup and persistent container mounts. An attacker controlling the API/OS account can still access credentials. See [Assistant Integration](assistant-integration.md).

## Durability and Retention

No hard-delete/retention job exists. Deleted plans, snapshots and command records remain until a reviewed policy is implemented. Ordinary shutdown retains database/object-store volumes. Reset is destructive and not daily startup.

RPO/RTO, backup restore drills, multi-instance connection metadata and retention need operational acceptance. Command metadata is not an event-sourced history of every layout. The separately authorized local English-label maintenance has a Git-ignored backup and version guards; it is not the regular UI write path.

## Acceptance Criteria

Failed writes preserve aggregate/version. Parallel matching-version saves permit one winner. Retries do not duplicate objects/versions. Delete/restore preserve content. API restart preserves plans and saved connections, not unsaved drafts/candidates. No credential material reaches Git, logs or public responses.
