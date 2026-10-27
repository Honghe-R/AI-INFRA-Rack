-- ============================================================================
--  001_facility_schema.sql
--  Site and Facility Editor -- initial migration (schema version 001).
--
--  Implements:
--    * Decision D15 -- the PostgreSQL 16 + PostGIS transactional relational store
--      (doc/tools/site-and-facility/storage-shape.md).
--    * The canonical Site and Facility Editor entity model
--      (doc/tools/site-and-facility/entity-model.md), including the
--      "Persistence Models" table list, identities, and reference fields.
--    * The canonical enumerations of the interchange contract
--      (doc/tools/site-and-facility/interchange-contract.md). No enumeration
--      value is invented here; every canonical value set is copied verbatim.
--
--  This file is the INITIAL migration: it creates the complete schema from
--  scratch in one runnable script. There is no prior schema and no data
--  migration. It is written for PostgreSQL 16 with PostGIS 3.x and uses only
--  syntax valid on that target.
--
--  Shape of the file:
--    1. Extensions.
--    2. Enum types (canonical enumerations, plus small enums for shapes that
--       the interchange contract does not enumerate).
--    3. Tables, one per entity-model persistence model, plus map_tile_usage.
--    4. Secondary indexes (including GiST spatial indexes).
--    5. Deferred foreign keys (forward references that cannot be declared
--       inline because of table creation order).
--    6. Row-level security: a catalog-driven DO block that enables RLS and
--       installs a project-isolation policy on every table carrying project_id.
--
--  Tenant-key discipline: every primary key and every unique constraint in
--  this schema carries project_id, and every foreign key carries project_id on
--  both sides. A reference therefore cannot cross a project boundary even when
--  application code supplies a foreign identifier, and the database enforces
--  project isolation independently of row-level security. Where the entity
--  model fixes a natural identity (for example geometry_records on
--  (entity_id, entity_type, revision_id, role, ordinal)), project_id is
--  appended to that identity; it never replaces it. The one exception is
--  projects itself, whose primary key already is project_id.
--
--  Partitioning guidance (doc/tools/site-and-facility/storage-shape.md,
--  "Partitioning and Growth"): the append-only high-volume tables are
--  time-partitioned by RANGE on created_at. outbox_events and import_features
--  are partitioned monthly (three months in the past through six months in the
--  future, plus a DEFAULT partition) because their rows are append-only, grow
--  with every publish and every import, and are read, archived, and dropped by
--  age rather than by identity. facility_diagnostics was the third
--  storage-shape candidate and is deliberately left unpartitioned: its
--  supersedes_diagnostic_id column is a foreign key back to
--  facility_diagnostics, PostgreSQL requires a foreign key that targets a
--  partitioned table to reference the whole partition key, and the superseded
--  diagnostic is normally older than the created_at of the row that supersedes
--  it, so the model's self-reference cannot be expressed on a partitioned
--  table. Graph tables (facility_envelopes, entity_registry, design_scopes,
--  facility_containers, geometry_records, and the utility, capacity, phase,
--  verification, and governance tables) remain ordinary unpartitioned tables
--  in this initial migration: they are read by revision, entity, and envelope,
--  not by age, and partitioning them would either force the partition key into
--  every identity or break the foreign keys that keep one revision's graph
--  consistent.
--
--  Horizontal growth beyond a single primary is by hash partitioning on
--  project_id or by Citus-style sharding with project_id as the distribution
--  column, which keeps one project's rows co-located so that every join and
--  every foreign key stays local to one shard. A list partition per project is
--  rejected: the deployment holds thousands of projects, and thousands of
--  partitions would bloat the planner's partition metadata, make DDL and
--  autovacuum unmanageable, and gain nothing over hashing.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extensions
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 2. Enum types
--
-- Canonical enumerations (interchange contract, "Canonical Enumerations").
-- Type names are snake_case renderings of the documented enum names; the
-- documented name is given in the comment above each type. Values are exact.
-- ----------------------------------------------------------------------------

-- LifecycleState
CREATE TYPE lifecycle_state AS ENUM (
  'DRAFT', 'VALIDATED', 'PUBLISHED'
);

-- CapabilityStatus
CREATE TYPE capability_status AS ENUM (
  'NOT_PROVIDED', 'PROVISIONAL', 'VALIDATED'
);

-- Capability
CREATE TYPE capability AS ENUM (
  'GEOMETRY', 'POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY',
  'ENVIRONMENT', 'PHASING'
);

-- EntityType. SPATIAL_CONSTRAINT is the canonical value for a spatial
-- constraint entity; the non-canonical value CONSTRAINT is not used anywhere.
CREATE TYPE entity_type AS ENUM (
  'SITE', 'PARCEL', 'BUILDING', 'FLOOR', 'HALL', 'SUPPORT_SPACE',
  'EQUIPMENT_YARD', 'RESERVED_AREA', 'UTILITY_SOURCE', 'UTILITY_INTERFACE',
  'UTILITY_ROUTE', 'SPATIAL_CONSTRAINT', 'ENVIRONMENTAL_PROFILE',
  'ENVIRONMENTAL_CONSTRAINT', 'FACILITY_PHASE', 'FAILURE_DOMAIN',
  'RESILIENCE_REQUIREMENT', 'FUEL_STORAGE', 'WATER_STORAGE',
  'CAPACITY_BUDGET', 'ASSUMPTION', 'WAIVER', 'DOCUMENT'
);

-- GeometryRole
CREATE TYPE geometry_role AS ENUM (
  'BOUNDARY', 'FOOTPRINT', 'FLOOR_BOUNDARY', 'ROOM_BOUNDARY', 'ROUTE',
  'CONNECTION_POINT', 'CONSTRAINT_AREA', 'REFERENCE_POINT'
);

-- GeometryType
CREATE TYPE geometry_type AS ENUM (
  'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOLYGON'
);

-- ScopeKind
CREATE TYPE scope_kind AS ENUM (
  'CAMPUS', 'SITE', 'PARCEL', 'BUILDING', 'BUILDING_LOCAL'
);

-- ContainerKind
CREATE TYPE container_kind AS ENUM (
  'PARCEL', 'BUILDING', 'FLOOR', 'HALL', 'SUPPORT_SPACE', 'EQUIPMENT_YARD',
  'RESERVED_AREA'
);

-- ConstraintKind
CREATE TYPE constraint_kind AS ENUM (
  'SETBACK', 'EASEMENT', 'ACCESS_ROUTE', 'HEIGHT_LIMIT', 'HAZARD_ZONE',
  'EXCLUSION_ZONE', 'REGULATORY_LIMIT'
);

-- ResourceKind
CREATE TYPE resource_kind AS ENUM (
  'POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY'
);

-- CapacityBasis
CREATE TYPE capacity_basis AS ENUM (
  'IT_LOAD', 'FACILITY_INPUT', 'HEAT_REJECTION', 'WATER_FLOW',
  'USABLE_FLOOR_AREA', 'NETWORK_ENTRY_COUNT', 'FUEL_VOLUME',
  'AUTONOMY_DURATION'
);

-- QuantityState
CREATE TYPE quantity_state AS ENUM (
  'MEASURED', 'CONTRACTUAL', 'FIRM', 'PLANNED', 'COMMISSIONED', 'ASSUMED'
);

-- SupplyState -- the subset of QuantityState valid for a utility capacity claim.
CREATE TYPE supply_state AS ENUM (
  'CONTRACTUAL', 'FIRM', 'PLANNED', 'COMMISSIONED'
);

-- ServiceState
CREATE TYPE service_state AS ENUM (
  'AVAILABLE', 'PLANNED', 'SUSPENDED', 'RETIRED'
);

-- AllocationState
CREATE TYPE allocation_state AS ENUM (
  'PROVISIONAL', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'REVOKED'
);

-- Priority
CREATE TYPE priority AS ENUM (
  'RESERVED', 'CRITICAL', 'HIGH', 'NORMAL', 'LOW'
);

-- ConsumerType
CREATE TYPE consumer_type AS ENUM (
  'FLOORPLAN', 'RACK', 'POWER', 'THERMAL', 'NETWORK', 'CABLING', 'VERIFY',
  'SIMULATION', 'COST_SCHEDULE', 'DEPLOYMENT'
);

-- PhaseStatus
CREATE TYPE phase_status AS ENUM (
  'PLANNED', 'UNDER_CONSTRUCTION', 'COMMISSIONING', 'AVAILABLE', 'RETIRED'
);

-- AvailabilityPolicy
CREATE TYPE availability_policy AS ENUM (
  'N', 'N_PLUS_1', 'TWO_N', 'TWO_N_PLUS_1', 'N_PLUS_2'
);

-- ReviewState
CREATE TYPE review_state AS ENUM (
  'UNREVIEWED', 'IN_REVIEW', 'REVIEWED', 'REJECTED'
);

-- TransformMethod
CREATE TYPE transform_method AS ENUM (
  'DECLARED_CRS', 'CONTROL_POINTS_HELMERT', 'CONTROL_POINTS_AFFINE',
  'FITTED_RESIDUAL', 'MANUAL'
);

-- DiagnosticStatus
CREATE TYPE diagnostic_status AS ENUM (
  'OPEN', 'ACKNOWLEDGED', 'WAIVED', 'RESOLVED', 'SUPERSEDED'
);

-- Severity
CREATE TYPE severity AS ENUM (
  'ERROR', 'WARNING', 'INFO'
);

-- RemediationCategory
CREATE TYPE remediation_category AS ENUM (
  'ADD_DATA', 'CORRECT_GEOMETRY', 'RESOLVE_CONFLICT', 'UPDATE_CAPACITY',
  'ADJUST_PHASE', 'OBTAIN_APPROVAL', 'REVIEW_IMPORT', 'RECONFIGURE_RESILIENCE',
  'CONTACT_RESPONSIBLE_PARTY', 'REVIEW_POLICY'
);

-- ApprovalDecision
CREATE TYPE approval_decision AS ENUM (
  'APPROVED', 'REJECTED', 'REVOKED'
);

-- ApprovalState
CREATE TYPE approval_state AS ENUM (
  'NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED', 'REVOKED'
);

