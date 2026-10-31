import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const scrypt = promisify(scryptCallback);
const OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_MS = 8 * 60 * 60 * 1000;
const INVITE_MS = 24 * 60 * 60 * 1000;
const COOKIE = 'rack_session';
export const RACK_GATEWAY_TOKEN = Symbol('rack.gateway.token');
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const invalid = () => fail(401, 'INVALID_CREDENTIALS', 'Account name or password is incorrect.');
export function normalizeLogin(value) {
  const login = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(login)) throw fail(400, 'INVALID_ACCOUNT', 'Use 3–64 letters, numbers, dots, underscores or hyphens.');
  return login;
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    throw fail(400, 'PASSWORD_POLICY', 'Use a password with 12–128 characters.');
  const salt = randomBytes(16).toString('base64url');
  return `${salt}.${(await scrypt(password, salt, 64, OPTIONS)).toString('base64url')}`;
}
async function matchesPassword(password, encoded) {
  const [salt, expected] = (encoded ?? '').split('.');
  const actual = await scrypt(password, salt || 'rack-auth-unknown-account', 64, OPTIONS);
  const wanted = Buffer.from(expected || '', 'base64url');
  return wanted.length === actual.length && timingSafeEqual(actual, wanted);
}
function publicAccount(account) {
  return { login: account.login, name: account.name, organisationId: account.organisationId };
}
export function sessionToken(headers) {
  const matches = (headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE.length + 1);
  return /^[\w-]{43}$/.test(value) ? value : null;
}
export function createAccountStore({ file, now = Date.now }) {
  async function read() {
    try {
      const state = JSON.parse(await readFile(file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.sessions)) throw new Error('Invalid account store.');
      return state;
    } catch (e) { if (e.code === 'ENOENT') return { version: 1, accounts: [], sessions: [] }; throw e; }
  }
  async function update(fn) {
    await mkdir(dirname(file), { recursive: true });
    let lock;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lock = await open(`${file}.lock`, 'wx', 0o600); break; }
      catch (e) { if (e.code !== 'EEXIST') throw e; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    if (!lock) throw new Error('Account store is busy.');
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const state = await read();
      const result = await fn(state);
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
      return result;
    } finally { await unlink(temp).catch(() => {}); await lock.close(); await unlink(`${file}.lock`); }
  }
  return {
    async provision({ login: input, subject, name, organisationId }) {
      const login = normalizeLogin(input), raw = token();
      if (!subject || !name || !organisationId) throw new Error('A verified backend subject, name and organisation are required.');
      await update(state => {
        const existing = state.accounts.find(a => a.login === login || a.subject === subject);
        if (existing?.passwordHash) throw new Error('This account is already activated. Provisioning never resets a password.');
        if (existing && (existing.login !== login || existing.subject !== subject)) throw new Error('This account name or subject is already bound.');
        const account = existing ?? { login, subject, name, organisationId };
        Object.assign(account, { activationHash: digest(raw), activationExpires: now() + INVITE_MS });
        if (!existing) state.accounts.push(account);
      });
      return raw;
    },
    async activate(raw, password) {
      if (typeof raw !== 'string' || !/^[\w-]{43}$/.test(raw)) throw fail(400, 'ACTIVATION_INVALID', 'The activation link is invalid, expired or already used.');
      const passwordHash = await hashPassword(password);
      return update(state => {
        const account = state.accounts.find(a => a.activationHash === digest(raw) && a.activationExpires > now() && !a.passwordHash);
        if (!account) throw fail(400, 'ACTIVATION_INVALID', 'The activation link is invalid, expired or already used.');
        account.passwordHash = passwordHash;
        delete account.activationHash; delete account.activationExpires;
        return publicAccount(account);
      });
    },
    async login(input, password, validateAccount) {
      let login;
      try { login = normalizeLogin(input); } catch { login = ''; }
      if (typeof password !== 'string' || password.length > 128) throw invalid();
      const account = (await read()).accounts.find(a => a.login === login && a.passwordHash);
      if (!(await matchesPassword(password, account?.passwordHash)) || !account) throw invalid();
      if (validateAccount) await validateAccount(account);
      const raw = token();
      await update(state => {
        const current = state.accounts.find(a => a.login === login && a.passwordHash === account.passwordHash);
        if (!current) throw invalid();
        state.sessions = state.sessions.filter(s => s.expires > now());
        // Bound retained sessions per account; each login uses a fresh token.
        const own = state.sessions.filter(s => s.login === login);
        const oldest = new Set(own.slice(0, Math.max(0, own.length - 4)).map(s => s.hash));
        state.sessions = state.sessions.filter(s => !oldest.has(s.hash));
        state.sessions.push({ hash: digest(raw), login, expires: now() + SESSION_MS });
      });
      return { raw, account: publicAccount(account) };
    },
    async session(raw) {
      if (!raw) return null;
      const state = await read();
      const session = state.sessions.find(s => s.hash === digest(raw) && s.expires > now());
      return session ? state.accounts.find(a => a.login === session.login && a.passwordHash) ?? null : null;
    },
    async logout(raw) { if (raw) await update(state => { state.sessions = state.sessions.filter(s => s.hash !== digest(raw) && s.expires > now()); }); },
  };
}

