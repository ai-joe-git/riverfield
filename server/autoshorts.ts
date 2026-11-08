// Durable composite application. A task checkpoints every artifact; retries never discard source media.
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, realpathSync, copyFileSync, linkSync } from "node:fs";
import { join, resolve, relative, extname, basename, isAbsolute } from "node:path";
import type { App } from "./registry.ts";
import type { Values } from "./runner.ts";
import type { Inference } from "./inference-queue.ts";
import { approximateWords, assemble, captions, command, probe, sourceDimensions, dimensions, type Word } from "./autoshorts-media.ts";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(v=>!["__proto__","constructor","prototype"].includes(v),"Reserved identifier");
const engine = z.string().min(1).max(80);
export const sceneSchema = z.object({
  id, order:z.number().int().min(0), duration:z.number().min(1).max(60), narration:z.string().max(5000),
  visual:z.string().max(6000), prompt:z.string().min(1).max(12000), engine:engine.default("z-image"),
  method:z.enum(["image","video","import"]).default("image"), references:z.array(z.string()).max(12).default([]),
  instructions:z.string().max(2000).default(""), params:z.record(z.string(),z.unknown()).default({}),
  profile:z.enum(["auto","native","x2","x4","custom"]).default("auto"), megapixels:z.number().min(.1).max(2).default(.4),
  factor:z.union([z.literal(1),z.literal(2),z.literal(4)]).default(2), trim:z.number().min(0).max(3600).default(0),
  keepAudio:z.boolean().default(false), decision:z.enum(["pending","accepted","regenerate"]).default("pending"),
});
export const boardSchema = z.object({title:z.string().min(1).max(200), hook:z.string().max(2000), narration:z.string().max(30000),
  closing:z.string().max(2000), music:z.string().max(3000).default(""), scenes:z.array(sceneSchema).min(1).max(40)}).superRefine((b,ctx)=>{
  if(new Set(b.scenes.map(s=>s.id)).size!==b.scenes.length) ctx.addIssue({code:"custom",message:"Scene IDs must be unique"});
  if(new Set(b.scenes.map(s=>s.order)).size!==b.scenes.length) ctx.addIssue({code:"custom",message:"Scene ordering must be unique"});
  if(b.scenes.reduce((n,s)=>n+s.duration,0)>600) ctx.addIssue({code:"custom",message:"Maximum production duration is 600 seconds"});
});
/** llama-server arguments → an OpenAI base URL, but only for loopback servers. */
export function llamaEndpoint(argv:string[]):string|null {
  const flags=(name:string)=>{const inline=argv.find(a=>a.startsWith(`${name}=`));if(inline)return inline.slice(name.length+1);const at=argv.lastIndexOf(name);return at>=0&&at+1<argv.length?argv[at+1]:undefined;};
  const host=flags("--host")||"127.0.0.1";const port=Number(flags("--port")||8080);
  if(!["127.0.0.1","localhost","::1"].includes(host))return null;
  if(!Number.isInteger(port)||port<1||port>65535)return null;
  return `http://${host.includes(":")?`[${host}]`:host}:${port}/v1`;
}

