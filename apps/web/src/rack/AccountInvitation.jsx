import { useEffect, useRef, useState } from 'react';

const roles = {
  'project-viewer': 'Viewer — view plans and compute previews',
  'project-editor': 'Editor — edit layouts, equipment and save',
  'project-admin': 'Administrator — also manage members and delete plans',
};

export function AccountInvitationForm({ values, busy, onChange, onSubmit }) {
  return <form className="rack-access-form" onSubmit={onSubmit}>
    <h3>Invite new account</h3>
    <p>Create a personal sign-in and grant access to this project. The member sets their own password.</p>
    <label>Account name<input autoComplete="off" required minLength={3} maxLength={64}
      pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,63}" value={values.login} disabled={busy}
      onChange={e => onChange({ ...values, login: e.target.value })} placeholder="e.g. alex.chen" /></label>
    <label>Display name<input autoComplete="off" required maxLength={160} value={values.name} disabled={busy}
      onChange={e => onChange({ ...values, name: e.target.value })} /></label>
    <label>Project role<select value={values.roleKey} disabled={busy} onChange={e => onChange({ ...values, roleKey: e.target.value })}>
      {Object.entries(roles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <p>Share the generated link privately. It expires in 24 hours and works once. No email is sent.
      Reissuing an identical pending invitation invalidates its earlier link; activated accounts cannot be reset here.</p>
    <button className="rack-primary" disabled={busy}>{busy ? 'Creating invitation…' : 'Create or reissue invitation'}</button>
  </form>;
}

export function AccountInvitation({ client, projectId, onCreated, disabled = false }) {
  const empty = () => ({ login: '', name: '', roleKey: 'project-viewer' });
  const [values, setValues] = useState(empty), [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false), [result, setResult] = useState(null), [error, setError] = useState(null), [copied, setCopied] = useState(false);
  const requestId = useRef(null), controller = useRef(null), sending = useRef(false);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    client.request('/__auth/session', { signal: abort.signal }).then(r => {
      if (!abort.signal.aborted) setEnabled(r.data?.mode === 'password' && Boolean(r.data.account));
    }).catch(() => {});
    return () => abort.abort();
  }, [client]);
  if (!enabled) return null;
  return <section aria-label="New account invitation">
    {!result ? <AccountInvitationForm values={values} busy={busy || disabled} onChange={next => {
      requestId.current = null; setValues(next); setError(null);
    }} onSubmit={async event => {
      event.preventDefault(); if (sending.current || disabled) return;
      sending.current = true; setBusy(true); setError(null);
      requestId.current ??= crypto.randomUUID();
      const signal = controller.current.signal;
      try {
        const response = await client.request('/__auth/invitations', { method: 'POST', signal,
          body: { ...values, projectId, requestId: requestId.current } });
        if (signal.aborted) return;
        setResult(response.data); setCopied(false); onCreated();
      } catch (e) { if (!signal.aborted) setError(`${e.message || 'Invitation failed.'} Retry the same details after checking project access.`); }
      finally { sending.current = false; if (!signal.aborted) setBusy(false); }
    }} /> : <div className="rack-access-form">
      <h3>Invitation ready: {result.login}</h3>
      <p role="status">The account and project role are ready. The member must activate their account before signing in.</p>
      <label>Private activation link<input readOnly value={result.activationUrl} onFocus={e => e.target.select()} /></label>
      <p>Expires: {new Date(result.expiresAt).toLocaleString()}. Keep this link private; anyone holding it can set the initial password.</p>
      <div className="rack-actions"><button type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(result.activationUrl); setCopied(true); }
        catch { setError('Copy is unavailable. Select the activation link and copy it manually.'); }
      }}>{copied ? 'Link copied' : 'Copy activation link'}</button>
      <button type="button" onClick={() => { setResult(null); setValues(empty()); requestId.current = null; setError(null); }}>Invite another account</button>
      <button type="button" onClick={() => { setResult(null); setError(null); }}>Hide link</button></div>
    </div>}
    {error && <p role="alert" className="rack-error">{error}</p>}
  </section>;
}