function cookie(raw, secure, maxAge = SESSION_MS / 1000) {
  return `${COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export function createLoginLimiter({ now = Date.now, max = 8, windowMs = 300000 } = {}) {
  const buckets = new Map();
  return key => {
    for (const [k, b] of buckets) if (b.until <= now()) buckets.delete(k);
    const current = buckets.get(key) ?? { until: now() + windowMs, count: 0 };
    if (current.count >= max || (!buckets.has(key) && buckets.size >= 2048)) throw fail(429, 'LOGIN_RATE_LIMITED', 'Too many attempts. Wait five minutes and try again.');
    current.count++; buckets.set(key, current);
  };
}
export function createRackAuthMiddleware({ store, mint, allowedOrigins, secure = false, validateAccount = null, now = Date.now }) {
  const limitIp = createLoginLimiter({ now, max: 24 }), limitAccount = createLoginLimiter({ now });
  const origins = new Set(allowedOrigins);
  const mutating = method => !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return async (request, response, next) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!(path.startsWith('/__auth/') || /^\/api(?:\/|$)/.test(path))) return next();
    try {
      response.setHeader('Cache-Control', 'no-store');
      if (mutating(request.method) && !origins.has(request.headers.origin))
        throw fail(403, 'ORIGIN_REJECTED', 'This request must come from the Rack application.');
      const raw = sessionToken(request.headers);
      if (/^\/api(?:\/|$)/.test(path)) {
        const account = await store.session(raw);
        if (!account) throw fail(401, 'UNAUTHENTICATED', 'Sign in to continue.');
        // Only this private Symbol reaches the proxy hook. Browser headers cannot set it.
        request[RACK_GATEWAY_TOKEN] = await mint(account.subject);
        delete request.headers.authorization; delete request.headers['x-dev-subject'];
        return next();
      }
      let data, body = {};
      if (path === '/__auth/session' && request.method === 'GET') {
        const account = await store.session(raw);
        data = { mode: 'password', account: account ? publicAccount(account) : null };
      } else {
        if (request.method !== 'POST' || !['/__auth/activate', '/__auth/login', '/__auth/logout'].includes(path))
          throw fail(404, 'NOT_FOUND', 'The requested resource was not found.');
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw fail(415, 'JSON_REQUIRED', 'Use a JSON request.');
        let size = 0, chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 8192) throw fail(413, 'BODY_TOO_LARGE', 'The request is too large.'); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw fail(400, 'INVALID_JSON', 'Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'INVALID_JSON', 'Use a JSON object.');
        if (path !== '/__auth/logout') {
          limitIp(request.socket.remoteAddress ?? 'unknown');
          limitAccount(`${path}:${digest(typeof body.login === 'string' ? body.login.trim().toLowerCase() : 'activation')}`);
        }
        if (path === '/__auth/activate') data = await store.activate(body.token, body.password);
        else if (path === '/__auth/login') {
          const result = await store.login(body.login, body.password, validateAccount);
          await store.logout(raw);
          response.setHeader('Set-Cookie', cookie(result.raw, secure));
          data = result.account;
        } else {
          await store.logout(raw);
          response.setHeader('Set-Cookie', cookie('', secure, 0));
          data = { signedOut: true };
        }
      }
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ data }));
    } catch (e) {
      response.statusCode = e.status ?? 503;
      if (response.statusCode === 429) response.setHeader('Retry-After', '300');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: { code: e.code ?? 'AUTH_UNAVAILABLE', message: e.status ? e.message : 'Sign-in is temporarily unavailable. Contact the platform operator.' } }));
    }
  };
}
