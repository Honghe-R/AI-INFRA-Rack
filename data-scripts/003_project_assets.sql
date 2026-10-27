-- ============================================================================
--  003_project_assets.sql
--  Workspace Project Assets -- project-scoped asset, version, representation,
--  link, hold, and job storage (schema version 003).
--
--  Implements:
--    * doc/workspace/project-assets.md -- the "Persistence Models" table and
--      the identity, versioning, and deduplication rules.
--    * Decision D20 -- imported files are first-class project assets; tools
--      consume an exact version through a binding and never own the file.
--    * Decision D22 -- the tenant-key discipline: project_id is part of every
--      primary key, every unique constraint, and every foreign key, so a
--      stored reference cannot cross a project boundary.
--    * Decision D21 and doc/workspace/retention.md -- retention_class on the
--      asset and a legal-hold record that overrides every retention value.
--
--  Relationship to the facility schema (001): 001 owns this tool's side of the
--  asset layer. asset_bindings, spatial_transforms, import_mappings,
--  import_features, and import_reports already exist there and intentionally
--  carry asset_version_id and representation_id WITHOUT a foreign key, because
--  the asset rows live here at project scope. The asset tables therefore never
--  reference a revision or a binding; the binding references the asset.
--
--  Why a separate table for jobs: `jobs` in 001 requires a scenario_id, and an
--  asset scan or processing job is project-scoped and predates any scenario.
--  `asset_jobs` mirrors the job columns without inventing a scenario.
--
--  Row-level security: 001's catalog-driven policy loop ran before these tables
--  existed, so the same idempotent loop is repeated at the end of this file.
--  An unset app.project_id fails closed.
--
--  Target: PostgreSQL 16. Extensions are created by 001.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Enum types
--
-- Project Asssets shapes are workspace-level and are not part of the facility
-- interchange contract, so their enumerations are defined here. Type names are
-- snake_case renderings of the documented names; values are exact.
-- ----------------------------------------------------------------------------

-- ProjectAsset.kind
CREATE TYPE asset_kind AS ENUM (
  'CAD', 'BIM', 'GIS', 'RASTER', 'DOCUMENT', 'DATASET', 'OTHER'
);

-- ProjectAsset.status
CREATE TYPE asset_status AS ENUM (
  'ACTIVE', 'ARCHIVED', 'QUARANTINED', 'DELETED'
);

-- ProjectAsset.access_classification
CREATE TYPE asset_access_classification AS ENUM (
  'PROJECT', 'RESTRICTED'
);

-- AssetVersion.status
CREATE TYPE asset_version_status AS ENUM (
  'CURRENT', 'SUPERSEDED', 'QUARANTINED'
);

-- AssetVersion.intake_state. Intake creates a pending version before any bytes
-- arrive (project-assets.md, "Intake Sequence"), so content_checksum,
-- size_bytes, and storage_key are absent until the content request completes.
-- An aborted intake removes the pending version and records nothing.
CREATE TYPE asset_intake_state AS ENUM (
  'PENDING', 'COMPLETE'
);

-- AssetVersion.malware_scan_state
CREATE TYPE malware_scan_state AS ENUM (
  'PENDING', 'CLEAN', 'INFECTED', 'FAILED'
);

-- AssetRepresentation.kind
CREATE TYPE asset_representation_kind AS ENUM (
  'ORIGINAL', 'CONVERTED', 'FEATURES', 'PREVIEW', 'TILES', 'MESH', 'TEXT',
  'GEOREFERENCE'
);

-- AssetRepresentation.status
CREATE TYPE asset_representation_status AS ENUM (
  'READY', 'STALE', 'FAILED'
);

-- AssetLink / AssetBinding role
CREATE TYPE asset_link_role AS ENUM (
  'SOURCE', 'EVIDENCE', 'REFERENCE', 'ATTACHMENT'
);

-- AssetLink.target discriminant
CREATE TYPE asset_link_target_kind AS ENUM (
  'PROJECT', 'SCENARIO', 'REVISION', 'ENTITY'
);

-- AssetJob.job_type. `job_state` and `review_state` already exist in 001.
CREATE TYPE asset_job_type AS ENUM (
  'SCAN', 'PROCESS'
);

-- ----------------------------------------------------------------------------
-- 2. Tables
-- ----------------------------------------------------------------------------

-- Model: project_assets. The logical file: project-scoped, tool-neutral, and
-- never revision-scoped. current_version_id is a deferred foreign key to
-- asset_versions, which cannot be declared inline because asset_versions
-- references this table in turn.
CREATE TABLE project_assets (
  asset_id              uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  name                  text NOT NULL,
  kind                  asset_kind NOT NULL,
  media_type            text NOT NULL,
  status                asset_status NOT NULL DEFAULT 'ACTIVE',
  access_classification asset_access_classification NOT NULL DEFAULT 'PROJECT',
  current_version_id    uuid NOT NULL,
  version_count         integer NOT NULL DEFAULT 0 CHECK (version_count >= 0),
  tags                  text[] NOT NULL DEFAULT '{}',
  retention_class       text NOT NULL DEFAULT 'PROJECT_ASSET',
  owner                 text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz,
  updated_by            uuid,
  PRIMARY KEY (asset_id, project_id),
  CONSTRAINT project_assets_name_check CHECK (length(btrim(name)) > 0),
  CONSTRAINT project_assets_media_type_check CHECK (length(btrim(media_type)) > 0),
  CONSTRAINT project_assets_owner_check CHECK (length(btrim(owner)) > 0)
);

