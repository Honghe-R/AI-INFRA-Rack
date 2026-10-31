import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, lstat, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ApiError } from '@ai-infra/core';

export const DEVELOPER_IMAGE = 'ai-infra-rack-agent:local';
export const RACK_SOURCE = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const extensions = /\.(?:js|jsx|mjs|cjs|ts|tsx|json|md|css|html|sql|yaml|yml|txt|svg)$/i;
const directories = new Set(['apps', 'packages', 'scripts', 'doc', 'data-scripts']);
const excluded = /^(?:node_modules|dist|coverage|records|ui-shots|presentation-assets|vendor|target)$/i;
const forbidden = /(?:^(?:secrets?|credentials?)\.(?:json|txt|ya?ml)$|private[-_]?key|certificate|accounts\.json|^activate-)/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message, status = 400, code = 'DEVELOPER_INPUT_INVALID') => { throw new ApiError(code, message, { status }); };
function allowed(path) {
  return typeof path === 'string' && path.length < 240 && /^[a-zA-Z0-9_./-]+$/.test(path) &&
    !path.split('/').some(p => !p || p === '..' || p.startsWith('.') || excluded.test(p) || forbidden.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)) &&
    extensions.test(path) && (path.includes('/') ? directories.has(path.split('/')[0]) : /\.(md|json)$/i.test(path));
}
async function safe(root, path) {
  if (!allowed(path)) fail('Use an allowed relative source path. Secrets, runtime files and links are excluded.');
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel.startsWith('..') || resolve(target) === resolve(root)) fail('Path is outside the workspace.');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) fail('Symbolic links and junctions are not allowed.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; break; }
  }
  return target;
}
export async function sourceFiles(root) {
  const files = [];
  async function walk(directory = '') {
    for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
      if (item.name.startsWith('.') || excluded.test(item.name) || forbidden.test(item.name) || item.isSymbolicLink()) continue;
      const path = directory ? `${directory}/${item.name}` : item.name;
      if (item.isDirectory() && (directory || directories.has(item.name))) await walk(path);
      else if (item.isFile() && allowed(path)) files.push(path);
      if (files.length > 4000) fail('Workspace exceeds the 4,000-file limit.', 413);
    }
  }
  await walk(); return files.sort();
}
export async function copySource(source, destination) {
  const files = await sourceFiles(source); let size = 0;
  for (const path of files) {
    const from = await safe(source, path), bytes = await readFile(from);
    size += bytes.length;
    if (size > 24 * 1024 * 1024 || bytes.length > 2 * 1024 * 1024) fail('Source snapshot exceeds its size limit.', 413);
    if (bytes.includes(0)) continue;
    const target = await safe(destination, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  return { files: files.length, bytes: size };
}
export function dockerRunArguments({ tree, name, command }) {
  return ['run', '--name', name, '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--user=1000:1000', '--cpus=1', '--memory=1536m', '--pids-limit=128',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--tmpfs', '/work:rw,nosuid,nodev,exec,size=1536m,uid=1000,gid=1000',
    '--mount', `type=bind,source=${tree},target=/input,readonly`, DEVELOPER_IMAGE,
    'cp -a /opt/rack/node_modules /work/node_modules && cp -R /input/. /work/ && exec /bin/sh -c "$1"', 'rack-command', command];
}
export function runDocker(args, { timeout = 60000, signal } = {}) {
  return new Promise((done, reject) => {
    const child = spawn('docker', args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', truncated = false, timedOut = false;
    const consume = bytes => {
      const text = bytes.toString(), remaining = 12000 - output.length;
      if (text.length > remaining) truncated = true;
      if (remaining > 0) output += text.slice(0, remaining);
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    const cancel = () => { timedOut = true; child.kill(); };
    const timer = setTimeout(cancel, timeout); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('error', e => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new ApiError('DEVELOPER_RUNTIME_UNAVAILABLE', 'Docker is unavailable. Run the local developer setup; no host fallback is allowed.', { status: 503 })); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); done({ exitCode: code, output, truncated, timedOut }); });
  });
}

export function createDeveloperWorkspace({ sourceRoot = RACK_SOURCE, root = join(RACK_SOURCE, '.local-runtime/developer'), authorize,
  enabled = process.env.AI_INFRA_COMPOSE_FILE === 'compose.rack.yaml' && process.env.RACK_DEVELOPER_ENABLED !== 'false',
  execute = runDocker } = {}) {
  const locks = new Map(), budgets = new Map();
  async function access(ctx) {
    if (!enabled) fail('Development Agent is disabled on this server.', 503, 'DEVELOPER_DISABLED');
    if (!UUID.test(ctx.workspaceId ?? '') || !UUID.test(ctx.initiatedBy?.userId ?? '')) fail('A personal project context is required.', 403);
    for (const key of ['project.member.manage', 'rack.read', 'rack.write']) if (!await authorize({ key, userId: ctx.initiatedBy.userId, workspaceId: ctx.workspaceId }))
      fail('Development Agent requires project administration and Rack edit access.', 403, 'ASSISTANT_FORBIDDEN');
  }
  const location = ctx => join(root, hash(`${ctx.initiatedBy.userId}|${ctx.workspaceId}`).slice(0, 32));
  async function locked(ctx, action) {
    await access(ctx);
    const key = location(ctx), previous = locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      // Root ancestors must be regular directories, including ignored runtime roots.
      for (const path of [sourceRoot, dirname(root), root, key]) {
        await mkdir(path, { recursive: true });
        if ((await lstat(path)).isSymbolicLink() || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase())
          fail('Workspace roots must not contain links or redirected directories.');
      }
      if (!await readFile(join(key, 'ready.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; })) {
        const count = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).length;
        if (count > 20) fail('The local developer workspace limit was reached. Ask the operator to archive unused workspaces.', 429);
        await mkdir(join(key, 'base'), { recursive: true }); await mkdir(join(key, 'tree'), { recursive: true });
        await copySource(sourceRoot, join(key, 'base')); await copySource(join(key, 'base'), join(key, 'tree'));
        await writeFile(join(key, 'ready.json'), JSON.stringify({ createdAt: new Date().toISOString() }));
      }
      for (const dir of ['tree', 'base']) if ((await lstat(join(key, dir))).isSymbolicLink()) fail('Workspace links are forbidden.');
      return action({ tree: join(key, 'tree'), base: join(key, 'base'), key });
    });
    locks.set(key, pending);
    try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
  }
  async function use(ctx, kind, fn) {
    await access(ctx);
    if (ctx.readOnly && (kind === 'write' || kind === 'run'))
      fail('Read-only development sessions cannot edit files or execute commands.', 403, 'ASSISTANT_FORBIDDEN');
    const key = `${ctx.initiatedBy.userId}|${ctx.workspaceId}|${ctx.requestId}`;
    for (const [k, value] of budgets) if (Date.now() - value.at > 900000) budgets.delete(k);
    if (!budgets.has(key)) { if (budgets.size > 256) budgets.delete(budgets.keys().next().value); budgets.set(key, { at: Date.now(), calls: 0, runs: 0 }); }
    const budget = budgets.get(key);
    if (++budget.calls > 12 || (kind === 'run' && ++budget.runs > 2)) fail('Development turn budget reached: 12 tools and 2 commands maximum.', 429, 'DEVELOPER_CALL_LIMIT');
    return locked(ctx, fn);
  }
  async function changes({ tree, base }, includePatch = false) {
    const paths = [...new Set([...(await sourceFiles(base)), ...(await sourceFiles(tree))])].sort();
    const items = []; let patch = '';
    for (const path of paths) {
      const read = async root => readFile(await safe(root, path), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      const old = await read(base), next = await read(tree);
      if (old === next) continue;
      items.push({ path, status: old === null ? 'added' : next === null ? 'deleted' : 'modified', hash: next === null ? null : hash(next) });
      if (includePatch) {
        const lines = text => (text === '' || text === null ? [] : text.match(/[^\n]*\n|[^\n]+$/g));
        const before = lines(old), after = lines(next);
        patch += `diff --git a/${path} b/${path}\n${old === null ? 'new file mode 100644\n' : next === null ? 'deleted file mode 100644\n' : ''}`;
        patch += `--- ${old === null ? '/dev/null' : `a/${path}`}\n+++ ${next === null ? '/dev/null' : `b/${path}`}\n`;
        if (before.length || after.length) patch += `@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n`;
        for (const [prefix, entries] of [['-', before], ['+', after]]) for (const line of entries) patch += prefix + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
        if (Buffer.byteLength(patch) > 2 * 1024 * 1024) fail('Patch exceeds the 2 MiB export limit.', 413);
      }
    }
    return { items, ...(includePatch ? { patch } : {}), liveCheckoutChanged: false };
  }
  return {
    enabled,
    async status(ctx, { countTool = false } = {}) {
      await access(ctx);
      const inspect = async () => {
        const inspected = await execute(['image', 'inspect', DEVELOPER_IMAGE, '--format', '{{.Id}}'], { timeout: 5000 }).catch(() => ({ exitCode: 1 }));
        return { enabled: true, runtimeReady: inspected.exitCode === 0, image: DEVELOPER_IMAGE, workspace: 'Private source snapshot; export patch to promote changes', limits: { rounds: 8, toolCalls: 16, sourceToolCalls: 12, legacyDeveloperRounds: 6, commands: 2, commandSeconds: 60 } };
      };
      return countTool ? use(ctx, 'read', inspect) : inspect();
    },
    async list(ctx, args) { return use(ctx, 'read', async ({ tree }) => {
      const start = args.offset ?? 0;
      if (!Number.isSafeInteger(start) || start < 0 || start > 4000) fail('offset must be from 0 to 4000.');
      const all = await sourceFiles(tree); return { files: all.slice(start, start + 80), total: all.length, nextOffset: start + 80 < all.length ? start + 80 : null };
    }); },
    async read(ctx, args) { return use(ctx, 'read', async ({ tree }) => {
      const file = await safe(tree, args.path), bytes = await readFile(file), text = bytes.toString('utf8');
      const start = args.start_line ?? 1, count = args.line_count ?? 60;
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 100) fail('Use positive start_line and line_count from 1 to 100.');
      const lines = text.split('\n'), content = lines.slice(start - 1, start - 1 + count).join('\n');
      return { path: args.path, hash: hash(bytes), totalLines: lines.length, startLine: start, content: content.slice(0, 6000), truncated: content.length > 6000 || start - 1 + count < lines.length };
    }); },
    async search(ctx, args) { return use(ctx, 'read', async ({ tree }) => {
      if (typeof args.query !== 'string' || !args.query || args.query.length > 160) fail('Use a literal search query of 1–160 characters.');
      const items = []; let truncated = false;
      for (const path of await sourceFiles(tree)) {
        const lines = (await readFile(await safe(tree, path), 'utf8')).split('\n');
        for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(args.query.toLowerCase())) {
          if (items.length === 20) { truncated = true; break; }
          items.push({ path, line: i + 1, text: lines[i].slice(0, 180) });
        }
        if (truncated) break;
      }
      return { items, truncated };
    }); },
    async edit(ctx, args, remove = false) { return use(ctx, 'write', async ({ tree }) => {
      const file = await safe(tree, args.path);
      let before = await readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (args.expected_hash !== (before === null ? null : hash(before))) fail('The file changed. Read it again before editing.', 409, 'DEVELOPER_FILE_CONFLICT');
      if (remove) { if (before === null) fail('The file does not exist.'); await unlink(file); return { path: args.path, deleted: true, liveCheckoutChanged: false }; }
      let content;
      if (args.content !== undefined) { if (typeof args.content !== 'string') fail('content must be a string.'); content = args.content; }
      else {
        if (before === null || typeof args.find !== 'string' || !args.find || typeof args.replace !== 'string' || before.split(args.find).length !== 2) fail('find must match exactly once in the existing file.');
        content = before.replace(args.find, () => args.replace);
      }
      if (Buffer.byteLength(content) > 256 * 1024 || content.includes('\0')) fail('Edited text exceeds 256 KiB or contains binary data.', 413);
      const total = (await sourceFiles(tree)).length;
      if (before === null && total >= 4000) fail('Workspace file limit reached.', 413);
      let bytes = Buffer.byteLength(content);
      for (const path of await sourceFiles(tree)) if (path !== args.path) bytes += (await lstat(await safe(tree, path))).size;
      if (bytes > 24 * 1024 * 1024) fail('Workspace exceeds 24 MiB.', 413);
      await mkdir(dirname(file), { recursive: true });
      const temporary = join(dirname(file), `.edit-${randomUUID()}`);
      try { await writeFile(temporary, content, { flag: 'wx' }); await rename(temporary, file); }
      finally { await unlink(temporary).catch(() => {}); }
      return { path: args.path, hash: hash(content), bytes: Buffer.byteLength(content), liveCheckoutChanged: false };
    }); },
    async run(ctx, args) { return use(ctx, 'run', async ({ tree }) => {
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 2000 || args.command.includes('\0')) fail('Use a shell command of 1–2000 characters.');
      const name = `rack-agent-${randomUUID()}`;
      try {
        const result = await execute(dockerRunArguments({ tree, name, command: args.command }), { signal: ctx.signal });
        return { ...result, isolation: 'Disposable Linux container; network disabled; live checkout never mounted', persistedFileEdits: false };
      } finally { await execute(['rm', '-f', name], { timeout: 5000 }).catch(() => {}); }
    }); },
    async changes(ctx, args = {}) { return use(ctx, 'read', async dirs => {
      const result = await changes(dirs, Boolean(args.include_diff));
      return { ...result, ...(result.patch !== undefined ? { patch: result.patch.slice(0, 6000), truncated: result.patch.length > 6000 } : {}) };
    }); },
    async export(ctx) { return locked(ctx, dirs => changes(dirs, true)); },
  };
}
