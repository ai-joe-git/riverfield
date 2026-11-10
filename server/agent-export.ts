import type {Conversation} from "./agent-store.ts";
import {hydrateMedia} from "./agent-media.ts";

/** No provider config is accepted here. Redact known credential values even inside tool text. */
export function exportConversation(conversation:Conversation,provider:{name:string;kind:string}|undefined,redact:(text:string)=>string,details=true){
 const sensitive=/^(?:api[_-]?key|authorization|proxy[_-]?authorization|cookie|set-cookie|password|passwd|secret|client_secret|access[_-]?token|refresh[_-]?token|token|credentials|keyEnv|baseURL)$/i;
 const clean=(v:any):any=>{
  if(typeof v==="string"){
   const text=redact(v);
   // Tool results often carry JSON as text; redact credential fields inside it too.
   if(text.length<5_000_000&&/^[\[{]/.test(text.trim()))try{const parsed=JSON.parse(text);return JSON.stringify(clean(parsed));}catch{}
   return text;
  }
  return Array.isArray(v)?v.map(clean):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sensitive.test(k)?"[redacted]":clean(x)])):v;
 };
 const c=clean(hydrateMedia(structuredClone(conversation))) as Conversation;
 const data={format:"riverfield-conversation",version:1,exportedAt:new Date().toISOString(),provider:provider?clean({name:provider.name,kind:provider.kind}):{id:c.provider},conversation:c};
 const lines=[`# ${c.title.replace(/[\r\n]/g," ")}`,"",`Created: ${c.created} · Updated: ${c.updated}`,`Model: ${c.model} · Provider: ${provider?redact(provider.name):c.provider}`,""];
 const referenced=new Set<string>();
 const media=(messageId:string)=>{for(const a of c.artifacts.filter(a=>a.origin?.messageId===messageId)){if(referenced.has(a.id))continue;referenced.add(a.id);lines.push(`- Media: [${a.name.replace(/[\[\]\r\n]/g,"_")}](${a.url}) · ${a.type} · App: ${a.app||"unknown"} · Job: ${a.job||"—"}`,`  Origin: ${JSON.stringify(a.origin)}`,"");}};
 for(const m of c.messages){
  lines.push(`## ${m.role} · ${m.created}`,`Message: ${m.id}`,"",m.content,"");
  for(const call of m.calls||[]){const t=c.tools.find(t=>t.id===call.id);lines.push(`### Tool: ${call.name} · ${t?.status||"pending"}`,`Call: ${call.id}${t?.job?` · Job: ${t.job}`:""}`,"");if(details)lines.push("<details><summary>Arguments and result</summary>","","````json",JSON.stringify({arguments:call.arguments,result:t?.result,error:t?.error},null,2),"````","","</details>","");}
  for(const id of m.attachments||[]){const a=c.attachments.find(a=>a.id===id);if(a)lines.push(`- Attachment: [${a.name.replace(/[\[\]\r\n]/g,"_")}](${a.url})`,"");}
  media(m.id);
 }
 const unknown=c.artifacts.filter(a=>!referenced.has(a.id));if(unknown.length)lines.push("## Media with unknown origin","",...unknown.map(a=>`- [${a.name}](${a.url}) · ${a.id}`),"");
 return {json:data,markdown:lines.join("\n")};
}
