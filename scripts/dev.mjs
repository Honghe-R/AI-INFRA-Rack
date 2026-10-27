#!/usr/bin/env node
/**
 * The development loop, in one console.
 *
 * Starts the API and the workspace shell together, prefixes their output so interleaved
 * logs stay attributable, and takes both down with one Ctrl-C.
 *
 * Why a script rather than a tool: this spawns two processes, forwards one signal, and
 * prefixes lines. `concurrently` and `npm-run-all` are dependencies for that, and the
 * repository already has dependency-free precedents in `ui-shot` and `dev-stack`.
 *
 * It also pre-flight checks the things a doomed run would otherwise discover late. The ports
 * come first, because an earlier dev loop can outlive its terminal — the children below are
 * started detached so one signal reaches the whole tree — and `EADDRINUSE` from two dying npm
 * trees says nothing about which process holds the port or what to do about it. The two
 * services the API depends on come next: a missing database is the failure that costs the
 * most time, because the API starts happily and then answers 503 on every protected route.
 * Both warnings name the remedy instead of leaving you to read a status code.
 *
 * Port policy, because "reuse what is already running" is the tempting default and the wrong
 * one. A reused server is not owned by this console: Ctrl-C would not stop it, its logs are
 * not here, and its environment was read when it started, so a `.env` change since then is
 * invisible. That is the same confusing failure the checks above exist to prevent. So the
 * default stops before spawning anything and prints the command that fixes it; `--kill`
 * reclaims a port this repository is holding, and `--reuse` joins a server deliberately,
 * saying plainly that this console does not own it.
 *
 * Both processes stay on the host, so hot reload works normally. `dev:api` and `dev:web`
 * remain available for anyone who wants a console each.
 */
import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { databaseReady, objectStoreReady } from './lib/probes.mjs';
import { describePort, isInside, listenersOn, waitForPortFree } from './lib/ports.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const paint = (code, text) => (process.stdout.isTTY === true ? `\x1b[${code}m${text}\x1b[0m` : text);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_PORT = process.env.PORT ?? '8787';
const WEB_PORT = process.env.WEB_PORT ?? '5173';
const KILL_GRACE_MS = 5000;

/**
 * The two halves as data, because the port pre-flight, the banner, and the spawn all iterate
 * the same list — and a service added to one but not another is exactly the bug this avoids.
 */
const SERVICES = [
  {
    name: 'api',
    label: 'api',
    colorCode: '36',
    script: 'dev:api',
    directory: 'apps/api',
    port: API_PORT,
    url: `http://127.0.0.1:${API_PORT}`,
    portVariable: 'PORT',
    alternativePort: '8792',
  },
  {
    name: 'web',
    label: 'shell',
    colorCode: '35',
    script: 'dev:web',
    directory: 'apps/web',
    port: WEB_PORT,
    url: `http://localhost:${WEB_PORT}`,
    portVariable: 'WEB_PORT',
    alternativePort: '5199',
  },
];

const USAGE = `Usage: npm run dev [-- --kill | --reuse]

  (no option)  start both, failing if a port is already in use
  --kill       reclaim ports held by this repository's own dev servers, then start
  --reuse      leave whatever is already listening, and start only the missing half
`;

const children = [];
let stopping = false;

function parseArguments(argv) {
  const flags = { kill: false, reuse: false, help: false };
  for (const argument of argv) {
    if (argument === '--kill') flags.kill = true;
    else if (argument === '--reuse') flags.reuse = true;
    else if (argument === '--help' || argument === '-h') flags.help = true;
    else {
      process.stderr.write(`Unknown option "${argument}".\n\n${USAGE}`);
      process.exit(2);
    }
  }
  if (flags.kill && flags.reuse) {
    process.stderr.write(`--kill reclaims the port and --reuse joins it; pick one.\n\n${USAGE}`);
    process.exit(2);
  }
  return flags;
}

