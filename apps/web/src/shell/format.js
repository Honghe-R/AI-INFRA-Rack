/**
 * Small display formatters for shell chrome.
 *
 * Identifiers are UUIDs. A full one is unreadable and, repeated in three places,
 * dominates the interface; a short form is legible and still enough to tell two
 * snapshots apart at a glance. Anything that shows a short identifier also keeps
 * the full value in a `title`, so nothing is hidden from a user who needs it.
 */

/** The first eight characters of an identifier, or the whole value if it is short. */
export function shortId(value) {
  if (typeof value !== 'string') return '';
  return value.length > 12 ? value.slice(0, 8) : value;
}
