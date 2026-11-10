import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {RiverfieldAgent} from "../server/agent.ts";
import {Providers,complete,type ToolDefinition} from "../server/agent-providers.ts";
import {InferenceQueue} from "../server/inference-queue.ts";
import type {McpConnection} from "../server/agent-mcp.ts";
import {dialogueIncluded,type EngineApp} from "../server/production.ts";

const temporary=()=>mkdtempSync("/tmp/opencode/riverfield-production-test-");
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
 let step=0;const calls:any[]=[],requests:any[]=[];
 const connection=():McpConnection=>({tools:async()=>definitions,call:async(name,args)=>{calls.push({name,args});return handler?handler(name,args):text(name==="get_app"?{id:args.app,section:"video",inputs:[]}:name==="run_app"?{id:`job-${calls.length}`,app:args.app,status:"queued"}:{id:args.id,status:"succeeded",outputs:[]});},close:async()=>{}});
 const completion=async(...args:Parameters<typeof complete>)=>{requests.push(args);const reply=replies[step++]||{text:"Done",calls:[]};if(reply instanceof Error)throw reply;args[8](reply.text||"");return reply;};
 const queue=new InferenceQueue(),a=new RiverfieldAgent(dir,process.cwd(),queue.run,connection,completion);
 const p=a.providers.save({name:"Test local",location:"local",baseURL:"http://127.0.0.1:8080/v1",model:"fixture"});
 const c=a.store.create(p.id,"fixture");return {a,c,calls,requests,steps:()=>step};
}
const apps:EngineApp[]=[
 {id:"pika-studio-director",name:"Pika Director",section:"video",inputs:[{id:"flex_mode",type:"select",options:[{value:"ref2va"}]},{id:"steps",type:"number"}]},
 {id:"z-image",name:"Z Image",section:"image",inputs:[{id:"flex_mode",type:"select",options:[{value:"ref2va"}]}]},
];
const questions={questions:[
 {id:"format",header:"Format",question:"What are we making?",options:[{label:"Vertical micro-drama",description:"DramaBox style"},{label:"Series episode",description:"Streaming"}]},
 {id:"look",header:"Look",question:"Which reference style?",options:[{label:"DramaBox"},{label:"Black Mirror"}],multiple:false},
]};
const plan=()=>({
 format:"Vertical micro-drama",style:"DramaBox",platform:"TikTok / Reels",language:"French",aspect:"9:16",durationSeconds:20,sound:"dialogue",
 engine:"pika-studio-director",imageEngine:"z-image",model:"",lockedValues:{flex_mode:"ref2va"},treatment:"A two-scene hook and reversal.",
 scenes:[
  {id:"hook",title:"Hook",prompt:'DramaBox vertical, Lena confronts Marc in the rain: "I know what you did."',seconds:10,dialogue:[{speaker:"Lena",line:"I know what you did."}],references:[]},
  {id:"turn",title:"Turn",prompt:"DramaBox vertical, Marc steps back and looks away.",seconds:10,dialogue:[{speaker:"Marc",line:"Then prove it."}],references:[]},
 ],
});
const videoRun=(sceneIndex:number,withDialogue=true,source=plan())=>({text:"",calls:[{name:"run_app",arguments:{app:"pika-studio-director",values:{flex_mode:"ref2va",segment_windows:[{prompt:withDialogue?`${source.scenes[sceneIndex].prompt} ${source.scenes[sceneIndex].dialogue.map(d=>d.line).join(" ")}`:source.scenes[sceneIndex].prompt}]}}}]});
const longPlan=()=>{const p=plan();return {...p,durationSeconds:30,scenes:[...p.scenes,{id:"close",title:"Close",prompt:"DramaBox vertical, Lena walks away into the night.",seconds:10,dialogue:[{speaker:"Lena",line:"We are done."}],references:[]}]};};

test("ask_user pauses the turn, persists clickable answers as a tool result and resumes",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{
  const x=setup(dir,[call("ask_user",questions),{text:"Merci, je prépare le plan.",calls:[]}]);a=x.a;
  a.message(x.c.id,{text:"Fais un micro-drama"});let c=await settled(a,x.c.id);
  assert.equal(c.status,"question");assert.equal(c.tools[0].status,"asking");assert.ok(c.questions);assert.equal(c.questions.questions.length,2);
  assert.throws(()=>a!.message(c.id,{text:"ignore the questions"}),/questions/i);
  await assert.rejects(()=>a!.answer(c.id,{answers:{format:["Not offered"]}}),/not offered/);
  await a.answer(c.id,{answers:{format:["Vertical micro-drama"],look:["Black Mirror"]},notes:"French, 9:16"});
  c=await settled(a,c.id);
  assert.equal(c.status,"idle");assert.equal(c.questions,undefined);assert.equal(c.tools[0].status,"done");
  const result=c.messages.find(m=>m.callId===c.tools[0].id)!;
  assert.match(result.content,/Vertical micro-drama/);assert.match(result.content,/Black Mirror/);
  assert.equal(c.interview?.answers[0].selected[0],"Vertical micro-drama");assert.match(c.interview?.notes||"",/French/);
  assert.equal(x.calls.length,0,"ask_user is local");
  assert.match(x.requests.at(-1)[3],/Vertical micro-drama/,"the model receives the answers as durable data");
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});

