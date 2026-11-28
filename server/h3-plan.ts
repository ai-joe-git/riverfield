import {z} from "zod";
import { InputError } from "./input-error.ts";

const nativeFrames = (seconds: number) => Math.min(3592, 5 + 17 * Math.max(0, Math.round((seconds * 24 - 5) / 17)));
const legal=(length:number)=>Number.isInteger(length)&&length>=5&&length<=3592&&(length-5)%17===0;
const imageSlots=z.array(z.number().int().min(0).max(8)).max(9),audioSlots=z.array(z.number().int().min(0).max(2)).max(3);
export const segmentRequest=z.object({seconds:z.number().min(5/24).max(150).describe("Requested duration of EACH generated segment, not total story duration"),total_seconds:z.number().positive().optional().describe("Optional total timeline duration to validate, including overlap"),overlap_frames:z.number().int().min(0).max(3591).optional().describe("Defaults to 0 (hard cuts). Set a legal overlap explicitly only to extend the same continuous camera take, for example beyond 15 seconds."),prompts:z.array(z.string().trim().min(1).max(12000)).min(1).max(64),images:imageSlots.default([]),audios:audioSlots.default([]),segment_images:z.array(imageSlots).max(64).optional(),segment_audios:z.array(audioSlots).max(64).optional()});
/** Same frame geometry as the Material Planner. Arithmetic belongs in code, not in an LLM. */
export function planH3(raw:unknown){const {seconds,total_seconds,overlap_frames,prompts,images,audios,segment_images,segment_audios}=segmentRequest.parse(raw);const length=nativeFrames(seconds);const seam=overlap_frames??0;
 if(seam>=length||(seam!==0&&seam!==1&&!legal(seam)))throw new Error("Overlap must be 0, 1 or 5 + 17*n frames and shorter than the segment.");
 const stride=length-seam;
 for(const [name,slots] of [["segment_images",segment_images],["segment_audios",segment_audios]] as const)if(slots&&slots.length!==prompts.length)throw new Error(`${name} must have one entry per prompt`);
 const windows=prompts.map((prompt,i)=>({start:i*stride,end:i*stride+length,prompt,images:[...(segment_images?.[i]??images)],audios:[...(segment_audios?.[i]??audios)]})),total=windows.at(-1)!.end/24;
 if(total_seconds!==undefined&&Math.abs(total-total_seconds)>.5)throw new Error(`${prompts.length} segments of ${seconds}s overlap to ${total.toFixed(2)}s, not total_seconds=${total_seconds}. Change segment duration or prompt count; seconds is per segment.`);
 return {segment_windows:JSON.stringify({windows,videos:[],audios:[]}),frames:windows.at(-1)!.end,seconds:total,segmentSeconds:length/24,segmentFrames:length,overlapFrames:seam,promptValidation:"not_performed"};}

