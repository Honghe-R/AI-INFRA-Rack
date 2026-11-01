import {test} from 'vitest';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {addPlanObject} from '../rack/rack-commands.js';
import {defaultEditorEquipment,defaultEditorConstraints,validateEditorEquipment} from '../rack/edit-layout-state.js';
import {createDeviceBatch,DEFAULT_CUSTOM_DEVICE} from '../rack/device-batch.js';
import {renameAllocatedDevices,nameAllocationResult} from '../rack/allocation-names.js';
import {RackCapacityLimits} from '../rack/RackCapacityLimits.jsx';
import {RackDevicePicker} from '../rack/RackDevicePicker.jsx';
import {RackAddDialog} from '../rack/RackAddDialog.jsx';
const model={modelId:'m',name:'42U',widthM:.6,depthM:1.2,heightU:42};
const layout={planId:'p',version:2,models:[model],placements:[],snapshot:{snapshotId:'s',view:{extentM:{width:20,height:20}}},equipment:defaultEditorEquipment(),constraints:defaultEditorConstraints()};
const values={modelId:'m',quantity:3,numbered:true,prefix:'H',xM:5,yM:5,rotationDeg:0};
const custom={...DEFAULT_CUSTOM_DEVICE,kind:'switch',heightU:1,weightKg:5,powerKw:.5,coolingKw:.5};

test('new rack batches include each chosen capacity limit in the same copied draft',()=>{
 let n=0;const before=structuredClone(layout);
 const added=addPlanObject(layout,null,'rack_add',{...values,capacityTemplateId:'gpu'},null,()=>`r${++n}`).draft;
 assert.equal(added.equipment.rackLimits.length,3);
 for(const rack of added.placements)assert.deepEqual(added.equipment.rackLimits.find(l=>l.rackId===rack.rackId),{rackId:rack.rackId,maxWeightKg:1500,maxPowerKw:30,maxCoolingKw:30});
 assert.equal(validateEditorEquipment(added.equipment,added.placements),null);assert.deepEqual(layout,before);
 const unknown=addPlanObject(layout,null,'rack_add',{...values,capacityTemplateId:'custom',maxWeightKg:'',maxPowerKw:0,maxCoolingKw:8},null).draft;
 assert.equal(unknown.equipment.rackLimits[0].maxWeightKg,null);assert.equal(unknown.equipment.rackLimits[0].maxPowerKw,0);
 assert.throws(()=>addPlanObject(layout,null,'rack_add',{...values,capacityTemplateId:'custom',maxPowerKw:-1},null));
 assert.equal(addPlanObject(layout,null,'rack_add',{...values,capacityTemplateId:'model'},null).draft.equipment.rackLimits.length,0);
});
test('custom device batches preserve honest unknowns, unique identities, type names and unassigned inventory',()=>{
 let n=0;const devices=createDeviceBatch([],{quantity:12,custom},()=>`d${++n}`);
 assert.equal(new Set(devices.map(d=>d.deviceId)).size,12);assert.equal(devices[0].name,'Switch 01');assert.equal(devices.at(-1).name,'Switch 12');
 assert.ok(devices.every(d=>d.rackId===null&&d.startU===null&&!d.catalogRef&&d.powerKw===.5));
 const added=addPlanObject(layout,null,'rack_device',{quantity:12,catalogKey:'custom',custom},null).draft;
 assert.equal(validateEditorEquipment(added.equipment,[]),null);
 const unknown=createDeviceBatch(devices,{quantity:1,custom:{...custom,weightKg:''}})[0];assert.equal(unknown.weightKg,null);assert.equal(unknown.name,'Switch 13');
 for(const patch of [{heightU:0},{heightU:''},{weightKg:-1}])assert.throws(()=>createDeviceBatch([],{quantity:2,custom:{...custom,...patch}}));
 assert.throws(()=>createDeviceBatch([],{quantity:129,custom}));
});
test('catalog batch specs and pinned reference survive and do not mutate the catalog',()=>{
 const model={modelId:'demo-compute-2u',version:3,name:'Compute server',specification:{heightU:2,weightKg:20,powerKw:1,coolingKw:1}};
 const before=structuredClone(model);const batch=createDeviceBatch([],{quantity:3,catalogModel:model});
 assert.ok(batch.every(d=>d.heightU===2&&d.catalogRef.modelId===model.modelId&&d.catalogRef.version===3));assert.deepEqual(model,before);
});
test('allocation names use per-rack U order across device types and preserve IDs, demands, catalog refs and unassigned names',()=>{
 const placements=[{rackId:'h',name:'H05'},{rackId:'a',name:'A01'}];
 const devices=[{deviceId:'switch',name:'Switch old',rackId:'h',startU:40,heightU:1,powerKw:.5},
 {deviceId:'server',name:'Compute node',catalogRef:{modelId:'demo-compute-2u',version:1},rackId:'h',startU:1,heightU:2},
 {deviceId:'other',name:'Other',rackId:'a',startU:5}, {deviceId:'left',name:'Unassigned server',rackId:null,startU:null}];
 const before=structuredClone(devices),renamed=renameAllocatedDevices(placements,devices);
 assert.deepEqual(renamed.map(d=>d.name),['H05-Switch-02','H05-Server-01','A01-Equipment-01','Unassigned server']);
 assert.deepEqual(renamed.map(({name,...rest})=>rest),devices.map(({name,...rest})=>rest));assert.deepEqual(devices,before);
 assert.deepEqual(renameAllocatedDevices(placements,renamed),renamed);
 const result={candidates:[{body:{placements,equipment:{devices}},metrics:{assignedDevices:2}}]};const preview=nameAllocationResult(result);
 assert.equal(preview.candidates[0].body.equipment.devices[0].name,'H05-Switch-02');assert.deepEqual(result.candidates[0].body.equipment.devices,devices);
});
test('capacity confirmation is explicit and write-gated; custom picker works without the remote catalog',()=>{
 const props={rack:{rackId:'h',name:'H05'},model,limit:{rackId:'h',maxWeightKg:null,maxPowerKw:0,maxCoolingKw:8}};
 const html=renderToStaticMarkup(<RackCapacityLimits {...props} editable/>);
 assert.match(html,/Confirm capacity limits/);assert.match(html,/Unconfirmed edits are not saved/);
 assert.match(renderToStaticMarkup(<RackCapacityLimits {...props} editable={false}/>),/disabled="">Confirm capacity limits/);
 const picker=renderToStaticMarkup(<RackDevicePicker equipment={layout.equipment} editable catalogState={{error:new Error('offline')}}/>);
 for(const label of ['Custom','Device type','Equipment quantity','Add custom devices'])assert.ok(picker.includes(label),label);
});
test('add dialogs offer rack capacity inputs and custom equipment beside versioned choices',()=>{
 const rack=renderToStaticMarkup(<RackAddDialog kind="rack_add" layout={layout} catalogState={{}}/>);
 for(const label of ['Capacity limits for new racks','General-purpose servers','Custom limits','Weight limit (kg)'])assert.ok(rack.includes(label),label);
 const devices=renderToStaticMarkup(<RackAddDialog kind="rack_device" layout={layout} catalogState={{}}/>);
 for(const label of ['Custom','Device type','Equipment quantity'])assert.ok(devices.includes(label),label);
});
