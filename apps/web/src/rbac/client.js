/**
 * The client permission predicate (blueprint §9).
 *
 * `can()` is async despite the name — a promise used in a boolean position is
 * always truthy, so every call site must await it. Decision identity is
 * `(key, organisationId, projectId)`: an unscoped call is a *global* question and
 * must never reuse a scoped answer, or vice versa.
 *
 * Fail closed. A non-OK response or a transport error yields `allowed: false`.
 * `check()` also reports `determined`, so a caller can distinguish "the server
 * said no" from "we could not ask" instead of letting an outage masquerade as a
 * policy decision. Non-determined results are never cached.
 */
export function createPermissionClient({
  baseUrl = '',
  fetchImpl = globalThis.fetch,
  ttlMs = 30_000,
  now = Date.now,
  checkPath = '/api/v1/me/permissions/check',
  keysPath = '/api/v1/me/permissions',
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  let unscopedKeys = null;

  function endpoint(key, { projectId, organisationId }) {
    const params = new URLSearchParams({ function_key: key });
    if (projectId) params.set('project_id', projectId);
    if (organisationId) params.set('organisation_id', organisationId);
    return `${baseUrl}${checkPath}?${params.toString()}`;
  }

  async function load(key, scope) {
    try {
      const response = await fetchImpl(endpoint(key, scope), { headers: { accept: 'application/json' } });
      if (!response.ok) return { allowed: false, determined: false };
      const body = await response.json();
      return { allowed: body?.data?.allowed === true, determined: true };
    } catch {
      return { allowed: false, determined: false };
    }
  }

  async function check(key, scope = {}) {
    const projectId = scope.projectId ?? null;
    const organisationId = scope.organisationId ?? null;
    const identity = `${key}|${organisationId ?? '-'}|${projectId ?? '-'}`;

    // The local key set proves unscoped positives only. A miss falls through to
    // the server; it must never be read as a denial.
    if (!projectId && !organisationId && unscopedKeys?.has(key)) return { allowed: true, determined: true };

    const hit = cache.get(identity);
    if (hit && hit.expiresAt > now()) return hit.value;

    const pending = inflight.get(identity);
    if (pending) return pending;

    const promise = load(key, { projectId, organisationId })
      .then((value) => {
        if (value.determined) cache.set(identity, { value, expiresAt: now() + ttlMs });
        return value;
      })
      .finally(() => inflight.delete(identity));

    inflight.set(identity, promise);
    return promise;
  }

  return {
    /** Boolean convenience. Fails closed. */
    async can(key, scope) {
      return (await check(key, scope)).allowed;
    },

    /** `{ allowed, determined }` — for surfaces that must show "could not check". */
    check,

    /** Seeds the unscoped fast path from an already-fetched key set. */
    setUnscopedKeys(keys) {
      unscopedKeys = new Set(keys);
      return unscopedKeys.size;
    },

    /**
     * Synchronous fast path: does the locally known key set prove this unscoped
     * question? Only positives can be proved here — a miss must be asked, never
     * assumed false.
     */
    hasUnscopedKey(key) {
      return unscopedKeys?.has(key) === true;
    },

    async loadUnscopedKeys() {
      try {
        const response = await fetchImpl(`${baseUrl}${keysPath}`, { headers: { accept: 'application/json' } });
        if (!response.ok) return null;
        const body = await response.json();
        unscopedKeys = new Set(body?.data?.keys ?? []);
        return unscopedKeys;
      } catch {
        return null;
      }
    },

    /** Call when roles or membership change, or a demoted user stays privileged. */
    invalidate() {
      const size = cache.size;
      cache.clear();
      unscopedKeys = null;
      return size;
    },

    get cacheSize() {
      return cache.size;
    },
  };
}
