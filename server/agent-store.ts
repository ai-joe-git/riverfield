import {mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,existsSync,realpathSync,rmSync,chmodSync} from "node:fs";
import {join,resolve,relative,isAbsolute,extname} from "node:path";
import {randomUUID} from "node:crypto";
import {hydrateMedia} from "./agent-media.ts";
import type {AgentProject} from "./agent-project.ts";
import type {Production,Interview,PendingQuestions} from "./production.ts";

export type Call={id:string;name:string;arguments:Record<string,unknown>};
export type ChatMessage={id:string;role:"user"|"assistant"|"tool";content:string;calls?:Call[];callId?:string;attachments?:string[];kind?:"studio";created:string};
export type ToolRecord=Call&{status:"proposed"|"approved"|"running"|"done"|"error"|"denied"|"uncertain"|"asking";result?:unknown;error?:string;job?:string;turn?:string;section?:string;scene?:string};
export type Attachment={id:string;name:string;path:string;mime:string;url:string};
export type ArtifactOrigin={messageId:string;toolCallId?:string;turnId?:string;jobId?:string;inferred?:boolean;unknown?:boolean};
export type Artifact=Attachment&{type:string;job?:string;app?:string;seconds?:number;metadata?:unknown;origin?:ArtifactOrigin;created?:string};
export type Conversation={id:string;title:string;created:string;updated:string;provider:string;model:string;instructions:string;mode:"ask"|"auto"|"read-only";maxSteps:number;enabledTools:string[];messages:ChatMessage[];tools:ToolRecord[];attachments:Attachment[];artifacts:Artifact[];jobs:string[];jobStates:Record<string,any>;status:"idle"|"running"|"approval"|"question"|"failed"|"canceled"|"interrupted";error?:string;warnings:string[];runId?:string;project?:AgentProject;questions?:PendingQuestions;interview?:Interview;production?:Production};
export const identifier=(s:string)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(s)||["__proto__","constructor","prototype"].includes(s))throw new Error("Invalid identifier");return s;};
export function within(root:string,path:string){const base=realpathSync(root),file=realpathSync(resolve(root,path)),rel=relative(base,file);if(rel.startsWith("..")||isAbsolute(rel))throw new Error("File outside permitted scope");return file;}
export function atomic(path:string,data:unknown){const temp=`${path}.tmp`;writeFileSync(temp,JSON.stringify(data,null,2),{mode:0o600});renameSync(temp,path);chmodSync(path,0o600);}
export const now=()=>new Date().toISOString();
export class AgentStore {
  dir:string;
  constructor(dir:string){this.dir=resolve(dir);mkdirSync(this.dir,{recursive:true,mode:0o700});chmodSync(this.dir,0o700);}
  folder(id:string){return join(this.dir,"conversations",identifier(id));}
  list(){const dir=join(this.dir,"conversations");return existsSync(dir)?readdirSync(dir).filter(id=>/^[\w-]+$/.test(id)&&existsSync(join(dir,id,"conversation.json"))).map(id=>this.get(id)).sort((a,b)=>b.updated.localeCompare(a.updated)):[];}
  /** Persist legacy media origins and job states implied by recorded tool results, once at startup. */
  migrate(){const dir=join(this.dir,"conversations");if(!existsSync(dir))return;
    for(const id of readdirSync(dir).filter(id=>/^[\w-]+$/.test(id)&&existsSync(join(dir,id,"conversation.json")))){
      const path=join(dir,id,"conversation.json"),c=JSON.parse(readFileSync(path,"utf8")),before=JSON.stringify(c);
      hydrateMedia(c);
      if(JSON.stringify(c)!==before){c.updated=now();atomic(path,c);}
    }
  }
  get(id:string):Conversation{return hydrateMedia(JSON.parse(readFileSync(join(this.folder(id),"conversation.json"),"utf8")));}
  save(c:Conversation){hydrateMedia(c);c.updated=now();atomic(join(this.folder(c.id),"conversation.json"),c);}
  create(provider="",model=""){const c:Conversation={id:randomUUID(),title:"New conversation",created:now(),updated:now(),provider,model,instructions:"",mode:"ask",maxSteps:12,enabledTools:[],messages:[],tools:[],attachments:[],artifacts:[],jobs:[],jobStates:{},status:"idle",warnings:[]};mkdirSync(join(this.folder(c.id),"uploads"),{recursive:true,mode:0o700});this.save(c);return c;}
  remove(id:string){this.get(id);rmSync(this.folder(id),{recursive:true});}
  upload(c:Conversation,bytes:Uint8Array,name:string,mime:string){
    if(bytes.length>20*2**20)throw new Error("Attachments are limited to 20 MB each");
    const ext=extname(name).toLowerCase();const types:Record<string,string>={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".mp4":"video/mp4",".webm":"video/webm",".wav":"audio/wav",".mp3":"audio/mpeg",".flac":"audio/flac",".ogg":"audio/ogg",".txt":"text/plain"};
    if(!types[ext])throw new Error("Supported attachments: images, video, audio or UTF-8 .txt (no executable/HTML/SVG files)");
    const id=randomUUID(),path=join(this.folder(c.id),"uploads",id+ext);writeFileSync(path,bytes,{mode:0o600});
    const a={id,name:name.slice(0,200),path,mime:types[ext],url:`/api/agent/conversations/${c.id}/files/${id}`};c.attachments.push(a);this.save(c);return a;
  }
  file(c:Conversation,id:string){const a=[...c.attachments,...c.artifacts].find(a=>a.id===id);if(!a)throw new Error("Unknown conversation artifact");return a.path;}
}