export const configSchema = z.object({
  topic:z.string().max(30000).default(""), language:z.string().max(60).default("fr"), duration:z.number().min(3).max(600).default(30),
  mode:z.enum(["FAST","HYBRID","CINEMA"]).default("HYBRID"), aspect:z.enum(["9:16","16:9","1:1"]).default("9:16"),
  height:z.union([z.literal(720),z.literal(1080),z.literal(1280),z.literal(1920)]).default(1920), fps:z.number().int().min(12).max(60).default(24),
  llmUrl:z.string().default("http://127.0.0.1:8080/v1"), model:z.string().max(200).default(""),
  system:z.string().max(12000).default("You are a short-film director. Produce an engaging hook, specific visuals, concise spoken narration, and a strong ending. Return JSON only."),
  temperature:z.number().min(0).max(2).default(.7), videoEngine:engine.default("h3-video-turbo"), imageEngine:engine.default("z-image"),
  tts:engine.default("tts"), voice:z.string().max(200).default(""), voiceTags:z.array(z.string()).max(12).default(["female"]),
  speechParams:z.record(z.string(),z.unknown()).default({}),
  profile:z.enum(["auto","native","x2","x4","custom"]).default("x2"), megapixels:z.number().min(.1).max(2).default(.4),
  factor:z.union([z.literal(1),z.literal(2),z.literal(4)]).default(2), autoAccept:z.boolean().default(false),
  subtitles:z.enum(["none","srt","burn","karaoke"]).default("burn"), subtitleText:z.string().max(60000).default(""),
  alignUrl:z.string().default(""), visionUrl:z.string().default(""), visionModel:z.string().max(200).default(""),
  fit:z.enum(["crop","contain"]).default("crop"), transition:z.number().min(0).max(1).default(.2),
  music:z.string().default(""), musicEngine:engine.default("music-yue2"), musicPrompt:z.string().max(5000).default(""),
  musicVolume:z.number().min(0).max(1).default(.12),
});
type Config = z.infer<typeof configSchema>;
type Scene = z.infer<typeof sceneSchema>;
export type Artifact = { key:string; path:string; job?:string; seconds:number; modelLoading:number|null; duration?:number; words?:Word[]; alignment?:string; alignmentKey?:string; inputHash?:string; resolution?:{mp:number;factor:number;width:number;height:number} };
type SceneState = { media?:Artifact; audio?:Artifact; upscale?:Artifact; evaluation?:unknown; };
type Task = { id:string; action:string; scene?:string; status:"queued"|"running"|"succeeded"|"failed"|"canceled"|"interrupted"; started:string; finished?:string; error?:string; operation?:string; child?:string; dependency?:string; queue?:number|null; progress?:unknown };
export type Project = { id:string; title:string; created:string; updated:string; revision:number; config:Config; board?:z.infer<typeof boardSchema>; states:Record<string,SceneState>; tasks:Task[]; exports:{path:string;srt:string;key:string;seconds:number;created:string}[]; music?:Artifact };
export type Execute = (app:App, values:Values, signal:AbortSignal, update:(v:Partial<Task>)=>void, resume?:string)=>Promise<{path:string;job:string;seconds:number;modelLoading:number|null}>;
export const hash = (x:unknown) => createHash("sha256").update(x instanceof Uint8Array ? x : JSON.stringify(x)).digest("hex").slice(0,24);
export function localURL(value:string) {
  const u = new URL(value);
  if(!["http:","https:"].includes(u.protocol) || !["127.0.0.1","localhost","[::1]"].includes(u.hostname) || u.username || u.password) throw new Error("Only loopback local inference URLs are allowed");
  return u.href.replace(/\/$/,"");
}
export function contained(root:string, file:string) {
  const base=realpathSync(root), path=realpathSync(resolve(root,file)), rel=relative(base,path);
  if(rel.startsWith("..") || isAbsolute(rel)) throw new Error("File outside project/output root");
  return path;
}
function retain(source:string,target:string){
  if(existsSync(target))return;
  try{linkSync(source,target);}catch(e){if(["EXDEV","EPERM","ENOTSUP"].includes((e as NodeJS.ErrnoException).code||""))copyFileSync(source,target);else throw e;}
}
export function resolution(app:App, profile:string, mp:number, factor:number, aspect:string) {
  const field=app.inputs.find(i=>i.id==="resolution" || i.id==="megapixels");
  const value=profile==="x4"?.2:profile==="x2"?.4:profile==="native"?Number(field?.default||.8):mp;
  if(field) {
    if(field.options && !field.options.some(o=>o.value===value)) throw new Error(`${app.name}: ${value} MP unsupported; choose ${field.options.map(o=>o.value).join(", ")} MP or another engine`);
    if((field.min!==undefined && value<field.min)||(field.max!==undefined && value>field.max)) throw new Error(`${app.name}: ${value} MP outside ${field.min}–${field.max}; no range was silently extended`);
  }
  return { mp:value, factor:profile==="native"?1:profile==="x4"?4:profile==="x2"?2:factor, ...sourceDimensions(value,aspect) };
}

