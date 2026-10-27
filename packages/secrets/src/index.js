import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Secret resolution.
 *
 * The Non-Functional Requirements require that secrets be held outside the
 * application: converter licence keys, map provider credentials, and service
 * credentials are injected at runtime from a secret manager, never stored in the
 * database, an image, a log, or a trace. This module is the single seam where a
 * secret is fetched, so every consumer inherits that rule.
 *
 * A `SecretProvider` is `{ get(name) -> Promise<string|undefined>, require(name)
 * -> Promise<string> }`. Providers are deliberately async: a real secret manager
 * is a network call, and a synchronous interface would force a cache into every
 * call site.
 */
export class SecretNotFoundError extends Error {
  constructor(name) {
    super(`Secret "${name}" was not found.`);
    this.name = 'SecretNotFoundError';
    this.secretName = name;
  }
}

/** Reads secrets from the process environment. Development and CI only. */
export function envSecretProvider(env = process.env, { prefix = '' } = {}) {
  return baseProvider(async (name) => {
    const value = env[`${prefix}${name}`];
    return value === undefined || value === '' ? undefined : value;
  });
}

/**
 * Reads secrets from files under a directory, one file per secret. This matches
 * the mounted-volume convention used by orchestrators that expose secrets as
 * files rather than environment variables.
 */
export function fileSecretProvider(directory, { readFileImpl = readFile } = {}) {
  if (!directory) throw new Error('fileSecretProvider requires a directory.');
  const root = resolve(directory);
  return baseProvider(async (name) => {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid secret name "${name}".`);
    try {
      const value = await readFileImpl(join(root, name), 'utf8');
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    } catch (cause) {
      if (cause?.code === 'ENOENT') return undefined;
      throw cause;
    }
  });
}

/**
 * Wraps a provider with a bounded in-memory cache so a hot path does not make a
 * network call per use. Rotation is picked up after the TTL.
 */
export function cachedSecretProvider(provider, { ttlMs = 300_000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    async get(name) {
      const cached = entries.get(name);
      if (cached && cached.expiresAt > now()) return cached.value;
      const value = await provider.get(name);
      entries.set(name, { value, expiresAt: now() + ttlMs });
      return value;
    },
    require(name) {
      return this.get(name).then((value) => {
        if (value === undefined) throw new SecretNotFoundError(name);
        return value;
      });
    },
    clear(name) {
      if (name === undefined) entries.clear();
      else entries.delete(name);
    },
  };
}

/**
 * Builds the configured provider. `source` is `env`, `file`, or a pre-built
 * provider, so a test can inject a fake without touching the environment.
 */
export function createSecretProvider({ source = 'env', directory, env = process.env, ttlMs } = {}) {
  const provider =
    typeof source === 'object' && source !== null
      ? source
      : source === 'file'
        ? fileSecretProvider(directory)
        : source === 'env'
          ? envSecretProvider(env)
          : (() => {
              throw new Error(`Unknown secret source "${source}".`);
            })();

  return cachedSecretProvider(provider, { ttlMs });
}

function baseProvider(lookup) {
  return {
    get: lookup,
    async require(name) {
      const value = await lookup(name);
      if (value === undefined) throw new SecretNotFoundError(name);
      return value;
    },
  };
}
