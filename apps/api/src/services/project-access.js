import { ApiError } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { ROLE_PRESETS } from '@ai-infra/rbac';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROJECT_ACCESS_ROLES = Object.freeze(['project-viewer', 'project-editor', 'project-admin']);
const bad = message => new ApiError('VALIDATION_FAILED', message, { status: 400 });
const conflict = () => new ApiError('PROJECT_ACCESS_CONFLICT', 'Project access changed. Refresh members before trying again.', { status: 409 });
const denied = () => new ApiError('INSUFFICIENT_PERMISSION', 'Project member management access is required.', { status: 403 });

export function normalizeProjectAccess(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['role_key', 'status', 'expected_version'].includes(key))) throw bad('Only role_key, status and expected_version are accepted.');
  if (!PROJECT_ACCESS_ROLES.includes(body.role_key)) throw bad('Choose a supported project role.');
  if (!['ACTIVE', 'SUSPENDED'].includes(body.status)) throw bad('Status must be ACTIVE or SUSPENDED.');
  if (body.expected_version !== null && (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1)) throw bad('expected_version must be a positive integer or explicit null for a new member.');
  return { roleKey: body.role_key, status: body.status, expectedVersion: body.expected_version };
}

function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw bad(`Pagination must be between ${min} and ${max}.`);
  return Number(value);
}
const memberSql = `SELECT m.user_id, m.status, m.access_version, u.display_name, u.email, u.status AS account_status,
    r.role_key, EXISTS (SELECT 1 FROM organization_memberships om WHERE om.organization_id=p.organization_id
      AND om.user_id=m.user_id AND om.status='ACTIVE') AS organisation_active
  FROM project_memberships m JOIN users u ON u.user_id=m.user_id JOIN projects p ON p.project_id=m.project_id
  LEFT JOIN role_assignments ra ON ra.user_id=m.user_id AND ra.scope_kind='project' AND ra.scope_id=m.project_id
  LEFT JOIN roles r ON r.role_id=ra.role_id WHERE m.project_id=$1`;
function present(row) {
  return { userId: row.user_id, displayName: row.display_name, email: row.email, status: row.status,
    accountStatus: row.account_status, organisationActive: row.organisation_active, roleKey: row.role_key,
    version: row.access_version };
}
const access = row => row ? { roleKey: row.role_key, status: row.status, version: row.access_version } : null;

// Fresh DB evaluation of this one non-showcase management permission. This is
// repeated after the project lock, so a queued request cannot use a revoked grant.
async function requireManager(client, projectId, actorId) {
  const { rows } = await client.query(`SELECT 1 FROM users u JOIN role_assignments ra ON ra.user_id=u.user_id
    JOIN role_permissions rp ON rp.role_id=ra.role_id JOIN permissions k ON k.permission_id=rp.permission_id
    JOIN projects p ON p.project_id=$1
    WHERE u.user_id=$2 AND u.status='ACTIVE' AND k.key='project.member.manage' AND (
      (ra.scope_kind='project' AND ra.scope_id=p.project_id AND EXISTS (SELECT 1 FROM project_memberships m
        WHERE m.project_id=p.project_id AND m.user_id=u.user_id AND m.status='ACTIVE')) OR
      (ra.scope_kind='organisation' AND ra.scope_id=p.organization_id AND EXISTS (SELECT 1 FROM organization_memberships m
        WHERE m.organization_id=p.organization_id AND m.user_id=u.user_id AND m.status='ACTIVE')) OR
      ra.scope_kind='global') LIMIT 1`, [projectId, actorId]);
  if (!rows.length) throw denied();
}

