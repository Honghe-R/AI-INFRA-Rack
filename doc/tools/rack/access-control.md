# Rack Authentication and Access Control

Status: implementation contract for the scoped access increment of 2026-10-30. Runtime verification is recorded in the root progress log, not inferred from this specification.

## Purpose and ownership

Authentication establishes an account identity. Authorization decides which operation that identity may perform in a project. Reuse the inherited identity verifier, permission catalog, role assignments and evaluator; Rack contributes its permission split, project access workflow and acceptance evidence. A person's job title is not an authorization rule.

The local Rack platform now defaults to [personal password sign-in](local-sign-in.md), with one-use activation, salted password hashes, revocable browser sessions and a current-account-only menu. The authentication gateway obtains the subject from its server-side session and ignores browser impersonation headers. The backend still verifies its signed token and checks actual database permissions. Account provisioning does not grant roles. This is a local single-instance login implementation, not an enterprise identity-provider deployment.

The older development account switcher requires explicit RACK_AUTH_MODE=demo on a loopback development server. Its role labels are seed examples rather than effective permissions. OIDC/JWKS remains the production deployment seam; never expose development impersonation on a public deployment.

## Default capability matrix

| Operation | Project viewer | Project editor | Project administrator |
| --- | --- | --- | --- |
| Read plans, equipment, catalog and capacity | Yes | Yes | Yes |
| Run checks and compute temporary candidates | Yes | Yes | Yes |
| Create/rename plans and save layouts | No | Yes | Yes |
| Edit racks, equipment and planning constraints | No | Yes | Yes |
| Stage and save generated designs | No | Yes | Yes |
| Delete and restore complete plans | No | No | Yes |
| Manage project membership and roles | No | No | Yes |
| Query authorized saved data with Assistant | Yes | Yes | Yes |

These are default preset grants, not a hardcoded hierarchy. Effective permissions may also come from organisation/global assignments. Organisation administrators can manage project members through their existing `project.member.manage` grant, but do not automatically receive Rack write/delete/recovery access. System administration alone grants no Rack content access. One account can hold different roles in different projects.

## Permission keys and enforcement

| Key | Scope | Operations |
| --- | --- | --- |
| `rack.read` | Project | Read plans/catalog, run checks, compute candidates |
| `rack.write` | Project | Create/rename plans, capture input, save layouts |
| `rack.delete` | Project | Soft-delete a complete plan |
| `rack.restore` | Project | Restore a soft-deleted plan |
| `facility.read` | Project | Additional gate for room geometry/layout computation and Rack Assistant |
| `project.member.manage` | Project | List project members, eligible organisation accounts and recent access events; change project roles/status |

Frontend gates are affordances only. HTTP guards authorize the path's project before the handler. Computation never persists a candidate. The model's five Rack tools remain read/computation only and use the existing permission authorizer; no membership/save/delete tools are added. Personal model connections remain owned by the authenticated account and never become visible to a project administrator.

The project's actual organisation is authoritative. A body/query organisation identifier that conflicts with it is rejected by the shared HTTP guard; the evaluator and effective-key projection also fail closed. A caller cannot pair an unrelated project with an organisation where they hold administrator grants.

## Project access workflow

Open **Project access** in the Rack header. Only a user with `project.member.manage` sees this control. It manages project access, independently of which plan is selected.

1. Read the paginated member list and the latest access events.
2. Search eligible, active accounts in the project's own organisation. These are existing organisation accounts; there is no email invitation, sign-up or global user directory.
3. Add an account as Project viewer, Project editor or Project administrator.
4. Change another member's direct project role, suspend their project membership, or reactivate it.
5. Inspect the resulting member version and actor/time/action event. Refresh after any uncertain response or conflict before submitting a new change.

Suspension disables that project's direct membership grant. It is not an explicit deny: organisation/global grants may still authorize access. The interface must state this. Assignment/status are shown as direct project facts, not claimed as a complete effective-permission report. No hard deletion of users, organisation membership, or project content is performed.

## API contract

All routes are authenticated, require `project.member.manage`, use the path project as scope, and return `Cache-Control: no-store`.

| Method/path, relative to `/api/v1/projects/:projectId` | Purpose |
| --- | --- |
| `GET /members?offset=0&limit=20` | Bounded member page plus latest 20 audit events |
| `GET /member-candidates?q=...&limit=20` | Bounded active organisation account search |
| `PUT /members/:userId` | Set direct project role/status with an optimistic precondition |

Example mutation body:

```json
{
  "role_key": "project-editor",
  "status": "ACTIVE",
  "expected_version": 3
}
```

`expected_version` is the member version last read, or explicit `null` for a new membership. Existing rows require a positive safe integer. Unknown/server-owned fields, arbitrary roles and statuses other than ACTIVE/SUSPENDED are rejected. UUIDs are validated. A stale version produces `409 PROJECT_ACCESS_CONFLICT`; no implicit overwrite or automatic retry occurs. The successful response contains the current member row. A repeated identical submission with its new version is a no-op and creates no event. An unchanged old version after a committed/lost response conflicts: refresh to reconcile.

Pagination uses offset 0–10000 and limit 1–100 for members, default 20; candidates allow limit 1–20 and a literal case-insensitive query of at most 100 characters. Stable name/ID ordering and limit-plus-one determine whether another page exists. The event list intentionally exposes only the latest 20 events; full audit export is future work.

## Transaction and storage rules

- Serialize project access mutations on the project row. Recheck the actor's actual database permission inside the transaction rather than relying only on the gateway's decision cache.
- Require an active target user and active organisation membership in this same organisation. Lock these records while updating; do not let a submitted organisation/scope/actor redirect the operation.
- Accept only the three project presets. Require the database key mapping to match its canonical preset exactly; custom role delegation is outside this UI's scope.
- Block changes to one's own project membership through this API. A different administrator can make the change. Protect the last active direct project administrator, counting only active user accounts, under the project lock.
- `project_memberships.access_version` tracks membership updates and direct project role changes. Database triggers also advance it for inherited repository assignment/status operations, preventing an old version from becoming valid after a role is changed and changed back. Role catalog changes are a separate administrative concern.
- Persist assignment, membership state and `project_access_events` in one transaction. Events record project, target, actor, correlation ID, before/after role/status/version and timestamp; no API key, model payload or arbitrary request body is stored.
- Invalidate the target's permission decisions after commit. Another browser's visual controls can remain stale until refresh; backend decisions are authoritative and subsequent requests must reject revoked grants. Already executing operations are not retroactively undone.
- The generic system administration endpoints are a privileged recovery path. They are not exposed through this project UI and do not promise this workflow's last-administrator/self-change policy. Production administrator procedures must account for that distinction.

Migration 012 adds the two Rack keys, default administrator grants, membership versions/triggers and project-scoped event storage. Previous migrations are immutable. Existing plan content and versions do not change. The event table uses forced project RLS; application-level permission checks remain necessary. A local database owner connection is not evidence of production RLS enforcement.

## Acceptance and limits

Verify viewer write/delete/restore denials, editor save/rename success but delete/restore denial, administrator lifecycle success, foreign-project denial, same-organisation candidate filtering, role allowlist, self-change protection, last-administrator protection, concurrent conflicts, atomic events, permission-cache revocation and inherited-grant behavior. Keep Assistant cross-account connection and project-scope tests in the relevant regression set.

Production login, identity-provider provisioning, invitation mail, custom role editing, expiring access, multi-instance cache invalidation and tamper-proof audit retention are not delivered by this increment. The current process-local permission cache needs coordinated invalidation before multi-instance deployment. Do not describe a suspended direct membership as a universal deny.
