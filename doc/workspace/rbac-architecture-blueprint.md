> **Confidential — internal architecture material.**
> Do not copy, quote, summarize, or transmit this document outside the workspace.

# Role-Based Access Control — Architecture Blueprint

A vendor-neutral architectural reference for adding RBAC to a multi-tenant web application:
a server that is the only enforcement point, a permission catalog, scope-aware roles, and a
client predicate that decides what to render.

This is a blueprint, not a design specification. It describes the model, the resolution
algorithm, the contracts, and the failure modes — the parts that are expensive to re-derive.
It deliberately omits product names, domain vocabulary, real permission keys, role names,
table names, identifiers and credentials. Adapt the names; keep the seams.

---

## 1. The shape of the model

RBAC here has three separable layers. Keeping them separate is the whole design.

| Layer | Question it answers | Where it lives |
|---|---|---|
| **Catalog** | What capabilities exist? | A key registry (code constants + a registered table) |
| **Assignment** | Who holds which role, at which scope? | Roles + a role→key map + per-user assignments |
| **Evaluation** | Is *(user, key, scope)* allowed? | One function, cached, reused everywhere |

And exactly one enforcement boundary:

- The **server** answers "allowed" and enforces it on every request. It is the source of truth.
- The **client** asks the server the same question to decide what to show. This is
  **presentation**, never security: the client hides controls, the server refuses the call.

A useful one-line rule: *the client decides what a user sees; the server decides what a user
can do.* Any code that treats a client gate as protection is a bug.

---

## 2. Vocabulary and core entities

- **Permission key** — a dotted capability string `area.resource.action` (sub-areas allowed:
  `area.sub.resource.action`). It is a **stable string**, not a row id, so it can be written in
  code, in presets, and in client components.
- **Role** — a named bundle of permission keys: `{ id, roleKey, name, scopeHint, description }`.
  `roleKey` is a namespaced stable identifier; `name` is display-only; `scopeHint` is advisory
  (system / organisation / workspace) and must not be enforced by code.
- **Assignment** — `(user, role, scopeKind, scopeId)` with `scopeKind ∈ {global, organisation,
  workspace}` and `scopeId` null for global. Upsert semantics: **one role per user per concrete
  scope**; reassigning replaces rather than stacks.
- **Grant (decision)** — the result of evaluation: `{ allowed, grant, scopeIds?, readOnly?,
  showcase? }`, where `grant` names *why* it passed: workspace / organisation / global / user /
  onboarding / showcase.
- **Scope** — a point in the tenancy hierarchy: global (system), organisation, workspace. A
  request may carry an organisation id, a workspace id, both, or neither.

Two tables do the mapping: a **role→key** association, and the **assignment**. A separate
**direct user→key** table exists for exceptions; see the failure modes for why it is a trap.

---

## 3. Permission catalog

- Author keys as **grouped constants** in one module (one group per domain area), and import
  them everywhere. Never retype the string at a call site; a shared identifier is what makes a
  rename safe.
- Register each key in a **catalog table** (`id, key, name, description, scope`). The table is
  the runtime source of truth for evaluation; the code constants are for authoring and issuing
  checks.
- **An unregistered key must deny.** Resolution looks the key up and fails closed when no row
  exists. A typo or a removed key then produces "unknown permission" — not a silent allow.
- Namespacing is **not enum-enforced**. Treat keys as free-form strings with a naming
  convention; if you want a closed set, add a test that the constants and the seeded rows agree.
- Some key literals may need to remain aliased across areas for backward compatibility. Keep
  aliases deliberate and documented; an accidental duplicate is a security review finding.
- Migrations should seed canonical keys and, on a rename, copy grants from the old key to the
  new one, then keep the old key as a deprecated alias or remove it in a later release.

**Drift is the catalog's enemy.** Two sources (code constants and DB rows) will diverge unless
something checks them. Add a test or a startup assertion comparing the constant set with the
seeded set, and alert on a mismatch.

---

## 4. Roles, presets and assignment

