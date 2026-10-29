// One-off cleanup requested by the user. Default is read-only; --apply moves
// only the seven named local development demos to recoverable deleted plans.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createPool } from '@ai-infra/db';

assert.equal(process.env.COMPOSE_PROJECT_NAME,'ai-infra-rack-dev');
const database=new URL(process.env.DATABASE_URL);
assert.equal(database.hostname,'127.0.0.1'); assert.equal(database.pathname,'/rack_facility');
const project='4c11ab8d-5d57-4ad8-ad55-ac08574fba46';
const revision='c5b4b888-e66e-4ffa-bb0e-2dd738ed5f4d';
const demo='4b8f7bf3-9015-455f-8bc8-ef3520f0d748';
const names=[
  'Rack room budget demo — shared power and cooling',
  'Rack allocation demo — unassigned devices', 'Rack catalog demo — six racks',
  'Rack equipment demo — Hall A1', 'Rack constraints demo — Hall A1',
  'Rack editor demo — Hall A1', 'Rack UI demo — Hall A1',
];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function request(path,options={}) {
  const response=await fetch(`http://localhost:${process.env.WEB_PORT}${path}`,{
    ...options,headers:{'x-dev-subject':'dev-user','content-type':'application/json',...options.headers},
    signal:AbortSignal.timeout(15000),
  });
  const result=await response.json(); assert.equal(response.status,200,JSON.stringify(result));return result.data;
}
const base=`/api/v1/projects/${project}/rack/plans`;
const scope=`revision_id=${revision}&scenario_id=4ee0094b-9f4e-4e45-8c3e-244fe83348d2&limit=50`;
const active=await request(`${base}?${scope}`),trash=await request(`${base}?${scope}&deleted=true`);
assert.equal(active.nextCursor,null);assert.equal(trash.nextCursor,null);
const targets=names.map(name=>{
  const matches=[...active.items,...trash.items].filter(plan=>plan.name===name);
  assert.equal(matches.length,1,`Expected exactly one named demo: ${name}`); return matches[0];
});
if(!process.argv.includes('--apply')) {
  console.log(JSON.stringify({dryRun:true,targets:targets.map(({planId,name,deletedAt})=>({planId,name,deletedAt}))},null,2));
} else {
  const pool=createPool({connectionString:process.env.DATABASE_URL});
  try {
    // Read-only DB verification includes data not exposed while a plan is deleted.
    const contents=async id=>(await pool.query(`SELECT p.equipment,p.spatial_constraints,
      (SELECT document FROM rack_room_snapshots WHERE plan_id=p.plan_id) snapshot,
      (SELECT jsonb_agg(to_jsonb(q) ORDER BY rack_id) FROM rack_placements q WHERE q.plan_id=p.plan_id) placements
      FROM rack_plans p WHERE project_id=$1 AND plan_id=$2`,[project,id])).rows[0];
    const facilityPath=`/api/v1/projects/${project}/facility/revisions/${revision}`;
    const facilityBefore=hash(await request(facilityPath)),demoBefore=hash(await request(`${base}/${demo}/layout`));
    const records=[];
    for(const plan of targets) {
      const before=hash(await contents(plan.planId));
      const result=plan.deletedAt?plan:await request(`${base}/${plan.planId}`,{method:'DELETE',
        body:JSON.stringify({contract_version:1}),headers:{'If-Match':`"${plan.version}"`,'Idempotency-Key':randomUUID()}});
      assert.ok(result.deletedAt);assert.equal(hash(await contents(plan.planId)),before);
      records.push({planId:plan.planId,name:plan.name,previousVersion:plan.version,version:result.version,
        deletedAt:result.deletedAt,contentSha256:before,contentUnchanged:true});
    }
    assert.equal(hash(await request(facilityPath)),facilityBefore);
    assert.equal(hash(await request(`${base}/${demo}/layout`)),demoBefore);
    const evidence={records,retainedDemo:demo,retainedDemoUnchanged:true,facilityUnchanged:true};
    await writeFile(new URL('./cleanup-results.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence,null,2));
  } finally {await pool.end();}
}
