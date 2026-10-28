import { useEffect, useRef, useState } from 'react';
import { RoomFloorplan } from './RackRoomView.jsx';
import { rackError } from './rack-plan-state.js';
import { optionStageReason, stageRackOption } from './rack-options-state.js';

const label = id => id === 'row-scan-v1' ? 'Row scan · baseline' : 'Largest first · heuristic';
const number = n => Number(n.toFixed(3)).toLocaleString();

export function RackOptions({ client, layout, draft, canWrite, onDraftChange, onNavigate }) {
  const [step, setStep] = useState(0.5), [rotate, setRotate] = useState(true), [strategy, setStrategy] = useState('COMPARE');
  const [result, setResult] = useState(null), [selected, setSelected] = useState(0), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState(null);
  const request = useRef(null);
  useEffect(() => {
    request.current?.abort(); setPending(false); setResult(null); setConfirmed(false); setError(null);
    return () => request.current?.abort();
  }, [layout.projectId, layout.planId, layout.version, layout.snapshot.snapshotId]);
  const stale = layout.sourceStatus.status !== 'UNCHANGED';
  const option = result?.candidates[selected];
  const guards = { canWrite, draft, confirmed };
  const stageReason = optionStageReason(layout, result, option, guards);
  async function generate(event) {
    event.preventDefault();
    if (pending || draft || stale) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setPending(true); setError(null); setResult(null); setConfirmed(false);
    try {
      const response = await client.generateRackOptions(layout.projectId, layout.planId, {
        contract_version: 1, base_version: layout.version, snapshot_id: layout.snapshot.snapshotId,
        options: { grid_step_m: step, allow_rotation: rotate, strategy },
      }, { signal: controller.signal });
      if (!controller.signal.aborted) { setResult(response.data); setSelected(0); }
    } catch (e) { if (!controller.signal.aborted) setError(rackError(e)); }
    finally { if (!controller.signal.aborted) setPending(false); }
  }
  return <section className="rack-options" aria-label="Rack layout options">
    <h3>Generate and compare layouts</h3>
    <p>Relocate the existing unlocked racks; keep locked positions, identities, equipment assignments and capacity assumptions. Search uses the fixed room Polygon, holes, exclusion zones and declared front/rear clearances.</p>
    <p className="rack-muted">Two deterministic greedy strategies, with bounded grid search. Neither guarantees an optimum or proves that a room is full. No device allocation, connected-aisle planning or engineering certification is performed.</p>
    <form className="rack-card" onSubmit={generate} aria-label="Layout search parameters">
      <div className="rack-form-fields">
        <label>Grid step (m)<input type="number" min="0.1" max="5" step="0.1" required disabled={pending}
          value={Number.isFinite(step) ? step : ''} onChange={e => setStep(e.target.value === '' ? NaN : Number(e.target.value))} /></label>
        <label>Strategy<select value={strategy} disabled={pending} onChange={e => setStrategy(e.target.value)}>
          <option value="COMPARE">Compare both strategies</option><option value="INPUT_ORDER">Saved rack order / row scan</option><option value="LARGEST_FIRST">Largest footprint first</option>
        </select></label>
      </div>
      <label className="rack-option-check"><input type="checkbox" checked={rotate} disabled={pending} onChange={e => setRotate(e.target.checked)} />Allow quarter-turn rotations</label>
      <p>{layout.placements.length} racks · {layout.placements.filter(p => p.locked).length} locked · base v{layout.version}. Save or discard manual edits before generation.</p>
      <div className="rack-actions"><button className="rack-primary" disabled={pending || Boolean(draft) || stale || !layout.placements.length}> {pending ? 'Searching…' : 'Generate layout options'}</button>
        {pending && <button type="button" onClick={() => { request.current?.abort(); setPending(false); }}>Stop waiting</button>}</div>
      {draft && <p className="rack-warning">One shared draft is open. Current edits will not be overwritten.</p>}
      <p className="rack-muted">At most 64 movable racks, 2,048 proposed poses per rack and 16,384 per option. Server planning time is bounded; stopping this view does not immediately interrupt an already running database query.</p>
    </form>
    {error && <p role="alert" className="rack-error">{error}</p>}
    {result && <>
      <p role="status">{result.candidates.length} option(s) · {result.elapsedMs} ms · saved base v{result.baseVersion}. Preview only; the database has not changed.</p>
      <p className="rack-muted">Generated grid: {result.options.grid_step_m} m · Rotations: {result.options.allow_rotation ? 'quarter turns' : 'preserved'} · Algorithms: {result.candidates.map(c => c.algorithmId).join(', ')}</p>
      <div className="rack-table-scroll"><table className="rack-input-table"><caption>Layout comparison · smaller rack envelope is more compact; movement is a separate tradeoff</caption>
        <thead><tr><th>Layout</th><th>Rack envelope (m²)</th><th>Moved racks</th><th>Movement (m)</th><th>Unplaced</th><th>Scope checks</th></tr></thead>
        <tbody><tr><td>Current saved layout</td><td>{number(result.baseline.metrics.envelopeAreaM2)}</td><td>0</td><td>0</td><td>—</td><td>{result.baseline.report.status} / {result.baseline.equipmentReport.status}</td></tr>
          {result.candidates.map((c, index) => <tr key={c.optionId}><td><button aria-pressed={selected === index} onClick={() => { setSelected(index); setConfirmed(false); }}>{label(c.algorithmId)}</button></td>
            <td>{number(c.metrics.envelopeAreaM2)}</td><td>{c.metrics.movedRacks}</td><td>{number(c.metrics.movementM)}</td><td>{c.unplaced.length}</td><td>{c.report.status} / {c.equipmentReport.status}</td></tr>)}
        </tbody></table></div>
      {result.candidates.length === 2 && JSON.stringify(result.candidates[0].placements) === JSON.stringify(result.candidates[1].placements) &&
        <p className="rack-muted">Both strategies produced the same layout for these inputs. Sorting is not guaranteed to improve the baseline.</p>}
      {option && <>
        <h3>{label(option.algorithmId)}</h3>
        <p>{option.positionsSubmitted} proposed poses submitted · {option.unplaced.length} unplaced. Devices remain in their original racks and U slots.</p>
        <details className="rack-card"><summary>Rack position changes · {option.metrics.movedRacks} moved</summary>
          <div className="rack-table-scroll"><table className="rack-input-table"><thead><tr><th>Rack</th><th>Saved centre / rotation</th><th>Proposed centre / rotation</th><th>Change</th></tr></thead>
            <tbody>{option.placements.map(p => {
              const old = layout.placements.find(r => r.rackId === p.rackId);
              const moved = ['xM','yM','rotationDeg'].some(k => p[k] !== old[k]);
              return <tr key={p.rackId}><td>{p.name}</td><td>{number(old.xM)}, {number(old.yM)} m / {old.rotationDeg}°</td><td>{number(p.xM)}, {number(p.yM)} m / {p.rotationDeg}°</td><td>{p.locked ? 'Locked · retained' : moved ? 'Move / rotate' : 'Unchanged'}</td></tr>;
            })}</tbody></table></div>
        </details>
        {option.unplaced.length > 0 && <section className="rack-warning" aria-label="Unplaced racks"><h4>Unplaced racks · retained at original positions for this partial preview</h4>
          <ul>{option.unplaced.map(item => <li key={item.rackId}>{layout.placements.find(p => p.rackId === item.rackId)?.name ?? item.rackId} · {item.code}: {item.message}</li>)}</ul></section>}
        <RoomFloorplan key={option.optionId} layoutLabel="Option preview · not saved" room={layout.snapshot.room} view={layout.snapshot.view} sourceGeometry={layout.snapshot.sourceGeometry}
          placements={option.placements} models={layout.models} constraints={option.body.constraints} report={option.report} equipmentReport={option.equipmentReport} />
        <section className="rack-card" aria-label="Option check results"><h4>Full server checks</h4>
          <p>Spatial: {option.report.status} · Equipment: {option.equipmentReport.status} · Whole-plan: NOT_RUN</p>
          <ul>{[...option.report.diagnostics, ...option.equipmentReport.diagnostics].map((d, i) => <li key={i}>{d.code}: {d.message}</li>)}</ul>
          <p className="rack-muted">Unchecked spatial scope: {option.report.uncheckedRules.join(', ')}. Unknown demands and budgets remain unknown; an error-free limited scope is not engineering approval.</p>
        </section>
        <label className="rack-option-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I reviewed this preview and its limited check scope.</label>
        {stageReason && <p className="rack-muted">{stageReason}</p>}
        <button className="rack-primary" disabled={Boolean(stageReason)} onClick={() => {
          try { onDraftChange(stageRackOption(layout, result, option, guards)); setConfirmed(false); onNavigate('layout'); }
          catch (e) { setError(e.message); }
        }}>Use selected option as draft</button>
        <p className="rack-muted">Review the shared draft, then Save layout to apply. Saving rechecks authorization, source freshness, locked racks, version and both rule reports atomically. Options are temporary and are not stored as candidate history.</p>
      </>}
    </>}
  </section>;
}
