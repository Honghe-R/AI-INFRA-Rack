/**
 * Acting as a different identity in development.
 *
 * The identity is a **request header**, not a client-side fiction: the dev server's proxy
 * reads it and mints a bearer token for that subject, so switching changes what the API
 * thinks the caller is and therefore what it will answer. Anything else — hiding controls
 * client-side — would test the CSS rather than the permissions, and would show a role's
 * view that the server would never actually grant.
 *
 * The list comes from the dev server rather than from this module, because the dev server
 * is also what mints the tokens: one endpoint, one list, and a build has neither. What it
 * serves is a projection of the seed's record — the person, their organisation, their role,
 * the subject to send, and the organisation to list projects for — so the fields the account
 * menu must not show are not in the browser for it to show. A failed or absent read means
 * there is nothing to switch between, which is the production case and also the case of a
 * dev server with no `AUTH_DEV_SECRET`.
 */
const STORAGE_KEY = 'ai-infra.dev-identity';

/** The header the dev proxy reads. It is stripped before the request reaches the API. */
export const DEV_IDENTITY_HEADER = 'x-dev-subject';

/**
 * The identity this session asked to act as, or null for the server's default.
 *
 * Read from storage on every call rather than cached in a module variable, so a change in
 * another tab — or a reload after choosing — cannot leave a stale subject being sent.
 */
export function currentDevIdentity(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    // Private mode, or storage disabled. Not being able to remember a choice must not
    // stop the app from working.
    return null;
  }
}

export function rememberDevIdentity(subject, storage = globalThis.localStorage) {
  try {
    if (subject) storage?.setItem(STORAGE_KEY, subject);
    else storage?.removeItem(STORAGE_KEY);
  } catch {
    // As above: the choice simply does not persist.
  }
}

/**
 * The header to send, or an empty object.
 *
 * Exported so every client that talks to the API sends it: the permission client has its
 * own `fetch` and does not go through the API client, so a header added in only one place
 * left the checks answering as the default identity — every role then saw every control,
 * which is precisely the thing this exists to test.
 */
export function devIdentityHeaders(storage = globalThis.localStorage) {
  const subject = currentDevIdentity(storage);
  return subject ? { [DEV_IDENTITY_HEADER]: subject } : {};
}

/**
 * A `fetch` that carries the identity header.
 *
 * The permission predicate is deliberately dependency-free, so it cannot import this
 * module and cannot add the header itself. Wrapping the fetch it is constructed with keeps
 * that boundary intact and keeps the dev concern in the app layer, where a deployment's
 * build drops it along with the rest.
 *
 * The subject is read per request rather than captured, so a switch takes effect without
 * rebuilding anything.
 */
const wrappedFetches = new WeakMap();

export function withDevIdentity(fetchImpl = globalThis.fetch) {
  // Memoised, and that is load-bearing rather than an optimisation. This is used as a
  // default parameter — `fetchImpl = withDevIdentity()` — and a default parameter is
  // evaluated on every render, so it handed back a new function each time. Anything that
  // put that function in an effect's dependency list re-ran the effect on every render,
  // set state, and rendered again: an unbounded loop of key-set reads, at roughly 190
  // requests a second. Returning the same wrapper for the same fetch removes the trap
  // rather than requiring every call site to remember it.
  const existing = wrappedFetches.get(fetchImpl);
  if (existing) return existing;

  const wrapper = async (url, options = {}) => {
    const response = await fetchImpl(url, { ...options, headers: { ...options.headers, ...devIdentityHeaders() } });
    if (response.status === 401 && typeof globalThis.dispatchEvent === 'function') globalThis.dispatchEvent(new Event('rack:session-expired'));
    return response;
  };
  wrappedFetches.set(fetchImpl, wrapper);
  return wrapper;
}

/** The identities the dev server offers, or an empty list when it offers none. */
export async function loadDevIdentities({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl('/__dev/identities', { headers: { accept: 'application/json' } });
    if (!response.ok) return { available: false, identities: [], defaultSubject: null };
    const body = await response.json();
    const identities = body?.data?.identities ?? [];
    return {
      available: identities.length > 0,
      identities,
      defaultSubject: body?.data?.defaultSubject ?? null,
    };
  } catch {
    return { available: false, identities: [], defaultSubject: null };
  }
}

/**
 * The organisation a session acting as `subject` should list projects for.
 *
 * The organisation is a session fact, not a build-time one: an identity in the second
 * organisation must list the second organisation's projects, and a single
 * `VITE_ORGANISATION_ID` cannot say that. The dev server declares the organisation on
 * the identities it knows (`organisationId`), and this resolves the current choice
 * against that list.
 *
 * `fallback` is the deployment's answer and the primary organisation's: the first
 * organisation's id is allocated by the seed, so it is not a constant the list could
 * carry, and the env var the seed writes is the one thing that knows it.
 */
export async function resolveDevOrganisation({
  fallback = null,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
} = {}) {
  const { identities, defaultSubject } = await loadDevIdentities({ fetchImpl });
  const subject = currentDevIdentity(storage) ?? defaultSubject ?? null;
  if (!subject) return fallback;
  const identity = identities.find((item) => item.subject === subject) ?? null;
  return identity?.organisationId ?? fallback;
}

/**
 * What the menu shows as the current identity.
 *
 * A subject that was chosen and has since been removed from the list still reads as
 * itself rather than silently reverting: the header is still being sent, so pretending
 * otherwise would describe a session that is not the one running.
 */
export function describeIdentity({ identities = [], subject = null, fallbackName = null } = {}) {
  const known = identities.find((identity) => identity.subject === subject) ?? null;
  if (known) {
    return {
      subject: known.subject,
      // Who is acting: a person, their organisation, and their role. The menu shows all
      // three, and the control shows the name. Nothing here describes the *project* — the
      // same person holds the same role in every project they belong to, so naming one
      // would suggest the identity were a property of it.
      name: known.name ?? known.subject,
      organisationName: known.organisationName ?? null,
      roleLabel: known.roleLabel ?? null,
      known: true,
    };
  }
  // A subject that was chosen and has since been removed from the list still reads as
  // itself rather than silently reverting: the header is still being sent, so pretending
  // otherwise would describe a session that is not the one running. Its organisation and
  // role are not knowable, and claiming them would be worse than showing the subject.
  if (subject) return { subject, name: subject, organisationName: null, roleLabel: null, known: false };
  return { subject: null, name: fallbackName ?? 'Account', organisationName: null, roleLabel: null, known: true };
}