/** Stable Agent/MCP profile. Manual Director timelines and other H3 apps remain editable. */
export const DIRECTOR_DEFAULTS={segmentSeconds:7.3,segmentFrames:175,overlapFrames:0,fps:24} as const;
export const DIRECTOR_MANAGED_INPUTS=["duration","start_seconds","clip_name","detail","multiple","sla","format","codec","filename_prefix"] as const;
export const DIRECTOR_DELIVERY={app:"relayvsr-upscale",defaultScale:"x2",options:["off","x2","x4"],separateRun:true,requiresSucceededVideo:true,pixelAreaMultipliers:{x2:4,x4:16}} as const;
export function directorDurations(){return [1,2,3,5].map(segments=>{
 const plan=planH3({seconds:DIRECTOR_DEFAULTS.segmentSeconds,prompts:Array(segments).fill("Timing only")});
 return {segments,frames:plan.frames,seconds:plan.seconds,label:`${plan.seconds.toFixed(2)} s (${segments} ${segments===1?"segment":"segments"})`,description:"Native Director duration with hard cuts. Other story targets can be entered as free text."};
});}
export const directorRequest=segmentRequest.omit({seconds:true,overlap_frames:true}).extend({total_seconds:z.number().positive().optional().describe("Approximate desired story duration; selects a native segment count, never an exact-duration rejection"),prompts:z.array(z.string().trim().min(1).max(12000)).max(64).default([]).describe("One complete prompt per native window; omit initially to obtain the required count")});
export function planDirectorSegments(raw:unknown){
 const args=directorRequest.parse(raw),{fps,segmentFrames,overlapFrames}=DIRECTOR_DEFAULTS;
 const count=args.total_seconds===undefined?Math.max(1,args.prompts.length):Math.max(1,Math.min(64,1+Math.round((args.total_seconds*fps-segmentFrames)/(segmentFrames-overlapFrames))));
 const geometry=planH3({seconds:DIRECTOR_DEFAULTS.segmentSeconds,prompts:Array(count).fill("Pending prompt")});
 const base={...geometry,requestedSeconds:args.total_seconds??null,requiredPrompts:count,defaults:DIRECTOR_DEFAULTS};
 if(args.prompts.length!==count){const {segment_windows,...metadata}=base;return {...metadata,segment_windows:undefined,ready:false,windows:JSON.parse(segment_windows).windows.map((w:any)=>({...w,prompt:""})),receivedPrompts:args.prompts.length,note:`Write exactly ${count} segment prompts for the native windows. Do not change segment duration or overlap. Requested story duration is approximate.`};}
 const plan=planH3({...args,seconds:DIRECTOR_DEFAULTS.segmentSeconds,total_seconds:undefined});
 return {...base,...plan,ready:true};
}

/** Normalize only the automated Pika path, BEFORE approval, without changing creative text/materials. */
export function directorValues(values:Record<string,unknown>,files?:Record<string,unknown>):Record<string,unknown>{
 const out={...values,duration:DIRECTOR_DEFAULTS.segmentSeconds,start_seconds:0};
 if(values.flex_mode===undefined&&files!==undefined)(out as Record<string,unknown>).flex_mode=Object.entries(files).some(([key,value])=>/^(image|video)\d+$/.test(key)&&value)?"ref2va":"fl2va";
 // Actual manifest defaults own technical settings, not the model.
 for(const key of DIRECTOR_MANAGED_INPUTS)if(key!=="duration"&&key!=="start_seconds")delete (out as Record<string,unknown>)[key];
 if(!values.segment_windows)return out;
 let spec:any;try{spec=typeof values.segment_windows==="string"?JSON.parse(values.segment_windows):values.segment_windows;}catch{return out;}
 if(!Array.isArray(spec?.windows)||!spec.windows.length||spec.windows.length>64)return out;
 const geometry=JSON.parse(planH3({seconds:DIRECTOR_DEFAULTS.segmentSeconds,prompts:spec.windows.map(()=>"Pending prompt")}).segment_windows);
 return {...out,segment_count:spec.windows.length,segment_windows:JSON.stringify({...spec,windows:spec.windows.map((w:any,i:number)=>({...w,start:geometry.windows[i].start,end:geometry.windows[i].end}))})};
}

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

/** Render checkpoint names and editor intent are independent. A text-only run can use the FL2VA checkpoint. */
export function directorPromptMode(input: { flexMode?: string; hasVisual: boolean; ltx?: boolean; first?: boolean; last?: boolean }) {
  if (input.ltx) {
    if (input.first && input.last) return "first_last";
    if (input.first) return "first_frame";
    if (input.last) return "last_frame";
    return "t2v";
  }
  if (input.first && input.last) return "fl2va";
  if (input.first) return "i2va";
  if (input.last) return "l2va";
  return input.hasVisual && input.flexMode !== "fl2va" ? "ref2va" : "t2va";
}

