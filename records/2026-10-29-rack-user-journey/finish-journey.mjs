// Retire only this turn's browser fixture after verifying the restored data.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
assert.equal(process.env.COMPOSE_PROJECT_NAME,'ai-infra-rack-dev');
const database=new URL(process.env.DATABASE_URL);
assert.equal(database.hostname,'127.0.0.1');assert.equal(database.pathname,'/rack_facility');
const base=`http://localhost:${process.env.WEB_PORT}/api/v1/projects/4c11ab8d-5d57-4ad8-ad55-ac08574fba46/rack/plans`;
const id='481e475a-269c-44fa-a404-d0d1d3ab6c48';
async function request(path,options={}) {
  const response=await fetch(`${base}${path}`,{...options,
    headers:{'x-dev-subject':'dev-user','content-type':'application/json',...options.headers}});
  assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json(); assert.equal(response.status,200,JSON.stringify(body));return body.data;
}
let plan=await request(`/${id}`);
assert.equal(plan.name,'用户流程验收 · 两柜服务器与交换机');
if(!plan.deletedAt) {
  const layout=await request(`/${id}/layout`);
  const before=JSON.parse(await readFile(new URL('./journey-saved.json',import.meta.url),'utf8'));
  for(const key of ['snapshot','placements','equipment','constraints'])assert.deepEqual(layout[key],before[key]);
  plan=await request(`/${id}`,{method:'DELETE',body:JSON.stringify({contract_version:1}),
    headers:{'If-Match':`"${plan.version}"`,'Idempotency-Key':randomUUID()}});
}
assert.ok(plan.deletedAt);
const list=await request('');
assert.ok(!list.items.some(p=>p.planId===id));
const evidence={fixture:{planId:id,version:plan.version,deletedAt:plan.deletedAt},
  activePlans:list.items.map(({planId,name,version})=>({planId,name,version})),cacheControl:'no-store'};
await writeFile(new URL('./final-local-state.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
