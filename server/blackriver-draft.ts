import {existsSync,readFileSync,statSync} from "node:fs";
import {basename,resolve} from "node:path";
import {optionsSchema} from "./native-options.ts";

const normalize=(path:string)=>resolve(path).normalize("NFKC").replace(/\\/g,"/").toLowerCase();
const mode=(value:unknown)=>{if(typeof value!=="string")return null;const parts=value.split(",").map(v=>v.trim()).filter(Boolean);return parts.length&&parts.every(v=>/^(?:none|draft-[a-z0-9-]+|ngram-[a-z0-9-]+)$/.test(v))&&!(parts.includes("none")&&parts.length>1)?parts.join(","):null;};
/** Read only the per-model draft subset. Never import credentials, extra argv or process state. */
export function blackriverDraftSettings(path:string,modelPath=""){
 const empty={source:"BlackRiver Workspace",available:false,modes:[] as string[],match:null as null|{name:string;options:Record<string,unknown>;performance:Record<string,unknown>;draftSource:string;draftFile:string|null;updatedAt:string|null},error:null as string|null};
 if(!existsSync(path))return empty;
 try{
  if(statSync(path).size>8*1024**2)throw new Error("BlackRiver settings exceed the bounded read size");
  const data=JSON.parse(readFileSync(path,"utf8")),profiles=Object.entries(data.modelProfiles||{}) as [string,any][],modes=[...new Set(profiles.map(([,p])=>mode(p?.params?.specType)).filter((v):v is string=>!!v))];
  const exact=modelPath?profiles.find(([key])=>normalize(key)===normalize(modelPath)):undefined;
  if(!exact)return {...empty,available:true,modes};
  const params=exact[1]?.params||{},picked=Object.fromEntries(Object.entries(params).filter(([key])=>key==="specType"||key.startsWith("specDraft"))),parsed=optionsSchema.safeParse(picked);
  if(!parsed.success)return {...empty,available:true,modes,error:"The matching BlackRiver draft settings contain unsupported or invalid parameter values"};
  const performance=optionsSchema.safeParse(Object.fromEntries(Object.entries(params).filter(([key])=>key==="batchSize"||key==="ubatchSize")));
  return {...empty,available:true,modes,match:{name:String(exact[1].name||basename(modelPath)).slice(0,200),options:parsed.data as Record<string,unknown>,performance:performance.success?performance.data as Record<string,unknown>:{},draftSource:params.draftMode==="manual"?"explicit file":params.draftMode==="auto"?"automatic / embedded":"not specified",draftFile:typeof params.draftModelPath==="string"&&params.draftModelPath?basename(params.draftModelPath):null,updatedAt:typeof exact[1].updatedAt==="string"?exact[1].updatedAt:null}};
 }catch{return {...empty,error:"BlackRiver draft settings could not be read"};}
}
