import type {Conversation,Artifact,ToolRecord} from "./agent-store.ts";

/** Same shape the MCP client exposes, without importing the client into the store. */
export function resultData(result:any):any{
 if(result?.structuredContent)return result.structuredContent;
 const texts=(result?.content||[]).filter((b:any)=>b.type==="text").map((b:any)=>b.text).join("\n");
 try{return JSON.parse(texts);}catch{return texts||result;}
}

export const terminalJob=(status:string)=>["succeeded","failed","canceled","expired","lost"].includes(status);
/** A delayed poll must never regress a terminal result to running. */
export function mergeJob(c:Conversation,data:any){
 if(!data||typeof data.id!=="string"||typeof data.status!=="string"||!c.jobs.includes(data.id))return false;
 const old=c.jobStates[data.id];
 if(terminalJob(old?.status)&&!terminalJob(data.status))return false;
 const next={...old,...data};
 if(JSON.stringify(next)===JSON.stringify(old))return false;
 c.jobStates[data.id]=next;
 return true;
}
export function artifactOrigin(c:Conversation,a:Pick<Artifact,"path"|"job">,observed?:ToolRecord){
 const producer=a.job?c.tools.find(t=>t.name==="run_app"&&(t.job===a.job||resultData(t.result)?.id===a.job)):undefined;
 const reporter=c.tools.find(t=>t.result&&JSON.stringify(t.result).includes(a.path));
 const tool=observed||reporter||producer;
 const message=c.messages.find(m=>m.calls?.some(call=>call.id===tool?.id))||c.messages.find(m=>m.role!=="tool"&&m.content.includes(a.path))||c.messages.find(m=>m.calls?.some(call=>call.id===producer?.id));
 const anchor=message||c.messages.find(m=>m.role==="assistant")||c.messages[0];
 if(!anchor)return undefined;
 const index=c.messages.indexOf(anchor),turn=tool?.turn||c.messages.slice(0,index+1).findLast(m=>m.role==="user")?.id;
 return {messageId:anchor.id,toolCallId:tool?.id,turnId:turn,jobId:a.job,inferred:!observed,unknown:!message};
}
/** Additive, deterministic legacy migration; existing ids, paths and messages stay intact. */
export function hydrateMedia(c:Conversation){
 for(const t of c.tools)if(["run_app","job","wait_job","cancel_job"].includes(t.name)&&t.result){const data=resultData(t.result);if(t.name==="run_app"&&data?.id&&c.jobs.includes(data.id))t.job||=data.id;mergeJob(c,data);}
 for(const a of c.artifacts)if(!a.origin){const origin=artifactOrigin(c,a);if(origin)a.origin=origin;}
 return c;
}
