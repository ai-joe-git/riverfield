// Local prompt compilation, not Pika's hosted rewriter or MiniMax's hosted Context-IR.
import type { App } from "./registry.ts";
import {shotPrompt} from "./autoshorts-continuity.ts";
export const RECIPE_VERSION=1;
export const PROMPT_SOURCES={
  pika:"https://github.com/Pika-Labs/Pika-H3-Flex/blob/main/docs/prompt-guidance.md",
  h3:"https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/README.md#prompting-guidance",
};
export function recipeFor(app:Pick<App,"id"|"inputs">,cinema=false){
  const pika=app.id.startsWith("pika-")||app.id==="h3-r2v-flex";
  const ref=["h3-r2v","h3-r2v-flex","studio-director","pika-studio-director"].includes(app.id);
  const endpoints=app.inputs.some(i=>i.id==="first_frame");
  const effectiveEngine=cinema&&app.id==="pika-text-to-video"?"pika-video":app.id;
  const conditioning=ref?"ref2va":endpoints||effectiveEngine==="pika-video"?"fl2va":"t2va";
  const supported=pika||app.id.startsWith("h3-")||app.id==="studio-director";
  return {id:`${supported?pika?"pika":"minimax-h3":"custom"}-${conditioning}`,version:RECIPE_VERSION,
    family:!supported?"Custom workflow":pika?"Pika H3 Flex":"MiniMax H3",conditioning,effectiveEngine,supported,
    cinemaSupported:supported&&conditioning!=="t2va",needsKeyframe:conditioning==="fl2va"||ref,
    endpointFrames:conditioning==="fl2va",source:pika?PROMPT_SOURCES.pika:PROMPT_SOURCES.h3,
    guidance:conditioning==="ref2va"
      ? "Ref2VA: subject_definitions, summary [reference generation], retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Map actual ordered <Picture N> to canonical <Subject N>; preserve defined features without showing sheets. Use stable (S1) speaker IDs and <d>[Language]exact dialogue</d>."
      : "T2VA/FL2VA: integrated_multimodal_description [Shot 1], overall_soundscape, non_diegetic_music. FL2VA starts with the actual endpoint-image alignment. Describe one continuous shot, actions in causal order, camera speed/amplitude and final state. Use stable (S1) speaker IDs and <d>[Language]exact dialogue</d>.",
  };
}
export type MediaBinding={input:string;path:string;role:"identity"|"setting"|"prop"|"first-frame"|"last-frame";entity?:string;description:string};
const languages:Record<string,string>={en:"English",fr:"French",es:"Spanish",de:"German",it:"Italian",pt:"Portuguese",ar:"Arabic",ja:"Japanese",ko:"Korean",zh:"Chinese",ru:"Russian"};
export function compileVideoPrompt(recipe:ReturnType<typeof recipeFor>,scene:any,bible:any,bindings:MediaBinding[],language:string,native=true){
  const d=scene.direction||{},characters=(bible?.entities||[]).filter((e:any)=>e.kind==="character");
  const speakers=characters.map((e:any,i:number)=>({id:e.id,label:`S${i+1}`,description:e.description,voice:e.traits?.voice||""}));
  const lines=scene.dialogueLines?.length?scene.dialogueLines:scene.dialogue?.trim()?[{speakerId:characters.length===1?characters[0].id:"",text:scene.dialogue,delivery:""}]:[];
  const words=lines.reduce((n:number,l:any)=>n+String(l.text).trim().split(/\s+/).length,0),warnings:string[]=[];
  if(words>scene.duration*3)warnings.push("Dialogue is dense for this shot duration. Shorten it or split the shot; native delivery timing is not guaranteed.");
  const finish=(prompt:string)=>{if(recipe.family==="Pika H3 Flex"&&prompt.length>8000)throw new Error(`${scene.id}: compiled Pika prompt exceeds 8000 characters; shorten descriptions rather than silently truncating identities`);return {prompt,speakers,bindings,warnings};};
  if(native&&lines.length&&characters.length>1&&lines.some((l:any)=>!l.speakerId))throw new Error(`${scene.id}: assign each dialogue line to a canonical speaker; a free-form dialogue string is ambiguous with several characters`);
  const spoken=native?lines.map((line:any)=>{
    const speaker=speakers.find((s:any)=>s.id===line.speakerId);
    if(bible&&!speaker)throw new Error(`${scene.id}: unknown dialogue speaker ${line.speakerId}`);
    const text=String(line.text).replace(/<\/?d>/gi,"");
    return `${speaker?.id||"The character"} (${speaker?.label||"S1"}) says ${line.delivery||speaker?.voice||"naturally, with visible synchronized lip movement"}, <d>[${languages[line.language||language]||line.language||language}] ${text}</d>. The listener reacts silently; only this speaker mouths this line.`;
  }).join("\n"):"";
  const body=shotPrompt(bible,{...scene,dialogue:""});
  const visuals=`${body}\nOne continuous shot; no montage or unrequested cuts. ${d.framing||""}. ${d.camera||""}. ${d.action||""}\nOpening state: ${d.startState||scene.continuity?.notes||scene.visual}.\nEnding state: ${d.endState||"Hold the visible result of the described action"}. ${d.emotion||""}.\n${spoken||"No spoken dialogue; preserve non-verbal performances."}\nComplete action and any spoken line by ${Math.max(.5,scene.duration-.4).toFixed(2)} seconds, then hold the ending state for the cut; do not begin extra dialogue in the frame-grid tail.\nNo external narrator in the generated clip; any explicitly enabled TTS is mixed separately. No subtitles, labels or unrequested text.`;
  const sound=scene.speechMode==="mute"?"N/A":d.soundscape||"Natural location ambience and physical sounds synchronized to the described actions. No extra voices; do not repeat the dialogue as narration.";
  const music=d.music?.trim()||"N/A";
  const images=bindings.filter(b=>/\.(png|jpg|jpeg|webp)$/i.test(b.path));
  if(recipe.conditioning==="ref2va"){
    if(!images.length)throw new Error(`${scene.id}: Ref2VA requires actual visual reference inputs`);
    const definitions=images.map((b,i)=>`<Subject ${i+1}> is ${b.description} from <Picture ${i+1}> (${b.role}${b.entity?`, canonical ${b.entity}`:""}).`);
    const retention=images.map((b,i)=>`<Subject ${i+1}>: ${b.role==="first-frame"||b.role==="last-frame"?"attribute_transfer - use only the shot composition and pose":"fully_preserved - retain only the defined identity, vehicle geometry, wardrobe or location features"}. Show one coherent scene, never reference-sheet panels, labels or duplicate views.`);
    return finish(`subject_definitions:\n${definitions.join("\n")}\n\nsummary:\n[reference generation] ${scene.visual}\n\nretention_analysis:\n${retention.join("\n")}\n\ndetailed_description:\n[Shot 1] ${visuals}\n\noverall_soundscape:\n${sound}\n\nnon_diegetic_music:\n${music}`);
  }
  let alignment="";
  if(recipe.conditioning==="fl2va"){
    const first=images.findIndex(b=>b.role==="first-frame"),last=images.findIndex(b=>b.role==="last-frame");
    if(first<0)throw new Error(`${scene.id}: FL2VA Cinema needs an approved opening keyframe`);
    const frames=Math.max(5,Math.round(scene.duration*24)),seconds=(frames+(5-frames%17+17)%17)/24;
    alignment=`For the target video, at 0.00 seconds into the target video, <Picture ${first+1}> (from [Shot 1]) is fully referenced.`;
    if(last>=0)alignment+=` <Picture ${last+1}> (from [Shot 1]) aligns with the ${seconds.toFixed(2)}-second mark. Begin from the first frame and develop continuous action to the ending frame.`;
    alignment+="\n\n";
  }
  return finish(`${alignment}integrated_multimodal_description:\n[Shot 1] ${visuals}\n\noverall_soundscape:\n${sound}\n\nnon_diegetic_music:\n${music}`);
}