export class AutoShorts {
  root:string; apps:Map<string,App>; execute:Execute;
  private inference:Inference;
  private queue:{p:string;t:string}[]=[]; private active?:{controller:AbortController;p:string;t:string};
  constructor(root:string, apps:App[], execute:Execute, inference:Inference=(_label,work)=>work()) {
    this.root=resolve(root); mkdirSync(this.root,{recursive:true}); this.apps=new Map(apps.map(a=>[a.id,a])); this.execute=execute;
    this.inference=inference;
    for(const p of this.list()) { let changed=false; for(const t of p.tasks) if(["running","queued"].includes(t.status)){t.status="interrupted";t.error="Server restarted. Resume this task; completed artifacts are retained.";changed=true;} if(changed)this.save(p); }
  }
  directory(pid:string) { id.parse(pid); return join(this.root,pid); }
  list():Project[] { return readdirSync(this.root).filter(n=>/^[\w-]+$/.test(n)&&existsSync(join(this.root,n,"project.json"))).map(n=>this.get(n)).sort((a,b)=>b.updated.localeCompare(a.updated)); }
  get(pid:string):Project { return JSON.parse(readFileSync(join(this.directory(pid),"project.json"),"utf8")); }
  describe(pid:string) { return {...this.get(pid), directory:resolve(this.directory(pid)), assets:readdirSync(join(this.directory(pid),"assets")).map(n=>`assets/${n}`)}; }
  save(p:Project) { p.updated=new Date().toISOString(); const dir=this.directory(p.id); writeFileSync(join(dir,"project.json.tmp"),JSON.stringify(p,null,2));renameSync(join(dir,"project.json.tmp"),join(dir,"project.json")); if(p.board){writeFileSync(join(dir,"storyboard.json.tmp"),JSON.stringify(p.board,null,2));renameSync(join(dir,"storyboard.json.tmp"),join(dir,"storyboard.json"));} }
  create(raw:unknown) {
    const config=configSchema.parse(raw); localURL(config.llmUrl); if(config.alignUrl)localURL(config.alignUrl);if(config.visionUrl)localURL(config.visionUrl);
    const p:Project={id:randomUUID(),title:config.topic.slice(0,80)||"Untitled production",created:new Date().toISOString(),updated:"",revision:0,config,states:{},tasks:[],exports:[]};
    for(const d of ["scenes","audio","subtitles","upscaled","exports","assets"])mkdirSync(join(this.directory(p.id),d),{recursive:true});
    this.save(p);return p;
  }
  edit(pid:string, raw:{config?:unknown;board?:unknown}) {
    const p=this.get(pid); if(this.active?.p===pid||p.tasks.some(t=>["running","queued"].includes(t.status)))throw new Error("Cancel active/queued production and wait for it to stop before editing");
    if(raw.config)p.config=configSchema.parse(raw.config);
    localURL(p.config.llmUrl);if(p.config.alignUrl)localURL(p.config.alignUrl);if(p.config.visionUrl)localURL(p.config.visionUrl);
    if(raw.board){p.board=boardSchema.parse(raw.board);p.title=p.board.title;}
    else if(!p.board)p.title=p.config.topic.slice(0,80)||"Untitled production";
    p.revision++;this.save(p);return p;
  }
  file(pid:string,file:string) { return contained(this.directory(pid),file); }
  import(pid:string,bytes:Uint8Array,name:string) {
    if(bytes.length>500*2**20)throw new Error("500 MB import limit");
    const ext=extname(name).toLowerCase();if(![".mp4",".mov",".webm",".mkv",".png",".jpg",".jpeg",".webp",".wav",".mp3",".flac",".ogg",".m4a"].includes(ext))throw new Error("Unsupported media file");
    const file=`assets/${hash(bytes)}${ext}`;writeFileSync(join(this.directory(pid),file),bytes);return file;
  }
  importPath(pid:string,path:string,allowedRoot:string) {const f=contained(allowedRoot,path);return this.import(pid,readFileSync(f),basename(f));}
  capabilities(){return [...this.apps.values()].filter(a=>a.status==="ready"&&!a.pipeline).map(a=>({id:a.id,name:a.name,inputs:a.inputs,outputs:a.outputs}));}
  /** Find llama.cpp servers already running on this machine, including launchers that pick a random port. */
  async llmServers():Promise<{url:string;models:string[]}[]> {
    const urls=new Set<string>();
    for(const pid of readdirSync("/proc")){
      if(!/^\d+$/.test(pid))continue;
      try{
        const raw=readFileSync(`/proc/${pid}/cmdline`,"utf8");if(!raw.includes("llama-server"))continue;
        const argv=raw.split("\0").filter(Boolean);if(!argv.some(a=>basename(a).startsWith("llama-server")))continue;
        const url=llamaEndpoint(argv);if(url)urls.add(url);
      }catch{/* process ended while we were reading it */ }
    }
    const live:{url:string;models:string[]}[]=[];
    await Promise.all([...urls].map(async url=>{
      try{
        const r=await fetch(`${url}/models`,{signal:AbortSignal.timeout(2500),redirect:"error"});if(!r.ok)return;
        const data=await r.json() as any;
        live.push({url,models:(data.data||data.models||[]).map((m:any)=>m.id||m.model).filter((m:unknown):m is string=>typeof m==="string")});
      }catch{/* listed but not answering: not a usable endpoint */ }
    }));
    return live.sort((a,b)=>a.url.localeCompare(b.url));
  }
  schemas(){return {config:z.toJSONSchema(configSchema),storyboard:z.toJSONSchema(boardSchema)};}
  start(pid:string,action:string,scene?:string,force=false) {
    if(!["plan","produce","media","audio","align","upscale","evaluate","render","music"].includes(action))throw new Error("Unknown production action");
    const p=this.get(pid);if(this.active?.p===pid||p.tasks.some(t=>["running","queued"].includes(t.status)))throw new Error("This project already has an active task (wait for cancellation to finish)");
    if(scene && !p.board?.scenes.some(s=>s.id===scene))throw new Error("Unknown scene");
    if(["media","audio","align","upscale","evaluate"].includes(action)&&!scene)throw new Error("Choose a scene");
    if(force&&scene){const s=p.board!.scenes.find(s=>s.id===scene)!;p.states[scene]??={};if(action==="audio")p.states[scene].audio=undefined;if(action==="upscale")p.states[scene].upscale=undefined;if(action==="media"){s.decision="regenerate";s.params.seed=Math.floor(Math.random()*2**48);}}
    const t:Task={id:randomUUID(),action,scene,status:"queued",started:new Date().toISOString()};p.tasks.push(t);this.save(p);this.queue.push({p:pid,t:t.id});void this.drain();return t;
  }
  async cancel(pid:string) { const p=this.get(pid);for(const t of p.tasks)if(t.status==="queued"||t.status==="running")t.status="canceled";this.save(p);this.queue=this.queue.filter(q=>q.p!==pid);if(this.active?.p===pid)this.active.controller.abort();return this.get(pid); }
  private async drain(){if(this.active)return;const next=this.queue.shift();if(!next)return;const controller=new AbortController();this.active={controller,...next};
    let p=this.get(next.p), t=p.tasks.find(t=>t.id===next.t)!;t.status="running";this.save(p);
    const update=(v:Partial<Task>)=>{Object.assign(t,v);this.save(p);};
    try{await this.run(p,t,controller.signal,update);controller.signal.throwIfAborted();t.status="succeeded";}catch(e){t.status=controller.signal.aborted?"canceled":"failed";t.error=(e as Error).message;}finally{t.finished=new Date().toISOString();this.save(p);this.active=undefined;void this.drain();}
  }
  private app(name:string){const a=this.apps.get(name);if(!a?.workflowPath||a.status!=="ready")throw new Error(`Workflow ${name} is unavailable`);return a;}
  private mediaHash(p:Project,s:Scene) {
    if(s.method==="import")return hash(s.references);
    const profile=s.profile==="auto"?p.config.profile:s.profile;
    const source=profile==="custom"?(s.profile==="custom"?s.megapixels:p.config.megapixels):profile;
    return hash([s.prompt,s.engine,s.method,s.params,s.references,source,p.config.aspect]);
  }
  private factor(p:Project,s:Scene) {
    const profile=s.profile==="auto"?p.config.profile:s.profile;
    return profile==="native"?1:profile==="x4"?4:profile==="x2"?2:profile==="custom"?(s.profile==="custom"?s.factor:p.config.factor):(p.states[s.id]?.media?.resolution?.factor||2);
  }
  private async generated(p:Project,t:Task,app:App,values:Values,folder:string,key:string,signal:AbortSignal,update:(v:Partial<Task>)=>void):Promise<Artifact>{
    // Reuse an interrupted child's durable history job, rather than starting another expensive inference.
    update({dependency:key,child:undefined,queue:null,progress:null});
    const prior=[...p.tasks].reverse().find(old=>old.id!==t.id&&old.scene===t.scene&&old.action===t.action&&old.child&&old.dependency===key&&old.operation===t.operation&&old.status==="interrupted");
    const result=await this.execute(app,values,signal,update,prior?.child);signal.throwIfAborted();
    const path=`${folder}/${key}-${hash(result.job)}${extname(result.path)}`;retain(result.path,join(this.directory(p.id),path));return {...result,path,key};
  }
  private async plan(p:Project,signal:AbortSignal){
    const c=p.config, url=localURL(c.llmUrl);
    const methods=c.mode==="FAST"?"Only image or import scenes; no video diffusion.":c.mode==="HYBRID"?"Mostly images; at most one third of scenes may use video diffusion.":"Original video scenes using the available video engines.";
    const available=[c.imageEngine,c.videoEngine];available.forEach(a=>this.app(a));
    const schema={type:"object",properties:{title:{type:"string"},hook:{type:"string"},narration:{type:"string"},closing:{type:"string"},music:{type:"string"},scenes:{type:"array",items:{type:"object",properties:{id:{type:"string"},order:{type:"integer"},duration:{type:"number"},narration:{type:"string"},visual:{type:"string"},prompt:{type:"string"},engine:{type:"string",enum:available},method:{type:"string",enum:["image","video"]},references:{type:"array",items:{type:"string"}},instructions:{type:"string"}},required:["id","order","duration","narration","visual","prompt","engine","method","references","instructions"],additionalProperties:false}}},required:["title","hook","narration","closing","music","scenes"],additionalProperties:false};
    const messages:any[]=[{role:"system",content:c.system},{role:"user",content:`Topic/script: ${c.topic}\nLanguage ${c.language}, aspect ${c.aspect}, target ${c.duration} seconds. ${methods} Available engines: ${JSON.stringify(available.map(a=>({id:a,inputs:this.app(a).inputs.filter(i=>["duration","resolution","megapixels"].includes(i.id))})))}. Use stable scene IDs, no references unless provided. Every scene's narration must be spoken in the requested language. Include hook and closing in scene narration. Return the storyboard JSON.`}];
    for(let attempt=0;attempt<3;attempt++){
      const r=await fetch(`${url}/chat/completions`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:c.model||undefined,messages,temperature:c.temperature,response_format:{type:"json_schema",json_schema:{name:"storyboard",strict:true,schema}}}),signal:AbortSignal.timeout(180000),redirect:"error"})
        .catch(e=>{signal.throwIfAborted();throw new Error(`Cannot reach local llama.cpp at ${url}: ${e.message}. Start llama-server with the selected model, or import a storyboard manually.`);});
      if(!r.ok)throw new Error(`Local llama.cpp ${r.status}: ${(await r.text()).slice(0,1000)}. Enable /v1/chat/completions with JSON schema support.`);
      const data=await r.json() as any, content=data.choices?.[0]?.message?.content;
      signal.throwIfAborted();
      try{const board=boardSchema.parse(JSON.parse(content)); for(const s of board.scenes){if(!available.includes(s.engine))throw new Error("Engine not permitted");if(c.mode==="FAST"&&s.method==="video")throw new Error("FAST must not use video diffusion");if(c.mode==="CINEMA"&&s.method!=="video")throw new Error("CINEMA plans must generate original video scenes");if(s.method==="video"&&s.engine!==c.videoEngine)throw new Error("Video scenes must use the video engine");if(s.method==="image"&&s.engine!==c.imageEngine)throw new Error("Image scenes must use the image engine");}if(c.mode==="HYBRID"&&board.scenes.filter(s=>s.method==="video").length>Math.ceil(board.scenes.length/3))throw new Error("HYBRID must use at most one third video scenes");p.board=board;p.title=board.title;return;}
      catch(e){messages.push({role:"assistant",content:content||""},{role:"user",content:`Repair the JSON to satisfy the schema: ${String(e).slice(0,2000)}`});}
    }throw new Error("Local LLM failed storyboard validation after 3 attempts; edit/import a storyboard manually.");
  }
  private profile(p:Project,s:Scene,app:App){let profile=s.profile==="auto"?p.config.profile:s.profile;
    if(profile==="auto"){
      const rows=this.list().filter(old=>old.config.aspect===p.config.aspect).flatMap(old=>old.board?.scenes.flatMap(scene=>{const state=old.states[scene.id],r=state?.media?.resolution;if(!r||scene.decision!=="accepted"||scene.engine!==s.engine||Math.abs(scene.duration-s.duration)>s.duration*.2|| (r.factor!==1&&!state.upscale))return [];return [{mp:r.mp,factor:r.factor,seconds:state.media!.seconds+(state.upscale?.seconds||0)}];})||[]);
      const measured=rows.sort((a,b)=>a.seconds-b.seconds)[0];
      if(measured)return resolution(app,"custom",measured.mp,measured.factor,p.config.aspect);
      profile="x2";
    }
    return resolution(app,profile,s.profile==="custom"?s.megapixels:p.config.megapixels,s.profile==="custom"?s.factor:p.config.factor,p.config.aspect);
  }
  private async audio(p:Project,s:Scene,t:Task,signal:AbortSignal,update:(v:Partial<Task>)=>void){
    const state=p.states[s.id]??={}, c=p.config, key=hash([s.narration,c.tts,c.voice,c.voiceTags,c.language,c.speechParams]);
    if(state.audio?.key===key&&existsSync(join(this.directory(p.id),state.audio.path)))return this.align(p,s,signal,update);
    update({operation:`Narration · ${s.id}`,scene:s.id});
    if(!s.narration.trim()){
      const path=`audio/${key}.wav`;await command("ffmpeg",["-y","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-t",String(s.duration),join(this.directory(p.id),path)],signal);state.audio={path,key,seconds:0,modelLoading:null,duration:s.duration,words:[],alignment:"no narration"};
    }else{
      const app=this.app(c.tts);if(!["tts","tts-clone","tts-omni","tts-omni-clone"].includes(app.id))throw new Error("Choose a supported local TTS workflow");
      const values:Values={...c.speechParams,text:s.narration};if(app.inputs.some(i=>i.id==="language"))values.language=c.language;
      if(app.inputs.some(i=>i.id==="voice"&&i.type==="select"))values.voice=c.voiceTags;
      const voice=app.inputs.find(i=>i.id==="voice"&&i.type==="audio");if(voice){if(!c.voice)throw new Error("Import a voice reference for cloned narration");values.voice={bytes:readFileSync(this.file(p.id,c.voice)),name:basename(c.voice)};}
      state.audio=await this.generated(p,t,app,values,"audio",key,signal,update);
      const meta=await probe(this.file(p.id,state.audio.path),signal);
      if(!Number.isFinite(meta.duration)||meta.duration<=0)throw new Error(`${s.id}: ffprobe could not measure the generated narration duration`);
      state.audio.duration=meta.duration;
      state.audio.words=approximateWords(s.narration,meta.duration);state.audio.alignment="approximate (text distributed over actual audio duration)";
    }state.audio!.inputHash=key;this.save(p);await this.align(p,s,signal,update);
  }
  private async align(p:Project,s:Scene,signal:AbortSignal,update:(v:Partial<Task>)=>void){
    const audio=p.states[s.id]?.audio,c=p.config;if(!audio)throw new Error(`${s.id}: generate narration first`);
    const key=hash([audio.key,c.alignUrl]);if(audio.alignmentKey===key)return;
    update({operation:`Caption timing · ${s.id}`,scene:s.id});
    audio.words=approximateWords(s.narration,audio.duration||s.duration);audio.alignment=s.narration?"approximate (text distributed over actual audio duration)":"no narration";
    if(c.alignUrl&&s.narration){try{await this.inference("Local speech alignment",async()=>{
        const form=new FormData();form.set("file",new Blob([readFileSync(this.file(p.id,audio.path))]),basename(audio.path));form.set("model","whisper-1");form.set("response_format","verbose_json");form.append("timestamp_granularities[]","word");
        const res=await fetch(`${localURL(c.alignUrl)}/audio/transcriptions`,{method:"POST",body:form,signal:AbortSignal.timeout(120000),redirect:"error"});if(!res.ok)throw new Error(`alignment ${res.status}`);
        const words=z.array(z.object({word:z.string(),start:z.number().nonnegative(),end:z.number().nonnegative()})).min(1).parse((await res.json() as any).words);
        if(words.some((w,i)=>w.end<w.start||w.end>(audio.duration||s.duration)+1||(i>0&&w.start<words[i-1].start)))throw new Error("Invalid alignment timing");signal.throwIfAborted();audio.words=words;audio.alignment="local word transcription (not forced alignment)";
      },signal,position=>update({queue:position}));
      }catch(e){signal.throwIfAborted();audio.alignment+=`; local aligner unavailable: ${(e as Error).message}`;}}
    audio.alignmentKey=key;
    writeFileSync(join(this.directory(p.id),"subtitles",`${s.id}-${key}.json`),JSON.stringify({words:audio.words,method:audio.alignment},null,2));this.save(p);
  }
  private async media(p:Project,s:Scene,t:Task,signal:AbortSignal,update:(v:Partial<Task>)=>void){
    const state=p.states[s.id]??={}, c=p.config;
    update({operation:`Scene media · ${s.id}`,scene:s.id});
    if(s.method==="import"){
      if(!s.references[0])throw new Error(`${s.id}: import a picture/video and set its reference path`);
      const path=s.references[0];this.file(p.id,path);const key=hash([path]);if(state.media?.key!==key)state.upscale=undefined;state.media={key,path,seconds:0,modelLoading:null,inputHash:this.mediaHash(p,s)};this.save(p);return;
    }
    if(c.mode==="FAST"&&s.method==="video")throw new Error("FAST mode avoids video diffusion; select image/import");
    const app=this.app(s.engine);if(!app.outputs.some(o=>o.type===s.method))throw new Error(`${s.engine} does not generate ${s.method} outputs`);
    if(s.engine==="h3-r2v-flex"&&!s.references.length)throw new Error("H3 Ref2VA needs a reference image/video; import a reference, or use H3 Turbo/Pika fl2va for text-to-video");
    const profile=s.method==="video"?this.profile(p,s,app):null;
    const values:Values={...s.params,seed:s.params.seed??42};
    const promptField=app.inputs.find(i=>["prompt","global_prompt"].includes(i.id));if(!promptField)throw new Error(`${app.name}: no supported prompt input`);values[promptField.id]=s.prompt;
    const aspect=app.inputs.find(i=>i.id==="aspect");if(aspect){const option=aspect.options?.find(o=>String(o.value).startsWith(c.aspect));if(!option)throw new Error(`${app.name}: aspect ${c.aspect} unsupported`);values.aspect=option.value;}
    if(s.method==="image"&&!aspect&&values.width===undefined&&values.height===undefined){
      const widths=app.inputs.find(i=>i.id==="width")?.options?.map(o=>Number(o.value)).filter(Number.isFinite),heights=app.inputs.find(i=>i.id==="height")?.options?.map(o=>Number(o.value)).filter(Number.isFinite);
      if(widths?.length&&heights?.length){const ratio=c.aspect==="9:16"?9/16:c.aspect==="1:1"?1:16/9;
        const best=widths.flatMap(width=>heights.map(height=>({width,height,score:4*Math.abs(Math.log(width/height/ratio))+Math.abs(Math.log(width*height/1e6))}))).sort((a,b)=>a.score-b.score)[0];values.width=best.width;values.height=best.height;}
    }
    if(profile){const field=app.inputs.find(i=>["resolution","megapixels"].includes(i.id));if(field)values[field.id]=profile.mp;}
    if(app.inputs.some(i=>i.id==="duration")) values.duration=Math.max(s.duration, state.audio?.duration||0);
    if(app.id==="pika-studio-director")values.flex_mode=s.references.length?"ref2va":"fl2va";
    if(app.inputs.some(i=>i.id==="segment_count"))values.segment_count=1;
    const slots=app.inputs.filter(i=>["image","video","audio"].includes(i.type));
    s.references.forEach(ref=>{const ext=extname(ref).toLowerCase(),type=[".png",".jpg",".jpeg",".webp"].includes(ext)?"image":[".mp4",".mov",".webm",".mkv"].includes(ext)?"video":"audio";
      const slot=slots.find(i=>i.type===type&&values[i.id]===undefined);if(!slot)throw new Error(`${app.name}: no free ${type} reference input`);values[slot.id]={bytes:readFileSync(this.file(p.id,ref)),name:basename(ref)};});
    const key=hash([s.engine,s.prompt,s.references,s.params,profile,c.aspect,values.duration]);
    const inputHash=this.mediaHash(p,s);
    if(state.media?.key===key&&s.decision!=="regenerate"&&existsSync(join(this.directory(p.id),state.media.path))){state.media.inputHash=inputHash;this.save(p);return;}
    state.media=await this.generated(p,t,app,values,"scenes",key,signal,update);
    if(profile){const actual=await probe(this.file(p.id,state.media.path),signal);state.media.resolution={...profile,width:actual.width,height:actual.height};}
    state.media.inputHash=inputHash;state.upscale=undefined;s.decision=c.autoAccept?"accepted":"pending";this.save(p);
  }
  private async upscale(p:Project,s:Scene,t:Task,signal:AbortSignal,update:(v:Partial<Task>)=>void){
    const state=p.states[s.id];if(!state?.media)throw new Error("Generate/import scene media first");
    if(s.decision!=="accepted")throw new Error(`${s.id}: review and accept this scene before spending upscale compute`);
    if(s.method!=="video"&&s.method!=="import")return;
    if(state.media.inputHash!==this.mediaHash(p,s))throw new Error(`${s.id}: source settings changed; generate/reselect the media first`);
    const f=this.factor(p,s);
    if(f===1)return;const file=this.file(p.id,state.media.path);if(![".mp4",".mov",".webm",".mkv"].includes(extname(file)))return;
    const key=hash([state.media.key,f]), app=this.app("relayvsr-upscale");if(state.upscale?.key===key&&existsSync(join(this.directory(p.id),state.upscale.path)))return;
    update({operation:`RelayVSR x${f} · ${s.id}`,scene:s.id});
    state.upscale=await this.generated(p,t,app,{video:{bytes:readFileSync(file),name:basename(file)},unet_name:f===2?"relayvsr_x2_lightx2v_int8_convrot.safetensors":"relayvsr_x4_int8_convrot.safetensors",vae_name:`relayvsr_flash_vae_x${f}_fp32.safetensors`,detail:1,seed:42},"upscaled",key,signal,update);this.save(p);
  }
  private async render(p:Project,signal:AbortSignal,update:(v:Partial<Task>)=>void){
    const board=p.board!;const c=p.config, scenes=[...board.scenes].sort((a,b)=>a.order-b.order), editing=[];let offset=0;const words:Word[]=[];
    for(const s of scenes){const state=p.states[s.id];if(!state?.media||!state.audio)throw new Error(`${s.id}: missing media or narration`);if(s.decision!=="accepted")throw new Error(`${s.id}: review and accept media before export`);
      if(state.audio.inputHash!==hash([s.narration,c.tts,c.voice,c.voiceTags,c.language,c.speechParams]))throw new Error(`${s.id}: narration settings changed; regenerate narration before export`);
      await this.align(p,s,signal,update);
      if(state.media.inputHash!==this.mediaHash(p,s))throw new Error(`${s.id}: scene settings changed; regenerate/reselect media before export`);
      const video=[".mp4",".mov",".webm",".mkv"].includes(extname(state.media.path)),factor=this.factor(p,s);
      if(video&&factor!==1&&state.upscale?.key!==hash([state.media.key,factor]))throw new Error(`${s.id}: selected RelayVSR profile has not been rendered; upscale the accepted scene first`);
      const file=this.file(p.id,video&&factor!==1?state.upscale!.path:state.media.path), meta=await probe(file,signal), duration=Math.max(s.duration,state.audio.duration||0);
      editing.push({media:file,image:[".png",".jpg",".jpeg",".webp"].includes(extname(file)),audio:this.file(p.id,state.audio.path),duration,trim:s.trim,keepAudio:s.keepAudio&&meta.audio});
      words.push(...(state.audio.words||[]).map(w=>({...w,start:w.start+offset,end:w.end+offset})));offset+=duration;
    }
    const key=hash([editing,words,c.subtitles,c.subtitleText,c.fit,c.height,c.aspect,c.fps,c.transition,c.music,c.musicVolume,p.music?.key]);
    const cached=p.exports.find(e=>e.key===key&&existsSync(join(this.directory(p.id),e.path)));if(cached)return;
    const folder=`exports/${key}`,dir=join(this.directory(p.id),folder);mkdirSync(dir,{recursive:true});const size=dimensions(c.aspect,c.height);
    const text=c.subtitleText?approximateWords(c.subtitleText,offset):words, subs=captions(text,c.subtitles==="karaoke",size.width,size.height);
    writeFileSync(join(dir,"captions.srt"),subs.srt);writeFileSync(join(dir,"captions.ass"),subs.ass);
    update({operation:"FFmpeg · normalize, Ken Burns, fades, mix, captions, H.264"});const started=Date.now();
    await assemble(dir,editing,{aspect:c.aspect,height:c.height,fps:c.fps,fit:c.fit,transition:c.transition,burn:["burn","karaoke"].includes(c.subtitles),music:c.music?this.file(p.id,c.music):p.music?this.file(p.id,p.music.path):undefined,musicVolume:c.musicVolume},signal);
    p.exports.push({path:`${folder}/final.mp4`,srt:`${folder}/captions.srt`,key,seconds:(Date.now()-started)/1000,created:new Date().toISOString()});this.save(p);
  }
  private async run(p:Project,t:Task,signal:AbortSignal,update:(v:Partial<Task>)=>void){
    if(t.action==="plan"){update({operation:"Local llama.cpp · validated storyboard"});await this.inference("llama.cpp storyboard",()=>this.plan(p,signal),signal,position=>update({queue:position}));this.save(p);return;}
    if(t.action==="produce"&&!p.board){await this.inference("llama.cpp storyboard",()=>this.plan(p,signal),signal,position=>update({queue:position}));this.save(p);}
    if(!p.board)throw new Error("Generate or save a storyboard first");
    if(t.action==="render")return this.render(p,signal,update);
    if(t.action==="music"){
      const c=p.config,app=this.app(c.musicEngine);if(!["music-yue2","music","music-turbo","music-turbo-hq"].includes(app.id))throw new Error("Unsupported music engine");
      const key=hash([c.musicEngine,c.musicPrompt,c.duration]);if(p.music?.key===key)return;update({operation:"Optional local music"});
      const v:Values={seed:42};for(const i of app.inputs){if(["style","prompt"].includes(i.id))v[i.id]=c.musicPrompt||p.board.music;if(i.id==="lyrics")v.lyrics="[Instrumental]";if(i.id==="seconds")v.seconds=Math.max(Number(i.min||10),Math.min(Number(i.max||360),c.duration));}
      p.music=await this.generated(p,t,app,v,"audio",key,signal,update);this.save(p);return;
    }
    for(const s of [...p.board.scenes].sort((a,b)=>a.order-b.order)){
      if(t.scene&&t.action!=="produce"&&s.id!==t.scene)continue;signal.throwIfAborted();p.states[s.id]??={};
      if(t.action==="produce"||t.action==="audio")await this.audio(p,s,t,signal,update);
      if(t.action==="align"){if(p.states[s.id].audio)p.states[s.id].audio!.alignmentKey=undefined;await this.align(p,s,signal,update);}
      if(t.action==="produce"||t.action==="media")await this.media(p,s,t,signal,update);
      if(t.action==="produce"||t.action==="upscale"){
        if(p.config.autoAccept&&t.action==="produce")s.decision="accepted";
        if(s.decision==="accepted")await this.upscale(p,s,t,signal,update);
        else if(t.action==="upscale")throw new Error("Accept the scene before upscaling");
      }
      if(t.action==="evaluate"){
        if(!p.config.visionUrl)throw new Error("No local vision model configured; review this scene manually");
        const state=p.states[s.id];if(!state.media)throw new Error("No media to review");update({operation:`Local vision review · ${s.id}`});
        const frame=join(this.directory(p.id),"scenes",`${s.id}-review.jpg`);await command("ffmpeg",["-y","-i",this.file(p.id,state.media.path),"-frames:v","1","-vf","scale=640:-2",frame],signal);
        await this.inference("Local vision review",async()=>{
          const r=await fetch(`${localURL(p.config.visionUrl)}/chat/completions`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:p.config.visionModel||undefined,messages:[{role:"user",content:[{type:"text",text:`Review fidelity, artifacts and composition for: ${s.visual}. This is only a single frame, not a temporal evaluation. Do not automatically accept the scene.`},{type:"image_url",image_url:{url:`data:image/jpeg;base64,${readFileSync(frame).toString("base64")}`}}]}],max_tokens:500}),signal:AbortSignal.timeout(120000),redirect:"error"});
          if(!r.ok)throw new Error(`Local vision model returned ${r.status}; manual review remains available`);state.evaluation=(await r.json() as any).choices?.[0]?.message?.content;signal.throwIfAborted();this.save(p);
        },signal,position=>update({queue:position}));
      }
    }
    if(t.action==="produce"&&p.board.scenes.every(s=>s.decision==="accepted"))await this.render(p,signal,update);
  }
}