-- EntityStatus
CREATE TYPE entity_status AS ENUM (
  'IMPORTED_REFERENCE', 'PROVISIONAL', 'VALIDATED', 'SUPERSEDED'
);

-- DocumentKind
CREATE TYPE document_kind AS ENUM (
  'CAD_DRAWING', 'GIS_DATASET', 'KML', 'BIM_MODEL', 'VENDOR_STUDY', 'PERMIT',
  'SURVEY', 'CONTACT_RECORD', 'OTHER'
);

-- CostScheduleKind
CREATE TYPE cost_schedule_kind AS ENUM (
  'COST', 'SCHEDULE', 'SUSTAINABILITY'
);

-- ----------------------------------------------------------------------------
-- 2b. Small enums for shapes the interchange contract does not enumerate.
-- These value sets are implied by the entity-model shapes; the interchange
-- contract names no canonical enum for them.
-- ----------------------------------------------------------------------------

-- ImportFeature.status (entity-model: REFERENCE_ONLY | MAPPED | UNSUPPORTED)
CREATE TYPE import_feature_status AS ENUM (
  'REFERENCE_ONLY', 'MAPPED', 'UNSUPPORTED'
);

-- Assumption.status (entity-model: OPEN | RESOLVED | SUPERSEDED)
CREATE TYPE assumption_status AS ENUM (
  'OPEN', 'RESOLVED', 'SUPERSEDED'
);

-- ValidationRun.scope (entity-model: FULL | AFFECTED_SUBGRAPH)
CREATE TYPE validation_scope AS ENUM (
  'FULL', 'AFFECTED_SUBGRAPH'
);

-- ValidationRun execution status (not enumerated in the documents).
CREATE TYPE validation_run_status AS ENUM (
  'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'
);

-- Asynchronous job state (entity-model jobs model; not enumerated in the docs).
CREATE TYPE job_state AS ENUM (
  'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);

-- Provenance.confidence (entity-model Common Value Shapes: HIGH | MEDIUM | LOW)
CREATE TYPE confidence AS ENUM (
  'HIGH', 'MEDIUM', 'LOW'
);

-- StorageReserve.kind (entity-model Utilities table: FUEL | WATER)
CREATE TYPE storage_reserve_kind AS ENUM (
  'FUEL', 'WATER'
);

-- Waiver lifecycle status (entity-model Waiver has a status; not enumerated).
CREATE TYPE waiver_status AS ENUM (
  'GRANTED', 'EXPIRED', 'REVOKED'
);

-- ============================================================================
-- 3. Tables
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 3.1 Project and Revision Context
-- ----------------------------------------------------------------------------

-- Model: projects. Tenant-scoped container for scenarios and revisions.
CREATE TABLE projects (
  project_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  name             text NOT NULL,
  description      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz,
  updated_by       uuid
);

-- Model: scenarios. One project has many scenarios; each scenario has an
-- independent draft lineage. scenarios is one of the two tables that does not
-- carry a separate project_id identifier column: project_id is a foreign key,
-- scenario_id is the natural identifier.
CREATE TABLE scenarios (
  scenario_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz,
  updated_by   uuid,
  -- The primary key carries the tenant key, so every child table enforces
  -- tenant consistency with a composite foreign key instead of
  -- application-only validation.
  PRIMARY KEY (scenario_id, project_id)
);

-- Model: revisions. One scenario has many revisions. DRAFT is mutable under an
-- ETag; VALIDATED and PUBLISHED are immutable and PUBLISHED is a one-way
-- transition from VALIDATED.
CREATE TABLE revisions (
  revision_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  scenario_id       uuid NOT NULL,
  base_revision_id  uuid,
  lifecycle_state   lifecycle_state NOT NULL DEFAULT 'DRAFT',
  name              text,
  content_checksum  text,
  published_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  PRIMARY KEY (revision_id, project_id),
  -- Branch ancestry stays inside one project: a base revision can never come
  -- from another tenant.
  CONSTRAINT revisions_base_revision_fk
    FOREIGN KEY (base_revision_id, project_id)
    REFERENCES revisions (revision_id, project_id),
  CONSTRAINT revisions_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  -- Redundant key that lets child tables enforce project/scenario consistency.
  CONSTRAINT revisions_tenant_key UNIQUE (revision_id, project_id, scenario_id),
  CONSTRAINT revisions_published_at_check
    CHECK (lifecycle_state <> 'PUBLISHED' OR published_at IS NOT NULL),
  CONSTRAINT revisions_immutable_checksum_check
    CHECK (lifecycle_state = 'DRAFT' OR content_checksum IS NOT NULL),
  CONSTRAINT revisions_no_self_base_check
    CHECK (base_revision_id IS NULL OR base_revision_id <> revision_id)
);

-- Model: revision_lineage. Branch ancestry and publication boundaries.
-- Identity: (revision_id, parent_revision_id).
CREATE TABLE revision_lineage (
  revision_id        uuid NOT NULL,
  parent_revision_id uuid NOT NULL,
  project_id         uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  scenario_id        uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  PRIMARY KEY (revision_id, parent_revision_id, project_id),
  -- Both endpoints of an ancestry edge must live in the same project.
  CONSTRAINT revision_lineage_revision_fk
    FOREIGN KEY (revision_id, project_id)
    REFERENCES revisions (revision_id, project_id) ON DELETE CASCADE,
  CONSTRAINT revision_lineage_parent_revision_fk
    FOREIGN KEY (parent_revision_id, project_id)
    REFERENCES revisions (revision_id, project_id) ON DELETE CASCADE,
  CONSTRAINT revision_lineage_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT revision_lineage_no_self_check
    CHECK (revision_id <> parent_revision_id)
);

-- Model: revision_etags. Current draft ETag and optimistic-concurrency version.
-- Identity: revision_id (one row per revision).
CREATE TABLE revision_etags (
  revision_id  uuid NOT NULL,
  project_id   uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  scenario_id  uuid NOT NULL,
  etag         uuid NOT NULL DEFAULT gen_random_uuid(),
  etag_version bigint NOT NULL DEFAULT 0 CHECK (etag_version >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  PRIMARY KEY (revision_id, project_id),
  -- The ETag row belongs to exactly one revision, and that revision cannot
  -- cross projects.
  CONSTRAINT revision_etags_revision_fk
    FOREIGN KEY (revision_id, project_id)
    REFERENCES revisions (revision_id, project_id) ON DELETE CASCADE,
  CONSTRAINT revision_etags_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id)
);

-- Model: outbox_events. Transactional outbox for published domain events.
-- payload is a free-form event payload and is correctly jsonb.
CREATE TABLE outbox_events (
  event_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL,
  scenario_id     uuid NOT NULL,
  revision_id     uuid,
  event_type      text NOT NULL,
  aggregate_type  text,
  aggregate_id    uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id  uuid,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  -- The primary key carries both the partition key (created_at) and the tenant
  -- key (project_id), as PostgreSQL requires of every unique key on a
  -- partitioned table.
  PRIMARY KEY (event_id, project_id, created_at),
  CONSTRAINT outbox_events_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT outbox_events_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id)
)
PARTITION BY RANGE (created_at);

-- Model: idempotency_records. Stores the original command result for
-- duplicate-safe retries. Identity: (scope, idempotency_key).
CREATE TABLE idempotency_records (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  scenario_id      uuid NOT NULL,
  scope            text NOT NULL,
  idempotency_key  text NOT NULL,
  request_hash     text,
  response_status  integer,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  expires_at       timestamptz,
  CONSTRAINT idempotency_records_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  -- The identity is tenant-scoped: the same command key used in two projects
  -- is two different records.
  PRIMARY KEY (id, project_id),
  CONSTRAINT idempotency_records_scope_key
    UNIQUE (scope, idempotency_key, project_id)
);

-- Model: jobs. Asynchronous asset processing, binding, validation, publish, and
-- export job state. The binding_id foreign key is declared in the deferred
-- foreign-key section because asset_bindings is created later.
CREATE TABLE jobs (
  job_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL,
  scenario_id   uuid NOT NULL,
  revision_id   uuid,
  binding_id    uuid,
  job_type      text NOT NULL,
  state         job_state NOT NULL DEFAULT 'QUEUED',
  progress_pct  integer NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  requested_by  uuid,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  result        jsonb,
  error_message text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz,
  updated_by    uuid,
  PRIMARY KEY (job_id, project_id),
  CONSTRAINT jobs_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT jobs_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT jobs_completion_check
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

-- ----------------------------------------------------------------------------
-- 3.2 Facility Graph
-- ----------------------------------------------------------------------------

-- Model: facility_envelopes. One revision has at most one Facility Envelope;
-- the envelope is the immutable handoff root. Identity is envelope_id, with the
-- storage-shape uniqueness rule (project_id, scenario_id, revision_id).
-- The model also requires at least one pinned asset version; that is a
-- child-row cardinality rule and cannot be expressed as a table CHECK.
CREATE TABLE facility_envelopes (
  envelope_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL,
  scenario_id       uuid NOT NULL,
  revision_id       uuid NOT NULL,
  lifecycle_state   lifecycle_state NOT NULL DEFAULT 'DRAFT',
  approval_state    approval_state NOT NULL DEFAULT 'NOT_REQUIRED',
  content_checksum  text,
  published_at      timestamptz,
  validation_run_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  PRIMARY KEY (envelope_id, project_id),
  CONSTRAINT facility_envelopes_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT facility_envelopes_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT facility_envelopes_identity_key
    UNIQUE (project_id, scenario_id, revision_id),
  -- Redundant key that lets child tables enforce envelope tenant consistency.
  CONSTRAINT facility_envelopes_tenant_key
    UNIQUE (envelope_id, project_id, scenario_id),
  CONSTRAINT facility_envelopes_revision_unique UNIQUE (revision_id, project_id),
  CONSTRAINT facility_envelopes_published_check
    CHECK (lifecycle_state <> 'PUBLISHED' OR published_at IS NOT NULL),
  CONSTRAINT facility_envelopes_checksum_check
    CHECK (lifecycle_state = 'DRAFT' OR content_checksum IS NOT NULL)
);

-- Model: entity_registry. Registry of stable entity IDs that permits
-- cross-entity references, including geometry ownership, without exposing
-- polymorphic rows directly. Identity: (entity_id, revision_id).
--
-- POLYMORPHIC REFERENCE: entity_registry is the resolution point for the
-- polymorphic (entity_id, entity_type) pairs used by geometry_records and other
-- entity references. The declared foreign key is on (entity_id, revision_id);
-- an additional unique key on (entity_id, entity_type, revision_id) lets
-- referencing tables also pin entity_type, so a geometry record cannot claim a
-- type that disagrees with the registry row.
CREATE TABLE entity_registry (
  entity_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  revision_id  uuid NOT NULL,
  project_id   uuid NOT NULL,
  scenario_id  uuid NOT NULL,
  entity_type  entity_type NOT NULL,
  status       entity_status NOT NULL DEFAULT 'PROVISIONAL',
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz,
  updated_by   uuid,
  PRIMARY KEY (entity_id, revision_id, project_id),
  CONSTRAINT entity_registry_typed_key
    UNIQUE (entity_id, entity_type, revision_id, project_id),
  CONSTRAINT entity_registry_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT entity_registry_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id)
);