- **Roles are data, not code.** Seed a role catalogue; version it through migrations, because
  changing a role changes effective permissions for every holder.
- **Presets** (role templates) are named, hardcoded bundles of permission keys: global-admin,
  organisation-admin, workspace-admin, workspace-editor, viewer, plus feature bundles. Applying
  a preset:
  - is an idempotent insert-ignore of mappings;
  - **never removes** keys the role already holds;
  - should record that it was applied (a note or an audit row), but a note is not history —
    prefer a real audit trail if presets are part of operations.
- **Assignment is per scope.** A user may simultaneously hold a global role, an organisation
  role and a workspace role; evaluation unions them. There is no override table and no
  deny-precedence table: "more specific wins" is implemented by *not having a broad grant that
  would be wrong*, not by subtraction.
- **Reassignment replaces within a scope.** Enforce it with a unique key on
  `(user, role-scope-kind, scope-id)` and an upsert, so a double-assign cannot leave two roles
  fighting.
- **The display role is not the enforcement role.** A helper that resolves the *most specific*
  role (workspace > organisation > global) is fine for labels and badges. Never let it decide
  access; enforcement must union all matching scopes via the evaluator.
- Avoid **membership mirror tables** as a second source of truth. If a canonical assignment
  table exists, mirror writes must be best-effort only, and reads must prefer the canonical
  table. Two writable sources that can disagree will eventually disagree.

---

## 5. The evaluation algorithm

Given *(user, key-or-id, scope)*, evaluate in this order and stop at the first match:

1. **Reject empties.** No user or no key → deny.
2. **Resolve the key** to its catalog id. Unknown key → deny (see §3).
3. **Workspace-scoped role** containing the key → allow, `grant: workspace`.
4. **Organisation-scoped role** containing the key — explicit, or derived from the workspace's
   owning organisation → allow, `grant: organisation`.
5. **Global-scoped role** containing the key → allow, `grant: global`.
6. **Direct per-user grant** for the key → allow, `grant: user`.
7. **Special grants** (keep these few and explicit):
   - *onboarding*: an unscoped "create the first organisation" key to a user with zero
     memberships, so a brand-new account can bootstrap;
   - *public/showcase read*: a workspace flagged public, only for a fixed read-only key set,
     allow with `readOnly: true`.
8. **Default deny.**

Semantics to keep straight:

- **Inheritance is a union of independently matched scopes**, not wildcard traversal. There is
  no deny-overrides and no explicit-deny row; a stored "not allowed" flag that evaluation never
  reads is worse than not having one.
- **A global role satisfies scoped checks.** It is effectively a per-key wildcard across scopes.
  Order matters only for labelling the grant.
- **A scoped role must never satisfy an unscoped check.** An organisation or workspace role is
  not a global role. Enforce this by early-returning when no scope is supplied.
- **Scope-null the system-level keys.** A small set of system-management keys must be evaluated
  with scope forced to null, so no scoped role can ever grant them.
- **No hardcoded super-user.** If a global role holds the system key, it acts as admin *at the
  specific checks that ask for the system key* — never as a blanket bypass of the evaluator.
- **Fail closed on evaluator errors.** A thrown lookup must deny, not allow. Log it loudly; a
  database blip must not open the door.
- **Suspension must subtract permission.** If membership carries a suspended/disabled status,
  evaluation has to read it. A status column that is written but never consulted does not
  suspend anyone.

### Caching

- Cache a **decision** keyed by `(user, key, workspace, organisation)` and dedupe in-flight
  requests behind one promise. A short TTL is right (tens of seconds); permissions should not be
  stale for minutes.
- Cache **key→id** resolution separately, with a longer TTL. **Do not cache negatives** unless
  you also invalidate on catalog changes, or a newly registered key stays unknown.
- **Invalidate deliberately.** Role/key mapping changes should clear the whole decision cache
  (they are rare). Assignment and membership changes should invalidate by user and/or scope.
  Anything that grants or revokes must have a matching invalidation; otherwise an offboarded
  user keeps their permissions until the TTL expires.
