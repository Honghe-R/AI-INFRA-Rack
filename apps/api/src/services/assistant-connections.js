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
    throw fail('ASSISTANT_CONNECTION_INVALID', `${name} 不能为空，且不能包含控制字符。`);
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
    if (typeof userId !== 'string' || !userId) throw fail('UNAUTHENTICATED', '请先登录。', 401);
    return createHash('sha256').update(userId).digest('hex');
  };
  const pathFor = (userId) => join(directory, `${owner(userId)}.json`);
  const secretPath = (ref) => {
    if (!uuid.test(ref)) throw fail('ASSISTANT_STORAGE_INVALID', '连接凭证引用损坏。', 503);
    return join(directory, 'vault', `${ref}.json`);
  };
  async function read(userId) {
    try { return JSON.parse(await readFile(pathFor(userId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw fail('ASSISTANT_STORAGE_INVALID', '无法读取个人模型连接。', 503); }
  }
  async function master({ create = false } = {}) {
    const path = join(keyDirectory, 'master.key');
    if (create) {
      await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
      let exists = true;
      try { await readFile(path); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
      if (!exists) {
        const encrypted = await readdir(join(directory, 'vault')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
        if (encrypted.length) throw fail('ASSISTANT_KEY_UNAVAILABLE', '原凭证主密钥缺失，请恢复密钥后继续。', 503);
      }
      try { if (!exists) await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    try {
      const key = await readFile(path);
      if (key.length !== 32) throw new Error('Invalid master key.');
      return key;
    } catch { throw fail('ASSISTANT_KEY_UNAVAILABLE', '本机凭证主密钥不可用，请恢复原密钥或删除连接后重新配置。', 503); }
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
    } catch { throw fail('ASSISTANT_KEY_UNAVAILABLE', '无法解密本机模型凭证，请恢复原主密钥或重新配置。', 503); }
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
    if (!row || row.id !== id) throw fail('ASSISTANT_CONNECTION_NOT_FOUND', '个人模型连接不存在，请重新加载。', 404);
    if (row.version !== version) throw fail('ASSISTANT_CONNECTION_CHANGED', '模型连接已修改，请重新加载后继续。', 412);
    return row;
  }
  async function save(userId, body) {
    return serial(userId, async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some((key) => !['name', 'endpoint', 'model', 'apiKey', 'version'].includes(key))) {
        throw fail('ASSISTANT_CONNECTION_INVALID', '连接字段不正确。');
      }
      const previous = await read(userId);
      if (body.version !== (previous?.version ?? null)) throw fail('ASSISTANT_CONNECTION_CHANGED', '模型连接已修改，请重新加载后再保存。', 412);
      const name = text(body.name, '连接名称', 80);
      const endpoint = normalizeAssistantEndpoint(body.endpoint, allowedOrigins);
      const model = text(body.model, '模型 ID', 160);
      const apiKey = body.apiKey === undefined || body.apiKey === ''
        ? previous ? await credential(previous, userId) : null : text(body.apiKey, 'API Key', 8192);
      if (!apiKey) throw fail('ASSISTANT_CONNECTION_INVALID', '首次配置需要填写 API Key。');
      if (apiKey.length < 4) throw fail('ASSISTANT_CONNECTION_INVALID', 'API Key 长度不足。');
      if (/^[*•]+$/.test(apiKey)) throw fail('ASSISTANT_CONNECTION_INVALID', '请输入真实 Key，不能保存掩码；留空可保留已保存的 Key。');
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
        throw fail('ASSISTANT_STORAGE_UNAVAILABLE', '无法保存个人模型连接，请检查本机存储权限。', 503);
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
      if (previous.version !== version) throw fail('ASSISTANT_CONNECTION_CHANGED', '模型连接已修改，请重新加载。', 412);
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
    if (previous && (previous.pending || now() - previous.at < 10_000)) throw fail('ASSISTANT_TEST_LIMIT', '请等待当前测试完成，测试间隔至少 10 秒。', 429);
    if (testing.size >= 1000) for (const [key, item] of testing) if (!item.pending && now() - item.at >= 10_000) testing.delete(key);
    if (!testing.has(id) && testing.size >= 1000) throw fail('ASSISTANT_TEST_LIMIT', '当前连接测试繁忙，请稍后重试。', 429);
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
      if (calls.length === 0) return { chat: true, toolRoundTrip: false, message: '模型已响应，但本次没有调用测试工具；Rack Agent 工具能力尚未确认。' };
      if (calls.length !== 1 || calls[0].function?.name !== 'connection_ping' || !calls[0].id || JSON.parse(calls[0].function.arguments)?.token !== 'rack-test') {
        return { chat: true, toolRoundTrip: false, message: '模型已响应，但测试工具调用格式不符合约定。' };
      }
      const second = await connection.provider.complete({ messages: [...messages, message,
        { role: 'tool', tool_call_id: calls[0].id, content: '{"ok":true,"token":"rack-test"}' }], tools, signal, modelOptions: { max_tokens: 256 } });
      const final = second.choices?.[0]?.message;
      if (!final?.content || final.tool_calls?.length) return { chat: true, toolRoundTrip: false, message: '工具调用已产生，但未完成最终回答；需要进一步检查模型兼容性。' };
      return { chat: true, toolRoundTrip: true, message: '模型响应和工具调用往返测试通过。可以在 Ask about Rack 中使用。' };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Provider body and free-form error text can contain credentials. Never echo either.
      throw fail('ASSISTANT_CONNECTION_TEST_FAILED', '连接测试失败，请检查地址、Key、模型 ID、网络或服务商额度。', 502);
    } finally {
      connection?.release();
      testing.set(id, { pending: false, at: now() });
    }
  }
  return { get: async (userId) => publicInfo(await read(userId)), save, remove, open, test };
}
