import { useEffect, useRef, useState } from 'react';
import { RackWorkbench } from './RackWorkbench.jsx';
import { rackError } from './rack-plan-state.js';
import { optionStageReason, stageRackOption } from './rack-options-state.js';

const labels = {'demand-first-fit-v1':'Input order · First Fit baseline','demand-dominant-best-fit-v1':'Dominant resource descending · Best Fit heuristic'};
const fmt=n=>Number(n.toFixed(3)).toLocaleString();
export function designDemandBody(layout, values) {
  const {quantities,models,rackModelId,maxRacks,limits,frontM,rearM,gapM,sourceReference,budgetEnabled,budget}=values;
  return {contract_version:1,base_version:layout.version,snapshot_id:layout.snapshot.snapshotId,demand:{
    groups:models.filter(m=>Number(quantities[m.modelId]??0)>0).map(m=>({modelId:m.modelId,version:m.version,quantity:Number(quantities[m.modelId])})),
    rackModelId,maxRacks:Number(maxRacks),rackLimits:Object.fromEntries(Object.entries(limits).map(([k,v])=>[k,v===''?null:Number(v)])),
    gapM:Number(gapM),sourceReference,constraints:{...layout.constraints,source:{kind:'ASSUMED',reference:sourceReference},clearance:{frontM:Number(frontM),rearM:Number(rearM)}},
    ...(budgetEnabled?{roomBudget:{source:{kind:'ASSUMED',reference:sourceReference},maxPowerKw:budget.maxPowerKw===''?null:Number(budget.maxPowerKw),maxCoolingKw:budget.maxCoolingKw===''?null:Number(budget.maxCoolingKw)}}:{})}};
}

