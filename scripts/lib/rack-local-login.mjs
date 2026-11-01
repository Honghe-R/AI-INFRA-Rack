import { randomBytes, createHash } from 'node:crypto';

const ttl = 8 * 60 * 60 * 1000;
const hash = raw => createHash('sha256').update(raw).digest('hex');
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(address);

// A temporary local-development account. Never installed on preview/production servers.
export function localLoginEnabled({ mode, host, enabled = true }) {
  return mode === 'development' && loopback(host) && enabled;
}

export function withLocalLogin(store, { enabled = false, organisationId = null, now = Date.now } = {}) {
  const sessions = new Map();
  const prune = () => { for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key); };
  return {
    ...store,
    canLocalLogin: remoteAddress => enabled && loopback(remoteAddress),
    async login(login, password, validateAccount, remoteAddress) {
      if (!enabled || login !== '111') return store.login(login, password, validateAccount);
      if (password !== '111' || !loopback(remoteAddress))
        throw Object.assign(new Error('Account name or password is incorrect.'), { status: 401, code: 'INVALID_CREDENTIALS' });
      const account = { login: '111', name: 'Local demo administrator', subject: 'dev-user', organisationId };
      // Uses the seeded backend identity and normal server-side RBAC. Never bypass outages.
      if (!validateAccount) throw new Error('Backend verification is required for local demo sign-in.');
      await validateAccount(account);
      prune();
      if (sessions.size >= 24) sessions.delete(sessions.keys().next().value);
      const raw = randomBytes(32).toString('base64url');
      sessions.set(hash(raw), { account, expires: now() + ttl });
      return { raw, account: { login: account.login, name: account.name, organisationId: account.organisationId } };
    },
    async session(raw) {
      prune();
      return (enabled && raw && sessions.get(hash(raw))?.account) || store.session(raw);
    },
    async logout(raw) {
      if (raw && sessions.delete(hash(raw))) return;
      return store.logout(raw);
    },
  };
}
