import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { normalizeEditableLayout, normalizeEquipment, normalizeSpatialConstraints, assertLockedRacksUnchanged, resolveCatalogReference } from '@ai-infra/rack';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reject=(message,code='RACK_ASSISTANT_ARGUMENTS_INVALID',status=400)=>{throw new ApiError(code,message,{status});};
function fields(input,keys) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k))) reject('Unexpected or malformed edit arguments.');
}
function exact(items,value,idKey,label) {
  if(typeof value!=='string'||!value.trim()||value.length>160) reject(`Provide an exact ${label} name or identifier.`);
  const matches=items.filter(item=>item[idKey].toLowerCase()===value.toLowerCase()||item.name===value);
  if(matches.length!==1) reject(matches.length?`The ${label} name is ambiguous. Use an identifier from a read tool.`:`The ${label} was not found in this plan.`, 'RACK_ASSISTANT_OBJECT_UNRESOLVED',409);
  return matches[0];
}
function finite(value,label,min=-10000,max=10000) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max) reject(`${label} must be a number from ${min} to ${max}.`);
  return value;
}
const beforeAfter=(label,before,after)=>`${label}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`;
export function buildRackAssistantEdit(layout,operations) {
  if(!Array.isArray(operations)||operations.length<1||operations.length>20) reject('Provide 1–20 edit operations.');
  const draft=structuredClone({placements:layout.placements,constraints:layout.constraints,equipment:layout.equipment}),changes=[];
  for(const op of operations) {
    const allowed={MOVE_RACK:['type','rack','x_m','y_m','rotation_deg'],ADD_RACK:['type','model_id','name','x_m','y_m','rotation_deg','locked','quantity','columns','step_x_m','step_y_m'],
      REMOVE_RACK:['type','rack'],ASSIGN_DEVICE:['type','device','rack','start_u'],SET_CLEARANCE:['type','front_m','rear_m'],
      SET_ROOM_BUDGET:['type','max_power_kw','max_cooling_kw','reference'],
      ADD_DEVICE:['type','name','catalog_model_id','catalog_version','quantity','height_u','weight_kg','power_kw','cooling_kw'],
      REMOVE_DEVICES:['type','devices'], REMOVE_RACKS:['type','racks','unassign_devices'],
      SET_RACK_LOCK:['type','rack','locked'],SET_RACK_LIMITS:['type','rack','max_weight_kg','max_power_kw','max_cooling_kw'],
      SET_OBSTACLE:['type','obstacle','name','x_m','y_m','width_m','depth_m'],REMOVE_OBSTACLES:['type','obstacles']}[op?.type];
    if(!allowed) reject('Unsupported edit operation.'); fields(op,allowed);
    if(op.type==='ADD_RACK') {
      const model=layout.models.find(m=>m.modelId===op.model_id);
      if(!model) reject('Use a rack model identifier returned by rack_read_plan.');
      const count=op.quantity??1;
      if(!Number.isSafeInteger(count)||count<1||count>128) reject('Rack quantity must be 1–128.');
      if(op.locked!==undefined&&typeof op.locked!=='boolean') reject('locked must be boolean.');
      const columns=count===1?1:op.columns;
      if(!Number.isSafeInteger(columns)||columns<1||columns>128) reject('Provide columns for a rack batch.');
      const dx=count===1?0:finite(op.step_x_m,'step_x_m',0.001,1000),dy=count===1?0:finite(op.step_y_m,'step_y_m',0.001,1000);
      for(let i=0;i<count;i++) draft.placements.push({rackId:randomUUID(),modelId:model.modelId,name:count===1?op.name:`${op.name} ${i+1}`,
        xM:finite(op.x_m,'x_m')+(i%columns)*dx,yM:finite(op.y_m,'y_m')+Math.floor(i/columns)*dy,rotationDeg:op.rotation_deg??0,locked:op.locked??true});
      changes.push(`Add ${count===1?'rack':`${count} racks`} ${JSON.stringify(op.name)} using model ${model.modelId}; position lock ${op.locked??true}.`);
    } else if(op.type==='MOVE_RACK') {
      const rack=exact(draft.placements,op.rack,'rackId','rack');
      const before={xM:rack.xM,yM:rack.yM,rotationDeg:rack.rotationDeg};
      rack.xM=finite(op.x_m,'x_m');rack.yM=finite(op.y_m,'y_m');
      if(op.rotation_deg!==undefined) rack.rotationDeg=op.rotation_deg;
      changes.push(beforeAfter(`Move rack ${JSON.stringify(rack.name)} (metres/degrees)`,before,{xM:rack.xM,yM:rack.yM,rotationDeg:rack.rotationDeg}));
    } else if(op.type==='REMOVE_RACK') {
      const rack=exact(draft.placements,op.rack,'rackId','rack');
      if(draft.equipment.devices.some(d=>d.rackId===rack.rackId)) reject('Unassign or move every installed device before removing its rack.');
      draft.placements=draft.placements.filter(p=>p.rackId!==rack.rackId);
      draft.equipment.rackLimits=draft.equipment.rackLimits.filter(l=>l.rackId!==rack.rackId);
      changes.push(`Remove empty rack ${JSON.stringify(rack.name)} (${rack.rackId}).`);
    } else if(op.type==='ASSIGN_DEVICE') {
      const device=exact(draft.equipment.devices,op.device,'deviceId','device');
      const oldRack=draft.placements.find(r=>r.rackId===device.rackId);
      const rack=op.rack===null?null:exact(draft.placements,op.rack,'rackId','rack');
      if(rack? !Number.isSafeInteger(op.start_u)||op.start_u<1 : op.start_u!==null) reject('An installed device needs a positive integer start_u; unassignment needs rack:null and start_u:null.');
      changes.push(beforeAfter(`Assign device ${JSON.stringify(device.name)}`,{rack:oldRack?.name??null,startU:device.startU},{rack:rack?.name??null,startU:op.start_u}));
      device.rackId=rack?.rackId??null;device.startU=op.start_u;
    } else if(op.type==='ADD_DEVICE') {
      const quantity=op.quantity??1;
      if(!Number.isSafeInteger(quantity)||quantity<1||quantity>128) reject('Device quantity must be 1–128.');
      let values;
      if(op.catalog_model_id!==undefined) {
        if(['height_u','weight_kg','power_kw','cooling_kw'].some(k=>Object.hasOwn(op,k))) reject('Catalog specifications cannot be overridden; use custom device fields instead.');
        const model=resolveCatalogReference({modelId:op.catalog_model_id,version:op.catalog_version});
        values={...model.specification,catalogRef:{modelId:model.modelId,version:model.version}};
      } else {
        if(op.catalog_version!==undefined) reject('catalog_version requires catalog_model_id.');
        values={heightU:op.height_u,weightKg:op.weight_kg,powerKw:op.power_kw,coolingKw:op.cooling_kw};
      }
      for(let i=0;i<quantity;i++) draft.equipment.devices.push({deviceId:randomUUID(),name:quantity===1?op.name:`${op.name} ${i+1}`,...values,rackId:null,startU:null});
      changes.push(`Add ${quantity} unassigned device(s) ${JSON.stringify(op.name)}; ${op.catalog_model_id?'pinned catalog model':'explicit custom assumptions'}.`);
    } else if(op.type==='REMOVE_DEVICES') {
      const targets=targetsFor(draft.equipment.devices,op.devices,'deviceId','device');
      draft.equipment.devices=draft.equipment.devices.filter(d=>!targets.has(d.deviceId));
      changes.push(`Delete ${targets.size} device(s), including their installed assignments: ${op.devices.join(', ')}.`);
    } else if(op.type==='REMOVE_RACKS') {
      const targets=targetsFor(draft.placements,op.racks,'rackId','rack');
      if(op.unassign_devices!==undefined&&typeof op.unassign_devices!=='boolean') reject('unassign_devices must be boolean.');
      const installed=draft.equipment.devices.filter(d=>targets.has(d.rackId));
      if(installed.length&&!op.unassign_devices) reject('Racks contain devices. Explicitly request unassign_devices:true, or move/unassign them first.');
      for(const d of installed){d.rackId=null;d.startU=null;}
      draft.placements=draft.placements.filter(r=>!targets.has(r.rackId));
      draft.equipment.rackLimits=draft.equipment.rackLimits.filter(l=>!targets.has(l.rackId));
      changes.push(`Delete ${targets.size} rack(s); retain and unassign ${installed.length} installed device(s): ${op.racks.join(', ')}.`);
    } else if(op.type==='SET_RACK_LOCK') {
      const rack=exact(draft.placements,op.rack,'rackId','rack');
      if(typeof op.locked!=='boolean') reject('locked must be boolean.');
      changes.push(beforeAfter(`Position lock ${rack.name}`,rack.locked,op.locked));rack.locked=op.locked;
    } else if(op.type==='SET_RACK_LIMITS') {
      const rack=exact(draft.placements,op.rack,'rackId','rack');
      const old=draft.equipment.rackLimits.find(l=>l.rackId===rack.rackId)??null;
      const value=(v,k)=>v===null?null:finite(v,k,0,1000000);
      const next={rackId:rack.rackId,maxWeightKg:value(op.max_weight_kg,'max_weight_kg'),maxPowerKw:value(op.max_power_kw,'max_power_kw'),maxCoolingKw:value(op.max_cooling_kw,'max_cooling_kw')};
      draft.equipment.rackLimits=draft.equipment.rackLimits.filter(l=>l.rackId!==rack.rackId).concat(next);
      changes.push(beforeAfter(`Declared capacity ${rack.name} (kg/kW/kW)`,old,next));
    } else if(op.type==='SET_OBSTACLE') {
      const old=op.obstacle===undefined?null:exact(draft.constraints.obstacles,op.obstacle,'obstacleId','obstacle');
      const next={obstacleId:old?.obstacleId??randomUUID(),name:op.name,xM:finite(op.x_m,'x_m'),yM:finite(op.y_m,'y_m'),widthM:finite(op.width_m,'width_m',0.001,10000),depthM:finite(op.depth_m,'depth_m',0.001,10000)};
      draft.constraints.obstacles=draft.constraints.obstacles.filter(o=>o.obstacleId!==next.obstacleId).concat(next);
      changes.push(beforeAfter('Assumed exclusion zone (metres)',old,next));
    } else if(op.type==='REMOVE_OBSTACLES') {
      const targets=targetsFor(draft.constraints.obstacles,op.obstacles,'obstacleId','obstacle');
      draft.constraints.obstacles=draft.constraints.obstacles.filter(o=>!targets.has(o.obstacleId));
      changes.push(`Remove ${targets.size} assumed exclusion zone(s): ${op.obstacles.join(', ')}.`);
    } else if(op.type==='SET_CLEARANCE') {
      const next={frontM:finite(op.front_m,'front_m',0,10),rearM:finite(op.rear_m,'rear_m',0,10)};
      changes.push(beforeAfter('Front/rear maintenance clearance (m)',draft.constraints.clearance,next));draft.constraints.clearance=next;
    } else {
      const limit=(value,key)=>value===null?null:finite(value,key,0,1000000);
      const next={maxPowerKw:limit(op.max_power_kw,'max_power_kw'),maxCoolingKw:limit(op.max_cooling_kw,'max_cooling_kw'),source:{kind:'ASSUMED',reference:op.reference}};
      changes.push(beforeAfter('Assumed room budget (kW)',draft.equipment.roomBudget??null,next));draft.equipment.roomBudget=next;
    }
  }
  const entries=normalizeEditableLayout({placements:draft.placements,models:layout.models,projectId:layout.projectId,planId:layout.planId});
  const placements=entries.map(({placement:{planId,projectId,...placement}})=>placement);
  assertLockedRacksUnchanged(layout.placements,placements);
  const body={contract_version:1,snapshot_id:layout.snapshot.snapshotId,placements,
    constraints:normalizeSpatialConstraints(draft.constraints),equipment:normalizeEquipment(draft.equipment,placements)};
  if(isDeepStrictEqual({placements:layout.placements,constraints:layout.constraints,equipment:layout.equipment},{placements:body.placements,constraints:body.constraints,equipment:body.equipment})) reject('The requested operations do not change the saved plan.');
  return {body,changes};
}

