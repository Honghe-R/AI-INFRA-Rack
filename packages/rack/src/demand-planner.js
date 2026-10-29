import { record, fail, text, uuid } from './input.js';
import { resolveCatalogReference } from './catalog.js';
import { normalizeSpatialConstraints } from './constraints.js';
import { normalizeEquipment, CAPACITY_DIMENSIONS } from './equipment.js';
import { normalizeRoomBudget, exceedsResource, resourceDemand } from './room-budget.js';
import { plannerGeometry, layoutMetrics } from './planner.js';

export const DEMAND_LIMITS = Object.freeze({ groups: 16, devices: 128, racks: 32, arrangements: 256, batchSize: 16 });
export function normalizeDesignDemand(input) {
  record(input, 'demand', new Set(['groups','rackModelId','maxRacks','rackLimits','sourceReference','gapM','constraints','roomBudget']));
  if (!Array.isArray(input.groups) || !input.groups.length || input.groups.length > DEMAND_LIMITS.groups)
    fail('demand.groups', 'requires 1 to 16 model/quantity groups');
  let count = 0;
  const keys = new Set();
  const groups = input.groups.map(g => {
    record(g, 'demand.group', new Set(['modelId','version','quantity']));
    const model = resolveCatalogReference({modelId:g.modelId,version:g.version});
    if (!Number.isSafeInteger(g.quantity) || g.quantity < 1 || g.quantity > DEMAND_LIMITS.devices)
      fail('demand.quantity', 'must be an integer from 1 to 128');
    const key = `${model.modelId}@${model.version}`;
    if (keys.has(key)) fail('demand.groups', 'combine duplicate model versions into one group');
    keys.add(key); count += g.quantity;
    return Object.freeze({modelId:model.modelId,version:model.version,quantity:g.quantity});
  });
  if (count > DEMAND_LIMITS.devices) fail('demand.groups', 'supports at most 128 devices in total');
  if (!Number.isSafeInteger(input.maxRacks) || input.maxRacks < 1 || input.maxRacks > DEMAND_LIMITS.racks)
    fail('demand.maxRacks', 'must be an integer from 1 to 32');
  record(input.rackLimits, 'demand.rackLimits', new Set(CAPACITY_DIMENSIONS.map(([,k]) => k)));
  const limits = {};
  for (const [,key] of CAPACITY_DIMENSIONS) {
    const value = input.rackLimits[key];
    if (!Number.isFinite(value) || value < 0 || value > 1000000)
      fail(`demand.rackLimits.${key}`, 'requires an explicit finite limit from 0 to 1000000');
    limits[key] = value;
  }
  if (!Number.isFinite(input.gapM) || input.gapM < 0 || input.gapM > 5) fail('demand.gapM','must be from 0 to 5 metres');
  return Object.freeze({groups:Object.freeze(groups),rackModelId:uuid(input.rackModelId,'demand.rackModelId'),
    maxRacks:input.maxRacks,rackLimits:Object.freeze(limits),gapM:input.gapM,
    sourceReference:text(input.sourceReference,'demand.sourceReference',512),
    ...(Object.hasOwn(input,'constraints') ? {constraints:normalizeSpatialConstraints(input.constraints)} : {}),
    ...(Object.hasOwn(input,'roomBudget') ? {roomBudget:normalizeRoomBudget(input.roomBudget)} : {})});
}

function pack(devices, model, demand, strategy, makeId) {
  const bins = [], assignments = new Map(), unplaced = [];
  const limits = Object.fromEntries(CAPACITY_DIMENSIONS.map(([,key]) => [key,
    model[key] === null || model[key] === undefined ? demand.rackLimits[key] : Math.min(model[key],demand.rackLimits[key])]));
  const dimensions = [['heightU','heightU'], ...CAPACITY_DIMENSIONS];
  const cap = {...limits,heightU:model.heightU};
  const score = d => Math.max(...dimensions.map(([key,max]) => d[key] === null ? Infinity : cap[max] === 0 ? d[key] === 0 ? 0 : Infinity : d[key]/cap[max]));
  const queue = devices.map((d,index) => ({d,index}));
  if (strategy === 'DOMINANT_BEST_FIT') queue.sort((a,b) => score(b.d)-score(a.d) || a.index-b.index);
  for (const {d} of queue) {
    let reason = CAPACITY_DIMENSIONS.some(([key]) => d[key] === null) ? 'UNKNOWN_DEVICE_DEMAND' : null;
    if (!reason && dimensions.some(([key,max]) => exceedsResource(d[key],cap[max]))) reason = 'DEVICE_EXCEEDS_RACK';
    if (reason) { unplaced.push({deviceId:d.deviceId,code:reason,message:'Device retained in inventory; known demands and sufficient single-rack capacity are required.'}); continue; }
    const fits = bin => dimensions.every(([key,max]) => !exceedsResource(bin.used[key]+d[key],cap[max]));
    let available = bins.filter(fits);
    if (strategy === 'DOMINANT_BEST_FIT') available.sort((a,b) => {
      const remainder = bin => dimensions.reduce((sum,[key,max]) => sum + (cap[max] === 0 ? 0 : (cap[max]-bin.used[key]-d[key])/cap[max]),0);
      return remainder(a)-remainder(b) || a.index-b.index;
    });
    let bin = available[0];
    if (!bin && bins.length < demand.maxRacks) {
      bin = {index:bins.length,rackId:makeId('rack',bins.length),used:{heightU:0,weightKg:0,powerKw:0,coolingKw:0}};
      bins.push(bin);
    }
    if (!bin) { unplaced.push({deviceId:d.deviceId,code:'RACK_COUNT_LIMIT',message:'No capacity in the selected rack count; increase the limit or revise equipment/limits.'}); continue; }
    assignments.set(d.deviceId,{rackId:bin.rackId,startU:bin.used.heightU+1});
    for (const [key] of dimensions) bin.used[key] += d[key];
  }
  return {bins,limits,unplaced,devices:devices.map(d => ({...d,...assignments.get(d.deviceId)}))};
}

