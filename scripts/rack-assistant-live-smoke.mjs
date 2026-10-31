// Explicit opt-in: at most two paid provider requests, 300 output tokens each.
// Reuses the connection service; never prints/decrypts credentials itself.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createAssistantHost } from '@ai-infra/assistant';
import { assistantConnectionDirectories, createAssistantConnections } from '../apps/api/src/services/assistant-connections.js';
import { createAssistantFetch } from '../apps/api/src/services/assistant-endpoint.js';
import { createAssistantScopeResolver, createPermissionAuthorizer } from '../apps/api/src/assistant-host.js';
import { createRackAssistantSurface } from '../apps/api/src/services/rack-assistant.js';
import { createRackKnowledge, rackAgentDigest } from '../apps/api/src/services/rack-knowledge.js';
import { createRackAgentActions, createRackRoomReader } from '../apps/api/src/services/rack-agent-actions.js';
import { createRackLayoutService } from '../apps/api/src/services/rack-layout.js';
import { createRackPlanService } from '../apps/api/src/services/rack-plans.js';
import { createDeveloperSurface } from '../apps/api/src/services/developer-assistant.js';

if (!process.argv.includes('--live')) throw new Error('Paid provider acceptance requires the explicit --live flag.');
if (process.env.AI_INFRA_COMPOSE_FILE !== 'compose.rack.yaml') throw new Error('Use the isolated Rack environment.');
const config=loadConfig(),pool=createPool({connectionString:config.databaseUrl,max:2});
const root=fileURLToPath(new URL('../',import.meta.url));
const report={startedAt:new Date().toISOString(),kind:'SMALL_REAL_PROVIDER_READ_ONLY_ACCEPTANCE',requests:0,
  maxRequests:2,maxOutputTokensPerRequest:300,usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0},
  liveBusinessWrites:false,credentialOutput:false,acceptance:'NOT_RUN'};
