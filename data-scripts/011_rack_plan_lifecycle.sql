-- Recoverable plan deletion. Keep snapshot, placements, equipment and command history.
ALTER TABLE rack_plans ADD COLUMN deleted_at timestamptz;
ALTER TABLE rack_plans ADD COLUMN deleted_by uuid REFERENCES users(user_id);
ALTER TABLE rack_plans ADD CONSTRAINT rack_plan_deletion_actor CHECK
  ((deleted_at IS NULL) = (deleted_by IS NULL));
CREATE INDEX rack_plans_active_list_idx ON rack_plans(project_id, created_at DESC, plan_id DESC)
  WHERE deleted_at IS NULL;
COMMENT ON COLUMN rack_plans.deleted_at IS
  'Soft deletion; active list and all layout operations exclude deleted plans. Restore via versioned Rack lifecycle operation.';