// Build non-overlapping compact matrices, then translate complete arrangements.
// Bounds propose positions only: the injected adapter checks the real Polygon.
function shapesFor(placements, model, constraints, gap) {
  const result = [], front = constraints.clearance?.frontM ?? 0, rear = constraints.clearance?.rearM ?? 0;
  // Requested gap is a minimum. A micrometre separates numerically coincident
  // footprints at zero; no checker tolerance or engineering clearance is waived.
  const spacingGap=Math.max(gap,0.000001);
  for (let cols=1; cols<=placements.length; cols++) for (const rotationDeg of [0,90]) {
    const shapes = placements.map((p,i) => {
      const x=(i%cols)*(model.widthM+spacingGap), y=Math.floor(i/cols)*(model.depthM+front+rear+spacingGap);
      return plannerGeometry({...p,xM:rotationDeg ? -y : x,yM:rotationDeg ? x : y,rotationDeg},model,constraints.clearance);
    });
    const points = shapes.flatMap(s => [s.geometry,...s.bands].flatMap(g=>g.coordinates[0]));
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    const minX=Math.min(...xs),minY=Math.min(...ys),width=Math.max(...xs)-minX,depth=Math.max(...ys)-minY;
    const bounds=shapes.map(s=>s.bounds);
    const rackWidth=Math.max(...bounds.map(b=>b.maxX))-Math.min(...bounds.map(b=>b.minX));
    const rackDepth=Math.max(...bounds.map(b=>b.maxY))-Math.min(...bounds.map(b=>b.minY));
    result.push({shapes,minX,minY,width,depth,cols,rotationDeg,rackArea:rackWidth*rackDepth,rackSpan:Math.max(rackWidth,rackDepth)});
  }
  // Rank the same rack-envelope metric shown to the user. Including clearance
  // in this score can wrongly prefer a long thin column over a tighter row.
  return result.sort((a,b)=>a.rackArea-b.rackArea || a.rackSpan-b.rackSpan || a.cols-b.cols || a.rotationDeg-b.rotationDeg);
}
function translate(shape, x, y, model, clearance) {
  const entries = shape.shapes.map(s => plannerGeometry({...s.placement,xM:s.placement.xM+x,yM:s.placement.yM+y},model,clearance));
  // A GeometryCollection stays valid when zero-gap footprints share an edge;
  // a MultiPolygon with shared boundary segments is invalid under OGC rules.
  return {placements:entries.map(s=>s.placement),geometry:{type:'GeometryCollection',geometries:entries.map(s=>s.geometry)},bands:entries.flatMap(s=>s.bands)};
}
async function locate(placements, model, boundary, constraints, gap, pickArrangement) {
  if (!placements.length) return {placements,found:true,positionsSubmitted:0};
  const points = boundary.coordinates[0],xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const x0=Math.min(...xs),y0=Math.min(...ys),x1=Math.max(...xs),y1=Math.max(...ys);
  const shapes=shapesFor(placements,model,constraints,gap).filter(s=>s.width<=x1-x0 && s.depth<=y1-y0);
  let submitted=0,batch=[],last=null;
  // Center/corners first, then an evenly spaced 8x8 translation sample, with
  // fair round-robin across column counts/orientations before the global cap.
  const fractions=[[.5,.5],[0,0],[1,0],[0,1],[1,1]];
  for(let iy=0;iy<8;iy++)for(let ix=0;ix<8;ix++)fractions.push([ix/7,iy/7]);
  async function flush() {
    if (!batch.length) return null;
    submitted+=batch.length;
    const index=await pickArrangement(batch);
    if(index!==null && (!Number.isInteger(index)||index<0||index>=batch.length))throw new Error('Invalid arrangement adapter result');
    const found=index===null ? null : batch[index]; batch=[]; return found;
  }
  for(const [fx,fy] of fractions) for(const shape of shapes) {
    if(submitted+batch.length>=DEMAND_LIMITS.arrangements)break;
    last=translate(shape,x0-shape.minX+fx*(x1-x0-shape.width),y0-shape.minY+fy*(y1-y0-shape.depth),model,constraints.clearance);
    batch.push(last);
    if(batch.length===DEMAND_LIMITS.batchSize) {const found=await flush();if(found)return {...found,found:true,positionsSubmitted:submitted};}
  }
  const found=await flush();
  return found ? {...found,found:true,positionsSubmitted:submitted} : {placements:last?.placements ?? placements,found:false,positionsSubmitted:submitted};
}

