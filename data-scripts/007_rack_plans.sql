-- First Rack persistence slice: empty independent plans, not equipment or layout storage.
-- Existing migrations stay immutable. Facility data is referenced, never updated here.
INSERT INTO permissions (key, name, description, scope) VALUES
  ('rack.read', 'Read Rack plans', 'Read Rack plans and their facility source status.', 'project'),
  ('rack.write', 'Write Rack plans', 'Create Rack plans within a project.', 'project')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM (VALUES
  ('organisation-admin', 'rack.read'),
  ('project-admin', 'rack.read'), ('project-admin', 'rack.write'),
  ('project-editor', 'rack.read'), ('project-editor', 'rack.write'),
  ('project-viewer', 'rack.read')
) AS grants(role_key, permission_key)
JOIN roles r ON r.role_key = grants.role_key
JOIN permissions p ON p.key = grants.permission_key
ON CONFLICT DO NOTHING;

CREATE TABLE rack_plans (
  plan_id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  scenario_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  source_container_id uuid NOT NULL,
  source_revision_etag text NOT NULL CHECK (
    length(source_revision_etag) BETWEEN 1 AND 512
    AND btrim(source_revision_etag) = source_revision_etag
    AND source_revision_etag !~ '[[:cntrl:]]'
  ),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160 AND length(btrim(name)) > 0),
  contract_version integer NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state = 'DRAFT'),
  validation_state text NOT NULL DEFAULT 'NOT_RUN' CHECK (validation_state = 'NOT_RUN'),
  creation_key uuid NOT NULL,
  creation_hash text NOT NULL CHECK (creation_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, project_id),
  UNIQUE (project_id, creation_key),
  FOREIGN KEY (source_revision_id, project_id, scenario_id)
    REFERENCES revisions(revision_id, project_id, scenario_id),
  FOREIGN KEY (source_container_id, source_revision_id, project_id)
    REFERENCES facility_containers(container_id, revision_id, project_id)
);
CREATE INDEX rack_plans_source_idx ON rack_plans(project_id, source_revision_id, source_container_id);

ALTER TABLE rack_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE rack_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY rack_plans_project_isolation ON rack_plans
  USING (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  WITH CHECK (project_id = nullif(current_setting('app.project_id', true), '')::uuid);

COMMENT ON TABLE rack_plans IS
  'Empty Rack drafts only. No placements, room geometry snapshot, checksum, editing or publishing yet.';
