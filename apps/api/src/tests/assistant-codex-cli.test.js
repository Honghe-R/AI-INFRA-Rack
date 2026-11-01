import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexCliConnection, readCodexSelection, codexDecisionResponse } from '../services/assistant-codex-cli.js';
import { createAssistantHost } from '@ai-infra/assistant';

const config='model_provider="gateway"\nmodel="configured-model"\n[model_providers.gateway]\nname="Gateway"\nbase_url="https://models.example/v1"\nwire_api="responses"\nenv_key="PROBE_KEY"\nnotify=["do-not-run"]\n[mcp_servers.other]\ncommand="do-not-run"\n';
const tool={type:'function',function:{name:'rack_probe',description:'Read a synthetic result',parameters:{type:'object',properties:{},additionalProperties:false}}};
async function fixture(t,{decision={content:'测试回答',tool_calls:[]},allowUser=async id=>id==='alice',hang=false,omitCompletion=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'rack-codex-test-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  const home=join(root,'home'),entry=join(root,'codex.js'),runtime=join(root,'runtime');await mkdir(home);
  await writeFile(join(home,'config.toml'),config);await writeFile(entry,'// synthetic CLI');
  const calls=[];
  const spawnImpl=(command,args,options)=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{queueMicrotask(()=>child.emit('close',1));return true;};
    let input='';child.stdin.on('data',b=>{input+=b.toString();});
    child.stdin.on('finish',()=>{calls.push({command,args,options,input});if(hang)return;
      queueMicrotask(()=>{
        const result=typeof decision==='function'?decision(input,calls.length):decision;
        for(const event of [{type:'thread.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}},
          ...(!omitCompletion?[{type:'turn.completed',usage:{input_tokens:10,output_tokens:3,cached_input_tokens:2}}]:[])])child.stdout.write(JSON.stringify(event)+'\n');
        child.stdout.end();child.stderr.end();child.emit('close',0);
      });
    });return child;
  };
  const env={CODEX_HOME:home,ASSISTANT_CODEX_CLI_PATH:entry,PROBE_KEY:'synthetic-cli-secret',DATABASE_URL:'never-in-child',AUTH_DEV_SECRET:'never-in-child'};
  const service=createCodexCliConnection({env,allowUser,spawnImpl,runtimeDirectory:runtime,timeoutMs:1000});
  const info=await service.status('alice');
  return {root,home,runtime,calls,service,info,open:()=>service.open('alice',info.connectionId,info.version)};
}

test('CLI selection copies only model transport fields and rejects embedded credentials',()=>{
  const selection=readCodexSelection(config);
  assert.equal(selection.model,'configured-model');assert.equal(selection.provider.env_key,'PROBE_KEY');
  assert.equal(Object.hasOwn(selection.provider,'notify'),false);assert.equal(Object.hasOwn(selection,'mcp_servers'),false);
  for(const source of [config.replace('https://models.example/v1','https://secret@models.example/v1'),
    config.replace('https://models.example/v1','https://models.example/v1?key=secret'),
    config.replace('notify=', 'experimental_bearer_token=')])assert.throws(()=>readCodexSelection(source));
});

test('CLI status is owner-scoped; stale or foreign references never start a process',async t=>{
  const f=await fixture(t);
  assert.equal(f.info.configured,true);assert.equal((await f.service.status('bob')).available,false);
  await assert.rejects(f.service.open('bob',f.info.connectionId,f.info.version),e=>e.status===403);
  await assert.rejects(f.service.open('alice','foreign',f.info.version),e=>e.status===412);
  await assert.rejects(f.service.open('alice',f.info.connectionId,'old'),e=>e.status===412);
  assert.equal(f.calls.length,0);assert.ok(!JSON.stringify(f.info).includes('synthetic-cli-secret'));
});

test('CLI completion uses stdin, disables native tools, omits backend secrets and cleans ephemeral files',async t=>{
  const f=await fixture(t),connection=await f.open(),before=await readFile(join(f.home,'config.toml'));
  const result=await connection.provider.complete({messages:[{role:'user',content:'你好'}],tools:[tool]});
  assert.equal(result.choices[0].message.content,'测试回答');assert.equal(result.usage.total_tokens,13);
  const call=f.calls[0];assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
  assert.equal(call.options.env.DATABASE_URL,undefined);assert.equal(call.options.env.AUTH_DEV_SECRET,undefined);
  assert.equal(call.options.env.PROBE_KEY,'synthetic-cli-secret');assert.ok(!call.args.join(' ').includes('synthetic-cli-secret'));
  for(const arg of ['--ignore-user-config','--ignore-rules','--ephemeral','--output-schema','features.shell_tool=false','features.hooks=false','features.plugins=false','tools.view_image=false'])assert.ok(call.args.includes(arg));
  assert.ok(call.input.includes('你好'));assert.ok(call.input.includes('rack_probe'));
  assert.deepEqual(await readdir(f.runtime),[]);assert.deepEqual(await readFile(join(f.home,'config.toml')),before);
});

test('CLI validates platform tool names/arguments and maps usage and calls to the existing provider contract',()=>{
  const r=codexDecisionResponse({content:'',tool_calls:[{name:'rack_probe',arguments:'{}'}]},[tool],'model');
  assert.equal(r.choices[0].message.tool_calls[0].function.name,'rack_probe');
  for(const call of [{name:'shell',arguments:'{}'},{name:'rack_probe',arguments:'[]'},{name:'rack_probe',arguments:'invalid'}])
    assert.throws(()=>codexDecisionResponse({content:'',tool_calls:[call]},[tool],'model'),e=>e.code==='CODEX_INVALID_RESPONSE');
});

test('CLI adapter completes the real Host tool loop rather than executing platform operations itself',async t=>{
  let executed=0;
  const f=await fixture(t,{decision:(_input,round)=>round===1?{content:'',tool_calls:[{name:'rack_probe',arguments:'{}'}]}:{content:'工具结果已收到',tool_calls:[]}});
  const connection=await f.open();
  const host=createAssistantHost({provider:connection.provider,surfaces:[{key:'rack',version:1,digest:null}],
    guides:[{key:'rack',surface:'rack',requiredEntryFunctions:['rack.read']}],
    capabilities:[{name:'rack_probe',description:'Probe',inputSchema:tool.function.parameters,access:'read',confirmation:'none',surfaces:['rack'],requiredFunctions:['rack.read'],handler:async()=>{executed++;return {ok:true};}}],
    resolveScope:async()=>({surface:'rack',workspaceId:'project'}),authorize:async()=>true});
  const result=await host.orchestrator.runTurn({messages:[{role:'user',content:'Read the probe'}],contextKey:'cli-context',context:{userId:'alice',surface:'rack'},permissionMode:'read_only'});
  assert.equal(executed,1);assert.equal(f.calls.length,2);assert.match(JSON.stringify(result),/工具结果已收到/);
  assert.match(f.calls[1].input,/"role":"tool"/);
});

test('CLI abort stops its request and releases the per-account busy guard',async t=>{
  const f=await fixture(t,{hang:true}),connection=await f.open(),controller=new AbortController();
  const pending=connection.provider.complete({messages:[],signal:controller.signal});
  while(f.calls.length===0)await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(connection.provider.complete({messages:[]}),e=>e.code==='CODEX_CLI_BUSY');
  controller.abort();await assert.rejects(pending,e=>e.code==='LLM_CANCELLED');
  assert.deepEqual(await readdir(f.runtime),[]);
});

test('simultaneous CLI starts acquire the account guard before configuration reads',async t=>{
  const f=await fixture(t),connection=await f.open();
  const first=connection.provider.complete({messages:[]});
  await assert.rejects(connection.provider.complete({messages:[]}),e=>e.code==='CODEX_CLI_BUSY');
  await first;assert.equal(f.calls.length,1);
  await connection.provider.complete({messages:[]});assert.equal(f.calls.length,2);
});

test('CLI rejects truncated event streams even when the process exits successfully',async t=>{
  const f=await fixture(t,{omitCompletion:true}),connection=await f.open();
  await assert.rejects(connection.provider.complete({messages:[]}),e=>e.code==='CODEX_CLI_FAILED');
  assert.deepEqual(await readdir(f.runtime),[]);
});
