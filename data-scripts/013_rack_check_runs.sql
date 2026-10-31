-- Immutable evidence for scoped saved-plan checks; not engineering validation.
CREATE TABLE rack_check_runs (
  run_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  plan_version integer NOT NULL CHECK (plan_version >= 1),
  snapshot_id uuid NOT NULL,
  input_hash text NOT NULL CHECK (length(input_hash) = 64),
  ruleset text NOT NULL,
  command_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  spatial_report jsonb NOT NULL CHECK (jsonb_typeof(spatial_report) = 'object'),
  equipment_report jsonb NOT NULL CHECK (jsonb_typeof(equipment_report) = 'object'),
  created_by uuid NOT NULL REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, project_id) REFERENCES rack_plans(plan_id, project_id) ON DELETE CASCADE,
  UNIQUE (project_id, plan_id, command_key)
);
CREATE INDEX rack_check_runs_recent ON rack_check_runs(project_id, plan_id, created_at DESC, run_id DESC);
ALTER TABLE rack_check_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rack_check_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY rack_check_run_isolation ON rack_check_runs
  USING (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
  WITH CHECK (project_id = nullif(current_setting('app.project_id', true), '')::uuid);
COMMENT ON TABLE rack_check_runs IS
  'Append-only through Rack services: saved spatial/equipment check evidence. No engineering certification or approval.';
