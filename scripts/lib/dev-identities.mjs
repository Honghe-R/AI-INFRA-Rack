/**
 * The identities a development session can act as.
 *
 * One list, in one place, because three consumers have to agree on it: the seed creates
 * these users and gives them these roles, the dev server mints a token per subject, and
 * the account menu offers them. A list written three times is a list that drifts, and the
 * failure mode is a menu entry that authenticates as a user nobody created.
 *
 * They are chosen to differ in **authority**, not in name, because that is what there is
 * to test. Each role exercises a different set of UI gates:
 *
 *   * `project-admin` holds everything, so it is the baseline where nothing is hidden;
 *   * `project-editor` authors and validates but cannot publish, approve, or grant a
 *     waiver — the governance controls should be absent, not merely blocked;
 *   * `project-viewer` is read-only, so every write control should be gone;
 *   * `organisation-admin` administers membership and the project structure and
 *     deliberately holds no project content keys, which is the case that catches a
 *     control gated on the wrong thing — the mistake that hid the asset upload surface.
 *
 * **Each organisation holds one of every role**, and that symmetry is the point rather than
 * tidiness. A list with four identities in the first organisation and two in the second
 * cannot answer the questions the second tenant exists to ask: whether an *editor* in
 * another organisation can author, or whether an *organisation* administrator there is
 * refused the project keys their counterpart is refused. It also made the menu read as the
 * first organisation plus an afterthought. `system-admin` is deliberately not among them:
 * it is a system-scope role, held across organisations and owned by none, so an
 * organisation owning one of every role is four identities, not five.
 *
 * An identity names a **person**, the organisation that person belongs to, and the role
 * they hold there. Nothing else about it is a fact about who is acting: the scope it is
 * held at and the reason it exists are properties of the test these identities set up, and
 * they belong in this file and the session record, not in the menu. Every role therefore
 * appears twice in the menu, once per organisation, and the organisation is what tells the
 * two apart.
 *
 * Scopes matter as much as roles. `facility.validate.run`, `facility.publish`, and
 * `facility.waiver.grant` are project-scoped, so an organisation role never implies them
 * however senior it sounds. That is why the admin identity's own project role is listed
 * separately from its organisation one.
 *
 * Each project identity also carries an organisation-scoped **read** role, and that is not
 * padding. The projects list is checked at organisation scope — the caller has not chosen a
 * project yet — and the evaluator matches project scope, then organisation, then global. So
 * a role held only at project scope can read everything in the project and still not be
 * able to find it: the list refuses, the workspace never opens, and the identity cannot be
 * used to test anything at all. `project-viewer` grants read and nothing else, so lending
 * it at organisation scope is what membership means here and cannot blur the write gating
 * these identities exist to exercise.
 */

/** Where a role is held. An organisation role is not a project role. */
export const PROJECT = 'project';
export const ORGANISATION = 'organisation';

/**
 * The organisations the dev seed creates, and the project each one holds.
 *
 * Tenancy is part of what there is to test — a reference that crosses a tenant, or a
 * permission that resolves at the wrong one, is exactly the class of bug row-level
 * security and the tenant-key discipline exist to catch — and it takes two organisations
 * to see it. So this list is the same kind of shared fact as the identity list above:
 * the seed creates them, the dev server tells a session which one belongs to the identity
 * it is acting as, and the facility seed fills each project.
 *
 * The second organisation's id is **fixed** rather than allocated, because a session has
 * to know which organisation to list before it has read the database. The primary's is
 * whatever the seed allocated on first run — changing it now would strand an existing
 * project — so a session falls back to `VITE_ORGANISATION_ID` for that one, which the
 * seed writes.
 */
export const DEV_ORGANISATIONS = Object.freeze([
  Object.freeze({
    key: 'primary',
    name: 'Development organisation',
    projectName: 'Northern DC Campus',
    ownerSubject: 'dev-user',
    organisationId: null,
  }),
  Object.freeze({
    key: 'cascade',
    name: 'Cascade Cloud',
    projectName: 'Cascade Ridge Campus',
    ownerSubject: 'dev-second-admin',
    // UUID v5 over the seed namespace (6f9619ff-8b86-d011-b42d-00c04fc964ff) and
    // "dev-organisation:cascade-cloud", so the id is stable across every machine.
    organisationId: 'e3be6d4b-a1aa-5b44-bef0-dd8ff28a5e2d',
  }),
]);

/** The keys the identities below name their organisation by. */
const PRIMARY = 'primary';
const CASCADE = 'cascade';

/**
 * One identity: a **person**, the organisation they belong to, and the role they hold.
 *
 * Those three facts are the whole of it, and the account control renders exactly them.
 * A development identity is otherwise easy to describe by its role and its scope — "the
 * project administrator", "the second organisation's admin" — which reads as a
 * description of a permission rather than of a person, and leaves a session unable to
 * say who it is acting as.
 *
 * `roleLabel` is the name the RBAC catalog gives the role (`002_workspace_identity_rbac.sql`),
 * so it is never invented here; `name` is a person, and it is what the seed writes to
 * `users.display_name`.
 */
const defineIdentity = ({ subject, name, roleKey, roleLabel, scope, organisation, organisationReadRoleKey = null }) => {
  const organisationEntry = DEV_ORGANISATIONS.find((entry) => entry.key === organisation);
  return Object.freeze({
    subject,
    name,
    roleKey,
    roleLabel,
    scope,
    organisation,
    organisationName: organisationEntry?.name ?? null,
    // A session has to know which organisation to list before it has read the database;
    // only the second organisation's id is a constant (see DEV_ORGANISATIONS).
    organisationId: organisationEntry?.organisationId ?? null,
    organisationReadRoleKey,
  });
};

