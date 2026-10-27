/**
 * Port occupancy: who is listening, and where that process runs.
 *
 * `dev.mjs` has to tell three situations apart before it spawns anything, because the
 * remedy differs in each:
 *
 *   - the port is free;
 *   - a server from this repository holds it — usually a dev loop whose terminal went away,
 *     since `dev.mjs` starts its children detached so it can signal the whole tree;
 *   - something else holds it, such as a PostgreSQL installed on the host.
 *
 * "Address already in use" cannot distinguish them, so this reports the pid and the process's
 * working directory and lets the caller decide, since only the caller knows which directory
 * its own server runs from. Failing closed matters more than answering: when the host cannot
 * tell us (no `lsof`, or it was denied) the state is `unknown`, never a guess, because the
 * caller's next step may be to stop a process.
 */
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute, relative } from 'node:path';
import { connect } from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Whether something accepts a connection on `port`.
 *
 * Both loopbacks are probed, because the two servers do not bind the same one: the API
 * listens on `::` and Vite on `::1`. Probing `127.0.0.1` alone would report a live Vite
 * server as free — the same mismatch the README describes when it says to open `localhost`
 * rather than `127.0.0.1`.
 */
export async function portInUse(port, { hosts = ['127.0.0.1', '::1'], timeoutMs = 750 } = {}) {
  const attempts = hosts.map(
    (host) =>
      new Promise((resolve) => {
        const socket = connect({ host, port: Number(port) });
        const done = (value) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.on('error', () => done(false));
        socket.on('connect', () => done(true));
      }),
  );
  return (await Promise.all(attempts)).some(Boolean);
}

/**
 * Pids listening on `port`, or `null` when the host cannot tell us.
 *
 * "Nothing is listening" (`[]`) and "we cannot say" (`null`) are different answers, and only
 * the first is safe to start on, so the two are not collapsed.
 */
export async function listenersOn(port) {
  try {
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      timeout: 5000,
    });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number)
      .filter(Number.isInteger);
  } catch (error) {
    // `lsof` exits 1 when nothing matches, which is an answer rather than a failure.
    if (error.code === 1) return [];
    return null;
  }
}

/** The working directory of `pid`, or `null` when it cannot be read. */
export async function processCwd(pid) {
  try {
    const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: 5000,
    });
    // `-Fn` prints one field per line; the path is the `n`-prefixed one.
    const field = stdout.split('\n').find((line) => line.startsWith('n'));
    return field ? field.slice(1) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `path` is `root` or sits beneath it.
 *
 * `path.relative` does the comparing rather than a string prefix, so `/repo-other` is not
 * treated as being inside `/repo`, and a trailing separator on either argument does not
 * matter.
 */
export function isInside(root, path) {
  if (!path) return false;
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Describes whoever holds `port`.
 *
 * A listener is reported with its working directory rather than a process name, because the
 * directory is what identifies the server: `npm` and `node --watch` wrappers are not the
 * processes holding the port, and the answer to "did this checkout start it" is where it
 * runs, not what it is called.
 *
 * @returns {Promise<
 *   {state: 'free', listeners: []} |
 *   {state: 'occupied', listeners: Array<{pid: number, cwd: string|null}>} |
 *   {state: 'unknown', listeners: []}
 * >}
 */
export async function describePort(port) {
  if (!(await portInUse(port))) return { state: 'free', listeners: [] };

  const pids = await listenersOn(port);
  if (pids === null || pids.length === 0) return { state: 'unknown', listeners: [] };

  const listeners = [];
  for (const pid of pids) listeners.push({ pid, cwd: await processCwd(pid) });
  return { state: 'occupied', listeners };
}

/**
 * Waits for `port` to be free, and to *stay* free for `settleMs`.
 *
 * The settle window is not padding. Killing the process that listens can leave a supervisor
 * behind (`node --watch` waits for a file change rather than exiting), and a port that frees
 * and is retaken a moment later would race the replacement we are about to start. Requiring
 * quiet catches that instead of starting on top of it.
 */
export async function waitForPortFree(port, { timeoutMs = 5000, settleMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) {
      await delay(150);
      continue;
    }
    await delay(settleMs);
    return !(await portInUse(port));
  }
  return false;
}