-- Model: asset_versions. One immutable byte set. Both identities from the
-- specification are expressed here and both carry the tenant key:
--   * (asset_id, version_number) -- monotonic per asset.
--   * (project_id, content_checksum) -- deduplication after intake. Identical
--     bytes within one project resolve to one version row; the service reuses
--     that row rather than storing the object twice.
CREATE TABLE asset_versions (
  asset_version_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  asset_id                    uuid NOT NULL,
  version_number              integer NOT NULL CHECK (version_number > 0),
  intake_state                asset_intake_state NOT NULL DEFAULT 'PENDING',
  content_checksum            text CHECK (content_checksum IS NULL OR content_checksum ~ '^[0-9a-f]{64}$'),
  size_bytes                  bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  storage_key                 text,
  filename                    text NOT NULL,
  media_type                  text NOT NULL,
  malware_scan_state          malware_scan_state NOT NULL DEFAULT 'PENDING',
  status                      asset_version_status NOT NULL DEFAULT 'CURRENT',
  supersedes_asset_version_id uuid,
  source_ref                  text NOT NULL,
  provenance                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_at                 timestamptz NOT NULL DEFAULT now(),
  uploaded_by                 uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_at                  timestamptz,
  updated_by                  uuid,
  PRIMARY KEY (asset_version_id, project_id),
  CONSTRAINT asset_versions_asset_fk
    FOREIGN KEY (asset_id, project_id)
    REFERENCES project_assets (asset_id, project_id) ON DELETE CASCADE,
  CONSTRAINT asset_versions_supersedes_fk
    FOREIGN KEY (supersedes_asset_version_id, project_id)
    REFERENCES asset_versions (asset_version_id, project_id),
  CONSTRAINT asset_versions_number_key
    UNIQUE (asset_id, version_number, project_id),
  -- Versions are per-asset: an asset never holds the same bytes twice. Identical
  -- bytes across different assets share one stored object (see
  -- asset_versions_content_idx) rather than one version row, so each asset keeps
  -- its own version history and provenance (D24).
  CONSTRAINT asset_versions_checksum_key
    UNIQUE (asset_id, content_checksum, project_id),
  CONSTRAINT asset_versions_self_check
    CHECK (supersedes_asset_version_id IS NULL OR supersedes_asset_version_id <> asset_version_id),
  -- A version carries content identity exactly when its intake completed.
  CONSTRAINT asset_versions_intake_check
    CHECK (
      (intake_state = 'COMPLETE')
      = (content_checksum IS NOT NULL AND size_bytes IS NOT NULL AND storage_key IS NOT NULL)
    )
);

-- Model: asset_representations. Derived artifacts, keyed by producer so a new
-- producer version creates a new row and marks the old one STALE rather than
-- mutating it. storage_key is required for stored kinds; FEATURES and
-- GEOREFERENCE may be represented inline by their producer.
CREATE TABLE asset_representations (
  representation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  asset_version_id  uuid NOT NULL,
  kind              asset_representation_kind NOT NULL,
  media_type        text NOT NULL,
  content_checksum  text NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  storage_key       text,
  producer_id       text NOT NULL,
  producer_version  text NOT NULL,
  status            asset_representation_status NOT NULL DEFAULT 'READY',
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  PRIMARY KEY (representation_id, project_id),
  CONSTRAINT asset_representations_version_fk
    FOREIGN KEY (asset_version_id, project_id)
    REFERENCES asset_versions (asset_version_id, project_id) ON DELETE CASCADE,
  CONSTRAINT asset_representations_producer_key
    UNIQUE (asset_version_id, kind, producer_id, producer_version, project_id),
  CONSTRAINT asset_representations_storage_check
    CHECK (storage_key IS NOT NULL OR kind IN ('FEATURES', 'GEOREFERENCE')),
  CONSTRAINT asset_representations_producer_check
    CHECK (length(btrim(producer_id)) > 0 AND length(btrim(producer_version)) > 0)
);

-- Model: asset_links. A lightweight association that does not consume the
-- asset into a design. A PROJECT link needs no target_id; every other target
-- kind must name one.
CREATE TABLE asset_links (
  link_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  asset_version_id uuid NOT NULL,
  target_kind      asset_link_target_kind NOT NULL,
  target_id        uuid,
  role             asset_link_role NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  PRIMARY KEY (link_id, project_id),
  CONSTRAINT asset_links_version_fk
    FOREIGN KEY (asset_version_id, project_id)
    REFERENCES asset_versions (asset_version_id, project_id) ON DELETE CASCADE,
  CONSTRAINT asset_links_target_check
    CHECK (target_kind = 'PROJECT' OR target_id IS NOT NULL)
);

