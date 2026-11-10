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
function setup(dir:string,replies:any[],handler?:(name:string,args:any)=>Promise<any>){
 let step=0;const calls:any[]=[];
 const connection=():McpConnection=>({tools:async()=>definitions,call:async(name,args)=>{calls.push({name,args});return handler?handler(name,args):text(name==="get_app"?{id:args.app,inputs:[]}:name==="run_app"?{id:"job-a",app:args.app,status:"succeeded"}:{id:args.id,status:"succeeded",outputs:[]});},close:async()=>{}});
 const completion=async(...args:Parameters<typeof complete>)=>{const reply=replies[step++]||{text:"Done",calls:[]};if(reply instanceof Error)throw reply;args[8](reply.text||"");return reply;};
 const a=new RiverfieldAgent(dir,process.cwd(),new InferenceQueue().run,connection,completion);
 const p=a.providers.save({name:"Test local",location:"local",baseURL:"http://127.0.0.1:8080/v1",model:"fixture"});
 const c=a.store.create(p.id,"fixture");return {a,c,calls,steps:()=>step,connection};
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
