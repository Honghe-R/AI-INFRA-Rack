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
    catch(e){if(signal.aborted)return;if(!uncertainCreation(e))onAttempt(null);setError(`${uncertainCreation(e)?'结果尚未确认，请重试原操作；不要重复新建请求。 ':''}${rackError(e)}`);}
    finally{sending.current=false;if(!signal.aborted)setBusy(false);}
  }
  const operation=attempt?.operation??form;
  return <section className="rack-plan-actions" aria-label="方案管理">
    {!operation?<div className="rack-actions">{plan.deletedAt?<button disabled={blocked} onClick={()=>setForm('restore')}>恢复方案</button>:<>
      <button disabled={blocked} onClick={()=>{setName(plan.name);setForm('rename');}}>重命名方案</button>
      <button className="rack-danger" disabled={blocked} onClick={()=>setForm('delete')}>删除方案</button></>}
      {blocked&&<span className="rack-muted">请先保存或放弃编辑草稿，再管理方案。</span>}</div>:<form onSubmit={apply}>
      <h3>{operation==='rename'?'重命名方案':operation==='delete'?'删除此方案？':'恢复此方案？'}</h3>
      {operation==='rename'?<label>方案名称<input required maxLength={160} value={attempt?.body.name??name} disabled={busy||Boolean(attempt)} onChange={e=>setName(e.target.value)}/></label>:
        <p>{operation==='delete'?`“${plan.name}”及其 ${plan.placements.length} 个机柜会移入已删除方案，布局、设备和约束均可恢复。`:'恢复后返回正常列表，原布局、设备和约束保留；来源变化仍需按原规则处理。'}</p>}
      <div className="rack-actions"><button className="rack-primary" disabled={busy||blocked||(operation==='rename'&&!name.trim())}>
        {busy?'处理中…':attempt?'重试原操作':operation==='rename'?'保存名称':operation==='delete'?'确认删除方案':'确认恢复方案'}</button>
        <button type="button" disabled={busy||Boolean(attempt)} onClick={()=>{setForm(null);setError(null);}}>取消</button></div>
    </form>}
    {error&&<p role="alert" className="rack-error">{error}</p>}
  </section>;
}
