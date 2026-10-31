import { useEffect, useRef, useState } from 'react';
import { rackError, uncertainCreation } from './rack-plan-state.js';
import { assertRackReportScope, rackInventoryCsv, downloadRackFile, savedCheckBlockReason } from './rack-report.js';

export function RackCheckHistory({ client, layout, draft, canWrite }) {
  const [history, setHistory] = useState(null), [loadError, setLoadError] = useState(null);
  const [retry, setRetry] = useState(0), [busy, setBusy] = useState(false);
  const [error, setError] = useState(null), [notice, setNotice] = useState(null), [attempt, setAttempt] = useState(null);
  const lifetime = useRef(null), sending = useRef(false);
  const blocked = savedCheckBlockReason(layout, draft, canWrite);
  useEffect(() => {
    const c = new AbortController(); lifetime.current = c;
    return () => c.abort();
  }, [client, layout.projectId, layout.planId, layout.version]);
  useEffect(() => {
    const c = new AbortController(); setHistory(null); setLoadError(null);
    client.listRackCheckRuns(layout.projectId, layout.planId, { signal: c.signal }).then(({ data }) => {
      if (data.projectId !== layout.projectId || data.planId !== layout.planId || data.version !== layout.version)
        throw new Error('The saved plan changed. Reload it to view current check history.');
      if (!c.signal.aborted) setHistory(data);
    }).catch(e => { if (!c.signal.aborted) setLoadError(e); });
    return () => c.abort();
  }, [client, layout.projectId, layout.planId, layout.version, retry]);
  async function act(operation) {
    if (sending.current || lifetime.current?.signal.aborted) return;
    const signal = lifetime.current.signal;
    sending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await operation(signal); }
    catch (e) { if (!signal.aborted) setError(e); }
    finally { sending.current = false; if (!signal.aborted) setBusy(false); }
  }
  const record = () => {
    if (blocked) return;
    act(async signal => {
      const current = attempt ?? { key: crypto.randomUUID(), body: { contract_version: 1, base_version: layout.version, snapshot_id: layout.snapshot.snapshotId } };
      setAttempt(current);
      let result;
      try { result = await client.recordRackCheckRun(layout.projectId, layout.planId, current.body, { idempotencyKey: current.key, signal }); }
      catch (e) { if (!signal.aborted && !uncertainCreation(e)) setAttempt(null); throw e; }
      if (signal.aborted) return;
      if (result.data.projectId !== layout.projectId || result.data.planId !== layout.planId || result.data.planVersion !== layout.version)
        throw new Error('The check result does not match this saved plan. Reload before retrying.');
      setAttempt(null); setNotice(`Recorded saved version ${result.data.planVersion}: spatial ${result.data.spatialStatus}; equipment ${result.data.equipmentStatus}.`);
      setRetry(n => n + 1);
    });
  };
  const download = format => {
    if (draft) return;
    act(async signal => {
      const { data } = await client.getRackReport(layout.projectId, layout.planId, { signal });
      if (signal.aborted) return;
      assertRackReportScope(data, layout);
      const name = `rack-${layout.planId}-v${layout.version}`;
      downloadRackFile(format === 'csv' ? rackInventoryCsv(data) : JSON.stringify(data, null, 2) + '\n',
        `${name}.${format}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8');
      setNotice(`Downloaded saved version ${layout.version}. ${data.checkRun ? 'Matching check evidence included in JSON.' : 'No current recorded check; scope is explicit in JSON.'}`);
    });
  };
  const historical = run => act(async signal => {
    const { data } = await client.getRackCheckRun(layout.projectId, layout.planId, run.runId, { signal });
    if (signal.aborted) return;
    if (data.projectId !== layout.projectId || data.planId !== layout.planId || data.runId !== run.runId)
      throw new Error('The historical check scope does not match.');
    downloadRackFile(JSON.stringify({ kind: 'RACK_SCOPED_CHECK_RECORD', validationState: 'NOT_RUN', ...data }, null, 2) + '\n',
      `rack-check-${data.runId}.json`, 'application/json;charset=utf-8');
  });
  return <section className="rack-card" aria-label="Saved check history and reports">
    <h3>Saved checks & reports</h3>
    <p>Record evidence for saved version {layout.version}. Draft checks below update while editing. Recorded checks cover declared spatial, equipment and capacity rules; whole-plan validation remains NOT_RUN.</p>
    <div className="rack-actions">
      <button disabled={busy || Boolean(blocked)} title={blocked ?? ''} onClick={record}>{attempt ? 'Retry same check recording' : 'Record saved checks'}</button>
      <button disabled={busy || Boolean(draft)} onClick={() => download('json')}>Download plan JSON</button>
      <button disabled={busy || Boolean(draft)} onClick={() => download('csv')}>Download equipment CSV</button>
      <button disabled={busy} onClick={() => setRetry(n => n + 1)}>Refresh history</button>
    </div>
    {blocked && <p className="rack-muted">{blocked}</p>}
    {draft && <p className="rack-warning">Downloads use the saved plan. Save or discard your draft first.</p>}
    {attempt && <p className="rack-warning">If the result is uncertain, retry the same recording to avoid a duplicate.</p>}
    {error && <p role="alert" className="rack-error">{rackError(error)}</p>}
    {notice && <p role="status">{notice}</p>}
    {loadError ? <p role="alert" className="rack-error">{rackError(loadError)}</p> : !history ? <p role="status">Loading saved checks…</p> : !history.items.length ?
      <p>No saved checks yet. Save the layout, then record its checks.</p> : <div className="rack-table-scroll"><table className="rack-input-table">
        <caption>Latest {history.items.length} saved checks{history.hasOlder ? ' (older records retained)' : ''}</caption>
        <thead><tr><th>Recorded (local time)</th><th>Version</th><th>Freshness</th><th>Spatial</th><th>Equipment</th><th>Evidence</th></tr></thead>
        <tbody>{history.items.map(run => <tr key={run.runId}>
          <td>{new Date(run.createdAt).toLocaleString()}</td><td>{run.planVersion}</td>
          <td title={run.freshness.reasons.join(', ')}>{run.freshness.status}</td>
          <td>{run.spatialStatus}</td><td>{run.equipmentStatus}</td>
          <td><button disabled={busy} onClick={() => historical(run)}>Check JSON</button></td>
        </tr>)}</tbody>
      </table></div>}
    <p className="rack-muted">JSON retains provenance, unknowns and unchecked rules. CSV lists installed and unassigned devices. Historical check JSON contains reports, not an old layout. Downloads are planning artifacts.</p>
  </section>;
}
