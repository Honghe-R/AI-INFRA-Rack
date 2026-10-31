import { createHash } from 'node:crypto';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { getRackCatalog } from '@ai-infra/rack';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(message,status=400,code='RACK_AGENT_INPUT_INVALID')=>{throw new ApiError(code,message,{status});};
const schema=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
function retryKey(ctx,kind,args) {
  const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
  const h=createHash('sha256').update(JSON.stringify([ctx.initiatedBy.userId,ctx.workspaceId,ctx.scenarioId,ctx.revisionId,kind,ordered(args)])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function createRackRoomReader({pool}) {
  return ctx=>withTenant(pool,ctx.workspaceId,async client=>(await client.query(
    `SELECT c.container_id AS "roomId",c.name,e.etag AS "sourceEtag",r.lifecycle_state AS "sourceState"
     FROM facility_containers c JOIN revisions r ON r.project_id=c.project_id AND r.revision_id=c.revision_id
     LEFT JOIN revision_etags e ON e.project_id=c.project_id AND e.revision_id=c.revision_id
     WHERE c.project_id=$1 AND c.scenario_id=$2 AND c.revision_id=$3 AND c.kind='HALL'
     ORDER BY c.container_id LIMIT 501`,[ctx.workspaceId,ctx.scenarioId,ctx.revisionId])).rows,{readOnly:true});
}

export function createRackAgentActions({plans,rooms,authorize}) {
  async function access(ctx,keys,write=false) {
    if(!UUID.test(ctx.workspaceId??'')||!ctx.initiatedBy?.userId) throw errors.unauthorized();
    for(const key of ['rack.read','facility.read',...keys]) if(!await authorize({key,userId:ctx.initiatedBy.userId,workspaceId:ctx.workspaceId}))
      fail('Your account does not have permission for this Rack operation.',403,'ASSISTANT_FORBIDDEN');
    if(write&&(ctx.readOnly||ctx.rackContext?.hasUnsavedDraft))
      fail('Read-only source or unsaved local draft: save/discard the draft before making changes.',409,'RACK_ASSISTANT_DIRTY_DRAFT');
    if(!UUID.test(ctx.scenarioId??'')||!UUID.test(ctx.revisionId??'')) fail('Open a scenario/revision first.');
  }
  const capabilities=[];
  function add(name,description,properties,required,keys,write,handler,describe=null,confirmable=null) {
    capabilities.push({name,description,inputSchema:schema(properties,required),access:write?'write':'read',confirmation:write?'required':'none',
      surfaces:['rack'],requiredFunctions:['rack.read','facility.read',...keys],describe,confirmable,
      handler:async(ctx,args)=>{
        if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(properties,k))) fail('Unexpected Rack operation arguments.');
        await access(ctx,keys,write);return handler(ctx,args);
      }});
  }
  add('rack_get_catalog','Read device model IDs/versions/specifications for adding inventory or demand design. All examples are synthetic assumptions.',{},[],[],false,async()=>getRackCatalog());
  add('rack_list_rooms','List up to 20 HALL rooms and current Facility source tokens for Plan creation. Names/IDs and sourceEtag come from this tool.',
    {offset:{type:'integer',minimum:0}},[],[],false,async(ctx,args)=>{
      const offset=args.offset??0;
      if(!Number.isSafeInteger(offset)||offset<0||offset>500) fail('offset must be 0–500.');
      const all=await rooms(ctx);
      return {items:all.slice(offset,offset+20),nextOffset:offset+20<all.length?offset+20:null,truncated:all.length>500};
    });
  async function creation(ctx,args) {
    await access(ctx,['rack.write'],true);
    if(typeof args.name!=='string'||!args.name.trim()||args.name.length>160) fail('Provide a Plan name of 1–160 characters.');
    const matches=(await rooms(ctx)).filter(r=>r.roomId===args.room||r.name===args.room);
    if(matches.length!==1) fail('Choose one exact room name/ID from rack_list_rooms.',409);
    if(typeof args.source_etag!=='string'||args.source_etag!==matches[0].sourceEtag) fail('Facility source changed; read rooms and confirm again.',409,'RACK_SOURCE_STALE');
    if(matches[0].sourceState!=='DRAFT') fail('New Plans require a draft Facility source.',409);
    return matches[0];
  }
  add('rack_create_plan','Create a saved empty Plan in a listed HALL using its exact source_etag. Confirmation applies; room capture is done by the normal service. Use returned planId for subsequent reads/previews.',
    {name:{type:'string'},room:{type:'string'},source_etag:{type:'string'}},['name','room','source_etag'],['rack.write'],true,async(ctx,args)=>{
      const room=await creation(ctx,args);
      const result=await plans.create({projectId:ctx.workspaceId,actorId:ctx.initiatedBy.userId,creationKey:retryKey(ctx,'create',args),
        body:{contract_version:1,name:args.name,scenario_id:ctx.scenarioId,facility_input:{revision_id:ctx.revisionId,container_id:room.roomId,revision_etag:args.source_etag}}});
      return {persisted:true,planId:result.plan.planId,name:result.plan.name,appliedVersion:result.plan.version,replayed:result.replayed,
        nextStep:'Use returned planId in plan_id for read/preview/design tools. An empty Plan was created; no racks or devices have been added.'};
    },async(ctx,args)=>{const room=await creation(ctx,args);return `Create empty Rack Plan ${JSON.stringify(args.name)} in ${room.name}.`;},creation);
  for(const operation of ['rename','delete','restore']) {
    const key=operation==='rename'?'rack.write':`rack.${operation}`;
    async function inspect(ctx,args) {
      await access(ctx,[key],true);
      const planId=args.plan_id??ctx.rackContext?.planId;
      if(!UUID.test(planId??'')) fail('Choose a Plan or provide plan_id from a read tool.');
      if(!Number.isSafeInteger(args.base_version)||args.base_version<1) fail('Read the current Plan base_version first.');
      if(operation==='rename'&&(typeof args.name!=='string'||!args.name.trim()||args.name.length>160)) fail('Provide a Plan name of 1–160 characters.');
      const plan=await plans.get({projectId:ctx.workspaceId,planId});
      if(plan.scenarioId!==ctx.scenarioId||plan.facilityInput.revisionId!==ctx.revisionId) throw errors.notFound();
      return plan;
    }
    const properties={plan_id:{type:'string',format:'uuid'},base_version:{type:'integer',minimum:1},...(operation==='rename'?{name:{type:'string'}}:{})};
    add(`rack_${operation}_plan`,`${operation} a saved Rack Plan. Requires ${key}; supply version from a read. Delete is recoverable soft deletion, restore reactivates it. No device rows are individually purged.`,
      properties,['base_version',...(operation==='rename'?['name']:[])],[key],true,async(ctx,args)=>{
        const plan=await inspect(ctx,args);
        const result=await plans.manage({projectId:ctx.workspaceId,planId:plan.planId,actorId:ctx.initiatedBy.userId,operation,
          key:retryKey(ctx,operation,{...args,plan_id:plan.planId}),ifMatch:`"${args.base_version}"`,body:{contract_version:1,...(operation==='rename'?{name:args.name}:{})}});
        return {persisted:true,planId:result.plan.planId,name:result.plan.name,deleted:result.plan.deletedAt!==null,
          appliedVersion:result.appliedVersion,replayed:result.replayed,nextStep:'Report this saved lifecycle result. Read again before a further mutation.'};
      },async(ctx,args)=>{const p=await inspect(ctx,args);return `${operation} Rack Plan ${JSON.stringify(p.name)}, saved version ${args.base_version}${operation==='rename'?` → ${JSON.stringify(args.name)}`:''}.`;},
      async(ctx,args)=>{const p=await inspect(ctx,args);if(p.version!==args.base_version) fail('The Plan changed. Read and review again.',412,'RACK_VERSION_CONFLICT');});
  }
  return {capabilities};
}

