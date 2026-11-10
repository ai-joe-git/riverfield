import {mkdirSync,existsSync,readFileSync,realpathSync,statSync,readdirSync,openSync,readSync,closeSync} from "node:fs";
import {join,dirname,basename,isAbsolute,delimiter} from "node:path";
import {homedir} from "node:os";
import {createServer} from "node:net";
import {spawn,execFile,type ChildProcess} from "node:child_process";
import {promisify} from "node:util";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {atomic,identifier} from "./agent-store.ts";
import {optionsSchema,defaults,nativeOptions,buildNativeArgs,supportedFlags} from "./native-options.ts";
import {ggufMetadata} from "./gguf.ts";

const exec=promisify(execFile);
const profileSchema=z.strictObject({id:z.string().optional(),name:z.string().min(1).max(100),executable:z.string().min(1).max(4096),modelPath:z.string().min(1).max(4096),options:optionsSchema.default({}),extraArgs:z.array(z.string()).max(256).default([])});
export type NativeProfile=z.infer<typeof profileSchema>&{id:string};
const pause=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{signal?.throwIfAborted();const timer=setTimeout(done,ms);function done(){signal?.removeEventListener("abort",abort);resolve();}function abort(){clearTimeout(timer);signal?.removeEventListener("abort",abort);reject(signal?.reason);}signal?.addEventListener("abort",abort,{once:true});});
function file(path:string){if(!isAbsolute(path))throw new Error("Use an absolute local path");const actual=realpathSync(path);if(!statSync(actual).isFile())throw new Error("Expected a regular file");return actual;}
export function ggufInfo(path:string){
 const actual=file(path);if(!/\.gguf$/i.test(actual))throw new Error("Choose a GGUF file");
 const fd=openSync(actual,"r");try{const bytes=statSync(actual).size,header=Buffer.alloc(24);if(readSync(fd,header,0,24,0)!==24||header.toString("ascii",0,4)!=="GGUF")throw new Error("Invalid or incomplete GGUF header");const version=header.readUInt32LE(4);if(![2,3].includes(version))throw new Error(`Unsupported GGUF version ${version}`);const tensors=Number(header.readBigUInt64LE(8));if(tensors<1)throw new Error("GGUF contains no tensors");return {path:actual,name:basename(actual),bytes,version,tensors};}finally{closeSync(fd);}
}
function childEnv(executable:string){const env:NodeJS.ProcessEnv={};for(const [key,value] of Object.entries(process.env))if(/^(PATH|HOME|USER|LANG|LC_.*|TMPDIR|SYSTEMROOT|WINDIR|OMP_.*|VK_.*|GGML_.*|HSA_USE_SVM|HSA_ENABLE_SDMA|CUDA_VISIBLE_DEVICES|ROCR_VISIBLE_DEVICES)$/i.test(key))env[key]=value;env.LD_LIBRARY_PATH=[dirname(executable),process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter);return env;}
async function unusedPort(){const server=createServer();await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const port=(server.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));return port;}