function targetsFor(items,values,idKey,label) {
  if(!Array.isArray(values)||!values.length||values.length>128) reject(`Provide 1–128 exact ${label} targets.`);
  const ids=values.map(v=>exact(items,v,idKey,label)[idKey]);
  if(new Set(ids).size!==ids.length) reject('Batch targets must not contain duplicates.');
  return new Set(ids);
}

export function createRackAssistantEdits({pool,layouts,authorize}) {
  async function access(ctx) {
    if(!ctx.initiatedBy?.userId||!UUID.test(ctx.workspaceId??'')||!UUID.test(ctx.rackContext?.planId??'')) reject('Select a saved Rack plan first.','RACK_ASSISTANT_PLAN_REQUIRED',409);
    for(const key of ['rack.read','facility.read','rack.write']) if(!await authorize({key,userId:ctx.initiatedBy.userId,workspaceId:ctx.workspaceId})) reject('Rack edit and Facility read permissions are required.','ASSISTANT_FORBIDDEN',403);
    if(ctx.readOnly) reject('This source is read-only.','ASSISTANT_FORBIDDEN',403);
    if(ctx.rackContext.hasUnsavedDraft) reject('Save or discard the local draft before Assistant edits.','RACK_ASSISTANT_DIRTY_DRAFT',409);
  }
  async function current(ctx,transactionClient=null) {
    const layout=await layouts.get({projectId:ctx.workspaceId,planId:ctx.rackContext.planId,transactionClient});
    if(layout.scenarioId!==ctx.scenarioId||layout.facilityInput.revisionId!==ctx.revisionId) throw errors.notFound();
    return layout;
  }
  async function inspect(ctx,args,client=null,{allowReplay=false}={}) {
    await access(ctx);fields(args,['proposal_id']);
    if(!UUID.test(args.proposal_id??'')) reject('proposal_id must come from a successful preview.');
    const load=async db=>(await db.query(`SELECT *,expires_at<=now() AS expired FROM rack_assistant_proposals
      WHERE project_id=$1 AND plan_id=$2 AND created_by=$3 AND proposal_id=$4`,[ctx.workspaceId,ctx.rackContext.planId,ctx.initiatedBy.userId,args.proposal_id])).rows[0];
    const row=client?await load(client):await withTenant(pool,ctx.workspaceId,load,{readOnly:true});
    if(!row) throw errors.notFound('Assistant edit proposal not found.');
    const layout=await current(ctx,client);
    if(row.applied_version!==null && allowReplay) return {row,layout};
    if(row.applied_version!==null) reject('This proposal was already applied.','RACK_PROPOSAL_APPLIED',409);
    if(row.expired) reject('This edit preview expired. Generate a new preview.','RACK_PROPOSAL_EXPIRED',409);
    if(layout.version!==row.base_version||ctx.rackContext.version!==layout.version||
      (ctx.rackContext.clientVersion!=null&&ctx.rackContext.clientVersion!==layout.version)) reject('The saved plan changed. Refresh and preview again.','RACK_VERSION_CONFLICT',412);
    if(layout.snapshot?.snapshotId!==row.snapshot_id||layout.sourceStatus.status!=='UNCHANGED') reject('The fixed input or Facility source changed.','RACK_SOURCE_STALE',409);
    return {row,layout};
  }
  async function prepare(ctx,baseVersion) {
      await access(ctx);
      const layout=await current(ctx);
      if(!Number.isSafeInteger(baseVersion)||baseVersion!==layout.version||ctx.rackContext.version!==layout.version||
        (ctx.rackContext.clientVersion!=null&&ctx.rackContext.clientVersion!==layout.version)) reject('Read the current saved version before previewing edits.','RACK_VERSION_CONFLICT',412);
      if(!layout.snapshot) reject('The room has no supported fixed boundary snapshot. Configure/capture the room boundary before layout edits.','RACK_SNAPSHOT_REQUIRED',409);
      if(layout.sourceStatus.status!=='UNCHANGED') reject('Unchanged fixed room inputs are required.','RACK_SOURCE_STALE',409);
      return layout;
  }
  async function propose(ctx,layout,body,changes) {
      assertLockedRacksUnchanged(layout.placements,body.placements);
      if(isDeepStrictEqual({placements:layout.placements,constraints:layout.constraints,equipment:layout.equipment},
        {placements:body.placements,constraints:body.constraints,equipment:body.equipment}))
        return {canApply:false,persisted:false,changes:[],reason:'The candidate makes no changes to the saved Plan.',validationState:'NOT_RUN'};
      const checks=await layouts.check({projectId:ctx.workspaceId,planId:layout.planId,body});
      if(checks.report.diagnostics.length||checks.equipmentReport.diagnostics.length)
        return {canApply:false,persisted:false,changes,...checks,validationState:'NOT_RUN'};
      const row=await withTenant(pool,ctx.workspaceId,async client=>{
        const p=(await client.query('SELECT version,deleted_at FROM rack_plans WHERE project_id=$1 AND plan_id=$2 FOR UPDATE',[ctx.workspaceId,layout.planId])).rows[0];
        if(!p||p.deleted_at||p.version!==layout.version) reject('The plan changed during preview. Read and preview again.','RACK_VERSION_CONFLICT',412);
        return (await client.query(`INSERT INTO rack_assistant_proposals(proposal_id,project_id,plan_id,created_by,base_version,snapshot_id,save_body,changes,command_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING proposal_id,expires_at`,
        [randomUUID(),ctx.workspaceId,layout.planId,ctx.initiatedBy.userId,layout.version,layout.snapshot.snapshotId,JSON.stringify(body),JSON.stringify(changes),randomUUID()])).rows[0];
      });
      return {canApply:true,persisted:false,planId:layout.planId,proposalId:row.proposal_id,expiresAt:row.expires_at,baseVersion:layout.version,changes,
        report:checks.report,equipmentReport:checks.equipmentReport,validationState:'NOT_RUN',nextStep:'Explain the exact changes and incomplete scope, then call rack_apply_changes with this proposal_id. The user must confirm before any layout is saved.'};
  }
  return {
    async preview(ctx,args) {
      fields(args,['base_version','operations']);
      const layout=await prepare(ctx,args.base_version);
      const {body,changes}=buildRackAssistantEdit(layout,args.operations);
      return propose(ctx,layout,body,changes);
    },
    async previewGenerated(ctx,args) {
      fields(args,['base_version','kind','options','demand','candidate_index','allow_partial']);
      const layout=await prepare(ctx,args.base_version);
      if(args.candidate_index!==undefined&&(!Number.isSafeInteger(args.candidate_index)||args.candidate_index<0||args.candidate_index>1)) reject('candidate_index must be 0 or 1.');
      if(args.allow_partial!==undefined&&typeof args.allow_partial!=='boolean') reject('allow_partial must be boolean.');
      const request={projectId:ctx.workspaceId,planId:layout.planId,body:{contract_version:1,base_version:layout.version,snapshot_id:layout.snapshot.snapshotId}};
      let generated;
      if(args.kind==='DESIGN') {
        if(args.options!==undefined) reject('DESIGN accepts demand, not relocation options.');
        request.body.demand=args.demand;generated=await layouts.designOptions(request);
      } else if(args.kind==='RELOCATE') {
        if(args.demand!==undefined) reject('RELOCATE does not accept demand.');
        request.body.options=args.options??{};generated=await layouts.options(request);
      } else if(args.kind==='ALLOCATE') {
        if(args.options!==undefined||args.demand!==undefined) reject('ALLOCATE only accepts saved inventory.');
        generated=await layouts.equipmentOptions(request);
      } else reject('kind must be DESIGN, RELOCATE or ALLOCATE.');
      const candidates=generated.candidates.map((c,i)=>({index:i,algorithmId:c.algorithmId,canApply:c.canStage,metrics:c.metrics,
        unplaced:(c.unplaced??[]).slice(0,16),remainingUnassigned:(c.unassigned??[]).slice(0,16),remainingCount:(c.unassigned??[]).length}));
      const index=args.candidate_index??generated.candidates.findIndex(c=>c.canStage&&(args.allow_partial||!c.unassigned?.length));
      const candidate=generated.candidates[index];
      if(!candidate||!candidate.canStage||(!args.allow_partial&&candidate.unassigned?.length))
        return {canApply:false,persisted:false,candidates,reason:'Candidate blocked, missing, or partial. Review findings; partial allocation requires explicit allow_partial:true.',validationState:'NOT_RUN'};
      if(args.kind==='DESIGN') candidate.body.placements=candidate.body.placements.map(p=>({...p,locked:true}));
      const proposal=await propose(ctx,layout,candidate.body,[`Apply ${args.kind} candidate ${index}, algorithm ${candidate.algorithmId}; ${candidate.body.placements.length} racks, ${candidate.body.equipment.devices.length} devices.`,
        `Remaining unassigned from this allocation: ${candidate.unassigned?.length??0}. Declared rule checks only; no global optimality or engineering certification.`]);
      return {...proposal,candidates,inputFingerprint:generated.inputFingerprint,scope:generated.scope};
    },
    async confirmable(ctx,args) {await inspect(ctx,args);},
    async describe(ctx,args) {
      const {row}=await inspect(ctx,args);
      return `Save these changes to Rack plan ${row.plan_id}, version ${row.base_version}: ${row.changes.join(' ')} Checks cover declared rules only; unknown/unchecked scope remains. This saves the plan.`;
    },
    async apply(ctx,args) {
      await access(ctx);fields(args,['proposal_id']);
      return withTenant(pool,ctx.workspaceId,async client=>{
        await client.query('SELECT plan_id FROM rack_plans WHERE project_id=$1 AND plan_id=$2 FOR UPDATE',[ctx.workspaceId,ctx.rackContext.planId]);
        const {row,layout}=await inspect(ctx,args,client,{allowReplay:true});
        if(row.applied_version!==null) return {persisted:true,replayed:true,planId:row.plan_id,appliedVersion:row.applied_version,currentVersion:layout.version,changes:row.changes};
        const result=await layouts.mutate({projectId:ctx.workspaceId,planId:row.plan_id,actorId:ctx.initiatedBy.userId,body:row.save_body,
          key:row.command_key,ifMatch:`"${row.base_version}"`,operation:'save',transactionClient:client});
        await client.query('UPDATE rack_assistant_proposals SET applied_version=$2,applied_at=now() WHERE proposal_id=$1',[row.proposal_id,result.appliedVersion]);
        return {persisted:true,replayed:result.replayed,projectId:ctx.workspaceId,planId:row.plan_id,appliedVersion:result.appliedVersion,
          currentVersion:result.layout.version,changes:row.changes,validationState:'NOT_RUN',nextStep:'The plan was saved. Report this applied version and stop further edits in this turn.'};
      });
    },
  };
}
