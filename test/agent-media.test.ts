import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {hydrateMedia,mergeJob,artifactOrigin} from "../server/agent-media.ts";
import {exportConversation} from "../server/agent-export.ts";
import {AgentStore} from "../server/agent-store.ts";
import type {Conversation,ChatMessage,ToolRecord,Artifact} from "../server/agent-store.ts";

const imagePath="/home/zardoz/freefield/out/history/20261110-060522684-4d16/out-01.png";
const videoPath="/home/zardoz/freefield/out/history/20261110-060957387-f3dd/out-01.mp4";
const text=(data:any)=>({content:[{type:"text",text:JSON.stringify(data)}]});
const job=(id:string,app:string,status:string,path?:string,extra:any={})=>({id,app,status,seconds:40.8,outputs:path?[{type:path.endsWith(".mp4")?"video":"image",path,file:path.split("/").at(-1)}]:[],...extra});
function fixture(){
 const messages:ChatMessage[]=[
  {id:"u1",role:"user",content:"Make an image, then animate it",created:"2026-11-10T06:00:00.000Z"},
  {id:"a1",role:"assistant",content:"Generating the still.",calls:[{id:"r1",name:"run_app",arguments:{app:"z-image"}}],created:"2026-11-10T06:05:00.000Z"},
  {id:"t1",role:"tool",content:'{"id":"20261110-060522684-4d16","status":"starting"}',callId:"r1",created:"2026-11-10T06:05:01.000Z"},
  {id:"a2",role:"assistant",content:"The still is rendering. Waiting for the job.",calls:[{id:"w1",name:"wait_job",arguments:{id:"20261110-060522684-4d16"}}],created:"2026-11-10T06:05:20.000Z"},
  {id:"t2",role:"tool",content:JSON.stringify({id:"20261110-060522684-4d16",status:"succeeded",outputs:[{path:imagePath}]}),callId:"w1",created:"2026-11-10T06:06:03.000Z"},
  {id:"a3",role:"assistant",content:"The image is ready.",calls:[{id:"w2",name:"wait_job",arguments:{id:"20261110-060957387-f3dd"}}],created:"2026-11-10T06:09:00.000Z"},
  {id:"t3",role:"tool",content:JSON.stringify({id:"20261110-060957387-f3dd",status:"succeeded",outputs:[{path:videoPath}]}),callId:"w2",created:"2026-11-10T06:16:55.000Z"},
  {id:"a4",role:"assistant",content:"Both are ready.",calls:[],created:"2026-11-10T06:17:00.000Z"},
 ];
 const tools:ToolRecord[]=[
  {id:"r1",name:"run_app",arguments:{app:"z-image"},status:"done",job:"20261110-060522684-4d16",turn:"u1",result:text(job("20261110-060522684-4d16","z-image","starting"))},
  {id:"w1",name:"wait_job",arguments:{id:"20261110-060522684-4d16"},status:"done",turn:"u1",result:text(job("20261110-060522684-4d16","z-image","succeeded",imagePath))},
  {id:"r2",name:"run_app",arguments:{app:"pika-video"},status:"done",job:"20261110-060957387-f3dd",turn:"u1",result:text(job("20261110-060957387-f3dd","pika-video","starting"))},
  {id:"w2",name:"wait_job",arguments:{id:"20261110-060957387-f3dd"},status:"done",turn:"u1",result:text(job("20261110-060957387-f3dd","pika-video","succeeded",videoPath))},
 ];
 const artifacts:Artifact[]=[
  {id:"img",path:imagePath,type:"image",mime:"image/png",name:"out-01.png",url:"/api/agent/conversations/c1/files/img",job:"20261110-060522684-4d16",app:"z-image",seconds:40.8,metadata:{width:768,height:1280,duration:0,audio:false}},
  {id:"vid",path:videoPath,type:"video",mime:"video/mp4",name:"out-01.mp4",url:"/api/agent/conversations/c1/files/vid",job:"20261110-060957387-f3dd",app:"pika-video",seconds:417.7,metadata:{width:480,height:864,duration:5.166688,audio:true}},
 ];
 const c:Conversation={id:"c1",title:"Production run",created:"2026-11-10T06:00:00.000Z",updated:"2026-11-10T06:17:00.000Z",provider:"provider-id",model:"halogen-qwen3.8-flash-next",instructions:"",mode:"ask",maxSteps:12,enabledTools:[],messages,tools,attachments:[],artifacts,jobs:["20261110-060522684-4d16","20261110-060957387-f3dd"],jobStates:{"20261110-060522684-4d16":job("20261110-060522684-4d16","z-image","succeeded",imagePath),"20261110-060957387-f3dd":job("20261110-060957387-f3dd","pika-video","succeeded",videoPath)},status:"idle",warnings:[]};
 return c;
}

test("legacy artifacts attach at the tool message that reported them, in conversation order",()=>{
 const c=hydrateMedia(fixture());
 assert.equal(c.artifacts[0].origin?.messageId,"a2");
 assert.equal(c.artifacts[0].origin?.toolCallId,"w1");
 assert.equal(c.artifacts[0].origin?.jobId,"20261110-060522684-4d16");
 assert.equal(c.artifacts[0].origin?.turnId,"u1");
 assert.equal(c.artifacts[0].origin?.inferred,true);
 assert.equal(c.artifacts[1].origin?.messageId,"a3");
 assert.equal(c.artifacts[1].origin?.toolCallId,"w2");
 const positions=c.messages.map(m=>m.id);
 assert.ok(positions.indexOf(c.artifacts[0].origin!.messageId)<positions.indexOf(c.artifacts[1].origin!.messageId));
});