/** Owns only children it spawned. No PID adoption, process searches, or external server shutdown. */
export class NativeRuntime {
 readonly dir:string;private child:ChildProcess|null=null;private loaded:NativeProfile|null=null;private signature="";private port=0;private phase="unloaded";private error="";private logs:string[]=[];private helpCache=new Map<string,string>();private loadingController:AbortController|null=null;private effectiveArgs:string[]=[];private effectiveContext:number|null=null;private accessKey="";private helpers=new Set<ChildProcess>();private closed=false;private nativeContexts=new Map<string,number>();
 constructor(dir:string){this.dir=dir;mkdirSync(dir,{recursive:true,mode:0o700});}
 inspect(path:string){return {...ggufInfo(path),...ggufMetadata(path)};}
 profiles():NativeProfile[]{const path=join(this.dir,"profiles.json");return existsSync(path)?JSON.parse(readFileSync(path,"utf8")):[];}
 get(id:string){identifier(id);const profile=this.profiles().find(p=>p.id===id);if(!profile)throw new Error("Unknown native model profile");return profile;}
 status(){return {phase:this.phase,pid:this.child?.pid||null,profile:this.loaded?.id||null,model:this.loaded?.name||null,baseURL:this.port?`http://127.0.0.1:${this.port}/v1`:null,error:this.error,logs:this.logs.slice(-80),effectiveArgs:this.effectiveArgs,effectiveContext:this.effectiveContext,owned:true};}
 cancelLoading(){this.loadingController?.abort(new Error("Native model loading canceled by user"));}
 catalogue(){return {profiles:this.profiles(),fields:nativeOptions,defaults,status:this.status()};}
 async help(executable:string){if(this.closed)throw new Error("Native runtime is closed");const path=file(executable);if(!/^llama-server(?:\.exe)?$/.test(basename(path)))throw new Error("Choose a llama-server executable");const key=`${path}:${statSync(path).mtimeMs}`;let help=this.helpCache.get(key);if(!help){const running=exec(path,["--help"],{timeout:15000,maxBuffer:2*1024**2,env:childEnv(path)});this.helpers.add(running.child);running.child.once("close",()=>this.helpers.delete(running.child));const result=await running;help=result.stdout+result.stderr;if(!help.includes("--model")||!help.includes("--port"))throw new Error("This binary is not a compatible llama-server");this.helpCache.set(key,help);}return help;}
 async save(raw:unknown){const parsed=profileSchema.parse(raw);const id=parsed.id?identifier(parsed.id):randomUUID();const profile:NativeProfile={...parsed,id,executable:file(parsed.executable),modelPath:ggufInfo(parsed.modelPath).path};
  const old=this.profiles().find(p=>p.id===id);if(old&&old.modelPath!==profile.modelPath)throw new Error("Create a new profile for a different GGUF; projector, draft and MTP settings must not leak across models");
  for(const key of ["mmprojPath","draftModelPath"])if(profile.options[key])profile.options[key]=ggufInfo(String(profile.options[key])).path;
  buildNativeArgs(profile.modelPath,`riverfield-${id}`,1,profile.options,await this.help(profile.executable),profile.extraArgs);
  atomic(join(this.dir,"profiles.json"),[...this.profiles().filter(p=>p.id!==id),profile]);return profile;
 }
 remove(id:string){this.get(id);if(this.loaded?.id===id)throw new Error("Unload the model before deleting its profile");atomic(join(this.dir,"profiles.json"),this.profiles().filter(p=>p.id!==id));}
 scan(directory:string){const path=realpathSync(directory);if(!statSync(path).isDirectory())throw new Error("Choose a model directory");const files:ReturnType<typeof ggufInfo>[]=[];let visited=0;const walk=(dir:string,depth:number)=>{for(const e of readdirSync(dir,{withFileTypes:true})){if(++visited>10000||files.length>=500)return;if(e.isDirectory()&&depth<3)walk(join(dir,e.name),depth+1);else if(e.isFile()&&/\.gguf$/i.test(e.name)){try{files.push(ggufInfo(join(dir,e.name)));}catch{/* Corrupt downloads are not selectable. */}}}};walk(path,0);return files;}
 binaries(){const paths=new Set<string>(),exe=process.platform==="win32"?"llama-server.exe":"llama-server";const scan=(dir:string,depth:number)=>{if(!existsSync(dir)||depth>6)return;for(const e of readdirSync(dir,{withFileTypes:true})){if(e.isDirectory())scan(join(dir,e.name),depth+1);else if(e.isFile()&&e.name===exe)paths.add(join(dir,e.name));}};for(const dir of [join(this.dir,"bin"),join(homedir(),".config/blackriver-workspace/native-runtime/llama.cpp")])scan(dir,0);for(const dir of (process.env.PATH||"").split(delimiter)){const p=join(dir,exe);if(existsSync(p))paths.add(p);}return [...paths];}
 async load(id:string,signal?:AbortSignal){signal?.throwIfAborted();if(this.closed)throw new Error("Native runtime is closed");const profile=this.get(id),signature=JSON.stringify(profile);if(this.child&&this.phase==="ready"&&signature===this.signature)return this.provider(id);
  await this.unload();signal?.throwIfAborted();const help=await this.help(profile.executable);ggufInfo(profile.modelPath);
  if(!supportedFlags(help).has("--api-key"))throw new Error("Managed runtimes require llama-server API-key support; select a compatible build");
  for(const key of ["mmprojPath","draftModelPath"])if(profile.options[key])ggufInfo(String(profile.options[key]));
  // This is a lower bound, not a fabricated KV-cache prediction. Never load with less than weights + OS reserve.
  if(process.platform==="linux"){const available=Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync("/proc/meminfo","utf8"))?.[1]||0)*1024;const weights=[profile.modelPath,profile.options.mmprojPath,profile.options.draftModelPath].filter(Boolean).map(p=>statSync(String(p)).size).reduce((sum,bytes)=>sum+bytes,0);if(available&&available<weights+2*1024**3)throw new Error("Insufficient available system memory for GGUF weights plus OS reserve. Unload external models or choose a smaller GGUF/context.");}
  const port=await unusedPort(),key=randomUUID(),args=[...buildNativeArgs(profile.modelPath,`riverfield-${id}`,port,profile.options,help,profile.extraArgs),"--api-key",key];
  signal?.throwIfAborted();if(this.closed)throw new Error("Native runtime is closed");
  const controller=new AbortController();this.loadingController=controller;signal=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
  this.phase="loading";this.error="";this.logs=[];this.loaded=profile;this.port=port;this.signature=signature;this.effectiveArgs=args.map((v,i)=>args[i-1]==="--api-key"?"[redacted]":v);this.effectiveContext=null;this.accessKey=key;
  const child=spawn(profile.executable,args,{env:childEnv(profile.executable),stdio:["ignore","pipe","pipe"],windowsHide:true,detached:false});this.child=child;
  const logStream=(stream:NodeJS.ReadableStream|undefined)=>{let pending="";const emit=(line:string)=>{if(line)this.logs.push(line.split(key).join("[redacted]").slice(0,4000));this.logs=this.logs.slice(-200);};stream?.on("data",(data:Buffer)=>{pending+=data.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()||"";for(const line of lines)emit(line);if(pending.length>16000){emit("[oversized log line omitted]");pending="";}});stream?.on("end",()=>emit(pending));};logStream(child.stdout||undefined);logStream(child.stderr||undefined);
  child.on("error",e=>{this.error=e.message;});child.once("exit",(code,sig)=>{if(this.child!==child)return;this.child=null;this.port=0;this.accessKey="";this.phase="failed";this.error=`llama-server exited (${sig||code}). ${this.logs.slice(-3).join(" ").slice(0,1000)}`;});
  try{const deadline=Date.now()+10*60_000;while(Date.now()<deadline){signal?.throwIfAborted();if(this.child!==child||child.exitCode!==null||this.error)throw new Error(this.error||"Native runtime exited during startup");try{const response=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.any([AbortSignal.timeout(2000),...(signal?[signal]:[])])});if(response.ok){const models=await response.json() as any,model=models.data?.find((m:any)=>m.id===`riverfield-${id}`);if(model){let actual=model.meta?.n_ctx;try{const res=await fetch(`http://127.0.0.1:${port}/props`,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(2000)});if(res.ok){const props=await res.json() as any;actual=props.default_generation_settings?.n_ctx||props.n_ctx||actual;}}catch{/* Older builds may expose context only in model metadata. */}if(Number.isSafeInteger(actual)&&actual>0)this.effectiveContext=actual;if(profile.options.fit==="on"&&!this.effectiveContext)throw new Error("Auto-fit build did not advertise effective context; disable fit or select a build exposing /props");signal?.throwIfAborted();this.phase="ready";return this.provider(id);}}}catch(e){if((e as Error).message.startsWith("Auto-fit"))throw e;/* Startup may take several minutes. */}await pause(250,signal);}throw new Error("Native model startup timed out after ten minutes");
  }catch(e){await this.unload();this.phase="failed";this.error=(e as Error).message;throw e;}finally{if(this.loadingController===controller)this.loadingController=null;}
 }
 /** Training context advertised by the GGUF metadata, e.g. 262144. Cached per model file revision. */
 nativeContext(id:string){const p=this.get(id),key=`${p.modelPath}:${statSync(p.modelPath).mtimeMs}`;let value=this.nativeContexts.get(key);
  if(value===undefined){const metadata=ggufMetadata(p.modelPath).metadata as Record<string,unknown>;value=Number(Object.entries(metadata).find(([name])=>name.endsWith(".context_length"))?.[1])||0;this.nativeContexts.set(key,value);}return value;}
 provider(id:string){const p=this.get(id),parallel=Math.max(1,Number(p.options.parallel||1)),requested=Number(p.options.contextSize??0);
  // 0 is llama.cpp's native mode (-c 0): the model's training context, requested in full.
  const configured=requested>0?Math.floor(requested/parallel):0;
  const active=this.loaded?.id===id?this.effectiveContext:null;
  const effective=active!==null&&Number.isSafeInteger(active)&&active>0?active:0;
  const contextTokens=effective&&configured?Math.min(configured,effective):effective||configured||this.nativeContext(id);
  return {baseURL:`http://127.0.0.1:${this.port}/v1`,model:`riverfield-${id}`,apiKey:this.loaded?.id===id?this.accessKey:"",contextTokens,temperature:Number(p.options.temperature??.7),topP:Number(p.options.topP??.95),topK:Number(p.options.topK??40),minP:Number(p.options.minP??0),repeatPenalty:Number(p.options.repeatPenalty??1),seed:Number(p.options.seed??-1),vision:!!p.options.mmprojPath};}
 async unload(){const child=this.child;if(!child){this.phase="unloaded";this.loaded=null;this.port=0;this.effectiveContext=null;this.accessKey="";return;}this.phase="unloading";
  // Keep ownership until exit is confirmed. Do not release the GPU slot on a mere signal delivery.
  const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));if(child.exitCode!==null||child.signalCode!==null){this.child=null;}else{child.kill("SIGTERM");const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");},10000);try{await exited;}finally{clearTimeout(timer);}}
  if(this.child===child)this.child=null;this.port=0;this.loaded=null;this.phase="unloaded";this.error="";this.effectiveContext=null;this.accessKey="";
 }
 async close(){this.closed=true;this.cancelLoading();await Promise.all([...this.helpers].map(async child=>{if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));child.kill("SIGTERM");const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");},10000);try{await exited;}finally{clearTimeout(timer);}}));await this.unload();}
}
