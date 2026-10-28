-- Plan-local assumed equipment specifications and assignments. No Facility change.
ALTER TABLE rack_plans ADD COLUMN equipment jsonb NOT NULL DEFAULT
'{"coverage":"UNKNOWN","source":{"kind":"ASSUMED","reference":"Equipment planning inputs not recorded."},"devices":[],"rackLimits":[]}'::jsonb
CHECK (jsonb_typeof(equipment)='object');
COMMENT ON COLUMN rack_plans.equipment IS 'Versioned plan-local equipment inventory and capacity assumptions. Validated atomically with layout by API; not a global asset registry or engineering certificate.';
