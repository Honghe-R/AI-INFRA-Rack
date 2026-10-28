import { useEffect, useRef, useState } from 'react';
import { RackElevation } from './RackEquipment.jsx';
import { optionStageReason, stageRackOption } from './rack-options-state.js';
import { rackError } from './rack-plan-state.js';

const reasons = {
  UNKNOWN_DEVICE_RESOURCE: 'Device weight, power or cooling demand is unknown.',
  NO_UNLOCKED_RACK: 'There are no unlocked target racks.',
  NO_ELIGIBLE_POSITION: 'No checked target fits this device under this greedy search.',
  NO_CONTIGUOUS_U: 'No continuous U-slot range', UNKNOWN_RACK_CAPACITY: 'Unknown rack limit or installed demand', CAPACITY_EXCEEDED: 'Declared resource limit would be exceeded',
};
export function RackAllocation({ client, layout, draft, canWrite, onDraftChange }) {
  const [result, setResult] = useState(null), [pending, setPending] = useState(false), [error, setError] = useState(null);
  const [confirmed, setConfirmed] = useState(false), [rackId, setRackId] = useState('');
  const request = useRef(null);
  useEffect(() => {
    request.current?.abort(); setResult(null); setPending(false); setConfirmed(false); setError(null); setRackId('');
    return () => request.current?.abort();
  }, [layout]);
  const candidate = result?.candidates[0];
  const optionReason = optionStageReason(layout, result, candidate, { canWrite, draft, confirmed });
  const unassigned = layout.equipment.devices.filter(d => d.rackId === null).length;
  const selected = layout.placements.find(p => p.rackId === rackId);
  const name = id => layout.equipment.devices.find(d => d.deviceId === id)?.name ?? id;
  const rackName = id => layout.placements.find(p => p.rackId === id)?.name ?? id;
  const resource = value => `${value.total === null ? 'Unknown' : Number(value.total.toFixed(4))} / ${value.limit === null ? 'Unknown' : value.limit} ${value.unit} (${value.status})`;
  async function generate() {
    if (pending || draft || layout.sourceStatus.status !== 'UNCHANGED' || !unassigned) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setPending(true); setError(null); setResult(null); setConfirmed(false);
    try {
      const response = await client.generateRackEquipmentOption(layout.projectId, layout.planId, {
        contract_version: 1, base_version: layout.version, snapshot_id: layout.snapshot.snapshotId,
      }, { signal: controller.signal });
      if (!controller.signal.aborted) { setResult(response.data); setRackId(response.data.candidates[0]?.assignments[0]?.rackId ?? layout.placements[0]?.rackId ?? ''); }
    } catch (e) { if (!controller.signal.aborted) setError(rackError(e)); }
    finally { if (!controller.signal.aborted) setPending(false); }
  }
  return <section className="rack-card" aria-label="Automatic device allocation">
    <h3>Auto-allocate unassigned devices</h3>
    <p>Largest U-height first, then first fitting rack and lowest continuous U range. Existing assignments and all rack positions stay fixed; locked racks are excluded as targets.</p>
    <p className="rack-muted">Known weight, power and cooling demand and limits are required. Unknown data is not treated as zero or unlimited. Uses saved data only; at most 128 unassigned devices, 64 unlocked racks and 100 U per rack. This is a greedy suggestion, not an optimality or feasibility proof.</p>
    <p>{unassigned} unassigned in saved v{layout.version}. Enter device demands and per-rack capacity assumptions below, then save before generating.</p>
    <button className="rack-primary" onClick={generate} disabled={pending || Boolean(draft) || !unassigned || layout.sourceStatus.status !== 'UNCHANGED'}>{pending ? 'Allocating…' : 'Generate device allocation'}</button>
    {draft && <p className="rack-warning">Save or discard the shared draft first. Automatic allocation will not overwrite local edits.</p>}
    {error && <p role="alert" className="rack-error">{error}</p>}
    {candidate && <>
      <p role="status">Preview only · {candidate.metrics.assignedDevices} newly assigned · {candidate.metrics.remainingUnassigned} remain unassigned · {candidate.metrics.excludedLockedRacks} locked racks excluded. No data saved.</p>
      <div className="rack-table-scroll"><table className="rack-input-table"><caption>Proposed assignments</caption>
        <thead><tr><th>Device</th><th>Target rack</th><th>U range</th></tr></thead><tbody>{candidate.assignments.map(a => <tr key={a.deviceId}><td>{name(a.deviceId)}</td><td>{rackName(a.rackId)}</td><td>U{a.startU}–U{a.endU}</td></tr>)}</tbody></table></div>
      <div className="rack-table-scroll"><table className="rack-input-table"><caption>Capacity after proposed allocation · declared assumptions</caption>
        <thead><tr><th>Rack</th><th>Free U before → after</th><th>Weight</th><th>Power</th><th>Cooling</th></tr></thead>
        <tbody>{candidate.equipmentReport.racks.map(r => <tr key={r.rackId}><td>{rackName(r.rackId)}</td>
          <td>{result.baseline.equipmentReport.racks.find(b => b.rackId === r.rackId)?.freeU} → {r.freeU}</td>
          <td>{resource(r.capacities.weightKg)}</td><td>{resource(r.capacities.powerKw)}</td><td>{resource(r.capacities.coolingKw)}</td></tr>)}</tbody></table></div>
      {candidate.unassigned.length > 0 && <details open><summary>Unassigned devices and reasons · {candidate.unassigned.length}</summary><ul>{candidate.unassigned.map(d => <li key={d.deviceId}>
        <strong>{name(d.deviceId)}</strong>: {reasons[d.code] ?? d.code}
        {d.unknownDimensions?.length > 0 && ` (${d.unknownDimensions.join(', ')})`}
        {Object.entries(d.rejectionCounts ?? {}).map(([code,count]) => <span key={code}> · {reasons[code] ?? code}: {count} rack(s)</span>)}
      </li>)}</ul></details>}
      <label>Allocation preview rack<select value={rackId} onChange={e => setRackId(e.target.value)}>{layout.placements.map(p => <option key={p.rackId} value={p.rackId}>{p.name}</option>)}</select></label>
      {selected && <RackElevation rack={selected} model={layout.models.find(m => m.modelId === selected.modelId)}
        devices={candidate.body.equipment.devices.filter(d => d.rackId === rackId)} readOnly />}
      <p>Spatial checks: {candidate.report.status} · Equipment: {candidate.equipmentReport.status} · Whole-plan validation: NOT_RUN.</p>
      {(candidate.report.diagnostics.length > 0 || candidate.equipmentReport.diagnostics.length > 0) && <ul>{[...candidate.report.diagnostics,...candidate.equipmentReport.diagnostics].map((d,i) => <li key={i}>{d.code}: {d.message}</li>)}</ul>}
      <p className="rack-muted">Unrecorded geometry, physical compatibility, redundant power feeds, airflow and floor loads are not certified by this allocation. Partial results retain all remaining devices in inventory.</p>
      <label className="rack-option-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I reviewed the U-slot preview, capacity checks and any devices still unassigned.</label>
      {optionReason && <p className="rack-muted">{candidate.metrics.assignedDevices === 0 ? 'No devices can be assigned from these inputs. Complete the missing data or adjust constraints first.' : optionReason}</p>}
      <button disabled={Boolean(optionReason)} onClick={() => {
        try { onDraftChange(stageRackOption(layout, result, candidate, { canWrite, draft, confirmed })); setConfirmed(false); }
        catch (e) { setError(e.message); }
      }}>Use allocation as draft</button>
      <p className="rack-muted">Review the shared draft, then Save layout. The existing version, permissions, source freshness and full checks are enforced again in the original atomic save.</p>
    </>}
  </section>;
}
