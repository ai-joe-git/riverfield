import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {RiverfieldAgent} from "../server/agent.ts";
import {InferenceQueue} from "../server/inference-queue.ts";
import type {McpConnection} from "../server/agent-mcp.ts";

const text=(data:any)=>({content:[{type:"text",text:JSON.stringify(data)}]});
function fixture(status="succeeded"){
 const dir=mkdtempSync("/tmp/opencode/riverfield-completion-"),job="20261111-134539845-158f",folder=join(dir,"history",job);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,"out-01.mp4"),"mock video bytes");writeFileSync(join(folder,"meta.json"),JSON.stringify({id:job,app:"pika-studio-director",outputs:[{file:"out-01.mp4",type:"video"}]}));
 let modelCalls=0,toolCalls=0;
 const connection=():McpConnection=>({tools:async()=>[],call:async()=>{toolCalls++;return text({id:job,app:"pika-studio-director",status,outputs:status==="succeeded"?[{path:join(folder,"out-01.mp4"),type:"video"}]:[],error:status==="failed"?{message:"Mock renderer failed"}:null});},close:async()=>{}});
 const a=new RiverfieldAgent(dir,process.cwd(),new InferenceQueue().run,connection,async()=>{modelCalls++;throw new Error("No model call is allowed for job notifications");});
 const c=a.store.create();c.tools.push({id:"standalone",name:"run_app",arguments:{app:"pika-studio-director"},status:"done",job,standalone:true});c.jobs=[job];c.jobStates[job]={id:job,status};
 c.artifacts.push({id:"video",type:"video",name:"out-01.mp4",path:join(folder,"out-01.mp4"),mime:"video/mp4",url:`/api/agent/conversations/${c.id}/files/video`,job});a.store.save(c);
 return {a,c,job,modelCalls:()=>modelCalls,toolCalls:()=>toolCalls,cleanup:async()=>{await a.close();rmSync(dir,{recursive:true,force:true});}};
}

test("an already completed standalone video gets one factual chat confirmation and a served link, without a model call",async()=>{
 const x=fixture();try{
  let c=x.a.get(x.c.id);assert.equal(c.messages.length,1);assert.match(c.messages[0].content,/Render complete/);assert.match(c.messages[0].content,/Open video.*\/api\/agent/);assert.equal(c.tools[0].completionNotified,true);
  c=x.a.get(c.id);assert.equal(c.messages.length,1);assert.equal(x.modelCalls(),0);assert.equal(x.toolCalls(),0);assert.equal(c.artifacts.length,1);
 }finally{await x.cleanup();}
});
test("job refresh announces failure or cancellation exactly once, never success",async()=>{
 for(const status of ["failed","canceled"]){const x=fixture(status);try{
  await x.a.refreshJobs(x.c.id);await x.a.refreshJobs(x.c.id);const c=x.a.store.get(x.c.id);assert.equal(c.messages.length,1);assert.doesNotMatch(c.messages[0].content,/Render complete/);assert.match(c.messages[0].content,status==="failed"?/Mock renderer failed/:/canceled/);assert.equal(x.modelCalls(),0);
 }finally{await x.cleanup();}}
});
test("background completion sends the final chat message through the live state event",async()=>{
 const x=fixture();let off=()=>{};try{
  const c=x.a.store.get(x.c.id);c.jobStates[x.job].status="running";x.a.store.save(c);
  let timer:ReturnType<typeof setTimeout>|undefined;
  const notification=new Promise<any>((resolve,reject)=>{timer=setTimeout(()=>reject(new Error("No completion state event")),3000);off=x.a.subscribe(c.id,(event,state)=>{if(event==="state"&&state.messages.some((m:any)=>/Render complete/.test(m.content)))resolve(state);});});
  x.a.get(c.id);const completed=await notification;clearTimeout(timer);assert.equal(completed.jobStates[x.job].status,"succeeded");assert.equal(completed.messages.length,1);assert.match(completed.messages[0].content,/Open video/);assert.equal(x.modelCalls(),0);
 }finally{off();await x.cleanup();}
});
