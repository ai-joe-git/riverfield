import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync} from "node:fs";
import {join} from "node:path";
import {RiverfieldAgent} from "../server/agent.ts";
import {AgentStore} from "../server/agent-store.ts";
import {Providers,complete,sse,toolSchema,type ToolDefinition} from "../server/agent-providers.ts";
import {InferenceQueue} from "../server/inference-queue.ts";
import type {McpConnection} from "../server/agent-mcp.ts";

const temporary=()=>mkdtempSync("/tmp/opencode/riverfield-agent-test-");
const schema=(properties:any,required:string[]=[])=>({type:"object",properties,required,additionalProperties:false});
const definitions:ToolDefinition[]=[
 {name:"list_apps",description:"Apps",inputSchema:schema({})},
 {name:"get_app",description:"Manifest",inputSchema:schema({app:{type:"string"}},["app"])},
 {name:"run_app",description:"Run",inputSchema:schema({app:{type:"string"},values:{type:"object"},files:{type:"object"}},["app"])},
 ...["job","wait_job","cancel_job"].map(name=>({name,inputSchema:schema({id:{type:"string"}},["id"])})),
 {name:"history",inputSchema:{type:"object"}},
];
const text=(data:any)=>({content:[{type:"text",text:JSON.stringify(data)}]});
const call=(name:string,args:any={})=>({text:"",calls:[{id:"model-reuses-this-id",name,arguments:args}]});
async function settled(a:RiverfieldAgent,id:string){for(let i=0;i<500;i++){const c=a.store.get(id);if(c.status!=="running")return c;await new Promise(r=>setTimeout(r,10));}throw new Error("Agent timeout");}
function setup(dir:string,replies:any[],handler?:(name:string,args:any)=>Promise<any>,prepareNative?:ConstructorParameters<typeof RiverfieldAgent>[5]){
 let step=0;const calls:any[]=[],requests:any[]=[];
 const connection=():McpConnection=>({tools:async()=>definitions,call:async(name,args)=>{calls.push({name,args});return handler?handler(name,args):text(name==="get_app"?{id:args.app,inputs:[]}:name==="run_app"?{id:"job-a",app:args.app,status:"succeeded"}:{id:args.id,status:"succeeded",outputs:[]});},close:async()=>{}});
 const completion=async(...args:Parameters<typeof complete>)=>{requests.push(args);const reply=replies[step++]||{text:"Done",calls:[]};if(reply instanceof Error)throw reply;args[8](reply.text||"");return reply;};
 const queue=new InferenceQueue(),a=new RiverfieldAgent(dir,process.cwd(),queue.run,connection,completion,prepareNative);
 const p=a.providers.save({name:"Test local",location:"local",baseURL:"http://127.0.0.1:8080/v1",model:"fixture"});
 const c=a.store.create(p.id,"fixture");return {a,c,calls,steps:()=>step,connection,requests,queue};
}
test("providers are server-side, redacted and protected; endpoint labels are enforced",()=>{
 const dir=temporary();try{const s=new AgentStore(dir),p=new Providers(s.dir);const v=p.save({name:"OpenAI",location:"remote",baseURL:"https://api.openai.com/v1",apiKey:"PRIVATE-TEST-KEY",model:"test"});
 assert.equal(v.keyPresent,true);assert.ok(!JSON.stringify(p.list()).includes("PRIVATE-TEST-KEY"));assert.equal(statSync(p.path).mode&0o777,0o600);assert.equal(p.redact(new Error("key PRIVATE-TEST-KEY")),"key [redacted]");
 assert.throws(()=>p.save({name:"Wrong local",location:"local",baseURL:"https://example.com/v1"}),/loopback/);
 assert.throws(()=>p.save({name:"Wrong remote",location:"remote",baseURL:"http://api.example.com/v1"}),/HTTPS/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("provider schema adaptation preserves properties named pattern while removing unsupported schema keywords",()=>{
 const original={type:"object",properties:{pattern:{type:"string",pattern:"a"},counts:{type:"object",propertyNames:{type:"string"},additionalProperties:{type:"integer"}}}};
 const adapted=toolSchema(original);assert.ok(adapted.properties.pattern);assert.equal(adapted.properties.pattern.pattern,undefined);assert.equal(adapted.properties.counts.propertyNames,undefined);assert.equal(original.properties.pattern.pattern,"a");
});
function stream(events:any[]){return new Response(new ReadableStream({start(controller){const bytes=new TextEncoder().encode(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(""));for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}}),{headers:{"content-type":"text/event-stream"}});}
test("provider HTTP errors explain memory failures without unrelated tool advice or raw budgets",async()=>{
 const dir=temporary();try{const providers=new Providers(new AgentStore(dir).dir),p=providers.get(providers.save({name:"Fixture",location:"local",baseURL:"http://localhost:41969/v1",model:"fixture"}).id);
 const failures=[
  {status:503,body:JSON.stringify({error:{code:"RUNTIME_MEMORY_PRESSURE",message:"Model needs 14.6 GiB; 13.9 GiB available. PRIVATE-KEY",memoryBudget:{requestedBytes:15644569061}}}),match:/503 \(RUNTIME_MEMORY_PRESSURE\): Model needs 14.6 GiB; 13.9 GiB available. \[redacted\]/,hint:false},
  {status:401,body:JSON.stringify({error:{message:"Invalid API key PRIVATE-KEY"}}),match:/401: Invalid API key \[redacted\]/,hint:false},
  {status:503,body:"Backend unavailable",match:/503: Backend unavailable/,hint:false},
  {status:400,body:JSON.stringify({error:{message:"tools is not supported for this model"}}),match:/400: tools is not supported/,hint:true},
 ];
 for(const f of failures)await assert.rejects(()=>complete(p,"PRIVATE-KEY","fixture","system",[],[],[],new AbortController().signal,()=>{},(async()=>new Response(f.body,{status:f.status})) as typeof fetch),(error:Error)=>{assert.match(error.message,f.match);assert.equal(error.message.includes("JSON tool protocol"),f.hint);assert.ok(!error.message.includes("memoryBudget"));assert.ok(!error.message.includes("PRIVATE-KEY"));return true;});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("OpenAI-compatible native tools stream UTF-8 text and incremental function arguments",async()=>{
 const dir=temporary();try{const p=new Providers(new AgentStore(dir).dir),config=p.get(p.save({name:"Local",location:"local",baseURL:"http://localhost:8080/v1",model:"m"}).id);let request:any;let deltas="";
 const result=await complete(config,"","m","system",[],definitions,[],new AbortController().signal,d=>deltas+=d,(async(_url,init)=>{request=JSON.parse(init!.body as string);return stream([{choices:[{delta:{content:"Été "}}]},{choices:[{delta:{tool_calls:[{index:0,id:"c",function:{name:"get_app",arguments:'{"app":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"z-image"}'}}]},finish_reason:"tool_calls"}]}]);}) as typeof fetch);
 assert.equal(deltas,"Été ");assert.equal(result.calls[0].name,"get_app");assert.deepEqual(result.calls[0].arguments,{app:"z-image"});assert.ok(request.tools.length);assert.equal(request.stream,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("Anthropic uses native tool_use blocks and returns real incremental tool inputs",async()=>{
 const dir=temporary();try{const p=new Providers(new AgentStore(dir).dir),config=p.get(p.save({name:"Claude",kind:"anthropic",location:"remote",baseURL:"https://api.anthropic.com/v1",apiKey:"secret",model:"m"}).id);let payload:any;
 const result=await complete(config,"secret","m","system",[],definitions,[],new AbortController().signal,()=>{},(async(url,init)=>{assert.match(String(url),/\/messages$/);assert.equal((init!.headers as any)["x-api-key"],"secret");payload=JSON.parse(init!.body as string);return stream([{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"t",name:"list_apps"}},{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:"{}"}},{type:"message_stop"}]);}) as typeof fetch);
 assert.equal(result.calls[0].name,"list_apps");assert.ok(payload.tools[0].input_schema);assert.equal(payload.system,"system");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("JSON tool fallback is explicit and malformed/incomplete output is never executed",async()=>{
 const dir=temporary();try{const p=new Providers(new AgentStore(dir).dir),config=p.get(p.save({name:"Fallback",location:"local",baseURL:"http://localhost:8080/v1",model:"m",toolMode:"json"}).id);
 const result=await complete(config,"","m","system",[],definitions,[],new AbortController().signal,()=>{},(async()=>stream([{choices:[{delta:{content:JSON.stringify({text:"Inspecting",tool_calls:[{name:"list_apps",arguments:{}}]})},finish_reason:"stop"}]}])) as typeof fetch);assert.equal(result.calls[0].name,"list_apps");
 await assert.rejects(()=>complete({...config,toolMode:"native"},"","m","system",[],definitions,[],new AbortController().signal,()=>{},(async()=>stream([{choices:[{delta:{content:"partial"}}]}])) as typeof fetch),/without a completion marker/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("plain-text writing sends no tool protocol even for JSON-fallback profiles; managed thinking can be disabled",async()=>{
 const dir=temporary();try{const providers=new Providers(new AgentStore(dir).dir),p=providers.get(providers.save({name:"Writer",location:"local",baseURL:"http://127.0.0.1:1/v1",model:"fixture",toolMode:"json"}).id);let payload:any;
  const result=await complete({...p,runtimeProfile:"owned-fixture",tokenMode:"custom",maxTokens:96},"","fixture","Write plain text.",[],[],[],new AbortController().signal,()=>{},(async(_url,init)=>{payload=JSON.parse(init!.body as string);return stream([{choices:[{delta:{content:"Bonjour."},finish_reason:"stop"}]}]);}) as typeof fetch,{thinking:false});
  assert.equal(result.text,"Bonjour.");assert.deepEqual(result.calls,[]);assert.equal(payload.tools,undefined);assert.equal(payload.tool_choice,undefined);assert.doesNotMatch(payload.messages[0].content,/Explicit JSON tool protocol/);assert.equal(payload.chat_template_kwargs.enable_thinking,false);assert.equal(payload.max_tokens,96);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("opted-in audio/video attachments send real media payloads rather than just filenames",async()=>{
 const dir=temporary();try{const store=new AgentStore(dir),providers=new Providers(store.dir),p=providers.get(providers.save({name:"Omni",location:"local",baseURL:"http://localhost:1/v1",model:"fixture",audio:true,video:true}).id),c=store.create();const audio=store.upload(c,Buffer.from("mock audio bytes"),"clip.wav","audio/wav"),video=store.upload(c,Buffer.from("mock video bytes"),"clip.mp4","video/mp4");let payload:any;const message={id:"message",role:"user" as const,content:"Listen and watch",attachments:[audio.id,video.id],created:new Date().toISOString()};const fetcher=(async(_url:any,init:any)=>{payload=JSON.parse(init.body);return stream([{choices:[{delta:{content:"Media received."},finish_reason:"stop"}]}]);}) as typeof fetch;
  await complete(p,"","fixture","Describe supplied media only.",[message],[],c.attachments,new AbortController().signal,()=>{},fetcher);const parts=payload.messages[1].content;assert.equal(parts.find((a:any)=>a.type==="input_audio").input_audio.data,Buffer.from("mock audio bytes").toString("base64"));assert.equal(parts.find((a:any)=>a.type==="input_audio").input_audio.format,"wav");assert.equal(parts.find((a:any)=>a.type==="input_video").input_video.data,Buffer.from("mock video bytes").toString("base64"));assert.equal(payload.tools,undefined);
  await complete({...p,audio:false,video:false},"","fixture","system",[message],[],c.attachments,new AbortController().signal,()=>{},fetcher);assert.ok(payload.messages[1].content.some((a:any)=>a.text?.includes("Audio bytes were NOT sent")));assert.ok(payload.messages[1].content.some((a:any)=>a.text?.includes("Video frames and soundtrack were NOT sent")));assert.ok(!payload.messages[1].content.some((a:any)=>a.type==="input_audio"||a.type==="input_video"));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("real agent cycles discover apps, read a manifest, ask approval, then return actual job/artifact output",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{
 const folder=join(dir,"history","20261109-120000000-abcd");mkdirSync(folder,{recursive:true});writeFileSync(join(folder,"out-01.png"),"fixture");writeFileSync(join(folder,"meta.json"),JSON.stringify({id:"20261109-120000000-abcd",app:"z-image",outputs:[{file:"out-01.png"}],inputs:[]}));
 const x=setup(dir,[call("list_apps"),call("get_app",{app:"z-image"}),call("run_app",{app:"z-image",values:{prompt:"a character"}}),call("wait_job",{id:"20261109-120000000-abcd"}),{text:"The actual image is ready.",calls:[]}],async(name,args)=>text(name==="run_app"?{id:"20261109-120000000-abcd",app:args.app,status:"succeeded"}:name==="wait_job"?{id:args.id,status:"succeeded",outputs:[{path:join(folder,"out-01.png"),type:"image"}]}:{id:args.app,inputs:[]}));a=x.a;
 a.message(x.c.id,{text:"Créer une référence"});let c=await settled(a,x.c.id);assert.equal(c.status,"approval");assert.equal(x.calls.filter(c=>c.name==="run_app").length,0);
 const t=c.tools.find(t=>t.name==="run_app")!;a.approve(c.id,t.id,true);c=await settled(a,c.id);assert.equal(c.status,"idle");assert.equal(c.artifacts.length,1);assert.equal(c.artifacts[0].type,"image");assert.equal(c.jobs.length,1);assert.equal(x.calls.filter(c=>c.name==="run_app").length,1);
 assert.ok(x.calls.find(c=>c.name==="run_app").args.request_id);assert.equal(new Set(c.tools.map(t=>t.id)).size,c.tools.length,"reused model tool IDs must not collide");
 a.resume(c.id);c=await settled(a,c.id);assert.equal(x.calls.filter(c=>c.name==="run_app").length,1,"completed tools are not rerun");
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("read-only and scoped files are enforced outside model control",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{const x=setup(dir,[call("get_app",{app:"x"}),call("run_app",{app:"x",files:{image:"/etc/passwd"}}),{text:"Refused",calls:[]}]);a=x.a;a.edit(x.c.id,{mode:"auto"});a.message(x.c.id,{text:"test"});let c=await settled(a,x.c.id);assert.equal(x.calls.some(c=>c.name==="run_app"),false);assert.match(c.tools.at(-1)!.error!,/permission denied/);
 a.edit(c.id,{mode:"read-only"});a.message(c.id,{text:"again"});c=await settled(a,c.id);assert.equal(c.status,"idle");
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("tool errors become tool results and unknown/invalid calls cannot execute",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{const x=setup(dir,[call("made_up_tool"),call("get_app",{}),call("list_apps"),{text:"Errors handled",calls:[]}],async()=>({isError:true,content:[{type:"text",text:"Backend unavailable"}]}));a=x.a;a.message(x.c.id,{text:"test"});const c=await settled(a,x.c.id);assert.equal(c.status,"idle");assert.equal(x.calls.length,1);assert.equal(c.tools.filter(t=>t.status==="error").length,3);assert.ok(c.messages.some(m=>m.role==="tool"&&m.content.includes("Unknown MCP tool")));
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("identical non-polling tool calls stop the turn instead of looping",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{const x=setup(dir,[call("list_apps"),call("list_apps"),{text:"must not run",calls:[]}],async()=>text({count:0,apps:[]}));a=x.a;
 a.message(x.c.id,{text:"find image apps"});const c=await settled(a,x.c.id);
 assert.equal(c.status,"failed");assert.match(c.error||"",/repeated list_apps with identical arguments/i);
 assert.equal(x.calls.filter(c=>c.name==="list_apps").length,1,"the repeated call is not dispatched");
 assert.equal(c.tools.filter(t=>t.name==="list_apps").length,2);assert.ok(c.tools.some(t=>t.status==="error"&&/repeated list_apps/i.test(t.error||"")));
 for(const m of c.messages)for(const call of m.calls||[])assert.ok(c.messages.some(x=>x.role==="tool"&&x.callId===call.id),"every assistant tool call keeps a matching tool message");
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("polling tools may legitimately repeat with the same id in one turn",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{const x=setup(dir,[call("wait_job",{id:"job-a"}),call("wait_job",{id:"job-a"}),{text:"Done",calls:[]}],async()=>text({id:"job-a",status:"succeeded",outputs:[]}));a=x.a;
 a.message(x.c.id,{text:"wait for the job"});const c=await settled(a,x.c.id);
 assert.equal(c.status,"idle");assert.equal(x.calls.filter(c=>c.name==="wait_job").length,2);
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("a lost generation can be retried with the same arguments in one turn",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{let jobs=0;
 const x=setup(dir,[call("get_app",{app:"z-image"}),call("run_app",{app:"z-image",values:{prompt:"x"}}),call("run_app",{app:"z-image",values:{prompt:"x"}}),{text:"Retried after the backend loss",calls:[]}],
  async(name,args)=>text(name==="get_app"?{id:"z-image",inputs:[]}:{id:`job-${++jobs}`,app:args.app,status:jobs===1?"lost":"failed"}));a=x.a;a.edit(x.c.id,{mode:"auto"});
 a.message(x.c.id,{text:"make the scene"});const c=await settled(a,x.c.id);
 assert.equal(c.status,"idle");assert.equal(x.calls.filter(c=>c.name==="run_app").length,2,"a lost job is not a duplicate generation");
 assert.equal(c.tools.filter(t=>t.name==="run_app").length,2);
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("a succeeded generation still cannot be submitted twice in one turn",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{
 const x=setup(dir,[call("get_app",{app:"z-image"}),call("run_app",{app:"z-image",values:{prompt:"x"}}),call("run_app",{app:"z-image",values:{prompt:"x"}}),{text:"must not run",calls:[]}],
  async(name,args)=>text(name==="get_app"?{id:"z-image",inputs:[]}:{id:"job-1",app:args.app,status:"succeeded",outputs:[]}));a=x.a;a.edit(x.c.id,{mode:"auto"});
 a.message(x.c.id,{text:"make the scene"});const c=await settled(a,x.c.id);
 assert.equal(c.status,"failed");assert.match(c.error||"",/already submitted/i);
 assert.equal(x.calls.filter(c=>c.name==="run_app").length,1);
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("lost generation retries remain bounded, including after a successful retry",async()=>{
 for(const second of ["lost","succeeded"]){const dir=temporary();let a:RiverfieldAgent|undefined;try{let jobs=0;
 const x=setup(dir,[call("get_app",{app:"z-image"}),...Array.from({length:3},()=>call("run_app",{app:"z-image",values:{prompt:"x"}}))],async(name,args)=>text(name==="get_app"?{id:args.app,inputs:[]}:{id:`job-${++jobs}`,app:args.app,status:jobs===1?"lost":second}));a=x.a;a.edit(x.c.id,{mode:"auto"});a.message(x.c.id,{text:"make it"});const c=await settled(a,x.c.id);assert.equal(c.status,"failed");assert.equal(x.calls.filter(t=>t.name==="run_app").length,2);
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}}
});
test("project_state is local and persisted; model updates cannot change user engine locks",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{const x=setup(dir,[call("project_state",{action:"update",state:{summary:"Keep cast and locations",references:[],scenes:[],activeScene:""}}),{text:"Plan recorded",calls:[]}]);a=x.a;a.edit(x.c.id,{mode:"auto",project:{brief:"Black Mirror style, vertical",summary:"",references:[],scenes:[],activeScene:"",lock:{section:"video",app:"pika-studio-director",values:{adapter:"ref2va"}}}});a.message(x.c.id,{text:"plan the scenes"});const c=await settled(a,x.c.id);assert.equal(c.project?.summary,"Keep cast and locations");assert.equal(c.project?.lock.app,"pika-studio-director");assert.equal(x.calls.filter(t=>t.name==="project_state").length,0);assert.match(x.requests.at(-1)[3],/Black Mirror style, vertical/);assert.match(x.requests.at(-1)[3],/Keep cast and locations/);
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("read-only project writes and user-locked video substitutions cannot dispatch",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{const x=setup(dir,[call("project_state",{action:"update",state:{summary:"no",references:[],scenes:[],activeScene:""}}),{text:"No update",calls:[]}]);a=x.a;a.edit(x.c.id,{mode:"read-only"});a.message(x.c.id,{text:"inspect"});let c=await settled(a,x.c.id);assert.equal(c.tools[0].status,"error");assert.match(c.tools[0].error||"",/read-only/);assert.equal(x.calls.length,0);await a.close();
 const y=setup(dir,[call("get_app",{app:"h3-r2v"}),call("run_app",{app:"h3-r2v",values:{prompt:"x"}}),{text:"Use Pika instead",calls:[]}],async()=>text({id:"h3-r2v",section:"video",inputs:[]}));a=y.a;a.edit(y.c.id,{mode:"auto",project:{brief:"",summary:"",references:[],scenes:[],activeScene:"",lock:{section:"video",app:"pika-studio-director",values:{}}}});a.message(y.c.id,{text:"make it"});c=await settled(a,y.c.id);assert.equal(y.calls.filter(t=>t.name==="run_app").length,0);assert.match(c.tools.find(t=>t.name==="run_app")?.error||"",/locked video engine/);
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("managed provider preparation occurs inside the shared GPU slot before completion",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{let prepared=0;const x=setup(dir,[{text:"Ready",calls:[]}],undefined,async(p)=>{prepared++;assert.ok(x.queue.snapshot().active?.label.startsWith("Agent"));return {...p,baseURL:"http://127.0.0.1:45678/v1",model:"riverfield-fixture",contextTokens:4096,temperature:.3};});a=x.a;const p=a.providers.get(x.c.provider);a.providers.save({...p,runtimeProfile:"fixture"});a.message(x.c.id,{text:"hello"});const c=await settled(a,x.c.id);assert.equal(c.status,"idle");assert.equal(prepared,1);assert.equal(x.requests[0][0].baseURL,"http://127.0.0.1:45678/v1");assert.equal(x.requests[0][2],"riverfield-fixture");assert.equal(x.requests[0][0].contextTokens,4096);
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("restart marks uncertain dispatches and reconnects known jobs without resubmitting generation",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{const x=setup(dir,[]);a=x.a;const c=x.c;c.status="running";c.jobs=["owned-job"];c.tools=[{id:"pending",name:"run_app",arguments:{app:"z-image"},status:"running"}];a.store.save(c);await a.close();
 const calls:any[]=[];a=new RiverfieldAgent(dir,process.cwd(),new InferenceQueue().run,()=>({tools:async()=>definitions,call:async(name,args)=>{calls.push(name);return text(name==="history"?{runs:[{id:"owned-job",app:"z-image",status:"succeeded"}]}:{id:args.id,status:"succeeded",outputs:[]});},close:async()=>{}}));
 assert.equal(a.store.get(c.id).status,"interrupted");const recovered=await a.refreshJobs(c.id);assert.equal(recovered.tools[0].status,"done");assert.equal(recovered.jobStates["owned-job"].status,"succeeded");assert.ok(!calls.includes("run_app"));
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});
test("shared GPU slot is released before MCP work; a local agent waits behind media jobs",async()=>{
 const dir=temporary();const queue=new InferenceQueue();let finish!:()=>void;const media=queue.run("existing media job",()=>new Promise<void>(r=>finish=r));let invoked=false;
 const a=new RiverfieldAgent(dir,process.cwd(),queue.run,()=>({tools:async()=>definitions,call:async()=>text({}),close:async()=>{}}),async()=>{invoked=true;return {text:"Finished",calls:[]};});
 try{const p=a.providers.save({name:"local",location:"local",baseURL:"http://127.0.0.1:8080/v1",model:"test"}),c=a.store.create(p.id,"test");a.message(c.id,{text:"hello"});await new Promise(r=>setTimeout(r,20));assert.equal(invoked,false);finish();await media;assert.equal((await settled(a,c.id)).status,"idle");assert.equal(invoked,true);
 }finally{finish();await a.close();rmSync(dir,{recursive:true,force:true});}
});