- A user-scoped invalidation should also clear any cached user profile if that profile feeds
  authorization.

---

## 6. Decision object and contracts

One evaluator, one shape. Everything else wraps it.

```
decision = {
  allowed: boolean,
  grant: 'workspace' | 'organisation' | 'global' | 'user' | 'onboarding' | 'showcase' | null,
  functionId: id | null,
  workspaceId?, organisationId?,
  showcase?: true,
  readOnly?: true,
}
```

- **Non-throwing wrapper** (for services and shared code): adds `functionKey`, echoes the scope,
  and a machine `reason ∈ { UNAUTHENTICATED, FUNCTION_REQUIRED, INSUFFICIENT_PERMISSION,
  UNKNOWN_FUNCTION }`. Callers branch on `allowed`; nobody parses prose.
- **Throwing wrapper** (for domain code): maps the reason to a typed error carrying a `code` and
  HTTP status (401 for unauthenticated, 403 for the rest). The service layer throws; the HTTP
  layer translates.
- **Middleware** stores the allowed decision on the request (`req.permission = { allowed, grant,
  functionId, functionKey, scopeIds?, showcase?, readOnly? }`) so later handlers can read the
  *reason* and implement partial/self-access rules without re-querying.
- **A read endpoint may return 200 with `allowed:false`**, so a client can cache a distinct
  denial. Do not use the HTTP status for the decision on the check endpoint; reserve non-200 for
  transport/protocol errors.

---

## 7. Backend enforcement

### Authentication ≠ authorization

Keep them as separate middleware:

- **Authentication**: verify the token; missing → 401, invalid/expired → 403, user record
  missing → 401. Attach the user, and any auth-strength context (MFA satisfied, auth timestamp)
  that later guards need. A short-TTL profile cache is fine here.
- **Step-up guards**: an MFA guard and a recent-authentication guard for sensitive operations.
  These are identity checks; they should not be conflated with a permission key.

### The permission guard factory

```
checkPermission(requiredKey, { organisationParam, workspaceParam })
```

- Read scope ids from **route params, then body, then query** (document the precedence).
- **Resolve public identifiers to internal ids** before evaluation; an unresolvable scoped
  entity is a 404, not a silent null scope. This is where "wrong id shape → silent deny" is
  avoided.
- Delegate to the cached evaluator. **Wrap it so an evaluator exception becomes a 500**, not an
  unhandled crash and not an implicit allow.
- System-level keys are special-cased to ignore scope.
- Nested routers reuse the same factory.

### Denial contract

| Condition | Status | Body |
|---|---|---|
| No authenticated user | 401 | authn error (`message`) |
| Scoped entity not found | 404 | not found |
| Unknown key | 403 | `{ allowed:false, error, functionKey }` |
| Insufficient permission | 403 | `{ allowed:false, error, functionKey }` |
| Evaluator threw | 500 | generic failure |

Keep two distinct envelopes for authn and authz, and put a machine `code` on step-up failures.
Clients and logs should never have to parse a human sentence to learn what happened.

### Defense in depth

The route guard is the coarse boundary. Domain services that touch sensitive data should also
call the **non-throwing or throwing wrapper**, accepting the authorization function as an
injectable dependency so tests can substitute it. This catches:

- callers that reach a service without going through the route (jobs, scripts, other services);
- partial permissions inside a handler (e.g. "read others' records" vs "read your own").

Any deliberate bypass (a fixture/migration path that skips the check when there is no user)
must be explicit, narrow, and impossible for a normal request to reach. Stamp it with a comment
and, if possible, an environment guard.

---

## 8. Administration

- **Self endpoints**: effective permission keys for the caller (optionally scoped), a single
  check, and a guarded "compute for another user" for admin UIs.
- **System administration** (system key + MFA + recent auth): list roles, list keys, read and
  replace a role's key mappings, apply a preset, assign a role at any scope (public ids
  resolved), list/revoke a user's assignments, delete a user (cascade assignments and direct
  grants).
