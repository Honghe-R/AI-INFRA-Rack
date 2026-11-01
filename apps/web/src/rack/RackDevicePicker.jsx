import { useState } from 'react';
import { createDeviceBatch, DEFAULT_CUSTOM_DEVICE } from './device-batch.js';
import { MAX_EQUIPMENT_DEVICES } from './limits.generated.js';
export function CustomDeviceFields({values, onChange, disabled=false}) {
  return <fieldset className="rack-catalog-picker"><legend>Custom device assumptions</legend>
    <label>Device type<select value={values.kind} disabled={disabled} onChange={e=>onChange({...values,kind:e.target.value})}>
      <option value="server">Server</option><option value="switch">Switch</option><option value="gpu">GPU server</option><option value="other">Other equipment</option></select></label>
    <label>Name prefix (optional)<input value={values.namePrefix} maxLength={100} disabled={disabled} onChange={e=>onChange({...values,namePrefix:e.target.value})}/></label>
    <div className="rack-form-fields">{[['heightU','Height (U)'],['weightKg','Weight (kg)'],['powerKw','Power (kW)'],['coolingKw','Cooling (kW)']].map(([key,label])=><label key={key}>{label}<input type="number" min={key==='heightU'?1:0} max={key==='heightU'?100:1000000} step={key==='heightU'?1:'any'} required={key==='heightU'} placeholder="Unknown" value={values[key]} disabled={disabled} onChange={e=>onChange({...values,[key]:e.target.value})}/></label>)}</div>
    <p className="rack-muted">ASSUMED · Blank demand means unknown; 0 is explicit. Custom devices do not claim a catalog binding.</p>
  </fieldset>;
}
export function RackDevicePicker({catalogState, equipment, editable, onAdd}) {
  const [key,setKey]=useState(''),[quantity,setQuantity]=useState(1),[custom,setCustom]=useState({...DEFAULT_CUSTOM_DEVICE}),[error,setError]=useState(null);
  const models=catalogState?.data?.models??[];
  const selected=key || (models[0]?`${models[0].modelId}@${models[0].version}`:'custom');
  const model=models.find(m=>`${m.modelId}@${m.version}`===selected);
  return <fieldset className="rack-catalog-picker"><legend>Versioned equipment catalog</legend>
    {catalogState?.pending && <p role="status">Reading model specifications…</p>}
    {catalogState?.error && <p role="alert">Catalog could not be loaded. Custom device entry remains available. <button type="button" onClick={catalogState.retry}>Retry catalog</button></p>}
    <label>Equipment model<select value={selected} disabled={!editable} onChange={e=>{setKey(e.target.value);setError(null);}}>
      {models.map(m=><option key={`${m.modelId}@${m.version}`} value={`${m.modelId}@${m.version}`}>{m.name} · v{m.version}</option>)}<option value="custom">Custom</option></select></label>
    {selected==='custom' ? <CustomDeviceFields values={custom} onChange={setCustom} disabled={!editable}/> : model && <p className="rack-muted">ASSUMED · {model.specification.heightU} U · {model.specification.weightKg??'Unknown'} kg · {model.specification.powerKw??'Unknown'} kW power · {model.specification.coolingKw??'Unknown'} kW cooling. Unknown values stay unknown.</p>}
    <label>Equipment quantity<input type="number" min="1" max="128" step="1" value={quantity} disabled={!editable} onChange={e=>setQuantity(e.target.value)}/></label>
    <button type="button" disabled={!editable || equipment.devices.length>=MAX_EQUIPMENT_DEVICES} onClick={()=>{
      if(!editable)return;
      try {const devices=createDeviceBatch(equipment.devices,{quantity,catalogModel:model,custom:selected==='custom'?custom:null});onAdd(devices);setError(null);}catch(e){setError(e.message);}
    }}>{selected==='custom'?'Add custom devices':'Add from catalog'}</button>
    {error && <p role="alert" className="rack-error">{error}</p>}
    <p className="rack-muted">Adds unassigned devices to this draft. Use automatic allocation or choose racks and U slots, then Save layout.</p>
  </fieldset>;
}
