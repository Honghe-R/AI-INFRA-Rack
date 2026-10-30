import { RackElevation } from './RackEquipment.jsx';
import { rackLoadDisplay } from './floorplan-load.js';

const kinds = [ ['demo-gpu-4u','GPU servers'], ['demo-compute-2u','Compute servers'], ['demo-tor-1u','ToR switches'], ['demo-optical-2u','Optical switches'] ];
export function RackHallInventory({ placements, models, equipment, report, selectedId, onSelect, onNavigate }) {
  const selected = placements.find(p=>p.rackId===selectedId), devices = equipment.devices;
  const installed = devices.filter(d=>d.rackId!==null);
  const groups = new Map();
  for (const p of [...placements].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))) {
    const group = /^([A-Za-z]+)\d+$/.exec(p.name)?.[1] ?? 'Other';
    if (!groups.has(group)) groups.set(group,[]); groups.get(group).push(p);
  }
  return <section className="rack-card rack-hall-inventory" aria-label="Room equipment overview">
    <h3>Room equipment overview</h3>
    <p>{placements.length} racks · {installed.length} installed · {devices.length-installed.length} unassigned · {placements.filter(p=>p.locked).length} locked racks</p>
    <p className="rack-muted">The floorplan shows racks containing servers and switches. Select a rack to inspect its installed equipment. Network connections are not shown.</p>
    <p>Equipment counts by model (including unassigned devices)</p>
    <ul className="rack-hall-kinds">{kinds.map(([key,label]) => <li key={key}>{label}: {devices.filter(d=>d.catalogRef?.modelId===key).length}</li>)}
      <li>Other / Custom: {devices.filter(d=>!kinds.some(([key])=>key===d.catalogRef?.modelId)).length}</li></ul>
    <p className="rack-muted">Grouped by rack name prefix for browsing; these are not spatial zones or network topology. Counts show installed devices; colors show current power check results.</p>
    {[...groups].map(([group,racks])=><div className="rack-hall-row" key={group}>
      <strong>{group} group</strong><div className="rack-hall-racks">{racks.map(p=>{
        const load = rackLoadDisplay('power',p.rackId,report), count = installed.filter(d=>d.rackId===p.rackId).length;
        return <button key={p.rackId} aria-pressed={selectedId===p.rackId} aria-label={`View rack ${p.name}, ${count} devices`}
          data-load={load.tone} title={`${p.name} · ${load.label}${p.locked?' · Locked':''}`} onClick={()=>onSelect(p.rackId)}>
          <strong>{p.name}</strong><span>{count} devices{p.locked?' · Locked':''}</span></button>;
      })}</div>
    </div>)}
    {selected ? <div className="rack-hall-selected">
      <h4>{selected.name} · Installed equipment</h4>
      <p>{rackLoadDisplay('power',selected.rackId,report).label} · {selected.locked?'Rack position locked':'Rack position editable'}</p>
      <div className="rack-actions"><button onClick={()=>onNavigate('equipment')}>Manage equipment and U slots</button><button onClick={()=>onNavigate('capacity')}>View capacity and budgets</button></div>
      <RackElevation rack={selected} model={models.find(m=>m.modelId===selected.modelId)} devices={installed.filter(d=>d.rackId===selectedId)} readOnly />
    </div> : <p>Select a rack on the canvas or above to inspect its U slots and equipment.</p>}
    <p className="rack-muted">Aisle reservations shown as exclusion zones only prevent rack and maintenance-band intrusion. Aisle connectivity, evacuation and airflow remain unchecked.</p>
  </section>;
}
