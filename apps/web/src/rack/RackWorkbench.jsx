import { useEffect, useId, useRef, useState } from 'react';
import { Server, Network, Cpu, Box, LockKeyhole, Move, MousePointer2, RotateCw, Plus, X, ArrowLeft, Layers } from 'lucide-react';
import { rackCorners, displayClearanceBands } from './edit-layout-state.js';
import { CANVAS, boundaryPath, fitRoom, niceMetres, toScreen } from './floorplan-view.js';
import { rackLoadDisplay } from './floorplan-load.js';
import { deviceKind, dragPosition, equipmentCamera, pointerPosition } from './workbench-view.js';
import { RackElevations, RackCapacityTable } from './RackViews.jsx';

const fmt=(v,unit='')=>Number.isFinite(v)?`${Number(v.toFixed(3))}${unit}`:'Unknown';
const iconFor={gpu:Cpu,server:Server,switch:Network,other:Box};
function DeviceIcon({device}) { const Icon=iconFor[deviceKind(device)[1]]; return <Icon size={16} aria-hidden="true"/>; }
function Facts({items}) { return <dl className="rack-inspector-facts">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }

export function RackInspector({rack, model, devices, selectedDevice, report, onDevice, onBack, onNavigate,
  editable, positionLocked, onUpdate, onRemove, onClose, pending=false}) {
  const installed=devices.filter(d=>d.rackId===rack?.rackId);
  const summary=report?.racks.find(r=>r.rackId===rack?.rackId);
  return <aside className="rack-inspector" aria-label="Object details">
    <header><span><MousePointer2 size={16}/> Inspector <small>Object details</small></span><button aria-label="Close object details" onClick={onClose}><X size={16}/></button></header>
    {selectedDevice ? <>
      <button className="rack-inspector-back" onClick={onBack}><ArrowLeft size={14}/>{rack?'Back to rack':'Unassigned equipment'}</button>
      <div className="rack-inspector-title"><DeviceIcon device={selectedDevice}/><h3>{selectedDevice.name}</h3></div>
      <span className="rack-type-chip">{deviceKind(selectedDevice)[0]}</span>
      <Facts items={[
        ['Assigned rack',rack?.name??'Unassigned'],['U slots',selectedDevice.rackId===null?'Unassigned':`U${selectedDevice.startU}–${selectedDevice.startU+selectedDevice.heightU-1}`],
        ['Height',`${selectedDevice.heightU} U`],['Weight',fmt(selectedDevice.weightKg,' kg')],
        ['Power demand',fmt(selectedDevice.powerKw,' kW')],['Cooling demand',fmt(selectedDevice.coolingKw,' kW')],
        ['Model',selectedDevice.catalogRef?`${selectedDevice.catalogRef.modelId} · v${selectedDevice.catalogRef.version}`:'Custom assumed specifications'],
      ]}/>
      <details><summary>Identity and source</summary><code>{selectedDevice.deviceId}</code><p>Specifications use assumptions saved in this plan. Unknown values are not treated as zero.</p></details>
      {onNavigate&&<button className="rack-inspector-link" onClick={()=>onNavigate('equipment')}>Open equipment and U slots →</button>}
    </> : rack ? <>
      <div className="rack-inspector-title"><Server size={24}/><h3>{rack.name}</h3><span className="rack-type-chip">Rack</span></div>
      <p className="rack-inspector-subtitle">{model?.name} · {positionLocked?'Position locked':'Position editable'}</p>
      <Facts items={[
        ['Dimensions',`${fmt(model?.widthM)} × ${fmt(model?.depthM)} m`],['Height / Installed',`${model?.heightU??'?'} U / ${installed.length} devices`],
        ['Center position',`${fmt(rack.xM)}, ${fmt(rack.yM)} m`],['Orientation',`${rack.rotationDeg}°`],
      ]}/>
      <div className="rack-inspector-loads"><Load label="U slots" value={summary?`${summary.occupiedU} / ${summary.heightU} U`:'Not checked'} ratio={summary?summary.occupiedU/summary.heightU:null}/>
        <Load label="Power" value={rackLoadDisplay('power',rack.rackId,report).label} ratio={summary?.capacities.powerKw.limit>0?summary.capacities.powerKw.knownSubtotal/summary.capacities.powerKw.limit:null}/></div>
      <div className="rack-actions"><button aria-label="Rotate selected rack" disabled={!editable||positionLocked} onClick={()=>onUpdate({rotationDeg:(rack.rotationDeg+90)%360})}><RotateCw size={14}/>Rotate 90°</button>
        {onNavigate&&<button onClick={()=>onNavigate('capacity')}>Capacity details →</button>}
        {onRemove&&<button className="rack-danger" disabled={!editable||positionLocked||installed.length>0} onClick={onRemove}>Remove selected rack</button>}</div>
      {onRemove&&<p className="rack-muted">{installed.length?'Unassign or move equipment on the equipment page before removing this rack.':'Save the layout to persist rack removal. Use Discard changes to undo it before saving.'}</p>}
      {positionLocked&&<p className="rack-muted"><LockKeyhole size={12}/> Unlock and save a previously locked rack before moving it.</p>}
      <h4>Installed equipment <span>{installed.length}</span></h4>
      <p className="rack-muted">Select an equipment block or list entry for details · U1 is at the bottom</p>
      {model&&<div className="rack-mini-elevation" aria-label={`${rack.name} equipment elevation`}>
        <div className="rack-mini-u-axis"><span>U{model.heightU}</span><span>U1</span></div>
        <div className="rack-mini-u-body">{installed.map(d=><button key={d.deviceId} data-kind={deviceKind(d)[1]}
          style={{bottom:`${(d.startU-1)/model.heightU*100}%`,height:`${d.heightU/model.heightU*100}%`}}
          aria-label={`View equipment ${d.name}`} title={`${d.name} · U${d.startU}–${d.startU+d.heightU-1}`}
          onClick={()=>onDevice(d.deviceId)}><DeviceIcon device={d}/><span>{d.name}</span></button>)}</div>
      </div>}
      <DeviceList devices={installed} onDevice={onDevice}/>
      {!installed.length&&<p className="rack-muted">This rack is empty. Assign devices on the equipment page.</p>}
      {onNavigate&&<button className="rack-inspector-link" onClick={()=>onNavigate('equipment')}>Manage equipment and U slots →</button>}
    </> : <>
      <div className="rack-inspector-empty"><Layers size={30}/><h3>{pending?'Unassigned equipment':'Select a rack'}</h3><p>{pending?'Select equipment for specifications; use the equipment page to assign a position.':'Select a rack on the canvas to inspect capacity, equipment and specifications.'}</p></div>
      {pending&&<DeviceList devices={devices.filter(d=>d.rackId===null)} onDevice={onDevice}/>}
    </>}
  </aside>;
}
function Load({label,value,ratio}) { return <div className="rack-inspector-load"><div><span>{label}</span><strong>{value}</strong></div><div className="rack-meter"><span style={{width:`${ratio===null?0:Math.max(0,Math.min(100,ratio*100))}%`}} data-high={ratio>=.8}/></div></div>; }
function DeviceList({devices,onDevice}) { return <ul className="rack-inspector-devices">{devices.map(d=><li key={d.deviceId}><button onClick={()=>onDevice(d.deviceId)}><DeviceIcon device={d}/><span><strong>{d.name}</strong><small>{deviceKind(d)[0]} · {d.rackId===null?'Unassigned':`U${d.startU}–${d.startU+d.heightU-1}`}</small></span><span>›</span></button></li>)}</ul>; }

