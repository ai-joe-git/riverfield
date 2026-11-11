import {z} from "zod";
import type {Conversation} from "./agent-store.ts";
import type {ToolDefinition} from "./agent-providers.ts";

const reference=z.strictObject({label:z.string().min(1).max(120),kind:z.enum(["character","location","prop"]),assetId:z.string().max(2000)});
const scene=z.strictObject({id:z.string().min(1).max(100),title:z.string().min(1).max(300),requiredReferences:z.array(z.string().max(120)).max(30),status:z.enum(["planned","generating","generated","verified"]).default("planned")});
const content=z.strictObject({summary:z.string().max(12000),references:z.array(reference).max(100),scenes:z.array(scene).max(100),activeScene:z.string().max(100)});
export const projectSchema=content.extend({brief:z.string().max(12000),lock:z.strictObject({section:z.enum(["image","video","audio","3d","utility"]),app:z.string().max(200),values:z.record(z.string().max(100),z.union([z.string().max(4000),z.number(),z.boolean()]))})}).refine(p=>JSON.stringify(p).length<=32000,"Project state exceeds 32,000 characters; keep the summary and scene plan concise");
export type AgentProject=z.infer<typeof projectSchema>;
export const projectOf=(c:Conversation):AgentProject=>c.project||{brief:"",summary:"",references:[],scenes:[],activeScene:"",lock:{section:"video",app:"",values:{}}};
export const projectTool:ToolDefinition={name:"project_state",description:"Read/update durable project summary, canonical character/location/prop references and scene plan. assetId accepts a known attachment/artifact ID, exact known path, or unique job ID/filename; the studio stores the canonical asset ID. Never invent references. User brief and engine/parameter locks cannot be changed by this tool. Generated is not visually verified.",inputSchema:{type:"object",properties:{action:{type:"string",enum:["get","update"]},state:z.toJSONSchema(content,{io:"input"})},required:["action"],additionalProperties:false}};
export function resolveProjectAsset(c:Conversation,value:string){
 const assets=[...c.artifacts,...c.attachments],exact=assets.find(a=>a.id===value);if(exact)return exact;
 const matches=assets.filter(a=>a.path===value||a.name===value||("job" in a&&a.job===value)).filter((a,i,all)=>all.findIndex(b=>b.path===a.path)===i);
 if(matches.length===1)return matches[0];
 const available=(matches.length?matches:assets).slice(-20).map(a=>({id:a.id,name:a.name,path:a.path}));
 throw new Error(`${matches.length?"Ambiguous":"Unknown"} reference asset ${JSON.stringify(value)}. Use a known asset ID or exact path: ${JSON.stringify(available)}`);
}
export function updateProject(c:Conversation,state:unknown){const parsed=content.parse(state),labels=new Set<string>(),ids=new Set<string>();for(const r of parsed.references){if(labels.has(r.label))throw new Error("Reference labels must be unique");labels.add(r.label);r.assetId=resolveProjectAsset(c,r.assetId).id;}for(const scene of parsed.scenes){if(ids.has(scene.id))throw new Error("Scene IDs must be unique");ids.add(scene.id);if(scene.requiredReferences.some(label=>!labels.has(label)))throw new Error("Scene requires an unknown canonical reference");if(scene.status==="verified")throw new Error("Do not mark visual/audio fidelity verified through project_state; content inspection evidence must be reported separately");}if(parsed.activeScene&&!ids.has(parsed.activeScene))throw new Error("Unknown active scene");c.project=projectSchema.parse({...projectOf(c),...parsed});return c.project;}
export function checkProject(c:Conversation,app:string,section:string|undefined,values:Record<string,unknown>,files:Record<string,string>){
 // RelayVSR is catalogued as video, but transforms an existing clip rather than generating a scene.
 if(app==="relayvsr-upscale")return;
 const p=projectOf(c);if(p.lock.app){if(section===p.lock.section&&app!==p.lock.app)throw new Error(`User locked ${p.lock.section} engine to ${p.lock.app}; do not substitute another app`);if(app===p.lock.app)for(const [key,value] of Object.entries(p.lock.values))if(values[key]!==value)throw new Error(`User locked ${key}=${JSON.stringify(value)}. Include that exact parameter.`);}
 if(section!=="video")return;const scene=p.scenes.find(s=>s.id===p.activeScene);for(const label of scene?.requiredReferences||[]){const ref=p.references.find(r=>r.label===label),asset=[...c.attachments,...c.artifacts].find(a=>a.id===ref?.assetId);if(!asset||!Object.values(files).includes(asset.path))throw new Error(`Scene ${scene!.title} requires canonical ${label}. Pass its actual file reference instead of regenerating/substituting it.`);}}
