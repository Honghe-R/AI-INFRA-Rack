import { deviceFromCatalog } from '../catalog/catalog-state.js';
import { MAX_EQUIPMENT_DEVICES } from './limits.generated.js';

export function createDeviceBatch(existing, {quantity = 1, catalogModel = null, custom = null}, makeId = () => crypto.randomUUID()) {
  const count = Number(quantity);
  if (!Number.isSafeInteger(count) || count < 1 || count > 128 || existing.length + count > MAX_EQUIPMENT_DEVICES)
    throw new Error(`Add 1–128 devices at a time, within the ${MAX_EQUIPMENT_DEVICES}-device plan limit.`);
  let specification, prefix;
  if (custom) {
    const types = {server:'Server',switch:'Switch',gpu:'GPU server',other:'Equipment'};
    if (!types[custom.kind]) throw new Error('Choose a custom device type.');
    const heightU = Number(custom.heightU);
    if (String(custom.heightU??'').trim()==='' || !Number.isInteger(heightU) || heightU < 1 || heightU > 100) throw new Error('Device height must be 1–100 U.');
    specification = {heightU};
    for (const key of ['weightKg','powerKw','coolingKw']) {
      const raw=custom[key], value=raw == null || String(raw).trim()==='' ? null : Number(raw);
      if (value!==null && (!Number.isFinite(value) || value<0 || value>1000000)) throw new Error('Device demands must be from 0 to 1000000; blank means unknown.');
      specification[key]=value;
    }
    const label=String(custom.namePrefix??'').trim();
    if(label.length>100 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error('Custom name must be at most 100 characters.');
    prefix=types[custom.kind]+(label ? ` ${label}` : '');
  } else {
    if (!catalogModel) throw new Error('Choose an available versioned equipment model or Custom.');
    prefix=catalogModel.name.slice(0,140);
  }
  const used=new Set(existing.map(d=>d.name.toLowerCase()));let number=1;
  return Array.from({length:count},()=>{
    let name;do {name=`${prefix} ${String(number++).padStart(2,'0')}`;}while(used.has(name.toLowerCase()));used.add(name.toLowerCase());
    const deviceId=makeId();
    return custom ? {deviceId,name,...specification,rackId:null,startU:null} : {...deviceFromCatalog(catalogModel,deviceId),name};
  });
}
export const DEFAULT_CUSTOM_DEVICE = Object.freeze({kind:'server',namePrefix:'',heightU:1,weightKg:'',powerKw:'',coolingKw:''});