const stableIds = (max: number) => z.array(z.string().min(1).max(160)).max(max).default([]);
export const directorBatchInput = z.object({
  productionId: z.string().min(1).max(160),
  segments: z.array(z.object({
    seconds: z.number().min(5 / 24).max(150).optional().describe("Approximate segment duration in seconds. Riverfield aligns it."),
    frames: z.number().int().min(5).max(3592).optional().describe("Use only to preserve an existing native frame count."),
    brief: z.string().trim().min(1).max(10000).describe('One or two plain sentences, for example Daichi opens the window and says "It is cold."'),
    dialogue: z.array(z.string().min(1).max(700)).max(24).default([]).describe("Optional plain dialogue lines. You can put them in the brief instead."),
    imageAssetIds: stableIds(9), audioAssetIds: stableIds(3),
  })).min(1).max(64),
});

/** Partition an ordered, hard-cut Flash timeline only where the manifest caps or render mode require it. */
export function planDirectorBatches(raw: z.infer<typeof directorBatchInput>, capacity: { image: number; audio: number }) {
  type Window = { start: number; end: number; prompt: string; images: number[]; audios: number[]; dialogue?: string[] };
  type Batch = { mode: "ref2va" | "fl2va"; images: string[]; audios: string[]; windows: Window[]; sourceStart: number };
  const groups: Batch[] = [];
  const episodeFrames: { segment: number; start: number; end: number }[] = [];
  let position = 0;
  for (const [index, segment] of raw.segments.entries()) {
    if ((segment.seconds === undefined) === (segment.frames === undefined))
      throw new InputError(`Segment ${index + 1}: supply seconds, or frames for an existing native duration.`);
    const frames = segment.frames ?? nativeFrames(segment.seconds!);
    if (!legal(frames)) throw new InputError(`Segment ${index + 1}: frames must be 5 + 17*n. Supply seconds for automatic timing.`);
    const { imageAssetIds, audioAssetIds } = segment;
    if (imageAssetIds.length > capacity.image || audioAssetIds.length > capacity.audio ||
        new Set(imageAssetIds).size !== imageAssetIds.length || new Set(audioAssetIds).size !== audioAssetIds.length)
      throw new InputError(`Segment ${index + 1} has duplicate references or exceeds the native media slots.`);
    if (segment.dialogue.some(line => /<\/?d>/i.test(line))) throw new InputError("Supply dialogue lines without wrapper tags.");
    const mode = imageAssetIds.length ? "ref2va" : "fl2va";
    const missing = (from: string[], used: string[]) => from.filter(id => !used.includes(id));
    let batch = groups.at(-1);
    if (!batch || batch.mode !== mode || batch.images.length + missing(imageAssetIds, batch.images).length > capacity.image ||
        batch.audios.length + missing(audioAssetIds, batch.audios).length > capacity.audio) {
      batch = { mode, images: [], audios: [], windows: [], sourceStart: position };
      groups.push(batch);
    }
    batch.images.push(...missing(imageAssetIds, batch.images));
    batch.audios.push(...missing(audioAssetIds, batch.audios));
    const start = position - batch.sourceStart;
    const prompt = segment.dialogue.length ? `${segment.brief}\nDialogue:\n${segment.dialogue.join("\n")}` : segment.brief;
    if (prompt.length > 12000) throw new InputError(`Segment ${index + 1} exceeds the 12,000-character brief and dialogue limit.`);
    batch.windows.push({ start, end: start + frames, prompt, ...(segment.dialogue.length ? { dialogue:segment.dialogue } : {}),
      images: imageAssetIds.map(id => batch.images.indexOf(id)), audios: audioAssetIds.map(id => batch.audios.indexOf(id)) });
    episodeFrames.push({ segment: index + 1, start: position, end: position + frames });
    position += frames;
  }
  return { fps: 24, frames: position, seconds: position / 24, episodeFrames,
    batches: groups.map((batch, index) => ({ index: index + 1, sourceStart: batch.sourceStart,
      frames: batch.windows.at(-1)!.end, app: "h3-studio-director-flash",
      values: { production_id: raw.productionId, prompt_enhancer: true, flex_mode: batch.mode,
        segment_windows: { windows: batch.windows, videos: [], audios: [] } },
      asset_ids: Object.fromEntries([...batch.images.map((id, i) => [`image${i + 1}`, id]),
        ...batch.audios.map((id, i) => [`audio${i + 1}`, id])]),
    })),
  };
}
