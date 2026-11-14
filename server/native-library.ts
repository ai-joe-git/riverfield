import {basename,dirname,relative,isAbsolute,sep,join} from "node:path";
import {createHash} from "node:crypto";

type File={path:string;name:string;bytes:number;version:number;tensors:number};
export type LibraryFile=File&{role:"model"|"projector"|"mtp"|"draft";quantization:string|null;parts:number};
const sort=(a:string,b:string)=>a.localeCompare(b,"en",{numeric:true,sensitivity:"base"});
const inside=(root:string,path:string)=>{const r=relative(root,path);return !r||r!==".."&&!r.startsWith(`..${sep}`)&&!isAbsolute(r);};
export function libraryRole(name:string):LibraryFile["role"]|null{
 if(/^(?:imatrix|importance[-_]?matrix)(?:[-_.]|$)/i.test(name))return null;
 if(/^(?:mmproj|projector)(?:[-_.]|$)/i.test(name))return "projector";
 if(/^mtp(?:[-_.]|$)/i.test(name))return "mtp";
 if(/(?:^|[-_.])(?:draft|dflash\d*|eagle\d*|dspark)(?:[-_.]|$)/i.test(name))return "draft";
 return "model";
}
const quantization=(name:string)=>/(?:^|[-_])((?:UD[-_])?(?:IQ\d|TQ\d|Q\d)[A-Z0-9_]*|BF16|F16|FP16|F32)(?=[-.]|$)/i.exec(name)?.[1]||null;
const stem=(name:string)=>name.replace(/\.gguf$/i,"").replace(/-\d{5}-of-\d{5}$/i,"").replace(/[-_](?:UD[-_])?(?:IQ\d|TQ\d|Q\d|BF16|F16|FP16|F32).*$/i,"");
const key=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]/g,"");

/** Association by local model folder/name is visible in the UI, not a compatibility certificate. */
export function groupNativeLibrary(files:File[],roots:string[]){
 const minimal=roots.filter(r=>!roots.some(other=>other!==r&&inside(other,r))),folders=new Map<string,LibraryFile[]>(),orphans:LibraryFile[]=[];
 const owner=(path:string)=>{const root=minimal.find(r=>inside(r,path));if(!root)return dirname(path);if(/[-_ ]GGUF$/i.test(basename(root)))return root;const parts=relative(root,path).split(sep);return parts.length>1?join(root,parts[0]):root;};
 for(const file of new Map(files.map(f=>[f.path,f])).values()){
  const role=libraryRole(file.name),split=/-(\d{5})-of-(\d{5})\.gguf$/i.exec(file.name);if(!role||split&&Number(split[1])!==1)continue;
  const entry={...file,role,quantization:quantization(file.name),parts:split?Number(split[2]):1},dir=owner(file.path);folders.set(dir,[...(folders.get(dir)||[]),entry]);
 }
 const groups:{id:string;name:string;directory:string;models:LibraryFile[];projectors:LibraryFile[];mtp:LibraryFile[];drafts:LibraryFile[];association:string}[]=[];
 for(const [dir,entries]of folders){
  const main=entries.filter(f=>f.role==="model"),aux=entries.filter(f=>f.role!=="model");if(!main.length){orphans.push(...aux);continue;}
  const flat=minimal.includes(dir)&&!/[-_ ]GGUF$/i.test(basename(dir)),families=new Map<string,LibraryFile[]>();for(const f of main){const family=flat?stem(f.name):basename(dir).replace(/[-_ ]GGUF$/i,"");families.set(family,[...(families.get(family)||[]),f]);}
  const assigned=new Set<string>();
  for(const [name,models]of families){const associated=aux.filter(f=>{if(!flat||families.size===1)return true;const matches=[...families.keys()].filter(family=>key(f.name).includes(key(family)));return matches.length===1&&matches[0]===name;});associated.forEach(f=>assigned.add(f.path));groups.push({id:createHash("sha256").update(dir+"\0"+name).digest("hex").slice(0,20),name,directory:dir,models:models.sort((a,b)=>sort(a.name,b.name)),projectors:associated.filter(f=>f.role==="projector"),mtp:associated.filter(f=>f.role==="mtp"),drafts:associated.filter(f=>f.role==="draft"),association:!flat||families.size===1?"Same model folder":"Matching model name"});}
  orphans.push(...aux.filter(f=>!assigned.has(f.path)));
 }
 for(const g of groups)for(const list of [g.projectors,g.mtp,g.drafts])list.sort((a,b)=>sort(a.name,b.name));
 return {groups:groups.sort((a,b)=>sort(a.name,b.name)||sort(a.directory,b.directory)),orphans:orphans.sort((a,b)=>sort(a.name,b.name))};
}
