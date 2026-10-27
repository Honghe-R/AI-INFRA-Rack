/**
 * Finding a feature in the drawn graph.
 *
 * Pure, and separate from the control that renders it, for the reason `facility-overlay.js`
 * is pure: the ranking is a decision worth asserting without a browser, and the control is
 * left with nothing but presentation.
 *
 * The search runs over what is **drawn** — the shapes the canvas is painting. A hit that
 * cannot be highlighted would be a promise the tool cannot keep, so a feature behind a
 * hidden layer switch is not a result at all, and the control says how many are behind one
 * rather than quietly reporting no match.
 */

/** How many results the panel lists before it counts the rest instead. */
export const SEARCH_RESULT_LIMIT = 8;

/**
 * How well each field answers a query. A name is what a person searches by, a type is what
 * they search by when they do not know the name, and the layer is a fallback that keeps
 * "utilities" from returning nothing.
 */
const FIELDS = Object.freeze([
  { field: 'displayName', weight: 3 },
  { field: 'entityType', weight: 2 },
  { field: 'role', weight: 1 },
  { field: 'layer', weight: 0 },
]);

/**
 * The shapes matching `query`, best first.
 *
 * Three grades of match, and the grade decides before the field does: a field that *is* the
 * query beats one that starts with it, which beats one that merely contains it. So "hall"
 * finds a feature named "Hall" before "Data Hall 01", and both before a `SUPPORT_SPACE`
 * whose role happens to contain the word. Equal scores keep the order they were drawn in,
 * which is the layer order — the same order the map reads in.
 */
export function searchShapes(shapes = [], query = '') {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle.length === 0) return [];

  const scored = [];
  shapes.forEach((shape, index) => {
    const score = scoreOf(shape, needle);
    if (score > 0) scored.push({ shape, score, index });
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.shape);
}

/** The best score any field of a shape earns, or 0 for no match at all. */
function scoreOf(shape, needle) {
  let best = 0;
  for (const { field, weight } of FIELDS) {
    const value = shape?.[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    const haystack = value.toLowerCase();
    const grade = haystack === needle ? 3 : haystack.startsWith(needle) ? 2 : haystack.includes(needle) ? 1 : 0;
    if (grade === 0) continue;
    best = Math.max(best, grade * 10 + weight);
  }
  return best;
}