/** Pure deterministic demand expansion, multi-resource bin packing and bounded
 * compact geometry search. Caller provides stable IDs and authoritative IO. */
export async function generateDemandOptions({projectId,planId,demand:input,models,boundary,constraints:savedConstraints,roomBudget:savedBudget,makeId,pickArrangement}) {
  const demand=normalizeDesignDemand(input),model=models.find(m=>m.modelId===demand.rackModelId);
  if(!model)fail('demand.rackModelId','must reference a server rack model');
  const constraints=demand.constraints ?? normalizeSpatialConstraints(savedConstraints);
  const roomBudget=Object.hasOwn(demand,'roomBudget') ? demand.roomBudget : savedBudget ?? null;
  const source={kind:'ASSUMED',reference:demand.sourceReference};
  const devices=[];
  for(const group of demand.groups) {
    const catalog=resolveCatalogReference({modelId:group.modelId,version:group.version});
    for(let i=0;i<group.quantity;i++)devices.push({deviceId:makeId('device',devices.length),name:`${catalog.name} ${i+1}`,
      ...catalog.specification,catalogRef:{modelId:catalog.modelId,version:catalog.version},rackId:null,startU:null});
  }
  const candidates=[];
  for(const strategy of ['INPUT_FIRST_FIT','DOMINANT_BEST_FIT']) {
    const packed=pack(devices,model,demand,strategy,makeId);
    const initial=packed.bins.map((bin,i)=>({projectId,planId,rackId:bin.rackId,modelId:model.modelId,name:`Rack ${String(i+1).padStart(2,'0')}`,
      xM:i*(model.widthM+demand.gapM),yM:0,rotationDeg:0,locked:false}));
    const located=await locate(initial,model,boundary,constraints,demand.gapM,pickArrangement);
    const unplaced=[...packed.unplaced];
    if(!located.found)unplaced.push({code:'NO_COMPACT_LAYOUT',message:'No complete compact arrangement accepted within the finite search. This does not prove infeasibility; try other constraints or manual layout.'});
    for(const [key,max] of [['powerKw','maxPowerKw'],['coolingKw','maxCoolingKw']]) if(roomBudget) {
      const total=resourceDemand(devices,key);
      if(roomBudget[max]===null || total.total===null)unplaced.push({code:'UNKNOWN_ROOM_BUDGET',message:`Cannot establish complete ${key} demand against this room budget.`});
      else if(exceedsResource(total.total,roomBudget[max]))unplaced.push({code:'DEMAND_EXCEEDS_ROOM_BUDGET',message:`Total requested ${key} exceeds the plan's assumed room budget.`});
    }
    const equipment=normalizeEquipment({coverage:'DECLARED_COMPLETE',source,devices:packed.devices,
      rackLimits:packed.bins.map(b=>({rackId:b.rackId,...packed.limits})),roomBudget},located.placements);
    candidates.push({algorithmId:strategy==='INPUT_FIRST_FIT'?'demand-first-fit-v1':'demand-dominant-best-fit-v1',strategy,
      placements:located.placements,equipment,constraints,unplaced,positionsSubmitted:located.positionsSubmitted,
      metrics:{...layoutMetrics(located.placements,models,located.placements),rackCount:located.placements.length,
        requestedDevices:devices.length,assignedDevices:equipment.devices.filter(d=>d.rackId!==null).length}});
  }
  return candidates.sort((a,b)=>Number(Boolean(a.unplaced.length))-Number(Boolean(b.unplaced.length)) || b.metrics.assignedDevices-a.metrics.assignedDevices || a.metrics.rackCount-b.metrics.rackCount || a.metrics.envelopeAreaM2-b.metrics.envelopeAreaM2);
}
