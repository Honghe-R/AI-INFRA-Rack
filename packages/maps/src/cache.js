/**
 * Tile cache and burst rate limiting.
 *
 * Both are in-process and deliberately small: the specification calls the tile
 * cache disposable and rebuildable, and a burst limit is a protection, not a
 * billing control (the quota is). A multi-instance deployment replaces these with
 * a shared store; the interfaces stay the same.
 */

/** A bounded TTL cache keyed by provider, style, and tile coordinates. */
export function createTileCache({ maxEntries = 500, now = Date.now } = {}) {
  const entries = new Map();

  function keyOf({ providerId, style, z, x, y }) {
    return `${providerId}|${style ?? '-'}|${z}|${x}|${y}`;
  }

  function get(coordinates) {
    const key = keyOf(coordinates);
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return null;
    }
    // Refresh recency for the eviction order.
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(coordinates, value, ttlSeconds) {
    if (!(ttlSeconds > 0)) return false;
    const key = keyOf(coordinates);
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
    entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    return true;
  }

  return { get, set, get size() { return entries.size; }, clear: () => entries.clear() };
}

/**
 * A sliding-window limiter: at most `limit` events per `windowMs` for a key.
 * `check` records the event when it is allowed.
 */
export function createRateLimiter({ limit, windowMs, now = Date.now } = {}) {
  if (!(limit > 0) || !(windowMs > 0)) throw new Error('createRateLimiter requires a positive limit and window.');

  const hits = new Map();

  function check(key) {
    const current = now();
    const window = hits.get(key) ?? [];
    const recent = window.filter((timestamp) => current - timestamp < windowMs);
    if (recent.length >= limit) {
      const retryAfterMs = windowMs - (current - recent[0]);
      hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }
    recent.push(current);
    hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }

  return { check, get trackedKeys() { return hits.size; }, clear: () => hits.clear() };
}