let connection;
try {
  const repository=createRbacRepository({pool});
  const guard=createPermissionGuard({evaluator:createEvaluator({repository}),repository});
  const authorize=createPermissionAuthorizer({guard});
  const users=(await pool.query("SELECT user_id,subject FROM users WHERE subject IN ('dev-user','dev-editor','dev-viewer')")).rows;
  const admin=users.find(u=>u.subject==='dev-user');assert.ok(admin,'Local administrator identity is missing.');
  const candidates=(await pool.query("SELECT p.project_id,p.name,r.scenario_id,r.revision_id FROM projects p JOIN revisions r ON r.project_id=p.project_id WHERE r.lifecycle_state='DRAFT' ORDER BY p.created_at LIMIT 20")).rows;
  const project=await (async()=>{for(const p of candidates)if(await authorize({key:'rack.read',userId:admin.user_id,workspaceId:p.project_id})&&await authorize({key:'facility.read',userId:admin.user_id,workspaceId:p.project_id}))return p;})();
  assert.ok(project,'No authorized Rack project found.');
  const allowedOrigins=(process.env.ASSISTANT_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
  const transport=createAssistantFetch({allowedOrigins});
  const connections=createAssistantConnections({...assistantConnectionDirectories(),timeoutMs:45000,fetchImpl:async(url,options)=>{
    if(report.requests>=2) throw Object.assign(new Error('Live smoke request cap reached.'),{status:429});
    report.requests++;
    return transport(url,options);
  }});
  const metadata=await connections.get(admin.user_id);
  if(!metadata) throw Object.assign(new Error('Configure the administrator model connection first.'),{code:'ASSISTANT_SETUP_REQUIRED'});
  connection=await connections.open(admin.user_id,metadata.connectionId,metadata.version);
  report.model=metadata.model;report.project=project.name;
  const layouts=createRackLayoutService({pool}),plans=createRackPlanService({pool});
  const rack=createRackAssistantSurface({layouts,plans,authorize});
  const knowledge=createRackKnowledge({authorize});
  // One small current-file tool avoids paying for irrelevant mutation schemas.
  const capabilities=knowledge.capabilities.filter(c=>c.name==='rack_read_knowledge');
  const provider={async complete(request){
    const result=await connection.provider.complete({...request,modelOptions:{max_tokens:300}});
    for(const key of Object.keys(report.usage))report.usage[key]+=result.usage?.[key]??0;
    return result;
  }};
  const host=createAssistantHost({provider,surfaces:[rack.surface],guides:[rack.guide],capabilities,authorize,
    resolveScope:createAssistantScopeResolver({pool,authorize}),buildDigest:input=>rackAgentDigest(input,authorize),
    limits:{maxIterations:2},redact:connection.redact});
  const result=await host.orchestrator.runTurn({contextKey:`live-smoke-${randomUUID()}`,permissionMode:'read_only',
    signal:AbortSignal.timeout(90000),context:{surface:'rack',userId:admin.user_id,projectId:project.project_id,scenarioId:project.scenario_id,revisionId:project.revision_id},
    messages:[{role:'user',content:'请先调用 rack_read_knowledge，读取 doc/tools/rack/unified-agent.md 的前12行（start_line:1,line_count:12），然后只用两句中文说明这个项目的 Assistant 如何获取项目知识、为什么不能越权。请依据刚读取的内容，不要执行任何修改，也不要再检索其他资料。'}]});
  report.status=result.status;report.draftChanged=result.draftChanged;
  report.tools=result.trace.rounds.flatMap(r=>r.calls??[]).map(c=>({name:c.name,outcome:c.outcome}));
  report.answer=connection.redact(result.choices[0].message.content);
  assert.equal(result.status,'ok');assert.equal(result.draftChanged,false);
  assert.ok(report.tools.some(t=>t.name==='rack_read_knowledge'&&['ok','degraded'].includes(t.outcome)),'Real model did not complete the knowledge tool.');
  assert.ok(/[\u3400-\u9fff]/.test(report.answer),'Expected a Chinese answer.');
  // No additional model calls: verify actual database permission decisions.
  const actions=createRackAgentActions({plans,rooms:createRackRoomReader({pool}),authorize});
  const registryHost=createAssistantHost({provider:{},surfaces:[rack.surface],guides:[rack.guide],
    capabilities:[...rack.capabilities,...actions.capabilities,...knowledge.capabilities,...createDeveloperSurface({}).capabilities],resolveScope:async()=>null});
  report.permissions=[];
  for(const subject of ['dev-viewer','dev-editor']) {
    const user=users.find(u=>u.subject===subject);assert.ok(user);
    const selected=await registryHost.toolRegistry.select({surfaceKey:'rack',authorize:key=>authorize({key,userId:user.user_id,workspaceId:project.project_id})});
    const ctx={workspaceId:project.project_id,scenarioId:project.scenario_id,revisionId:project.revision_id,initiatedBy:{userId:user.user_id},requestId:randomUUID()};
    const forbidden=subject==='dev-viewer'?'rack_create_plan':'rack_delete_plan';
    await assert.rejects(actions.capabilities.find(c=>c.name===forbidden).handler(ctx,{}),e=>e.status===403);
    assert.ok(!selected.some(t=>t.name===forbidden));assert.ok(!selected.some(t=>t.name.startsWith('dev_')));
    report.permissions.push({subject,forbiddenTool:forbidden,selectionExcluded:true,executionDenied:true,codeToolsExcluded:true});
  }
  report.acceptance='PASSED';
} catch(error) {
  report.acceptance='FAILED';report.error={code:error.code??'LIVE_SMOKE_FAILED',message:connection?.redact(error.message)??'Live acceptance could not start.'};process.exitCode=1;
} finally {
  connection?.release();await pool.end();
  report.finishedAt=new Date().toISOString();
  const directory=join(root,'.local-runtime/assistant-live-smoke');await mkdir(directory,{recursive:true});
  const path=join(directory,`result-${Date.now()}.json`);await writeFile(path,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,reportPath:path},null,2));
}
