import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@ai-infra/core';
import { createOpenAiCompatibleProvider, createRedactor } from '@ai-infra/assistant';
import { createAssistantFetch, normalizeAssistantEndpoint } from './assistant-endpoint.js';

const fail = (code, message, status = 400) => new ApiError(code, message, { status });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail('ASSISTANT_CONNECTION_INVALID', `${name} is required and must not contain control characters.`);
  }
  return value.trim();
};

export function assistantConnectionDirectories(env = process.env) {
  const base = join(env.LOCALAPPDATA || env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'AI-INFRA-Rack');
  return { directory: env.ASSISTANT_CONNECTION_DIR || join(base, 'assistant-connections'),
    keyDirectory: env.ASSISTANT_KEY_DIR || join(base, 'assistant-keys') };
}

/** Local, single-instance adapter. Never stores credentials in the repo or database. */
export function createAssistantConnections({ directory, keyDirectory, allowedOrigins = [], timeoutMs = 60_000,
  fetchImpl = createAssistantFetch({ allowedOrigins }), now = () => Date.now() } = {}) {
  if (!directory || !keyDirectory) throw new Error('Assistant connection storage directories are required.');
  const locks = new Map();
  const active = new Map();
  const testing = new Map();
  const owner = (userId) => {
    if (typeof userId !== 'string' || !userId) throw fail('UNAUTHENTICATED', 'Sign in first.', 401);
    return createHash('sha256').update(userId).digest('hex');
  };
  const pathFor = (userId) => join(directory, `${owner(userId)}.json`);
  const secretPath = (ref) => {
    if (!uuid.test(ref)) throw fail('ASSISTANT_STORAGE_INVALID', 'The connection credential reference is invalid.', 503);
    return join(directory, 'vault', `${ref}.json`);
  };
  async function read(userId) {
    try { return JSON.parse(await readFile(pathFor(userId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw fail('ASSISTANT_STORAGE_INVALID', 'Could not read your model connection.', 503); }
  }
  async function master({ create = false } = {}) {
    const path = join(keyDirectory, 'master.key');
    if (create) {
      await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
      let exists = true;
      try { await readFile(path); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
      if (!exists) {
        const encrypted = await readdir(join(directory, 'vault')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
        if (encrypted.length) throw fail('ASSISTANT_KEY_UNAVAILABLE', 'The credential master key is missing. Restore it before continuing.', 503);
      }
      try { if (!exists) await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    try {
      const key = await readFile(path);
      if (key.length !== 32) throw new Error('Invalid master key.');
      return key;
    } catch { throw fail('ASSISTANT_KEY_UNAVAILABLE', 'The local credential master key is unavailable. Restore it, or delete the connection and configure it again.', 503); }
  }
  function publicInfo(row) {
    if (!row) return null;
    return { connectionId: row.id, version: row.version, name: row.name, endpoint: row.endpoint,
      model: row.model, models: [row.model], host: new URL(row.endpoint).host,
      provider: 'openai-compatible', configured: true, hasKey: true, updatedAt: row.updatedAt };
  }
  async function credential(row, userId) {
    try {
      const sealed = JSON.parse(await readFile(secretPath(row.secretRef), 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', await master(), Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${owner(userId)}/${row.id}/${row.version}`));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw fail('ASSISTANT_KEY_UNAVAILABLE', 'Could not decrypt the local model credential. Restore the original master key or configure the connection again.', 503); }
  }
  async function serial(userId, work) {
    const id = owner(userId);
    const previous = locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    locks.set(id, current);
    try { return await current; }
    finally { if (locks.get(id) === current) locks.delete(id); }
  }
  function revoke(userId) {
    for (const controller of active.get(owner(userId)) ?? []) controller.abort();
  }
  async function assertVersion(userId, id, version) {
    const row = await read(userId);
    if (!row || row.id !== id) throw fail('ASSISTANT_CONNECTION_NOT_FOUND', 'Your model connection was not found. Reload the connection settings.', 404);
    if (row.version !== version) throw fail('ASSISTANT_CONNECTION_CHANGED', 'The model connection has changed. Reload it before continuing.', 412);
    return row;
  }
  async function save(userId, body) {
    return serial(userId, async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some((key) => !['name', 'endpoint', 'model', 'apiKey', 'version'].includes(key))) {
        throw fail('ASSISTANT_CONNECTION_INVALID', 'Invalid connection fields.');
      }
      const previous = await read(userId);
      if (body.version !== (previous?.version ?? null)) throw fail('ASSISTANT_CONNECTION_CHANGED', 'The model connection has changed. Reload it before saving.', 412);
      const name = text(body.name, 'Connection name', 80);
      const endpoint = normalizeAssistantEndpoint(body.endpoint, allowedOrigins);
      const model = text(body.model, 'Model ID', 160);
      const apiKey = body.apiKey === undefined || body.apiKey === ''
        ? previous ? await credential(previous, userId) : null : text(body.apiKey, 'API Key', 8192);
      if (!apiKey) throw fail('ASSISTANT_CONNECTION_INVALID', 'An API key is required for the initial setup.');
      if (apiKey.length < 4) throw fail('ASSISTANT_CONNECTION_INVALID', 'The API key is too short.');
      if (/^[*•]+$/.test(apiKey)) throw fail('ASSISTANT_CONNECTION_INVALID', 'Enter the actual key, not a mask. Leave it blank to keep the saved key.');
      const row = { id: previous?.id ?? randomUUID(), version: (previous?.version ?? 0) + 1,
        name, endpoint, model, secretRef: randomUUID(), updatedAt: new Date(now()).toISOString() };
      // An existing encrypted record never causes silent master-key regeneration.
      const key = await master({ create: !previous });
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${owner(userId)}/${row.id}/${row.version}`));
      const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
      const sealed = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      await mkdir(join(directory, 'vault'), { recursive: true, mode: 0o700 });
      const temporary = `${pathFor(userId)}.${randomUUID()}.tmp`;
      try {
        await writeFile(secretPath(row.secretRef), JSON.stringify(sealed), { flag: 'wx', mode: 0o600 });
        await writeFile(temporary, JSON.stringify(row), { flag: 'wx', mode: 0o600 });
        await rename(temporary, pathFor(userId));
      } catch {
        await unlink(temporary).catch(() => {});
        await unlink(secretPath(row.secretRef)).catch(() => {});
        throw fail('ASSISTANT_STORAGE_UNAVAILABLE', 'Could not save your model connection. Check local storage permissions.', 503);
      }
      revoke(userId);
      if (previous) await unlink(secretPath(previous.secretRef)).catch(() => {});
      return publicInfo(row);
    });
  }
  async function remove(userId, version) {
    return serial(userId, async () => {
      const previous = await read(userId);
      if (!previous) return;
      if (previous.version !== version) throw fail('ASSISTANT_CONNECTION_CHANGED', 'The model connection has changed. Reload it.', 412);
      await unlink(pathFor(userId));
      revoke(userId);
      await unlink(secretPath(previous.secretRef)).catch(() => {});
    });
  }
  async function open(userId, connectionId, version) {
    const row = await assertVersion(userId, connectionId, version);
    const apiKey = await credential(row, userId);
    const redact = createRedactor([apiKey]);
    const base = createOpenAiCompatibleProvider({ endpoint: row.endpoint, apiKey, model: row.model, timeoutMs, fetchImpl });
    const controller = new AbortController();
    const id = owner(userId);
    if (!active.has(id)) active.set(id, new Set());
    active.get(id).add(controller);
    // Recheck after asynchronous decryption, before publishing an active request.
    try { await assertVersion(userId, row.id, row.version); }
    catch (error) { active.get(id).delete(controller); throw error; }
    return { ...publicInfo(row), redact, signal: controller.signal,
      provider: { name: base.name, model: base.model, async complete(args) {
        await assertVersion(userId, row.id, row.version);
        return base.complete({ ...args, signal: AbortSignal.any([controller.signal, ...(args.signal ? [args.signal] : [])]) });
      } },
      release() { const set = active.get(id); set?.delete(controller); if (set?.size === 0) active.delete(id); },
    };
  }
  async function test(userId, { connectionId, version }, signal) {
    const id = owner(userId);
    const previous = testing.get(id);
    if (previous && (previous.pending || now() - previous.at < 10_000)) throw fail('ASSISTANT_TEST_LIMIT', 'Wait for the current test to finish. Allow at least 10 seconds between tests.', 429);
    if (testing.size >= 1000) for (const [key, item] of testing) if (!item.pending && now() - item.at >= 10_000) testing.delete(key);
    if (!testing.has(id) && testing.size >= 1000) throw fail('ASSISTANT_TEST_LIMIT', 'Connection testing is busy. Try again later.', 429);
    testing.set(id, { pending: true, at: now() });
    let connection;
    try {
      connection = await open(userId, connectionId, version);
      const messages = [{ role: 'user', content: 'Connection compatibility test. Call connection_ping with token "rack-test", then reply OK after receiving its result.' }];
      const tools = [{ type: 'function', function: { name: 'connection_ping', description: 'Synthetic connection test with no business data.',
        parameters: { type: 'object', properties: { token: { type: 'string', enum: ['rack-test'] } }, required: ['token'], additionalProperties: false } } }];
      const first = await connection.provider.complete({ messages, tools, signal, modelOptions: { max_tokens: 256 } });
      const message = first.choices?.[0]?.message;
      if (!message || (!message.content && !message.tool_calls?.length)) throw new Error('Empty model reply.');
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) return { chat: true, toolRoundTrip: false, message: 'The model responded without calling the test tool. Rack Agent tool support is not confirmed.' };
      if (calls.length !== 1 || calls[0].function?.name !== 'connection_ping' || !calls[0].id || JSON.parse(calls[0].function.arguments)?.token !== 'rack-test') {
        return { chat: true, toolRoundTrip: false, message: 'The model responded, but the test tool call did not match the expected format.' };
      }
      const second = await connection.provider.complete({ messages: [...messages, message,
        { role: 'tool', tool_call_id: calls[0].id, content: '{"ok":true,"token":"rack-test"}' }], tools, signal, modelOptions: { max_tokens: 256 } });
      const final = second.choices?.[0]?.message;
      if (!final?.content || final.tool_calls?.length) return { chat: true, toolRoundTrip: false, message: 'The model called the tool but did not complete a final answer. Check model compatibility.' };
      return { chat: true, toolRoundTrip: true, message: 'Model response and tool-call round trip passed. You can use Ask about Rack.' };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Provider body and free-form error text can contain credentials. Never echo either.
      throw fail('ASSISTANT_CONNECTION_TEST_FAILED', 'Connection test failed. Check the endpoint, key, model ID, network and provider quota.', 502);
    } finally {
      connection?.release();
      testing.set(id, { pending: false, at: now() });
    }
  }
  return { get: async (userId) => publicInfo(await read(userId)), save, remove, open, test };
}
