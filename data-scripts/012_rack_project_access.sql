-- Rack lifecycle authority is separate from everyday editing.
INSERT INTO permissions (key, name, description, scope) VALUES
  ('rack.delete', 'Delete Rack plans', 'Soft-delete complete Rack plans within a project.', 'project'),
  ('rack.restore', 'Restore Rack plans', 'Restore soft-deleted Rack plans within a project.', 'project')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM roles r CROSS JOIN permissions p
WHERE r.role_key = 'project-admin' AND p.key IN ('rack.delete', 'rack.restore')
ON CONFLICT DO NOTHING;

ALTER TABLE project_memberships ADD COLUMN access_version integer NOT NULL DEFAULT 1
  CHECK (access_version > 0);

CREATE FUNCTION bump_project_membership_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.access_version := OLD.access_version + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_membership_version BEFORE UPDATE ON project_memberships
  FOR EACH ROW EXECUTE FUNCTION bump_project_membership_version();

-- Cover the inherited assignment repository as well as the project access UI.
CREATE FUNCTION bump_project_assignment_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.scope_kind = 'project' THEN
    UPDATE project_memberships SET updated_at = now()
      WHERE project_id = OLD.scope_id AND user_id = OLD.user_id;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.scope_kind = 'project' THEN
    IF TG_OP = 'INSERT' THEN
      UPDATE project_memberships SET updated_at = now()
        WHERE project_id = NEW.scope_id AND user_id = NEW.user_id;
    ELSIF OLD.scope_kind IS DISTINCT FROM NEW.scope_kind
       OR OLD.scope_id IS DISTINCT FROM NEW.scope_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
      UPDATE project_memberships SET updated_at = now()
        WHERE project_id = NEW.scope_id AND user_id = NEW.user_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER project_assignment_version AFTER INSERT OR UPDATE OR DELETE ON role_assignments
  FOR EACH ROW EXECUTE FUNCTION bump_project_assignment_version();

CREATE TABLE project_access_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES users(user_id),
  actor_user_id uuid NOT NULL REFERENCES users(user_id),
  action text NOT NULL CHECK (action IN ('ADD', 'CHANGE')),
  before_access jsonb,
  after_access jsonb NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_access_events_recent ON project_access_events(project_id, created_at DESC, event_id DESC);
ALTER TABLE project_access_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_access_events FORCE ROW LEVEL SECURITY;
CREATE POLICY project_access_events_isolation ON project_access_events
  USING (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  WITH CHECK (project_id = nullif(current_setting('app.project_id', true), '')::uuid);
COMMENT ON TABLE project_access_events IS
  'Transactional project access events. Only project.member.manage routes expose these; no credentials or request bodies.';