test("video generation requires an approved plan; the model cannot approve its own draft",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{
  const x=setup(dir,[call("get_app",{app:"pika-studio-director"}),call("run_app",{app:"pika-studio-director",values:{segment_windows:[{prompt:plan().scenes[0].prompt}]}}),{text:"I need the plan approved.",calls:[]}]);a=x.a;
  a.message(x.c.id,{text:"generate the scene"});let c=await settled(a,x.c.id);
  assert.equal(x.calls.filter(t=>t.name==="run_app").length,0);
  assert.match(c.tools.find(t=>t.name==="run_app")?.error||"",/approved production plan/i);
  await a.close();

  const y=setup(dir,[call("get_app",{app:"pika-studio-director"}),call("production_plan",{action:"update",plan:{...plan(),status:"approved",pilot:{approved:true}}}),call("run_app",{app:"pika-studio-director",values:{segment_windows:[{prompt:plan().scenes[0].prompt}]}}),{text:"Waiting for your review.",calls:[]}]);a=y.a;
  a.message(y.c.id,{text:"draft the plan"});c=await settled(a,y.c.id);
  assert.equal(c.production?.status,"draft","the model cannot approve its own plan");
  assert.equal(c.production?.pilot.approved,false);
  assert.match(c.tools.find(t=>t.name==="run_app")?.error||"",/waiting for the user's review/i);
  assert.equal(y.calls.filter(t=>t.name==="run_app").length,0);
  const view=a.productionView(y.c.id,apps);assert.equal(view.production?.status,"draft");assert.ok(view.issues.length>=0);
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});

test("approval rejects an uncovered runtime, missing dialogue, wrong engine and unsupported locks",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{
  const x=setup(dir,[call("production_plan",{action:"update",plan:{...plan(),durationSeconds:60,engine:"z-image",lockedValues:{flex_mode:"unsupported"},scenes:[{...plan().scenes[0],dialogue:[],seconds:10}]}}),{text:"Draft ready.",calls:[]}]);a=x.a;
  a.message(x.c.id,{text:"draft"});const c=await settled(a,x.c.id);
  assert.equal(c.status,"idle");
  assert.throws(()=>a!.approveProduction(c.id,apps),(e:Error)=>{
   assert.match(e.message,/covers 10s but the requested runtime is 1:00/);assert.match(e.message,/Dialogue is required/);assert.match(e.message,/not a video app/);assert.match(e.message,/not a supported option/);return true;
  });
  assert.equal(a.store.get(c.id).production?.status,"draft");
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});

test("approved video must match a scene and include its dialogue; the pilot gate blocks the rest",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{
  let jobs=0;
  const x=setup(dir,[
   call("get_app",{app:"pika-studio-director"}),call("production_plan",{action:"update",plan:plan()}),{text:"Plan ready.",calls:[]},
   videoRun(1,false),{text:"Retrying with dialogue.",calls:[]},
  ],async(name,args)=>text(name==="get_app"?{id:args.app,section:"video",inputs:apps[0].inputs}:name==="run_app"?{id:`job-${++jobs}`,app:args.app,status:"queued"}:{id:args.id,status:"succeeded",outputs:[]}));a=x.a;
  a.message(x.c.id,{text:"prepare"});let c=await settled(a,x.c.id);assert.equal(c.production?.status,"draft");
  a.approveProduction(c.id,apps);
  a.message(c.id,{text:"second scene without the line"});c=await settled(a,c.id);
  assert.equal(x.calls.filter(t=>t.name==="run_app").length,0);
  assert.match(c.tools.filter(t=>t.name==="run_app").at(-1)?.error||"",/omits the approved dialogue/i);
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});

test("an approved scene can run as the pilot; further scenes wait for pilot approval",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{
  let jobs=0;
  const x=setup(dir,[
   call("get_app",{app:"pika-studio-director"}),call("production_plan",{action:"update",plan:plan()}),{text:"Plan ready.",calls:[]},
   videoRun(0),call("wait_job",{id:"job-1"}),{text:"Pilot ready.",calls:[]},
   videoRun(1),{text:"Pilot needs your review.",calls:[]},
   videoRun(1),call("wait_job",{id:"job-2"}),{text:"Episode complete.",calls:[]},
  ],async(name,args)=>text(name==="get_app"?{id:args.app,section:"video",inputs:apps[0].inputs}:name==="run_app"?{id:`job-${++jobs}`,app:args.app,status:"queued"}:{id:args.id,status:"succeeded",outputs:[]}));a=x.a;a.edit(x.c.id,{mode:"auto"});
  a.message(x.c.id,{text:"prepare"});let c=await settled(a,x.c.id);a.approveProduction(c.id,apps);
  a.message(c.id,{text:"pilot"});c=await settled(a,c.id);
  assert.equal(x.calls.filter(t=>t.name==="run_app").length,1);
  assert.equal(c.production?.scenes[0].status,"generated");assert.match((c.warnings||[]).join("\n"),/Pilot gate/i);

  // The next scene is refused until the pilot is approved in the studio.
  a.message(c.id,{text:"remaining"});c=await settled(a,c.id);
  assert.equal(x.calls.filter(t=>t.name==="run_app").length,1);
  assert.match(c.tools.filter(t=>t.name==="run_app").at(-1)?.error||"",/Pilot gate/i);

  c=a.store.get(c.id);c.artifacts.push({id:"pilot-clip",name:"pilot.mp4",path:join(dir,"pilot.mp4"),mime:"video/mp4",url:"/api/x",type:"video",seconds:10,job:"job-1"});a.store.save(c);
  a.approvePilot(c.id,"pilot-clip",apps);

  a.message(c.id,{text:"remaining after approval"});c=await settled(a,c.id);
  assert.equal(x.calls.filter(t=>t.name==="run_app").length,2);
  assert.equal(c.production?.scenes[1].status,"generated");assert.equal(c.production?.pilot.approved,true);
  assert.equal(c.status,"idle");
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});

test("ending a production turn below the approved runtime triggers one bounded studio-continuation",async()=>{
 const dir=temporary();let a:RiverfieldAgent|undefined;try{
  let jobs=0;
  const x=setup(dir,[
   call("get_app",{app:"pika-studio-director"}),call("production_plan",{action:"update",plan:longPlan()}),{text:"Plan ready.",calls:[]},
   videoRun(0,true,longPlan()),call("wait_job",{id:"job-1"}),{text:"Pilot ready.",calls:[]},
   videoRun(1,true,longPlan()),call("wait_job",{id:"job-2"}),{text:"Done!",calls:[]},{text:"Still done.",calls:[]},
  ],async(name,args)=>text(name==="get_app"?{id:args.app,section:"video",inputs:apps[0].inputs}:name==="run_app"?{id:`job-${++jobs}`,app:args.app,status:"queued"}:{id:args.id,status:"succeeded",outputs:[]}));a=x.a;a.edit(x.c.id,{mode:"auto"});
  a.message(x.c.id,{text:"prepare"});let c=await settled(a,x.c.id);a.approveProduction(c.id,apps);
  a.message(c.id,{text:"pilot"});c=await settled(a,c.id);
  assert.equal(c.production?.scenes[0].status,"generated");
  c=a.store.get(c.id);c.artifacts.push({id:"pilot-clip",name:"pilot.mp4",path:join(dir,"pilot.mp4"),mime:"video/mp4",url:"/api/x",type:"video",seconds:10,job:"job-1"});a.store.save(c);a.approvePilot(c.id,"pilot-clip",apps);
  a.message(c.id,{text:"produce the rest"});c=await settled(a,c.id);
  assert.equal(c.status,"idle");
  assert.equal(x.steps(),10,"one extra model call after the premature completion");
  assert.ok(c.messages.some(m=>m.kind==="studio"&&/NOT complete/.test(m.content)));
  assert.match((c.warnings||[]).join("\n"),/not complete/i);
  assert.equal(c.production?.scenes[2].status,"planned");
 }finally{await a?.close();rmSync(dir,{recursive:true,force:true});}
});

test("every approved dialogue line must be present, not just one",()=>{
 const scene={...plan().scenes[0],status:"planned" as const,dialogue:[{speaker:"Lena",line:"First line."},{speaker:"Marc",line:"Second line."}]};
 assert.equal(dialogueIncluded(scene,{prompt:"DramaBox vertical. First line."}),false);
 assert.equal(dialogueIncluded(scene,{prompt:"DramaBox vertical. First line. Second line."}),true);
});