export function RackWorkbench({snapshot, placements, models, constraints, equipment, report, equipmentReport,
  selectedId, onSelect, editable, onMove, isPositionLocked, onUpdate, onNavigate, focusRequest,
  modelId, onModelChange, onAdd, onRemove, actions, feedback}) {
  const {view,room}=snapshot;
  const [camera,setCamera]=useState(()=>equipmentCamera(placements,models,constraints,view.extentM));
  const [scope,setScope]=useState('equipment'),[mode,setMode]=useState('power');
  const [viewMode,setViewMode]=useState('floor');
  const [step,setStep]=useState(.1),[bands,setBands]=useState(false),[zones,setZones]=useState(true);
  const [selectedDeviceId,setSelectedDeviceId]=useState(null),[pending,setPending]=useState(false);
  const [preview,setPreview]=useState(null),[dragging,setDragging]=useState(false),[message,setMessage]=useState('');
  const [query,setQuery]=useState('');
  const svgRef=useRef(null),drag=useRef(null),previewRef=useRef(null),sectionRef=useRef(null);
  const [expanded,setExpanded]=useState(false);
  const patternId=`rack-dots-${useId().replace(/:/g,'')}`;
  const selected=placements.find(p=>p.rackId===selectedId);
  const selectedDevice=equipment.devices.find(d=>d.deviceId===selectedDeviceId);
  const device=selectedDevice?.rackId===(selectedId??null)?selectedDevice:undefined;
  const model=models.find(m=>m.modelId===selected?.modelId);
  const displayed=placements.map(p=>preview?.rackId===p.rackId?{...p,...preview}:p);
  const installed=equipment.devices.filter(d=>d.rackId!==null),pendingCount=equipment.devices.length-installed.length;
  const choose=id=>{onSelect(id);setSelectedDeviceId(null);setPending(false);};
  const chooseDevice=id=>{const d=equipment.devices.find(d=>d.deviceId===id);setSelectedDeviceId(id);onSelect(d?.rackId??null);};
  const fit=which=>{setScope(which);setCamera(which==='room'?fitRoom(view.extentM):equipmentCamera(placements,models,constraints,view.extentM));};
  useEffect(()=>{if(focusRequest) { fit('equipment'); if(focusRequest.showFloor) setViewMode('floor'); }},[focusRequest]);
  useEffect(()=>{if(selectedDeviceId&&!device)setSelectedDeviceId(null);},[selectedId,selectedDeviceId,device]);
  useEffect(()=>{const changed=()=>setExpanded(document.fullscreenElement===sectionRef.current);
    document.addEventListener('fullscreenchange',changed);return()=>document.removeEventListener('fullscreenchange',changed);},[]);
  async function expand() {try {if(document.fullscreenElement===sectionRef.current)await document.exitFullscreen();
    else await sectionRef.current.requestFullscreen();}catch{setMessage('The browser could not expand the workbench. You can still use the current canvas.');}}
  useEffect(()=>{if(!editable){drag.current=null;previewRef.current=null;setPreview(null);setDragging(false);setMessage('');}},[editable]);
  function finish(event,cancel=false) {
    const active=drag.current,next=previewRef.current;
    drag.current=null;previewRef.current=null;setPreview(null);setDragging(false);
    if(svgRef.current?.hasPointerCapture(event.pointerId))svgRef.current.releasePointerCapture(event.pointerId);
    if(!cancel&&active&&next&&editable&&!isPositionLocked(active.rackId)&&
      (next.xM!==active.xM||next.yM!==active.yM)) {
      onMove(active.rackId,{xM:next.xM,yM:next.yM});
      setMessage(`Position updated to ${fmt(next.xM)}, ${fmt(next.yM)} m. Check the layout, then save.`);
    }
  }
  const scaleM=niceMetres(80/camera.scale),roomCamera=fitRoom(view.extentM);
  const pickable=placements.filter(p=>p.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  return <section ref={sectionRef} className="rack-workbench" aria-label="Rack visual workbench">
    <div className="rack-workbench-title"><div><p>RACK STUDIO <span>{viewMode==='floor'?'Physical layout':viewMode==='elevation'?'Rack elevations':'Capacity overview'}</span></p><h3>{room.name}</h3></div>
      <div className="rack-workbench-totals"><span><strong>{placements.length}</strong> racks</span><span><strong>{installed.length}</strong> installed devices</span><button onClick={()=>{onSelect(null);setSelectedDeviceId(null);setPending(true);}}><strong>{pendingCount}</strong> unassigned ›</button><button onClick={expand}>{expanded?'Exit expanded view':'Expand workbench'}</button></div></div>
    <div className="rack-studio-actions">{actions}{feedback&&<p role="status">{feedback}</p>}</div>
    <div className="rack-workbench-body"><div className="rack-workbench-main">
      <div className="rack-view-switch" role="group" aria-label="Rack views">{[['floor','Floor layout'],['elevation','Rack elevations'],['capacity','Capacity table']].map(([id,label])=><button key={id} aria-pressed={viewMode===id} onClick={()=>setViewMode(id)}>{label}</button>)}<span>Same plan · Selection is preserved between views</span></div>
      {viewMode==='elevation'&&<RackElevations placements={placements} models={models} devices={equipment.devices} selectedId={selectedId} selectedDeviceId={selectedDeviceId} report={equipmentReport} onSelect={choose} onDevice={chooseDevice}/>}
      {viewMode==='capacity'&&<RackCapacityTable placements={placements} devices={equipment.devices} report={equipmentReport} selectedId={selectedId} onSelect={choose}/>}
      <div className="rack-physical-view" hidden={viewMode!=='floor'}>
      <div className="rack-studio-toolbar"><div className="rack-segment" aria-label="Canvas scope"><button aria-pressed={scope==='equipment'} onClick={()=>fit('equipment')}>Equipment area</button><button aria-pressed={scope==='room'} onClick={()=>fit('room')}>Full room</button></div>
        <label>Color by<select aria-label="Rack color mode" value={mode} onChange={e=>setMode(e.target.value)}><option value="layout">Layout</option><option value="power">Power</option><option value="u">U slots</option></select></label>
        <label><input type="checkbox" checked={zones} onChange={e=>setZones(e.target.checked)}/>Exclusion zones</label><label><input type="checkbox" checked={bands} onChange={e=>setBands(e.target.checked)}/>Maintenance bands</label>
        <label>Snap<select aria-label="Drag snap spacing" value={step} onChange={e=>setStep(Number(e.target.value))}><option value={.1}>0.1 m</option><option value={.5}>0.5 m</option><option value={1}>1 m</option></select></label></div>
      <div className="rack-studio-map">
        <svg ref={svgRef} viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`} className={`rack-studio-canvas${dragging?' is-dragging':''}`} role="group" aria-label="Room layout canvas" tabIndex={0}
          onPointerMove={event=>{const active=drag.current;if(!active||active.pointerId!==event.pointerId)return;
            const next={rackId:active.rackId,...dragPosition(active,pointerPosition(event.clientX,event.clientY,svgRef.current.getBoundingClientRect(),camera),step)};
            previewRef.current=next;setPreview(next);}}
          onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)}
          onLostPointerCapture={()=>{drag.current=null;previewRef.current=null;setPreview(null);setDragging(false);}}
          onKeyDown={event=>{if(event.key==='Escape'&&drag.current){finish({pointerId:drag.current.pointerId},true);event.preventDefault();}}}>
          <defs><pattern id={patternId} width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65"/></pattern></defs>
          <rect className="rack-studio-map-bg" width="800" height="440"/>
          <path className="rack-studio-room" d={boundaryPath(view.boundaryLocalM,camera)} fillRule="evenodd"/>
          <rect className="rack-studio-dots" width="800" height="440" fill={`url(#${patternId})`} pointerEvents="none"/>
          {bands&&<g aria-label="Rack maintenance bands">{displayed.flatMap(r=>{const m=models.find(m=>m.modelId===r.modelId);return m?displayClearanceBands(r,m,constraints.clearance).map(b=><polygon key={`${r.rackId}:${b.side}`} className={`rack-maintenance-band ${b.side.toLowerCase()}`} points={b.points.map(p=>toScreen(p,camera).join(',')).join(' ')}/>):[];})}</g>}
          {zones&&<g aria-label="Planning exclusion zones">{constraints.obstacles.map(o=>{const [x,y]=toScreen([o.xM-o.widthM/2,o.yM+o.depthM/2],camera),w=o.widthM*camera.scale,h=o.depthM*camera.scale;return <g key={o.obstacleId} className="rack-studio-zone"><title>{`${o.name} · ${o.widthM} × ${o.depthM} m`}</title><rect x={x} y={y} width={w} height={h} rx="2"/>{w>65&&<text x={x+w/2} y={y+h/2+3} textAnchor="middle">{o.name.replace(' · 禁放','')}</text>}</g>;})}</g>}
          <g aria-label="Rack shapes">{displayed.map(r=>{
            const m=models.find(m=>m.modelId===r.modelId);if(!m||![r.xM,r.yM].every(Number.isFinite))return null;
            const [x,y]=toScreen([r.xM,r.yM],camera),w=m.widthM*camera.scale,h=m.depthM*camera.scale;
            const tone=rackLoadDisplay(mode,r.rackId,equipmentReport)?.tone??'clear';
            const issue=report?.diagnostics.some(d=>d.rackIds?.includes(r.rackId))||equipmentReport?.diagnostics.some(d=>d.rackId===r.rackId);
            const count=installed.filter(d=>d.rackId===r.rackId).length,locked=isPositionLocked(r.rackId);
            return <g key={r.rackId} role="button" tabIndex={0} aria-label={`Select rack ${r.name}`} aria-pressed={selectedId===r.rackId}
              className={`rack-studio-rack${selectedId===r.rackId?' is-selected':''}${issue?' has-issue':''}`} data-load={tone} data-locked={locked}
              onClick={()=>choose(r.rackId)} onKeyDown={event=>{
                if(['Enter',' '].includes(event.key)){event.preventDefault();choose(r.rackId);}
                const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]}[event.key];
                if(delta&&editable&&!locked){event.preventDefault();event.stopPropagation();const amount=event.shiftKey?1:step;onMove(r.rackId,{xM:Number((r.xM+delta[0]*amount).toFixed(4)),yM:Number((r.yM+delta[1]*amount).toFixed(4))});}
              }} onPointerDown={event=>{event.stopPropagation();choose(r.rackId);if(event.button!==0||!editable||locked)return;
                event.preventDefault();event.currentTarget.focus();svgRef.current.setPointerCapture(event.pointerId);
                drag.current={rackId:r.rackId,pointerId:event.pointerId,xM:r.xM,yM:r.yM,pointer:pointerPosition(event.clientX,event.clientY,svgRef.current.getBoundingClientRect(),camera)};setDragging(true);}}>
              <title>{`${r.name} · ${count} devices · ${m.widthM} × ${m.depthM} m${locked?' · Position locked':''}`}</title>
              <g transform={`translate(${x},${y}) rotate(${-r.rotationDeg})`}>
                <rect className="rack-studio-cabinet" x={-w/2} y={-h/2} width={w} height={h} rx="2"/>
                {w>10&&[.22,.4,.58,.76].map(f=><g key={f}><line className="rack-studio-slot" x1={-w*.32} x2={w*.32} y1={-h/2+h*f} y2={-h/2+h*f}/><circle className="rack-studio-led" cx={w*.28} cy={-h/2+h*f} r={Math.min(1.2,w*.04)}/></g>)}
                <line className="rack-studio-front" x1={-w*.35} x2={w*.35} y1={h/2-2} y2={h/2-2}/>
              </g>
              {w>8&&<text x={x} y={y-(r.rotationDeg%180===0?h:w)/2-7} textAnchor="middle" style={{fontSize:8}}>{r.name}</text>}
            </g>;
          })}</g>
          <g className="rack-studio-scale"><rect x="14" y="390" width="118" height="40" rx="5"/><path d={`M26 413 v6 h${scaleM*camera.scale} v-6`}/><text x="26" y="405">{scaleM} m · To scale</text></g>
        </svg>
        <div className="rack-studio-map-note">{scope==='equipment'?'Equipment area view':'Full room boundary'} · Room area {fmt(view.areaM2)} m²<small>↑ N</small></div>
        <svg className="rack-studio-minimap" viewBox="0 0 800 440" aria-label="Room overview"><path d={boundaryPath(view.boundaryLocalM,roomCamera)} fillRule="evenodd"/>{placements.map(r=>{const m=models.find(m=>m.modelId===r.modelId);return m&&[r.xM,r.yM].every(Number.isFinite)?<polygon key={r.rackId} points={rackCorners(r,m).map(p=>toScreen(p,roomCamera).join(',')).join(' ')}/>:null;})}</svg>
      </div>
      <div className="rack-studio-footer"><span><i className="rack-dot"/>Normal <i className="rack-dot high"/>High load <i className="rack-dot issue"/>Conflict <i className="rack-dot unknown"/>Unknown</span><span>{editable?<><Move size={13}/>Drag unlocked racks · Arrow keys to nudge</>:<><MousePointer2 size={13}/>Select for details · Choose Edit layout to place racks</>}</span></div>
      </div>
      <div className="rack-studio-inventory"><div className="rack-studio-inventory-tools"><label><span>Rack inventory</span><input aria-label="Search racks" placeholder="Search rack IDs…" value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="rack-actions"><select aria-label="New rack model" value={modelId||models[0]?.modelId} disabled={!editable} onChange={e=>onModelChange(e.target.value)}>{models.map(m=><option key={m.modelId} value={m.modelId}>{m.name}</option>)}</select><button disabled={!editable||placements.length>=256} onClick={onAdd}><Plus size={14}/>Add rack</button></div></div>
        <div className="rack-studio-rack-list">{pickable.map(r=><button key={r.rackId} aria-pressed={selectedId===r.rackId} onClick={()=>choose(r.rackId)}>{isPositionLocked(r.rackId)?<LockKeyhole size={12}/>:<Server size={12}/>} {r.name}</button>)}</div></div>
      <p role="status" className="rack-studio-status">{message||'Physical dimensions are to scale. Dots form the canvas background; snap spacing is measured in metres.'}</p>
    </div><RackInspector rack={selected} model={model} devices={equipment.devices} selectedDevice={device} report={equipmentReport} onDevice={chooseDevice}
      onBack={()=>setSelectedDeviceId(null)} onClose={()=>{onSelect(null);setSelectedDeviceId(null);setPending(false);}}
      onNavigate={onNavigate} editable={editable} positionLocked={selected?isPositionLocked(selected.rackId):false} onUpdate={onUpdate} onRemove={onRemove} pending={pending}/></div>
    <p className="rack-studio-boundary">Synthetic / assumed inputs · Exclusion zones and maintenance bands are checked by the backend. Equipment is assigned to racks and U slots. Overall engineering validation has not run; aisle connectivity and network cabling remain unchecked.</p>
  </section>;
}