test("repeated hydration and polling keep one artifact with a stable association",()=>{
 const c=fixture();
 hydrateMedia(c);const first=JSON.stringify(c.artifacts);
 hydrateMedia(c);hydrateMedia(c);
 assert.equal(c.artifacts.length,2);
 assert.equal(JSON.stringify(c.artifacts),first);
 assert.equal(new Set(c.artifacts.map(a=>a.path)).size,2);
});

test("new artifacts keep an explicit origin; inferred legacy metadata is never overwritten",()=>{
 const c=fixture();
 const recorded=artifactOrigin(c,{path:imagePath,job:"20261110-060522684-4d16"},c.tools.find(t=>t.id==="w1"));
 c.artifacts[0].origin=recorded;
 hydrateMedia(c);
 assert.equal(c.artifacts[0].origin?.inferred,false);
 const legacy={...fixture(),artifacts:[{...fixture().artifacts[0],origin:{messageId:"a4",inferred:false}}]};
 hydrateMedia(legacy);assert.equal(legacy.artifacts[0].origin?.messageId,"a4");
});

test("startup migration persists recovered job states and origins exactly once",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-media-test-");try{
  const store=new AgentStore(join(dir,"agent")),folder=join(store.dir,"conversations","c1");mkdirSync(folder,{recursive:true});
  const c=fixture();c.jobStates["20261110-060957387-f3dd"].status="running";
  writeFileSync(join(folder,"conversation.json"),JSON.stringify(c));
  store.migrate();
  const first=JSON.parse(readFileSync(join(folder,"conversation.json"),"utf8"));
  assert.equal(first.jobStates["20261110-060957387-f3dd"].status,"succeeded");
  assert.equal(first.artifacts[0].origin.messageId,"a2");
  assert.equal(first.artifacts[1].origin.messageId,"a3");
  const snapshot=readFileSync(join(folder,"conversation.json"),"utf8");
  store.migrate();
  assert.equal(readFileSync(join(folder,"conversation.json"),"utf8"),snapshot,"migration is stable and does not rewrite clean conversations");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("job updates move to succeeded and never regress from a delayed poll",()=>{
 const c=fixture();
 mergeJob(c,{id:"20261110-060522684-4d16",status:"running",progress:{value:.4}});
 assert.equal(c.jobStates["20261110-060522684-4d16"].status,"succeeded");
 mergeJob(c,{id:"20261110-060957387-f3dd",status:"failed",error:{message:"backend stopped"}});
 assert.equal(c.jobStates["20261110-060957387-f3dd"].status,"failed");
 assert.equal(c.jobStates["20261110-060957387-f3dd"].error.message,"backend stopped");
 mergeJob(c,{id:"20261110-060957387-f3dd",status:"running"});
 assert.equal(c.jobStates["20261110-060957387-f3dd"].status,"failed");
 mergeJob(c,{id:"unrelated",status:"succeeded"});
 assert.equal(c.jobStates.unrelated,undefined);
});

test("Markdown and JSON exports preserve chronology, tools, jobs and media but never credentials",()=>{
 const c=hydrateMedia(fixture());
 c.tools[0].arguments={app:"z-image",apiKey:"SUPER-SECRET",nested:{authorization:"Bearer SUPER-SECRET"}};
 c.tools[0].result={content:[{type:"text",text:JSON.stringify({id:"20261110-060522684-4d16",echo:"SUPER-SECRET",cookie:"session=abc"})}]};
 const redact=(s:string)=>s.split("SUPER-SECRET").join("[redacted]");
 const out=exportConversation(c,{name:"Halogen local",kind:"openai"},redact);
 assert.match(out.markdown,/^# Production run/);
 assert.match(out.markdown,/Model: halogen-qwen3\.8-flash-next/);
 assert.match(out.markdown,/Tool: run_app · done/);
 assert.match(out.markdown,/Tool: wait_job · done/);
 assert.match(out.markdown,/Job: 20261110-060522684-4d16/);
 assert.match(out.markdown,/\[out-01\.png\]\(\/api\/agent\/conversations\/c1\/files\/img\)/);
 assert.match(out.markdown,/"messageId":"a2"/);
 assert.ok(out.markdown.indexOf("Make an image")<out.markdown.indexOf("The image is ready"));
 assert.ok(!/!\[[^\]]*\]\(\/(?:home|tmp|Users)\//.test(out.markdown),"local absolute media paths are never exported as Markdown embeds");
 assert.ok(!out.markdown.includes("SUPER-SECRET"));
 assert.ok(!out.markdown.includes("session=abc"));
 const json=JSON.parse(JSON.stringify(out.json));
 assert.equal(json.format,"riverfield-conversation");
 assert.equal(json.conversation.messages.length,8);
 assert.equal(json.conversation.artifacts[0].origin.messageId,"a2");
 assert.equal(json.conversation.artifacts[1].origin.jobId,"20261110-060957387-f3dd");
 assert.equal(json.conversation.tools[0].arguments.apiKey,"[redacted]");
 assert.equal(json.conversation.tools[0].arguments.nested.authorization,"[redacted]");
 assert.ok(!JSON.stringify(json).includes("SUPER-SECRET"));
 assert.ok(!JSON.stringify(json).includes("api-key"));
 assert.equal(json.provider.name,"Halogen local");
 assert.equal(json.provider.apiKey,undefined);
});

test("export without tool details still names execution status and media",()=>{
 const out=exportConversation(fixture(),undefined,s=>s,false);
 assert.match(out.markdown,/Tool: wait_job · done/);
 assert.ok(!out.markdown.includes("Arguments and result"));
 assert.match(out.markdown,/files\/vid/);
});
