import { rackLoadDisplay } from './floorplan-load.js';
import { deviceKind } from './workbench-view.js';

const number = value => Number.isFinite(value) ? Number(value.toFixed(3)) : '?';
export function capacityLabel(summary, key, unit) {
  const capacity = summary?.capacities[key];
  if (!capacity) return 'Not checked';
  return `${capacity.total === null ? '≥' + number(capacity.knownSubtotal) : number(capacity.total)} / ${number(capacity.limit)} ${unit}${capacity.status === 'UNKNOWN' ? ' · Unknown' : capacity.status === 'EXCEEDED' ? ' · Exceeded' : ''}`;
}

/** Schematic views share object IDs/selection; they never write physical positions. */
export function RackElevations({ placements, models, devices, selectedId, selectedDeviceId, report, onSelect, onDevice }) {
  return <div className="rack-elevation-gallery" aria-label="All rack elevations">
    <p className="rack-view-explainer">Rack front elevations · U1 is at the bottom · Select equipment for details; ordering is for display only.</p>
    <div className="rack-elevation-cards">{placements.map(rack => {
      const model = models.find(m => m.modelId === rack.modelId);
      const members = devices.filter(d => d.rackId === rack.rackId);
      const supported = Number.isInteger(model?.heightU) && model.heightU > 0 && model.heightU <= 100;
      return <article key={rack.rackId} className={`rack-elevation-card${selectedId === rack.rackId ? ' is-selected' : ''}`}>
        <button className="rack-elevation-heading" onClick={() => onSelect(rack.rackId)} aria-pressed={selectedId === rack.rackId}>{rack.name}<small>{model?.heightU ?? '?'} U · {members.length} devices</small></button>
        {supported ? <div className="rack-gallery-cabinet" style={{'--rack-units':model.heightU}}>
          <span className="rack-gallery-top">U{model.heightU}</span><span className="rack-gallery-bottom">U1</span>
          {members.filter(d => Number.isInteger(d.startU) && Number.isInteger(d.heightU)).map(d => <button key={d.deviceId} data-kind={deviceKind(d)[1]}
            aria-label={`View equipment ${d.name}`} aria-pressed={selectedDeviceId === d.deviceId}
            style={{bottom:`${(d.startU - 1) / model.heightU * 100}%`,height:`${d.heightU / model.heightU * 100}%`}}
            title={`${d.name} · U${d.startU}–${d.startU + d.heightU - 1}`} onClick={() => onDevice(d.deviceId)}>{d.name}<small>U{d.startU}–{d.startU + d.heightU - 1}</small></button>)}
        </div> : <p>An elevation is not available for this model.</p>}
        <p className="rack-muted">{rackLoadDisplay('power',rack.rackId,report).label}</p>
      </article>;
    })}</div>
    {!placements.length && <p>No racks yet. Choose Add rack or Auto design in the toolbar to start.</p>}
  </div>;
}

export function RackCapacityTable({ placements, devices, report, selectedId, onSelect }) {
  return <div className="rack-capacity-view" aria-label="Rack capacity table">
    <p className="rack-view-explainer">Based on backend checks of the current draft · “?” means an unknown limit; “≥” is the known demand subtotal. Select a name for details.</p>
    <table><thead><tr><th>Rack / Position</th><th>Equipment</th><th>U slots</th><th>Weight</th><th>Power</th><th>Cooling</th></tr></thead><tbody>
      {placements.map(rack => { const summary = report?.racks.find(r => r.rackId === rack.rackId);
        return <tr key={rack.rackId} className={selectedId === rack.rackId ? 'is-selected' : ''}><th><button aria-pressed={selectedId === rack.rackId} onClick={() => onSelect(rack.rackId)}>{rack.name}</button><small>{number(rack.xM)}, {number(rack.yM)} m · {rack.rotationDeg}°</small></th>
          <td>{devices.filter(d => d.rackId === rack.rackId).length}</td><td>{summary ? `${summary.occupiedU} / ${summary.heightU} U${summary.uStatus === 'ISSUES_FOUND' ? ' · Conflict' : ''}` : 'Not checked'}</td>
          <td>{capacityLabel(summary,'weightKg','kg')}</td><td>{capacityLabel(summary,'powerKw','kW')}</td><td>{capacityLabel(summary,'coolingKw','kW')}</td></tr>;
      })}
    </tbody></table>{!placements.length && <p>No racks yet.</p>}
  </div>;
}
