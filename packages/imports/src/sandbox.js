import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The sandbox boundary.
 *
 * Every registered adapter parses untrusted input, so every adapter runs here
 * (doc/workspace/import-adapters.md, "Extensibility Model"): a child process with
 * a scrubbed environment, a bounded old space, a wall-clock timeout, and no
 * database, storage, or secret handle. The parent passes a temporary file path
 * and reads one JSON result back.
 */
const DEFAULT_RUNNER = fileURLToPath(new URL('./worker-runner.mjs', import.meta.url));

export class SandboxError extends Error {
  constructor(message, { reason, code = null, stderr = null } = {}) {
    super(message);
    this.name = 'SandboxError';
    this.reason = reason;
    this.adapterCode = code;
    this.stderr = stderr;
  }
}

export function createSandbox({
  runnerPath = DEFAULT_RUNNER,
  timeoutMs = 30 * 60 * 1000,
  maxOldSpaceMb = 256,
  spawnImpl = spawn,
  nodePath = process.execPath,
} = {}) {
  /**
   * Runs one adapter and resolves to its result. A non-zero exit, a timeout, or a
   * malformed result rejects; the pipeline turns that into a failed conversion.
   */
  function run({ entryPoint, mediaType, path, filename = null, limits = {} }) {
    const job = JSON.stringify({ entryPoint, mediaType, path, filename, limits });

    return new Promise((resolve, reject) => {
      const child = spawnImpl(nodePath, [`--max-old-space-size=${maxOldSpaceMb}`, runnerPath], {
        // No ambient credentials: the child receives a PATH and nothing else.
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new SandboxError('The adapter exceeded its time limit.', { reason: 'timeout' }));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new SandboxError('The adapter process could not start.', { reason: 'spawn', stderr: error.message }));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          reject(new SandboxError('The adapter produced no readable result.', { reason: 'protocol', stderr }));
          return;
        }
        if (!parsed.ok) {
          reject(
            new SandboxError(parsed.error?.message ?? 'The adapter failed.', {
              reason: 'adapter',
              code: parsed.error?.code ?? null,
              stderr,
            }),
          );
          return;
        }
        resolve(parsed.result);
      });

      child.stdin.end(job);
    });
  }

  return { run, runnerPath, timeoutMs, maxOldSpaceMb };
}
