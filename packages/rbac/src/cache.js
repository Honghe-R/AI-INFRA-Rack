/**
 * A small TTL cache with in-flight de-duplication and tag invalidation.
 *
 * Two rules from the blueprint drive the shape (§5, invariant 8):
 *  * a short TTL, because permissions should not be stale for minutes;
 *  * every grant has a matching invalidation, so entries carry tags
 *    (`user:<id>`, `project:<id>`, `organisation:<id>`, `catalog`) that an
 *    assignment, membership, or role-mapping change can drop by name.
 *
 * In-flight loads are shared, so a screen that asks for the same decision
 * several times produces one query. In-flight work is not cancelled by an
 * invalidation; the TTL bounds how long a racing value can survive.
 */
export function createTtlCache({ ttlMs = 30_000, now = Date.now, maxEntries = 10_000 } = {}) {
  const entries = new Map();
  const inflight = new Map();

  function trim() {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  return {
    /** Returns a live value without loading, or `undefined`. */
    peek(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },

    /** Stores a value explicitly. Callers that must not cache negatives use this. */
    set(key, value, tags = []) {
      entries.set(key, { value, expiresAt: now() + ttlMs, tags: new Set(tags) });
      trim();
      return value;
    },

    async getOrLoad(key, loader, tags = []) {
      const hit = entries.get(key);
      if (hit) {
        if (hit.expiresAt > now()) return hit.value;
        entries.delete(key);
      }

      const pending = inflight.get(key);
      if (pending) return pending;

      const promise = (async () => {
        const value = await loader();
        entries.set(key, { value, expiresAt: now() + ttlMs, tags: new Set(tags) });
        trim();
        return value;
      })().finally(() => inflight.delete(key));

      inflight.set(key, promise);
      return promise;
    },

    /** Drops every entry carrying any of the given tags. Returns the count. */
    invalidateTags(tags) {
      const wanted = new Set(Array.isArray(tags) ? tags : [tags]);
      let removed = 0;
      for (const [key, item] of entries) {
        for (const tag of item.tags) {
          if (wanted.has(tag)) {
            entries.delete(key);
            removed += 1;
            break;
          }
        }
      }
      return removed;
    },

    clear() {
      const size = entries.size;
      entries.clear();
      return size;
    },

    get size() {
      return entries.size;
    },

    get inflightCount() {
      return inflight.size;
    },
  };
}
