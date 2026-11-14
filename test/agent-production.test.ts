import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {loadRegistry} from "../server/registry.ts";
import {RiverfieldAgent} from "../server/agent.ts";
import {complete,type ToolDefinition} from "../server/agent-providers.ts";
import {InferenceQueue} from "../server/inference-queue.ts";
import type {McpConnection} from "../server/agent-mcp.ts";
import {draftProduction} from "../server/production.ts";

const text=(data:any)=>({content:[{type:"text",text:JSON.stringify(data)}]});
const call=(name:string,args:any={})=>({text:"",calls:[{id:"model-id",name,arguments:args}]});
async function settled(a:RiverfieldAgent,id:string){for(let i=0;i<500;i++){const c=a.store.get(id);if(c.status!=="running")return c;await new Promise(r=>setTimeout(r,10));}throw new Error("Agent timeout");}
function setup(replies:any[],runResult?:(args:any,index:number)=>any){
 const dir=mkdtempSync("/tmp/opencode/riverfield-production-test-"),calls:any[]=[],catalogs:ToolDefinition[][]=[];
 const definitions:ToolDefinition[]=["get_app","run_app","job","cancel_job"].map(name=>({name,inputSchema:{type:"object"}}));
 const connection=():McpConnection=>({tools:async()=>definitions,call:async(name,args)=>{calls.push({name,args});if(name==="run_app"&&runResult)return runResult(args,calls.filter(c=>c.name==="run_app").length);return text(name==="get_app"?{id:args.app,section:"video",inputs:[]}:name==="run_app"?{id:"job-1",app:args.app,status:"succeeded",outputs:[]}:{id:args.id,status:"succeeded",outputs:[]});},close:async()=>{}});
 let step=0;
 const completion=async(...args:Parameters<typeof complete>)=>{catalogs.push(args[5]);const reply=replies[step++]||{text:"Done",calls:[]};args[8](reply.text||"");return reply;};
 const a=new RiverfieldAgent(dir,process.cwd(),new InferenceQueue().run,connection,completion);
 const p=a.providers.save({name:"Fixture",location:"local",baseURL:"http://127.0.0.1:8080/v1",model:"fixture"});
 const c=a.store.create(p.id,"fixture");
 return {a,c,calls,catalogs,cleanup:async()=>{await a.close();rmSync(dir,{recursive:true,force:true});}};
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
test("the model receives no legacy production schema to repeatedly rewrite",async()=>{
 const x=setup([]);
 try{
  x.a.message(x.c.id,{text:"Prepare a concise proposal"});assert.equal((await settled(x.a,x.c.id)).status,"idle");assert.equal(x.calls.length,0);
  assert.ok(!x.catalogs[0].some(t=>t.name==="production_plan"));assert.ok(x.catalogs[0].some(t=>t.name==="ask_user"));
 }finally{await x.cleanup();}
});
test("a display-name run reuses the inspected canonical manifest before approval and dispatch",async()=>{
 const x=setup([call("run_app",{app:"Pika Studio Director",values:{seed:42}})]);
 try{
  const saved=x.a.store.get(x.c.id);saved.tools.push({id:"known-pika",name:"get_app",arguments:{app:"pika-studio-director"},status:"done",result:text({id:"pika-studio-director",name:"Pika Studio Director",section:"video",inputs:[]})});x.a.store.save(saved);
  x.a.message(saved.id,{text:"Propose one pilot"});let c=await settled(x.a,saved.id);
  assert.equal(c.status,"approval");assert.equal(c.tools.at(-1)!.arguments.app,"pika-studio-director");assert.equal(x.calls.length,0);
  x.a.approve(c.id,c.tools.at(-1)!.id,true);c=await settled(x.a,c.id);
  assert.equal(c.status,"idle");assert.equal(x.calls[0].args.app,"pika-studio-director");
 }finally{await x.cleanup();}
});
const rejected=(code:string,message="Bad prompt")=>({isError:true,structuredContent:{status:400,code:"INPUT_VALIDATION",error:message,issues:[{code,field:"segment_windows.windows.0.prompt.retention_analysis",message}],retryable:false},content:[]});
test("46 speculative Pika corrections stop after one unchanged correction, preserving accepted assets and no fake GPU jobs",async()=>{
 const x=setup([call("get_app",{app:"pika-studio-director"}),...Array.from({length:46},(_,i)=>call("run_app",{app:"pika-studio-director",values:{prompt:`Cosmetic wording ${i}`,seed:i}}))],(_,i)=>rejected("PIKA_RETENTION",`Different prose, same invalid retention ${i}`));
 try{
  const saved=x.a.store.get(x.c.id);saved.artifacts.push({id:"accepted-moss",name:"alex.png",type:"image",mime:"image/png",path:"/known/alex.png",url:"/known/alex.png",job:"moss-ok"});x.a.store.save(saved);
  x.a.edit(saved.id,{mode:"auto",maxSteps:100});x.a.message(saved.id,{text:"Use the accepted references for one pilot"});const c=await settled(x.a,saved.id);
  assert.equal(x.calls.filter(t=>t.name==="run_app").length,2);assert.equal(c.status,"failed");assert.match(c.error||"",/unchanged error signature/);assert.equal(c.artifacts[0].id,"accepted-moss");assert.deepEqual(c.jobs,[]);
  assert.ok(c.messages.some(m=>m.role==="assistant"&&/Existing successful images\/assets are preserved/.test(m.content)));
 }finally{await x.cleanup();}
});
test("at most two corrections across changing validation issues; queued tools cannot replay on Continue",async()=>{
 const batch={text:"",calls:[0,1,2,3].map(i=>({id:`run-${i}`,name:"run_app",arguments:{app:"pika-studio-director",values:{prompt:`Attempt ${i}`}}}))};
 const x=setup([call("get_app",{app:"pika-studio-director"}),batch],(_,i)=>rejected(`ISSUE_${i}`));
 try{x.a.edit(x.c.id,{mode:"auto"});x.a.message(x.c.id,{text:"One pilot"});const c=await settled(x.a,x.c.id);assert.equal(x.calls.filter(t=>t.name==="run_app").length,3);assert.equal(c.status,"failed");assert.ok(c.messages.some(m=>m.role==="tool"&&/Not executed/.test(m.content)));assert.throws(()=>x.a.resume(c.id),/Continue cannot repair or replay/);assert.equal(x.calls.filter(t=>t.name==="run_app").length,3);assert.deepEqual(c.jobs,[]);}finally{await x.cleanup();}
});
test("identical rejected payload is not dispatched twice; legacy HTTP400 failures are also bounded",async()=>{
 for(const cosmetic of [false,true]){
  const x=setup([call("get_app",{app:"pika-studio-director"}),...[0,1,2,3].map(i=>call("run_app",{app:"pika-studio-director",values:{prompt:cosmetic?`Wording ${i}`:"Identical"}}))],()=>({...text("Error: 400 Pika segment 1: retention_analysis requires an explicit retention relationship"),isError:true}));
  try{x.a.edit(x.c.id,{mode:"auto"});x.a.message(x.c.id,{text:"Pilot"});await settled(x.a,x.c.id);assert.equal(x.calls.filter(t=>t.name==="run_app").length,cosmetic?2:1);}finally{await x.cleanup();}
 }
});
test("transient HTTP500 is not counted as a deterministic validation failure",async()=>{
 const x=setup([call("get_app",{app:"pika-studio-director"}),...[0,1,2].map(i=>call("run_app",{app:"pika-studio-director",values:{seed:i}}))],(_,i)=>i<3?{isError:true,structuredContent:{status:500,code:"HTTP_ERROR",error:"Backend starting",retryable:true},content:[]}:text({id:"job-1",app:"pika-studio-director",status:"succeeded",outputs:[]}));
 try{x.a.edit(x.c.id,{mode:"auto"});x.a.message(x.c.id,{text:"Pilot"});const c=await settled(x.a,x.c.id);assert.equal(c.status,"idle");assert.equal(x.calls.filter(t=>t.name==="run_app").length,3);assert.deepEqual(c.jobs,["job-1"]);}finally{await x.cleanup();}
});
test("Pika validation recovery cannot automatically regenerate accepted MOSS references",async()=>{
 const x=setup([call("get_app",{app:"pika-studio-director"}),call("run_app",{app:"pika-studio-director"}),call("get_app",{app:"moss-turbo"}),call("run_app",{app:"moss-turbo",values:{prompt:"Regenerate Alex"}})],()=>rejected("PIKA_RETENTION"));
 try{
  const saved=x.a.store.get(x.c.id);saved.artifacts.push({id:"accepted-moss",name:"alex.png",type:"image",mime:"image/png",path:"/known/alex.png",url:"/known/alex.png",app:"moss-turbo"});x.a.store.save(saved);
  x.a.edit(saved.id,{mode:"auto"});x.a.message(saved.id,{text:"Use the accepted references"});const c=await settled(x.a,saved.id);
  assert.equal(c.status,"failed");assert.match(c.error||"",/not the successful MOSS images/);assert.equal(x.calls.filter(t=>t.name==="run_app").length,1);assert.equal(c.artifacts[0].id,"accepted-moss");assert.deepEqual(c.jobs,[]);
 }finally{await x.cleanup();}
});
test("a standalone corrected request requires approval, dispatches once, and makes zero model calls",async()=>{
 const x=setup([]);
 try{
  const c=x.a.store.get(x.c.id),request={id:"corrected-request",name:"run_app",arguments:{app:"pika-studio-director",values:{seed:42}}};
  c.tools.push({id:"known-app",name:"get_app",arguments:{app:"pika-studio-director"},status:"done",result:text({id:"pika-studio-director",section:"video",inputs:[]})},{...request,turn:"reviewed-correction",status:"proposed",standalone:true});
  c.messages.push({id:"reviewed-correction",role:"assistant",content:"Corrected request awaiting explicit approval.",calls:[request],created:new Date().toISOString()});c.status="approval";x.a.store.save(c);
  assert.equal(x.calls.length,0);assert.equal(x.catalogs.length,0);
  x.a.approve(c.id,request.id,true);const completed=await settled(x.a,c.id);
  assert.equal(completed.status,"idle");assert.equal(x.calls.length,1);assert.equal(x.calls[0].name,"run_app");assert.equal(x.catalogs.length,0);assert.deepEqual(completed.jobs,["job-1"]);
 }finally{await x.cleanup();}
});
test("Pika duration and interleaving are native in the exact arguments shown BEFORE approval",async()=>{
 const x=setup([call("get_app",{app:"pika-studio-director"}),call("run_app",{app:"pika-studio-director",values:{duration:10.5,start_seconds:42,segment_windows:JSON.stringify({windows:[{start:0,end:260,prompt:"First",images:[],audios:[]},{start:221,end:481,prompt:"Second",images:[],audios:[]}]})}})]);
 try{
  x.a.message(x.c.id,{text:"Use Director defaults"});const c=await settled(x.a,x.c.id),request=c.tools.at(-1)!;
  assert.equal(c.status,"approval");assert.equal(x.calls.filter(t=>t.name==="run_app").length,0);assert.equal((request.arguments.values as any).duration,7.3);assert.equal((request.arguments.values as any).start_seconds,0);
  const shown=c.messages.flatMap(m=>m.calls||[]).find(t=>t.id===request.id)!;assert.deepEqual(shown.arguments,request.arguments);assert.deepEqual(JSON.parse((shown.arguments.values as any).segment_windows).windows.map((w:any)=>[w.start,w.end]),[[0,175],[136,311]]);
 }finally{await x.cleanup();}
});
test("reading an existing pending approval updates only the proposed geometry, not creative content or previous jobs",async()=>{
 const x=setup([]);try{
  const c=x.a.store.get(x.c.id),call={id:"pending-native",name:"run_app",arguments:{app:"pika-studio-director",values:{duration:11,segment_windows:JSON.stringify({windows:[{start:0,end:260,prompt:"Keep the user's scenario",images:[0,1],audios:[]}]})}}};
  c.status="approval";c.messages.push({id:"proposal",role:"assistant",content:"Review",created:new Date().toISOString(),calls:[call]});c.tools.push({...call,status:"proposed",turn:"proposal"},{id:"previous-job",name:"run_app",arguments:{app:"pika-studio-director",values:{duration:11}},status:"done",job:"existing-job"});c.jobs.push("existing-job");c.jobStates["existing-job"]={id:"existing-job",status:"succeeded"};x.a.store.save(c);
  const viewed=x.a.get(c.id),pending=viewed.tools[0].arguments.values as any;assert.equal(pending.duration,7.3);assert.equal(JSON.parse(pending.segment_windows).windows[0].prompt,"Keep the user's scenario");assert.equal((viewed.tools[1].arguments.values as any).duration,11);assert.deepEqual(viewed.jobs,["existing-job"]);assert.equal(x.calls.length,0);assert.equal(x.catalogs.length,0);
 }finally{await x.cleanup();}
});
test("Pika's initial runtime interview cannot offer hallucinated duration/segment pairs",async()=>{
 const x=setup([call("ask_user",{questions:[{id:"runtime",header:"Runtime",question:"How long?",options:[{label:"~15s (1 segment)"},{label:"~22s (3 segments)"},{label:"~29s (4 segments)"}]},{id:"genre",header:"Genre",question:"What genre?",options:[{label:"Comedy"},{label:"Drama"}]}]})]);
 try{
  x.a.message(x.c.id,{text:"Use pika-studio-director; ask me the runtime first."});let c=await settled(x.a,x.c.id);assert.equal(c.status,"question");
  const options=c.questions!.questions[0].options;assert.deepEqual(options.map(o=>o.label),["7.29 s (1 segment)","12.96 s (2 segments)","18.63 s (3 segments)","29.96 s (5 segments)"]);assert.equal(c.questions!.questions[1].options[0].label,"Comedy");
  assert.deepEqual((c.tools.at(-1)!.arguments.questions as any[])[0].options,options);assert.deepEqual((c.messages.find(m=>m.calls?.some(t=>t.name==="ask_user"))!.calls![0].arguments.questions as any[])[0].options,options);
  await x.a.answer(c.id,{answers:{runtime:["12.96 s (2 segments)"],genre:["Comedy"]}});c=await settled(x.a,c.id);assert.equal(c.interview!.answers[0].selected[0],"12.96 s (2 segments)");assert.equal(x.calls.length,0);
 }finally{await x.cleanup();}
});
test("unrelated audio runtime questions are not rewritten to Pika timing",async()=>{
 const x=setup([call("ask_user",{questions:[{id:"runtime",header:"Runtime",question:"Music duration?",options:[{label:"15 seconds"},{label:"60 seconds"}]}]})]);
 try{const saved=x.a.store.get(x.c.id);saved.tools.push({id:"existing-pika",name:"get_app",arguments:{app:"pika-studio-director"},status:"done",result:text({id:"pika-studio-director"})});x.a.store.save(saved);x.a.message(x.c.id,{text:"Compose a music track for this Pika project."});const c=await settled(x.a,x.c.id);assert.deepEqual(c.questions!.questions[0].options.map(o=>o.label),["15 seconds","60 seconds"]);}finally{await x.cleanup();}
});

const inspectedPika=()=>{const a=loadRegistry(process.cwd()).apps.find(a=>a.id==="pika-studio-director")!;return {id:a.id,name:a.name,section:a.section,inputs:a.inputs.map(i=>({id:i.id,type:i.type,options:i.options?.map(o=>o.value),multiple:i.multiple,help:i.help}))};};
test("the actual Maya transport mistakes are corrected before approval using inspected file slots",async()=>{
 const replies:any[]=[],x=setup(replies);
 try{
  const c=x.a.store.get(x.c.id),first=join(x.a.out,"maya.png"),second=join(x.a.out,"corridor.png");writeFileSync(first,"mock");writeFileSync(second,"mock");
  c.artifacts.push(...[first,second].map((path,i)=>({id:`known-${i}`,name:`image-${i}.png`,path,url:`/image-${i}`,type:"image",mime:"image/png"})));
  c.tools.push({id:"known-pika",name:"get_app",arguments:{app:"pika-studio-director"},status:"done",result:text(inspectedPika())});x.a.store.save(c);
  const prompt=readFileSync("test/fixtures/pika-maya-dialogue.txt","utf8"),windows=JSON.stringify({windows:[{start:0,end:175,prompt,images:[0,1],audios:[]}]});
  replies.push(call("run_app",{app:"pika-studio-director",values:{segment_windows:windows,aspect:"9:16",megapixels:.4,image1:first,image2:second,image:[0,1]}}));
  x.a.message(c.id,{text:"Prepare the existing Maya references"});let current=await settled(x.a,c.id);assert.equal(current.status,"approval");assert.equal(x.calls.length,0);
  const request=current.tools.at(-1)!.arguments;assert.deepEqual(request.files,{image1:first,image2:second});assert.equal((request.values as any).image,undefined);assert.equal((request.values as any).image1,undefined);assert.equal((request.values as any).aspect,"9:16 (Portrait Widescreen)");assert.ok(!x.catalogs[0].find(t=>t.name==="run_app")!.inputSchema.oneOf);
  x.a.approve(c.id,current.tools.at(-1)!.id,true);current=await settled(x.a,c.id);assert.equal(x.calls.length,1);assert.equal(current.status,"idle");assert.equal(current.artifacts.length,2);
 }finally{await x.cleanup();}
});
test("moving known file keys out of values never bypasses conversation file permissions",async()=>{
 const x=setup([call("run_app",{app:"pika-studio-director",values:{image1:"/etc/passwd"}})]);
 try{const c=x.a.store.get(x.c.id);c.tools.push({id:"known-pika",name:"get_app",arguments:{app:"pika-studio-director"},status:"done",result:text(inspectedPika())});x.a.store.save(c);x.a.edit(c.id,{mode:"auto"});x.a.message(c.id,{text:"Do not upload arbitrary files"});const done=await settled(x.a,c.id);assert.equal(x.calls.length,0);assert.match(done.tools.at(-1)!.error||"",/permission denied/);}finally{await x.cleanup();}
});
test("local deterministic argument errors are bounded too, without an HTTP request or a fake job",async()=>{
 const x=setup(Array.from({length:46},(_,i)=>call("run_app",{app:"pika-studio-director",values:{image1:[0,i]}})));
 try{const c=x.a.store.get(x.c.id);c.tools.push({id:"known-pika",name:"get_app",arguments:{app:"pika-studio-director"},status:"done",result:text(inspectedPika())});x.a.store.save(c);x.a.edit(c.id,{mode:"auto",maxSteps:100});x.a.message(c.id,{text:"Use known references"});const done=await settled(x.a,c.id);assert.equal(x.calls.length,0);assert.equal(x.catalogs.length,2);assert.equal(done.status,"failed");assert.deepEqual(done.jobs,[]);assert.match(done.error||"",/unchanged error signature/);}finally{await x.cleanup();}
});
