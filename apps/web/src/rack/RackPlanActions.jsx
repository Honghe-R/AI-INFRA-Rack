import { useEffect, useRef, useState } from 'react';
import { rackError, uncertainCreation } from './rack-plan-state.js';

export function RackPlanActions({ client, plan, canWrite, blocked, attempt, onAttempt, onManaged }) {
  const [form,setForm]=useState(null),[name,setName]=useState(plan.name),[busy,setBusy]=useState(false),[error,setError]=useState(null);
  const sending=useRef(false), lifetime=useRef(null);
  useEffect(()=>{
    const controller=new AbortController();
    lifetime.current=controller;
    return ()=>controller.abort();
  },[]);
  if(!canWrite)return null;
  async function apply(event){
    event.preventDefault();if(sending.current||blocked)return;
    const intent=attempt??{planId:plan.planId,operation:form,key:crypto.randomUUID(),version:plan.version,
      body:{contract_version:1,...(form==='rename'?{name:name.trim()}:{})}};
    const signal=lifetime.current.signal;
    sending.current=true;onAttempt(intent);setBusy(true);setError(null);
    try {const result=await client.manageRackPlan(plan.projectId,intent.planId,intent.operation,intent.body,
      {version:intent.version,idempotencyKey:intent.key,signal});
      if(signal.aborted)return;
      setForm(null);onManaged(result.data,intent.operation);}
    catch(e){if(signal.aborted)return;if(!uncertainCreation(e))onAttempt(null);setError(`${uncertainCreation(e)?'The result is unconfirmed. Retry the original operation instead of creating another request. ':''}${rackError(e)}`);}
    finally{sending.current=false;if(!signal.aborted)setBusy(false);}
  }
  const operation=attempt?.operation??form;
  return <section className="rack-plan-actions" aria-label="Plan management">
    {!operation?<div className="rack-actions">{plan.deletedAt?<button disabled={blocked} onClick={()=>setForm('restore')}>Restore plan</button>:<>
      <button disabled={blocked} onClick={()=>{setName(plan.name);setForm('rename');}}>Rename plan</button>
      <button className="rack-danger" disabled={blocked} onClick={()=>setForm('delete')}>Delete plan</button></>}
      {blocked&&<span className="rack-muted">Save or discard the editing draft before managing this plan.</span>}</div>:<form onSubmit={apply}>
      <h3>{operation==='rename'?'Rename plan':operation==='delete'?'Delete this plan?':'Restore this plan?'}</h3>
      {operation==='rename'?<label>Plan name<input required maxLength={160} value={attempt?.body.name??name} disabled={busy||Boolean(attempt)} onChange={e=>setName(e.target.value)}/></label>:
        <p>{operation==='delete'?`“${plan.name}” and its ${plan.placements.length} racks will move to Deleted plans. The layout, equipment and constraints can be restored.`:'Restore this plan to the active list with its layout, equipment and constraints. Source changes still require review under the existing rules.'}</p>}
      <div className="rack-actions"><button className="rack-primary" disabled={busy||blocked||(operation==='rename'&&!name.trim())}>
        {busy?'Working…':attempt?'Retry original operation':operation==='rename'?'Save name':operation==='delete'?'Confirm plan deletion':'Confirm plan restoration'}</button>
        <button type="button" disabled={busy||Boolean(attempt)} onClick={()=>{setForm(null);setError(null);}}>Cancel</button></div>
    </form>}
    {error&&<p role="alert" className="rack-error">{error}</p>}
  </section>;
}
