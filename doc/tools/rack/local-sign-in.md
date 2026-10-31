# Local account sign-in

## Scope

The Rack local platform defaults to password sign-in rather than development
impersonation. Each provisioned account has its own password and revocable
browser session. Existing database identities, project permissions and personal
Assistant ownership are reused; signing in cannot select a role or another user.

This increment provides a single-instance local authentication gateway in the
Vite server. The API continues to verify server-issued bearer tokens and enforce
database RBAC. It is not a production identity provider or school SSO deployment.

## User journey

### Administrator-created accounts

In password mode, Project access provides **Invite new account**. A manager enters
a unique account name, display name and one of the three project roles. The gateway
checks a live server session and fresh project-management permission, reserves the
login, and calls the scoped backend to create a random local identity, organisation
membership and direct project grant. Only `project.read` is granted at organisation
scope for project discovery; no organisation-wide Rack or Facility grant is added.
The backend transaction records an ADD access event. A stored request UUID makes
retries recoverable without creating another user or overwriting changed access.

The administrator receives a private, one-use activation URL, valid for 24 hours,
and shares it manually. No email is sent. A repeat with the same pending account,
creator, project, name and role reissues its link and invalidates the previous one.
Activated logins cannot be reset or rebound through invitations. Uncertain responses
can be retried with the same form; pending reservations survive a gateway restart.
Database and filesystem writes are not a distributed transaction: a failed second
step may leave a pending account, recoverable by retrying the invitation. No token
is returned until backend provisioning succeeds. Browser storage never retains
activation links; closing the access panel clears the displayed link.

Editors/viewers cannot use this endpoint, choose a subject, or grant organisation/
system roles. Project suspension removes the new account's direct business grants;
the account may still sign in and discover organisation project metadata. Existing
organisation/global grants are additive and are not revoked by project suspension.

### Existing-identity bootstrap

1. An operator provisions an existing backend subject using `npm run rack:account
   -- --subject dev-user --login admin`. The command validates the bound identity
   against the isolated API, writes a one-use activation link under the ignored
   `.local-runtime/auth/` directory, and never chooses a shared default password.
2. The user opens the link and sets a personal password of 12–128 characters.
   Activation is valid for 24 hours. Opening a link does not consume it; successful
   password setup consumes it atomically and redirects to normal sign-in.
3. Sign in with the account name and password. An eight-hour HttpOnly,
   SameSite=Strict session cookie survives refresh. Only the signed-in account is
   shown in the sidebar, with Sign out. Other accounts are not listed in the account menu;
   authorized managers can read their project's member list.
4. Project member administration remains guarded by project.member.manage.
   Account provisioning does not grant any project role or change plan data.
5. Sign out revokes the server session before clearing the cookie and reloading
   the app. Session expiry requires sign-in again. UI state from the previous
   account is removed by a full reload. Unsaved drafts are not durable.

## Authentication and storage contract

- `GET /__auth/session`: mode and the current account, or null. No user directory.
- `POST /__auth/activate`: one-use activation token and a new password.
- `POST /__auth/login`: account name and password; generic invalid-credential error.
- `POST /__auth/logout`: revoke the current session and clear its cookie.
- `POST /__auth/invitations`: session/Origin-protected new-account invitation;
  accepts only login, name, projectId, roleKey and requestId. Fresh backend manager
  authorization precedes reservation; returns login, activationUrl and expiresAt.
- `POST /api/v1/projects/:projectId/account-invitations`: authenticated scoped
  identity/membership provisioning; accepts request_id, display_name and role_key.
  Subject and organisation are server-derived. It returns backend identity metadata,
  never a password or activation token. The gateway performs credential provisioning.
- State-changing requests require an allowed exact Origin and JSON for login/
  activation. Login attempts are bounded per remote address and per normalized
  account within a five-minute process-local window. Bodies are limited to 8 KiB.
- Passwords use salted scrypt (N=32768, r=8, p=1). Passwords, bearer tokens and raw
  session/activation tokens are not saved in the account store. Only token hashes
  are persisted. Activation-link files necessarily contain the one-use secret and
  must remain private and be removed by the operator after activation.
- Local account/session state is held in `.local-runtime/auth/accounts.json`,
  outside source control and denied by Vite's file serving. Writes are serialized
  in one process and replaced atomically. Corrupt state fails closed.
- The browser's x-dev-subject and Authorization headers cannot choose an identity:
  the gateway removes them and attaches its own short-lived token only after
  validating the session. The backend still checks account suspension and real
  project permissions on each request.
- `RACK_AUTH_MODE=password` is the default. The old all-account switcher requires
  explicit `RACK_AUTH_MODE=demo`, development mode and a loopback-bound server.
  It must never be used as an externally accessible login mechanism.

## Boundaries

Operators can bootstrap existing backend subjects; managers can now provision new
local accounts through Project access. There is no anonymous registration, email
invitation delivery, forgotten-password mail, MFA or OIDC browser redirect. The web
service is loopback-bound by default; sharing a localhost invitation with another
computer requires a deliberately configured reachable service URL, allowed origins
and appropriate HTTPS deployment. It does not transfer credentials between separate
local installations. Operators can reissue an activation link for an account that
has not yet been activated.
Multi-instance sessions and coordinated rate limiting require a shared store.
Public deployment requires HTTPS/Secure cookies and an appropriate authentication
gateway or identity provider; a static Vite build alone does not provide this
local server. Filesystem owners can administer the local account store and must
be trusted. Eight-hour sessions are fixed-duration rather than rolling sessions.
