import {z} from "zod";
import {now,type Conversation} from "./agent-store.ts";
import type {ToolDefinition} from "./agent-providers.ts";

/**
 * Pre-production gate: a clickable interview, a user-approved plan, and a pilot clip.
 * The model may draft the plan but never approve it: approval is a studio action.
 */

const choice=z.strictObject({label:z.string().trim().min(1).max(80),description:z.string().trim().max(300).optional()});
const question=z.strictObject({
 id:z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
 header:z.string().trim().min(1).max(60),
 question:z.string().trim().min(1).max(400),
 options:z.array(choice).min(2).max(8),
 multiple:z.boolean().default(false),
});
export const questionInput=z.strictObject({questions:z.array(question).min(1).max(6)});
export type AgentQuestion=z.infer<typeof question>;
export type PendingQuestions={toolId:string;turn?:string;questions:AgentQuestion[];asked:string};

export const answerInput=z.strictObject({
 answers:z.record(z.string(),z.array(z.string().max(120)).max(8)).default({}),
 notes:z.string().max(4000).default(""),
 skip:z.boolean().default(false),
});
export type InterviewAnswer={id:string;header:string;question:string;selected:string[];other?:string};
export type Interview={answers:InterviewAnswer[];notes:string;skipped:boolean;at:string};

const dialogue=z.strictObject({speaker:z.string().trim().max(60).default(""),line:z.string().trim().min(1).max(600)});
const scene=z.strictObject({
 id:z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
 title:z.string().trim().min(1).max(200),
 prompt:z.string().trim().min(20).max(4000),
 seconds:z.number().min(0.2).max(150),
 dialogue:z.array(dialogue).max(40).default([]),
 references:z.array(z.string().trim().min(1).max(120)).max(30).default([]),
 status:z.enum(["planned","generating","generated","failed"]).default("planned"),
 job:z.string().max(100).optional(),
});
export type ProductionScene=z.infer<typeof scene>;

const productionContent=z.strictObject({
 format:z.string().trim().min(1).max(60),
 style:z.string().trim().min(1).max(120),
 platform:z.string().trim().min(1).max(80),
 language:z.string().trim().min(1).max(40),
 aspect:z.string().trim().regex(/^\d{1,2}:\d{1,2}$/),
 durationSeconds:z.number().min(1).max(36000),
 sound:z.enum(["dialogue","music","ambient","silent"]).default("dialogue"),
 engine:z.string().trim().min(1).max(200),
 imageEngine:z.string().trim().max(200).default(""),
 model:z.string().trim().max(200).default(""),
 lockedValues:z.record(z.string().max(100),z.union([z.string().max(4000),z.number(),z.boolean()])).default({}),
 treatment:z.string().trim().min(1).max(12000),
 scenes:z.array(scene).min(1).max(64),
});
export const productionInput=productionContent.refine(p=>JSON.stringify(p).length<=60000,"Production plan exceeds 60,000 characters; shorten prompts or split the episode");
export const productionSchema=productionContent.extend({
 status:z.enum(["draft","approved"]).default("draft"),
 approvedAt:z.string().optional(),
 approvedToolCount:z.number().int().min(0).optional(),
 pilot:z.strictObject({approved:z.boolean().default(false),artifact:z.string().max(100).optional(),at:z.string().optional()}).default({approved:false}),
});
export type Production=z.infer<typeof productionSchema>;

export type EngineApp={id:string;name:string;section:string;status?:string;inputs:Array<{id:string;type:string;options?:Array<{value:unknown}>}>};

export const askTool:ToolDefinition={
 name:"ask_user",
 description:"Ask the user clickable multiple-choice questions and pause until they answer. Use for pre-production choices (format, genre/style, runtime, video app/model, reference app, language). Options must be concrete and short. The user can always add free text or skip. Do not generate anything while questions are pending.",
 inputSchema:{type:"object",properties:{questions:z.toJSONSchema(questionInput.shape.questions,{io:"input"})},required:["questions"],additionalProperties:false},
};
/** The model may echo server-owned fields back from a get; accept them and strip them when drafting. */
function productionInputSchema(){
 const schema:any=z.toJSONSchema(productionContent,{io:"input"});
 Object.assign(schema.properties,{
  status:{type:"string",enum:["draft","approved"]},approvedAt:{type:"string"},approvedToolCount:{type:"number"},pilot:{type:"object"},
 });
 Object.assign(schema.properties.scenes.items.properties,{status:{type:"string"},job:{type:"string"}});
 return schema;
}
export const productionTool:ToolDefinition={
 name:"production_plan",
 description:"Read or draft the production plan: format, style, platform, runtime, aspect, sound, video engine, image engine, locked values, treatment and a scene script with per-scene prompts, seconds, dialogue lines and reference labels. Draft it after the production interview. The user approves it in the studio; this tool cannot approve it, and no video may be generated before approval. Total scene seconds must cover the requested runtime.",
 inputSchema:{type:"object",properties:{action:{type:"string",enum:["get","update"]},plan:productionInputSchema()},required:["action"],additionalProperties:false},
};

