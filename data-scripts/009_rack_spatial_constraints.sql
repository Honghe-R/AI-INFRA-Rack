-- Rack-owned planning assumptions; no Facility geometry or immutable snapshot is changed.
ALTER TABLE rack_plans ADD COLUMN spatial_constraints jsonb NOT NULL DEFAULT
'{"obstacleCoverage":"UNKNOWN","source":{"kind":"ASSUMED","reference":"Planning inputs not recorded."},"obstacles":[],"clearance":null}'::jsonb
CHECK (jsonb_typeof(spatial_constraints)='object');
COMMENT ON COLUMN rack_plans.spatial_constraints IS 'Versioned planning inputs, not surveyed Facility obstacles. API validates limits and topology; null clearance means not checked.';