- **Organisation administration**: list assignable roles/keys, read/replace role mappings, change
  a member's role, revoke a role — scoped to the caller's organisation.
- **Role/key replacement should be transactional**, clear the decision cache, and refuse (or
  auto-register) unknown keys. Auto-registration is convenient but creates metadata-poor rows;
  log it.
- A direct user→key administration surface that does not exist is a liability: either build the
  create/list/revoke endpoints, or remove the table. A grant table the evaluator reads but
  nobody can safely manage becomes an unauditable backdoor.

---

## 9. Frontend `can()` and component rendering

### Contract

```
can(permissionKey, { organisationId?, workspaceId? }) -> Promise<boolean>
```

- **It is async, despite the name.** Treat the return value as a promise at every call site. A
  promise used in a boolean position is always truthy.
- **Decision identity is `(key, organisationId, workspaceId)`.** An unscoped call is a *global*
  question and must not reuse a scoped answer, or vice versa.
- **Fast path**: a locally fetched set of the caller's unscoped keys can answer unscoped
  positives without a round trip. It must only prove positives — a miss falls through to the
  server, never to `false`.
- **Slow path**: ask a server check endpoint; on non-OK or transport error, return `false`
  (fail closed) and, ideally, expose a distinct "could not determine" state.
- **Single-flight and cache** decisions in an in-memory map keyed by the full decision identity,
  so a screen that asks for the same key several times makes one request.

### Rendering pattern

The pattern that scales:

```jsx
const [canManage, setCanManage] = useState(null);   // null = pending, not false

useEffect(() => {
  let mounted = true;
  Promise.all([can(KEY_A, { workspaceId }), can(KEY_B, { workspaceId })])
    .then(([a, b]) => { if (mounted) { setCanManage(a); setCanEdit(b); } });
  return () => { mounted = false; };
}, [can, workspaceId]);

if (canManage === null) return <Pending />;         // do not flash a denial
```

Rules:

- **Three-state gate: pending / allowed / denied.** Initialising to `false` renders a denial
  while the check is in flight, which reads to the user as a permission error. `null` (or a
  loading flag) exists precisely to prevent that.
- **Hide by default; disable only when the control's absence would confuse.** A hidden action
  says "not available"; a disabled one says "available but closed to you". Choose per surface
  and be consistent. An edit-denied screen often degrades to read-only.
- **Never call `can()` inside JSX conditionals or other synchronous boolean positions.** Await
  it in an effect (or a shared hook) and render from state.
- **Extract a shared gateway.** A `usePermission(key, scope)` hook (or a `<Can>` wrapper) removes
  the repeated effect/state boilerplate and centralises the pending-state policy. Per-component
  reimplementation is where the inconsistent loading states and duplicated denial strings come
  from.
- **Memoise `can` identity** if it is listed in effect dependencies, or effects re-run every
  render. The cache hides the cost; it does not hide the churn.

### What the client must not do

- Do not implement an admin/super-user bypass on the client. If a system-admin can see a control,
  the server should say so for that key; a client `isAdmin` short-circuit drifts from the server.
- Do not infer privilege from **role label text**. Substring-matching a display label to decide
  access is a second, unversioned authorization signal. Roles and labels are for the UI.
- Do not treat a transport failure as a denial silently. Show "could not check permissions" and
  offer a retry; otherwise an outage masquerades as a policy decision.

### Keeping client and server keys in step

- **One owner for the catalog.** The server owns the canonical key list; the client should
  import a generated or shared catalog rather than retyping strings. Retyped literals drift
  silently: a client typo hides UI, a server rename denies everyone, and neither fails a build.
- A mismatch must be **detectable**. At minimum, a contract test compares the client's referenced
  keys against the catalog; better, generate the client constants from the server catalog.
- **A scoped decision is only as good as its scope id.** Build the cache key and the request from
  resolved internal ids; an unresolved/opaque route id produces a false denial that looks like a
  policy decision.
