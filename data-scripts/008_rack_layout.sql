-- Editing is an independent Rack version; existing Facility revisions stay untouched.
ALTER TABLE rack_plans DROP CONSTRAINT rack_plans_version_check;
ALTER TABLE rack_plans ADD CONSTRAINT rack_plans_version_check CHECK (version >= 1);
ALTER TABLE rack_plans ADD COLUMN updated_at timestamptz;
ALTER TABLE rack_plans ADD COLUMN updated_by uuid REFERENCES users(user_id);

CREATE TABLE rack_models (
  model_id uuid PRIMARY KEY,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object')
);
-- Immutable, deliberately assumed demonstration models. No engineering capacity is asserted.
INSERT INTO rack_models VALUES
('10000000-0000-4000-8000-000000000001', '{"modelId":"10000000-0000-4000-8000-000000000001","name":"Demo 600 × 1200 mm / 42U","widthM":0.6,"depthM":1.2,"heightU":42,"maxWeightKg":null,"maxPowerKw":null,"maxCoolingKw":null,"source":{"kind":"ASSUMED","reference":"Course demonstration assumption; not a vendor or engineering specification."}}'),
('10000000-0000-4000-8000-000000000002', '{"modelId":"10000000-0000-4000-8000-000000000002","name":"Demo 800 × 1200 mm / 42U","widthM":0.8,"depthM":1.2,"heightU":42,"maxWeightKg":null,"maxPowerKw":null,"maxCoolingKw":null,"source":{"kind":"ASSUMED","reference":"Course demonstration assumption; not a vendor or engineering specification."}}');

CREATE TABLE rack_room_snapshots (
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  snapshot_id uuid NOT NULL DEFAULT gen_random_uuid(),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users(user_id),
  PRIMARY KEY (plan_id, project_id),
  UNIQUE (snapshot_id, project_id),
  FOREIGN KEY (plan_id, project_id) REFERENCES rack_plans(plan_id, project_id) ON DELETE CASCADE
);
CREATE TABLE rack_placements (
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  rack_id uuid NOT NULL,
  model_id uuid NOT NULL REFERENCES rack_models(model_id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160 AND length(btrim(name)) > 0),
  x_m double precision NOT NULL CHECK (x_m BETWEEN -10000 AND 20000),
  y_m double precision NOT NULL CHECK (y_m BETWEEN -10000 AND 20000),
  rotation_deg integer NOT NULL CHECK (rotation_deg IN (0,90,180,270)),
  locked boolean NOT NULL DEFAULT false,
  PRIMARY KEY (rack_id, plan_id, project_id),
  FOREIGN KEY (plan_id, project_id) REFERENCES rack_room_snapshots(plan_id, project_id) ON DELETE CASCADE
);
CREATE INDEX rack_placements_plan_idx ON rack_placements(project_id,plan_id);
CREATE TABLE rack_layout_commands (
  project_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  command_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash)=64),
  applied_version integer NOT NULL CHECK (applied_version>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users(user_id),
  PRIMARY KEY (project_id, plan_id, command_key),
  FOREIGN KEY (plan_id,project_id) REFERENCES rack_plans(plan_id,project_id) ON DELETE CASCADE
);
ALTER TABLE rack_room_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE rack_room_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY rack_snapshot_isolation ON rack_room_snapshots
 USING (project_id=nullif(current_setting('app.project_id',true),'')::uuid)
 WITH CHECK (project_id=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE rack_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE rack_placements FORCE ROW LEVEL SECURITY;
CREATE POLICY rack_placement_isolation ON rack_placements
 USING (project_id=nullif(current_setting('app.project_id',true),'')::uuid)
 WITH CHECK (project_id=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE rack_layout_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE rack_layout_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY rack_command_isolation ON rack_layout_commands
 USING (project_id=nullif(current_setting('app.project_id',true),'')::uuid)
 WITH CHECK (project_id=nullif(current_setting('app.project_id',true),'')::uuid);
COMMENT ON TABLE rack_models IS 'Shared immutable assumed demonstration catalog. No write API; replace via a new model ID, never reinterpret existing placements.';
COMMENT ON TABLE rack_plans IS 'Versioned Rack layout draft; validation_state NOT_RUN until complete validation is implemented.';