export function canonicalImagePrompt(entity:any,bible:any,engine:string){
  const role=entity.kind==="character"?"One single canonical actor, clear recognizable face and full wardrobe, natural proportions; no duplicate people or alternate views"
    :entity.kind==="vehicle"?"One single complete vehicle, three-quarter product view; preserve exact body model, color, wheel geometry and accessories; no people or driver"
    :entity.kind==="setting"?"One empty establishing location, coherent architecture and geography; no people, vehicles or signage"
    :"One isolated canonical prop, readable shape/material/scale; no hands or duplicate objects";
  return `${engine.startsWith("z-image")?"A precise photographic still":"Create one photographic reference image"}. ${role}. ${entity.description}. ${JSON.stringify(entity.traits)}. ${bible.style}. Time: ${bible.timeOfDay}. Lighting: ${bible.lighting}. No collage, contact sheet, labels, text, watermarks or video action sequence.`;
}
export function keyframeImagePrompt(scene:any,bible:any,labels:string[],endpoint:"first"|"last"="first"){
  const d=scene.direction||{};
  const fromNotes=scene.continuity?.notes?.match(endpoint==="first"?/Start:\s*([\s\S]*?)(?:\s*End:|$)/i:/End:\s*([\s\S]*)/i)?.[1];
  const pose=endpoint==="first"?d.startState||fromNotes||scene.visual:d.endState||fromNotes||scene.visual;
  const identities=(bible.entities||[]).filter((e:any)=>scene.continuity?.entityIds.includes(e.id)).map((e:any)=>`${e.id}: ${e.description}. Traits: ${JSON.stringify(e.traits)}. Count: ${scene.continuity.counts[e.id]??1}.`).join("\n");
  return `IMAGE EDIT: compose ONE cinematic still, not a collage. Input tiles in row-major order: ${labels.join(", ")}. Use each tile only for the named canonical identity, vehicle, setting or prop. Remove tile panels, labels and borders.\n${identities}\nStyle: ${bible.style}. Time: ${scene.continuity.timeOfDay}. Lighting: ${scene.continuity.lighting}.\nFraming: ${d.framing||"scene-specific composition"}. Camera placement: ${d.camera||"as described in the shot"}.\nDepict ONLY the ${endpoint==="first"?"OPENING":"ENDING"} state: ${pose}. Do not combine sequential actions or show an action montage. Preserve actor count, face, wardrobe, car geometry and location. No subtitles, text or watermarks.`;
}