-- Model: design_scopes. One envelope has one or more scopes, including the SITE
-- entity. A scope may nest in one parent scope and owns linked geometry.
CREATE TABLE design_scopes (
  scope_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL,
  scenario_id     uuid NOT NULL,
  revision_id     uuid NOT NULL,
  envelope_id     uuid NOT NULL,
  parent_scope_id uuid,
  entity_type     entity_type NOT NULL DEFAULT 'SITE',
  scope_kind      scope_kind NOT NULL,
  name            text NOT NULL,
  jurisdiction    text,
  provenance      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz,
  updated_by      uuid,
  PRIMARY KEY (scope_id, project_id),
  -- A scope is itself a registered entity (entity type SITE).
  CONSTRAINT design_scopes_entity_fk
    FOREIGN KEY (scope_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  CONSTRAINT design_scopes_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT design_scopes_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT design_scopes_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT design_scopes_site_type_check
    CHECK (entity_type = 'SITE'),
  CONSTRAINT design_scopes_no_self_parent_check
    CHECK (parent_scope_id IS NULL OR parent_scope_id <> scope_id),
  -- Redundant key that lets child tables enforce scope/revision consistency.
  CONSTRAINT design_scopes_revision_key UNIQUE (scope_id, revision_id, project_id)
);

-- Model: facility_containers. One scope has many containers; a container has
-- zero or one parent, many children, and linked geometry. The site itself is a
-- design scope, not a container. The (parent_container_id, level_number)
-- partial unique index below enforces "level_number is unique within a
-- building". The phase_id foreign key is deferred because facility_phases is
-- created later in this script.
CREATE TABLE facility_containers (
  container_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL,
  scenario_id         uuid NOT NULL,
  revision_id         uuid NOT NULL,
  envelope_id         uuid NOT NULL,
  scope_id            uuid NOT NULL,
  parent_container_id uuid,
  phase_id            uuid,
  kind                container_kind NOT NULL,
  entity_type         entity_type NOT NULL,
  name                text NOT NULL,
  level_number        integer,
  status              entity_status NOT NULL DEFAULT 'PROVISIONAL',
  elevation_base_m    numeric,
  elevation_top_m     numeric,
  provenance          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz,
  updated_by          uuid,
  PRIMARY KEY (container_id, project_id),
  -- A container is itself a registered entity.
  CONSTRAINT facility_containers_entity_fk
    FOREIGN KEY (container_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  -- A container's parent stays inside the same project; the scope reference
  -- below still pins the owning revision.
  CONSTRAINT facility_containers_parent_fk
    FOREIGN KEY (parent_container_id, project_id)
    REFERENCES facility_containers (container_id, project_id),
  CONSTRAINT facility_containers_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT facility_containers_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT facility_containers_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT facility_containers_scope_fk
    FOREIGN KEY (scope_id, revision_id, project_id)
    REFERENCES design_scopes (scope_id, revision_id, project_id),
  CONSTRAINT facility_containers_no_self_parent_check
    CHECK (parent_container_id IS NULL OR parent_container_id <> container_id),
  -- ContainerKind maps one-to-one onto its EntityType value.
  CONSTRAINT facility_containers_kind_type_check
    CHECK (
      (kind = 'PARCEL'         AND entity_type = 'PARCEL') OR
      (kind = 'BUILDING'       AND entity_type = 'BUILDING') OR
      (kind = 'FLOOR'          AND entity_type = 'FLOOR') OR
      (kind = 'HALL'           AND entity_type = 'HALL') OR
      (kind = 'SUPPORT_SPACE'  AND entity_type = 'SUPPORT_SPACE') OR
      (kind = 'EQUIPMENT_YARD' AND entity_type = 'EQUIPMENT_YARD') OR
      (kind = 'RESERVED_AREA'  AND entity_type = 'RESERVED_AREA')
    ),
  -- Only FLOOR and HALL carry a level_number.
  CONSTRAINT facility_containers_level_number_check
    CHECK (
      (kind IN ('FLOOR', 'HALL') AND level_number IS NOT NULL) OR
      (kind NOT IN ('FLOOR', 'HALL') AND level_number IS NULL)
    ),
  CONSTRAINT facility_containers_elevation_check
    CHECK (
      elevation_top_m IS NULL OR elevation_base_m IS NULL
      OR elevation_top_m >= elevation_base_m
    ),
  -- Redundant key that lets spatial_constraints enforce container/revision
  -- consistency.
  CONSTRAINT facility_containers_revision_key UNIQUE (container_id, revision_id, project_id)
);

-- A scope may nest in one parent scope; the composite key is declared on
-- design_scopes for revision consistency.
ALTER TABLE design_scopes
  ADD CONSTRAINT design_scopes_parent_scope_fk
  FOREIGN KEY (parent_scope_id, revision_id, project_id)
  REFERENCES design_scopes (scope_id, revision_id, project_id);

-- Model: geometry_records. A first-class, revisioned spatial record linked to
-- exactly one domain entity by stable entity_id and entity_type. Native PostGIS
-- columns only: geojson_4326 carries SRID 4326 (interchange representation) and
-- projected_geometry carries the authoritative projected representation used for
-- measurement. Both are GiST-indexed below.
--
-- Required-role presence (for example a BUILDING must have a FOOTPRINT) is a
-- cross-row rule and cannot be expressed as a table CHECK; it is enforced by
-- validation (facility.data.geometry.role_missing). The role/type mismatch rule
-- is expressible per row and is enforced by the two checks below.
-- parent_transform_id, asset_version_id, and binding_id forward-reference
-- tables created later, so those foreign keys are deferred.
CREATE TABLE geometry_records (
  geometry_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL,
  scenario_id          uuid NOT NULL,
  revision_id          uuid NOT NULL,
  entity_id            uuid NOT NULL,
  entity_type          entity_type NOT NULL,
  role                 geometry_role NOT NULL,
  ordinal              integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  geometry_type        geometry_type NOT NULL,
  geojson_4326         geometry(Geometry, 4326) NOT NULL,
  projected_geometry   geometry(Geometry) NOT NULL,
  projected_crs        text NOT NULL,
  vertical_crs         text,
  parent_transform_id  uuid,
  elevation_base_m     numeric,
  elevation_top_m      numeric,
  height_m             numeric,
  asset_version_id     uuid,
  binding_id           uuid,
  provenance           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz,
  updated_by           uuid,
  PRIMARY KEY (geometry_id, project_id),
  -- Polymorphic ownership resolves through entity_registry. The first two keys
  -- are the model-declared (entity_id, revision_id) reference; the third also
  -- pins entity_type so it cannot disagree with the registry row. All of them
  -- carry project_id, so ownership can never resolve across tenants.
  CONSTRAINT geometry_records_entity_fk
    FOREIGN KEY (entity_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  CONSTRAINT geometry_records_typed_entity_fk
    FOREIGN KEY (entity_id, entity_type, revision_id, project_id)
    REFERENCES entity_registry (entity_id, entity_type, revision_id, project_id),
  CONSTRAINT geometry_records_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT geometry_records_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT geometry_records_identity_key
    UNIQUE (entity_id, entity_type, revision_id, role, ordinal, project_id),
  CONSTRAINT geometry_records_projected_srid_check
    CHECK (ST_SRID(projected_geometry) > 0),
  CONSTRAINT geometry_records_4326_srid_check
    CHECK (ST_SRID(geojson_4326) = 4326),
  -- Declared geometry_type must match the actual stored geometry in both the
  -- interoperable and the projected representation.
  CONSTRAINT geometry_records_declared_type_check
    CHECK (
      (geometry_type = 'POINT'
        AND ST_GeometryType(geojson_4326) = 'ST_Point'
        AND ST_GeometryType(projected_geometry) = 'ST_Point') OR
      (geometry_type = 'LINESTRING'
        AND ST_GeometryType(geojson_4326) = 'ST_LineString'
        AND ST_GeometryType(projected_geometry) = 'ST_LineString') OR
      (geometry_type = 'POLYGON'
        AND ST_GeometryType(geojson_4326) = 'ST_Polygon'
        AND ST_GeometryType(projected_geometry) = 'ST_Polygon') OR
      (geometry_type = 'MULTIPOLYGON'
        AND ST_GeometryType(geojson_4326) = 'ST_MultiPolygon'
        AND ST_GeometryType(projected_geometry) = 'ST_MultiPolygon')
    ),
  -- Role/geometry-type mismatch (facility.data.geometry.type_mismatch), enforced
  -- for the role/type pairs the entity model fixes normatively.
  CONSTRAINT geometry_records_role_type_check
    CHECK (
      CASE role
        WHEN 'BOUNDARY'         THEN geometry_type IN ('POLYGON', 'MULTIPOLYGON')
        WHEN 'FOOTPRINT'        THEN geometry_type = 'POLYGON'
        WHEN 'FLOOR_BOUNDARY'   THEN geometry_type = 'POLYGON'
        WHEN 'ROOM_BOUNDARY'    THEN geometry_type = 'POLYGON'
        WHEN 'ROUTE'            THEN geometry_type = 'LINESTRING'
        WHEN 'CONNECTION_POINT' THEN geometry_type = 'POINT'
        WHEN 'CONSTRAINT_AREA'  THEN geometry_type IN ('POLYGON', 'MULTIPOLYGON')
        WHEN 'REFERENCE_POINT'  THEN geometry_type = 'POINT'
      END
    ),
  CONSTRAINT geometry_records_elevation_check
    CHECK (
      elevation_top_m IS NULL OR elevation_base_m IS NULL
      OR elevation_top_m >= elevation_base_m
    ),
  CONSTRAINT geometry_records_height_check
    CHECK (height_m IS NULL OR height_m >= 0)
);

-- Model: spatial_constraints. One envelope has many constraints. A constraint
-- attaches to exactly one scope or one container and owns zero or more linked
-- geometry records. Numeric rules declare rule_kind, rule_value, and rule_unit
-- and reference the geometry they constrain.
CREATE TABLE spatial_constraints (
  constraint_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL,
  scenario_id            uuid NOT NULL,
  revision_id            uuid NOT NULL,
  envelope_id            uuid NOT NULL,
  scope_id               uuid,
  container_id           uuid,
  applies_to_geometry_id uuid,
  kind                   constraint_kind NOT NULL,
  severity               severity NOT NULL DEFAULT 'ERROR',
  rule_kind              text,
  rule_value             numeric,
  rule_unit              text,
  provenance             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz,
  updated_by             uuid,
  PRIMARY KEY (constraint_id, project_id),
  CONSTRAINT spatial_constraints_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT spatial_constraints_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT spatial_constraints_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT spatial_constraints_scope_fk
    FOREIGN KEY (scope_id, revision_id, project_id)
    REFERENCES design_scopes (scope_id, revision_id, project_id),
  CONSTRAINT spatial_constraints_container_fk
    FOREIGN KEY (container_id, revision_id, project_id)
    REFERENCES facility_containers (container_id, revision_id, project_id),
  CONSTRAINT spatial_constraints_geometry_fk
    FOREIGN KEY (applies_to_geometry_id, project_id)
    REFERENCES geometry_records (geometry_id, project_id),
  -- Exactly one of scope_id / container_id.
  CONSTRAINT spatial_constraints_one_anchor_check
    CHECK ((scope_id IS NOT NULL) <> (container_id IS NOT NULL)),
  -- A numeric rule declares all three of rule_kind, rule_value, rule_unit.
  CONSTRAINT spatial_constraints_rule_check
    CHECK (
      rule_value IS NULL
      OR (rule_kind IS NOT NULL AND rule_unit IS NOT NULL)
    )
);

-- ----------------------------------------------------------------------------
-- 3.3 Environment and Phase
-- This section is created before the utility, resilience, and capacity tables
-- because facility_containers, storage_reserves, utility_sources,
-- utility_interfaces, capacity_budgets, and capacity_demand_requests all
-- reference facility_phases.
-- ----------------------------------------------------------------------------

-- Model: facility_phases. An envelope has many phases; dependency edges form a
-- directed acyclic graph (see phase_dependencies; cycles cannot be expressed as
-- a table CHECK and are validated before publish).
CREATE TABLE facility_phases (
  phase_id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id                uuid NOT NULL,
  scenario_id               uuid NOT NULL,
  revision_id               uuid NOT NULL,
  envelope_id               uuid NOT NULL,
  name                      text NOT NULL,
  phase_order               integer NOT NULL CHECK (phase_order >= 0),
  activation_date           date,
  activation_date_precision text,
  status                    phase_status NOT NULL DEFAULT 'PLANNED',
  provenance                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  updated_at                timestamptz,
  updated_by                uuid,
  PRIMARY KEY (phase_id, project_id),
  CONSTRAINT facility_phases_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT facility_phases_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT facility_phases_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT facility_phases_entity_fk
    FOREIGN KEY (phase_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  CONSTRAINT facility_phases_order_key UNIQUE (envelope_id, phase_order, project_id)
);

-- Model: phase_dependencies. One dependency edge. Identity:
-- (predecessor_phase_id, successor_phase_id). Self-reference and duplicate
-- pairs are prohibited by the CHECK and the primary key; cycles are not
-- expressible in SQL and are validated before publish.
CREATE TABLE phase_dependencies (
  predecessor_phase_id uuid NOT NULL,
  successor_phase_id   uuid NOT NULL,
  project_id           uuid NOT NULL,
  scenario_id          uuid NOT NULL,
  revision_id          uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  PRIMARY KEY (predecessor_phase_id, successor_phase_id, project_id),
  -- Both endpoints of a dependency edge must be phases of the same project.
  CONSTRAINT phase_dependencies_predecessor_fk
    FOREIGN KEY (predecessor_phase_id, project_id)
    REFERENCES facility_phases (phase_id, project_id),
  CONSTRAINT phase_dependencies_successor_fk
    FOREIGN KEY (successor_phase_id, project_id)
    REFERENCES facility_phases (phase_id, project_id),
  CONSTRAINT phase_dependencies_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT phase_dependencies_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT phase_dependencies_no_self_check
    CHECK (predecessor_phase_id <> successor_phase_id)
);

-- Model: phase_capability_availability. Declares when a capability becomes
-- available for consumption. Identity: (phase_id, capability).
CREATE TABLE phase_capability_availability (
  phase_id       uuid NOT NULL,
  capability     capability NOT NULL,
  project_id     uuid NOT NULL,
  scenario_id    uuid NOT NULL,
  revision_id    uuid NOT NULL,
  available      boolean NOT NULL DEFAULT false,
  available_from timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz,
  updated_by     uuid,
  PRIMARY KEY (phase_id, capability, project_id),
  CONSTRAINT phase_capability_availability_phase_fk
    FOREIGN KEY (phase_id, project_id)
    REFERENCES facility_phases (phase_id, project_id),
  CONSTRAINT phase_capability_availability_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT phase_capability_availability_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT phase_capability_availability_date_check
    CHECK (available = false OR available_from IS NOT NULL)
);

-- Model: environmental_profiles. One site scope has many time-versioned
-- profiles; a profile has many constraints. operating_ranges is a free-form
-- descriptor payload and is correctly jsonb; there is no canonical enum or
-- column set for it in the entity model.
CREATE TABLE environmental_profiles (
  profile_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL,
  scenario_id           uuid NOT NULL,
  revision_id           uuid NOT NULL,
  site_scope_id         uuid NOT NULL,
  design_weather_ref    text NOT NULL,
  hazard_classifications text[] NOT NULL DEFAULT '{}',
  permit_constraints    text[] NOT NULL DEFAULT '{}',
  operating_ranges      jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_at          timestamptz NOT NULL,
  effective_until       timestamptz,
  asset_version_id      uuid,
  provenance            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz,
  updated_by            uuid,
  PRIMARY KEY (profile_id, project_id),
  CONSTRAINT environmental_profiles_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT environmental_profiles_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT environmental_profiles_scope_fk
    FOREIGN KEY (site_scope_id, revision_id, project_id)
    REFERENCES design_scopes (scope_id, revision_id, project_id),
  CONSTRAINT environmental_profiles_effective_check
    CHECK (effective_until IS NULL OR effective_until > effective_at)
);

-- Model: environmental_constraints. A profile has many constraints, each
-- targeting an entity or an envelope-level condition. The constraint kind is
-- NOT enumerated by the interchange contract (ConstraintKind covers spatial
-- constraints such as SETBACK and HAZARD_ZONE, not environmental threshold
-- kinds), so it is stored as text rather than by inventing enum values.
CREATE TABLE environmental_constraints (
  environmental_constraint_id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL,
  scenario_id                 uuid NOT NULL,
  revision_id                 uuid NOT NULL,
  envelope_id                 uuid NOT NULL,
  profile_id                  uuid NOT NULL,
  affected_entity_id          uuid,
  applies_to_geometry_id      uuid,
  constraint_kind             text NOT NULL,
  threshold_value             numeric NOT NULL,
  threshold_unit              text NOT NULL,
  basis                       capacity_basis NOT NULL,
  effective_at                timestamptz,
  effective_until             timestamptz,
  provenance                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_at                  timestamptz,
  updated_by                  uuid,
  PRIMARY KEY (environmental_constraint_id, project_id),
  CONSTRAINT environmental_constraints_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT environmental_constraints_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT environmental_constraints_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT environmental_constraints_entity_fk
    FOREIGN KEY (affected_entity_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  CONSTRAINT environmental_constraints_profile_fk
    FOREIGN KEY (profile_id, project_id)
    REFERENCES environmental_profiles (profile_id, project_id),
  CONSTRAINT environmental_constraints_geometry_fk
    FOREIGN KEY (applies_to_geometry_id, project_id)
    REFERENCES geometry_records (geometry_id, project_id),
  CONSTRAINT environmental_constraints_effective_check
    CHECK (
      effective_until IS NULL OR effective_at IS NULL
      OR effective_until > effective_at
    )
);

-- ----------------------------------------------------------------------------
-- 3.4 Import Metadata
-- ----------------------------------------------------------------------------

-- Model: asset_bindings. This tool's consumption of one exact project asset
-- version. The asset, its versions, and its representations are stored at
-- project scope, not in this tool's tables, so asset_version_id and
-- representation_id are intentionally NOT foreign keys here; they are
-- validated against the project asset layer inside the writing transaction.
-- The transform_id foreign key is deferred (spatial_transforms is created next).
-- AssetBinding.role has no canonical enum, so it is text.
CREATE TABLE asset_bindings (
  binding_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL,
  scenario_id       uuid NOT NULL,
  revision_id       uuid NOT NULL,
  asset_version_id  uuid NOT NULL,
  representation_id uuid,
  transform_id      uuid,
  role              text NOT NULL,
  tool_id           text NOT NULL DEFAULT 'site_facility',
  status            review_state NOT NULL DEFAULT 'UNREVIEWED',
  mapping_ids       uuid[] NOT NULL DEFAULT '{}',
  payload_ref       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  PRIMARY KEY (binding_id, project_id),
  CONSTRAINT asset_bindings_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT asset_bindings_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT asset_bindings_tool_check CHECK (tool_id = 'site_facility')
);

-- Model: spatial_transforms. A binding can have many reviewed transforms for
-- different target scopes; local geometry references at most one parent
-- transform. control_points is an ordered free-form list of source/target
-- coordinate pairs preserved verbatim from the reviewed transform.
CREATE TABLE spatial_transforms (
  transform_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL,
  scenario_id       uuid NOT NULL,
  revision_id       uuid NOT NULL,
  binding_id        uuid NOT NULL,
  asset_version_id  uuid NOT NULL,
  source_units      text NOT NULL,
  target_units      text NOT NULL,
  source_crs        text,
  target_crs        text NOT NULL,
  vertical_crs      text,
  method            transform_method NOT NULL,
  control_points    jsonb NOT NULL DEFAULT '[]'::jsonb,
  residual_error_m  numeric,
  review_state      review_state NOT NULL DEFAULT 'UNREVIEWED',
  reviewer_id       uuid,
  reviewed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  PRIMARY KEY (transform_id, project_id),
  CONSTRAINT spatial_transforms_binding_fk
    FOREIGN KEY (binding_id, project_id)
    REFERENCES asset_bindings (binding_id, project_id),
  CONSTRAINT spatial_transforms_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT spatial_transforms_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  -- Source CRS is required unless at least two reviewed control points define
  -- the transform.
  CONSTRAINT spatial_transforms_source_crs_check
    CHECK (source_crs IS NOT NULL OR jsonb_array_length(control_points) >= 2),
  -- Fitted transforms require residual error.
  CONSTRAINT spatial_transforms_residual_check
    CHECK (method <> 'FITTED_RESIDUAL' OR residual_error_m IS NOT NULL),
  CONSTRAINT spatial_transforms_residual_nonneg_check
    CHECK (residual_error_m IS NULL OR residual_error_m >= 0),
  CONSTRAINT spatial_transforms_review_check
    CHECK (reviewed_at IS NULL OR reviewer_id IS NOT NULL)
);

-- Model: import_mappings. A binding has many mapping rules; one mapping
-- generates many normalized entities in one revision. Identity includes the
-- storage-shape unique key (asset_version_id, source_selector, revision_id).
CREATE TABLE import_mappings (
  mapping_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL,
  scenario_id           uuid NOT NULL,
  revision_id           uuid NOT NULL,
  binding_id            uuid NOT NULL,
  asset_version_id      uuid NOT NULL,
  transform_id          uuid NOT NULL,
  source_selector       text NOT NULL,
  target_entity_type    entity_type NOT NULL,
  target_geometry_role  geometry_role,
  attribute_mapping     jsonb NOT NULL DEFAULT '{}'::jsonb,
  cardinality           text NOT NULL DEFAULT 'ONE_TO_ONE',
  required              boolean NOT NULL DEFAULT false,
  review_state          review_state NOT NULL DEFAULT 'UNREVIEWED',
  reviewer_id           uuid,
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz,
  updated_by            uuid,
  PRIMARY KEY (mapping_id, project_id),
  CONSTRAINT import_mappings_binding_fk
    FOREIGN KEY (binding_id, project_id)
    REFERENCES asset_bindings (binding_id, project_id),
  CONSTRAINT import_mappings_transform_fk
    FOREIGN KEY (transform_id, project_id)
    REFERENCES spatial_transforms (transform_id, project_id),
  CONSTRAINT import_mappings_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT import_mappings_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT import_mappings_asset_selector_key
    UNIQUE (asset_version_id, source_selector, revision_id, project_id),
  CONSTRAINT import_mappings_review_check
    CHECK (reviewed_at IS NULL OR reviewer_id IS NOT NULL)
);

-- Model: import_features. Extracted source features with reference-only,
-- mapped, or unsupported status. raw_attributes is a free-form source payload
-- and is correctly jsonb. asset_version_id and representation_id belong to the
-- project asset layer and are not foreign keys here.
CREATE TABLE import_features (
  import_feature_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL,
  scenario_id          uuid NOT NULL,
  revision_id          uuid NOT NULL,
  asset_version_id     uuid NOT NULL,
  binding_id           uuid NOT NULL,
  representation_id    uuid,
  source_selector      text NOT NULL,
  source_feature_id    text,
  geometry_type        geometry_type,
  raw_attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  vertex_count         integer NOT NULL DEFAULT 0 CHECK (vertex_count >= 0),
  status               import_feature_status NOT NULL DEFAULT 'REFERENCE_ONLY',
  import_mapping_id    uuid,
  normalized_entity_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz,
  updated_by           uuid,
  -- The primary key carries both the partition key (created_at) and the tenant
  -- key (project_id), as PostgreSQL requires of every unique key on a
  -- partitioned table.
  PRIMARY KEY (import_feature_id, project_id, created_at),
  CONSTRAINT import_features_binding_fk
    FOREIGN KEY (binding_id, project_id)
    REFERENCES asset_bindings (binding_id, project_id),
  CONSTRAINT import_features_mapping_fk
    FOREIGN KEY (import_mapping_id, project_id)
    REFERENCES import_mappings (mapping_id, project_id),
  CONSTRAINT import_features_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT import_features_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT import_features_normalized_entity_fk
    FOREIGN KEY (normalized_entity_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  CONSTRAINT import_features_mapped_check
    CHECK (status <> 'MAPPED' OR import_mapping_id IS NOT NULL)
)
PARTITION BY RANGE (created_at);

-- Model: import_reports. Auditable per-import counts, diagnostics, and review
-- state. Element id arrays are arrays of the referenced surrogate keys.
CREATE TABLE import_reports (
  import_report_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL,
  scenario_id             uuid NOT NULL,
  revision_id             uuid NOT NULL,
  asset_version_ids       uuid[] NOT NULL DEFAULT '{}',
  binding_ids             uuid[] NOT NULL DEFAULT '{}',
  transform_ids           uuid[] NOT NULL DEFAULT '{}',
  mapping_ids             uuid[] NOT NULL DEFAULT '{}',
  diagnostic_ids          uuid[] NOT NULL DEFAULT '{}',
  mapped_feature_count    integer NOT NULL DEFAULT 0 CHECK (mapped_feature_count >= 0),
  unmapped_feature_count  integer NOT NULL DEFAULT 0 CHECK (unmapped_feature_count >= 0),
  unsupported_feature_count integer NOT NULL DEFAULT 0 CHECK (unsupported_feature_count >= 0),
  review_state            review_state NOT NULL DEFAULT 'UNREVIEWED',
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz,
  updated_by              uuid,
  PRIMARY KEY (import_report_id, project_id),
  CONSTRAINT import_reports_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT import_reports_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id)
);

-- ----------------------------------------------------------------------------
-- 3.5 Utilities, Resilience, and Capacity
-- ----------------------------------------------------------------------------

-- Model: failure_domains. An envelope has many failure domains forming an
-- acyclic containment tree. FailureDomain.kind has no canonical enum in the
-- interchange contract, so it is text. Acyclicity is not expressible in SQL and
-- is validated in the writing transaction.
CREATE TABLE failure_domains (
  failure_domain_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id               uuid NOT NULL,
  scenario_id              uuid NOT NULL,
  revision_id              uuid NOT NULL,
  envelope_id              uuid NOT NULL,
  parent_failure_domain_id uuid,
  name                     text NOT NULL,
  kind                     text NOT NULL,
  provenance               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz,
  updated_by               uuid,
  PRIMARY KEY (failure_domain_id, project_id),
  -- A failure-domain containment edge never crosses a project boundary.
  CONSTRAINT failure_domains_parent_fk
    FOREIGN KEY (parent_failure_domain_id, project_id)
    REFERENCES failure_domains (failure_domain_id, project_id),
  CONSTRAINT failure_domains_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT failure_domains_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT failure_domains_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT failure_domains_entity_fk
    FOREIGN KEY (failure_domain_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  CONSTRAINT failure_domains_no_self_parent_check
    CHECK (parent_failure_domain_id IS NULL OR parent_failure_domain_id <> failure_domain_id)
);

-- Model: resilience_requirements. One envelope has at most one active
-- requirement (enforced by the partial unique index below); applies_to names
-- resource kinds. policy_id names a PolicyReference; policy text is never
-- copied into tool state and there is no local policies table, so policy_id is
-- not a foreign key and only the pinned reference is stored.
CREATE TABLE resilience_requirements (
  requirement_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id                uuid NOT NULL,
  scenario_id               uuid NOT NULL,
  revision_id               uuid NOT NULL,
  envelope_id               uuid NOT NULL,
  availability_policy       availability_policy NOT NULL,
  policy_id                 text NOT NULL,
  applies_to                resource_kind[] NOT NULL DEFAULT '{}',
  autonomy_duration_seconds integer CHECK (autonomy_duration_seconds >= 0),
  active                    boolean NOT NULL DEFAULT true,
  provenance                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  updated_at                timestamptz,
  updated_by                uuid,
  PRIMARY KEY (requirement_id, project_id),
  CONSTRAINT resilience_requirements_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT resilience_requirements_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT resilience_requirements_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id)
);

-- Model: storage_reserves. Fuel and water storage with capacity and autonomy
-- duration. capacity and autonomy_duration are stored normalized (SI): volume
-- or flow in the capacity columns and seconds in autonomy_duration_seconds.
CREATE TABLE storage_reserves (
  storage_id                uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id                uuid NOT NULL,
  scenario_id               uuid NOT NULL,
  revision_id               uuid NOT NULL,
  envelope_id               uuid NOT NULL,
  kind                      storage_reserve_kind NOT NULL,
  capacity_value            numeric NOT NULL CHECK (capacity_value >= 0),
  capacity_unit             text NOT NULL,
  capacity_basis            capacity_basis NOT NULL,
  capacity_state            quantity_state NOT NULL DEFAULT 'PLANNED',
  autonomy_duration_seconds integer NOT NULL CHECK (autonomy_duration_seconds >= 0),
  failure_domain_id         uuid NOT NULL,
  phase_id                  uuid NOT NULL,
  provenance                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  updated_at                timestamptz,
  updated_by                uuid,
  PRIMARY KEY (storage_id, project_id),
  CONSTRAINT storage_reserves_failure_domain_fk
    FOREIGN KEY (failure_domain_id, project_id)
    REFERENCES failure_domains (failure_domain_id, project_id),
  CONSTRAINT storage_reserves_phase_fk
    FOREIGN KEY (phase_id, project_id)
    REFERENCES facility_phases (phase_id, project_id),
  CONSTRAINT storage_reserves_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT storage_reserves_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT storage_reserves_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT storage_reserves_entity_fk
    FOREIGN KEY (storage_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  -- capacity uses basis FUEL_VOLUME for FUEL and WATER_FLOW for WATER.
  CONSTRAINT storage_reserves_basis_check
    CHECK (
      (kind = 'FUEL'  AND capacity_basis = 'FUEL_VOLUME') OR
      (kind = 'WATER' AND capacity_basis = 'WATER_FLOW')
    )
);

-- Model: utility_sources. An envelope has many planning-level sources; a source
-- has many interfaces and linked CONNECTION_POINT geometry. capacity_state is
-- the SupplyState subset of QuantityState.
CREATE TABLE utility_sources (
  utility_source_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL,
  scenario_id        uuid NOT NULL,
  revision_id        uuid NOT NULL,
  envelope_id        uuid NOT NULL,
  kind               resource_kind NOT NULL,
  capacity_value     numeric NOT NULL CHECK (capacity_value >= 0),
  capacity_unit      text NOT NULL,
  capacity_basis     capacity_basis NOT NULL,
  capacity_state     supply_state NOT NULL,
  failure_domain_id  uuid NOT NULL,
  phase_id           uuid NOT NULL,
  available_from     timestamptz,
  provenance         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz,
  updated_by         uuid,
  PRIMARY KEY (utility_source_id, project_id),
  CONSTRAINT utility_sources_failure_domain_fk
    FOREIGN KEY (failure_domain_id, project_id)
    REFERENCES failure_domains (failure_domain_id, project_id),
  CONSTRAINT utility_sources_phase_fk
    FOREIGN KEY (phase_id, project_id)
    REFERENCES facility_phases (phase_id, project_id),
  CONSTRAINT utility_sources_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT utility_sources_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT utility_sources_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT utility_sources_entity_fk
    FOREIGN KEY (utility_source_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id)
);

-- Model: utility_interfaces. Each interface references exactly one source and
-- phase and owns one or more CONNECTION_POINT geometry records; downstream
-- tools attach to interfaces, not to sources.
CREATE TABLE utility_interfaces (
  interface_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL,
  scenario_id        uuid NOT NULL,
  revision_id        uuid NOT NULL,
  envelope_id        uuid NOT NULL,
  utility_source_id  uuid NOT NULL,
  capacity_value     numeric CHECK (capacity_value IS NULL OR capacity_value >= 0),
  capacity_unit      text,
  capacity_basis     capacity_basis,
  capacity_state     supply_state,
  service_state      service_state NOT NULL DEFAULT 'AVAILABLE',
  failure_domain_id  uuid NOT NULL,
  phase_id           uuid NOT NULL,
  available_from     timestamptz,
  provenance         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz,
  updated_by         uuid,
  PRIMARY KEY (interface_id, project_id),
  CONSTRAINT utility_interfaces_source_fk
    FOREIGN KEY (utility_source_id, project_id)
    REFERENCES utility_sources (utility_source_id, project_id),
  CONSTRAINT utility_interfaces_failure_domain_fk
    FOREIGN KEY (failure_domain_id, project_id)
    REFERENCES failure_domains (failure_domain_id, project_id),
  CONSTRAINT utility_interfaces_phase_fk
    FOREIGN KEY (phase_id, project_id)
    REFERENCES facility_phases (phase_id, project_id),
  CONSTRAINT utility_interfaces_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT utility_interfaces_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT utility_interfaces_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT utility_interfaces_entity_fk
    FOREIGN KEY (interface_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  -- A capacity claim must declare its unit and basis together.
  CONSTRAINT utility_interfaces_capacity_check
    CHECK (
      (capacity_value IS NULL AND capacity_unit IS NULL
        AND capacity_basis IS NULL AND capacity_state IS NULL)
      OR (capacity_value IS NOT NULL AND capacity_unit IS NOT NULL
        AND capacity_basis IS NOT NULL AND capacity_state IS NOT NULL)
    )
);

-- Model: capacity_budgets. Unique per owner entity, phase, resource kind, and
-- basis. The availability formula
--   available = firm * (1 - derating_factor) - reserve - accepted allocations
-- is not expressible as a single-row CHECK; available_value is the stored
-- derived result and overcommit is reported as
-- facility.capacity.budget.overcommit.
CREATE TABLE capacity_budgets (
  budget_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL,
  scenario_id          uuid NOT NULL,
  revision_id          uuid NOT NULL,
  envelope_id          uuid NOT NULL,
  owner_entity_id      uuid NOT NULL,
  phase_id             uuid NOT NULL,
  utility_interface_id uuid,
  resource_kind        resource_kind NOT NULL,
  basis                capacity_basis NOT NULL,
  unit                 text NOT NULL,
  commissioned_value   numeric NOT NULL DEFAULT 0 CHECK (commissioned_value >= 0),
  planned_value        numeric NOT NULL DEFAULT 0 CHECK (planned_value >= 0),
  reserved_value       numeric NOT NULL DEFAULT 0 CHECK (reserved_value >= 0),
  allocated_value      numeric NOT NULL DEFAULT 0 CHECK (allocated_value >= 0),
  available_value      numeric NOT NULL DEFAULT 0,
  derating_factor      numeric NOT NULL DEFAULT 0
                         CHECK (derating_factor >= 0 AND derating_factor <= 1),
  provenance           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz,
  updated_by           uuid,
  PRIMARY KEY (budget_id, project_id),
  CONSTRAINT capacity_budgets_phase_fk
    FOREIGN KEY (phase_id, project_id)
    REFERENCES facility_phases (phase_id, project_id),
  CONSTRAINT capacity_budgets_interface_fk
    FOREIGN KEY (utility_interface_id, project_id)
    REFERENCES utility_interfaces (interface_id, project_id),
  CONSTRAINT capacity_budgets_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT capacity_budgets_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT capacity_budgets_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT capacity_budgets_owner_fk
    FOREIGN KEY (owner_entity_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  CONSTRAINT capacity_budgets_identity_key
    UNIQUE (owner_entity_id, phase_id, resource_kind, basis, project_id)
);

-- Model: capacity_demand_requests. Downstream requests and their decisions;
-- append-only for audit, so there is no updated_at/updated_by. A downstream
-- request cannot modify facility entities, sources, or budgets.
CREATE TABLE capacity_demand_requests (
  request_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL,
  scenario_id       uuid NOT NULL,
  revision_id       uuid NOT NULL,
  envelope_id       uuid NOT NULL,
  consumer_type     consumer_type NOT NULL,
  consumer_id       uuid NOT NULL,
  phase_id          uuid NOT NULL,
  resource_kind     resource_kind NOT NULL,
  requested_value   numeric NOT NULL CHECK (requested_value >= 0),
  requested_unit    text NOT NULL,
  requested_basis   capacity_basis NOT NULL,
  requested_state   quantity_state NOT NULL DEFAULT 'PLANNED',
  required_from     timestamptz NOT NULL,
  priority          priority NOT NULL DEFAULT 'NORMAL',
  provenance        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  PRIMARY KEY (request_id, project_id),
  CONSTRAINT capacity_demand_requests_phase_fk
    FOREIGN KEY (phase_id, project_id)
    REFERENCES facility_phases (phase_id, project_id),
  CONSTRAINT capacity_demand_requests_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT capacity_demand_requests_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT capacity_demand_requests_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id)
);

-- Model: capacity_allocations. A budget has many allocations; each satisfies
-- at most one demand request. Identity includes the storage-shape unique key
-- (budget_id, demand_request_id). Only ACCEPTED allocations reduce available
-- capacity; that consequence is applied to capacity_budgets in the same
-- transaction and is not expressible as a single-row CHECK. The rule that an
-- allocation's resource kind, basis, and phase must match its budget and demand
-- request spans several tables and is also validated in the writing transaction.
CREATE TABLE capacity_allocations (
  allocation_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL,
  scenario_id       uuid NOT NULL,
  revision_id       uuid NOT NULL,
  budget_id         uuid NOT NULL,
  demand_request_id uuid NOT NULL,
  quantity_value    numeric NOT NULL CHECK (quantity_value >= 0),
  quantity_unit     text NOT NULL,
  quantity_basis    capacity_basis NOT NULL,
  quantity_state    quantity_state NOT NULL DEFAULT 'PLANNED',
  state             allocation_state NOT NULL DEFAULT 'PROVISIONAL',
  valid_from        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  PRIMARY KEY (allocation_id, project_id),
  CONSTRAINT capacity_allocations_budget_fk
    FOREIGN KEY (budget_id, project_id)
    REFERENCES capacity_budgets (budget_id, project_id),
  CONSTRAINT capacity_allocations_demand_request_fk
    FOREIGN KEY (demand_request_id, project_id)
    REFERENCES capacity_demand_requests (request_id, project_id),
  CONSTRAINT capacity_allocations_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT capacity_allocations_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT capacity_allocations_identity_key
    UNIQUE (budget_id, demand_request_id, project_id)
);

-- ----------------------------------------------------------------------------
-- 3.6 Verification and Governance
-- ----------------------------------------------------------------------------

-- Model: capability_coverage. Every envelope revision has exactly one derived
-- record per capability. Identity: (revision_id, capability). Status is derived
-- from validation evidence, never asserted directly (D11), so it is not
-- constrained to match any other row here.
CREATE TABLE capability_coverage (
  revision_id  uuid NOT NULL,
  capability   capability NOT NULL,
  project_id   uuid NOT NULL,
  scenario_id  uuid NOT NULL,
  envelope_id  uuid NOT NULL,
  status       capability_status NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz,
  updated_by   uuid,
  PRIMARY KEY (revision_id, capability, project_id),
  CONSTRAINT capability_coverage_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT capability_coverage_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT capability_coverage_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id)
);

-- Model: validation_runs. One revision has many runs; one clean run provides
-- the summary for a validated envelope. not_checked_capabilities makes the
-- "what VALIDATED covers" statement explicit.
CREATE TABLE validation_runs (
  validation_run_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id                uuid NOT NULL,
  scenario_id               uuid NOT NULL,
  revision_id               uuid NOT NULL,
  envelope_id               uuid NOT NULL,
  scope                     validation_scope NOT NULL DEFAULT 'FULL',
  status                    validation_run_status NOT NULL DEFAULT 'QUEUED',
  base_etag                 uuid,
  requested_capabilities    capability[] NOT NULL DEFAULT '{}',
  checked_capabilities      capability[] NOT NULL DEFAULT '{}',
  not_checked_capabilities  capability[] NOT NULL DEFAULT '{}',
  error_count               integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  warning_count             integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  started_at                timestamptz,
  completed_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  PRIMARY KEY (validation_run_id, project_id),
  CONSTRAINT validation_runs_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT validation_runs_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT validation_runs_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT validation_runs_completion_check
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

-- NOT PARTITIONED (deliberate). facility_diagnostics is the third storage-shape
-- partition candidate, but supersedes_diagnostic_id is a foreign key back to
-- this same table. PostgreSQL requires a foreign key that targets a partitioned
-- table to reference every partition key column, and a superseded diagnostic
-- normally predates the row that supersedes it, so the self-reference cannot be
-- expressed once created_at is part of the key. The table therefore stays an
-- ordinary table and is archived by revision age instead.
--
-- Model: facility_diagnostics. A run emits many append-only diagnostics, each
-- with a stable constraint ID, affected entities, evidence, severity, and
-- remediation category. Append-only: no updated_at/updated_by.
-- entity_refs, geometry_refs, source_values, and computed are free-form
-- evidence payloads and are correctly jsonb. The storage-shape index
-- (revision_id, entity_id) cannot be built on a free-form list; a GIN index on
-- entity_refs is provided instead (see the index section).
CREATE TABLE facility_diagnostics (
  diagnostic_id             uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id                uuid NOT NULL,
  scenario_id               uuid NOT NULL,
  revision_id               uuid NOT NULL,
  validation_run_id         uuid NOT NULL,
  constraint_id             text NOT NULL,
  severity                  severity NOT NULL,
  status                    diagnostic_status NOT NULL DEFAULT 'OPEN',
  entity_refs               jsonb NOT NULL DEFAULT '[]'::jsonb,
  geometry_refs             jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_values             jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  remediation_category      remediation_category NOT NULL,
  remediation_hint          text,
  policy_ref                text,
  supersedes_diagnostic_id  uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  PRIMARY KEY (diagnostic_id, project_id),
  CONSTRAINT facility_diagnostics_validation_run_fk
    FOREIGN KEY (validation_run_id, project_id)
    REFERENCES validation_runs (validation_run_id, project_id),
  CONSTRAINT facility_diagnostics_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT facility_diagnostics_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  -- A superseded diagnostic must belong to the same project.
  CONSTRAINT facility_diagnostics_supersedes_fk
    FOREIGN KEY (supersedes_diagnostic_id, project_id)
    REFERENCES facility_diagnostics (diagnostic_id, project_id),
  CONSTRAINT facility_diagnostics_no_self_supersede_check
    CHECK (supersedes_diagnostic_id IS NULL OR supersedes_diagnostic_id <> diagnostic_id)
);

-- Model: assumptions. Recorded unresolved inputs; an active assumption caps
-- every touched capability at PROVISIONAL. entity_refs is a free-form list of
-- (entity_type, entity_id) pairs and is correctly jsonb.
CREATE TABLE assumptions (
  assumption_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL,
  scenario_id    uuid NOT NULL,
  revision_id    uuid NOT NULL,
  envelope_id    uuid NOT NULL,
  statement      text NOT NULL,
  owner          text NOT NULL,
  confidence     confidence NOT NULL,
  effective_at   timestamptz NOT NULL,
  expires_at     timestamptz,
  status         assumption_status NOT NULL DEFAULT 'OPEN',
  entity_refs    jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz,
  updated_by     uuid,
  PRIMARY KEY (assumption_id, project_id),
  CONSTRAINT assumptions_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT assumptions_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT assumptions_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT assumptions_entity_fk
    FOREIGN KEY (assumption_id, revision_id, project_id)
    REFERENCES entity_registry (entity_id, revision_id, project_id),
  CONSTRAINT assumptions_expiry_check
    CHECK (expires_at IS NULL OR expires_at > effective_at)
);

-- Model: waivers. Suppress the gating effect of named diagnostics without
-- altering them. Append-only. policy_id and approver_id reference policy and
-- principal records owned elsewhere, so only the pinned reference is stored.
CREATE TABLE waivers (
  waiver_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL,
  scenario_id     uuid NOT NULL,
  revision_id     uuid NOT NULL,
  envelope_id     uuid,
  diagnostic_ids  uuid[] NOT NULL DEFAULT '{}',
  scope           text NOT NULL,
  granted_by      uuid NOT NULL,
  policy_id       text NOT NULL,
  reason          text NOT NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  status          waiver_status NOT NULL DEFAULT 'GRANTED',
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  PRIMARY KEY (waiver_id, project_id),
  CONSTRAINT waivers_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT waivers_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT waivers_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT waivers_expiry_check
    CHECK (expires_at IS NULL OR expires_at > granted_at)
);

-- Model: documents. Operational and permit metadata linked to entities; a
-- document is metadata and never supplies authoritative geometry. The document
-- checksum is unique within a project to support deduplication without
-- overwriting provenance. The object-store key is referenced, never inlined.
CREATE TABLE documents (
  document_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL,
  scenario_id        uuid NOT NULL,
  revision_id        uuid,
  kind               document_kind NOT NULL,
  title              text NOT NULL,
  media_type         text NOT NULL,
  content_checksum   text NOT NULL,
  storage_key        text NOT NULL,
  owner              text NOT NULL,
  issued_at          timestamptz,
  expires_at         timestamptz,
  entity_refs        jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz,
  updated_by         uuid,
  PRIMARY KEY (document_id, project_id),
  CONSTRAINT documents_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT documents_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT documents_checksum_key UNIQUE (project_id, content_checksum),
  CONSTRAINT documents_expiry_check
    CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at > issued_at)
);

-- Model: impact_notices. Invalidation notices for downstream consumers.
-- Append-only.
CREATE TABLE impact_notices (
  impact_notice_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id                 uuid NOT NULL,
  scenario_id                uuid NOT NULL,
  previous_revision_id       uuid NOT NULL,
  revision_id                uuid NOT NULL,
  changed_entity_refs        jsonb NOT NULL DEFAULT '[]'::jsonb,
  invalidated_consumer_types consumer_type[] NOT NULL DEFAULT '{}',
  issued_at                  timestamptz NOT NULL DEFAULT now(),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid,
  PRIMARY KEY (impact_notice_id, project_id),
  CONSTRAINT impact_notices_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT impact_notices_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT impact_notices_previous_revision_fk
    FOREIGN KEY (previous_revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT impact_notices_distinct_revisions_check
    CHECK (previous_revision_id <> revision_id)
);

-- Model: cost_schedule_references. Read-only links to cost, schedule, and
-- sustainability records owned by the Cost, Schedule, and Sustainability
-- workspace. Reference-only, never gating; this tool never writes the
-- referenced value and never creates the record.
CREATE TABLE cost_schedule_references (
  cost_schedule_ref_id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL,
  scenario_id          uuid NOT NULL,
  revision_id          uuid NOT NULL,
  envelope_id          uuid NOT NULL,
  kind                 cost_schedule_kind NOT NULL,
  provider             text NOT NULL,
  external_entity_ref  text NOT NULL,
  label                text,
  effective_at         timestamptz,
  source_ref           text NOT NULL,
  linked_entity_refs   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz,
  updated_by           uuid,
  PRIMARY KEY (cost_schedule_ref_id, project_id),
  CONSTRAINT cost_schedule_references_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT cost_schedule_references_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT cost_schedule_references_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id)
);

-- Model: approval_attestations. A validated revision can have many approval,
-- rejection, or revocation attestations. Append-only; rejection or revocation
-- is always a new attestation and never mutates the Facility Envelope.
-- approver_id references a principal record owned elsewhere and so is stored as
-- a pinned reference rather than a foreign key.
CREATE TABLE approval_attestations (
  attestation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL,
  scenario_id    uuid NOT NULL,
  envelope_id    uuid NOT NULL,
  revision_id    uuid NOT NULL,
  approver_id    uuid NOT NULL,
  policy_id      text NOT NULL,
  decision       approval_decision NOT NULL,
  approved_at    timestamptz NOT NULL DEFAULT now(),
  comment        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  PRIMARY KEY (attestation_id, project_id),
  CONSTRAINT approval_attestations_envelope_fk
    FOREIGN KEY (envelope_id, project_id, scenario_id)
    REFERENCES facility_envelopes (envelope_id, project_id, scenario_id),
  CONSTRAINT approval_attestations_revision_fk
    FOREIGN KEY (revision_id, project_id, scenario_id)
    REFERENCES revisions (revision_id, project_id, scenario_id),
  CONSTRAINT approval_attestations_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id)
);

-- ----------------------------------------------------------------------------
-- 3.7 Platform Support: Map Tile Usage Metering
-- ----------------------------------------------------------------------------

-- Table: map_tile_usage (storage-shape "Map Tile Cache and Usage Metering").
-- Authoritative counters by organization, project, user, provider, and period,
-- together with quota and threshold state. The quota check and the counter
-- increment commit in one transaction so the counter cannot drift from the
-- enforcement decision. Provider credentials are never written here.
-- Metering is project-scoped; scenario_id is carried for uniform tenant
-- isolation and is not part of the counter identity.
CREATE TABLE map_tile_usage (
  map_tile_usage_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  project_id         uuid NOT NULL,
  scenario_id        uuid NOT NULL,
  user_id            uuid,
  provider           text NOT NULL,
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  tile_count         bigint NOT NULL DEFAULT 0 CHECK (tile_count >= 0),
  quota_limit        bigint CHECK (quota_limit IS NULL OR quota_limit >= 0),
  threshold_state    text,
  threshold_notified_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  PRIMARY KEY (map_tile_usage_id, project_id),
  CONSTRAINT map_tile_usage_scenario_fk
    FOREIGN KEY (scenario_id, project_id)
    REFERENCES scenarios (scenario_id, project_id),
  CONSTRAINT map_tile_usage_period_check CHECK (period_end > period_start)
);

-- ----------------------------------------------------------------------------
-- 3.8 Time-range partitions for the append-only high-volume tables
--
-- outbox_events and import_features are declared PARTITION BY RANGE
-- (created_at) above. This block materializes monthly partitions relative to
-- the migration run date (three months back through six months forward) plus a
-- DEFAULT partition, so an insert can never fail for want of a partition.
-- Partition names are deterministic (outbox_events_2026_01,
-- import_features_2026_01, ...), which lets retention drop a whole month with
-- DROP TABLE instead of a mass DELETE. The indexes declared in section 4 on the
-- parents are created on every partition automatically. facility_diagnostics is
-- intentionally absent: see the note above its definition.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  parent_table    text;
  month_offset    integer;
  month_start     date;
  partition_start date;
  partition_end   date;
BEGIN
  FOREACH parent_table IN ARRAY ARRAY['outbox_events', 'import_features'] LOOP
    month_start := (date_trunc('month', current_date::timestamp))::date;
    FOR month_offset IN -3..6 LOOP
      partition_start := (month_start + make_interval(months => month_offset))::date;
      partition_end   := (partition_start + interval '1 month')::date;
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        parent_table || '_' || to_char(partition_start::timestamp, 'YYYY_MM'),
        parent_table,
        partition_start,
        partition_end
      );
    END LOOP;
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I DEFAULT',
      parent_table || '_default',
      parent_table
    );
  END LOOP;
END
$$;

-- ============================================================================
-- 4. Secondary indexes
-- ============================================================================

-- Spatial indexes: both geometry representations carry a native GiST index,
-- geojson_4326 for geographic queries and projected_geometry for planar
-- measurement (storage-shape "Geometry and CRS Storage").
CREATE INDEX geometry_records_geojson_gix
  ON geometry_records USING gist (geojson_4326);
CREATE INDEX geometry_records_projected_gix
  ON geometry_records USING gist (projected_geometry);

-- Entity-scoped geometry reads by stable entity ID within a revision.
CREATE INDEX geometry_records_entity_idx
  ON geometry_records (revision_id, entity_id, role);
CREATE INDEX geometry_records_type_idx
  ON geometry_records (revision_id, entity_type);

-- Registry lookups by revision and type.
CREATE INDEX entity_registry_type_idx
  ON entity_registry (revision_id, entity_type);

-- Container tree reads.
CREATE INDEX facility_containers_parent_idx
  ON facility_containers (parent_container_id);
CREATE INDEX facility_containers_scope_idx
  ON facility_containers (scope_id);

-- level_number is unique within a building: a FLOOR or HALL is a child of its
-- building, so uniqueness on (parent_container_id, level_number) among level
-- containers expresses the model rule.
CREATE UNIQUE INDEX facility_containers_building_level_key
  ON facility_containers (parent_container_id, level_number, project_id)
  WHERE kind IN ('FLOOR', 'HALL') AND level_number IS NOT NULL;

-- Branch ancestry lookups.
CREATE INDEX revision_lineage_parent_idx
  ON revision_lineage (parent_revision_id);

-- Import metadata reads.
CREATE INDEX import_features_asset_idx
  ON import_features (revision_id, asset_version_id, status);
CREATE INDEX import_features_selector_idx
  ON import_features (asset_version_id, source_selector);
CREATE INDEX import_mappings_binding_idx
  ON import_mappings (binding_id);

-- Utility and capacity reads.
CREATE INDEX utility_sources_envelope_idx
  ON utility_sources (envelope_id, kind);
CREATE INDEX utility_interfaces_source_idx
  ON utility_interfaces (utility_source_id);
CREATE INDEX capacity_budgets_envelope_idx
  ON capacity_budgets (envelope_id, resource_kind, basis);
CREATE INDEX capacity_allocations_request_idx
  ON capacity_allocations (demand_request_id);
CREATE INDEX capacity_allocations_state_idx
  ON capacity_allocations (revision_id, state);

-- At most one active resilience requirement per envelope.
CREATE UNIQUE INDEX resilience_requirements_active_key
  ON resilience_requirements (envelope_id, project_id)
  WHERE active;

-- Phase graph reads.
CREATE INDEX phase_dependencies_successor_idx
  ON phase_dependencies (successor_phase_id);

-- Diagnostics: composite index for the common severity/status read and a GIN
-- index over the free-form entity reference list.
CREATE INDEX facility_diagnostics_revision_severity_idx
  ON facility_diagnostics (revision_id, severity, status);
CREATE INDEX facility_diagnostics_run_idx
  ON facility_diagnostics (validation_run_id);
CREATE INDEX facility_diagnostics_entity_refs_gin
  ON facility_diagnostics USING gin (entity_refs);

-- Validation runs by revision.
CREATE INDEX validation_runs_revision_idx
  ON validation_runs (revision_id, status);

-- Append-only governance lookups.
CREATE INDEX waivers_revision_idx
  ON waivers (revision_id, status);
CREATE INDEX approval_attestations_revision_idx
  ON approval_attestations (revision_id, decision);

-- Outbox: unpublished events, and partition/archive key.
CREATE INDEX outbox_events_revision_idx
  ON outbox_events (revision_id, occurred_at);
CREATE INDEX outbox_events_unpublished_idx
  ON outbox_events (occurred_at)
  WHERE published_at IS NULL;

-- Job state polling.
CREATE INDEX jobs_state_idx
  ON jobs (state, created_at);

-- Metering counter identity: one row per organization, project, user, provider,
-- and period. NULL user_id means the project-level counter; NULLS NOT DISTINCT
-- keeps that single project-level row unique instead of allowing many.
CREATE UNIQUE INDEX map_tile_usage_counter_key
  ON map_tile_usage (
    organization_id, project_id, user_id, provider, period_start
  ) NULLS NOT DISTINCT;

-- ============================================================================
-- 5. Deferred foreign keys
-- Forward references that cannot be declared inline because of creation order.
-- ============================================================================

-- jobs.binding_id references asset_bindings, which is created in section 3.4.
ALTER TABLE jobs
  ADD CONSTRAINT jobs_binding_fk
  FOREIGN KEY (binding_id, project_id)
  REFERENCES asset_bindings (binding_id, project_id);

-- facility_containers.phase_id references facility_phases (section 3.3).
ALTER TABLE facility_containers
  ADD CONSTRAINT facility_containers_phase_fk
  FOREIGN KEY (phase_id, project_id)
  REFERENCES facility_phases (phase_id, project_id);

-- asset_bindings.transform_id and geometry_records.parent_transform_id
-- reference spatial_transforms (section 3.4).
ALTER TABLE asset_bindings
  ADD CONSTRAINT asset_bindings_transform_fk
  FOREIGN KEY (transform_id, project_id)
  REFERENCES spatial_transforms (transform_id, project_id);

ALTER TABLE geometry_records
  ADD CONSTRAINT geometry_records_parent_transform_fk
  FOREIGN KEY (parent_transform_id, project_id)
  REFERENCES spatial_transforms (transform_id, project_id);

-- geometry_records.binding_id references asset_bindings. asset_version_id is
-- owned by the project asset layer and is intentionally not a foreign key.
ALTER TABLE geometry_records
  ADD CONSTRAINT geometry_records_binding_fk
  FOREIGN KEY (binding_id, project_id)
  REFERENCES asset_bindings (binding_id, project_id);

-- facility_envelopes.validation_run_id references validation_runs (section 3.6).
ALTER TABLE facility_envelopes
  ADD CONSTRAINT facility_envelopes_validation_run_fk
  FOREIGN KEY (validation_run_id, project_id)
  REFERENCES validation_runs (validation_run_id, project_id);

-- ============================================================================
-- 6. Row-level security: project isolation
--
-- Every tenant-scoped table carries project_id. RLS is enabled and a
-- project-isolation policy is installed by looping over the catalog, so the
-- policy cannot be forgotten when a table is added. The policy compares
-- project_id with current_setting('app.project_id', true)::uuid. A setting that
-- was never set yields NULL, and a setting that was RESET yields the empty
-- string; nullif(..., '') turns both into NULL, the comparison yields NULL (not
-- true), and the row is filtered out. An unset or reset setting therefore fails
-- closed instead of raising a cast error.
--
-- FORCE ROW LEVEL SECURITY is deliberately not used here so that the owning
-- migration role and maintenance tasks are not locked out; deployments that
-- require the table owner to be subject to the policy as well should run
-- ALTER TABLE ... FORCE ROW LEVEL SECURITY after this migration.
-- ============================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      -- 'r' covers ordinary tables and table partitions; 'p' covers the
      -- partitioned parents (outbox_events and import_features), which are
      -- application tables in their own right and must carry the same single
      -- project-isolation policy.
      AND c.relkind IN ('r', 'p')
      AND EXISTS (
        SELECT 1
        FROM pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'project_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_policy p
        WHERE p.polrelid = c.oid
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      r.relname
    );
    EXECUTE format(
      'CREATE POLICY project_isolation ON public.%I '
      'USING (project_id = nullif(current_setting(''app.project_id'', true), '''')::uuid) '
      'WITH CHECK (project_id = nullif(current_setting(''app.project_id'', true), '''')::uuid)',
      r.relname
    );
  END LOOP;
END
$$;

-- End of migration 001_facility_schema.sql
