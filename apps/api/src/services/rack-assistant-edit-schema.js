const number={type:'number'},text={type:'string'},nullableNumber={type:['number','null']};
const target={type:'string',description:'Exact saved object name or UUID from a read tool.'};
const quantity={type:'integer',minimum:1,maximum:128};
const targets={type:'array',items:target,minItems:1,maxItems:128};
const rotation={type:'integer',enum:[0,90,180,270]};
function operation(type,properties,required,description){
  return {type:'object',additionalProperties:false,properties:{type:{type:'string',enum:[type]},...properties},required:['type',...required],description};
}

// Each branch exposes only fields valid for that operation. A flat union makes
// compatible gateways fill irrelevant fields and then fail the runtime contract.
export const rackEditOperationSchema={anyOf:[
  operation('MOVE_RACK',{rack:target,x_m:number,y_m:number,rotation_deg:rotation},['rack','x_m','y_m'],'Move an already unlocked rack; coordinates are metres.'),
  operation('ADD_RACK',{model_id:text,name:text,x_m:number,y_m:number,rotation_deg:rotation,locked:{type:'boolean'},quantity,columns:{type:'integer',minimum:1,maximum:128},step_x_m:number,step_y_m:number},['model_id','name','x_m','y_m'],'Add racks using a model_id from rack_read_plan. locked defaults true. Batch quantity >1 needs columns and step_x_m/step_y_m in metres; a step may be zero only on an unused axis. Positions are rack centres. Do not include device, obstacle or capacity fields.'),
  operation('REMOVE_RACK',{rack:target},['rack'],'Remove one empty, already unlocked rack.'),
  operation('ASSIGN_DEVICE',{device:target,rack:{type:['string','null']},start_u:{type:['integer','null']}},['device','rack','start_u'],'Assign a device to a rack/U position; use rack:null,start_u:null to unassign.'),
  operation('SET_CLEARANCE',{front_m:number,rear_m:number},['front_m','rear_m'],'Set front/rear maintenance clearance in metres.'),
  operation('SET_ROOM_BUDGET',{max_power_kw:nullableNumber,max_cooling_kw:nullableNumber,reference:text},['max_power_kw','max_cooling_kw','reference'],'Set an explicitly assumed room budget; null means unknown.'),
  operation('ADD_DEVICE',{name:text,quantity,catalog_model_id:text,catalog_version:{type:'integer'}},['name','catalog_model_id','catalog_version'],'Add unassigned devices from a pinned catalog model. Do not include custom specifications.'),
  operation('ADD_DEVICE',{name:text,quantity,height_u:{type:'integer'},weight_kg:nullableNumber,power_kw:nullableNumber,cooling_kw:nullableNumber},['name','height_u','weight_kg','power_kw','cooling_kw'],'Add unassigned devices using explicit custom specifications; null means unknown. Do not include catalog fields.'),
  operation('REMOVE_DEVICES',{devices:targets},['devices'],'Delete the exact listed devices, including their assignments.'),
  operation('REMOVE_RACKS',{racks:targets,unassign_devices:{type:'boolean'}},['racks'],'Remove already unlocked racks; occupied racks require explicit unassign_devices:true.'),
  operation('SET_RACK_LOCK',{rack:target,locked:{type:'boolean'}},['rack','locked'],'Set a position lock. Unlock must be saved separately before move/delete.'),
  operation('SET_RACK_LIMITS',{rack:target,max_weight_kg:nullableNumber,max_power_kw:nullableNumber,max_cooling_kw:nullableNumber},['rack','max_weight_kg','max_power_kw','max_cooling_kw'],'Set per-rack declared capacity; null means unknown.'),
  operation('SET_OBSTACLE',{obstacle:target,name:text,x_m:number,y_m:number,width_m:number,depth_m:number},['name','x_m','y_m','width_m','depth_m'],'Create an assumed exclusion zone; include obstacle only to update an existing exact zone.'),
  operation('REMOVE_OBSTACLES',{obstacles:targets},['obstacles'],'Remove the exact listed assumed zones.'),
]};
