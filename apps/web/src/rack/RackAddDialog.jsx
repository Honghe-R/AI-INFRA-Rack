import { useEffect, useRef, useState } from 'react';
import { RACK_COMMANDS } from './rack-commands.js';

export function RackAddDialog({ kind, layout, draft, catalogState, blockedReason, onApply, onClose }) {
  const dialog = useRef(null);
  const [error, setError] = useState(null);
  const [values, setValues] = useState(() => ({ name: kind === 'rack_add' ? `Rack ${(draft?.placements ?? layout.placements).length + 1}` : `Exclusion zone ${(draft?.constraints ?? layout.constraints).obstacles.length + 1}`,
    modelId: layout.models[0]?.modelId ?? '', xM: Number((layout.snapshot.view.extentM.width / 2).toFixed(2)),
    yM: Number((layout.snapshot.view.extentM.height / 2).toFixed(2)), rotationDeg: 0, widthM: 1, depthM: 1, quantity: 1, catalogKey: '' }));
  useEffect(() => { const previous = document.activeElement; dialog.current.showModal();
    return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  const patch = (key, value) => setValues(v => ({ ...v, [key]: value }));
  const models = catalogState.data?.models ?? [];
  const catalogKey = values.catalogKey || (models[0] ? `${models[0].modelId}@${models[0].version}` : '');
  const specification = models.find(m => `${m.modelId}@${m.version}` === catalogKey)?.specification;
  return <dialog ref={dialog} className="rack-add-dialog" aria-label={RACK_COMMANDS.find(c => c.commandId === kind)?.label} onCancel={event => { event.preventDefault(); onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); try { onApply({ ...values, catalogKey }); } catch (e) { setError(e.message); } }}>
      <header><h2>{kind === 'rack_add' ? '添加机柜' : kind === 'rack_device' ? '添加设备' : '添加禁放区'}</h2><button type="button" aria-label="关闭添加窗口" onClick={onClose}>×</button></header>
      <p className="rack-muted">加入当前 Plan 的共享草稿；检查后点击 Save layout 才会保存。取消不会改变方案。</p>
      {kind === 'rack_device' ? <>
        {catalogState.pending ? <p role="status">正在读取设备目录…</p> : catalogState.error ? <p role="alert">设备目录暂不可用。<button type="button" onClick={catalogState.retry}>重试目录</button></p> : null}
        <label>设备型号<select aria-label="设备型号" required value={catalogKey} onChange={e => patch('catalogKey', e.target.value)}>{!models.length && <option value="">暂无可用型号</option>}{models.map(m => <option key={`${m.modelId}@${m.version}`} value={`${m.modelId}@${m.version}`}>{m.name} · v{m.version}</option>)}</select></label>
        <label>设备数量<input type="number" required min="1" max="128" step="1" value={values.quantity} onChange={e => patch('quantity', e.target.value)}/></label>
        {specification && <p>{specification.heightU} U · {specification.powerKw ?? '未知'} kW · {specification.weightKg ?? '未知'} kg / 台</p>}
        <p className="rack-muted">设备先进入待上架库存，保留目录版本。随后在设备页自动分配机柜和 U 位，或手动指定。</p>
      </> : <>
        <label>{kind === 'rack_add' ? '机柜名称' : '禁放区名称'}<input required maxLength="160" value={values.name} onChange={e => patch('name', e.target.value)}/></label>
        {kind === 'rack_add' && <label>机柜型号<select required value={values.modelId} onChange={e => patch('modelId', e.target.value)}>{layout.models.map(m => <option key={m.modelId} value={m.modelId}>{m.name} · {m.heightU} U · {m.widthM} × {m.depthM} m</option>)}</select></label>}
        <div className="rack-form-fields">{['xM', 'yM', ...(kind === 'rack_zone' ? ['widthM', 'depthM'] : [])].map(key => <label key={key}>{({xM:'中心 X (m)', yM:'中心 Y (m)', widthM:'宽度 (m)', depthM:'深度 (m)'})[key]}<input type="number" required step="0.01" min={['widthM', 'depthM'].includes(key) ? '0.01' : '-10000'} max="10000" value={values[key]} onChange={e => patch(key, e.target.value)}/></label>)}</div>
        {kind === 'rack_add' && <label>方向<select value={values.rotationDeg} onChange={e => patch('rotationDeg', e.target.value)}>{[0,90,180,270].map(deg => <option key={deg} value={deg}>{deg}°</option>)}</select></label>}
        <p className="rack-muted">使用真实房间的局部米制坐标。初始位置只是提案，越界、重叠和维护带冲突会由后端检查。</p>
      </>}
      {(error || blockedReason) && <p role="alert" className="rack-error">{blockedReason || error}</p>}
      <footer className="rack-actions"><button type="button" onClick={onClose}>取消</button><button className="rack-primary" disabled={Boolean(blockedReason) || (kind === 'rack_device' && !catalogKey)}>加入草稿</button></footer>
    </form>
  </dialog>;
}
