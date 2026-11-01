import { useEffect, useState } from 'react';
const fields=[['maxWeightKg','Weight limit (kg)'],['maxPowerKw','Power limit (kW)'],['maxCoolingKw','Cooling limit (kW)']];
export function RackCapacityLimits({rack,model,limit,editable,onConfirm}) {
  const initial=()=>({enabled:Boolean(limit),values:Object.fromEntries(fields.map(([key])=>[key,limit ? (limit[key]??'') : (model?.[key]??'')]))});
  const [input,setInput]=useState(initial),[error,setError]=useState(null);
  const current=JSON.stringify([limit??null,model?.maxWeightKg??null,model?.maxPowerKw??null,model?.maxCoolingKw??null]);
  useEffect(()=>{setInput(initial());setError(null);},[rack.rackId,current]);
  return <fieldset className="rack-catalog-picker"><legend>Plan-assumed capacity limits</legend>
    <label className="rack-lock-field"><input type="checkbox" checked={input.enabled} disabled={!editable} onChange={e=>{setInput({...input,enabled:e.target.checked});setError(null);}}/>Use plan-assumed capacity limits</label>
    {input.enabled && <div className="rack-form-fields">{fields.map(([key,label])=><label key={key}>{label}<input type="number" min="0" max="1000000" step="any" placeholder="Unknown" value={input.values[key]} disabled={!editable} onChange={e=>{setInput({...input,values:{...input.values,[key]:e.target.value}});setError(null);}}/></label>)}</div>}
    <button type="button" disabled={!editable} onClick={()=>{
      if(!editable)return;
      try {
        const result=input.enabled?{rackId:rack.rackId}:null;
        if(result) for(const [key] of fields){const raw=input.values[key],value=String(raw).trim()===''?null:Number(raw);if(value!==null&&(!Number.isFinite(value)||value<0||value>1000000))throw new Error('Limits must be from 0 to 1000000; blank means unknown.');result[key]=value;}
        onConfirm(result);setError('Capacity limits confirmed in the draft. Save layout to persist.');
      } catch(e){setError(e.message);}
    }}>Confirm capacity limits</button>
    {error && <p role="status">{error}</p>}
    <p className="rack-muted">Click Confirm to apply these inputs to the shared draft, then Save layout. Unconfirmed edits are not saved. Position lock does not prevent capacity edits. Limits are planning assumptions.</p>
  </fieldset>;
}