export function parseQuestions(raw:unknown){
 const parsed=questionInput.parse(raw);
 if(new Set(parsed.questions.map(q=>q.id)).size!==parsed.questions.length)throw new Error("Question ids must be unique");
 for(const q of parsed.questions)if(new Set(q.options.map(o=>o.label)).size!==q.options.length)throw new Error(`Question ${q.id} has duplicate option labels`);
 return parsed;
}

/** Validate answers against the pending questions. Labels are the only accepted answer values. */
export function parseAnswers(pending:PendingQuestions,raw:unknown){
 const parsed=answerInput.parse(raw);
 const byId=new Map(pending.questions.map(q=>[q.id,q]));
 for(const id of Object.keys(parsed.answers))if(!byId.has(id))throw new Error(`Unknown question ${id}`);
 const answers:InterviewAnswer[]=pending.questions.map(q=>{
  const selected=[...new Set((parsed.answers[q.id]||[]).map(s=>s.trim()).filter(Boolean))];
  if(!q.multiple&&selected.length>1)throw new Error(`Question ${q.id} accepts one choice`);
  for(const label of selected)if(!q.options.some(o=>o.label===label))throw new Error(`Option ${JSON.stringify(label)} is not offered by question ${q.id}`);
  return {id:q.id,header:q.header,question:q.question,selected};
 });
 if(!parsed.skip&&!answers.some(a=>a.selected.length)&&!parsed.notes.trim())throw new Error("Choose an option, add a note, or skip the questions");
 return {answers,notes:parsed.notes.trim(),skipped:parsed.skip};
}

export function formatSeconds(value:number){
 const total=Math.round(value*10)/10,minutes=Math.floor(total/60),seconds=total-minutes*60;
 return minutes?`${minutes}:${String(Math.floor(seconds)).padStart(2,"0")}`:`${total}s`;
}

function cleanPlan(raw:any){
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("Expected a production plan object");
 const {status,approvedAt,approvedToolCount,pilot,...content}=raw;
 content.scenes=Array.isArray(content.scenes)?content.scenes.map((s:any)=>{
  if(!s||typeof s!=="object")return s;
  const {status:sceneStatus,job,...rest}=s;
  return rest;
 }):content.scenes;
 return productionInput.parse(content);
}

export function draftProduction(c:Conversation,raw:unknown){
 const parsed=cleanPlan(raw);
 c.production={...parsed,scenes:parsed.scenes.map(s=>({...s,status:"planned",job:undefined})),status:"draft",pilot:{approved:false}};
 return c.production;
}

/** Structural checks that do not need the studio registry. */
export function structuralIssues(p:Production){
 const issues:string[]=[];
 if(new Set(p.scenes.map(s=>s.id)).size!==p.scenes.length)issues.push("Scene ids must be unique.");
 const total=p.scenes.reduce((sum,s)=>sum+s.seconds,0);
 if(total+0.25<p.durationSeconds)issues.push(`The scene plan covers ${formatSeconds(total)} but the requested runtime is ${formatSeconds(p.durationSeconds)}. Add scenes until the approved plan covers the full duration.`);
 if(p.sound==="dialogue"){
  const silent=p.scenes.filter(s=>!s.dialogue.some(d=>d.line.trim()));
  if(silent.length)issues.push(`Dialogue is required but these scenes have no line: ${silent.map(s=>s.title).join(", ")}. Add the spoken lines to each scene prompt and dialogue list, or choose a non-dialogue sound plan.`);
 }
 return issues;
}

