import { rackLoadDisplay } from './floorplan-load.js';
import { deviceKind } from './workbench-view.js';

const number = value => Number.isFinite(value) ? Number(value.toFixed(3)) : '?';
export function capacityLabel(summary, key, unit) {
  const capacity = summary?.capacities[key];
  if (!capacity) return '待检查';
  return `${capacity.total === null ? '≥' + number(capacity.knownSubtotal) : number(capacity.total)} / ${number(capacity.limit)} ${unit}${capacity.status === 'UNKNOWN' ? ' · 未知' : capacity.status === 'EXCEEDED' ? ' · 超限' : ''}`;
}

/** Schematic views share object IDs/selection; they never write physical positions. */
export function RackElevations({ placements, models, devices, selectedId, selectedDeviceId, report, onSelect, onDevice }) {
  return <div className="rack-elevation-gallery" aria-label="所有机柜立面">
    <p className="rack-view-explainer">机柜正面示意 · U1 在底部 · 点击设备查看详情；排列顺序仅用于展示。</p>
    <div className="rack-elevation-cards">{placements.map(rack => {
      const model = models.find(m => m.modelId === rack.modelId);
      const members = devices.filter(d => d.rackId === rack.rackId);
      const supported = Number.isInteger(model?.heightU) && model.heightU > 0 && model.heightU <= 100;
      return <article key={rack.rackId} className={`rack-elevation-card${selectedId === rack.rackId ? ' is-selected' : ''}`}>
        <button className="rack-elevation-heading" onClick={() => onSelect(rack.rackId)} aria-pressed={selectedId === rack.rackId}>{rack.name}<small>{model?.heightU ?? '?'} U · {members.length} 台</small></button>
        {supported ? <div className="rack-gallery-cabinet" style={{'--rack-units':model.heightU}}>
          <span className="rack-gallery-top">U{model.heightU}</span><span className="rack-gallery-bottom">U1</span>
          {members.filter(d => Number.isInteger(d.startU) && Number.isInteger(d.heightU)).map(d => <button key={d.deviceId} data-kind={deviceKind(d)[1]}
            aria-label={`查看设备 ${d.name}`} aria-pressed={selectedDeviceId === d.deviceId}
            style={{bottom:`${(d.startU - 1) / model.heightU * 100}%`,height:`${d.heightU / model.heightU * 100}%`}}
            title={`${d.name} · U${d.startU}–${d.startU + d.heightU - 1}`} onClick={() => onDevice(d.deviceId)}>{d.name}<small>U{d.startU}–{d.startU + d.heightU - 1}</small></button>)}
        </div> : <p>此型号无法绘制立面。</p>}
        <p className="rack-muted">{rackLoadDisplay('power',rack.rackId,report).label}</p>
      </article>;
    })}</div>
    {!placements.length && <p>暂无机柜。使用顶部 Add rack 或 Auto design 开始。</p>}
  </div>;
}

export function RackCapacityTable({ placements, devices, report, selectedId, onSelect }) {
  return <div className="rack-capacity-view" aria-label="机柜容量表">
    <p className="rack-view-explainer">使用当前草稿的后端检查结果 · “?” 为未知上限，“≥” 为已知需求小计。点击名称查看对象详情。</p>
    <table><thead><tr><th>机柜 / 位置</th><th>设备</th><th>U 位</th><th>重量</th><th>功率</th><th>冷却</th></tr></thead><tbody>
      {placements.map(rack => { const summary = report?.racks.find(r => r.rackId === rack.rackId);
        return <tr key={rack.rackId} className={selectedId === rack.rackId ? 'is-selected' : ''}><th><button aria-pressed={selectedId === rack.rackId} onClick={() => onSelect(rack.rackId)}>{rack.name}</button><small>{number(rack.xM)}, {number(rack.yM)} m · {rack.rotationDeg}°</small></th>
          <td>{devices.filter(d => d.rackId === rack.rackId).length}</td><td>{summary ? `${summary.occupiedU} / ${summary.heightU} U${summary.uStatus === 'ISSUES_FOUND' ? ' · 冲突' : ''}` : '待检查'}</td>
          <td>{capacityLabel(summary,'weightKg','kg')}</td><td>{capacityLabel(summary,'powerKw','kW')}</td><td>{capacityLabel(summary,'coolingKw','kW')}</td></tr>;
      })}
    </tbody></table>{!placements.length && <p>暂无机柜。</p>}
  </div>;
}
