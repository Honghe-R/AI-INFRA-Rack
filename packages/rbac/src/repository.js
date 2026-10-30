import { isKnownKey } from './catalog.js';
import { getPreset } from './presets.js';

/**
 * PostgreSQL implementation of the evaluator's repository port, plus the
 * operations the administration surface needs.
 *
 * Two invariants live in SQL rather than in the evaluator:
 *
 *  * **Suspension removes permission** (porting decision R2). `grantedKeys`
 *    requires an ACTIVE membership for project and organisation scope and an
 *    ACTIVE user account for every scope, so a suspended membership or account
 *    contributes nothing without deleting the assignment.
 *  * **One role per user per scope** (blueprint §4). `assignRole` upserts against
 *    the `role_assignments_one_role_per_scope` constraint, so reassignment
 *    replaces rather than stacks.
 *
 * `getProject` reads `projects`, which is under project row-level security.
 * Callers must therefore run it with the session scoped to that project, or hold
 * a role that bypasses the policy.
 */
export function createRbacRepository({ pool }) {
  if (!pool) throw new Error('createRbacRepository requires a pool.');

  async function query(text, values) {
    const result = await pool.query(text, values);
    return result.rows;
  }

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  const grantedKeysSql = {
    project: `
      SELECT DISTINCT p.key
      FROM role_assignments ra
      JOIN users u ON u.user_id = ra.user_id AND u.status = 'ACTIVE'
      JOIN roles r ON r.role_id = ra.role_id
      JOIN role_permissions rp ON rp.role_id = r.role_id
      JOIN permissions p ON p.permission_id = rp.permission_id
      WHERE ra.user_id = $1 AND ra.scope_kind = 'project' AND ra.scope_id = $2
        AND EXISTS (
          SELECT 1 FROM project_memberships m
          WHERE m.project_id = ra.scope_id AND m.user_id = ra.user_id AND m.status = 'ACTIVE'
        )`,
    organisation: `
      SELECT DISTINCT p.key
      FROM role_assignments ra
      JOIN users u ON u.user_id = ra.user_id AND u.status = 'ACTIVE'
      JOIN roles r ON r.role_id = ra.role_id
      JOIN role_permissions rp ON rp.role_id = r.role_id
      JOIN permissions p ON p.permission_id = rp.permission_id
      WHERE ra.user_id = $1 AND ra.scope_kind = 'organisation' AND ra.scope_id = $2
        AND EXISTS (
          SELECT 1 FROM organization_memberships m
          WHERE m.organization_id = ra.scope_id AND m.user_id = ra.user_id AND m.status = 'ACTIVE'
        )`,
    global: `
      SELECT DISTINCT p.key
      FROM role_assignments ra
      JOIN users u ON u.user_id = ra.user_id AND u.status = 'ACTIVE'
      JOIN roles r ON r.role_id = ra.role_id
      JOIN role_permissions rp ON rp.role_id = r.role_id
      JOIN permissions p ON p.permission_id = rp.permission_id
      WHERE ra.user_id = $1 AND ra.scope_kind = 'global'`,
  };

  return {
    // --- evaluator port -----------------------------------------------------

    async resolveKey(key) {
      const rows = await query('SELECT permission_id, key, scope FROM permissions WHERE key = $1', [key]);
      const row = rows[0];
      return row ? { id: row.permission_id, key: row.key, scope: row.scope } : null;
    },

    async grantedKeys({ userId, scopeKind, scopeId }) {
      const sql = grantedKeysSql[scopeKind];
      if (!sql) throw new Error(`Unknown scope kind "${scopeKind}".`);
      const rows = scopeKind === 'global' ? await query(sql, [userId]) : await query(sql, [userId, scopeId]);
      return new Set(rows.map((row) => row.key));
    },

    async getProject(projectId) {
      const rows = await query('SELECT project_id, organization_id, showcase FROM projects WHERE project_id = $1', [projectId]);
      const row = rows[0];
      return row ? { projectId: row.project_id, organisationId: row.organization_id, showcase: row.showcase } : null;
    },

    async countMemberships(userId) {
      const rows = await query(
        `SELECT (
           (SELECT count(*) FROM organization_memberships WHERE user_id = $1 AND status = 'ACTIVE')
         + (SELECT count(*) FROM project_memberships     WHERE user_id = $1 AND status = 'ACTIVE')
         )::int AS total`,
        [userId],
      );
      return rows[0]?.total ?? 0;
    },

    // --- identity -----------------------------------------------------------

    async findUserBySubject(subject) {
      const rows = await query('SELECT user_id, subject, email, display_name, status FROM users WHERE subject = $1', [subject]);
      return rows[0] ? mapUser(rows[0]) : null;
    },

    async findUserById(userId) {
      const rows = await query('SELECT user_id, subject, email, display_name, status FROM users WHERE user_id = $1', [userId]);
      return rows[0] ? mapUser(rows[0]) : null;
    },

    async createUser({ subject, email = null, displayName = null }) {
      // Idempotent *and* converging: a caller that declares a name gets it, and one that does
      // not leaves whatever is there rather than erasing it. The seed relies on the first
      // half — every machine that has been seeded already has these users, and a name that is
      // only ever written on the insert would leave them named by whatever the first run of a
      // previous list happened to say.
      const rows = await query(
        `INSERT INTO users (subject, email, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (subject) DO UPDATE SET
           email = COALESCE(EXCLUDED.email, users.email),
           display_name = COALESCE(EXCLUDED.display_name, users.display_name)
         RETURNING user_id, subject, email, display_name, status`,
        [subject, email, displayName],
      );
      return mapUser(rows[0]);
    },

    async setUserStatus(userId, status) {
      await query('UPDATE users SET status = $2, updated_at = now() WHERE user_id = $1', [userId, status]);
    },

    // --- catalog and roles --------------------------------------------------

    async listCatalog() {
      const permissions = await query('SELECT key, name, description, scope FROM permissions ORDER BY key');
      const roles = await query(
        `SELECT r.role_key, r.name, r.scope_hint, r.description,
                COALESCE(array_agg(p.key ORDER BY p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS keys
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.role_id
         LEFT JOIN permissions p ON p.permission_id = rp.permission_id
         GROUP BY r.role_key, r.name, r.scope_hint, r.description
         ORDER BY r.role_key`,
      );
      return {
        permissions: permissions.map((row) => ({ key: row.key, name: row.name, description: row.description, scope: row.scope })),
        roles: roles.map((row) => ({ roleKey: row.role_key, name: row.name, scopeHint: row.scope_hint, description: row.description, keys: row.keys })),
      };
    },

    async getRoleByKey(roleKey) {
      const rows = await query('SELECT role_id, role_key, name, scope_hint FROM roles WHERE role_key = $1', [roleKey]);
      return rows[0] ?? null;
    },

    /** Replaces a role's key set transactionally. Unknown keys are refused. */
    async replaceRolePermissions({ roleKey, keys }) {
      const unknown = keys.filter((key) => !isKnownKey(key));
      if (unknown.length > 0) throw new Error(`Unknown permission keys: ${unknown.join(', ')}`);

      return withTransaction(async (client) => {
        const { rows } = await client.query('SELECT role_id FROM roles WHERE role_key = $1 FOR UPDATE', [roleKey]);
        if (!rows[0]) throw new Error(`Unknown role "${roleKey}".`);
        const roleId = rows[0].role_id;

        await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT $1, p.permission_id FROM permissions p WHERE p.key = ANY($2::text[])`,
          [roleId, keys],
        );
        await client.query('UPDATE roles SET updated_at = now() WHERE role_id = $1', [roleId]);
        return { roleKey, keys: [...keys].sort() };
      });
    },

    /** Idempotent insert-ignore of a preset's keys. Never removes a key. */
    async applyPreset({ roleKey }) {
      const preset = getPreset(roleKey);
      if (!preset) throw new Error(`Unknown preset "${roleKey}".`);

      return withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO roles (role_key, name, scope_hint, description) VALUES ($1, $2, $3, $4)
           ON CONFLICT (role_key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
           RETURNING role_id`,
          [roleKey, preset.name, preset.scopeHint, preset.description],
        );
        const roleId = rows[0].role_id;
        const inserted = await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT $1, p.permission_id FROM permissions p WHERE p.key = ANY($2::text[])
           ON CONFLICT DO NOTHING`,
          [roleId, preset.keys],
        );
        return { roleKey, added: inserted.rowCount };
      });
    },

    // --- assignment and membership -----------------------------------------

    /** Upsert: one role per user per concrete scope (reassignment replaces). */
    async assignRole({ userId, roleKey, scopeKind, scopeId = null, actorUserId = null }) {
      return withTransaction(async (client) => {
        const role = await client.query('SELECT role_id FROM roles WHERE role_key = $1', [roleKey]);
        if (!role.rows[0]) throw new Error(`Unknown role "${roleKey}".`);

        if (scopeKind !== 'global') await ensureMembership(client, scopeKind, scopeId, userId);

        const assignment = await client.query(
          `INSERT INTO role_assignments (user_id, role_id, scope_kind, scope_id, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ON CONSTRAINT role_assignments_one_role_per_scope
           DO UPDATE SET role_id = EXCLUDED.role_id, updated_at = now()
           RETURNING assignment_id`,
          [userId, role.rows[0].role_id, scopeKind, scopeId, actorUserId],
        );
        return { assignmentId: assignment.rows[0].assignment_id, userId, roleKey, scopeKind, scopeId };
      });
    },

    async revokeAssignment({ userId, scopeKind, scopeId = null }) {
      const rows = await query(
        `DELETE FROM role_assignments
         WHERE user_id = $1 AND scope_kind = $2 AND scope_id IS NOT DISTINCT FROM $3
         RETURNING assignment_id`,
        [userId, scopeKind, scopeId],
      );
      return { revoked: rows.length };
    },

    async listUserAssignments(userId) {
      return query(
        `SELECT ra.assignment_id, ra.scope_kind, ra.scope_id, r.role_key, r.name
         FROM role_assignments ra JOIN roles r ON r.role_id = ra.role_id
         WHERE ra.user_id = $1
         ORDER BY ra.scope_kind, ra.scope_id`,
        [userId],
      ).then((rows) => rows.map((row) => ({
        assignmentId: row.assignment_id, scopeKind: row.scope_kind, scopeId: row.scope_id, roleKey: row.role_key, roleName: row.name,
      })));
    },

    async setMembershipStatus({ scopeKind, scopeId, userId, status }) {
      const table = scopeKind === 'project' ? 'project_memberships' : 'organization_memberships';
      const column = scopeKind === 'project' ? 'project_id' : 'organization_id';
      const rows = await query(
        `UPDATE ${table} SET status = $3, updated_at = now()
         WHERE ${column} = $1 AND user_id = $2
         RETURNING membership_id`,
        [scopeId, userId, status],
      );
      return { updated: rows.length };
    },

    async listMemberships({ scopeKind, scopeId }) {
      const table = scopeKind === 'project' ? 'project_memberships' : 'organization_memberships';
      const column = scopeKind === 'project' ? 'project_id' : 'organization_id';
      const rows = await query(
        `SELECT m.user_id, m.status, u.email, u.display_name
         FROM ${table} m JOIN users u ON u.user_id = m.user_id
         WHERE m.${column} = $1
         ORDER BY u.email`,
        [scopeId],
      );
      return rows.map((row) => ({ userId: row.user_id, status: row.status, email: row.email, displayName: row.display_name }));
    },

    // --- organisations and projects ----------------------------------------

    /** Onboarding: create the organisation, its first admin, and the membership. */
    async createOrganization({ name, ownerUserId }) {
      return withTransaction(async (client) => {
        const org = await client.query('INSERT INTO organizations (name) VALUES ($1) RETURNING organization_id', [name]);
        const organizationId = org.rows[0].organization_id;
        await ensureMembership(client, 'organisation', organizationId, ownerUserId);
        const role = await client.query("SELECT role_id FROM roles WHERE role_key = 'organisation-admin'");
        if (role.rows[0]) {
          await client.query(
            `INSERT INTO role_assignments (user_id, role_id, scope_kind, scope_id, created_by)
             VALUES ($1, $2, 'organisation', $3, $1)
             ON CONFLICT ON CONSTRAINT role_assignments_one_role_per_scope
             DO UPDATE SET role_id = EXCLUDED.role_id, updated_at = now()`,
            [ownerUserId, role.rows[0].role_id, organizationId],
          );
        }
        return { organizationId, name };
      });
    },

    async getOrganization(organizationId) {
      const rows = await query('SELECT organization_id, name, status FROM organizations WHERE organization_id = $1', [organizationId]);
      const row = rows[0];
      return row ? { organisationId: row.organization_id, name: row.name, status: row.status } : null;
    },

    /**
     * The effective key set for a caller at a scope, for the self endpoint. A
     * union of the independently matched scopes, never a wildcard traversal.
     */
    async effectiveKeys({ userId, projectId = null, organisationId = null }) {
      const keys = new Set();
      let resolvedOrganisationId = organisationId;

      if (projectId) {
        const project = await this.getProject(projectId);
        if (!project || (resolvedOrganisationId && project.organisationId && (typeof resolvedOrganisationId !== 'string' || resolvedOrganisationId.toLowerCase() !== project.organisationId.toLowerCase()))) {
          return { keys: [], organisationId: project?.organisationId ?? null };
        }
        resolvedOrganisationId = project.organisationId ?? resolvedOrganisationId;
        for (const key of await this.grantedKeys({ userId, scopeKind: 'project', scopeId: projectId })) keys.add(key);
      }
      if (resolvedOrganisationId) {
        for (const key of await this.grantedKeys({ userId, scopeKind: 'organisation', scopeId: resolvedOrganisationId })) keys.add(key);
      }
      for (const key of await this.grantedKeys({ userId, scopeKind: 'global', scopeId: null })) keys.add(key);

      return { keys: [...keys].sort(), organisationId: resolvedOrganisationId };
    },
  };
}

async function ensureMembership(client, scopeKind, scopeId, userId) {
  if (scopeKind === 'project') {
    await client.query(
      `INSERT INTO project_memberships (project_id, user_id, status) VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [scopeId, userId],
    );
    return;
  }
  await client.query(
    `INSERT INTO organization_memberships (organization_id, user_id, status) VALUES ($1, $2, 'ACTIVE')
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [scopeId, userId],
  );
}

function mapUser(row) {
  return { userId: row.user_id, subject: row.subject, email: row.email, displayName: row.display_name, status: row.status };
}
