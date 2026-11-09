import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { AutoShorts, boardSchema, configSchema, contained, localURL, resolution, hash, llamaEndpoint } from "../server/autoshorts.ts";
import { command, approximateWords, captions, dimensions, sourceDimensions, segmentArgs, probe } from "../server/autoshorts-media.ts";
import { loadRegistry } from "../server/registry.ts";
import { InferenceQueue } from "../server/inference-queue.ts";

const apps=loadRegistry().apps;
const scene=(id="shot-1",order=0)=>({id,order,duration:1.2,narration:"Hello local world",visual:"A blue landscape",prompt:"A blue landscape",engine:"z-image",method:"image",references:[],instructions:""});
const board=()=>({title:"Local film",hook:"Hello",narration:"Hello local world",closing:"Goodbye",music:"",scenes:[scene()]});
const temporary=()=>mkdtempSync(join(tmpdir(),"riverfield-autoshorts-"));
async function done(service:AutoShorts,pid:string){for(let i=0;i<600;i++){const p=service.get(pid), t=p.tasks.at(-1)!;if(!["queued","running"].includes(t.status))return p;await new Promise(r=>setTimeout(r,50));}throw new Error("Test task timeout");}

test("storyboard validation: stable IDs, ordering, duration, strict JSON types",()=>{
  assert.equal(boardSchema.parse(board()).scenes[0].profile,"auto");
  assert.throws(()=>boardSchema.parse({...board(),scenes:[scene(),scene()]}));
  assert.throws(()=>boardSchema.parse({...board(),scenes:[{...scene(),duration:-1}]}));
  assert.throws(()=>boardSchema.parse({...board(),scenes:[{...scene(),id:"../../escape"}]}));
  assert.throws(()=>boardSchema.parse({...board(),scenes:[{...scene(),id:"__proto__"}]}));
  assert.throws(()=>configSchema.parse({fps:NaN}));
});
test("local URLs and symlink/root containment",()=>{
  assert.equal(localURL("http://127.0.0.1:8080/v1"),"http://127.0.0.1:8080/v1");
  for(const url of ["https://example.com/v1","file:///etc/passwd","http://user:secret@localhost/v1"])assert.throws(()=>localURL(url));
  const dir=temporary();try{mkdirSync(join(dir,"inside"));writeFileSync(join(dir,"outside"),"test");symlinkSync(join(dir,"outside"),join(dir,"inside","link"));assert.throws(()=>contained(join(dir,"inside"),"link"));}finally{rmSync(dir,{recursive:true,force:true});}
});
test("resolution profiles obey actual manifests and x4 is sixteen times the pixels",()=>{
  const h3=apps.find(a=>a.id==="h3-video-turbo")!,pika=apps.find(a=>a.id==="pika-studio-director")!;
  assert.equal(resolution(h3,"x2",.4,2,"9:16").mp,.4);
  assert.throws(()=>resolution(h3,"x4",.2,4,"9:16"),/unsupported/);
  const r=resolution(pika,"x4",.2,4,"9:16");assert.equal(r.factor,4);assert.equal((r.width*4*r.height*4)/(r.width*r.height),16);
  assert.equal(sourceDimensions(.4,"9:16").width%32,0);
  assert.deepEqual(dimensions("9:16",1920),{width:1080,height:1920});
});
test("captions sanitize ASS control codes, preserve SRT timing, identify approximate words",()=>{
  const words=approximateWords("hello {\\pos(0,0)} world",3),out=captions(words,true);
  assert.match(out.srt,/00:00:00,000 --> 00:00:03,000/);
  assert.match(out.ass,/\\kf/);assert.doesNotMatch(out.ass,/\{\\pos/);
  const args=segmentArgs({media:"input';evil.mp4",audio:"a.wav",image:false,duration:2,trim:0,keepAudio:false},{aspect:"1:1",height:720,fps:24,fit:"crop",transition:.2,burn:false,musicVolume:.1},"out.mp4");
  assert.ok(args.includes("input';evil.mp4"));assert.equal(args.filter(x=>x==="-i").length,2);
});
test("durable persistence, interrupted recovery, independent scene state and busy editing",async()=>{
  const dir=temporary();try{
    const service=new AutoShorts(dir,apps,async()=>{throw new Error("not invoked");});let p=service.create({});
    assert.ok(service.schemas().storyboard);
    p=service.edit(p.id,{board:board()});assert.equal(service.get(p.id).title,"Local film");
    p.tasks.push({id:"task",action:"render",status:"running",started:new Date().toISOString()});service.save(p);
    assert.throws(()=>service.edit(p.id,{config:p.config}),/Cancel/);
    const recovered=new AutoShorts(dir,apps,async()=>{throw new Error("not invoked");});assert.equal(recovered.get(p.id).tasks[0].status,"interrupted");
    recovered.start(p.id,"render");const result=await done(recovered,p.id);assert.equal(result.tasks.at(-1)?.status,"failed");assert.match(result.tasks.at(-1)?.error||"",/missing media/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("synthetic vertical slice: local structured LLM, mock workflow outputs, real FFmpeg mix/captions/export and cached retry",{timeout:90000},async()=>{
  const dir=temporary();let calls=0;
  const llm=createServer((req,res)=>{req.resume();res.setHeader("content-type","application/json");res.end(JSON.stringify(req.url?.includes("transcriptions")?{words:[{word:"Hello",start:0,end:.3},{word:"local",start:.3,end:.7},{word:"world",start:.7,end:1.2}]}:{choices:[{message:{content:JSON.stringify({...board(),scenes:[scene(),scene("shot-2",1)]})}}]}));});
  llm.listen(0,"127.0.0.1");await once(llm,"listening");
  try{
    await command("ffmpeg",["-y","-f","lavfi","-i","color=c=blue:s=160x96","-frames:v","1","-threads","1",join(dir,"still.png")]);
    await command("ffmpeg",["-y","-f","lavfi","-i","sine=frequency=440:duration=1.2",join(dir,"speech.wav")]);
    const service=new AutoShorts(join(dir,"projects"),apps,async(app,values,signal,update)=>{
      calls++;update({child:`synthetic-${calls}`});signal.throwIfAborted();
      return {path:join(dir,app.id==="tts"?"speech.wav":"still.png"),job:`synthetic-${calls}`,seconds:.01,modelLoading:null};
    });
    let p=service.create({topic:"local test",mode:"FAST",llmUrl:`http://127.0.0.1:${(llm.address() as any).port}/v1`,autoAccept:true,height:720,aspect:"16:9",profile:"native",subtitles:"karaoke"});
    const track=service.import(p.id,readFileSync(join(dir,"speech.wav")),"music.wav");p=service.edit(p.id,{config:{...p.config,music:track}});
    service.start(p.id,"produce");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");assert.equal(p.exports.length,1);assert.equal(calls,4);
    const info=await probe(service.file(p.id,p.exports[0].path));assert.equal(info.width,1280);assert.equal(info.height,720);assert.ok(info.audio);assert.ok(Math.abs(info.duration-2.4)<.2);
    assert.match(readFileSync(service.file(p.id,p.exports[0].srt),"utf8"),/Hello local world/);
    service.start(p.id,"produce");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");assert.equal(calls,4);assert.equal(p.exports.length,1);
    service.edit(p.id,{config:{...p.config,alignUrl:p.config.llmUrl}});service.start(p.id,"align","shot-1");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"succeeded");assert.equal(calls,4);assert.match(p.states["shot-1"].audio?.alignment||"",/local word transcription/);
    const changed=structuredClone(p.board!);changed.scenes[0].narration="Changed narration";service.edit(p.id,{board:changed});service.start(p.id,"render");p=await done(service,p.id);assert.match(p.tasks.at(-1)?.error||"",/narration settings changed/);
  }finally{llm.close();await once(llm,"close");rmSync(dir,{recursive:true,force:true});}
});

test("review gate prevents upscaling rejected media; x2/x4 use synchronized RelayVSR pair without video regeneration",{timeout:90000},async()=>{
  const dir=temporary(),calls:{app:string;values:any}[]=[];
  try{
    const source=join(dir,"source.mp4");await command("ffmpeg",["-y","-f","lavfi","-i","color=c=red:s=160x96:r=24:d=1.2","-c:v","libx264","-threads","1","-pix_fmt","yuv420p",source]);
    const original=hash(readFileSync(source));
    const service=new AutoShorts(join(dir,"projects"),apps,async(app,values)=>{calls.push({app:app.id,values});return {path:source,job:`upscale-${calls.length}`,seconds:.05,modelLoading:null};});
    let p=service.create({profile:"x2",height:720,aspect:"16:9"});const path=service.import(p.id,readFileSync(source),"input.mp4");
    p=service.edit(p.id,{board:{...board(),scenes:[{...scene(),method:"import",references:[path],narration:"",profile:"custom",megapixels:.4,factor:2}]}});
    service.start(p.id,"produce");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.equal(p.tasks.at(-1)?.review?.stage,"clip-review");assert.equal(calls.length,0);assert.equal(p.exports.length,0);
    service.start(p.id,"upscale","shot-1");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"failed");assert.equal(calls.length,0);
    p.board!.scenes[0].decision="accepted";service.edit(p.id,{board:p.board});service.start(p.id,"upscale","shot-1");p=await done(service,p.id);
    assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");assert.equal(calls[0].app,"relayvsr-upscale");assert.match(calls[0].values.unet_name,/x2_lightx2v/);assert.match(calls[0].values.vae_name,/x2_fp32/);
    const oldUpscale=p.states["shot-1"].upscale!.path, oldMedia=p.states["shot-1"].media!.path;
    p.board!.scenes[0].factor=4;service.edit(p.id,{board:p.board});service.start(p.id,"upscale","shot-1");p=await done(service,p.id);
    assert.equal(p.tasks.at(-1)?.status,"succeeded",p.tasks.at(-1)?.error||"");assert.equal(calls.length,2);assert.match(calls[1].values.unet_name,/x4_int8/);assert.match(calls[1].values.vae_name,/x4_fp32/);
    assert.equal(p.states["shot-1"].media!.path,oldMedia);assert.notEqual(p.states["shot-1"].upscale!.path,oldUpscale);assert.equal(hash(readFileSync(service.file(p.id,oldUpscale))),original);
    assert.equal(hash(readFileSync(service.file(p.id,oldMedia))),original);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("cancellation aborts active workflow without discarding project or publishing incomplete artifacts",async()=>{
  const dir=temporary();try{
    let started!:()=>void;const ready=new Promise<void>(r=>started=r);
    const service=new AutoShorts(dir,apps,async(app,values,signal)=>{started();await new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("canceled")),{once:true}));throw new Error("unreachable");});
    let p=service.create({});p=service.edit(p.id,{board:board()});service.start(p.id,"audio","shot-1");await ready;await service.cancel(p.id);await new Promise(r=>setTimeout(r,20));p=service.get(p.id);assert.equal(p.tasks.at(-1)?.status,"canceled");assert.equal(p.states["shot-1"].audio,undefined);assert.equal(p.board!.title,"Local film");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("llama.cpp endpoint discovery reads --host/--port and refuses non-loopback servers",async()=>{
  assert.equal(llamaEndpoint(["/usr/bin/llama-server","-m","m.gguf","--host","127.0.0.1","--port","57409"]),"http://127.0.0.1:57409/v1");
  assert.equal(llamaEndpoint(["llama-server","--port=8080"]),"http://127.0.0.1:8080/v1");
  assert.equal(llamaEndpoint(["llama-server","--host","localhost","--port","34121"]),"http://localhost:34121/v1");
  assert.equal(llamaEndpoint(["llama-server","--host","0.0.0.0","--port","8080"]),null,"wildcard bind is not a loopback client URL");
  assert.equal(llamaEndpoint(["llama-server","--host","192.168.1.9","--port","8080"]),null);
  assert.equal(llamaEndpoint(["llama-server","--port","99999"]),null);
});

test("AutoShorts LLM requests wait in the same inference queue as ordinary workflow jobs",async()=>{
  const dir=temporary();let requests=0, release!:()=>void;
  const llm=createServer((req,res)=>{requests++;req.resume();res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(board())}}]}));});
  llm.listen(0,"127.0.0.1");await once(llm,"listening");
  try{
    const queue=new InferenceQueue();
    const ordinary=queue.run("Ordinary RiverField job",()=>new Promise<void>(r=>release=r));
    const service=new AutoShorts(dir,apps,async()=>{throw new Error("GPU not invoked");},queue.run);
    const p=service.create({mode:"FAST",llmUrl:`http://127.0.0.1:${(llm.address() as any).port}/v1`});
    service.start(p.id,"plan");await new Promise(r=>setTimeout(r,30));
    assert.equal(requests,0);assert.equal(queue.snapshot().waiting[0]?.label,"llama.cpp storyboard");
    release();await ordinary;const result=await done(service,p.id);
    assert.equal(result.tasks.at(-1)?.status,"succeeded",result.tasks.at(-1)?.error||"");assert.equal(requests,1);
  }finally{release?.();llm.close();await once(llm,"close");rmSync(dir,{recursive:true,force:true});}
});
