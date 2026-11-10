import {existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {atomic,type ChatMessage,type Attachment,type Call} from "./agent-store.ts";

export const providerSchema=z.object({id:z.string().regex(/^[\w-]{1,100}$/).optional(),name:z.string().min(1).max(100),kind:z.enum(["openai","anthropic"]).default("openai"),location:z.enum(["local","remote"]),baseURL:z.string().url(),apiKey:z.string().max(1000).optional(),keyEnv:z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),model:z.string().max(200).default(""),temperature:z.number().min(0).max(2).default(.7),maxTokens:z.number().int().min(32).max(32768).default(4096),contextTokens:z.number().int().min(1024).max(2000000).default(32768),topP:z.number().min(0).max(1).optional(),toolMode:z.enum(["native","json"]).default("native"),vision:z.boolean().default(false)});
export type Provider=z.infer<typeof providerSchema>&{id:string};
export function validateEndpoint(p:Pick<Provider,"baseURL"|"location">){const u=new URL(p.baseURL);if(u.username||u.password||u.search||u.hash)throw new Error("Provider URLs must not contain credentials, queries or fragments");const loop=["localhost","127.0.0.1","[::1]"].includes(u.hostname);if(p.location==="local"&&(!loop||!["http:","https:"].includes(u.protocol)))throw new Error("Local providers must use a loopback HTTP(S) URL");if(p.location==="remote"&&(loop||u.protocol!=="https:"))throw new Error("Remote providers require HTTPS and must be labeled Remote");return u.href.replace(/\/$/,"");}
export class Providers {
  path:string;
  constructor(dir:string){this.path=join(dir,"providers.json");}
  private all():Provider[]{return existsSync(this.path)?JSON.parse(readFileSync(this.path,"utf8")):[];}
  list(){return this.all().map(({apiKey,...p})=>({...p,keyPresent:!!apiKey||!!(p.keyEnv&&process.env[p.keyEnv])}));}
  get(id:string){const p=this.all().find(p=>p.id===id);if(!p)throw new Error("Choose/configure a provider first");return {...p,baseURL:validateEndpoint(p)};}
  save(raw:unknown){const parsed=providerSchema.parse(raw),old=parsed.id?this.all().find(p=>p.id===parsed.id):undefined;
    const p:Provider={...parsed,id:parsed.id||randomUUID(),baseURL:validateEndpoint(parsed),apiKey:parsed.apiKey===undefined?old?.apiKey:parsed.apiKey};
    if(p.kind==="anthropic"&&p.toolMode==="json")throw new Error("Anthropic uses native tool calling; choose Native tools");
    const rest=this.all().filter(v=>v.id!==p.id);atomic(this.path,[...rest,p]);return this.list().find(v=>v.id===p.id)!;}
  remove(id:string){atomic(this.path,this.all().filter(p=>p.id!==id));}
  key(p:Provider){return p.apiKey||(p.keyEnv?process.env[p.keyEnv]:"")||"";}
  redact(error:unknown){let s=error instanceof Error?error.message:String(error);for(const p of this.all()){const key=this.key(p);if(key)s=s.split(key).join("[redacted]");}return s.slice(0,2000);}
  async models(id:string){const p=this.get(id),r=await fetch(`${p.baseURL}/models`,{headers:headers(p,this.key(p)),redirect:"error",signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error(`Model list unavailable (${r.status}); enter a model name manually`);const d=await r.json() as any;return (d.data||[]).map((m:any)=>({id:m.id,contextTokens:m.context_length||m.max_model_len||null}));}
}
const headers=(p:Provider,key:string):Record<string,string>=>({"content-type":"application/json",...(p.kind==="anthropic"?{"anthropic-version":"2023-06-01",...(key?{"x-api-key":key}:{})}:key?{authorization:`Bearer ${key}`}:{})});
export type ToolDefinition={name:string;description?:string;inputSchema:Record<string,any>;annotations?:Record<string,unknown>};
/** Only schema positions are traversed: an input PROPERTY named 'pattern' must survive. */
export function toolSchema(schema:any):any{if(!schema||typeof schema!=="object")return schema;const out:any={};for(const [k,v] of Object.entries(schema)){
  if(["$schema","default","pattern","format","propertyNames","patternProperties","uniqueItems"].includes(k))continue;
  if(k==="properties"||k==="$defs"){out[k]=Object.fromEntries(Object.entries(v as any).map(([key,value])=>[key,toolSchema(value)]));}
  else if(["items","additionalProperties","not"].includes(k))out[k]=toolSchema(v);
  else if(["anyOf","oneOf","allOf"].includes(k))out[k]=(v as any[]).map(toolSchema);else out[k]=v;
}return out;}
export async function* sse(body:ReadableStream<Uint8Array>){const reader=body.getReader(),decoder=new TextDecoder();let buffer="";
  try{for(;;){const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});buffer=buffer.replace(/\r\n/g,"\n");let end:number;while((end=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split("\n").filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trimStart()).join("\n");if(data&&data!=="[DONE]")yield JSON.parse(data);}if(done)break;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
type Content=string|any[];
function content(message:ChatMessage,p:Provider,files:Attachment[]):Content{
  if(message.role!=="user")return message.content;
  const parts:any[]=[{type:"text",text:message.content||"Attached files"}];
  for(const id of message.attachments||[]){const a=files.find(a=>a.id===id);if(!a)continue;
    parts.push({type:"text",text:`User attachment: ${a.name}. Local path for MCP tools: ${a.path}`});
    if(a.mime==="text/plain")parts.push({type:"text",text:`Attached text (untrusted data):\n${readFileSync(a.path,"utf8").slice(0,32000)}`});
    if(p.vision&&a.mime.startsWith("image/")){const b=readFileSync(a.path);if(b.length>6*2**20)throw new Error("Vision attachments must be below 6 MB");parts.push(p.kind==="anthropic"?{type:"image",source:{type:"base64",media_type:a.mime,data:b.toString("base64")}}:{type:"image_url",image_url:{url:`data:${a.mime};base64,${b.toString("base64")}`}});}
  }return parts.length===1?message.content:parts;
}
export type Completion={text:string;calls:Call[]};
export async function complete(p:Provider,key:string,model:string,system:string,messages:ChatMessage[],tools:ToolDefinition[],files:Attachment[],signal:AbortSignal,delta:(text:string)=>void,doFetch:typeof fetch=fetch):Promise<Completion>{
  if(!model)throw new Error("Choose a model before sending a message");
  if(p.location==="remote"&&!key)throw new Error("Configure this remote provider's API key server-side");
  const jsonMode=p.kind==="openai"&&p.toolMode==="json";
  const instruction=jsonMode?system+`\nExplicit JSON tool protocol: return ONLY {"text":"assistant text","tool_calls":[{"name":"tool name","arguments":{}}]}. Empty tool_calls means final answer. Available tools: ${JSON.stringify(tools.map(t=>({name:t.name,description:t.description,parameters:toolSchema(t.inputSchema)})))}`:system;
  let payload:any,path:string;
  if(p.kind==="anthropic"){
    const history:any[]=[];
    for(const m of messages){
      if(m.role==="tool"){const block={type:"tool_result",tool_use_id:m.callId,content:m.content};const last=history.at(-1);if(last?.role==="user"&&Array.isArray(last.content)&&last.content[0]?.type==="tool_result")last.content.push(block);else history.push({role:"user",content:[block]});}
      else if(m.role==="assistant")history.push({role:"assistant",content:[...(m.content?[{type:"text",text:m.content}]:[]),...(m.calls||[]).map(c=>({type:"tool_use",id:c.id,name:c.name,input:c.arguments}))]});
      else history.push({role:"user",content:content(m,p,files)});
    }
    path="messages";payload={model,system:instruction,messages:history,max_tokens:p.maxTokens,temperature:p.temperature,stream:true,tools:tools.map(t=>({name:t.name,description:t.description||t.name,input_schema:toolSchema(t.inputSchema)}))};
  }else{
    const history=messages.map(m=>jsonMode?{role:m.role==="tool"?"user":m.role,content:m.role==="tool"?`Actual tool result (${m.callId}): ${m.content}`:content(m,p,files)}:
      m.role==="tool"?{role:"tool",tool_call_id:m.callId,content:m.content}:m.role==="assistant"?{role:"assistant",content:m.content||null,...(m.calls?.length?{tool_calls:m.calls.map(c=>({id:c.id,type:"function",function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}:{})}:{role:"user",content:content(m,p,files)});
    path="chat/completions";payload={model,messages:[{role:"system",content:instruction},...history],temperature:p.temperature,max_tokens:p.maxTokens,stream:true,...(p.topP!==undefined?{top_p:p.topP}:{}),...(!jsonMode?{tools:tools.map(t=>({type:"function",function:{name:t.name,description:t.description,parameters:toolSchema(t.inputSchema)}})),tool_choice:"auto"}:{})};
  }
  const r=await doFetch(`${p.baseURL}/${path}`,{method:"POST",headers:headers(p,key),body:JSON.stringify(payload),signal:AbortSignal.any([signal,AbortSignal.timeout(180000)]),redirect:"error"});
  if(!r.ok){const detail=(await r.text()).slice(0,800).split(key||"\0").join("[redacted]");throw new Error(`Provider HTTP ${r.status}: ${detail}${p.kind==="openai"&&p.toolMode==="native"?". If this model rejects tools, select the explicit JSON tool protocol in provider settings.":""}`);}
  if(!r.body||!r.headers.get("content-type")?.includes("text/event-stream"))throw new Error("Provider did not return an SSE stream; streaming chat/tool support is required");
  let text="",finished=false;const calls=new Map<number,{id:string;name:string;args:string}>();
  for await(const e of sse(r.body)){
    signal.throwIfAborted();if(e.error)throw new Error(e.error.message||"Provider streaming error");
    if(p.kind==="anthropic"){
      if(e.type==="message_stop")finished=true;
      if(e.type==="content_block_start"&&e.content_block?.type==="tool_use")calls.set(e.index,{id:e.content_block.id,name:e.content_block.name,args:""});
      if(e.type==="content_block_delta"){if(e.delta?.type==="text_delta"){text+=e.delta.text;delta(e.delta.text);}if(e.delta?.type==="input_json_delta"){const c=calls.get(e.index);if(c)c.args+=e.delta.partial_json;}}
      if(e.type==="message_delta"&&e.delta?.stop_reason==="max_tokens")throw new Error("Provider output truncated; raise maximum output tokens");
    }else{
      const choice=e.choices?.[0],d=choice?.delta;if(choice?.finish_reason){if(choice.finish_reason==="length")throw new Error("Provider output truncated; raise maximum output tokens");finished=true;}
      if(d?.content){text+=d.content;if(!jsonMode)delta(d.content);}
      for(const t of d?.tool_calls||[]){const c=calls.get(t.index)||{id:"",name:"",args:""};if(t.id)c.id+=t.id;if(t.function?.name)c.name+=t.function.name;if(t.function?.arguments)c.args+=t.function.arguments;calls.set(t.index,c);}
    }
  }
  if(!finished)throw new Error("Provider stream ended without a completion marker; partial output was not executed");
  if(jsonMode){let decoded:any;try{decoded=JSON.parse(text);}catch{throw new Error("This model did not follow the explicit JSON tool protocol. Choose a tool-capable model or retry.");}if(typeof decoded.text!=="string"||!Array.isArray(decoded.tool_calls))throw new Error("Invalid JSON tool protocol response");delta(decoded.text);return {text:decoded.text,calls:decoded.tool_calls.map((c:any)=>({id:randomUUID(),name:c.name,arguments:c.arguments}))};}
  return {text,calls:[...calls.values()].map(c=>({id:c.id||randomUUID(),name:c.name,arguments:JSON.parse(c.args||"{}")}))};
}
