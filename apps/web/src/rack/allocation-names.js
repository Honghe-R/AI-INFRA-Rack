import { deviceKind } from './workbench-view.js';
/** Labels only: stable IDs, pinned specifications and allocation decisions are preserved. */
export function renameAllocatedDevices(placements, devices) {
  const names=new Map();
  for(const rack of placements) {
    const installed=devices.filter(d=>d.rackId===rack.rackId).slice().sort((a,b)=>(a.startU??0)-(b.startU??0)||a.deviceId.localeCompare(b.deviceId));
    installed.forEach((device,index)=>{
      const kind=deviceKind(device)[1],type=kind==='switch'?'Switch':kind==='gpu'||kind==='server'?'Server':'Equipment';
      names.set(device.deviceId,`${rack.name.slice(0,140)}-${type}-${String(index+1).padStart(2,'0')}`);
    });
  }
  return devices.map(d=>names.has(d.deviceId)?{...d,name:names.get(d.deviceId)}:d);
}
export function nameAllocationResult(result) {
  return {...result,candidates:result.candidates.map(candidate=>({...candidate,body:{...candidate.body,equipment:{...candidate.body.equipment,
    devices:renameAllocatedDevices(candidate.body.placements,candidate.body.equipment.devices)}}}))};
}
