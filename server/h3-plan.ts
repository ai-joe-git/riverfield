import {z} from "zod";

const legal=(length:number)=>Number.isInteger(length)&&length>=5&&length<=3592&&(length-5)%17===0;
const imageSlots=z.array(z.number().int().min(0).max(8)).max(9),audioSlots=z.array(z.number().int().min(0).max(2)).max(3);
export const segmentRequest=z.object({seconds:z.number().min(5/24).max(150).describe("Requested duration of EACH generated segment, not total story duration"),total_seconds:z.number().positive().optional().describe("Optional total timeline duration to validate, including overlap"),prompts:z.array(z.string().trim().min(1).max(12000)).min(1).max(64),images:imageSlots.default([]),audios:audioSlots.default([]),segment_images:z.array(imageSlots).max(64).optional(),segment_audios:z.array(audioSlots).max(64).optional()});
/** Same frame geometry as the Material Planner. Arithmetic belongs in code, not in an LLM. */
export function planH3(raw:unknown){const {seconds,total_seconds,prompts,images,audios,segment_images,segment_audios}=segmentRequest.parse(raw);const length=Math.min(3592,5+17*Math.max(0,Math.round((seconds*24-5)/17)));const seam=[0,1,...Array.from({length:Math.max(0,Math.floor((length-6)/17)+1)},(_,i)=>5+17*i)].filter(n=>n<length).reduce((best,n)=>Math.abs(n-39)<Math.abs(best-39)?n:best,0);const stride=length-seam;
 for(const [name,slots] of [["segment_images",segment_images],["segment_audios",segment_audios]] as const)if(slots&&slots.length!==prompts.length)throw new Error(`${name} must have one entry per prompt`);
 const windows=prompts.map((prompt,i)=>({start:i*stride,end:i*stride+length,prompt,images:[...(segment_images?.[i]??images)],audios:[...(segment_audios?.[i]??audios)]})),total=windows.at(-1)!.end/24;
 if(total_seconds!==undefined&&Math.abs(total-total_seconds)>.5)throw new Error(`${prompts.length} segments of ${seconds}s overlap to ${total.toFixed(2)}s, not total_seconds=${total_seconds}. Change segment duration or prompt count; seconds is per segment.`);
 return {segment_windows:JSON.stringify({windows,videos:[],audios:[]}),frames:windows.at(-1)!.end,seconds:total,segmentSeconds:length/24,segmentFrames:length,overlapFrames:seam};}

/** Reject invalid plans before recording/queueing a GPU job. Do not silently rewrite user timelines. */
export function validateH3(values:Record<string,unknown>){
 let spec:any;const raw=values.segment_windows;
 if(raw){try{spec=typeof raw==="string"?JSON.parse(raw):raw;}catch{throw new Error("segment_windows must be valid JSON. Use plan_segments to construct aligned windows.");}
  if(!spec||!Array.isArray(spec.windows)||!spec.windows.length||spec.windows.length>64)throw new Error("segment_windows requires 1..64 windows");
 }
 const windows=spec?.windows;const prompts=windows?windows.map((w:any)=>w?.prompt):String(values.segment_prompts||"").split(/\r?\n/).map(p=>p.trim()).filter(Boolean);
 const count=windows?.length||Number(values.segment_count||1);
 const hasLocal=prompts.some((p:any)=>typeof p==="string"&&p.trim());
 if(hasLocal&&(prompts.length<count||prompts.some((p:any)=>typeof p!=="string"||!p.trim())))throw new Error("Segment prompt mode requires a non-empty prompt for every segment (even with global_prompt)");
 if(!hasLocal&&!String(values.global_prompt||"").trim())throw new Error("Enter global_prompt or a non-empty prompt for every segment before generation");
 if(!windows)return;
 let previous:any;
 for(const [i,w] of windows.entries()){
  if(!w||!Number.isInteger(w.start)||!Number.isInteger(w.end)||w.start<0||!legal(w.end-w.start))throw new Error(`Segment ${i+1}: integer boundaries and length 5 + 17*n (5..3592 frames) required. Use plan_segments.`);
  const overlap=previous?previous.end-w.start:0;
  if((!previous&&w.start!==0)||(previous&&(w.start<=previous.start||w.end<=previous.end||overlap<0||overlap>=Math.min(previous.end-previous.start,w.end-w.start)||(overlap!==0&&overlap!==1&&!legal(overlap)))))throw new Error(`Segment ${i+1}: windows must advance without gaps, with overlap 0, 1 or 5 + 17*n frames. Use plan_segments.`);
  for(const [key,type,max] of [["images","image",9],["audios","audio",3]] as const){if(w[key]!==undefined&&(!Array.isArray(w[key])||w[key].some((n:any)=>!Number.isInteger(n)||n<0||n>=max||!values[`${type}${n+1}`])))throw new Error(`Segment ${i+1}: ${key} must refer to supplied file slots (zero based)`);}
  previous=w;
 }
}