/** Spawns one child in its own process group, so its whole tree stops together. */
function start(service) {
  const child = spawn(npm, ['run', service.script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    // Its own group: `npm run dev:web` starts Vite beneath it, and signalling only the npm
    // wrapper can leave the real server holding the port.
    detached: true,
  });

  const prefix = paint(service.colorCode, `[${service.name}]`);
  const forward = (stream) => (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim() !== '') stream.write(`${prefix} ${line}\n`);
    }
  };
  child.stdout.on('data', forward(process.stdout));
  child.stderr.on('data', forward(process.stderr));
  child.on('exit', (code, signal) => {
    if (stopping) return;
    process.stderr.write(
      `\n${prefix} stopped (${signal ? `signal ${signal}` : `exit code ${code ?? 0}`}); stopping the other process.\n`,
    );
    stop(code ?? 1);
  });

  children.push({ name: service.name, child });
  return child;
}

function signalGroups(signal) {
  for (const { child } of children) {
    try {
      // Negative pid targets the group, not just the npm wrapper.
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function allExited() {
  return Promise.all(
    children.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('exit', resolve);
        }),
    ),
  );
}

/**
 * Stops everything and exits once the ports are genuinely free.
 *
 * Exiting before the children die would let an immediate restart race the old process for
 * 8787, which looks like a port conflict caused by the new run.
 */
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  signalGroups('SIGTERM');

  const finished = await Promise.race([allExited().then(() => true), delay(KILL_GRACE_MS).then(() => false)]);
  if (!finished) {
    process.stderr.write(`A child ignored SIGTERM for ${KILL_GRACE_MS}ms; killing it.\n`);
    signalGroups('SIGKILL');
    await allExited();
  }
  process.exit(code);
}

/** A working directory relative to the checkout, which is how it reads best in a message. */
function relativeCwd(cwd) {
  if (!cwd) return 'unknown';
  const rel = relative(REPO_ROOT, cwd);
  return rel === '' ? '.' : rel.startsWith('..') ? cwd : rel;
}

/**
 * Whether a listener is this service's dev server.
 *
 * The test is the working directory, not the process name: the port is held by the server
 * itself (`vite`, or the entry the API's watcher runs), and each runs from its own workspace
 * directory. Requiring that directory — rather than "somewhere in the checkout" — is what
 * keeps `--kill` from stopping an unrelated process that merely happens to share the
 * repository root as its working directory.
 */
function isOurServer(service, listener) {
  return isInside(join(REPO_ROOT, service.directory), listener.cwd);
}

/** The command that moves this half somewhere the occupant is not. */
function moveHint(service) {
  return `${service.portVariable}=${service.alternativePort} npm run dev`;
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false; // Already gone.
  }
}

/**
 * Prints what holds each port, and the command that resolves it.
 *
 * The pid and the working directory are the part that matters: together they turn "already
 * in use" into "an earlier dev loop of this repository is still running", which is a
 * different problem with a different fix.
 */
function reportOccupied(occupied) {
  for (const { service, occupant, ours } of occupied) {
    const listen = occupant.listeners
      .map((listener) => `pid ${listener.pid}, cwd ${relativeCwd(listener.cwd)}`)
      .join('; ');
    const who = ours
      ? `this repository's own dev server (${listen})`
      : occupant.state === 'unknown'
        ? 'something this host cannot identify (`lsof` is unavailable or was denied)'
        : `a process that is not this repository's ${service.label} dev server (${listen})`;

    const investigate = `lsof -nP -iTCP:${service.port} -sTCP:LISTEN`;
    process.stderr.write(`\nPort ${service.port} is held by ${who}.\n`);
    process.stderr.write(
      (ours
        ? 'An earlier `npm run dev` started it, and that terminal is gone.\n\n' +
          '  reclaim it and start fresh   npm run dev -- --kill\n' +
          '  use it where it is           npm run dev -- --reuse\n'
        : 'Refusing to touch it: reclaiming could stop something that is not ours.\n\n') +
        `  move this run                ${moveHint(service)}\n` +
        `  investigate                  ${investigate}\n`,
    );
  }
}

/**
 * Reclaims one port from this repository's own dev server.
 *
 * It signals the processes holding the port, and nothing else. Walking up to their parents
 * to find the supervisor would be tidier, but the parent chain also reaches whatever started
 * the run — a shell, or the harness — and those inherit the same working directory, so the
 * walk cannot tell them apart from the dev loop. Killing the listeners is the remedy the
 * README already documents, and it cannot take out the terminal you are typing in.
 */
