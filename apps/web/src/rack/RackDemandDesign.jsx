import { useEffect, useRef, useState } from 'react';
import { RackWorkbench } from './RackWorkbench.jsx';
import { rackError } from './rack-plan-state.js';
import { optionStageReason, stageRackOption } from './rack-options-state.js';

const labels = {'demand-first-fit-v1':'输入顺序 · First Fit 基线','demand-dominant-best-fit-v1':'资源占比降序 · Best Fit 启发式'};
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
  const [sourceReference,setSource]=useState('课程规划假设，需在实际部署前核实。');
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
  return <section className="rack-demand-design" aria-label="按设备数量自动设计">
    <h3>按设备数量自动设计</h3>
    <p>输入服务器、交换机数量与约束，自动计算所需机柜、安排连续 U 位，再生成紧凑布局候选。适用于空方案；生成只预览，采用后仍需保存。</p>
    {nonempty?<p className="rack-muted">此方案已有机柜或库存。请新建空方案使用数量规划；调整已有方案可使用下方重排和设备页自动上架。</p>:<>
      {catalogState.pending?<p role="status">正在读取设备目录…</p>:catalogState.error?<p role="alert">{rackError(catalogState.error)} <button onClick={catalogState.retry}>重试目录</button></p>:
      <form onSubmit={generate} className="rack-card">
        <fieldset disabled={pending}><legend>设备需求 · 合成目录规格</legend>
          <div className="rack-table-scroll"><table className="rack-input-table"><thead><tr><th>型号 / 版本</th><th>每台 U / kg / kW / 冷却 kW</th><th>数量</th></tr></thead><tbody>
            {models.map(m=><tr key={`${m.modelId}@${m.version}`}><td>{m.name} @{m.version}</td><td>{['heightU','weightKg','powerKw','coolingKw'].map(k=>m.specification[k]??'未知').join(' / ')}</td><td>
              <input aria-label={`${m.name} 数量`} type="number" min="0" max="128" step="1" required value={quantities[m.modelId]??0}
                onChange={e=>changed(()=>setQuantities({...quantities,[m.modelId]:e.target.value}))}/></td></tr>)}
          </tbody></table></div>
          <p>共 {total} 台，最多 128 台。未知资源不会按零处理，无法安排的设备会保留并说明原因。</p>
          <button type="button" onClick={()=>changed(()=>{setQuantities({'demo-gpu-4u':8,'demo-compute-2u':12,'demo-tor-1u':2});setLimits({maxWeightKg:800,maxPowerKw:12,maxCoolingKw:12});})}>填入课程示例参数</button>
        </fieldset>
        <fieldset disabled={pending}><legend>机柜与约束 · 显式规划假设</legend><div className="rack-form-fields">
          <label>机柜型号<select value={rackModelId} onChange={e=>changed(()=>setRackModelId(e.target.value))}>{layout.models.map(m=><option key={m.modelId} value={m.modelId}>{m.name}</option>)}</select></label>
          <label>最多机柜数<input type="number" required min="1" max="32" step="1" value={maxRacks} onChange={e=>changed(()=>setMaxRacks(e.target.value))}/></label>
          {Object.entries({maxWeightKg:'单柜重量上限 (kg)',maxPowerKw:'单柜功率上限 (kW)',maxCoolingKw:'单柜冷却上限 (kW)'}).map(([key,title])=><label key={key}>{title}<input type="number" required min="0" max="1000000" step="any" value={limits[key]} placeholder="填写已确认的规划假设" onChange={e=>changed(()=>setLimits({...limits,[key]:e.target.value}))}/></label>)}
          <label>正面维护净距 (m)<input type="number" required min="0" max="10" step="0.001" value={frontM} onChange={e=>changed(()=>setFrontM(e.target.value))}/></label>
          <label>背面维护净距 (m)<input type="number" required min="0" max="10" step="0.001" value={rearM} onChange={e=>changed(()=>setRearM(e.target.value))}/></label>
          <label>额外柜间距 (m)<input type="number" required min="0" max="5" step="0.001" value={gapM} onChange={e=>changed(()=>setGapM(e.target.value))}/></label>
          <label>假设来源<input required maxLength="512" value={sourceReference} onChange={e=>changed(()=>setSource(e.target.value))}/></label>
        </div><p>沿用已保存的 {layout.constraints.obstacles.length} 个禁放区及其完整性声明；先在约束页设置并保存可参与自动规划。维护净距不代表疏散通道已验证。</p>
          <label><input type="checkbox" checked={budgetEnabled} onChange={e=>changed(()=>setBudgetEnabled(e.target.checked))}/>为本次设计声明房间功率/冷却预算</label>
          {budgetEnabled?<div className="rack-form-fields">{Object.entries({maxPowerKw:'房间功率预算 (kW)',maxCoolingKw:'房间冷却预算 (kW)'}).map(([key,title])=><label key={key}>{title}<input type="number" min="0" max="1000000" step="any" required value={budget[key]} onChange={e=>changed(()=>setBudget({...budget,[key]:e.target.value}))}/></label>)}</div>:
            <p className="rack-muted">{layout.equipment.roomBudget?'沿用此方案已保存的房间预算。':'未记录房间预算：只能给出局部容量结果，预算状态仍为未知。'}</p>}
        </fieldset>
        <button className="rack-primary" disabled={pending||Boolean(draft)||layout.sourceStatus.status!=='UNCHANGED'||!models.length||total<1||total>128}>{pending?'正在计算候选…':'生成自动设计候选'}</button>
        {draft&&<p className="rack-warning">请先保存或放弃当前共享草稿，再生成候选。</p>}
        {layout.sourceStatus.status!=='UNCHANGED'&&<p className="rack-warning">Facility 输入已变化，请先复核来源。</p>}
        {pending&&<button type="button" onClick={()=>{controller.current?.abort();setPending(false);}}>停止等待</button>}
      </form>}
      {error&&<p role="alert" className="rack-error">{error}</p>}
      {result&&<>
        <p role="status">生成 {result.candidates.length} 个候选 · {result.elapsedMs} ms · 基于 v{result.baseVersion} · 尚未保存</p>
        <p className="rack-muted">优先全部安排，再比较柜数与紧凑度。有限启发式搜索，不保证全局最优；最多32柜、每策略256个整体位置提案。</p>
        <div className="rack-table-scroll"><table className="rack-input-table"><caption>自动设计方案比较</caption><thead><tr><th>策略</th><th>机柜数</th><th>已安排 / 请求</th><th>柜占地区包围面积 m²</th><th>未满足项</th><th>局部检查</th></tr></thead><tbody>
          {result.candidates.map((c,i)=><tr key={c.optionId}><td><button aria-pressed={index===i} onClick={()=>{setIndex(i);setSelectedId(null);setConfirmed(false);}}>{labels[c.algorithmId]}</button></td><td>{c.metrics.rackCount}</td><td>{c.metrics.assignedDevices} / {c.metrics.requestedDevices}</td><td>{fmt(c.metrics.envelopeAreaM2)}</td><td>{c.unplaced.length}</td><td>{c.report.status} / {c.equipmentReport.status}</td></tr>)}
        </tbody></table></div>
        {option&&<>
          <h4>{labels[option.algorithmId]} · 预览</h4>
          {option.unplaced.length>0&&<ul className="rack-warning">{option.unplaced.map((u,i)=><li key={i}>{u.deviceId&&`${option.body.equipment.devices.find(d=>d.deviceId===u.deviceId)?.name}: `}{u.code} · {u.message}</li>)}</ul>}
          <RackWorkbench key={option.optionId} snapshot={layout.snapshot} placements={option.placements} models={layout.models} constraints={option.body.constraints}
            equipment={option.body.equipment} report={option.report} equipmentReport={option.equipmentReport} selectedId={selectedId} onSelect={setSelectedId}
            editable={false} isPositionLocked={id=>option.placements.some(p=>p.rackId===id&&p.locked)}
            feedback="只读候选：点击机柜、柜内设备查看详情。采用为草稿后可微调。"/>
          <p>空间：{option.report.status} · 设备：{option.equipmentReport.status} · 房间预算：{option.equipmentReport.roomCapacity?.status??'INCOMPLETE'} · 整体验证：NOT_RUN</p>
          <ul>{[...option.report.diagnostics,...option.equipmentReport.diagnostics].map((d,i)=><li key={i}>{d.code}: {d.message}</li>)}</ul>
          <details><summary>未检查范围与假设</summary><p>{option.report.uncheckedRules.join(', ')}</p><p>设备与容量为合成假设；房间预算仅属于本方案，不预留其他方案容量。</p></details>
          <label className="rack-option-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已复核候选、假设及检查范围</label>
          {reason&&<p className="rack-muted">{reason}</p>}
          <button className="rack-primary" disabled={Boolean(reason)} onClick={()=>{try{onDraftChange(stageRackOption(layout,result,option,guards));setConfirmed(false);onNavigate('layout');}catch(e){setError(e.message);}}}>采用自动设计为草稿</button>
          <p className="rack-muted">随后点击 Save layout。保存再次检查权限、版本、输入来源、布局与设备容量，并原子写入。</p>
        </>}
      </>}
    </>}
  </section>;
}
