import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer,type Server} from "node:http";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from "node:fs";
import {join} from "node:path";
import {StudioMcp,resultData} from "../server/agent-mcp.ts";

const listen=async(server:Server)=>{server.listen(0,"127.0.0.1");await once(server,"listening");return (server.address() as {port:number}).port;};
test("real MCP -> real HTTP run route -> multipart -> validator -> SDK dispatch accepts Alex on the first attempt, without GPU",{timeout:30000},async()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-pika-api-"),requests:any[]=[],uploads:any[]=[],writerRequests:any[]=[];let dispatched!:(value:any)=>void;
 const dispatch=new Promise<any>(resolve=>dispatched=resolve);
 const backend=createServer(async(req,res)=>{
  const path=new URL(req.url!,"http://mock").pathname,send=(status:number,body:any)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body));};
  const request=new Request(new URL(req.url!,"http://mock"),{method:req.method,headers:req.headers as any,...(req.method==="POST"?{body:req as any,duplex:"half"}:{} )} as any);
  if(path==="/v1/chat/completions"){const payload=await request.json() as any;writerRequests.push(payload);const content=payload.messages.at(-1).content.includes("Write ONLY the words spoken")?"Are you sure?":"Maya waits in the corridor and receives unexpected news.";res.writeHead(200,{"content-type":"text/event-stream"});res.end(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:"stop"}]})}\n\n`);return;}
  if(path==="/riverfield/prepare")return send(200,{freed:false});
  if(path.startsWith("/object_info/")){const cls=decodeURIComponent(path.split("/").at(-1)!);return send(200,{[cls]:{}});}
  if(path==="/api/v2/assets"&&req.method==="POST"){
   const form=await request.formData();uploads.push(form.get("file_path"));
   return send(201,{id:`mock-image-${uploads.length}`,hash:null,size_bytes:1,content_type:"image/png",file_path:String(form.get("file_path")),created_at:new Date().toISOString(),url:"http://127.0.0.1/unused.png",url_expires_at:"2099-01-01T00:00:00Z"});
  }
  if(path==="/api/v2/jobs"&&req.method==="POST"){
   const body=await request.json();requests.push(body);dispatched(body);
   // The real SDK reached dispatch. Deliberately do not create or execute a backend job.
   return send(400,{error:{code:"MOCK_DISPATCH_ONLY",message:"Captured workflow; no inference is implemented by this mock"}});
  }
  return send(404,{error:"No such mock endpoint"});
 });
 const mockPort=await listen(backend),reservation=createServer(),port=await listen(reservation);await new Promise<void>(r=>reservation.close(()=>r()));
 const child=spawn(process.execPath,["--experimental-strip-types","--disable-warning=ExperimentalWarning","server/server.ts"],{cwd:process.cwd(),env:{...process.env,PORT:String(port),RIVERFIELD_HOST:"127.0.0.1",RIVERFIELD_OUT:dir,COMFY_BASE_URL:`http://127.0.0.1:${mockPort}`,RIVERFIELD_AGENT_MCP_URL:`http://127.0.0.1:${port}/mcp`,RIVERFIELD_PASSCODE:"",RIVERFIELD_MAX_ACTIVE:"0",RIVERFIELD_MAX_RUNS_PER_DAY:"0"},stdio:["ignore","pipe","pipe"]});
 let log="";child.stdout.on("data",b=>log+=b);child.stderr.on("data",b=>log+=b);let client:StudioMcp|undefined;
 const waitDispatch=async(promise:Promise<any>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`No mock SDK dispatch: ${log}`)),10000);})]);}finally{clearTimeout(timer);}};
 try{
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{cleanup();reject(new Error(`Server startup timed out: ${log}`));},15000),onData=()=>{if(log.includes("riverfield on")){cleanup();resolve();}},onExit=()=>{cleanup();reject(new Error(log));},cleanup=()=>{clearTimeout(timeout);child.stdout.off("data",onData);child.off("exit",onExit);};child.stdout.on("data",onData);child.once("exit",onExit);onData();});
  const base=`http://127.0.0.1:${port}`;client=new StudioMcp(base+"/mcp");
  const described=resultData(await client.call("get_app",{app:"pika-studio-director"})),example=resultData(await client.call("examples",{app:"pika-studio-director"}));
  const payload=JSON.parse(readFileSync("apps/pika-studio-director/request-example.json","utf8"));
  assert.deepEqual(described.example.values,payload.values);assert.deepEqual(example.values,payload.values);assert.equal(example.inputs.length,2);
  assert.equal(described.effectiveTechnicalDefaults.detail,.85);assert.equal(described.delivery.defaultScale,"x2");assert.equal(described.delivery.separateRun,true);assert.ok(!described.agentWritableInputs.includes("clip_name"));assert.ok(!described.agentWritableInputs.includes("segment_prompts"));
  // Keep the same test portable; locally these are the two original accepted MOSS outputs.
  for(const [key,path] of Object.entries(payload.files) as [string,string][]){if(!existsSync(path)){const mock=join(dir,`${key}.png`);writeFileSync(mock,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5m0AAAAASUVORK5CYII=","base64"));payload.files[key]=mock;}}
  const originalPrompt=JSON.parse(payload.values.segment_windows).windows[0].prompt;
  const tool=(await client.tools()).find(t=>t.name==="plan_segments")!;assert.ok(!(tool.inputSchema as any).properties.seconds,"the model has no segment-duration control");
  const layout=resultData(await client.call("plan_segments",{total_seconds:30}));assert.equal(layout.ready,false);assert.equal(layout.requiredPrompts,5);assert.equal(layout.frames,719);assert.equal(layout.segment_windows,undefined);
  const planned=resultData(await client.call("plan_segments",{prompts:[originalPrompt],segment_images:[[0,1]]}));
  assert.equal(JSON.parse(planned.segment_windows).windows[0].prompt,originalPrompt);assert.equal(planned.segmentFrames,175);
  const flat=resultData(await client.call("plan_segments",{prompts:["Alex sits at his desk."],segment_images:[[0,1]]}));assert.equal(flat.promptValidation,"not_performed");assert.equal(JSON.parse(flat.segment_windows).windows[0].prompt,"Alex sits at his desk.");
  const unformatted=await client.call("run_app",{...payload,values:{...payload.values,segment_windows:flat.segment_windows}});assert.equal(resultData(unformatted).status,400);assert.ok(resultData(unformatted).issues.some((i:any)=>i.code==="PIKA_SECTIONS"));assert.equal(requests.length,0);
  const bad=structuredClone(payload),window=JSON.parse(bad.values.segment_windows);window.windows[0].prompt=originalPrompt.replace("<Picture 2>","<Picture 3>");bad.values.segment_windows=JSON.stringify(window);
  const rejected=await client.call("run_app",bad),error=resultData(rejected);
  assert.equal(rejected.isError,true);assert.equal(error.status,400);assert.equal(error.code,"INPUT_VALIDATION");assert.ok(error.issues.some((i:any)=>i.code==="PIKA_UNBOUND_REFERENCE"&&i.field.endsWith(".references")));assert.equal(requests.length,0);assert.equal(uploads.length,0);
  const missing=await client.call("run_app",{...payload,files:{...payload.files,image2:join(dir,"nonexistent.png")}});assert.equal(missing.isError,true);assert.equal(resultData(missing).issues[0].code,"MISSING_FILE");assert.equal(requests.length,0);
  const accepted=await client.call("run_app",payload);assert.ok(!accepted.isError,JSON.stringify(accepted));assert.ok(resultData(accepted).id);
  const submitted=await waitDispatch(dispatch);
  assert.equal(requests.length,1);assert.equal(uploads.length,2);
  const graph=submitted.workflow;assert.equal(graph.rfplan.inputs.segment_windows,payload.values.segment_windows);assert.equal(graph[41].inputs.aspect_ratio,"9:16 (Portrait Widescreen)");assert.equal(graph[41].inputs.megapixels,0.4);
  assert.equal(graph[13].inputs.sampler_name,"lcm");assert.deepEqual(JSON.parse(graph.rfplan.inputs.segment_windows).windows[0].images,[0,1]);
  assert.ok(graph.rfplan.inputs.image1);assert.ok(graph.rfplan.inputs.image2);assert.notDeepEqual(graph.rfplan.inputs.image1,graph.rfplan.inputs.image2);
  assert.deepEqual(graph[50].inputs,JSON.parse(readFileSync("apps/pika-studio-director/workflow.api.json","utf8"))[50].inputs,"the locked sigma recipe is unchanged");
  // Same real HTTP/SDK path for empty-bin FL2VA: no picture uploads or fake endpoint fields.
  const flDispatch=new Promise<any>(resolve=>dispatched=resolve);
  const fl=await client.call("run_app",{app:payload.app,values:{duration:20,start_seconds:55,aspect:payload.values.aspect,megapixels:.4,global_prompt:"integrated_multimodal_description:\n[Shot 1] A quiet apartment at night.\noverall_soundscape:\nSoft room tone.\nnon_diegetic_music:\nN/A"}});assert.ok(!fl.isError,JSON.stringify(fl));
  const flGraph=(await waitDispatch(flDispatch)).workflow;assert.equal(uploads.length,2);assert.equal(flGraph.rfplan.inputs.generation_seconds,7.3);assert.equal(flGraph.rfplan.inputs.start_seconds,0);assert.match(flGraph[1].inputs.unet_name,/fl2va/);assert.match(flGraph[40].inputs.lora_name,/fl2va/);
  // Sound reference + multiple segments: keep the creative inputs but prevent custom geometry.
  const audio=join(dir,"room-tone.wav");writeFileSync(audio,Buffer.from("RIFFmock WAVE"));
  const withAudio=JSON.parse(payload.values.segment_windows);withAudio.windows[0].prompt=originalPrompt.replace("summary:","<Audio 1> supplies apartment ambience.\nsummary:");withAudio.windows[0].audios=[0];withAudio.windows[0].end=260;withAudio.windows.push({...withAudio.windows[0],start:221,end:481});
  const autoRefValues={...payload.values,duration:11,start_seconds:12,detail:.1,multiple:8,sla:false,clip_name:"qwen3vl_32b_minimax_h3_ultra_uncensored_heretic_int8_convrot.safetensors",audio_mode:"reference",segment_windows:JSON.stringify(withAudio)};delete autoRefValues.flex_mode;
  const audioDispatch=new Promise<any>(resolve=>dispatched=resolve),audioResult=await client.call("run_app",{...payload,files:{...payload.files,audio1:audio},values:autoRefValues});assert.ok(!audioResult.isError,JSON.stringify(audioResult));
  const audioGraph=(await waitDispatch(audioDispatch)).workflow,audioWindows=JSON.parse(audioGraph.rfplan.inputs.segment_windows).windows;
  assert.deepEqual(audioWindows.map((w:any)=>[w.start,w.end]),[[0,175],[136,311]]);assert.equal(audioWindows[0].prompt,withAudio.windows[0].prompt);assert.deepEqual(audioWindows[0].audios,[0]);assert.ok(audioGraph.rfplan.inputs.audio1);assert.equal(audioGraph.rfplan.inputs.generation_seconds,7.3);assert.equal(audioGraph.rfplan.inputs.start_seconds,0);assert.equal(audioGraph[41].inputs.megapixels,.4);assert.equal(requests.length,3);
  assert.equal(audioGraph[42].inputs.sparsity_ratio,.85);assert.equal(audioGraph[42].inputs.enabled,true);assert.equal(audioGraph[41].inputs.multiple,32);assert.equal(audioGraph[2].inputs.clip_name,"qwen3vl_32b_minimax_h3_int8_convrot.safetensors");
  assert.match(audioGraph[1].inputs.unet_name,/ref2va/);assert.match(audioGraph[40].inputs.lora_name,/ref2va/);
  // Existing Relay app remains a separate utility with its OWN paired models and one-step sampler.
  const relay=resultData(await client.call("get_app",{app:"relayvsr-upscale"})),dit4=relay.inputs.find((i:any)=>i.id==="unet_name").options[1],vae2=relay.inputs.find((i:any)=>i.id==="vae_name").options[0],clip=join(dir,"mock-source-video.mp4");writeFileSync(clip,"mock source bytes; no decoder is invoked by this backend");
  const mismatched=await client.call("run_app",{app:relay.id,files:{video:clip},values:{unet_name:dit4,vae_name:vae2}});assert.equal(mismatched.isError,true);assert.equal(resultData(mismatched).issues[0].code,"RELAY_MODEL_PAIR");assert.equal(requests.length,3);
  const relayDispatch=new Promise<any>(resolve=>dispatched=resolve),relayResult=await client.call("run_app",{app:relay.id,files:{video:clip},values:{unet_name:dit4}});assert.ok(!relayResult.isError,JSON.stringify(relayResult));
  const relayGraph=(await waitDispatch(relayDispatch)).workflow;assert.match(relayGraph[4].inputs.unet_name,/_x4_/);assert.match(relayGraph[7].inputs.vae_name,/_x4_/);assert.equal(relayGraph[6].inputs.steps,1);assert.equal(relayGraph[6].inputs.cfg,1);assert.equal(relayGraph[6].inputs.sampler_name,"euler");assert.deepEqual(relayGraph[105].inputs.audio,["2",1]);assert.deepEqual(relayGraph[105].inputs.fps,["2",2]);assert.equal(requests.length,4);
  // Reproduce BOTH actual Maya transport failures through the real API preparation path.
  const mayaPrompt=readFileSync("test/fixtures/pika-maya-dialogue.txt","utf8"),mayaWindows=JSON.stringify({windows:[0,136,272].map(start=>({start,end:start+175,prompt:mayaPrompt,images:[0,1],audios:[]})),videos:[],audios:[]});
  for(const variant of ["paths-in-values","redundant-image-field"]){
   const args=variant==="paths-in-values"?{app:payload.app,values:{...payload.values,aspect:"9:16",segment_windows:mayaWindows,image1:payload.files.image1,image2:payload.files.image2}}:{...payload,values:{...payload.values,segment_windows:mayaWindows,image:[0,1]}};
   const mayaDispatch=new Promise<any>(resolve=>dispatched=resolve);
   const mayaResult:any=await client.call("run_app",args);assert.ok(!mayaResult.isError,JSON.stringify(mayaResult));const mayaGraph=(await waitDispatch(mayaDispatch)).workflow;
   assert.deepEqual(JSON.parse(mayaGraph.rfplan.inputs.segment_windows).windows.map((w:any)=>[w.start,w.end,w.images]),[[0,175,[0,1]],[136,311,[0,1]],[272,447,[0,1]]]);assert.equal(mayaGraph[41].inputs.aspect_ratio,"9:16 (Portrait Widescreen)");assert.equal(mayaGraph[41].inputs.megapixels,.4);assert.ok(mayaGraph.rfplan.inputs.image1);assert.ok(mayaGraph.rfplan.inputs.image2);
  }
  assert.equal(requests.length,6);
  // Guided mode: fixed form -> plain-text writer -> code-built run, with NO LLM tool calls.
  const json=async(path:string,body?:any)=>{const r=await fetch(base+path,body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:undefined);const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
  const options=await json("/api/agent/director-options");assert.equal(writerRequests.length,0);
  const provider=await json("/api/agent/providers",{name:"Guided writer fixture",location:"local",baseURL:`http://127.0.0.1:${mockPort}/v1`,model:"fixture",toolMode:"json"}),conversation=await json("/api/agent/conversations",{provider:provider.id,model:"fixture"});
  const form=options.form;form.brief="Maya answers a call in a hospital corridor.";form.actors[0].name="Maya";form.actors[0].description="An adult woman in a navy coat.";form.environment="Empty hospital corridor";form.segments[0].action="Maya raises her phone and listens.";form.segments[0].dialogue[0]="Vous êtes sûr ?";
  for(const [field,slot] of [["asset","image1"],["environmentAsset","image2"]]){const data=new FormData();data.set("file",new Blob([readFileSync(payload.files[slot])],{type:"image/png"}),`${slot}.png`);const r=await fetch(base+`/api/agent/conversations/${conversation.id}/upload`,{method:"POST",body:data});const asset=await r.json();assert.ok(r.ok);if(field==="asset")form.actors[0].asset=asset.id;else form.environmentAsset=asset.id;}
  form.language="French";form.reviewed=true;const endpoint=`/api/agent/conversations/${conversation.id}/director`;await json(endpoint,{action:"save",form});assert.equal(writerRequests.length,0);
  const written=await json(endpoint,{action:"write",field:"scenario"});assert.match(written.director.scenario,/Maya waits/);assert.equal(writerRequests.length,1);assert.equal(writerRequests[0].tools,undefined);assert.equal(writerRequests[0].tool_choice,undefined);assert.doesNotMatch(writerRequests[0].messages[0].content,/Explicit JSON tool protocol/);
  assert.equal(written.director.promptsStale,true);
  const stale=await fetch(base+endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"run",kind:"video"})});assert.ok(!stale.ok);assert.equal(requests.length,6);
  // This transport fixture supplies its reviewed shot text manually; the chat-only path below uses prepare.
  await json(endpoint,{action:"save",form:{...written.director,promptsStale:false}});
  const guidedDispatch=new Promise<any>(resolve=>dispatched=resolve),guided=await json(endpoint,{action:"run",kind:"video"});assert.equal(guided.tools.at(-1).arguments.app,"pika-studio-director");assert.equal(guided.tools.at(-1).guidedTarget,"video");const guidedGraph=(await waitDispatch(guidedDispatch)).workflow;assert.match(JSON.parse(guidedGraph.rfplan.inputs.segment_windows).windows[0].prompt,/<d>\[French\] Vous êtes sûr \?<\/d>/);assert.equal(writerRequests.length,1);assert.equal(requests.length,7);
  const editDispatch=new Promise<any>(resolve=>dispatched=resolve),edited=await json(endpoint,{action:"run",kind:"edit",index:0,instruction:"Remove the ring"});assert.equal(edited.tools.at(-1).arguments.app,"qwen-image-edit-turbo");assert.equal((await waitDispatch(editDispatch)).workflow[451].inputs.unet_name,"qwen_image_2.1_turbo_int8_convrot.safetensors");assert.equal(writerRequests.length,1);
  for(let i=0;i<30;i++){const synced=await json(`/api/agent/conversations/${conversation.id}/jobs`,{});if(["failed","succeeded","canceled"].includes(synced.jobStates[edited.tools.at(-1).job]?.status))break;await new Promise(r=>setTimeout(r,10));}
  const sheetDispatch=new Promise<any>(resolve=>dispatched=resolve),sheet=await json(endpoint,{action:"run",kind:"actor",index:0});assert.equal(sheet.tools.at(-1).arguments.app,"moss-turbo");assert.equal(sheet.tools.at(-1).arguments.values.steps,8);assert.equal(sheet.tools.at(-1).arguments.values.rewrite,false);await waitDispatch(sheetDispatch);assert.equal(writerRequests.length,1);assert.equal(requests.length,9);
  const chat=await json("/api/agent/conversations",{provider:provider.id,model:"fixture"}),chatEndpoint=`/api/agent/conversations/${chat.id}/director`;
  assert.equal((await json(chatEndpoint,{action:"start"})).director.chatStep,"duration");
  assert.equal((await json(chatEndpoint,{action:"choose",key:"defaults"})).director.chatStep,"brief");assert.equal(writerRequests.length,1);
  assert.equal((await json(chatEndpoint,{action:"say",text:"A quiet scene about unexpected news."})).director.chatStep,"story");
  assert.equal((await json(chatEndpoint,{action:"prepare"})).director.chatStep,"draft");
  await json(chatEndpoint,{action:"choose",key:"settings"});await json(chatEndpoint,{action:"choose",key:"setting",value:"mode"});await json(chatEndpoint,{action:"choose",key:"mode",value:"fl2va"});
  assert.equal((await json(chatEndpoint,{action:"references"})).director.chatStep,"render");assert.equal(requests.length,9,"chat writing and navigation cannot launch GPU jobs");assert.ok(writerRequests.every(r=>r.tools===undefined&&r.tool_choice===undefined));
  const audioProvider=await json("/api/agent/providers",{name:"Audio inspection fixture",location:"local",baseURL:`http://127.0.0.1:${mockPort}/v1`,model:"fixture",toolMode:"json",audio:true}),audioChat=await json("/api/agent/conversations",{provider:audioProvider.id,model:"fixture"}),audioEndpoint=`/api/agent/conversations/${audioChat.id}/director`;
  const audioBefore=await json(audioEndpoint,{action:"start"}),upload=new FormData();upload.set("file",new Blob(["RIFF audio transport fixture"],{type:"audio/wav"}),"recording.wav");const uploadResponse=await fetch(base+`/api/agent/conversations/${audioChat.id}/upload`,{method:"POST",body:upload}),attached=await uploadResponse.json();assert.ok(uploadResponse.ok);
  const heard=await json(audioEndpoint,{action:"say",text:"Describe only the supplied recording.",attachments:[attached.id]});assert.deepEqual(heard.director,audioBefore.director);const audioPart=writerRequests.at(-1).messages.at(-1).content.find((p:any)=>p.type==="input_audio");assert.equal(audioPart.input_audio.data,Buffer.from("RIFF audio transport fixture").toString("base64"));assert.equal(audioPart.input_audio.format,"wav");assert.equal(requests.length,9,"audio inspection does not dispatch image/video jobs");
 }finally{
  await client?.close();if(child.exitCode===null){child.kill("SIGTERM");await once(child,"exit");}
  backend.closeAllConnections();await new Promise<void>(r=>backend.close(()=>r()));rmSync(dir,{recursive:true,force:true});
 }
});
