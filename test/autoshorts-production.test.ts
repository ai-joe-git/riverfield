import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {createServer} from "node:http";
import {once} from "node:events";
import {AutoShorts,boardSchema,sceneSchema,narrationText,upscalePlan} from "../server/autoshorts.ts";
import {bibleSchema,shotPrompt} from "../server/autoshorts-continuity.ts";
import {command,segmentArgs,probe} from "../server/autoshorts-media.ts";
import {loadRegistry} from "../server/registry.ts";

const apps=loadRegistry().apps;
const scene=(extra:any={})=>sceneSchema.parse({id:"shot",order:0,duration:1.2,narration:"",visual:"Night street",prompt:"A night street",engine:"pika-video",method:"video",...extra});
const board=(scenes:any[],extra:any={})=>boardSchema.parse({title:"Test",hook:"",closing:"",narration:"",scenes,...extra});
async function done(service:AutoShorts,pid:string){for(let i=0;i<600;i++){const p=service.get(pid);if(!["queued","running"].includes(p.tasks.at(-1)!.status))return p;await new Promise(r=>setTimeout(r,20));}throw new Error("timeout");}
async function fixture(dir:string){
  const source=join(dir,"source.mp4"),up=join(dir,"up.mp4"),tts=join(dir,"tts.wav"),image=join(dir,"ref.png");
  await command("ffmpeg",["-y","-f","lavfi","-i","color=c=red:s=96x64:r=24:d=1.2","-f","lavfi","-i","sine=frequency=220:duration=1.2","-c:v","libx264","-threads","1","-pix_fmt","yuv420p","-c:a","aac","-shortest",source]);
  await command("ffmpeg",["-y","-i",source,"-vf","scale=192:128","-c:v","libx264","-threads","1","-c:a","copy",up]);
  await command("ffmpeg",["-y","-f","lavfi","-i","sine=frequency=880:duration=0.4",tts]);
  await command("ffmpeg",["-y","-f","lavfi","-i","color=c=red:s=96x64","-frames:v","1","-threads","1",image]);
  return {source,up,tts,image};
}
function energy(file:string,start=0,length=.3){
  const raw=execFileSync("ffmpeg",["-v","error","-ss",String(start),"-i",file,"-t",String(length),"-vn","-ac","1","-ar","48000","-f","f32le","pipe:1"]);
  let sum=0;for(let i=0;i<raw.length;i+=4)sum+=raw.readFloatLE(i)**2;
  return Math.sqrt(sum/(raw.length/4));
}
const bible=()=>bibleSchema.parse({style:"Photorealistic",timeOfDay:"night",lighting:"Moonlight and neon",
  entities:[{id:"rosa",kind:"character",description:"Exactly one 70-year-old woman, silver bob, leopard coat and gold jewelry"},
    {id:"car",kind:"vehicle",description:"Tiny red hatchback, chrome wheels, huge spoiler",traits:{color:"red"}},
    {id:"street",kind:"setting",description:"Marrakech alley at midnight"}]});
const continuity=()=>({entityIds:["rosa","car","street"],settingId:"street",timeOfDay:"night",lighting:"Moonlight and neon",counts:{rosa:1,car:1},transition:false,notes:"Rosa drives alone"});

