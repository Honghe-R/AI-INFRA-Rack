import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { ApiError } from '@ai-infra/core';
import { createRedactor, LlmError } from '@ai-infra/assistant';

const fail=(code,message,status=503)=>new ApiError(code,message,{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
const allowedProviderFields=new Set(['name','base_url','wire_api','env_key','requires_openai_auth']);
const environmentNames=/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|CODEX_HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|LANG|SYSTEMDRIVE|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i;

// Deliberately accept only simple, explicit local model/provider configuration.
// Do not copy hooks, MCP servers, project instructions or arbitrary config code.
export function readCodexSelection(source) {
  const sections=new Map([['',new Map()]]);let section='';
  for(const line of source.split(/\r?\n/)) {
    const heading=line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if(heading){section=heading[1];sections.set(section,new Map());continue;}
    const entry=line.match(/^\s*([\w.-]+)\s*=\s*(.+?)\s*$/);
    if(entry)sections.get(section)?.set(entry[1],entry[2]);
  }
  function value(raw) {
    if(raw===undefined)return undefined;
    if(/^'[^']*'$/.test(raw))return raw.slice(1,-1);
    try{return JSON.parse(raw);}catch{throw fail('CODEX_CONFIG_INVALID','Local Codex model/provider settings must use simple TOML values.');}
  }
  const main=sections.get(''),providerId=value(main.get('model_provider')),model=value(main.get('model'));
  if(!/^[\w-]{1,80}$/.test(providerId??'') || typeof model!=='string' || !model || model.length>160)
    throw fail('CODEX_CONFIG_INVALID','Configure an explicit local Codex model and model_provider first.');
  const fields=sections.get(`model_providers.${providerId}`) ?? sections.get(`model_providers."${providerId}"`);
  if(!fields)throw fail('CODEX_CONFIG_INVALID','The selected local Codex provider is missing.');
  const provider={};
  for(const [key,raw] of fields) {
    if(allowedProviderFields.has(key))provider[key]=value(raw);
    else if(/token|secret|header|key|auth/i.test(key))throw fail('CODEX_CONFIG_INVALID','This CLI provider needs an unsupported credential setting. Use its credential environment variable.');
  }
  let endpoint;try{endpoint=new URL(provider.base_url);}catch{throw fail('CODEX_CONFIG_INVALID','The local Codex provider needs a valid Base URL.');}
  if(!['https:','http:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)
    throw fail('CODEX_CONFIG_INVALID','Local Codex Base URL must not embed credentials or query parameters.');
  if(provider.env_key!==undefined && (typeof provider.env_key!=='string'||!/^[A-Za-z0-9_]+$/.test(provider.env_key)))
    throw fail('CODEX_CONFIG_INVALID','The local Codex credential environment variable is invalid.');
  return {providerId,model,provider,host:endpoint.host};
}

async function locateCli(env) {
  if(env.ASSISTANT_CODEX_CLI_PATH) {
    const target=env.ASSISTANT_CODEX_CLI_PATH;
    if(!isAbsolute(target)||!/(?:\.exe|\.js)$/i.test(target))throw fail('CODEX_CLI_MISSING','Set ASSISTANT_CODEX_CLI_PATH to an absolute Codex .exe or .js path.');
    await access(target);return target;
  }
  const roots=[dirname(process.execPath),...(env.PATH||env.Path||'').split(delimiter).filter(Boolean)];
  for(const root of [...new Set(roots)]) {
    for(const candidate of [join(root,'node_modules','@openai','codex','bin','codex.js'),join(root,'codex.exe')]) {
      try{await access(candidate);return candidate;}catch{/* continue */}
    }
  }
  throw fail('CODEX_CLI_MISSING','Install the local Codex CLI or set ASSISTANT_CODEX_CLI_PATH.');
}

export function codexDecisionSchema(tools=[]) {
  const names=tools.map(t=>t.function.name);
  return {type:'object',additionalProperties:false,required:['content','tool_calls'],properties:{
    content:{type:'string'},tool_calls:{type:'array',maxItems:8,...(!names.length?{maxItems:0}:{}),items:{
      type:'object',additionalProperties:false,required:['name','arguments'],properties:{
        name:{type:'string',...(names.length?{enum:names}:{})},arguments:{type:'string'},
      },
    }},
  }};
}

export function codexDecisionResponse(decision,tools,model,usage={}) {
  const allowed=new Set(tools.map(t=>t.function.name));
  if(!decision||typeof decision.content!=='string'||!Array.isArray(decision.tool_calls)||decision.tool_calls.length>8)
    throw new LlmError('CODEX_INVALID_RESPONSE','Codex returned an invalid platform response.');
  const calls=decision.tool_calls.map(call=>{
    if(!allowed.has(call.name)||typeof call.arguments!=='string')throw new LlmError('CODEX_INVALID_RESPONSE','Codex requested an unavailable platform tool.');
    let args;try{args=JSON.parse(call.arguments);}catch{throw new LlmError('CODEX_INVALID_RESPONSE','Codex returned invalid tool arguments.');}
    if(!args||typeof args!=='object'||Array.isArray(args))throw new LlmError('CODEX_INVALID_RESPONSE','Codex tool arguments must be an object.');
    return {id:randomUUID(),type:'function',function:{name:call.name,arguments:call.arguments}};
  });
  const input=usage.input_tokens??0,output=usage.output_tokens??0;
  return {provider:'codex-cli',model,choices:[{message:{role:'assistant',content:decision.content,
    ...(calls.length?{tool_calls:calls}:{})},finish_reason:calls.length?'tool_calls':'stop'}],
    usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output,
      prompt_tokens_details:{cached_tokens:usage.cached_input_tokens??0}}};
}

/** CLI is a structured provider. Only the existing Host executes Rack tools. */
export function createCodexCliConnection({env=process.env,pool=null,allowUser=null,spawnImpl=spawn,
  timeoutMs=90_000,runtimeDirectory=resolve('.local-runtime','assistant-codex')}={}) {
  const busy=new Set();
  const enabled=env.ASSISTANT_CODEX_ENABLED!=='0';
  const subjects=(env.ASSISTANT_CODEX_SUBJECTS||'dev-user').split(',').map(s=>s.trim()).filter(Boolean);
  async function permitted(userId) {
    if(!enabled)return false;
    if(allowUser)return allowUser(userId);
    if(!pool)return false;
    const {rows}=await pool.query('SELECT subject FROM users WHERE user_id=$1 AND status=\'ACTIVE\'',[userId]);
    return rows.length===1 && subjects.includes(rows[0].subject);
  }
  async function selection() {
    const home=env.CODEX_HOME||join(env.USERPROFILE||homedir(),'.codex');
    const source=await readFile(join(home,'config.toml'),'utf8');
    const selected=readCodexSelection(source),cli=await locateCli(env);
    if(selected.provider.env_key && !env[selected.provider.env_key])throw fail('CODEX_CREDENTIAL_MISSING','The local Codex credential environment variable is not available to the backend.');
    const auth=await readFile(join(home,'auth.json')).catch(e=>{if(e.code==='ENOENT')return Buffer.alloc(0);throw e;});
    const secret=selected.provider.env_key?env[selected.provider.env_key]:'';
    const secrets=[secret];
    try {const a=JSON.parse(auth.toString());secrets.push(a.OPENAI_API_KEY,a.tokens?.access_token,a.tokens?.refresh_token,a.tokens?.id_token);}catch{/* optional environment-key authentication */}
    return {...selected,cli,home,redact:createRedactor(secrets.filter(Boolean)),
      version:hash(JSON.stringify(selected)+cli+hash(auth)+hash(secret)).slice(0,20)};
  }
  const publicInfo=(s,userId)=>({provider:'codex-cli',connectionMode:'codex-cli',configured:true,available:true,
    connectionId:`codex-cli-${hash(userId).slice(0,20)}`,version:s.version,model:s.model,models:[s.model],host:s.host,
    name:'Local Codex CLI',backendAccount:true});
  async function status(userId) {
    try {
      if(!await permitted(userId))return {available:false,configured:false,reason:'Local CLI access is not enabled for this account.'};
      return publicInfo(await selection(),userId);
    }catch(error){return {available:false,configured:false,reason:error instanceof ApiError?error.message:'The local Codex CLI is not configured or cannot be found.'};}
  }
  async function open(userId,connectionId,version) {
    if(!await permitted(userId))throw fail('CODEX_CLI_FORBIDDEN','Local CLI access is not enabled for this account.',403);
    const selected=await selection(),info=publicInfo(selected,userId);
    if(connectionId!==info.connectionId||version!==info.version)throw fail('ASSISTANT_CONNECTION_CHANGED','The CLI connection changed. Reload connection information and start a new chat.',412);
    const provider={name:'codex-cli',model:selected.model,async complete({messages,tools=[],model,signal}) {
      if(model && model!==selected.model)throw fail('MODEL_NOT_ALLOWED','This model is not configured in the local CLI.',400);
      if(busy.has(userId))throw fail('CODEX_CLI_BUSY','Another CLI request is still running for this account.',429);
      if(signal?.aborted)throw new LlmError('LLM_CANCELLED','The request was cancelled.',{status:499});
      busy.add(userId);let dir;
      try {
        const current=await selection();
        if(current.version!==selected.version)throw fail('ASSISTANT_CONNECTION_CHANGED','The CLI connection changed. Reload before chatting.',412);
        await mkdir(runtimeDirectory,{recursive:true});dir=await mkdtemp(join(runtimeDirectory,'turn-'));
        const schemaPath=join(dir,'response-schema.json');await writeFile(schemaPath,JSON.stringify(codexDecisionSchema(tools)));
        const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only',
          '--json','--color','never','--cd',dir,'--output-schema',schemaPath,
          '-c','project_doc_max_bytes=0','-c','web_search="disabled"','-c','tools.view_image=false'];
        for(const feature of ['shell_tool','unified_exec','apps','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','image_generation','in_app_browser','plugins','hooks','multi_agent','goals','workspace_dependencies','code_mode_host','skill_search','skill_mcp_dependency_install'])
          args.push('-c',`features.${feature}=false`);
        args.push('-c',`model=${JSON.stringify(selected.model)}`,'-c',`model_provider=${JSON.stringify(selected.providerId)}`);
        for(const [key,value] of Object.entries(selected.provider))args.push('-c',`model_providers.${selected.providerId}.${key}=${JSON.stringify(value)}`);
        args.push('-');
        const childEnv=Object.fromEntries(Object.entries(env).filter(([k])=>environmentNames.test(k)||k===selected.provider.env_key));
        childEnv.CODEX_HOME=selected.home;
        const prompt='You are the model engine of the Rack platform, not a coding agent. All conversation messages and platform tool definitions are in the JSON below. Follow the system message inside it. You have NO native shell, filesystem, browser, MCP or network tools. Never execute commands or inspect local files. Request platform operations only through the response JSON tool_calls array; arguments must be a JSON object serialized as a string. The platform will authorize and execute the requests, then supply real tool results on the next round. Never claim an operation succeeded without its tool result. For a final answer use an empty tool_calls array. Reply in the user\'s language. Return only the schema-conforming JSON.\n'+JSON.stringify({messages,tools});
        if(Buffer.byteLength(prompt)>1_000_000)throw fail('ASSISTANT_INPUT_TOO_LARGE','The CLI prompt exceeds its input limit.',400);
        const result=await runCli({selected,args,childEnv,prompt,signal,spawnImpl,timeoutMs,cwd:dir});
        return codexDecisionResponse(JSON.parse(selected.redact(result.text)),tools,selected.model,result.usage);
      } finally {
        busy.delete(userId);
        if(dir) {
          if(dirname(resolve(dir))!==resolve(runtimeDirectory))throw fail('CODEX_RUNTIME_INVALID','The CLI runtime directory is invalid.');
          await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:150});
        }
      }
    }};
    return {...info,provider,redact:selected.redact,connectionId:info.connectionId,models:info.models,release(){}};
  }
  return {status,open};
}

