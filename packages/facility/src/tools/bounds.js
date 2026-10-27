import { ApiError } from '@ai-infra/core';

/**
 * Bounding, paging, and truncation honesty.
 *
 * Two rules from the surface contract meet here:
 *
 *  * a result is capped (200 items, 32768 serialized bytes) and an over-budget
 *    result degrades to a self-describing digest rather than failing;
 *  * a truncated or degraded result MUST NOT be presentable as complete.
 *
 * The second rule is why every list result carries `truncated` and, when it is
 * true, a `notice` the caller is expected to relay. A silent prefix is the one
 * outcome this module exists to prevent.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const MAX_RESULT_BYTES = 32_768;

export function clampLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

/**
 * A revision-bound opaque cursor.
 *
 * It is bound to the revision it was minted for so a cursor cannot be carried to
 * another revision and silently page through a different graph. It carries a
 * position and nothing else — no permission, no object-store key.
 */
export function encodeCursor({ revisionId, offset }) {
  return Buffer.from(JSON.stringify({ r: revisionId, o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor, { revisionId }) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  if (!parsed || typeof parsed.o !== 'number' || parsed.r !== revisionId) throw badCursor();
  return parsed.o;
}

function badCursor() {
  return new ApiError('VALIDATION_FAILED', 'The cursor is not valid for this revision.', {
    status: 400,
    details: [{ field: 'cursor', reason: 'invalid_cursor' }],
  });
}

/**
 * Applies a cursor and a limit to an already-filtered, already-ordered list.
 *
 * The page is bounded by **both** the item limit and the byte budget. Trimming an
 * over-budget page after the fact would be a silent lie about which records exist —
 * and worse, it trims the tail, which is exactly where the newest findings sit. So
 * the byte budget decides where the page ends and the cursor says where to resume;
 * nothing is ever dropped without a cursor to fetch it.
 *
 * Ordering is the caller's responsibility and is what makes a cursor meaningful;
 * this function cannot repair an unordered input.
 */
export function paginate(items, { revisionId, limit, cursor = null, maxBytes = MAX_RESULT_BYTES }) {
  const size = clampLimit(limit);
  const offset = cursor ? decodeCursor(cursor, { revisionId }) : 0;
  // Headroom for the envelope fields that travel with the page.
  const budget = Math.max(1024, maxBytes - 1024);

  const window = [];
  let bytes = 0;
  let limitedByBytes = false;

  for (let index = offset; index < items.length && window.length < size; index += 1) {
    const itemBytes = byteSize(items[index]) + 1;
    if (window.length > 0 && bytes + itemBytes > budget) {
      limitedByBytes = true;
      break;
    }
    window.push(items[index]);
    bytes += itemBytes;
  }

  const nextOffset = offset + window.length;
  const more = nextOffset < items.length;
  return {
    items: window,
    next_cursor: more ? encodeCursor({ revisionId, offset: nextOffset }) : null,
    total: items.length,
    returned: window.length,
    truncated: more,
    page_limited_by: limitedByBytes ? 'bytes' : 'items',
    notice: more && limitedByBytes
      ? `This page ends at ${window.length} of ${items.length} matching records to stay within the result size cap. Follow next_cursor for the rest.`
      : null,
  };
}

/**
 * Measures a result and degrades it when it exceeds the byte cap.
 *
 * A list degrades by dropping items and saying so. A single object too large to
 * return degrades to a self-describing digest of its own shape, because a
 * partially returned object would be a lie about a single entity.
 */
export function boundResult(value) {
  const size = byteSize(value);
  if (size <= MAX_RESULT_BYTES) return { value, truncated: false, notice: null, bytes: size };

  if (value && Array.isArray(value.items)) {
    const items = [...value.items];
    while (items.length > 0 && byteSize({ ...value, items }) > MAX_RESULT_BYTES) items.pop();
    const notice =
      `The result was truncated to ${items.length} of ${value.total} matching items to stay within ` +
      `the ${MAX_RESULT_BYTES}-byte result cap. Narrow the query to see the rest.`;
    return {
      value: { ...value, items, returned: items.length, next_cursor: null, truncated: true, notice },
      truncated: true,
      notice,
      bytes: byteSize(value),
    };
  }

  const keys = value && typeof value === 'object' ? Object.keys(value) : [];
  const notice =
    `The result exceeded the ${MAX_RESULT_BYTES}-byte result cap and was reduced to a digest. ` +
    'Narrow the query to retrieve the full record.';
  return {
    value: { digest_of: 'over_budget_result', keys, notice },
    truncated: true,
    notice,
    bytes: size,
  };
}

export function byteSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