- **Invalidate on change.** When roles or membership change, clear the client decision cache and
  refetch the key set. Caches cleared only on login/logout keep a demoted user privileged for
  the rest of the session.

---

## 10. Invariants and anti-patterns

Invariants:

1. **The server is the only enforcement point.** Client gating is presentation and fails closed.
2. **Default deny.** Unknown key, missing user, evaluator error → denied.
3. **Decision identity is `(key, organisation scope, workspace scope)`.** Unscoped means global.
4. **Global roles satisfy scoped checks; scoped roles never satisfy unscoped checks.**
5. **System-level keys are scope-nulled and never granted by scoped roles.**
6. **Permissions are unioned across scopes; there is no deny-overrides and no all-keys super-role.**
7. **Roles and role labels are not permissions.** Never authorize from display text.
8. **Every grant has a matching invalidation.** A cache with no invalidation path is a stale-
   privilege bug with a delay.
9. **Unknown permission state renders as pending**, never as allowed and never as a hard denial.
10. **One catalog owner.** Consumers reference identifiers; nobody retypes keys.

Anti-patterns to avoid:

- An async predicate consumed synchronously (a promise is always truthy) → a gate that flickers
  open on first paint.
- Unstable return type from `can()` (boolean once cached, promise before) → callers that happen
  to work until the cache is warm.
- Defaulting permission state to `false` instead of pending → flashes of hidden UI / denials.
- Unbounded, no-TTL permission caches cleared only on auth lifecycle events.
- Non-memoised `can` identity in effect dependencies.
- A scope-parameter-name mismatch between the route and the guard → a null scope, i.e. a silent
  deny (or a broadened check).
- A grant table (`allowed` column) that evaluation never reads, and a direct-grant surface with
  no creation endpoint.
- Membership mirror tables written best-effort while reads sometimes trust them.
- A "most-specific role" helper reused for enforcement instead of display.
- A fixture/migration bypass that a production request can reach.

---

## 11. Porting checklist

1. **Define the catalog** as grouped constants in one module and seed a catalog table; add a test
   that the two agree.
2. **Model roles, the role→key map, and the scoped assignment** with a uniqueness constraint that
   makes reassignment replace.
3. **Seed role templates** as presets; make application idempotent and audited.
4. **Write one evaluator** implementing §5; return the decision object; cache with TTL and
   in-flight dedupe; fail closed.
5. **Add invalidation hooks** for assignment, role-mapping, and membership changes.
6. **Add the guard factory** with scope params, public-id resolution, and the denial contract.
7. **Add the service-layer assertion** (throwing) and the non-throwing wrapper, injectable for
   tests; call it where sensitive data is read or written.
8. **Build the administration endpoints** (system + organisation scoped), transactional and
   cache-clearing.
9. **Build a shared client gateway** (`usePermission`/`<Can>`) over one async `can()`, with a
   three-state pending model and fail-closed semantics.
10. **Wire invalidation on the client** to role/membership changes, and add a contract test for
    key drift.

### Explicit non-goals

- Attribute-based or relationship-based access control beyond scope membership. This model is a
  scope-aware allow-list.
- Field-level redaction is a separate concern (a projection layer), though it may key off the
  same roles.
- Row-level tenancy isolation is assumed to be handled by the data queries, not by this layer;
  RBAC answers "may this user perform this capability", not "which rows exist for them".

### Open questions to re-decide for a new project

> **Answered.** These questions were resolved during W0 in [Porting Decisions](porting-decisions.md). The answers there are binding; the questions are kept for provenance.

- Whether an explicit **deny** is ever needed. If it is, it must be read by the evaluator and
  must override allows; today's model has no deny path.
- Whether **suspension** should subtract permissions and how that interacts with global-looking
  roles.
- How **public/showcase read access** is granted and revoked, and whether the accompanying
  read-only mutation guard is sufficient or can be bypassed.
- Whether **direct per-user grants** are worth keeping. If yes, build the administration
  surface; if no, remove the table.
- Where the **catalog** should live if the client is to stop retyping keys — a generated module,
  a shared package, or a build-time check.
