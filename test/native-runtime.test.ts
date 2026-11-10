import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,statSync,symlinkSync,existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {NativeRuntime,ggufInfo} from "../server/native-runtime.ts";
import {buildNativeArgs,nativeOptions,optionsSchema,parseNativeHelp} from "../server/native-options.ts";
import {InferenceQueue} from "../server/inference-queue.ts";
import {Runner} from "../server/runner.ts";

const help=["--model","--alias","--host","--port","--api-key","--ignore-eos",...nativeOptions.flatMap(o=>[...o.flags,...(o.off?[o.off]:[])])].join("\n");
function fixture(){const dir=mkdtempSync("/tmp/opencode/riverfield-native-test-"),binary=join(dir,"llama-server"),model=join(dir,"model.gguf");const header=Buffer.alloc(24);header.write("GGUF");header.writeUInt32LE(3,4);header.writeBigUInt64LE(1n,8);writeFileSync(model,header);
 writeFileSync(binary,`#!/usr/bin/env node
const http=require('node:http');const args=process.argv.slice(2);if(args.includes('--help')){console.log(${JSON.stringify(help)});process.exit(0);}const val=k=>args[args.indexOf(k)+1],key=val('--api-key');process.stdout.write('fixture-key: '+key.slice(0,10));setTimeout(()=>process.stdout.write(key.slice(10)+'\\n'),1);const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.headers.authorization!=='Bearer '+key){res.statusCode=401;res.end('{}');return;}res.end(JSON.stringify({data:[{id:val('--alias')}]}));});server.listen(Number(val('--port')),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`,{mode:0o700});return {dir,binary,model,runtime:new NativeRuntime(join(dir,"runtime"))};}