async function reclaim(service, occupant) {
  const pids = occupant.listeners.map((listener) => listener.pid);
  process.stdout.write(
    `${paint('33', 'reclaiming')} ${service.label} on ${service.port} (pid ${pids.join(', ')}, ${relativeCwd(occupant.listeners[0]?.cwd)})\n`,
  );
  for (const pid of pids) signalPid(pid, 'SIGTERM');

  if (await waitForPortFree(service.port, { timeoutMs: KILL_GRACE_MS })) return true;

  // The listener may have changed while the port was held, so re-read rather than trusting
  // the list from before the signal.
  const remaining = await listenersOn(service.port);
  const stubborn = remaining === null || remaining.length === 0 ? pids : remaining;
  process.stderr.write(`  pid ${stubborn.join(', ')} held ${service.port} through SIGTERM; killing it.\n`);
  for (const pid of stubborn) signalPid(pid, 'SIGKILL');
  return waitForPortFree(service.port, { timeoutMs: 2000 });
}

/**
 * Settles every port before a child is spawned.
 *
 * @returns the set of service names this console should not start, because something already
 *   answers for them and `--reuse` asked to keep it that way.
 */
async function resolvePorts(flags) {
  const occupied = [];
  const reused = new Set();

  for (const service of SERVICES) {
    const occupant = await describePort(service.port);
    if (occupant.state === 'free') continue;

    const ours =
      occupant.state === 'occupied' && occupant.listeners.some((listener) => isOurServer(service, listener));

    if (flags.reuse) {
      reused.add(service.name);
      continue;
    }
    if (flags.kill && ours) {
      if (await reclaim(service, occupant)) continue;
      process.stderr.write(
        `\nPort ${service.port} is still in use after SIGKILL, so this run will not start on top of it.\n` +
          `  investigate                  lsof -nP -iTCP:${service.port} -sTCP:LISTEN\n`,
      );
      process.exit(1);
    }
    occupied.push({ service, occupant, ours });
  }

  if (occupied.length > 0) {
    reportOccupied(occupied);
    process.exit(1);
  }
  return reused;
}

const flags = parseArguments(process.argv.slice(2));
if (flags.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // A terminal delivers Ctrl-C to the npm wrapper as well as to this process, and npm
    // forwards it, so this handler runs twice for one keystroke. `stop` absorbs the
    // duplicate; the message needs the same guard or it prints twice.
    if (!stopping) process.stdout.write('\nStopping the development loop…\n');
    // Ctrl-C is how this command is meant to end, so it is a clean exit rather than 130.
    stop(0);
  });
}

const reused = await resolvePorts(flags);
const starting = SERVICES.filter((service) => !reused.has(service.name));

if (starting.length === 0) {
  process.stdout.write(
    `Both services already answer on ${API_PORT} and ${WEB_PORT}, so there is nothing to start.\n` +
      'This console does not own them, so Ctrl-C here would not stop them.\n' +
      'To restart them under this console: npm run dev -- --kill\n',
  );
  process.exit(0);
}

// Only meaningful for an API this run starts. A reused API read its own configuration when
// it started, so probing the database here would describe a process we do not control.
if (!reused.has('api')) {
  const [db, objects] = [await databaseReady(), await objectStoreReady()];
  if (!db || !objects) {
    const missing = [!db ? 'PostgreSQL' : null, !objects ? 'the object store' : null].filter(Boolean);
    process.stderr.write(
      `${paint('33', 'warning')} ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not reachable.\n` +
        '        The API will start and answer 503 on protected routes until it can reach the database.\n' +
        '        Start the local stack with: npm run dev:up\n\n',
    );
  }
}

process.stdout.write(
  `${SERVICES.map((service) => {
    const notes = [];
    if (reused.has(service.name)) notes.push('already running; this console did not start it');
    if (service.name === 'web') notes.push('use localhost, not 127.0.0.1');
    const note = notes.length > 0 ? `   (${notes.join('; ')})` : '';
    return `${paint(service.colorCode, service.label.padEnd(7))}${service.url}${note}`;
  }).join('\n')}\n` +
    `${reused.size > 0 ? 'Ctrl-C stops only what this console started.' : 'Ctrl-C stops both.'}\n\n`,
);

for (const service of starting) start(service);
