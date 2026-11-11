import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {RiverfieldAgent} from "../server/agent.ts";
import {complete,type ToolDefinition} from "../server/agent-providers.ts";
import {InferenceQueue} from "../server/inference-queue.ts";
import type {McpConnection} from "../server/agent-mcp.ts";
import {draftProduction} from "../server/production.ts";

const text=(data:any)=>({content:[{type:"text",text:JSON.stringify(data)}]});
const call=(name:string,args:any={})=>({text:"",calls:[{id:"model-id",name,arguments:args}]});
async function settled(a:RiverfieldAgent,id:string){for(let i=0;i<500;i++){const c=a.store.get(id);if(c.status!=="running")return c;await new Promise(r=>setTimeout(r,10));}throw new Error("Agent timeout");}
function setup(replies:any[]){
 const dir=mkdtempSync("/tmp/opencode/riverfield-production-test-"),calls:any[]=[];
 const definitions:ToolDefinition[]=["get_app","run_app","job","cancel_job"].map(name=>({name,inputSchema:{type:"object"}}));
 const connection=():McpConnection=>({tools:async()=>definitions,call:async(name,args)=>{calls.push({name,args});return text(name==="get_app"?{id:args.app,section:"video",inputs:[]}:name==="run_app"?{id:"job-1",app:args.app,status:"succeeded",outputs:[]}:{id:args.id,status:"succeeded",outputs:[]});},close:async()=>{}});
 let step=0;
 const completion=async(...args:Parameters<typeof complete>)=>{const reply=replies[step++]||{text:"Done",calls:[]};args[8](reply.text||"");return reply;};
 const a=new RiverfieldAgent(dir,process.cwd(),new InferenceQueue().run,connection,completion);
 const p=a.providers.save({name:"Fixture",location:"local",baseURL:"http://127.0.0.1:8080/v1",model:"fixture"});
 const c=a.store.create(p.id,"fixture");
 return {a,c,calls,cleanup:async()=>{await a.close();rmSync(dir,{recursive:true,force:true});}};
}

test("conversational video requests need normal tool approval, not a mandatory production schema",async()=>{
 const x=setup([call("get_app",{app:"pika-studio-director"}),call("run_app",{app:"pika-studio-director",values:{}})]);
 try{
  x.a.message(x.c.id,{text:"Run the approved single pilot"});let c=await settled(x.a,x.c.id);
  assert.equal(c.status,"approval");assert.equal(c.production,undefined);assert.equal(x.calls.filter(t=>t.name==="run_app").length,0);
  x.a.approve(c.id,c.tools.at(-1)!.id,true);c=await settled(x.a,c.id);
  assert.equal(c.status,"idle");assert.equal(x.calls.filter(t=>t.name==="run_app").length,1);
  assert.ok(!c.messages.some(m=>m.kind==="studio"),"no automatic continuation to more scenes");
 }finally{await x.cleanup();}
});

test("a declined generation is never dispatched",async()=>{
 const x=setup([call("get_app",{app:"pika-studio-director"}),call("run_app",{app:"pika-studio-director"})]);
 try{x.a.message(x.c.id,{text:"Propose a pilot"});let c=await settled(x.a,x.c.id);x.a.approve(c.id,c.tools.at(-1)!.id,false);c=await settled(x.a,c.id);assert.equal(x.calls.filter(t=>t.name==="run_app").length,0);assert.equal(c.tools.at(-1)!.status,"denied");}finally{await x.cleanup();}
});

test("legacy production and project engine locks do not block a separately approved RelayVSR utility",async()=>{
 const x=setup([call("get_app",{app:"relayvsr-upscale"}),call("run_app",{app:"relayvsr-upscale",values:{}})]);
 try{
  const c=x.a.store.get(x.c.id);
  draftProduction(c,{format:"Short",style:"Documentary",platform:"Mobile",language:"French",aspect:"9:16",durationSeconds:5,sound:"dialogue",engine:"pika-studio-director",imageEngine:"moss-turbo",model:"",lockedValues:{flex_mode:"ref2va"},treatment:"One pilot",scenes:[{id:"pilot",title:"Pilot",prompt:"One nervous contestant in a game-show studio",seconds:5,dialogue:[{speaker:"Candidate",line:"Oui."}],references:[]}]});
  c.project={brief:"",summary:"",references:[],scenes:[],activeScene:"",lock:{section:"video",app:"pika-studio-director",values:{flex_mode:"ref2va"}}};x.a.store.save(c);
  x.a.message(c.id,{text:"Separately authorize an upscale of the existing clip"});let latest=await settled(x.a,c.id);assert.equal(latest.status,"approval");
  x.a.approve(c.id,latest.tools.at(-1)!.id,true);latest=await settled(x.a,c.id);assert.equal(latest.status,"idle");assert.equal(x.calls.filter(t=>t.name==="run_app").length,1);
 }finally{await x.cleanup();}
});

test("duplicate GPU calls in the same user turn are stopped",async()=>{
 const run=call("run_app",{app:"pika-studio-director",values:{seed:42}}),x=setup([call("get_app",{app:"pika-studio-director"}),run,run]);
 try{x.a.edit(x.c.id,{mode:"auto"});x.a.message(x.c.id,{text:"One approved pilot only"});const c=await settled(x.a,x.c.id);assert.equal(x.calls.filter(t=>t.name==="run_app").length,1);assert.match(c.error||"",/paying twice/);}finally{await x.cleanup();}
});

test("ask_user remains optional and resumes with the user's actual answers",async()=>{
 const x=setup([call("ask_user",{questions:[{id:"language",header:"Language",question:"Dialogue language?",options:[{label:"French"},{label:"English"}]}]})]);
 try{x.a.message(x.c.id,{text:"Ask the missing essential question"});let c=await settled(x.a,x.c.id);assert.equal(c.status,"question");await x.a.answer(c.id,{answers:{language:["French"]}});c=await settled(x.a,c.id);assert.equal(c.status,"idle");assert.equal(c.interview?.answers[0].selected[0],"French");assert.equal(x.calls.length,0);}finally{await x.cleanup();}
});
