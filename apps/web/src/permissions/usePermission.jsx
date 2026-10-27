import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { withDevIdentity } from '../app/dev-identity.js';
import { createPermissionClient } from '../rbac/client.js';

/**
 * The shared client permission gateway (blueprint §9).
 *
 * Relocated here from the prototype shell in W2. The implementation is still the
 * single `can()` from `rbac/client.js`; this file only supplies the React
 * binding.
 *
 * Rules this file exists to enforce:
 *  * **Three-state, never two.** `allowed` starts `null` (pending), not `false`,
 *    because defaulting to denied renders a permission error while the check is
 *    still in flight.
 *  * **Never call `can()` in a boolean position.** It returns a promise.
 *  * **Hiding is presentation, not security.** The server refuses the call.
 *  * **"Could not check" is distinct from "denied".**
 */

const PermissionContext = createContext(null);

let fallbackClient = null;
function getFallbackClient() {
  // The dev identity rides on the fetch, not on the predicate: the predicate is kept
  // dependency-free by an import-boundary test, and this is the layer that is allowed to
  // know about a development affordance.
  if (!fallbackClient) fallbackClient = createPermissionClient({ fetchImpl: withDevIdentity() });
  return fallbackClient;
}

export function PermissionProvider({ client, unscopedKeys = null, children }) {
  const value = useMemo(() => {
    const resolved = client ?? getFallbackClient();
    // Seeding during render keeps a known positive answerable on the first paint,
    // including under server rendering where effects never run.
    if (unscopedKeys) resolved.setUnscopedKeys?.(unscopedKeys);
    return resolved;
  }, [client, unscopedKeys]);
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export function usePermissionClient() {
  return useContext(PermissionContext) ?? getFallbackClient();
}

/** Returns `{ allowed, pending, unavailable }`; `allowed` is null while in flight. */
export function usePermission(key, scope = {}) {
  const client = usePermissionClient();
  const projectId = scope.projectId ?? null;
  const organisationId = scope.organisationId ?? null;

  // The local key set proves unscoped positives without a round trip. It never
  // proves a negative, so a miss falls through to the server.
  const provenLocally = Boolean(key) && !projectId && !organisationId && client.hasUnscopedKey?.(key) === true;

  const [allowed, setAllowed] = useState(provenLocally ? true : key ? null : false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!key || provenLocally) {
      if (!key) setAllowed(false);
      return undefined;
    }

    let active = true;
    setAllowed(null);

    client.check(key, { projectId, organisationId }).then((result) => {
      if (!active) return;
      setUnavailable(!result.determined);
      setAllowed(result.allowed);
    });

    return () => {
      active = false;
    };
  }, [client, key, projectId, organisationId, provenLocally]);

  return { allowed, pending: allowed === null, unavailable };
}

/** Declarative gate. Renders `pending` while undecided, never a flash of denial. */
export function Can({ permission, projectId = null, organisationId = null, pending = null, fallback = null, children }) {
  const state = usePermission(permission, { projectId, organisationId });
  if (state.pending) return pending;
  if (!state.allowed) return fallback;
  return children;
}

/**
 * Call when roles or membership change: a cache cleared only on login/logout
 * keeps a demoted user privileged for the rest of the session.
 */
export function usePermissionInvalidate() {
  const client = usePermissionClient();
  return useCallback(() => client.invalidate(), [client]);
}