test("native launch settings preserve GGUF, KV, placement, auxiliary and draft controls",()=>{
 const args=buildNativeArgs("/models/main.gguf","agent",1234,{contextSize:65536,cacheTypeK:"q4_0",cacheTypeV:"q8_0",gpuLayers:"all",mmprojPath:"/models/mmproj.gguf",draftModelPath:"/models/draft.gguf",specType:"draft-mtp,ngram-mod",specDraftNMax:3,specDraftPMin:.6,specDraftCacheTypeK:"q8_0",cpuMoe:true,nCpuMoe:8,temperature:.5,kvOffload:false,loadMode:"mmap",fit:"off"},help,["--ignore-eos"]);
 const val=(flag:string)=>args[args.indexOf(flag)+1];assert.equal(val("--host"),"127.0.0.1");assert.equal(val("--ctx-size"),"65536");assert.equal(val("--spec-type"),"draft-mtp,ngram-mod");assert.equal(val("--cache-type-k-draft"),"q8_0");assert.equal(val("--spec-draft-p-min"),"0.6");assert.equal(val("--mmproj"),"/models/mmproj.gguf");assert.ok(args.includes("--no-kv-offload"));assert.ok(args.includes("--ignore-eos"));
});
test("native options are build-aware, expert argv cannot replace managed settings, and new profiles have no inherited auxiliaries",()=>{
 const args=buildNativeArgs("/m.gguf","a",1,{},help);assert.ok(!args.includes("--model-draft"));assert.ok(!args.includes("--mmproj"));assert.ok(!args.includes("--spec-type"));
 assert.throws(()=>buildNativeArgs("/m.gguf","a",1,{fit:"on"},"--model --alias --host --port"),/not supported/);
 for(const extra of [["--host=0.0.0.0"],["--model","/other.gguf"],["--api-key","secret"],["--ctx-size","262144"],["--made-up"]])assert.throws(()=>buildNativeArgs("/m.gguf","a",1,{},help,extra),/managed|unsupported/);
 const aliases=help+"\n-hf, --hf-repo REPO  Download a remote model\n--custom-option VALUE  A future build option";assert.equal(parseNativeHelp(aliases).find(o=>o.flag==="--hf-repo")?.managed,true);assert.throws(()=>buildNativeArgs("/m.gguf","a",1,{},aliases,["-hf","remote/repo"]),/managed/);assert.ok(buildNativeArgs("/m.gguf","a",1,{},aliases,["--custom-option=$(not-a-shell)"]).includes("--custom-option=$(not-a-shell)"));
 const aligned=parseNativeHelp("-lm,   --load-mode MODE                 Load mode\n--spec-type none,draft-mtp,ngram-mod  Speculation");assert.equal(aligned[0].flag,"--load-mode");assert.equal(aligned[0].managed,true);assert.deepEqual(aligned[1].aliases,[],"hyphens inside enum values are not flag aliases");assert.throws(()=>buildNativeArgs("/m.gguf","a",1,{},help+"\n-lm,   --load-mode MODE  Load mode",["-lm","none"]),/managed/);
 assert.throws(()=>optionsSchema.parse({batchSize:32,ubatchSize:64}),/Micro batch/);assert.throws(()=>optionsSchema.parse({specDraftNMax:2,specDraftNMin:3}),/Draft minimum/);assert.throws(()=>optionsSchema.parse({contextSize:3.5}),/1024|integer/);
});
test("native runtime persists isolated profiles, loads only its own child and waits for confirmed exit",async()=>{
 const x=fixture();let pid:number|null=null;try{const p=await x.runtime.save({name:"Fixture",executable:x.binary,modelPath:x.model,options:{contextSize:4096,temperature:.4,topK:17}});assert.equal(statSync(join(x.dir,"runtime/profiles.json")).mode&0o777,0o600);
 const provider=await x.runtime.load(p.id);pid=x.runtime.status().pid!;assert.equal(provider.contextTokens,4096);assert.equal(provider.temperature,.4);assert.equal(provider.topK,17);assert.equal(x.runtime.status().phase,"ready");assert.equal((await fetch(`${provider.baseURL}/models`)).status,401);assert.equal((await fetch(`${provider.baseURL}/models`,{headers:{authorization:`Bearer ${provider.apiKey}`}})).status,200);assert.ok(!JSON.stringify(x.runtime.catalogue()).includes(provider.apiKey),"ephemeral runtime credentials never reach status, logs, argv or profile JSON");assert.ok(x.runtime.status().effectiveArgs.includes("[redacted]"));
 await x.runtime.load(p.id);assert.equal(x.runtime.status().pid,pid,"same profile reuses the owned process");assert.throws(()=>x.runtime.remove(p.id),/Unload/);
 await x.runtime.unload();assert.equal(x.runtime.status().pid,null);assert.throws(()=>process.kill(pid!,0),/ESRCH/);x.runtime.remove(p.id);assert.equal(x.runtime.profiles().length,0);
 }finally{await x.runtime.unload();rmSync(x.dir,{recursive:true,force:true});}
});
test("native launch abort leaves no owned child and no automatic reloading",async()=>{
 const x=fixture();try{const p=await x.runtime.save({name:"Fixture",executable:x.binary,modelPath:x.model,options:{}});const controller=new AbortController();controller.abort(new Error("user stopped"));await assert.rejects(()=>x.runtime.load(p.id,controller.signal),/user stopped/);assert.equal(x.runtime.status().pid,null);}finally{await x.runtime.unload();rmSync(x.dir,{recursive:true,force:true});}
});
test("canceling an active native startup terminates its owned child before releasing the caller",async()=>{
 const x=fixture();try{const p=await x.runtime.save({name:"Fixture",executable:x.binary,modelPath:x.model,options:{}});const loading=x.runtime.load(p.id);let pid:number|null=null;for(let i=0;i<100;i++){pid=x.runtime.status().pid;if(pid)break;await new Promise(r=>setTimeout(r,5));}assert.ok(pid);x.runtime.cancelLoading();await assert.rejects(()=>loading,/canceled by user/);assert.equal(x.runtime.status().pid,null);assert.throws(()=>process.kill(pid!,0),/ESRCH/);
 }finally{await x.runtime.unload();rmSync(x.dir,{recursive:true,force:true});}
});
test("changing the GGUF in a remembered profile cannot inherit its auxiliary settings",async()=>{
 const x=fixture();try{const p=await x.runtime.save({name:"Fixture",executable:x.binary,modelPath:x.model,options:{mmprojPath:x.model,specType:"draft-mtp"}});const other=join(x.dir,"other.gguf");const bytes=Buffer.alloc(24);bytes.write("GGUF");bytes.writeUInt32LE(3,4);bytes.writeBigUInt64LE(1n,8);writeFileSync(other,bytes);await assert.rejects(()=>x.runtime.save({...p,modelPath:other}),/new profile/);const clean=await x.runtime.save({name:"Other",executable:x.binary,modelPath:other,options:{}});assert.equal(clean.options.mmprojPath,undefined);assert.equal(clean.options.specType,undefined);
 }finally{await x.runtime.unload();rmSync(x.dir,{recursive:true,force:true});}
});
test("runtime shutdown also terminates owned help probes and prevents late process launches",async()=>{
 const x=fixture(),marker=join(x.dir,"help-started");try{writeFileSync(x.binary,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);\n`,{mode:0o700});const lookup=x.runtime.help(x.binary).then(()=>null,e=>e);for(let i=0;i<200&&!existsSync(marker);i++)await new Promise(r=>setTimeout(r,5));assert.ok(existsSync(marker));const pid=Number(readFileSync(marker,"utf8"));await x.runtime.close();assert.ok(await lookup instanceof Error);assert.throws(()=>process.kill(pid,0),/ESRCH/);await assert.rejects(()=>x.runtime.load("unused"),/closed/);
 }finally{await x.runtime.close();rmSync(x.dir,{recursive:true,force:true});}
});
test("shared GPU queue unloads native child before media, then releases media before reloading",async()=>{
 const x=fixture(),queue=new InferenceQueue();try{const p=await x.runtime.save({name:"Fixture",executable:x.binary,modelPath:x.model,options:{}});const events:string[]=[];
 await queue.run("agent",async()=>{await x.runtime.load(p.id);events.push("agent");});const first=x.runtime.status().pid;
 const media=queue.run("media",async()=>{await x.runtime.unload();assert.equal(x.runtime.status().pid,null);assert.throws(()=>process.kill(first!,0),/ESRCH/);events.push("media");});
 const next=queue.run("agent",async()=>{events.push("release-media-confirmed");await x.runtime.load(p.id);events.push("agent-again");});await Promise.all([media,next]);assert.deepEqual(events,["agent","media","release-media-confirmed","agent-again"]);
 }finally{await x.runtime.unload();rmSync(x.dir,{recursive:true,force:true});}
});
test("native library scan is bounded and excludes invalid GGUFs and symlink directories",()=>{const x=fixture();try{writeFileSync(join(x.dir,"bad.gguf"),"not a model");mkdirSync(join(x.dir,"nested"));if(process.platform!=="win32")symlinkSync(x.dir,join(x.dir,"loop"),"dir");assert.equal(x.runtime.scan(x.dir).length,1);assert.equal(x.runtime.inspect(x.model).version,3);assert.throws(()=>ggufInfo(join(x.dir,"bad.gguf")),/Invalid/);}finally{rmSync(x.dir,{recursive:true,force:true});}});
test("media release requires positive acknowledgement, never a bare 404 or silent success",async()=>{
 for(const [status,body] of [[404,{}],[200,{}],[200,{released:false}]] as const){const runner=new Runner({baseUrl:"http://localhost:1",fetch:(async()=>new Response(JSON.stringify(body),{status})) as typeof fetch});await assert.rejects(()=>runner.release(),/release|confirm|gateway/);}
 let request:any;const runner=new Runner({baseUrl:"http://localhost:1",token:"fixture",fetch:(async(_u,init)=>{request=init;return new Response(JSON.stringify({released:true}));}) as typeof fetch});await runner.release();assert.equal(request.method,"POST");assert.equal(request.headers.authorization,"Bearer fixture");
});
