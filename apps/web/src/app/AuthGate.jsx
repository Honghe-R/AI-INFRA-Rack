import { useEffect, useState } from 'react';
import { rememberDevIdentity } from './dev-identity.js';

async function authRequest(path, body) {
  const response = await fetch(`/__auth/${path}`, { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data) throw new Error(payload?.error?.message ?? 'Sign-in is unavailable. Check that the Rack web server is running.');
  return payload.data;
}

export function AuthScreen({ activation = false, busy = false, error, notice, onSubmit }) {
  const [login, setLogin] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState(null);
  return <main className="rack-auth"><section className="rack-auth-card" aria-label={activation ? 'Activate account' : 'Sign in'}>
    <p className="rack-auth-brand">AI INFRA · RACK</p>
    <h1>{activation ? 'Set your password' : 'Sign in'}</h1>
    <p>{activation ? 'Activate your account with a personal password.' : 'Use your personal account to access your projects.'}</p>
    <form onSubmit={event => { event.preventDefault(); setLocalError(null);
      if (activation && password !== confirm) { setLocalError('The passwords do not match.'); return; }
      onSubmit({ login, password });
    }}>
      {!activation && <label>Account name<input name="username" autoComplete="username" required maxLength={64} value={login} disabled={busy} onChange={e => setLogin(e.target.value)} /></label>}
      <label>{activation ? 'New password' : 'Password'}<input name="password" type="password" autoComplete={activation ? 'new-password' : 'current-password'} required minLength={activation ? 12 : undefined} maxLength={128} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
      {activation && <><label>Confirm password<input name="confirm-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirm} disabled={busy} onChange={e => setConfirm(e.target.value)} /></label><p className="rack-auth-note">Use 12–128 characters. This link works once and expires after 24 hours.</p></>}
      {(error || localError) && <p role="alert" className="rack-auth-error">{error || localError}</p>}
      {notice && <p role="status">{notice}</p>}
      <button disabled={busy} type="submit">{busy ? 'Please wait…' : activation ? 'Activate account' : 'Sign in'}</button>
    </form>
    <p className="rack-auth-note">{activation ? 'After activation, sign in with the account name provided by your administrator.' : 'Need an account or password help? Contact your platform administrator. Project roles are assigned by an administrator.'}</p>
  </section></main>;
}

export function AuthGate({ children }) {
  const [session, setSession] = useState(null), [pending, setPending] = useState(true), [error, setError] = useState(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(null);
  const [activation, setActivation] = useState(() => new URLSearchParams(globalThis.location?.hash?.slice(1) ?? '').get('activate'));
  // Keep activation secrets out of subsequent history entries and copied URLs.
  useEffect(() => { if (activation) globalThis.history?.replaceState(null, '', `${location.pathname}${location.search}`); }, []);
  useEffect(() => { let active = true; authRequest('session').then(data => {
    if (!active) return;
    if (data.mode === 'password') rememberDevIdentity(null);
    setSession(data);
  }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setPending(false); }); return () => { active = false; }; }, []);
  useEffect(() => {
    if (session?.mode !== 'password' || !session.account) return;
    const expired = () => { setSession({ mode: 'password', account: null }); setNotice('Your session ended. Sign in again.'); };
    const refresh = async () => {
      try {
        const current = await authRequest('session');
        if (!current.account) expired();
        else if (current.account.login !== session.account.login) location.reload();
      } catch { /* A transient network error does not discard the session. */ }
    };
    const timer = setInterval(refresh, 60000);
    globalThis.addEventListener('rack:session-expired', expired);
    globalThis.addEventListener('focus', refresh);
    return () => { clearInterval(timer); globalThis.removeEventListener('rack:session-expired', expired); globalThis.removeEventListener('focus', refresh); };
  }, [session?.mode, session?.account]);
  if (pending) return <main className="rack-auth" role="status">Checking your session…</main>;
  if (!session) return <main className="rack-auth"><section className="rack-auth-card"><h1>Sign-in unavailable</h1><p role="alert">{error}</p><button onClick={() => location.reload()}>Retry</button></section></main>;
  if (!activation && (session.mode === 'demo' || session.account)) return children({ account: session.account, mode: session.mode,
    onSignOut: async () => {
      if (!globalThis.confirm('Sign out? Unsaved layout changes will be lost.')) return;
      try { await authRequest('logout', {}); rememberDevIdentity(null); location.reload(); }
      catch (e) { globalThis.alert(e.message); }
    } });
  return <AuthScreen key={activation ? 'activation' : 'login'} activation={Boolean(activation)} busy={busy} error={error} notice={notice} onSubmit={async values => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (activation) {
        const account = await authRequest('activate', { token: activation, password: values.password });
        setActivation(null); setNotice(`Account ${account.login} activated. Sign in with your new password.`);
      } else { await authRequest('login', values); rememberDevIdentity(null); location.reload(); }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }} />;
}
