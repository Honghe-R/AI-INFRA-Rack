/**
 * Bounding over failing (chatbox blueprint §4.3).
 *
 * An over-budget tool result or digest is an expected condition: sanitize it,
 * shrink it through progressively harsher profiles, and return a self-describing
 * envelope that states what was cut. Nothing here throws on hostile input —
 * cycles, excessive depth, BigInt, buffers, maps, sets, invalid dates, and
 * getters that throw all become explicit markers.
 */
export const SHRINK_PROFILES = Object.freeze([
  { maxItems: 50, maxString: 2_000, maxKeys: 50 },
  { maxItems: 10, maxString: 500, maxKeys: 20 },
  { maxItems: 3, maxString: 120, maxKeys: 8 },
]);

export const DEFAULT_RESULT_BYTES = 32_768;
export const DEFAULT_DIGEST_BYTES = 8_192;

/** A structural copy that cannot throw and whose output is always JSON-safe. */
export function sanitize(value, { maxDepth = 6, maxItems = 200, maxString = 4_000, maxKeys = 100 } = {}) {
  const seen = new WeakSet();

  function walk(node, depth) {
    if (node === null) return null;
    const type = typeof node;
    if (type === 'string') return node.length > maxString ? `${node.slice(0, maxString)}…[string truncated]` : node;
    if (type === 'number') return Number.isFinite(node) ? node : `[number ${String(node)}]`;
    if (type === 'boolean') return node;
    if (type === 'undefined') return '[undefined]';
    if (type === 'bigint') return `${node.toString()}n`;
    if (type === 'function') return '[function]';
    if (type === 'symbol') return '[symbol]';
    if (depth > maxDepth) return '[depth limit]';
    if (node instanceof Date) return Number.isNaN(node.getTime()) ? '[invalid date]' : node.toISOString();
    if (Buffer.isBuffer(node) || node instanceof Uint8Array) return `[bytes:${node.length}]`;
    if (node instanceof Map) return { '[map]': [...node.entries()].slice(0, maxItems).map(([k, v]) => [walk(k, depth + 1), walk(v, depth + 1)]) };
    if (node instanceof Set) return { '[set]': [...node.values()].slice(0, maxItems).map((item) => walk(item, depth + 1)) };
    if (typeof node?.then === 'function') return '[promise]';
    if (seen.has(node)) return '[circular]';
    seen.add(node);

    if (Array.isArray(node)) {
      const items = node.slice(0, maxItems).map((item) => walk(item, depth + 1));
      if (node.length > maxItems) items.push(`[${node.length - maxItems} more items]`);
      return items;
    }

    const output = {};
    let keys = 0;
    for (const key of Object.keys(node)) {
      if (keys >= maxKeys) {
        output['[keys truncated]'] = true;
        break;
      }
      keys += 1;
      try {
        output[key] = walk(node[key], depth + 1);
      } catch {
        // A hostile getter is a marker, never a thrown serialization error.
        output[key] = '[unreadable]';
      }
    }
    return output;
  }

  return walk(value, 0);
}

export function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '');
}

/**
 * Bounds a tool result or digest. Returns the value to hand to the model plus a
 * notice when anything was cut. `kind` labels the envelope ('digest' or 'tool').
 */
export function boundValue(value, { limitBytes, kind = 'tool', label = null, profiles = SHRINK_PROFILES } = {}) {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) throw new Error('boundValue requires a positive byte limit.');

  const original = sanitize(value);
  const originalBytes = byteLength(original);
  if (originalBytes <= limitBytes) return { value: original, truncated: false, notice: null, originalBytes };

  const totalItems = Array.isArray(original) ? original.length : null;
  for (const profile of profiles) {
    const candidate = sanitize(value, profile);
    const bytes = byteLength(candidate);
    if (bytes <= limitBytes) return envelope(candidate, { kind, label, originalBytes, limitBytes, totalItems, returnedItems: Array.isArray(candidate) ? candidate.length : null, notice: 'truncated' });
  }

  const metadataOnly = { '[truncated]': true, kind, label, original_bytes: originalBytes, limit_bytes: limitBytes };
  return envelope(metadataOnly, { kind, label, originalBytes, limitBytes, totalItems, returnedItems: 0, notice: 'metadata-only', forceEnvelope: true, raw: true });
}

/**
 * Shrinks an already-built envelope until it fits. Each candidate keeps the
 * truncation disclosure and drops detail, so the value handed back never lies:
 * it either fits with its metadata or says outright that content was omitted.
 */
function hardClamp(value, limitBytes, { kind, label, originalBytes }) {
  const candidates = [
    value,
    { truncated: true, reason: 'hard clamp', kind, tool: label, original_bytes: originalBytes, limit_bytes: limitBytes, data: '[omitted]' },
    { truncated: true, reason: 'hard clamp', data: '[omitted]' },
  ];
  for (const candidate of candidates) {
    if (byteLength(candidate) <= limitBytes) return candidate;
  }
  return '[truncated]';
}

function envelope(data, { kind, label, originalBytes, limitBytes, totalItems, returnedItems, notice, forceEnvelope = false }) {
  const value = {
    truncated: true,
    reason: notice === 'metadata-only' ? 'over-budget after every shrink profile' : 'over-budget',
    kind,
    tool: label,
    original_bytes: originalBytes,
    limit_bytes: limitBytes,
    total_items: totalItems,
    returned_items: returnedItems,
    note: 'The result was truncated. Disclose the truncation and narrow the query.',
    data,
  };
  // A final hard clamp guarantees the limit even if the envelope itself is huge:
  // drop fields until it fits, and fall back to a bare marker string if even the
  // smallest object cannot satisfy a tiny limit.
  const finalValue = hardClamp(value, limitBytes, { kind, label, originalBytes });
  return {
    value: finalValue,
    truncated: true,
    notice: { code: notice === 'metadata-only' ? 'TOOL_RESULT_OVER_BUDGET' : 'TOOL_RESULT_TRUNCATED', kind, tool: label, original_bytes: originalBytes, limit_bytes: limitBytes, returned_items: returnedItems, total_items: totalItems },
    originalBytes,
  };
}
