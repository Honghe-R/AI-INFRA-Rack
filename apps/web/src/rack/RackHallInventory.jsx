import { RackElevation } from './RackEquipment.jsx';
import { rackLoadDisplay } from './floorplan-load.js';

const kinds = [ ['demo-gpu-4u','GPU服务器'], ['demo-compute-2u','计算服务器'], ['demo-tor-1u','ToR交换机'], ['demo-optical-2u','光交换机'] ];
export function RackHallInventory({ placements, models, equipment, report, selectedId, onSelect, onNavigate }) {
  const selected = placements.find(p=>p.rackId===selectedId), devices = equipment.devices;
  const installed = devices.filter(d=>d.rackId!==null);
  const groups = new Map();
  for (const p of [...placements].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))) {
    const group = /^([A-Za-z]+)\d+$/.exec(p.name)?.[1] ?? '其他';
    if (!groups.has(group)) groups.set(group,[]); groups.get(group).push(p);
  }
  return <section className="rack-card rack-hall-inventory" aria-label="机房设备概览">
    <h3>机房设备概览</h3>
    <p>{placements.length} 个机柜 · {installed.length} 台已安装 · {devices.length-installed.length} 台待上架 · {placements.filter(p=>p.locked).length} 个锁定柜</p>
    <p className="rack-muted">平面图画机柜，柜内包含服务器和交换机。选择机柜可查看实际安装设备；这里不表示网络连线。</p>
    <p>设备型号统计（包含待上架设备）</p>
    <ul className="rack-hall-kinds">{kinds.map(([key,label]) => <li key={key}>{label}：{devices.filter(d=>d.catalogRef?.modelId===key).length}</li>)}
      <li>其他／自定义：{devices.filter(d=>!kinds.some(([key])=>key===d.catalogRef?.modelId)).length}</li></ul>
    <p className="rack-muted">以下按机柜名称前缀分组，便于浏览；不是空间分区或网络拓扑。数字为安装台数，颜色为当前功率检查结果。</p>
    {[...groups].map(([group,racks])=><div className="rack-hall-row" key={group}>
      <strong>{group} 组</strong><div className="rack-hall-racks">{racks.map(p=>{
        const load = rackLoadDisplay('power',p.rackId,report), count = installed.filter(d=>d.rackId===p.rackId).length;
        return <button key={p.rackId} aria-pressed={selectedId===p.rackId} aria-label={`查看机柜 ${p.name}，${count} 台设备`}
          data-load={load.tone} title={`${p.name} · ${load.label}${p.locked?' · Locked':''}`} onClick={()=>onSelect(p.rackId)}>
          <strong>{p.name}</strong><span>{count} 台{p.locked?' · 锁定':''}</span></button>;
      })}</div>
    </div>)}
    {selected ? <div className="rack-hall-selected">
      <h4>{selected.name} · 柜内设备</h4>
      <p>{rackLoadDisplay('power',selected.rackId,report).label} · {selected.locked?'机柜位置锁定':'可编辑机柜位置'}</p>
      <div className="rack-actions"><button onClick={()=>onNavigate('equipment')}>管理设备与 U 位</button><button onClick={()=>onNavigate('capacity')}>查看容量与预算</button></div>
      <RackElevation rack={selected} model={models.find(m=>m.modelId===selected.modelId)} devices={installed.filter(d=>d.rackId===selectedId)} readOnly />
    </div> : <p>点击图面或上方机柜按钮，查看柜内 U 位和设备。</p>}
    <p className="rack-muted">图面中的“通道预留”若以禁放区表示，只防止柜体与维护带侵占；通道连通、疏散、冷热气流仍未验证。</p>
  </section>;
}
