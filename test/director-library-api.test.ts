import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer,type Server} from "node:http";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {loadRegistry} from "../server/registry.ts";
import {resolveNativeWriter} from "../server/workspace-writer.ts";
import {StudioMcp,resultData} from "../server/agent-mcp.ts";
const listen=async(s:Server)=>{s.listen(0,"127.0.0.1");await once(s,"listening");return (s.address() as {port:number}).port;};
test("MCP and the real HTTP/SDK pipeline carry twelve selected FL2VA endpoints without GPU work",{timeout:20000},async()=>{
 const out=mkdtempSync("/tmp/director-library-api-"),uploads:string[]=[];let captured!:(graph:any)=>void;
 const dispatch=new Promise<any>(resolve=>captured=resolve);
 const backend=createServer(async(req,res)=>{
  const path=new URL(req.url!,"http://mock").pathname;const send=(status:number,body:unknown)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body));};
  if(path==="/riverfield/prepare")return send(200,{freed:false});
  if(path.startsWith("/object_info/")){const cls=decodeURIComponent(path.split('/').at(-1)!);return send(200,{[cls]:{}});}
  const request=new Request("http://mock"+path,{method:req.method,headers:req.headers as any,...(req.method==="POST"?{body:req as any,duplex:"half"}:{})} as any);
  if(path==="/api/v2/assets"&&req.method==="POST"){
   const form=await request.formData();uploads.push(String(form.get("file_path")));
   return send(201,{id:`image-${uploads.length}`,size_bytes:1,content_type:"image/png",file_path:String(form.get("file_path")),created_at:new Date().toISOString(),url:"http://127.0.0.1/unused.png",url_expires_at:"2099-01-01T00:00:00Z"});
  }
  if(path==="/api/v2/jobs"&&req.method==="POST"){const body=await request.json() as any;captured(body.workflow);return send(400,{error:{code:"MOCK_DISPATCH_ONLY",message:"Captured graph; no inference"}});}
  return send(404,{});
 });
 const backendPort=await listen(backend),reservation=createServer(),port=await listen(reservation);await new Promise<void>(r=>reservation.close(()=>r()));
 const child=spawn(process.execPath,["--experimental-strip-types","--disable-warning=ExperimentalWarning","server/server.ts"],{cwd:process.cwd(),env:{...process.env,PORT:String(port),RIVERFIELD_HOST:"127.0.0.1",RIVERFIELD_OUT:out,COMFY_BASE_URL:`http://127.0.0.1:${backendPort}`,RIVERFIELD_PASSCODE:"",RIVERFIELD_MAX_ACTIVE:"0",RIVERFIELD_MAX_RUNS_PER_DAY:"0"},stdio:["ignore","pipe","pipe"]});
 let log="";child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let client:StudioMcp|undefined;
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(log)),10000);const inspect=()=>{if(log.includes('riverfield on')){clearTimeout(timer);child.stdout.off('data',inspect);resolve();}};child.stdout.on('data',inspect);inspect();});
  client=new StudioMcp(`http://127.0.0.1:${port}/mcp`);const files:Record<string,string>={};
  for(let i=1;i<=12;i++){const path=join(out,`image-${i}.png`);writeFileSync(path,Uint8Array.of(i));files[`image${i}`]=path;}
  const windows=Array.from({length:6},(_,i)=>({start:i*175,end:(i+1)*175,prompt:"Independent scene",images:[],audios:[],first_frame:i*2,last_frame:i*2+1}));
  const result=await client.call("run_app",{app:"h3-studio-director-flash",files,values:{flex_mode:"fl2va",prompt_enhancer:false,segment_windows:{windows,videos:[],audios:[]}}});assert.ok(!result.isError,JSON.stringify(result));assert.ok(resultData(result).id);
  let timer:ReturnType<typeof setTimeout>|undefined;const graph=await Promise.race([dispatch,new Promise<never>((_,reject)=>timer=setTimeout(()=>reject(new Error(log)),8000))]);clearTimeout(timer);
  assert.ok(graph.rfplan.inputs.image12);assert.equal(uploads.length,12);assert.equal(JSON.parse(graph.rfplan.inputs.segment_windows).windows[5].last_frame,11);
  // Prompt-only requests exercise the real routing into the installed native systems.
  const registry=loadRegistry(process.cwd()).apps;
  for(const [id,mode,endpoint] of [
    ["h3-studio-director-flash","t2va",{}],
    ["h3-studio-director-flash","i2va",{first_frame:0}],
    ["h3-studio-director-flash","l2va",{last_frame:1}],
    ["h3-studio-director-flash","fl2va",{first_frame:0,last_frame:1}],
    ["h3-piflow-director","fl2va",{first_frame:0,last_frame:1}],
    ["ltx-director","first_frame",{}],
  ] as const){
   for(const slot of ["image1","image2"]){const fd=new FormData();fd.append("file",new Blob([Uint8Array.of(1)],{type:"image/png"}),slot+".png");const stored=await fetch(`http://127.0.0.1:${port}/api/directors/${id}/media/${slot}`,{method:"POST",body:fd});assert.equal(stored.status,200);}
   let done!:(graph:any)=>void;const wrote=new Promise<any>(r=>done=r);captured=done;
   const values={flex_mode:"fl2va",segment_windows:JSON.stringify({windows:[{start:0,end:175,prompt:"A quiet scene",images:id==="ltx-director"?[0]:[],audios:[],...endpoint}]})};
   const response=fetch(`http://127.0.0.1:${port}/api/directors/${id}/prompts`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({values,index:0})});
   const promptGraph=await Promise.race([wrote,new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new Error(`No ${id} ${mode} writer dispatch`)),5000);t.unref();})]);
   const enhancer=registry.find(a=>a.id===(id.startsWith("ltx-")?"ltx-prompt-generator":"prompt-enhancer"))!;
   const link=promptGraph.gen.inputs.system_prompt;assert.equal(promptGraph[link[0]].inputs.value,resolveNativeWriter(enhancer,mode).system,`${id} ${mode}`);
   // The mock intentionally rejects after capture; no writer or video inference exists here.
   assert.equal((await response).status,500);
  }
  let done!:(graph:any)=>void;const wrote=new Promise<any>(r=>done=r);captured=done;
  const promptForm=new FormData();promptForm.append("prompt","A separate LTX scene");promptForm.append("index","0");
  for(const slot of ["image","last_frame"])promptForm.append(slot,new Blob([Uint8Array.of(1)],{type:"image/png"}),slot+".png");
  const response=fetch(`http://127.0.0.1:${port}/api/directors/ltx-sequential-director/prompts`,{method:"POST",body:promptForm});
  const promptGraph=await Promise.race([wrote,new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new Error("No LTX first/last writer dispatch")),5000);t.unref();})]);
  const link=promptGraph.gen.inputs.system_prompt;const enhancer=registry.find(a=>a.id==="ltx-prompt-generator")!;
  assert.equal(promptGraph[link[0]].inputs.value,resolveNativeWriter(enhancer,"first_last").system);assert.equal((await response).status,500);

 }finally{await client?.close();child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');backend.closeAllConnections();await new Promise<void>(r=>backend.close(()=>r()));rmSync(out,{recursive:true,force:true});}
});
