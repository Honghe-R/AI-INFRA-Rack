-- ============================================================================
--  006_assistant_host.sql
--  Workspace assistant host (schema version 006).
--
--  Implements doc/workspace/chatbox-llm-architecture-blueprint.md §4.9 and §4.10:
--  a relational session index, a turn index that makes request-id deduplication a
--  unique constraint, and an append-only usage log that is the source of truth for
--  every balance view.
--
--  Turn CONTENT lives in private object storage (gzipped manifest plus one object
--  per turn); these tables index it and authorize access to it.
--
--  Target: PostgreSQL 16.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Session index
-- ----------------------------------------------------------------------------

CREATE TABLE assistant_sessions (
  session_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  context_key      text NOT NULL,
  surface          text,
  workspace_id     uuid,
  organisation_id  uuid,
  title            text,
  turn_count       integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  last_activity_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  CONSTRAINT assistant_sessions_context_check CHECK (length(btrim(context_key)) > 0)
);

CREATE INDEX assistant_sessions_owner_idx
  ON assistant_sessions (user_id, context_key, last_activity_at DESC);

-- One row per stored turn. UNIQUE (session_id, request_id) is what makes a
-- retried request idempotent: the second insert claims nothing.
CREATE TABLE assistant_turns (
  session_id   uuid NOT NULL REFERENCES assistant_sessions (session_id) ON DELETE CASCADE,
  turn_number  integer NOT NULL CHECK (turn_number > 0),
  request_id   uuid NOT NULL,
  storage_key  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, turn_number),
  CONSTRAINT assistant_turns_request_key UNIQUE (session_id, request_id)
);

-- ----------------------------------------------------------------------------
-- 2. Append-only usage log
--
-- Every balance view is re-aggregated from this table rather than trusting an
-- incrementing counter (blueprint §4.10). A trigger enforces append-only so the
-- ledger cannot be edited by accident or by a later handler.
-- ----------------------------------------------------------------------------

CREATE TABLE assistant_usage_log (
  usage_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid,
  request_id          uuid,
  user_id             uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  organisation_id     uuid,
  workspace_id        uuid,
  context_key         text,
  scope_kind          text NOT NULL CHECK (scope_kind IN ('user', 'organisation', 'workspace')),
  scope_id            uuid NOT NULL,
  provider            text,
  model               text,
  prompt_tokens       integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens   integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens        integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  cached_output_tokens integer NOT NULL DEFAULT 0 CHECK (cached_output_tokens >= 0),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assistant_usage_scope_idx
  ON assistant_usage_log (scope_kind, scope_id, created_at);

CREATE INDEX assistant_usage_user_idx
  ON assistant_usage_log (user_id, created_at);

-- In-place edits are refused: the ledger is append-only, and every balance view
-- is re-aggregated from it. Deletes are left to the governed retention and
-- erasure paths (which also need to satisfy the foreign key from users), so only
-- UPDATE is blocked here.
CREATE OR REPLACE FUNCTION assistant_usage_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'assistant_usage_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assistant_usage_log_no_update
  BEFORE UPDATE ON assistant_usage_log
  FOR EACH ROW EXECUTE FUNCTION assistant_usage_log_append_only();

-- End of migration 006_assistant_host.sql
