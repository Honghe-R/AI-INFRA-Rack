-- ============================================================================
--  004_asset_access_grants.sql
--  Project asset access grants (schema version 004).
--
--  Implements doc/workspace/project-assets.md, "Access Control": a RESTRICTED
--  asset requires an explicit grant in addition to project membership.
--
--  A grant is per asset and per user. Project membership plus `asset.write`
--  authorizes granting and revoking; it does not by itself authorize reading a
--  restricted asset. The uploader of a RESTRICTED asset is granted on creation,
--  so the creator never loses access to what they just uploaded.
--
--  This is a new migration rather than an edit to 003: 003 is applied and
--  migrations are immutable (packages/db/src/migrate.js).
--
--  Target: PostgreSQL 16. Extensions, projects, and users already exist.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------------------

CREATE TABLE asset_access_grants (
  grant_id   uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  asset_id   uuid NOT NULL,
  grantee_id uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  PRIMARY KEY (grant_id, project_id),
  CONSTRAINT asset_access_grants_asset_fk
    FOREIGN KEY (asset_id, project_id)
    REFERENCES project_assets (asset_id, project_id) ON DELETE CASCADE,
  -- One live grant per asset and grantee. A revoked grant keeps its row for
  -- audit and is excluded from the partial index below.
  CONSTRAINT asset_access_grants_grantee_key
    UNIQUE (asset_id, grantee_id, project_id),
  CONSTRAINT asset_access_grants_revoke_check
    CHECK (revoked_at IS NULL OR revoked_by IS NOT NULL)
);

-- ----------------------------------------------------------------------------
-- 2. Index
-- ----------------------------------------------------------------------------

CREATE INDEX asset_access_grants_live_idx
  ON asset_access_grants (project_id, asset_id, grantee_id)
  WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- 3. Row-level security
--
-- The catalog-driven loop from 001, repeated for this table.
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

-- End of migration 004_asset_access_grants.sql