/** App-aware checks used by the approval endpoint. */
export function approvalIssues(p:Production,apps?:EngineApp[]){
 const issues=structuralIssues(p);
 if(apps){
  const engine=apps.find(a=>a.id===p.engine);
  if(!engine)issues.push(`The planned video engine ${JSON.stringify(p.engine)} is not installed in this studio.`);
  else{
   if(engine.section!=="video")issues.push(`${engine.name} is not a video app. Choose the video engine that will produce the scenes.`);
   for(const [key,value] of Object.entries(p.lockedValues)){
    const input=engine.inputs.find(i=>i.id===key);
    if(!input)issues.push(`${engine.name} has no input named ${JSON.stringify(key)}.`);
    else if(["image","video","audio"].includes(input.type))issues.push(`${key} is a file input and cannot be locked to a value.`);
    else if(input.type==="select"&&input.options?.length&&!input.options.some(o=>o.value===value))issues.push(`${JSON.stringify(value)} is not a supported option for ${key}.`);
   }
  }
  if(p.imageEngine){
   const image=apps.find(a=>a.id===p.imageEngine);
   if(!image)issues.push(`The planned reference image engine ${JSON.stringify(p.imageEngine)} is not installed in this studio.`);
   else if(image.section!=="image")issues.push(`${image.name} is not an image app.`);
  }
  if(!p.imageEngine)issues.push("Choose the image engine that will build the character/location references.");
 }
 return issues;
}

/** The submitted values must carry an approved scene prompt (or its dialogue), so a paraphrase cannot silently replace the approved script. */
export function matchScene(p:Production,values:unknown){
 const text=JSON.stringify(values??{}).toLowerCase().replace(/\s+/g," ");
 const norm=(s:string)=>s.toLowerCase().replace(/\s+/g," ").trim();
 const byPrompt=p.scenes.find(s=>text.includes(norm(s.prompt).slice(0,80)));
 if(byPrompt)return byPrompt;
 let best:{scene:ProductionScene;lines:number}|undefined;
 for(const scene of p.scenes){
  const lines=scene.dialogue.filter(d=>text.includes(norm(d.line).slice(0,40))).length;
  if(lines&&(!best||lines>best.lines))best={scene,lines};
 }
 return best?.scene;
}

export function dialogueIncluded(scene:ProductionScene,values:unknown){
 const lines=scene.dialogue.map(d=>d.line.toLowerCase().replace(/\s+/g," ").trim().slice(0,40)).filter(Boolean);
 if(!lines.length)return true;
 const text=JSON.stringify(values??{}).toLowerCase().replace(/\s+/g," ");
 return lines.every(line=>text.includes(line));
}

/** Keep scene progress in sync with the recorded job states. */
export function syncProduction(c:Conversation){
 const p=c.production;if(!p)return;
 for(const scene of p.scenes){
  if(!scene.job)continue;
  const status=c.jobStates[scene.job]?.status;
  if(status==="succeeded")scene.status="generated";
  else if(["failed","canceled","lost","expired"].includes(status))scene.status="failed";
  else if(status)scene.status="generating";
 }
}

export function productionProgress(c:Conversation){
 const p=c.production;
 if(!p)return {plannedSeconds:0,producedSeconds:0,generated:0,total:0};
 const generated=p.scenes.filter(s=>s.status==="generated");
 return {plannedSeconds:p.durationSeconds,producedSeconds:Math.round(generated.reduce((sum,s)=>sum+s.seconds,0)*10)/10,generated:generated.length,total:p.scenes.length};
}

export function planSummary(p:Production){
 return {status:p.status,format:p.format,style:p.style,platform:p.platform,language:p.language,aspect:p.aspect,durationSeconds:p.durationSeconds,sound:p.sound,engine:p.engine,imageEngine:p.imageEngine,model:p.model,scenes:p.scenes.length,approvedAt:p.approvedAt,pilot:p.pilot};
}

export function validatePlan(p:Production){
 return productionSchema.parse(p);
}

export function approveProduction(c:Conversation,apps?:EngineApp[]){
 const p=c.production;if(!p)throw new Error("No production plan to approve");
 const issues=approvalIssues(p,apps);if(issues.length)throw new Error(`The production plan is not ready:\n- ${issues.join("\n- ")}`);
 p.status="approved";p.approvedAt=now();p.approvedToolCount=c.tools.length;p.pilot={approved:false};
 for(const scene of p.scenes){scene.status="planned";scene.job=undefined;}
 c.warnings=c.warnings.filter(w=>!w.startsWith("Studio check:")&&!w.startsWith("Pilot gate:"));
 return p;
}

export function approvePilot(c:Conversation,artifact:string){
 const p=c.production;if(!p||p.status!=="approved")throw new Error("No approved production plan");
 const media=c.artifacts.find(a=>a.id===artifact);
 if(!media||media.type!=="video")throw new Error("Choose a produced video clip to approve as the pilot");
 if(!media.job||!p.scenes.some(s=>s.job===media.job))throw new Error("This clip was not produced by an approved scene. Approve the pilot clip generated from the plan.");
 p.pilot={approved:true,artifact:media.id,at:now()};
 c.warnings=c.warnings.filter(w=>!w.startsWith("Pilot gate:"));
 return p;
}