export const DEV_IDENTITIES = Object.freeze([
  // Development organisation — one of every role, in the order the roles are described
  // above: the administrator who holds everything, the editor, the viewer, and the
  // organisation administrator who holds no project content keys.
  defineIdentity({
    subject: 'dev-user',
    name: 'Dana Whitfield',
    roleKey: 'project-admin',
    roleLabel: 'Project administrator',
    scope: PROJECT,
    organisation: PRIMARY,
  }),
  defineIdentity({
    subject: 'dev-editor',
    name: 'Ravi Menon',
    roleKey: 'project-editor',
    roleLabel: 'Project editor',
    scope: PROJECT,
    organisation: PRIMARY,
    organisationReadRoleKey: 'project-viewer',
  }),
  defineIdentity({
    subject: 'dev-viewer',
    name: 'Mei Lin',
    roleKey: 'project-viewer',
    roleLabel: 'Project viewer',
    scope: PROJECT,
    organisation: PRIMARY,
    organisationReadRoleKey: 'project-viewer',
  }),
  defineIdentity({
    subject: 'dev-org-admin',
    name: 'Alex Okafor',
    roleKey: 'organisation-admin',
    roleLabel: 'Organisation administrator',
    scope: ORGANISATION,
    organisation: PRIMARY,
  }),

  // Cascade Cloud — the same four roles in the same order, so the two organisations can be
  // compared entry by entry. A role missing here is a question the second tenant cannot be
  // asked: whether an editor elsewhere may author, or whether an organisation administrator
  // elsewhere is refused the project keys.
  defineIdentity({
    subject: 'dev-second-admin',
    name: 'Priya Raman',
    roleKey: 'project-admin',
    roleLabel: 'Project administrator',
    scope: PROJECT,
    organisation: CASCADE,
  }),
  defineIdentity({
    subject: 'dev-second-editor',
    name: 'Ines Alvarado',
    roleKey: 'project-editor',
    roleLabel: 'Project editor',
    scope: PROJECT,
    organisation: CASCADE,
    organisationReadRoleKey: 'project-viewer',
  }),
  defineIdentity({
    subject: 'dev-second-viewer',
    name: 'Tom Beckwith',
    roleKey: 'project-viewer',
    roleLabel: 'Project viewer',
    scope: PROJECT,
    organisation: CASCADE,
    organisationReadRoleKey: 'project-viewer',
  }),
  defineIdentity({
    subject: 'dev-second-org-admin',
    name: 'Noah Bergstrom',
    roleKey: 'organisation-admin',
    roleLabel: 'Organisation administrator',
    scope: ORGANISATION,
    organisation: CASCADE,
  }),
]);

/** The identity a session acts as when nothing has been chosen. */
export const DEFAULT_DEV_SUBJECT = DEV_IDENTITIES[0].subject;

/**
 * An identity as far as the browser is concerned: who is acting, and the two facts the
 * client needs to act as them.
 *
 * This is a projection rather than the whole record, and the difference is the point. The
 * list above is what the **seed** needs — the role it grants, the scope it grants it at, the
 * organisation-scope read role that makes the projects list answer — and none of that is a
 * fact about a person. The menu answers "who am I acting as", and the way to guarantee it
 * cannot drift into answering something else is for the fields it must not show never to
 * reach it. A comment asking a future editor to be careful is not a boundary; this is.
 *
 * `organisationId` is not part of the identity either, but the client cannot act as the
 * identity without it: the projects list is read at organisation scope, and the second
 * organisation's id is the only one a session can know before it has read the database.
 */
export function clientIdentity(identity) {
  if (!identity) return null;
  return {
    subject: identity.subject,
    name: identity.name,
    organisationName: identity.organisationName,
    roleLabel: identity.roleLabel,
    organisationId: identity.organisationId,
  };
}

/** Every identity, projected for the dev server to serve. */
export function clientIdentities() {
  return DEV_IDENTITIES.map(clientIdentity);
}

export function identityFor(subject) {
  return DEV_IDENTITIES.find((identity) => identity.subject === subject) ?? null;
}

/** The organisation an identity belongs to, or null for a subject nobody declared. */
export function organisationFor(subject) {
  return DEV_ORGANISATIONS.find((organisation) => organisation.ownerSubject === subject)
    ?? DEV_ORGANISATIONS.find((organisation) => identityFor(subject)?.organisation === organisation.key)
    ?? null;
}

/**
 * The organisation id a session acting as `subject` should list projects for.
 *
 * Null means "the session's own default", which is `VITE_ORGANISATION_ID`: the primary
 * organisation is allocated by the seed, so only its members can be resolved without
 * reading the database.
 */
export function organisationIdFor(subject) {
  return identityFor(subject)?.organisationId ?? null;
}

/**
 * The subjects the dev server is willing to mint for.
 *
 * The default subject is always included even if the list is edited, so that removing the
 * identity the app defaults to cannot lock a session out of its own dev stack.
 */
export function devSubjects({ include = DEFAULT_DEV_SUBJECT } = {}) {
  const subjects = new Set(DEV_IDENTITIES.map((identity) => identity.subject));
  if (include) subjects.add(include);
  return [...subjects];
}
