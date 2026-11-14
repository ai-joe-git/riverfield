import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {defaultDirectorForm,compileDirectorRun,creativeField,duplicateDirectorActors,formAsset,normalizeDirectorDialogue,assignStoryCastNames} from "../server/director-form.ts";
import {AgentStore,type Conversation} from "../server/agent-store.ts";
import {RiverfieldAgent} from "../server/agent.ts";
import {InferenceQueue} from "../server/inference-queue.ts";
import {complete} from "../server/agent-providers.ts";
import {loadRegistry} from "../server/registry.ts";
import {resolveValues} from "../server/runner.ts";

const apps=loadRegistry(process.cwd()).apps,text=(data:any)=>({content:[{type:"text",text:JSON.stringify(data)}]});
function ready(c:Conversation,dir:string){
 c.director=defaultDirectorForm();const f=c.director;f.brief="Maya answers a call in a hospital corridor.";f.scenario="Maya waits, then gets news.";f.actors[0]={name:"Maya",description:"An adult woman in a navy coat",asset:"actor"};f.environment="An empty hospital corridor";f.environmentAsset="room";f.reviewed=true;f.segments[0].action="Maya sits on a chair and answers her phone.";f.segments[0].dialogue[0]="Vous êtes sûr ?";
 for(const id of ["actor","room"]){const path=join(dir,id+".png");writeFileSync(path,"mock image");c.artifacts.push({id,path,name:id+".png",url:`/files/${id}`,mime:"image/png",type:"image"});}
  f.language="French";return f;
}
function fixture(failFirstWrite=false,reply?:(prompt:string)=>string){
 const dir=mkdtempSync("/tmp/opencode/riverfield-guided-"),calls:any[]=[],requests:Parameters<typeof complete>[]=[];
 const connection=()=>({tools:async()=>["get_app","run_app","job","cancel_job"].map(name=>({name,inputSchema:{type:"object"}})),call:async(name:string,args:any)=>{calls.push({name,args});if(name==="get_app"){const a=apps.find(a=>a.id===args.app)!;return text({id:a.id,name:a.name,section:a.section,inputs:a.inputs});}return text({id:"job-guided",app:args.app,status:"succeeded",outputs:[]});},close:async()=>{}});
 const completion=async(...args:Parameters<typeof complete>)=>{requests.push(args);if(failFirstWrite&&requests.length===1)throw new Error("Writer connection unavailable");return {text:reply?reply(args[4][0].content):"Maya waits quietly by the window.",calls:[]};};
 const a=new RiverfieldAgent(dir,process.cwd(),new InferenceQueue().run,connection,completion),p=a.providers.save({name:"Fixture",location:"local",baseURL:"http://127.0.0.1:1/v1",model:"fixture"}),c=a.store.create(p.id,"fixture");
 return {a,c,dir,calls,requests,cleanup:async()=>{await a.close();rmSync(dir,{recursive:true,force:true});}};
}
test("misrouted dialogue is moved out of the visual action without inventing text",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-normalize-");try{const c=new AgentStore(join(dir,"agent")).create(),f=ready(c,dir);f.actors[0].name="Clara";f.segments[0].dialogue[0]="";f.scenario="[Visual Directions]\nClara waits in the corridor.\n[Dialogue]\nClara: That was my favorite mug.";f.segments[0].action="[Visual Directions] Static medium shot.\nClara: That was my favorite mug.";const changes=normalizeDirectorDialogue(f);assert.equal(f.segments[0].dialogue[0],"That was my favorite mug.");assert.doesNotMatch(f.segments[0].action,/Clara:|\[Dialogue\]/);assert.match(f.scenario,/Clara waits in the corridor/);assert.doesNotMatch(f.scenario,/\[Visual Directions\]|\[Dialogue\]/);assert.ok(changes.some(c=>/Moved Clara/.test(c)));}finally{rmSync(dir,{recursive:true,force:true});}
});
test("placeholder cast slots take their names from the approved story",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-cast-");try{
  const c=new AgentStore(join(dir,"agent")).create(),f=ready(c,dir);
  f.actors=Array.from({length:3},()=>({name:"",description:"",asset:""}));f.actors.forEach((a,i)=>a.name=`Character ${i+1}`);
  f.scenario="In a neon-lit arcade, Kevin, wearing a backwards cap, stares at a broken claw machine. Sarah, sporting oversized flannel, watches him. Barry, an elderly janitor, approaches.\n\n\"Is that the third quarter?\" Sarah asks.\n\n\"It's a skill,\" Kevin says.\n\nBarry pauses.";
  assert.deepEqual(assignStoryCastNames(f),["Kevin","Sarah","Barry"]);assert.deepEqual(f.actors.map(a=>a.name),["Kevin","Sarah","Barry"]);assert.deepEqual(assignStoryCastNames(f),[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("cast extraction ignores sentence-start words and leaves existing names alone",()=>{
 const f=defaultDirectorForm();f.actors=Array.from({length:3},()=>({name:"",description:"",asset:""}));f.actors.forEach((a,i)=>a.name=`Character ${i+1}`);f.actors[1].name="Maya";
 f.scenario='"Final question," Beatrice says. "What is the weight?" Arthur asks. Silas whispers to Maya.';
 assert.deepEqual(assignStoryCastNames(f),["Beatrice","Arthur"]);assert.deepEqual(f.actors.map(a=>a.name),["Beatrice","Maya","Arthur"]);
});
test("a saved name-colon line is repaired before rendering and blocks the old prompt",async()=>{
 const x=fixture();try{const f=ready(x.c,x.dir);f.actors[0].name="Clara";f.segments[0].dialogue[0]="";f.segments[0].action="[Visual Directions] Static medium shot.\nClara: That was my favorite mug.";x.a.store.save(x.c);await assert.rejects(()=>x.a.runDirector(x.c.id,"video"),/repaired.*prepare/i);const c=x.a.store.get(x.c.id);assert.equal(c.director!.segments[0].dialogue[0],"That was my favorite mug.");assert.doesNotMatch(c.director!.segments[0].action,/Clara:|\[Dialogue\]/);assert.equal(c.director!.promptsStale,true);assert.equal(x.requests.length,0);assert.equal(x.calls.length,0);}finally{await x.cleanup();}
});
test("guided compiler owns models, file slots, geometry, native prompt sections and dialogue tags",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-form-");try{const c=new AgentStore(join(dir,"agent")).create(),f=ready(c,dir),moss=compileDirectorRun(c,"actor");assert.equal(moss.app,"moss-turbo");assert.equal(moss.values.steps,8);assert.equal(moss.values.rewrite,false);assert.match(String(moss.values.prompt),/LEFT THIRD.*RIGHT TWO THIRDS/);
  const qwen=compileDirectorRun(c,"edit",0,"Remove the ring");assert.equal(qwen.app,"qwen-image-edit-turbo");assert.equal(qwen.files.image,c.artifacts[0].path);
  f.count=2;f.segments.push(structuredClone(f.segments[0]));const pika=compileDirectorRun(c,"video"),windows=JSON.parse(String(pika.values.segment_windows)).windows;assert.equal(pika.app,"pika-studio-director");assert.deepEqual(Object.keys(pika.files),["image1","image2"]);assert.deepEqual(windows.map((w:any)=>[w.start,w.end,w.images]),[[0,175,[0,1]],[136,311,[0,1]]]);assert.match(windows[0].prompt,/<d>\[French\] Vous êtes sûr \?<\/d>/);assert.match(windows[0].prompt,/<Subject 1> \(S1\) says/);
  const values:any={...pika.values};for(const key of Object.keys(pika.files))values[key]={bytes:new Uint8Array([1]),name:"ref.png"};assert.doesNotThrow(()=>resolveValues(apps.find(a=>a.id===pika.app)!,values));
  assert.throws(()=>creativeField(f,"relay"),/creative fields/);assert.throws(()=>creativeField(f,"actors.0.asset"),/creative fields/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("each speaker gets its own subject line and the action stays before the constraints",async()=>{
 const x=fixture();try{
  const f=ready(x.c,x.dir);f.language="English";f.actors.push({name:"Brenda",description:"An adult woman in a yellow sweater",asset:"actor2"},{name:"Chad",description:"An adult man in a denim vest",asset:"actor3"});
  for(const id of ["actor2","actor3"]){const path=join(x.dir,id+".png");writeFileSync(path,"mock image");x.c.artifacts.push({id,path,name:id+".png",url:`/files/${id}`,mime:"image/png",type:"image"});}
  f.segments[0].action="Maya leans toward Brenda and holds up a clipboard.";f.segments[0].dialogue=["What is the color?","Bright blue.",""];f.segments[0].sound="Quiet studio room tone.";f.reviewed=true;x.a.store.save(x.c);x.a.saveDirector(x.c.id,f);
  const run=compileDirectorRun(x.a.store.get(x.c.id),"video"),prompt=JSON.parse(String(run.values.segment_windows)).windows[0].prompt;
  assert.match(prompt,/<Subject 1> \(S1\) says, <d>\[English\] What is the color\?<\/d>/);assert.match(prompt,/<Subject 2> \(S2\) says, <d>\[English\] Bright blue\.<\/d>/);
  assert.ok(prompt.indexOf("<Subject 1> (S1)")<prompt.indexOf("<Subject 2> (S2)"));
  assert.match(prompt,/Maya and Brenda are on camera with face and mouth clearly visible/);assert.match(prompt,/Every other character stays silent/);
  assert.ok(prompt.indexOf("Maya leans toward Brenda")<prompt.indexOf("Exactly 3 distinct people"));assert.doesNotMatch(prompt,/The spoken line is live on-camera speech/);
 }finally{await x.cleanup();}
});
test("guided FL2VA has no files or source labels; reference approval is required only in Ref2VA",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-form-");try{const c=new AgentStore(join(dir,"agent")).create(),f=ready(c,dir);f.reviewed=false;assert.throws(()=>compileDirectorRun(c,"video"),/approve the references/);f.mode="fl2va";const run=compileDirectorRun(c,"video");assert.deepEqual(run.files,{});assert.doesNotThrow(()=>resolveValues(apps.find(a=>a.id===run.app)!,run.values));f.audioAsset="actor";assert.throws(()=>compileDirectorRun(c,"video"),/Audio references require/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test("guided writer gets one text task, zero tools, bounded output and cannot change settings or launch apps",async()=>{
 const x=fixture();try{const f=ready(x.c,x.dir);x.a.store.save(x.c);x.a.saveDirector(x.c.id,f);const c=await x.a.writeDirector(x.c.id,"segments.0.action");assert.equal(c.director!.segments[0].action,"Maya waits quietly by the window.");assert.equal(c.director!.megapixels,.4);assert.equal(c.director!.relay,"x2");assert.equal(x.requests.length,1);assert.deepEqual(x.requests[0][5],[]);assert.deepEqual(x.requests[0][6],[]);assert.equal(x.requests[0][0].tokenMode,"native");assert.ok(x.requests[0][0].maxTokens>=8192);assert.match(x.requests[0][3],/Pika\/H3 prompt contract/);assert.equal(x.calls.length,0);
  await assert.rejects(()=>x.a.writeDirector(c.id,"megapixels"),/creative fields/);assert.equal(x.requests.length,1);assert.throws(()=>x.a.message(c.id,{text:"go"}),/Pika chat/);assert.throws(()=>x.a.resume(c.id),/Pika chat/);
 }finally{await x.cleanup();}
});
test("a sound field that contradicts a spoken line is repaired before saving",async()=>{
 const x=fixture(false,p=>p.includes("room tone")?"A heavy silence fills the room.":"Maya waits quietly by the window.");
 try{
  const f=ready(x.c,x.dir);x.a.store.save(x.c);x.a.saveDirector(x.c.id,f);
  const c=await x.a.writeDirector(x.c.id,"segments.0.sound");
  assert.match(c.director!.segments[0].sound,/Live on-camera speech/);assert.doesNotMatch(c.director!.segments[0].sound,/silence/i);
  assert.equal(x.requests.length,1);assert.equal(x.calls.length,0);
  assert.ok(c.messages.some(m=>m.role==="assistant"&&/Repaired segments\.0\.sound/.test(m.content)));
 }finally{await x.cleanup();}
});
test("guided run builds actual app arguments in code with no model completion",async()=>{
 const x=fixture();try{const f=ready(x.c,x.dir);x.a.store.save(x.c);x.a.saveDirector(x.c.id,f);const c=await x.a.runDirector(x.c.id,"video");assert.equal(c.status,"idle");assert.equal(x.requests.length,0);assert.deepEqual(x.calls.map(c=>c.name),["get_app","run_app"]);assert.equal(x.calls[1].args.app,"pika-studio-director");assert.deepEqual(Object.keys(x.calls[1].args.files),["image1","image2"]);assert.equal(c.tools.at(-1)!.guidedTarget,"video");assert.equal(c.tools.at(-1)!.standalone,true);
 }finally{await x.cleanup();}
});
test("role binding follows the current successful app output, without asking the model for asset IDs",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-form-");try{const c=new AgentStore(join(dir,"agent")).create(),f=ready(c,dir);f.actors[0].asset="";c.tools.push({id:"actor-job",name:"run_app",arguments:{app:"moss-turbo"},status:"done",guidedTarget:"actor:0",job:"actor-done"});c.artifacts[0].job="actor-done";assert.equal(compileDirectorRun(c,"video").files.image1,c.artifacts[0].path);
  c.tools.push({id:"pending-edit",name:"run_app",arguments:{app:"qwen-image-edit-turbo"},status:"done",guidedTarget:"actor:0",job:"new-edit"});assert.throws(()=>compileDirectorRun(c,"video"),/Missing reference/);
  const video=join(dir,"result.mp4");writeFileSync(video,"mock video");c.tools.push({id:"video-run",name:"run_app",arguments:{app:"pika-studio-director"},status:"done",guidedTarget:"video",job:"video-done"});c.artifacts.push({id:"rendered",name:"result.mp4",path:video,url:"/video",type:"video",mime:"video/mp4",job:"video-done"});
  assert.equal(compileDirectorRun(c,"relay").files.video,video);assert.match(String(compileDirectorRun(c,"relay").values.unet_name),/_x2_/);f.relay="x4";assert.match(String(compileDirectorRun(c,"relay").values.unet_name),/_x4_/);f.relay="off";assert.throws(()=>compileDirectorRun(c,"relay"),/disabled/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("guided buttons do not duplicate an in-flight job or bypass read-only mode",async()=>{
 const x=fixture();try{const f=ready(x.c,x.dir);x.c.tools.push({id:"pending",name:"run_app",arguments:{app:"pika-studio-director"},guidedTarget:"video",job:"still-running",status:"done"});x.c.jobs.push("still-running");x.c.jobStates["still-running"]={status:"running"};x.a.store.save(x.c);x.a.saveDirector(x.c.id,f);await assert.rejects(()=>x.a.runDirector(x.c.id,"video"),/job already exists/);assert.equal(x.calls.length,0);assert.equal(x.requests.length,0);x.a.edit(x.c.id,{mode:"read-only"});await assert.rejects(()=>x.a.runDirector(x.c.id,"actor"),/read-only/);assert.equal(x.calls.length,0);}finally{const c=x.a.store.get(x.c.id);c.jobStates["still-running"]={status:"canceled"};x.a.store.save(c);await x.cleanup();}
});
test("chat questions are deterministic; story revisions and preparation use only text completions",async()=>{
 const x=fixture();try{
  let c=x.a.startDirector(x.c.id);assert.equal(c.director!.chatStep,"duration");assert.equal(c.director!.language,"English");assert.equal(x.requests.length,0);
  c=x.a.chooseDirector(c.id,"duration","2");assert.equal(c.director!.chatStep,"resolution");
  c=x.a.chooseDirector(c.id,"resolution","0.4");c=x.a.chooseDirector(c.id,"relay","x4");c=x.a.chooseDirector(c.id,"cast","1");assert.equal(c.director!.chatStep,"brief");assert.equal(x.requests.length,0);
  c=await x.a.sayDirector(c.id,"A woman receives a surprising call.");assert.equal(c.director!.chatStep,"story");assert.equal(x.requests.length,1);assert.equal(c.messages.at(-1)!.content,c.director!.scenario);
  c=x.a.chooseDirector(c.id,"edit","scenario");c=await x.a.sayDirector(c.id,"Make the ending hopeful.");assert.match(x.requests.at(-1)![4][0].content,/Requested revision: Make the ending hopeful/);
  c=await x.a.prepareDirector(c.id);assert.equal(c.director!.chatStep,"draft");assert.ok(c.director!.segments.every(s=>s.action));assert.equal(x.calls.length,0);assert.ok(x.requests.every(r=>r[5].length===0&&r[6].length===0));
  c=x.a.chooseDirector(c.id,"settings","");c=x.a.chooseDirector(c.id,"setting","language");c=x.a.chooseDirector(c.id,"language","French");assert.equal(c.director!.chatStep,"story");assert.equal(c.director!.language,"French");
 }finally{await x.cleanup();}
});
test("chat reference reuse and correction return to review; prompt review has an explicit destination",async()=>{
 const x=fixture();try{
  const f=ready(x.c,x.dir);f.chatStep="draft";x.a.store.save(x.c);let c=await x.a.referenceDirector(x.c.id);assert.equal(c.director!.chatStep,"references");assert.equal(x.calls.length,0);
  c=x.a.chooseDirector(c.id,"referenceEdit","actor:0");c=await x.a.sayDirector(c.id,"Remove the ring");assert.equal(c.director!.chatStep,"confirmEdit");assert.equal(x.requests.length,0);assert.equal(x.calls.length,0);
  c=x.a.chooseDirector(c.id,"back","");assert.equal(c.director!.chatStep,"references");
  c=x.a.chooseDirector(c.id,"pickReference","","actor:0");c=x.a.chooseDirector(c.id,"bind","actor","actor:0");assert.equal(c.director!.chatStep,"references");
  c=x.a.chooseDirector(c.id,"approveReferences","");assert.equal(c.director!.chatStep,"render");c=x.a.chooseDirector(c.id,"reviewDraft","");assert.equal(c.director!.chatStep,"draft");
  c=await x.a.runDirector(c.id,"edit",0,"Remove the ring");assert.equal(c.director!.chatStep,"references");assert.equal(c.director!.reviewed,false);assert.equal(x.requests.length,0);
 }finally{await x.cleanup();}
});
test("failed story writing preserves the idea without advancing to story approval, and can be retried",async()=>{
 const x=fixture(true);try{
  x.a.startDirector(x.c.id);x.a.chooseDirector(x.c.id,"defaults","");
  await assert.rejects(()=>x.a.sayDirector(x.c.id,"A mockumentary about three coworkers."),/connection unavailable/);
  let c=x.a.get(x.c.id);assert.equal(c.status,"failed");assert.equal(c.director!.chatStep,"brief");assert.equal(c.director!.scenario,"");assert.equal(c.director!.brief,"A mockumentary about three coworkers.");
  await assert.rejects(()=>x.a.prepareDirector(c.id),/review a story first/);assert.equal(x.requests.length,1);
  c=await x.a.sayDirector(c.id,c.director!.brief);assert.equal(c.status,"idle");assert.equal(c.director!.chatStep,"story");assert.ok(c.director!.scenario);assert.equal(x.requests.length,2);assert.equal(x.calls.length,0);
 }finally{await x.cleanup();}
});
test("ordinary questions never rewrite any saved project field or launch tools",async()=>{
 const x=fixture();try{
  const f=ready(x.c,x.dir);f.chatStep="references";x.a.store.save(x.c);const before=JSON.stringify(f);
  let c=await x.a.sayDirector(x.c.id,"Why did you choose this character?");assert.equal(JSON.stringify(c.director),before);assert.match(x.requests[0][3],/read-only conversation, NOT a screenplay/);assert.equal(x.requests[0][5].length,0);assert.equal(x.calls.length,0);
  c=await x.a.sayDirector(c.id,"I asked a question, why?");assert.equal(JSON.stringify(c.director),before);assert.equal(x.calls.length,0);
 }finally{await x.cleanup();}
});
test("three Host regression: answer questions without rewriting and block duplicate images before any GPU dispatch",async()=>{
 const x=fixture();try{
  const f=ready(x.c,x.dir);f.actors=Array.from({length:3},()=>({name:"The Host",description:"A gaunt man in a tight black tuxedo, white dress shirt and black shoes.",asset:""}));f.chatStep="references";x.a.store.save(x.c);const before=JSON.stringify(f);
  const c=await x.a.sayDirector(x.c.id,"why you made three characters named the host and they very look alike");assert.equal(JSON.stringify(c.director),before);assert.match(c.messages.at(-1)!.content,/slot 1 is “The Host”.*slot 2 is “The Host”.*slot 3 is “The Host”/);assert.equal(x.requests.length,0);
  await assert.rejects(()=>x.a.referenceDirector(c.id),/Duplicate character/);await assert.rejects(()=>x.a.runDirector(c.id,"actor",0),/Duplicate character/);await assert.rejects(()=>x.a.runDirector(c.id,"video"),/Duplicate character/);assert.equal(x.calls.length,0);
 }finally{await x.cleanup();}
});
test("cast repair assigns numbered roles before descriptions and invalidates old reference bindings without regenerating them",async()=>{
 const x=fixture(false,p=>p.includes("Give only a short character name")?(p.includes("CHARACTER SLOT 2 OF 3")?"The Contestant":"The Friend"):p.includes("Describe only")?(p.includes("CHARACTER SLOT 2 OF 3")?"A young woman with red curls wearing a green cardigan, blue jeans and white sneakers.":"An elderly stocky man with gray beard wearing an orange sweater, brown trousers and leather boots."):p.includes("Write ONLY the words")?"SILENT":"The contestant waits for the host's question.");try{
  const f=ready(x.c,x.dir);f.actors=Array.from({length:3},()=>({name:"The Host",description:"A gaunt man in a tight black tuxedo, white dress shirt and black shoes.",asset:""}));f.scenario="1. The Host asks a question. 2. The Contestant sits in the chair. 3. The Friend answers a disconnected phone.";f.chatStep="references";x.c.tools.push({id:"old",name:"run_app",arguments:{},status:"done",job:"old",guidedTarget:"actor:1"});x.c.artifacts[0].job="old";x.a.store.save(x.c);
  const c=await x.a.prepareDirector(x.c.id);assert.deepEqual(c.director!.actors.map(a=>a.name),["The Host","The Contestant","The Friend"]);assert.deepEqual(duplicateDirectorActors(c.director!),[]);assert.equal(c.director!.chatStep,"draft");assert.equal(formAsset(c,"actor:1"),undefined);assert.ok(c.artifacts.some(a=>a.job==="old"));assert.equal(x.calls.length,0);
  assert.match(x.requests[0][4][0].content,/CHARACTER SLOT 2 OF 3/);assert.match(x.requests[1][4][0].content,/CHARACTER SLOT 3 OF 3/);assert.ok(x.requests.every(r=>r[5].length===0));
 }finally{await x.cleanup();}
});
test("duplicate writer output is rejected before overwriting the slot",async()=>{
 const x=fixture(false,()=>"The Host");try{const f=ready(x.c,x.dir);f.actors=[{name:"The Host",description:"Tall man wearing a tuxedo",asset:""},{name:"Character 2",description:"",asset:""}];x.a.store.save(x.c);await assert.rejects(()=>x.a.writeDirector(x.c.id,"actors.1.name"),/duplicated character slot 1/);assert.equal(x.a.store.get(x.c.id).director!.actors[1].name,"Character 2");assert.equal(x.calls.length,0);}finally{await x.cleanup();}
});
test("appearance edits cannot silently reuse a previous generated character image",async()=>{
 const x=fixture();try{const f=ready(x.c,x.dir);f.actors[0].asset="";x.c.tools.push({id:"old",name:"run_app",arguments:{},status:"done",job:"old",guidedTarget:"actor:0"});x.c.artifacts[0].job="old";x.a.store.save(x.c);assert.ok(formAsset(x.c,"actor:0"));const c=await x.a.writeDirector(x.c.id,"actors.0.description");assert.equal(formAsset(c,"actor:0"),undefined);assert.equal(c.director!.reviewed,false);assert.ok(c.artifacts.some(a=>a.job==="old"));assert.equal(x.calls.length,0);}finally{await x.cleanup();}
});
test("a changed cast cannot render old shot prompts",async()=>{
 const x=fixture();try{const f=ready(x.c,x.dir);x.a.store.save(x.c);const c=await x.a.writeDirector(x.c.id,"actors.0.description");assert.equal(c.director!.promptsStale,true);await assert.rejects(()=>x.a.runDirector(c.id,"video"),/Prepare and review shot prompts/);assert.equal(x.calls.length,0);}finally{await x.cleanup();}
});
test("contaminated writer text gets one bounded plain-text correction, never a GPU call",async()=>{
 const x=fixture(false,p=>p.includes("Correction required:")?"Maya waits quietly beside the chair. Static medium shot.":"The Host whispers to the camera crew.");try{const f=ready(x.c,x.dir);x.a.store.save(x.c);const c=await x.a.writeDirector(x.c.id,"segments.0.action");assert.match(c.director!.segments[0].action,/Maya waits quietly/);assert.equal(x.requests.length,2);assert.ok(x.requests.every(r=>r[5].length===0));assert.equal(x.calls.length,0);assert.ok(c.director!.staleTargets!.includes("video"));assert.doesNotMatch(x.requests[0][4][0].content,/Existing segment actions:/);}finally{await x.cleanup();}
});
test("persistent unassigned people cannot overwrite a field or reach image generation",async()=>{
 const x=fixture(false,()=>"The Host talks to the camera crew.");try{const f=ready(x.c,x.dir),old=f.segments[0].action;x.a.store.save(x.c);await assert.rejects(()=>x.a.writeDirector(x.c.id,"segments.0.action"),/Writer text rejected/);assert.equal(x.requests.length,2);assert.equal(x.a.store.get(x.c.id).director!.segments[0].action,old);assert.equal(x.calls.length,0);}finally{await x.cleanup();}
});
test("Pika chat media inspection sends selected attachments to a capable responder without changing the draft",async()=>{
 const x=fixture();try{const f=ready(x.c,x.dir);f.chatStep="draft";x.a.store.save(x.c);const audio=x.a.store.upload(x.c,Buffer.from("audio fixture"),"sample.wav","audio/wav");const p=x.a.providers.get(x.c.provider);x.a.providers.save({...p,audio:true});const before=JSON.stringify(x.a.store.get(x.c.id).director);const c=await x.a.sayDirector(x.c.id,"What words are actually spoken?",[audio.id]);assert.equal(JSON.stringify(c.director),before);assert.deepEqual(x.requests[0][4][0].attachments,[audio.id]);assert.equal(x.requests[0][6][0].path,audio.path);assert.equal(x.requests[0][5].length,0);assert.equal(x.calls.length,0);}finally{await x.cleanup();}
});
test("a text-only Pika chat cannot pretend to hear an attached recording",async()=>{
 const x=fixture();try{const f=ready(x.c,x.dir);f.chatStep="draft";x.a.store.save(x.c);const audio=x.a.store.upload(x.c,Buffer.from("audio fixture"),"sample.wav","audio/wav");await assert.rejects(()=>x.a.sayDirector(x.c.id,"Listen to this",[audio.id]),/cannot receive audio/);assert.equal(x.requests.length,0);assert.equal(x.calls.length,0);assert.equal(x.a.store.get(x.c.id).director!.scenario,f.scenario);await assert.rejects(()=>x.a.sayDirector(x.c.id,"Listen",["unknown"]),/Unknown attachments/);}finally{await x.cleanup();}
});