export function createProjectAccessService({ pool }) {
  return {
    async list({ projectId, actorId, query = {} }) {
      const offset = integer(query.offset, 0, 0, 10000), limit = integer(query.limit, 20, 1, 100);
      return withTenant(pool, projectId, async client => {
        await requireManager(client, projectId, actorId);
        const { rows } = await client.query(`${memberSql} ORDER BY lower(COALESCE(u.display_name,u.email,'')), m.user_id LIMIT $2 OFFSET $3`, [projectId, limit + 1, offset]);
        const events = await client.query(`SELECT event_id, target_user_id, actor_user_id, action, before_access, after_access,
          correlation_id, created_at FROM project_access_events WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 20`, [projectId]);
        return { projectId, actorId, items: rows.slice(0, limit).map(present), offset,
          nextOffset: rows.length > limit ? offset + limit : null, roles: PROJECT_ACCESS_ROLES,
          events: events.rows.map(e => ({ eventId: e.event_id, targetUserId: e.target_user_id, actorUserId: e.actor_user_id,
            action: e.action, before: e.before_access, after: e.after_access, correlationId: e.correlation_id, createdAt: e.created_at })) };
      }, { readOnly: true });
    },
    async candidates({ projectId, actorId, query = {} }) {
      const limit = integer(query.limit, 20, 1, 20), search = query.q ?? '';
      if (typeof search !== 'string' || search.length > 100) throw bad('Search must be at most 100 characters.');
      return withTenant(pool, projectId, async client => {
        await requireManager(client, projectId, actorId);
        const { rows } = await client.query(`SELECT u.user_id,u.display_name,u.email FROM projects p
          JOIN organization_memberships m ON m.organization_id=p.organization_id AND m.status='ACTIVE'
          JOIN users u ON u.user_id=m.user_id AND u.status='ACTIVE'
          WHERE p.project_id=$1 AND u.user_id<>$2
            AND strpos(lower(COALESCE(u.display_name,'') || ' ' || COALESCE(u.email,'')), lower($3))>0
            AND NOT EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.project_id AND pm.user_id=u.user_id)
          ORDER BY lower(COALESCE(u.display_name,u.email,'')),u.user_id LIMIT $4`, [projectId, actorId, search.trim(), limit + 1]);
        return { items: rows.slice(0, limit).map(r => ({ userId: r.user_id, displayName: r.display_name, email: r.email })), truncated: rows.length > limit };
      }, { readOnly: true });
    },
    async set({ projectId, userId, actorId, body, correlationId }) {
      if (typeof userId !== 'string' || !UUID.test(userId)) throw bad('A valid user ID is required.');
      userId = userId.toLowerCase();
      const input = normalizeProjectAccess(body);
      if (userId === actorId.toLowerCase()) throw new ApiError('PROJECT_ACCESS_SELF_CHANGE', 'Ask another administrator to change your project access.', { status: 403 });
      return withTenant(pool, projectId, async client => {
        const p = await client.query('SELECT project_id,organization_id FROM projects WHERE project_id=$1 FOR UPDATE', [projectId]);
        if (!p.rows.length) throw new ApiError('NOT_FOUND', 'Project not found.', { status: 404 });
        await requireManager(client, projectId, actorId);
        const eligible = await client.query(`SELECT u.user_id FROM users u JOIN organization_memberships m ON m.user_id=u.user_id
          WHERE u.user_id=$1 AND u.status='ACTIVE' AND m.organization_id=$2 AND m.status='ACTIVE' FOR SHARE OF u,m`, [userId, p.rows[0].organization_id]);
        if (!eligible.rows.length) throw new ApiError('PROJECT_MEMBER_INELIGIBLE', 'Choose an active account in this project\'s organisation.', { status: 400 });
        const current = (await client.query(`${memberSql} AND m.user_id=$2 FOR UPDATE OF m`, [projectId, userId])).rows[0];
        if ((current?.access_version ?? null) !== input.expectedVersion) throw conflict();
        const role = (await client.query(`SELECT role_id,scope_hint FROM roles WHERE role_key=$1 FOR SHARE`, [input.roleKey])).rows[0];
        if (!role || role.scope_hint !== 'project') throw bad('Project role is unavailable.');
        const keys = (await client.query('SELECT p.key FROM role_permissions rp JOIN permissions p ON p.permission_id=rp.permission_id WHERE rp.role_id=$1', [role.role_id])).rows;
        if (keys.length !== ROLE_PRESETS[input.roleKey].keys.length || keys.some(k => !ROLE_PRESETS[input.roleKey].keys.includes(k.key))) throw new ApiError('PROJECT_ROLE_CUSTOMIZED', 'This role has custom permissions. Ask a system administrator to review its delegation.', { status: 409 });
        if (current?.role_key === input.roleKey && current.status === input.status) return { member: present(current), changed: false };
        if (current?.role_key === 'project-admin' && current.status === 'ACTIVE' && (input.roleKey !== 'project-admin' || input.status !== 'ACTIVE')) {
          const others = await client.query(`${memberSql} AND m.user_id<>$2 AND m.status='ACTIVE' AND u.status='ACTIVE' AND r.role_key='project-admin'`, [projectId, userId]);
          if (!others.rows.length) throw new ApiError('PROJECT_LAST_ADMIN', 'Keep at least one active project administrator before changing this member.', { status: 409 });
        }
        await client.query(`INSERT INTO project_memberships(project_id,user_id,status) VALUES ($1,$2,$3)
          ON CONFLICT(project_id,user_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now()`, [projectId, userId, input.status]);
        await client.query(`INSERT INTO role_assignments(user_id,role_id,scope_kind,scope_id,created_by)
          VALUES ($1,$2,'project',$3,$4) ON CONFLICT ON CONSTRAINT role_assignments_one_role_per_scope
          DO UPDATE SET role_id=EXCLUDED.role_id,updated_at=now()`, [userId, role.role_id, projectId, actorId]);
        const saved = (await client.query(`${memberSql} AND m.user_id=$2`, [projectId, userId])).rows[0];
        await client.query(`INSERT INTO project_access_events(project_id,target_user_id,actor_user_id,action,before_access,after_access,correlation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [projectId, userId, actorId, current ? 'CHANGE' : 'ADD', access(current), access(saved), correlationId]);
        return { member: present(saved), changed: true };
      });
    },
  };
}
