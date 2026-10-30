import { useEffect, useRef, useState } from 'react';
import { RACK_COMMANDS } from './rack-commands.js';

export function RackAddDialog({ kind, layout, draft, catalogState, blockedReason, onApply, onClose }) {
  const dialog = useRef(null);
  const [error, setError] = useState(null);
  const [values, setValues] = useState(() => ({ name: kind === 'rack_add' ? `Rack ${(draft?.placements ?? layout.placements).length + 1}` : `Exclusion zone ${(draft?.constraints ?? layout.constraints).obstacles.length + 1}`,
    modelId: layout.models[0]?.modelId ?? '', xM: Number((layout.snapshot.view.extentM.width / 2).toFixed(2)),
    yM: Number((layout.snapshot.view.extentM.height / 2).toFixed(2)), rotationDeg: 0, widthM: 1, depthM: 1, quantity: 1, catalogKey: '' }));
  useEffect(() => { const previous = document.activeElement; dialog.current.showModal();
    return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  const patch = (key, value) => setValues(v => ({ ...v, [key]: value }));
  const models = catalogState.data?.models ?? [];
  const catalogKey = values.catalogKey || (models[0] ? `${models[0].modelId}@${models[0].version}` : '');
  const specification = models.find(m => `${m.modelId}@${m.version}` === catalogKey)?.specification;
  return <dialog ref={dialog} className="rack-add-dialog" aria-label={RACK_COMMANDS.find(c => c.commandId === kind)?.label} onCancel={event => { event.preventDefault(); onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); try { onApply({ ...values, catalogKey }); } catch (e) { setError(e.message); } }}>
      <header><h2>{kind === 'rack_add' ? 'Add rack' : kind === 'rack_device' ? 'Add equipment' : 'Add exclusion zone'}</h2><button type="button" aria-label="Close add dialog" onClick={onClose}>×</button></header>
      <p className="rack-muted">Add to this plan's shared draft, then check and choose Save layout to persist it. Cancel leaves the plan unchanged.</p>
      {kind === 'rack_device' ? <>
        {catalogState.pending ? <p role="status">Loading equipment catalog…</p> : catalogState.error ? <p role="alert">The equipment catalog is unavailable.<button type="button" onClick={catalogState.retry}>Retry catalog</button></p> : null}
        <label>Equipment model<select aria-label="Equipment model" required value={catalogKey} onChange={e => patch('catalogKey', e.target.value)}>{!models.length && <option value="">No models available</option>}{models.map(m => <option key={`${m.modelId}@${m.version}`} value={`${m.modelId}@${m.version}`}>{m.name} · v{m.version}</option>)}</select></label>
        <label>Equipment quantity<input type="number" required min="1" max="128" step="1" value={values.quantity} onChange={e => patch('quantity', e.target.value)}/></label>
        {specification && <p>{specification.heightU} U · {specification.powerKw ?? 'Unknown'} kW · {specification.weightKg ?? 'Unknown'} kg / device</p>}
        <p className="rack-muted">Equipment is added to unassigned inventory with its catalog version. Use the equipment page to assign racks and U slots automatically or manually.</p>
      </> : <>
        <label>{kind === 'rack_add' ? 'Rack name' : 'Exclusion zone name'}<input required maxLength="160" value={values.name} onChange={e => patch('name', e.target.value)}/></label>
        {kind === 'rack_add' && <label>Rack model<select required value={values.modelId} onChange={e => patch('modelId', e.target.value)}>{layout.models.map(m => <option key={m.modelId} value={m.modelId}>{m.name} · {m.heightU} U · {m.widthM} × {m.depthM} m</option>)}</select></label>}
        <div className="rack-form-fields">{['xM', 'yM', ...(kind === 'rack_zone' ? ['widthM', 'depthM'] : [])].map(key => <label key={key}>{({xM:'Center X (m)', yM:'Center Y (m)', widthM:'Width (m)', depthM:'Depth (m)'})[key]}<input type="number" required step="0.01" min={['widthM', 'depthM'].includes(key) ? '0.01' : '-10000'} max="10000" value={values[key]} onChange={e => patch(key, e.target.value)}/></label>)}</div>
        {kind === 'rack_add' && <label>Orientation<select value={values.rotationDeg} onChange={e => patch('rotationDeg', e.target.value)}>{[0,90,180,270].map(deg => <option key={deg} value={deg}>{deg}°</option>)}</select></label>}
        <p className="rack-muted">Coordinates are in the room's local metric system. Initial positions are proposals; the backend checks boundaries, overlaps and maintenance clearances.</p>
      </>}
      {(error || blockedReason) && <p role="alert" className="rack-error">{blockedReason || error}</p>}
      <footer className="rack-actions"><button type="button" onClick={onClose}>Cancel</button><button className="rack-primary" disabled={Boolean(blockedReason) || (kind === 'rack_device' && !catalogKey)}>Add to draft</button></footer>
    </form>
  </dialog>;
}