-- Model: asset_holds. A legal or regulatory hold overrides every retention
-- value (doc/workspace/retention.md, rule 1), and the deletion guard refuses a
-- delete while one is active. A hold names an asset or one exact version.
CREATE TABLE asset_holds (
  hold_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  asset_id         uuid,
  asset_version_id uuid,
  reason           text NOT NULL,
  authority        text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  released_at      timestamptz,
  released_by      uuid,
  released_reason  text,
  PRIMARY KEY (hold_id, project_id),
  CONSTRAINT asset_holds_asset_fk
    FOREIGN KEY (asset_id, project_id)
    REFERENCES project_assets (asset_id, project_id) ON DELETE CASCADE,
  CONSTRAINT asset_holds_version_fk
    FOREIGN KEY (asset_version_id, project_id)
    REFERENCES asset_versions (asset_version_id, project_id) ON DELETE CASCADE,
  CONSTRAINT asset_holds_target_check
    CHECK (asset_id IS NOT NULL OR asset_version_id IS NOT NULL),
  CONSTRAINT asset_holds_reason_check CHECK (length(btrim(reason)) > 0),
  CONSTRAINT asset_holds_release_check
    CHECK (released_at IS NULL OR released_by IS NOT NULL)
);

-- Model: asset_jobs. Scanning and processing job state at project scope. See
-- the file header for why this is not the facility `jobs` table.
CREATE TABLE asset_jobs (
  job_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  asset_version_id uuid,
  job_type         asset_job_type NOT NULL,
  state            job_state NOT NULL DEFAULT 'QUEUED',
  progress_pct     integer NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  requested_by     uuid,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  result           jsonb,
  error_message    text,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz,
  updated_by       uuid,
  PRIMARY KEY (job_id, project_id),
  CONSTRAINT asset_jobs_version_fk
    FOREIGN KEY (asset_version_id, project_id)
    REFERENCES asset_versions (asset_version_id, project_id) ON DELETE CASCADE,
  CONSTRAINT asset_jobs_completion_check
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

-- ----------------------------------------------------------------------------
-- 3. Secondary indexes
-- ----------------------------------------------------------------------------

CREATE INDEX project_assets_project_status_idx
  ON project_assets (project_id, status, kind);

CREATE INDEX asset_versions_asset_idx
  ON asset_versions (project_id, asset_id, version_number DESC);

-- Project-level content index: the deduplication lookup. Not unique, because a
-- version is per-asset (D24); its purpose is to find an already-stored object
-- for the same bytes so a second asset does not write a second object.
CREATE INDEX asset_versions_content_idx
  ON asset_versions (project_id, content_checksum);

CREATE INDEX asset_versions_scan_state_idx
  ON asset_versions (project_id, malware_scan_state)
  WHERE malware_scan_state <> 'CLEAN';

CREATE INDEX asset_representations_version_idx
  ON asset_representations (project_id, asset_version_id, kind);

CREATE INDEX asset_links_version_idx
  ON asset_links (project_id, asset_version_id);

CREATE INDEX asset_links_target_idx
  ON asset_links (project_id, target_kind, target_id);

CREATE INDEX asset_holds_asset_idx
  ON asset_holds (project_id, asset_id)
  WHERE released_at IS NULL;

CREATE INDEX asset_holds_version_idx
  ON asset_holds (project_id, asset_version_id)
  WHERE released_at IS NULL;

CREATE INDEX asset_jobs_version_idx
  ON asset_jobs (project_id, asset_version_id, state);

-- ----------------------------------------------------------------------------
-- 4. Deferred foreign keys and outbox adjustment
-- ----------------------------------------------------------------------------

-- Asset events are project-scoped and carry no scenario. `outbox_events` made
-- scenario_id NOT NULL for facility events; relax it so the one workspace
-- outbox can carry both. An asset event leaves scenario_id and revision_id
-- NULL, and a composite foreign key with a NULL column is not enforced
-- (MATCH SIMPLE), which is exactly the intended behaviour here.
ALTER TABLE outbox_events ALTER COLUMN scenario_id DROP NOT NULL;

-- project_assets.current_version_id -> asset_versions. Declared after both
-- tables exist, and DEFERRABLE because intake creates the asset and its pending
-- version in one transaction: at the moment the asset row is inserted its
-- current version does not exist yet, and the check must run at commit. ON
-- DELETE RESTRICT: a current version is never removed while the asset points at
-- it.
ALTER TABLE project_assets
  ADD CONSTRAINT project_assets_current_version_fk
  FOREIGN KEY (current_version_id, project_id)
  REFERENCES asset_versions (asset_version_id, project_id)
  DEFERRABLE INITIALLY DEFERRED;

-- ----------------------------------------------------------------------------
-- 5. Row-level security
--
-- The catalog-driven loop from 001, repeated because these tables did not exist
-- when it ran. It is idempotent: a table that already carries a policy is
-- skipped, and a table without project_id is never selected.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
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

-- End of migration 003_project_assets.sql
