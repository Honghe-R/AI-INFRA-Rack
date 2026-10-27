-- ============================================================================
--  005_map_tile_proxy.sql
--  Workspace basemap tile proxy (schema version 005).
--
--  Implements D16 and doc/workspace/import-adapters.md's map tile rules: the
--  permission keys the proxy authorizes against, the per-project provider
--  selection, and the metering table's project-scoped shape.
--
--  map_tile_usage itself is created by 001 (section 3.7). Two changes are needed:
--    * the three map.* permission keys, seeded from packages/rbac/src/catalog.js
--      and granted through the existing role presets;
--    * scenario_id becomes nullable, because a tile request is project-scoped and
--      carries no scenario. The counter identity never included it.
--
--  Target: PostgreSQL 16.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Permission keys and preset grants
--
-- Generated from packages/rbac/src/{catalog,presets}.js. Do not hand-edit: the
-- catalog drift test compares these rows with the code constants.
-- ----------------------------------------------------------------------------

INSERT INTO permissions (key, name, description, scope) VALUES
  ('map.read', 'Read basemap', 'Request proxied basemap tiles and provider metadata for a project.', 'project'),
  ('map.usage.read', 'Read basemap usage', 'Read tile usage, quota, and provider health for a project.', 'project'),
  ('map.manage', 'Manage basemap', 'Select the project basemap provider, style, and tile quota.', 'project')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
  ('organisation-admin', 'map.read'),
  ('organisation-admin', 'map.usage.read'),
  ('organisation-admin', 'map.manage'),
  ('project-admin', 'map.read'),
  ('project-admin', 'map.usage.read'),
  ('project-admin', 'map.manage'),
  ('project-editor', 'map.read'),
  ('project-viewer', 'map.read')
) AS grants(role_key, permission_key)
JOIN roles r ON r.role_key = grants.role_key
JOIN permissions p ON p.key = grants.permission_key
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Per-project provider selection
--
-- The provider descriptors themselves are configuration (packages/maps), not
-- rows: a deployment registers the providers it is licensed for. This table
-- stores only which one a project chose, its style, and its quota.
-- ----------------------------------------------------------------------------

CREATE TABLE project_map_settings (
  project_id       uuid PRIMARY KEY REFERENCES projects (project_id) ON DELETE CASCADE,
  provider_id      text NOT NULL,
  style            text,
  tile_quota       bigint CHECK (tile_quota IS NULL OR tile_quota >= 0),
  attribution_text text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz,
  updated_by       uuid,
  CONSTRAINT project_map_settings_provider_check CHECK (length(btrim(provider_id)) > 0)
);

-- ----------------------------------------------------------------------------
-- 3. Metering is project-scoped
-- ----------------------------------------------------------------------------

ALTER TABLE map_tile_usage ALTER COLUMN scenario_id DROP NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. Row-level security
--
-- The catalog-driven loop from 001, repeated because project_map_settings did not
-- exist when it ran. map_tile_usage already carries its policy.
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
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format(
      'CREATE POLICY project_isolation ON public.%I '
      'USING (project_id = nullif(current_setting(''app.project_id'', true), '''')::uuid) '
      'WITH CHECK (project_id = nullif(current_setting(''app.project_id'', true), '''')::uuid)',
      r.relname
    );
  END LOOP;
END
$$;

-- End of migration 005_map_tile_proxy.sql
