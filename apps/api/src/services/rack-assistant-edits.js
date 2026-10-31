import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { normalizeEditableLayout, normalizeEquipment, normalizeSpatialConstraints, assertLockedRacksUnchanged } from '@ai-infra/rack';

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
    const allowed={MOVE_RACK:['type','rack','x_m','y_m','rotation_deg'],ADD_RACK:['type','model_id','name','x_m','y_m','rotation_deg'],
      REMOVE_RACK:['type','rack'],ASSIGN_DEVICE:['type','device','rack','start_u'],SET_CLEARANCE:['type','front_m','rear_m'],
      SET_ROOM_BUDGET:['type','max_power_kw','max_cooling_kw','reference']}[op?.type];
    if(!allowed) reject('Unsupported edit operation.'); fields(op,allowed);
    if(op.type==='ADD_RACK') {
      const model=layout.models.find(m=>m.modelId===op.model_id);
      if(!model) reject('Use a rack model identifier returned by rack_read_plan.');
      const rack={rackId:randomUUID(),modelId:model.modelId,name:op.name,xM:finite(op.x_m,'x_m'),yM:finite(op.y_m,'y_m'),rotationDeg:op.rotation_deg??0,locked:false};
      draft.placements.push(rack);changes.push(`Add rack ${JSON.stringify(rack.name)}: model ${model.modelId}, centre (${rack.xM}, ${rack.yM}) m, ${rack.rotationDeg} degrees.`);
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

export function createRackAssistantEdits({pool,layouts,authorize}) {
  async function access(ctx) {
    if(!ctx.initiatedBy?.userId||!UUID.test(ctx.workspaceId??'')||!UUID.test(ctx.rackContext?.planId??'')) reject('Select a saved Rack plan first.','RACK_ASSISTANT_PLAN_REQUIRED',409);
    for(const key of ['rack.read','facility.read','rack.write']) if(!await authorize({key,userId:ctx.initiatedBy.userId,workspaceId:ctx.workspaceId})) reject('Rack edit and Facility read permissions are required.','ASSISTANT_FORBIDDEN',403);
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
  return {
    async preview(ctx,args) {
      await access(ctx);fields(args,['base_version','operations']);
      const layout=await current(ctx);
      if(!Number.isSafeInteger(args.base_version)||args.base_version!==layout.version||ctx.rackContext.version!==layout.version||
        (ctx.rackContext.clientVersion!=null&&ctx.rackContext.clientVersion!==layout.version)) reject('Read the current saved version before previewing edits.','RACK_VERSION_CONFLICT',412);
      if(!layout.snapshot||layout.sourceStatus.status!=='UNCHANGED') reject('Unchanged fixed room inputs are required.','RACK_SOURCE_STALE',409);
      const {body,changes}=buildRackAssistantEdit(layout,args.operations);
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
      return {canApply:true,persisted:false,proposalId:row.proposal_id,expiresAt:row.expires_at,baseVersion:layout.version,changes,
        report:checks.report,equipmentReport:checks.equipmentReport,validationState:'NOT_RUN',nextStep:'Explain the exact changes and incomplete scope, then call rack_apply_changes with this proposal_id. The user must confirm before any layout is saved.'};
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
