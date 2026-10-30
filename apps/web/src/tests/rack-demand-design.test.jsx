import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RackDemandDesign,designDemandBody } from '../rack/RackDemandDesign.jsx';
import { createApiClient } from '../api/client.js';
const layout={projectId:'p',planId:'plan',version:1,models:[{modelId:'rack',name:'42U'}],snapshot:{snapshotId:'s'},sourceStatus:{status:'UNCHANGED'},
  placements:[],equipment:{devices:[],rackLimits:[]},constraints:{obstacles:[],clearance:null,source:{kind:'ASSUMED',reference:'saved'},obstacleCoverage:'UNKNOWN'}};
const model={modelId:'gpu',version:1,name:'GPU',specification:{heightU:4,weightKg:80,powerKw:3,coolingKw:3}};
test('demand form assembles exact model versions and quantities, preserves obstacles and omits unedited budget',()=>{
  const values={quantities:{gpu:'8'},models:[model],rackModelId:'rack',maxRacks:'16',limits:{maxPowerKw:'12',maxWeightKg:'800',maxCoolingKw:'12'},frontM:'1',rearM:'.6',gapM:'.2',sourceReference:'assumed',budgetEnabled:false};
  const body=designDemandBody(layout,values);assert.deepEqual(body.demand.groups,[{modelId:'gpu',version:1,quantity:8}]);assert.equal(body.base_version,1);
  assert.equal(body.demand.rackLimits.maxPowerKw,12);assert.equal(Object.hasOwn(body.demand,'roomBudget'),false);assert.equal(body.demand.constraints.obstacleCoverage,'UNKNOWN');
  assert.deepEqual(body.demand.constraints.clearance,{frontM:1,rearM:.6});
  assert.equal(body.demand.constraints.source.reference,'assumed');
  assert.equal(designDemandBody(layout,{...values,budgetEnabled:true,budget:{maxPowerKw:0,maxCoolingKw:''}}).demand.roomBudget.maxCoolingKw,null);
});
test('empty-plan form shows quantity/assumption inputs, blocks dirty generation and directs nonempty plans to preserve existing work',()=>{
  const props={client:{},layout,catalogState:{data:{models:[model]}},canWrite:true};
  const html=renderToStaticMarkup(<RackDemandDesign {...props} draft={{}}/>);
  for(const text of ['Auto design from equipment quantities','GPU Quantity','Rack power limit (kW)','Use course example parameters','Save or discard the shared draft','required=""'])assert.ok(html.includes(text),text);
  assert.ok(/disabled=""[^>]*>Generate design candidates/.test(html));
  const occupied=renderToStaticMarkup(<RackDemandDesign {...props} layout={{...layout,placements:[{}]}}/>);
  assert.ok(occupied.includes('Create an empty plan'));assert.ok(!occupied.includes('Use course example parameters'));
});
test('demand preview uses readonly version-bound POST and no write headers, with cancellation/no-store',async()=>{
  let call;const signal=new AbortController().signal;
  const client=createApiClient({identity:()=>null,fetchImpl:async(url,options)=>{call={url,options};return{ok:true,json:async()=>({data:{}})};}});
  await client.generateRackDesignOptions('p/x','plan/x',{base_version:1},{signal});
  assert.equal(call.url,'/api/v1/projects/p%2Fx/rack/plans/plan%2Fx/layout/design-options');assert.equal(call.options.method,'POST');assert.equal(call.options.signal,signal);
  assert.equal(call.options.cache,'no-store');assert.equal(call.options.headers['If-Match'],undefined);assert.equal(call.options.headers['Idempotency-Key'],undefined);
});