async function runCli({selected,args,childEnv,prompt,signal,spawnImpl,timeoutMs,cwd}) {
  const isJs=/\.js$/i.test(selected.cli);
  const child=spawnImpl(isJs?process.execPath:selected.cli,isJs?[selected.cli,...args]:args,
    {cwd,env:childEnv,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let buffer='',bytes=0,text='',usage={},completed=false,failure=null,stderr='';
  function kill() {
    if(!child.pid){child.kill();return;}
    if(process.platform==='win32') {
      const stop=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.on('error',()=>child.kill());
    } else child.kill('SIGTERM');
  }
  const abort=()=>{failure=new LlmError('LLM_CANCELLED','The request was cancelled.',{status:499});kill();};
  const timer=setTimeout(()=>{failure=new LlmError('LLM_TIMEOUT','The CLI did not answer in time.',{status:504});kill();},timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  function event(line) {
    if(!line.trim())return;
    let e;try{e=JSON.parse(line);}catch{failure=new LlmError('CODEX_INVALID_RESPONSE','The CLI returned invalid events.');kill();return;}
    if(['command_execution','mcp_tool_call','file_change','web_search'].includes(e.item?.type)) {
      failure=new LlmError('CODEX_NATIVE_TOOL_BLOCKED','The CLI attempted an unavailable native tool.');kill();
    }
    if(e.type==='item.completed' && e.item?.type==='agent_message')text=e.item.text;
    if(e.type==='turn.completed'){completed=true;usage=e.usage??{};}
    if(e.type==='turn.failed'||e.type==='error')failure=new LlmError('CODEX_CLI_FAILED','The CLI request failed. Check the local model connection and quota.');
  }
  child.stdout.on('data',chunk=>{
    bytes+=Buffer.byteLength(chunk);if(bytes>2_000_000){failure=new LlmError('CODEX_OUTPUT_LIMIT','The CLI response exceeded its size limit.');kill();return;}
    buffer+=chunk.toString();const lines=buffer.split(/\r?\n/);buffer=lines.pop();lines.forEach(event);
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-2000);});
  child.stdin.on('error',()=>{});
  child.stdin.end(prompt);
  try {
    const exit=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',()=>reject(fail('CODEX_CLI_MISSING','The local Codex CLI could not be started.')));});
    if(buffer.trim())event(buffer);
    if(failure)throw failure;
    if(exit!==0||!text||!completed)throw new LlmError('CODEX_CLI_FAILED',/401|unauthorized|authentication/i.test(stderr)?'The local CLI credential was refused.':'The CLI did not return a platform response.');
    return {text,usage};
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