/** Optional target changes only the Plan inside the already authorized project/revision. */
export function targetRackCapabilities(capabilities,{layouts,authorize}) {
  const targets=new Set(['rack_read_plan','rack_query_capacity','rack_check_saved_layout','rack_generate_layout_options','rack_preview_changes','rack_preview_automatic_design','rack_apply_changes']);
  async function bind(ctx,args,capability,method) {
    if(!args||typeof args!=='object'||!Object.hasOwn(args,'plan_id')) return method(ctx,args);
    const {plan_id:planId,...rest}=args;
    if(!UUID.test(planId??'')) fail('plan_id must come from a scoped read tool.');
    for(const key of capability.requiredFunctions) if(!await authorize({key,userId:ctx.initiatedBy?.userId,workspaceId:ctx.workspaceId}))
      fail('Your account does not have permission for this Rack operation.',403,'ASSISTANT_FORBIDDEN');
    const layout=await layouts.get({projectId:ctx.workspaceId,planId});
    if(layout.scenarioId!==ctx.scenarioId||layout.facilityInput.revisionId!==ctx.revisionId) throw errors.notFound();
    const selected=ctx.rackContext?.planId===planId;
    return method({...ctx,rackContext:selected?ctx.rackContext:{planId,version:layout.version,clientVersion:layout.version,hasUnsavedDraft:ctx.rackContext?.hasUnsavedDraft===true}},rest);
  }
  return capabilities.map(c=>!targets.has(c.name)?c:{...c,
    inputSchema:{...c.inputSchema,properties:{...c.inputSchema.properties,plan_id:{type:'string',format:'uuid',description:'Optional Plan from scoped read/create; defaults to selected Plan.'}}},
    handler:(ctx,args)=>bind(ctx,args,c,c.handler),
    ...(c.describe?{describe:(ctx,args)=>bind(ctx,args,c,c.describe)}:{}),
    ...(c.confirmable?{confirmable:(ctx,args)=>bind(ctx,args,c,c.confirmable)}:{})});
}
