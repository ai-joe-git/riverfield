import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {AgentStore} from "../server/agent-store.ts";
import {RiverfieldAgent} from "../server/agent.ts";
import {Providers,complete,modelLimits,outputBudget} from "../server/agent-providers.ts";

const response=()=>new Response('data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n',{headers:{"content-type":"text/event-stream"}});
test("a 1M native output ceiling retains earlier conversation turns inside the shared context",()=>{
 const messages=[{role:"user",content:"Earlier context "+"a".repeat(12000)},{role:"assistant",content:"Retained answer"},{role:"user",content:"Follow-up"}];
 const p={tokenMode:"native",maxTokens:1048576,contextTokens:1048576};
 const packed=(RiverfieldAgent.prototype as any).context({messages},p);
 assert.deepEqual(packed,messages);
});
test("native limits use explicit per-model output metadata: 1M, 262K, 131K",async()=>{
 const dir=mkdtempSync("/tmp/opencode/agent-limits-");try{
  const store=new AgentStore(dir),models=[{id:"halogen",context_length:1048576,max_tokens_cap:1048576},{id:"large",context_length:1048576,top_provider:{max_completion_tokens:262144}},{id:"other",context_length:262144,max_output_tokens:131072}];
  const providers=new Providers(store.dir,(async()=>new Response(JSON.stringify({data:models}))) as typeof fetch);
  const config=providers.save({name:"Fixture",location:"local",baseURL:"http://localhost:8731/v1",maxTokens:2048});
  for(const [model,expected] of [["halogen",1048576],["large",262144],["other",131072]] as const){const p=await providers.resolve(config.id,model);assert.equal(p.nativeLimits?.outputTokens,expected);const b=outputBudget(p,1000)!;assert.ok(b>32768);assert.ok(b<=expected);assert.ok(b<=p.contextTokens-1256);}
  const p=await providers.resolve(config.id,"halogen");let payload:any;
  await complete(p,"","halogen","system",[],[],[],new AbortController().signal,()=>{},(async(_url,init)=>{payload=JSON.parse(init!.body as string);return response();}) as typeof fetch);
  assert.ok(payload.max_tokens>1000000,"legacy 2048 setting must not cap native Halogen output");assert.ok(payload.max_tokens<1048576,"input and tools reserve room in the shared window");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("context alone is not invented as a native output cap; unknown OpenAI defaults are delegated to the server",async()=>{
 assert.equal(modelLimits({id:"unknown",context_length:1048576}).outputTokens,null);
 const dir=mkdtempSync("/tmp/opencode/agent-limits-");try{const providers=new Providers(new AgentStore(dir).dir),saved=providers.save({name:"Unknown",location:"local",baseURL:"http://localhost:8080/v1"}),p=providers.get(saved.id);let payload:any;
  await complete(p,"","unknown","system",[],[],[],new AbortController().signal,()=>{},(async(_url,init)=>{payload=JSON.parse(init!.body as string);return response();}) as typeof fetch);assert.equal(payload.max_tokens,undefined);
  assert.throws(()=>outputBudget(p,p.contextTokens),/context is full/,"delegating output capacity does not waive the input context bound");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("custom caps above 32K remain available and are bounded by context, without consuming the whole history allowance",()=>{
 const dir=mkdtempSync("/tmp/opencode/agent-limits-");try{const providers=new Providers(new AgentStore(dir).dir),saved=providers.save({name:"Custom",location:"local",baseURL:"http://localhost:8080/v1",tokenMode:"custom",maxTokens:262144,contextTokens:1048576});
 assert.equal(outputBudget(providers.get(saved.id),1000),262144);
 const p={...providers.get(saved.id),contextTokens:131072};assert.equal(outputBudget(p,1000),129816);assert.throws(()=>outputBudget(p,131072),/context is full/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("older saved profiles default to native without modifying credentials or raw numeric settings",()=>{
 const dir=mkdtempSync("/tmp/opencode/agent-limits-");try{const providers=new Providers(new AgentStore(dir).dir);const saved=providers.save({name:"Old",location:"local",baseURL:"http://localhost:8080/v1",maxTokens:2048});const data=JSON.parse(readFileSync(providers.path,"utf8"));delete data[0].tokenMode;writeFileSync(providers.path,JSON.stringify(data));
 assert.equal(providers.get(saved.id).tokenMode,"native");assert.equal(providers.list()[0].tokenMode,"native");assert.equal(providers.get(saved.id).maxTokens,2048);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("model metadata cache is per connection, refreshable, and resolves the selected model rather than its default",async()=>{
 const dir=mkdtempSync("/tmp/opencode/agent-limits-");try{let requests=0;const providers=new Providers(new AgentStore(dir).dir,(async()=>{requests++;return new Response(JSON.stringify({data:[{id:"small",max_output_tokens:131072,context_length:262144},{id:"big",max_tokens_cap:1048576,context_length:1048576}]}));}) as typeof fetch);
 const p=providers.save({name:"Fixture",location:"local",baseURL:"http://localhost:8080/v1",model:"small"});assert.equal((await providers.resolve(p.id,"big")).nativeLimits?.outputTokens,1048576);assert.equal((await providers.limits(p.id,"small")).outputTokens,131072);assert.equal(requests,1);await providers.models(p.id,true);assert.equal(requests,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
