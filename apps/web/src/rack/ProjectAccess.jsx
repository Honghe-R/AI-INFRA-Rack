import { useEffect, useRef, useState } from 'react';
import { rackError } from './rack-plan-state.js';
import { AccountInvitation } from './AccountInvitation.jsx';

export const PROJECT_ROLE_LABELS = Object.freeze({
  'project-viewer': 'Project viewer', 'project-editor': 'Project editor', 'project-admin': 'Project administrator',
});
export function projectMemberIntent(member, roleKey, status) {
  if (!Object.hasOwn(PROJECT_ROLE_LABELS, roleKey) || !['ACTIVE', 'SUSPENDED'].includes(status)) throw new Error('Choose a supported role and status.');
  return { role_key: roleKey, status, expected_version: member?.version ?? null };
}

export function RackAccessSummary({ canWrite, canDelete, canRestore, canManage, pending = false }) {
  if (pending) return <p className="rack-access-summary" role="status">Checking your project capabilities…</p>;
  return <p className="rack-access-summary" aria-label="Your Rack capabilities">
    <strong>Your access:</strong> View and compute
    {canWrite ? ' · Edit and save' : ' · Read only'}
    {canDelete && ' · Delete plans'}{canRestore && ' · Restore plans'}{canManage && ' · Manage project access'}
  </p>;
}