export function RackDemandDesign({client,layout,catalogState,draft,canWrite,onDraftChange,onNavigate}) {
  const [quantities,setQuantities]=useState({}),[rackModelId,setRackModelId]=useState(layout.models[0]?.modelId??'');
  const [maxRacks,setMaxRacks]=useState(16),[limits,setLimits]=useState({maxWeightKg:'',maxPowerKw:'',maxCoolingKw:''});
  const [frontM,setFrontM]=useState(layout.constraints.clearance?.frontM??1),[rearM,setRearM]=useState(layout.constraints.clearance?.rearM??.6),[gapM,setGapM]=useState(.2);
  const [sourceReference,setSource]=useState('Course planning assumption; verify before deployment.');
  const [budgetEnabled,setBudgetEnabled]=useState(false),[budget,setBudget]=useState({maxPowerKw:'',maxCoolingKw:''});
  const [result,setResult]=useState(null),[index,setIndex]=useState(0),[confirmed,setConfirmed]=useState(false);
  const [pending,setPending]=useState(false),[error,setError]=useState(null),[selectedId,setSelectedId]=useState(null);
  const controller=useRef(null);
  useEffect(()=>{controller.current?.abort();setPending(false);setResult(null);setError(null);setConfirmed(false);
    return()=>controller.current?.abort();},[layout.projectId,layout.planId,layout.version,layout.snapshot.snapshotId]);
  const models=catalogState.data?.models??[],option=result?.candidates[index];
  const nonempty=layout.placements.length>0 || layout.equipment.devices.length>0 || layout.equipment.rackLimits.length>0;
  const total=models.reduce((n,m)=>n+Number(quantities[m.modelId]??0),0);
  const guards={canWrite,draft,confirmed},reason=optionStageReason(layout,result,option,guards);
  function changed(update){update();controller.current?.abort();setPending(false);setResult(null);setConfirmed(false);setError(null);}
  async function generate(event) {
    event.preventDefault();if(pending||draft||nonempty||layout.sourceStatus.status!=='UNCHANGED')return;
    const abort=new AbortController();controller.current?.abort();controller.current=abort;
    setPending(true);setError(null);setResult(null);setConfirmed(false);setSelectedId(null);
    try {const response=await client.generateRackDesignOptions(layout.projectId,layout.planId,designDemandBody(layout,
      {quantities,models,rackModelId,maxRacks,limits,frontM,rearM,gapM,sourceReference,budgetEnabled,budget}),{signal:abort.signal});
      if(!abort.signal.aborted){setResult(response.data);setIndex(0);}}
    catch(e){if(!abort.signal.aborted)setError(rackError(e));}
    finally{if(!abort.signal.aborted)setPending(false);}
  }
  return <section className="rack-demand-design" aria-label="Auto design from equipment quantities">
    <h3>Auto design from equipment quantities</h3>
    <p>Enter server and switch quantities and constraints to calculate rack requirements, allocate contiguous U slots and generate compact layout candidates. Use an empty plan; candidates are previews until staged and saved.</p>
    {nonempty?<p className="rack-muted">This plan already contains racks or inventory. Create an empty plan for quantity-based design, or use layout rearrangement below and automatic allocation on the equipment page.</p>:<>
      {catalogState.pending?<p role="status">Loading equipment catalog…</p>:catalogState.error?<p role="alert">{rackError(catalogState.error)} <button onClick={catalogState.retry}>Retry catalog</button></p>:
      <form onSubmit={generate} className="rack-card">
        <fieldset disabled={pending}><legend>Equipment demand · Synthetic catalog specifications</legend>
          <div className="rack-table-scroll"><table className="rack-input-table"><thead><tr><th>Model / Version</th><th>Per device: U / kg / kW / cooling kW</th><th>Quantity</th></tr></thead><tbody>
            {models.map(m=><tr key={`${m.modelId}@${m.version}`}><td>{m.name} @{m.version}</td><td>{['heightU','weightKg','powerKw','coolingKw'].map(k=>m.specification[k]??'Unknown').join(' / ')}</td><td>
              <input aria-label={`${m.name} Quantity`} type="number" min="0" max="128" step="1" required value={quantities[m.modelId]??0}
                onChange={e=>changed(()=>setQuantities({...quantities,[m.modelId]:e.target.value}))}/></td></tr>)}
          </tbody></table></div>
          <p>Total: {total} devices; maximum 128. Unknown resources are not treated as zero. Unplaced equipment is retained with a reason.</p>
          <button type="button" onClick={()=>changed(()=>{setQuantities({'demo-gpu-4u':8,'demo-compute-2u':12,'demo-tor-1u':2});setLimits({maxWeightKg:800,maxPowerKw:12,maxCoolingKw:12});})}>Use course example parameters</button>
        </fieldset>
        <fieldset disabled={pending}><legend>Racks and constraints · Declared planning assumptions</legend><div className="rack-form-fields">
          <label>Rack model<select value={rackModelId} onChange={e=>changed(()=>setRackModelId(e.target.value))}>{layout.models.map(m=><option key={m.modelId} value={m.modelId}>{m.name}</option>)}</select></label>
          <label>Maximum racks<input type="number" required min="1" max="32" step="1" value={maxRacks} onChange={e=>changed(()=>setMaxRacks(e.target.value))}/></label>
          {Object.entries({maxWeightKg:'Rack weight limit (kg)',maxPowerKw:'Rack power limit (kW)',maxCoolingKw:'Rack cooling limit (kW)'}).map(([key,title])=><label key={key}>{title}<input type="number" required min="0" max="1000000" step="any" value={limits[key]} placeholder="Enter a confirmed planning assumption" onChange={e=>changed(()=>setLimits({...limits,[key]:e.target.value}))}/></label>)}
          <label>Front maintenance clearance (m)<input type="number" required min="0" max="10" step="0.001" value={frontM} onChange={e=>changed(()=>setFrontM(e.target.value))}/></label>
          <label>Rear maintenance clearance (m)<input type="number" required min="0" max="10" step="0.001" value={rearM} onChange={e=>changed(()=>setRearM(e.target.value))}/></label>
          <label>Additional rack spacing (m)<input type="number" required min="0" max="5" step="0.001" value={gapM} onChange={e=>changed(()=>setGapM(e.target.value))}/></label>
          <label>Assumption source<input required maxLength="512" value={sourceReference} onChange={e=>changed(()=>setSource(e.target.value))}/></label>
        </div><p>Retains the saved {layout.constraints.obstacles.length} exclusion zones and their coverage declaration. Configure and save zones on the constraints page before generating candidates. Maintenance clearances do not verify evacuation routes.</p>
          <label><input type="checkbox" checked={budgetEnabled} onChange={e=>changed(()=>setBudgetEnabled(e.target.checked))}/>Declare a room power/cooling budget for this design</label>
          {budgetEnabled?<div className="rack-form-fields">{Object.entries({maxPowerKw:'Room power budget (kW)',maxCoolingKw:'Room cooling budget (kW)'}).map(([key,title])=><label key={key}>{title}<input type="number" min="0" max="1000000" step="any" required value={budget[key]} onChange={e=>changed(()=>setBudget({...budget,[key]:e.target.value}))}/></label>)}</div>:
            <p className="rack-muted">{layout.equipment.roomBudget?'Use the saved room budget for this plan.':'No room budget is recorded. Only local capacity can be assessed; the budget status remains unknown.'}</p>}
        </fieldset>
        <button className="rack-primary" disabled={pending||Boolean(draft)||layout.sourceStatus.status!=='UNCHANGED'||!models.length||total<1||total>128}>{pending?'Computing candidates…':'Generate design candidates'}</button>
        {draft&&<p className="rack-warning">Save or discard the shared draft before generating candidates.</p>}
        {layout.sourceStatus.status!=='UNCHANGED'&&<p className="rack-warning">Facility inputs have changed. Review the source first.</p>}
        {pending&&<button type="button" onClick={()=>{controller.current?.abort();setPending(false);}}>Stop waiting</button>}
      </form>}
      {error&&<p role="alert" className="rack-error">{error}</p>}
      {result&&<>
        <p role="status">Generated {result.candidates.length} candidates · {result.elapsedMs} ms · Based on v{result.baseVersion} · Not saved</p>
        <p className="rack-muted">Candidates prioritize placing all equipment, then rack count and compactness. Bounded heuristic search does not guarantee a global optimum: at most 32 racks and 256 whole-layout proposals per strategy.</p>
        <div className="rack-table-scroll"><table className="rack-input-table"><caption>Design candidate comparison</caption><thead><tr><th>Strategy</th><th>Rack count</th><th>Placed / Requested</th><th>Rack envelope area (m²)</th><th>Unmet items</th><th>Local checks</th></tr></thead><tbody>
          {result.candidates.map((c,i)=><tr key={c.optionId}><td><button aria-pressed={index===i} onClick={()=>{setIndex(i);setSelectedId(null);setConfirmed(false);}}>{labels[c.algorithmId]}</button></td><td>{c.metrics.rackCount}</td><td>{c.metrics.assignedDevices} / {c.metrics.requestedDevices}</td><td>{fmt(c.metrics.envelopeAreaM2)}</td><td>{c.unplaced.length}</td><td>{c.report.status} / {c.equipmentReport.status}</td></tr>)}
        </tbody></table></div>
        {option&&<>
          <h4>{labels[option.algorithmId]} · Preview</h4>
          {option.unplaced.length>0&&<ul className="rack-warning">{option.unplaced.map((u,i)=><li key={i}>{u.deviceId&&`${option.body.equipment.devices.find(d=>d.deviceId===u.deviceId)?.name}: `}{u.code} · {u.message}</li>)}</ul>}
          <RackWorkbench key={option.optionId} snapshot={layout.snapshot} placements={option.placements} models={layout.models} constraints={option.body.constraints}
            equipment={option.body.equipment} report={option.report} equipmentReport={option.equipmentReport} selectedId={selectedId} onSelect={setSelectedId}
            editable={false} isPositionLocked={id=>option.placements.some(p=>p.rackId===id&&p.locked)}
            feedback="Read-only candidate: select racks or equipment for details. Stage as a draft to adjust the layout."/>
          <p>Space: {option.report.status} · Equipment: {option.equipmentReport.status} · Room budget: {option.equipmentReport.roomCapacity?.status??'INCOMPLETE'} · Overall validation: NOT_RUN</p>
          <ul>{[...option.report.diagnostics,...option.equipmentReport.diagnostics].map((d,i)=><li key={i}>{d.code}: {d.message}</li>)}</ul>
          <details><summary>Unchecked scope and assumptions</summary><p>{option.report.uncheckedRules.join(', ')}</p><p>Equipment and capacities are synthetic assumptions. The room budget applies only to this plan and does not reserve capacity across plans.</p></details>
          <label className="rack-option-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I have reviewed the candidate, assumptions and check coverage</label>
          {reason&&<p className="rack-muted">{reason}</p>}
          <button className="rack-primary" disabled={Boolean(reason)} onClick={()=>{try{onDraftChange(stageRackOption(layout,result,option,guards));setConfirmed(false);onNavigate('layout');}catch(e){setError(e.message);}}}>Stage design as draft</button>
          <p className="rack-muted">Then choose Save layout. Saving rechecks permissions, versions, input sources, geometry and equipment capacity before an atomic write.</p>
        </>}
      </>}
    </>}
  </section>;
}
