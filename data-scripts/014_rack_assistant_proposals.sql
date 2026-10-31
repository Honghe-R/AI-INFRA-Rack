CREATE TABLE rack_assistant_proposals (
  proposal_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(user_id),
  base_version integer NOT NULL CHECK (base_version >= 1),
  snapshot_id uuid NOT NULL,
  save_body jsonb NOT NULL CHECK (jsonb_typeof(save_body) = 'object'),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array'),
  command_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  applied_version integer,
  applied_at timestamptz,
  CHECK ((applied_version IS NULL AND applied_at IS NULL) OR
         (applied_version = base_version + 1 AND applied_at IS NOT NULL)),
  FOREIGN KEY (plan_id, project_id) REFERENCES rack_plans(plan_id, project_id) ON DELETE CASCADE
);
CREATE INDEX rack_assistant_proposals_owner ON rack_assistant_proposals(project_id, plan_id, created_by, created_at DESC);
ALTER TABLE rack_assistant_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE rack_assistant_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY rack_assistant_proposal_isolation ON rack_assistant_proposals
 USING (project_id = nullif(current_setting('app.project_id', true), '')::uuid)
 WITH CHECK (project_id = nullif(current_setting('app.project_id', true), '')::uuid);