test("speech modes retain new native audio by default, honor explicit mutes and avoid duplicate dialogue TTS",()=>{
  assert.equal(scene().keepAudio,true);assert.equal(scene({keepAudio:false}).keepAudio,false);
  assert.equal(narrationText(scene({narration:"Five stars!",dialogue:"Five stars.",speechMode:"auto"})),"");
  assert.equal(narrationText(scene({narration:"A narrator",speechMode:"native"})),"");
  assert.equal(narrationText(scene({narration:"A narrator",speechMode:"mute"})),"");
  assert.equal(narrationText(scene({narration:"She arrives",dialogue:"Five stars"})),"She arrives");
});
test("internal RelayVSR is counted toward total factor, not blindly applied twice",()=>{
  assert.deepEqual(upscalePlan(2,2),{target:2,internal:2,external:1});
  assert.equal(upscalePlan(4,2).external,2);assert.equal(upscalePlan(4,1).external,4);
  assert.throws(()=>upscalePlan(1,2),/conflicts/);
});
test("visual bible expands self-contained prompts and rejects obvious contradictions",()=>{
  const s=scene({continuity:continuity()});const b=bible();
  const prompt=shotPrompt(b,s);assert.match(prompt,/70-year-old/);assert.match(prompt,/Tiny red hatchback/);assert.match(prompt,/midnight/);assert.match(prompt,/Moonlight/);
  assert.doesNotThrow(()=>board([{...s,prompt:"No daylight. Red hatchback with blue car underglow."}],{visualBible:b}));
  assert.throws(()=>board([{...s,prompt:"Sunny daylight"}],{visualBible:b}),/daylight/);
  assert.throws(()=>board([{...s,prompt:"A blue hatchback"}],{visualBible:b}),/vehicle color/);
  assert.throws(()=>board([{...s,continuity:{...continuity(),counts:{rosa:2}}}],{visualBible:b}),/duplicated/);
  assert.throws(()=>board([{...s,prompt:"Two elderly women in the car"}],{visualBible:b}),/duplicates/);
  assert.throws(()=>board([{...s,continuity:{...continuity(),timeOfDay:"day"},prompt:"Day shot",visual:"Day shot"}],{visualBible:b}),/explicit transition/);
  assert.throws(()=>board([{...s,continuity:{...continuity(),entityIds:["unknown"],settingId:"unknown"}}],{visualBible:b}),/unknown/);
});
test("Cinema planning requests a visual bible and separate dialogue; contradictions fail before generation",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"rf-cinema-plan-"));let invalid=false,requests=0;
  const llm=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const payload=JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(payload.response_format.json_schema.schema.properties.visualBible);
    assert.ok(payload.response_format.json_schema.schema.properties.scenes.items.properties.dialogue);
    requests++;const s=scene({engine:"pika-video",continuity:continuity(),prompt:invalid?"Sunny daylight":"Night street"});
    res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({title:"Film",hook:"",closing:"",narration:"",music:"",visualBible:bible(),scenes:[s]})}}]}));
  });
  llm.listen(0,"127.0.0.1");await once(llm,"listening");
  try{
    const service=new AutoShorts(join(dir,"projects"),apps,async()=>{throw new Error("GPU forbidden");});
    const cfg={mode:"CINEMA",llmUrl:`http://127.0.0.1:${(llm.address() as any).port}/v1`};
    let p=service.create(cfg);assert.equal(p.config.videoEngine,"pika-video");
    service.start(p.id,"plan");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");assert.ok(p.board?.visualBible);
    invalid=true;const bad=service.create(cfg);service.start(bad.id,"plan");p=await done(service,bad.id);
    assert.equal(p.tasks.at(-1)?.status,"failed");assert.match(p.tasks.at(-1)?.error||"",/validation/);assert.equal(requests,4);assert.equal(p.board,undefined);
  }finally{llm.close();await once(llm,"close");rmSync(dir,{recursive:true,force:true});}
});
test("FFmpeg preserves native-only sound, ducks for narration, restores ambience after TTS, and honors silence",{timeout:60000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),"rf-sound-"));try{
    const f=await fixture(dir),options={aspect:"16:9",height:96,fps:24,fit:"crop" as const,transition:0,burn:false,musicVolume:.1};
    const base={media:f.source,image:false,duration:1.2,trim:0,keepAudio:true};
    for(const [name,settings] of [["native",{}],["mix",{audio:f.tts}],["mute",{keepAudio:false}],["tts",{audio:f.tts,keepAudio:false}]] as const){
      await command("ffmpeg",segmentArgs({...base,...settings},options,join(dir,`${name}.mp4`)));
    }
    // Measure after the compressor's release tail, not at a borderline AAC block.
    const native=energy(join(dir,"native.mp4"),.95,.2);
    assert.ok(native>.04);
    assert.ok(energy(join(dir,"mix.mp4"),.95,.2)>native*.75,"ambience must recover after the narrator and release tail (not remain at constant quarter/half gain)");
    assert.ok(energy(join(dir,"mix.mp4"),.05)>.02);
    assert.ok(energy(join(dir,"mute.mp4"),.75)<.001);
    assert.ok(energy(join(dir,"tts.mp4"),.75)<.001,"explicit mute must not leak source audio");
    assert.ok(energy(join(dir,"tts.mp4"),.05)>.02);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("export records actual upscale path, scene overrides, source sound and versioned provenance; no GPU on render",{timeout:60000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),"rf-provenance-"));try{
    const f=await fixture(dir),calls:any[]=[];
    const service=new AutoShorts(join(dir,"projects"),apps,async(app,values)=>{calls.push({app:app.id,values});return {path:app.id==="relayvsr-upscale"?f.up:f.source,job:`job-${calls.length}`,seconds:0,modelLoading:null};});
    let p=service.create({mode:"CINEMA",height:720,aspect:"16:9",profile:"x4",autoAccept:true,subtitles:"none",transition:0});
    const path=service.import(p.id,readFileSync(f.source),"source.mp4");
    p=service.edit(p.id,{board:board([scene({method:"import",references:[path],profile:"custom",factor:2}),scene({id:"second",order:1,method:"import",references:[path],profile:"native"})])});
    service.start(p.id,"produce");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");
    assert.equal(calls.length,1);assert.equal(calls[0].app,"relayvsr-upscale");assert.match(calls[0].values.unet_name,/x2_light/);
    const exp=p.exports.at(-1)!,manifest=JSON.parse(readFileSync(service.file(p.id,exp.provenance!),"utf8"));
    assert.equal(manifest.complete,true);assert.equal(manifest.scenes[0].selected,"state.upscale.path");
    assert.equal(manifest.scenes[0].path,p.states.shot.upscale!.path);assert.equal(manifest.scenes[0].measured.width,192);
    assert.match(manifest.scenes[0].sha256,/^[a-f0-9]{64}$/);assert.equal(manifest.scenes[0].resolutionSettings.project.profile,"x4");
    assert.equal(manifest.scenes[0].nativeAudio,path);assert.equal(manifest.scenes[1].selected,"state.media.path");
    assert.equal(manifest.scenes[1].target,1);assert.ok(energy(service.file(p.id,exp.path),.75)>.04);
    service.start(p.id,"render");p=await done(service,p.id);assert.equal(calls.length,1);assert.equal(p.exports.length,1);
    const silent=structuredClone(p.board!);silent.scenes.forEach(s=>s.keepAudio=false);p=service.edit(p.id,{board:silent});
    service.start(p.id,"render");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");
    assert.equal(calls.length,1);assert.equal(p.exports.length,2);assert.ok(energy(service.file(p.id,p.exports.at(-1)!.path),.75)<.001);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("Pika media generation disables internal upscale even when scene params enable it",{timeout:60000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),"rf-pika-"));try{
    const f=await fixture(dir),calls:any[]=[];
    const service=new AutoShorts(join(dir,"projects"),apps,async(app,values)=>{calls.push(values);return {path:f.source,job:"pika",seconds:0,modelLoading:null};});
    let p=service.create({mode:"CINEMA",profile:"custom",megapixels:.5,factor:2});
    p=service.edit(p.id,{board:board([scene({params:{upscale:"x4"},speechMode:"native"})])});
    service.start(p.id,"media","shot");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");
    assert.equal(calls[0].upscale,"");assert.equal(p.states.shot.media?.workflowUpscale,1);
    p.states.shot.media!.workflowUpscale=2;p.board!.scenes[0].profile="custom";p.board!.scenes[0].megapixels=.5;p.board!.scenes[0].factor=2;service.save(p);
    const selection=await service.assemblySource(p,p.board!.scenes[0]);assert.equal(selection.selected,"state.media.path");
    assert.equal(selection.external,1);assert.equal(selection.internal,2);
    delete p.states.shot.media!.workflowUpscale;
    mkdirSync(join(dir,"history","pika"),{recursive:true});
    writeFileSync(join(dir,"history","pika","meta.json"),JSON.stringify({app:"pika-video",values:{upscale:"x2"}}));service.save(p);
    assert.equal((await service.assemblySource(p,p.board!.scenes[0])).internal,2,"legacy internal factor is recovered from actual history values");
    p.board!.scenes[0].decision="accepted";service.save(p);service.start(p.id,"upscale","shot");p=await done(service,p.id);
    assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");assert.equal(calls.length,1,"internal x2 must not run another external x2");
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("canonical references and keyframes are reviewed, cached and routed into Pika Video with full bible prompt",{timeout:60000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),"rf-continuity-"));try{
    const f=await fixture(dir),calls:{app:string;values:any}[]=[];
    const service=new AutoShorts(join(dir,"projects"),apps,async(app,values)=>{calls.push({app:app.id,values});return {path:app.outputs.some(o=>o.type==="image")?f.image:f.source,job:`call-${calls.length}`,seconds:0,modelLoading:null};});
    let p=service.create({mode:"CINEMA",profile:"native",imageEngine:"z-image",keyframeEngine:"edit"});
    const b=bible();p=service.edit(p.id,{board:board([scene({continuity:continuity(),engine:"pika-text-to-video",speechMode:"native"})],{visualBible:b})});
    service.start(p.id,"references");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");assert.equal(calls.length,3);
    service.start(p.id,"produce");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.match(p.tasks.at(-1)?.review?.message||"",/No video or TTS/);assert.equal(calls.length,3);
    service.start(p.id,"keyframe","shot");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.match(p.tasks.at(-1)?.review?.message||"",/approve each canonical/);assert.equal(calls.length,3);
    p.board!.visualBible!.entities.forEach(e=>e.approved=true);p=service.edit(p.id,{board:p.board});
    service.start(p.id,"keyframe","shot");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");
    assert.equal(calls.at(-1)!.app,"edit");assert.match(calls.at(-1)!.values.instruction,/Tiny red hatchback/);
    service.start(p.id,"keyframe","shot");p=await done(service,p.id);assert.equal(calls.length,4,"preparing the same keyframe again must reuse it");
    service.start(p.id,"media","shot");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.match(p.tasks.at(-1)?.review?.message||"",/approve the prepared keyframe/);assert.equal(calls.length,4);
    service.start(p.id,"approve-keyframe","shot");p=await done(service,p.id);
    service.start(p.id,"media","shot");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");
    assert.equal(calls.at(-1)!.app,"pika-video");assert.ok(calls.at(-1)!.values.first_frame.bytes);assert.match(calls.at(-1)!.values.prompt,/70-year-old/);
    p.board!.scenes[0].engine="h3-r2v-flex";p=service.edit(p.id,{board:p.board});
    service.start(p.id,"media","shot");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");
    assert.equal(calls.at(-1)!.app,"h3-r2v-flex");assert.ok(calls.at(-1)!.values.image1.bytes);
    const key=p.states.shot.media!.inputHash;
    p.board!.visualBible!.entities[0].description="New wardrobe";p=service.edit(p.id,{board:p.board});
    assert.equal(p.board!.visualBible!.entities[0].approved,false);
    service.start(p.id,"media","shot");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.match(p.tasks.at(-1)?.review?.message||"",/approve each canonical/);
    assert.equal(p.states.shot.media!.inputHash,key,"old footage is retained, not overwritten");
  }finally{rmSync(dir,{recursive:true,force:true});}
});