function RoleSelect({ value, disabled, onChange }) {
  return <label>Project role<select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
    {Object.entries(PROJECT_ROLE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
  </select></label>;
}

export function ProjectMemberList({ data, busy, onEdit }) {
  return <div className="rack-access-table"><table><caption>Direct project memberships</caption>
    <thead><tr><th>Account</th><th>Project role</th><th>Status</th><th>Version</th><th>Action</th></tr></thead>
    <tbody>{data.items.map(m => <tr key={m.userId}>
      <td>{m.displayName || m.email || m.userId}{m.userId === data.actorId && <strong> (you)</strong>}<small>{m.email || m.userId}</small></td>
      <td>{PROJECT_ROLE_LABELS[m.roleKey] || m.roleKey || 'No direct role'}</td>
      <td>{m.status}{m.accountStatus !== 'ACTIVE' && ` · Account ${m.accountStatus}`}{!m.organisationActive && ' · Organisation membership inactive'}</td>
      <td>{m.version}</td><td><button disabled={busy || m.userId === data.actorId || m.accountStatus !== 'ACTIVE' || !m.organisationActive}
        title={m.userId === data.actorId ? 'Ask another administrator to change your access.' : undefined} onClick={() => onEdit(m)}>Change access</button></td>
    </tr>)}</tbody>
  </table>{!data.items.length && <p>No project memberships on this page.</p>}</div>;
}

export function ProjectAccess({ client, projectId, onClose }) {
  const [state, setState] = useState({ pending: true, data: null }), [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState(''), [candidates, setCandidates] = useState(null), [candidateId, setCandidateId] = useState('');
  const [selected, setSelected] = useState(null), [roleKey, setRoleKey] = useState('project-viewer'), [status, setStatus] = useState('ACTIVE');
  const [busy, setBusy] = useState(false), [searching, setSearching] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState(null);
  const [mustRefresh, setMustRefresh] = useState(false);
  const lifetime = useRef(null), sending = useRef(false), searchingRef = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ pending: true, data: null });
    client.listProjectMembers(projectId, { offset, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setState({ pending: false, data: result.data }); setMustRefresh(false); }
    }).catch(e => { if (!controller.signal.aborted) setState({ pending: false, data: null, error: e }); });
    return () => controller.abort();
  }, [client, projectId, offset, refresh]);

  function reload() { setSelected(null); setCandidates(null); setCandidateId(''); setError(null); setRefresh(v => v + 1); }
  async function search(event) {
    event.preventDefault(); if (searchingRef.current || busy || mustRefresh) return;
    searchingRef.current = true; setSearching(true); setError(null); setCandidates(null); setCandidateId('');
    const signal = lifetime.current.signal;
    try { const result = await client.findProjectMemberCandidates(projectId, query, { signal }); if (!signal.aborted) setCandidates(result.data); }
    catch (e) { if (!signal.aborted) setError(rackError(e)); }
    finally { searchingRef.current = false; if (!signal.aborted) setSearching(false); }
  }
  async function save(event) {
    event.preventDefault(); if (sending.current || mustRefresh || state.pending || (!selected && !candidateId)) return;
    const userId = selected?.userId ?? candidateId, input = projectMemberIntent(selected, roleKey, selected ? status : 'ACTIVE');
    const signal = lifetime.current.signal;
    sending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await client.setProjectMember(projectId, userId, input, { signal });
      if (signal.aborted) return;
      setNotice(result.data.changed ? 'Project access saved. New server requests use the updated permissions. Other sessions may need to refresh their controls.' : 'Project access was already up to date.');
      reload();
    } catch (e) {
      if (signal.aborted) return;
      setError(`${rackError(e)} Refresh members to reconcile the current state before submitting again.`); setMustRefresh(true);
    } finally { sending.current = false; if (!signal.aborted) setBusy(false); }
  }
  const locked = busy || searching || state.pending || mustRefresh;
  return <section className="rack-card rack-project-access" aria-label="Project access">
    <header className="rack-heading"><div><h2>Project access</h2><p>Invite personal accounts and manage access to this project.</p></div>
      <div className="rack-actions"><button disabled={busy || searching} onClick={reload}>Refresh members</button><button disabled={busy || searching} onClick={onClose}>Close access</button></div></header>
    <p className="rack-warning">Suspending project membership removes its direct grant. Organisation or global roles may still allow access. Your own access must be changed by another administrator.</p>
    {error && <p role="alert" className="rack-error">{error}</p>}{notice && <p role="status" className="rack-notice">{notice}</p>}
    {state.pending ? <p role="status">Reading project access…</p> : state.error ? <p role="alert" className="rack-error">{rackError(state.error)}</p> : state.data && <>
      <ProjectMemberList data={state.data} busy={locked} onEdit={m => { setSelected(m); setRoleKey(PROJECT_ROLE_LABELS[m.roleKey] ? m.roleKey : 'project-viewer'); setStatus(m.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE'); setError(null); }} />
      <nav className="rack-actions" aria-label="Member pages"><button disabled={locked || offset === 0} onClick={() => { setSelected(null); setOffset(Math.max(0, offset - 20)); }}>Previous members</button>
        <span>Page {offset / 20 + 1}</span><button disabled={locked || state.data.nextOffset === null} onClick={() => { setSelected(null); setOffset(state.data.nextOffset); }}>Next members</button></nav>
      {selected ? <form onSubmit={save} className="rack-access-form"><h3>Change access: {selected.displayName || selected.email || selected.userId}</h3>
        <RoleSelect value={roleKey} disabled={locked} onChange={setRoleKey} />
        <label>Project membership<select value={status} disabled={locked} onChange={e => setStatus(e.target.value)}><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select></label>
        <p>Based on member version {selected.version}. At least one active project administrator must remain.</p>
        <div className="rack-actions"><button className="rack-primary" disabled={locked}>Save project access</button><button type="button" disabled={busy} onClick={() => { setSelected(null); setRoleKey('project-viewer'); }}>Cancel access change</button></div>
      </form> : <div className="rack-access-form"><h3>Add an organisation account</h3>
        <form onSubmit={search} className="rack-actions"><label>Find an account<input value={query} maxLength={100} disabled={locked} onChange={e => setQuery(e.target.value)} placeholder="Name or email" /></label><button disabled={locked}>{searching ? 'Searching…' : 'Search organisation'}</button></form>
        {candidates && <form onSubmit={save}><label>Eligible account<select required value={candidateId} disabled={locked} onChange={e => { setCandidateId(e.target.value); setRoleKey('project-viewer'); }}><option value="">Choose an existing account</option>
          {candidates.items.map(m => <option key={m.userId} value={m.userId}>{m.displayName || m.email || m.userId}{m.email ? ` · ${m.email}` : ''}</option>)}</select></label>
          {!candidates.items.length && <p>No matching accounts to add. Existing members can be changed above.</p>}{candidates.truncated && <p>First 20 results. Narrow your search to find another account.</p>}
          <RoleSelect value={roleKey} disabled={locked} onChange={setRoleKey} /><button className="rack-primary" disabled={locked || !candidateId}>Add project member</button></form>}
      </div>}
      <details><summary>Latest {state.data.events.length} project access events (up to 20)</summary>
        {!state.data.events.length ? <p>No access changes recorded through this workflow yet.</p> : <ol>{state.data.events.map(e => <li key={e.eventId}>
          <time>{e.createdAt}</time> · {e.action} · Target <code>{e.targetUserId}</code> · Actor <code>{e.actorUserId}</code>
          <p>{e.before ? `${PROJECT_ROLE_LABELS[e.before.roleKey] || e.before.roleKey} / ${e.before.status}` : 'No project membership'} → {PROJECT_ROLE_LABELS[e.after.roleKey] || e.after.roleKey} / {e.after.status} · v{e.after.version}</p>
        </li>)}</ol>}
      </details>
    </>}
    <AccountInvitation client={client} projectId={projectId} onCreated={reload} disabled={locked || !state.data} />
  </section>;
}
