-- Local invited users need project discovery, without organisation-wide tool grants.
INSERT INTO roles(role_key,name,scope_hint,description) VALUES
  ('organisation-member','Organisation member','organisation',
   'Discovers organisation project metadata without granting tool-content access.')
ON CONFLICT(role_key) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.role_id,p.permission_id FROM roles r CROSS JOIN permissions p
WHERE r.role_key='organisation-member' AND p.key='project.read'
ON CONFLICT DO NOTHING;
