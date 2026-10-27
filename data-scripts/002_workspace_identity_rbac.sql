-- ============================================================================
--  002_workspace_identity_rbac.sql
--  Workspace identity and role-based access control (milestone W1).
--
--  Implements doc/workspace/rbac-architecture-blueprint.md, constrained by the
--  W0 porting decisions:
--    * R1  no deny path — permission is the presence of an allow;
--    * R2  suspension removes the assignment, so a non-active membership grants
--          nothing (the evaluator's grantedKeys excludes it);
--    * R4  no direct per-user grant table, and therefore no administration
--          surface for one;
--    * R5  one catalog owner — the permission rows seeded here are a copy of
--           packages/rbac/src/catalog.js and a drift test compares the two.
--
--  Scope naming: the blueprint's `workspace` scope is this platform's `project`
--  scope. `scope_kind` uses global | organisation | project.
--
--  These are platform-level tables keyed by user, organisation, and scope — not
--  by project — so they are deliberately NOT placed under the project row-level
--  security policy that protects tool data. The evaluator reads a user's
--  assignments across every scope, and a project-scoped policy would hide exactly
--  the rows it needs. Access is guarded by the API authorization layer and by the
--  privileges granted to the application role.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Identity
-- ----------------------------------------------------------------------------

CREATE TABLE users (
  user_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject      text NOT NULL UNIQUE,          -- the OIDC subject claim
  email        text,
  display_name text,
  status       text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz
);

CREATE TABLE organizations (
  organization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz
);

-- Membership carries the suspension state that evaluation must consult. A
-- suspended membership contributes no assignment (porting decision R2).
CREATE TABLE organization_memberships (
  membership_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  UNIQUE (organization_id, user_id)
);

CREATE TABLE project_memberships (
  membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  UNIQUE (project_id, user_id)
);

-- A project belongs to exactly one organisation. The column already existed; the
-- constraint is added now that organizations exists.
ALTER TABLE projects
  ADD CONSTRAINT projects_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organizations (organization_id);

-- A showcase project exposes a fixed read-only key set to authenticated users
-- (blueprint §5 step 7). Read-only sharing is otherwise done with expiring share
-- grants, never a public role (porting decision R3).
ALTER TABLE projects
  ADD COLUMN showcase boolean NOT NULL DEFAULT false;

-- Organisation-scoped visibility, as an additional permissive policy: a session
-- that has resolved an organisation may read that organisation's projects.
-- Project-scoped sessions keep the narrower project policy from migration 001.
CREATE POLICY projects_organisation_isolation ON projects
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- 2. Catalog, roles, and assignment
-- ----------------------------------------------------------------------------

CREATE TABLE permissions (
  permission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('system', 'organisation', 'project', 'global')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  role_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key    text NOT NULL UNIQUE,
  name        text NOT NULL,
  scope_hint  text NOT NULL CHECK (scope_hint IN ('system', 'organisation', 'project')),
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles (role_id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions (permission_id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

-- One role per user per concrete scope: reassignment replaces rather than stacks
-- (blueprint §4). UNIQUE NULLS NOT DISTINCT makes that hold for the global scope
-- too, where scope_id is null and a plain unique constraint would treat every
-- row as distinct.
CREATE TABLE role_assignments (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES roles (role_id) ON DELETE CASCADE,
  scope_kind    text NOT NULL CHECK (scope_kind IN ('global', 'organisation', 'project')),
  scope_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users (user_id),
  updated_at    timestamptz,
  CONSTRAINT role_assignments_scope_check CHECK (
    (scope_kind = 'global' AND scope_id IS NULL)
    OR (scope_kind <> 'global' AND scope_id IS NOT NULL)
  ),
  CONSTRAINT role_assignments_one_role_per_scope
    UNIQUE NULLS NOT DISTINCT (user_id, scope_kind, scope_id)
);

CREATE INDEX role_assignments_user_idx ON role_assignments (user_id);
CREATE INDEX role_assignments_scope_idx ON role_assignments (scope_kind, scope_id);
CREATE INDEX role_permissions_permission_idx ON role_permissions (permission_id);
CREATE INDEX organization_memberships_user_idx ON organization_memberships (user_id);
CREATE INDEX project_memberships_user_idx ON project_memberships (user_id);

-- ----------------------------------------------------------------------------
-- 3. Seed the canonical catalog and the role presets
--
-- Generated from packages/rbac/src/{catalog,presets}.js. Do not hand-edit: a
-- drift test compares these rows with the code constants and fails the build on
-- a mismatch.
-- ----------------------------------------------------------------------------

INSERT INTO permissions (key, name, description, scope) VALUES
  ('project.read', 'Read projects', 'Read project and scenario metadata.', 'project'),
  ('project.write', 'Write projects', 'Create and edit projects and scenarios.', 'project'),
  ('project.member.manage', 'Manage project members', 'Assign and revoke project-scoped roles.', 'project'),
  ('asset.read', 'Read assets', 'Read project assets, versions, and representations.', 'project'),
  ('asset.write', 'Write assets', 'Create asset versions, process, reclassify, and archive.', 'project'),
  ('asset.delete', 'Delete assets', 'Delete an asset under the reference and retention guards.', 'project'),
  ('org.read', 'Read organisation', 'Read organisation metadata and its members.', 'organisation'),
  ('org.admin', 'Administer organisation', 'Manage organisation membership and role mappings.', 'organisation'),
  ('organisation.create', 'Create organisation', 'Bootstrap the first organisation for a new account.', 'global'),
  ('system.admin', 'System administration', 'Administer roles, keys, and assignments across tenants.', 'system'),
  ('system.catalog.manage', 'Manage permission catalog', 'Register permission keys and edit role mappings.', 'system'),
  ('facility.read', 'Read facility design', 'Read envelopes, entities, geometry, diagnostics, and jobs.', 'project'),
  ('facility.draft.create', 'Create facility draft', 'Create and branch facility revisions.', 'project'),
  ('facility.entity.write', 'Write facility entities', 'Create and update facility entities.', 'project'),
  ('facility.geometry.write', 'Write facility geometry', 'Create and replace geometry records.', 'project'),
  ('facility.constraint.write', 'Write spatial constraints', 'Create and update spatial constraints.', 'project'),
  ('facility.utility.write', 'Write utility sources', 'Create and update utility sources and interfaces.', 'project'),
  ('facility.phase.write', 'Write facility phases', 'Create and update phases and dependencies.', 'project'),
  ('facility.import.initiate', 'Initiate import', 'Bind a project asset version to a revision.', 'project'),
  ('facility.import.map', 'Map import content', 'Author and review import mappings and transforms.', 'project'),
  ('facility.import.apply', 'Apply import', 'Apply mapped content into the draft.', 'project'),
  ('facility.validate.run', 'Run validation', 'Run local or full validation.', 'project'),
  ('facility.capacity.request', 'Request capacity', 'Submit a capacity demand request.', 'project'),
  ('facility.capacity.allocate', 'Allocate capacity', 'Accept or reject capacity allocations.', 'project'),
  ('facility.publish', 'Publish revision', 'Publish a validated facility revision.', 'project'),
  ('facility.approve', 'Approve revision', 'Record an approval attestation.', 'project'),
  ('facility.waiver.grant', 'Grant waiver', 'Grant a scoped waiver over named diagnostics.', 'project'),
  ('facility.document.manage', 'Manage documents', 'Attach and detach document metadata.', 'project'),
  ('facility.export', 'Export design', 'Generate and download exports and reports.', 'project'),
  ('facility.share', 'Share draft context', 'Share a draft read-only with a recipient or tool.', 'project')
ON CONFLICT (key) DO NOTHING;

INSERT INTO roles (role_key, name, scope_hint, description) VALUES
  ('system-admin', 'System administrator', 'system', 'Administers roles, key mappings, and assignments. Holds no blanket content access by design.'),
  ('organisation-admin', 'Organisation administrator', 'organisation', 'Administers membership and project structure within one organisation.'),
  ('project-admin', 'Project administrator', 'project', 'Full authoring and governance authority within one project.'),
  ('project-editor', 'Project editor', 'project', 'Authors and validates design content but cannot publish, approve, or grant waivers.'),
  ('project-viewer', 'Project viewer', 'project', 'Read-only access to project content.')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
  ('system-admin', 'system.admin'),
  ('system-admin', 'system.catalog.manage'),
  ('system-admin', 'org.read'),
  ('system-admin', 'project.read'),
  ('organisation-admin', 'org.read'),
  ('organisation-admin', 'org.admin'),
  ('organisation-admin', 'project.read'),
  ('organisation-admin', 'project.write'),
  ('organisation-admin', 'project.member.manage'),
  ('organisation-admin', 'asset.read'),
  ('organisation-admin', 'asset.write'),
  ('organisation-admin', 'asset.delete'),
  ('organisation-admin', 'facility.read'),
  ('project-admin', 'project.read'),
  ('project-admin', 'project.write'),
  ('project-admin', 'project.member.manage'),
  ('project-admin', 'asset.read'),
  ('project-admin', 'asset.write'),
  ('project-admin', 'asset.delete'),
  ('project-admin', 'facility.read'),
  ('project-admin', 'facility.draft.create'),
  ('project-admin', 'facility.entity.write'),
  ('project-admin', 'facility.geometry.write'),
  ('project-admin', 'facility.constraint.write'),
  ('project-admin', 'facility.utility.write'),
  ('project-admin', 'facility.phase.write'),
  ('project-admin', 'facility.import.initiate'),
  ('project-admin', 'facility.import.map'),
  ('project-admin', 'facility.import.apply'),
  ('project-admin', 'facility.validate.run'),
  ('project-admin', 'facility.capacity.request'),
  ('project-admin', 'facility.capacity.allocate'),
  ('project-admin', 'facility.publish'),
  ('project-admin', 'facility.approve'),
  ('project-admin', 'facility.waiver.grant'),
  ('project-admin', 'facility.document.manage'),
  ('project-admin', 'facility.export'),
  ('project-admin', 'facility.share'),
  ('project-editor', 'project.read'),
  ('project-editor', 'asset.read'),
  ('project-editor', 'asset.write'),
  ('project-editor', 'facility.read'),
  ('project-editor', 'facility.draft.create'),
  ('project-editor', 'facility.entity.write'),
  ('project-editor', 'facility.geometry.write'),
  ('project-editor', 'facility.constraint.write'),
  ('project-editor', 'facility.utility.write'),
  ('project-editor', 'facility.phase.write'),
  ('project-editor', 'facility.import.initiate'),
  ('project-editor', 'facility.import.map'),
  ('project-editor', 'facility.import.apply'),
  ('project-editor', 'facility.validate.run'),
  ('project-editor', 'facility.capacity.request'),
  ('project-editor', 'facility.export'),
  ('project-editor', 'facility.share'),
  ('project-viewer', 'project.read'),
  ('project-viewer', 'asset.read'),
  ('project-viewer', 'facility.read')
) AS mapping(role_key, permission_key)
JOIN roles r ON r.role_key = mapping.role_key
JOIN permissions p ON p.key = mapping.permission_key
ON CONFLICT DO NOTHING;

-- End of migration 002_workspace_identity_rbac.sql
