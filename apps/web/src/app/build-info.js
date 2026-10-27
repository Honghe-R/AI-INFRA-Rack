/**
 * The build the browser is running.
 *
 * `vite.config.js` injects `__BUILD_COMMIT__` when the bundle is compiled — the
 * repository's HEAD, or `GIT_COMMIT`/`SOURCE_VERSION` when the build has no checkout to ask.
 * It is a build-time constant rather than a read from the API on purpose: a reader has to be
 * able to say which build *this browser* is actually running, and a value fetched from the
 * server would describe the server — while a cached bundle would report the new one.
 *
 * The `typeof` guard is what lets this module be compiled without the define — a test, a
 * script, a tool that imports it directly. `typeof` on an undeclared identifier is
 * `'undefined'` rather than an error, so the fallback is reached instead of throwing.
 */
export const BUILD_COMMIT = (typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : '').trim() || null;

/**
 * The short form a menu draws, with the full value left for the element's title. A commit
 * is read as an identifier rather than as prose, so it is shortened for the line and kept
 * whole where it can still be copied.
 */
export function shortCommit(commit = BUILD_COMMIT) {
  const value = typeof commit === 'string' ? commit.trim() : '';
  return value ? value.slice(0, 7) : null;
}
