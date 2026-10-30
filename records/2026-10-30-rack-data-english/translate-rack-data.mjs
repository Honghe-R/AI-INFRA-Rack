// One-time local data maintenance. Preview by default; --apply writes reviewed text changes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool } from '@ai-infra/db';
import { loadConfig } from '@ai-infra/core';

const replacements = [
  ['完整机房演示 · 32柜 / 多排混合设备', 'Full Hall Demo · 32 Racks / Mixed Equipment Rows'],
  ['自动设计示例 · 22台设备', 'Auto Design Demo · 22 Devices'],
  ['用户流程验收 · 两柜服务器与交换机', 'User Journey Demo · Two Racks with Servers and Switches'],
  ['课程规划假设，需在实际部署前核实。', 'Course planning assumption; verify before deployment.'],
  ['主通道预留 · 禁放', 'Main Aisle Reservation'],
  ['南侧通道预留 · 禁放', 'South Aisle Reservation'],
  ['北侧通道预留 · 禁放', 'North Aisle Reservation'],
  ['设备暂存区 · 禁放', 'Equipment Staging Area'],
  ['超高100U设备（拒绝示例）', 'Oversized 100U Device (Rejection Example)'],
  ['规格未知设备（不猜测）', 'Device with Unknown Specifications'],
  ['GPU服务器', 'GPU Server'], ['计算服务器', 'Compute Server'],
  ['交换机', 'Switch'], ['待上架', 'Unassigned'],
];
const han = /\p{Script=Han}/u;
let translatedStrings = 0;
function translate(value) {
  if (typeof value === 'string') {
    let result = value;
    for (const [from, to] of replacements) result = result.replaceAll(from, to);
    assert.ok(!han.test(result), `Unmapped Chinese text requires review: ${value}`);
    if (result !== value) translatedStrings++;
    return result;
  }
  if (Array.isArray(value)) return value.map(translate);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,translate(v)]));
  return value;
}
// Only display text may differ; identities, assignments, resource limits and geometry must match.
function structural(value) {
  if (Array.isArray(value)) return value.map(structural);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['name','reference','description'].includes(key)).map(([k,v]) => [k,structural(v)]));
  return value;
}
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'ai-infra-rack-dev');
assert.equal(process.env.AI_INFRA_COMPOSE_FILE, 'compose.rack.yaml');
const config = loadConfig(), db = new URL(config.databaseUrl);
assert.equal(db.hostname, '127.0.0.1'); assert.equal(db.port, '55532'); assert.equal(db.pathname, '/rack_facility');
const apply = process.argv.includes('--apply');
assert.ok(process.argv.slice(2).every(arg => arg === '--apply'), 'Only --apply is supported.');
const pool = createPool({connectionString:config.databaseUrl});
try {
  const rows = (await pool.query(`SELECT plan_id,project_id,name,version,deleted_at,spatial_constraints,equipment
    FROM rack_plans ORDER BY project_id,plan_id`)).rows;
  const changes = rows.flatMap(row => {
    const before = {name:row.name,spatial_constraints:row.spatial_constraints,equipment:row.equipment};
    const after = translate(before);
    assert.deepEqual(structural(after),structural(before));
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{row,before,after}];
  });
  const summary = {apply,changedPlans:changes.length,translatedStrings,
    plans:changes.map(({row,after}) => ({planId:row.plan_id,before:row.name,after:after.name,deleted:!!row.deleted_at,baseVersion:row.version}))};
  console.log(JSON.stringify(summary,null,2));
  if (apply && changes.length) {
    const directory = new URL('../../.local-runtime/backups/',import.meta.url);
    await mkdir(directory,{recursive:true});
    const backup = new URL(`rack-english-${Date.now()}.json`,directory);
    await writeFile(backup,JSON.stringify(changes.map(({row})=>row),null,2),{flag:'wx',mode:0o600});
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const {row,before,after} of changes) {
        await client.query("SELECT set_config('app.project_id',$1,true)",[row.project_id]);
        const result = await client.query(`UPDATE rack_plans SET name=$3,spatial_constraints=$4::jsonb,equipment=$5::jsonb,
          version=version+1,updated_at=now()
          WHERE project_id=$1 AND plan_id=$2 AND version=$6 AND name=$7
          AND spatial_constraints=$8::jsonb AND equipment=$9::jsonb
          RETURNING version`,[row.project_id,row.plan_id,after.name,JSON.stringify(after.spatial_constraints),JSON.stringify(after.equipment),
          row.version,before.name,JSON.stringify(before.spatial_constraints),JSON.stringify(before.equipment)]);
        assert.equal(result.rowCount,1,'Plan changed concurrently; roll back and review again.');
      }
      await client.query('COMMIT');
      console.log(`Applied text-only maintenance; backup: ${fileURLToPath(backup)}`);
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const verified = (await pool.query('SELECT name,spatial_constraints,equipment FROM rack_plans')).rows;
    assert.ok(!verified.some(row=>han.test(JSON.stringify(row))));
    console.log('Verified: no Chinese text remains in Rack plan names, constraints or equipment.');
  }
} finally { await pool.end(); }
