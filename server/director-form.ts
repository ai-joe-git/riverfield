import {z} from "zod";
import type {Conversation} from "./agent-store.ts";
import {planDirectorSegments,directorValues} from "./h3-plan.ts";
import {promptGuidance} from "../mcp/prompt-guidance.ts";
import {validateDirectorContent} from "./director-content.ts";

const text=z.string().max(6000);
export const directorFormSchema=z.object({
 mode:z.enum(["ref2va","fl2va"]),count:z.number().int().min(1).max(8),aspect:z.enum(["9:16 (Portrait Widescreen)","16:9 (Widescreen)","1:1 (Square)"]),megapixels:z.union([z.literal(.4),z.literal(.8)]),relay:z.enum(["off","x2","x4"]),language:z.enum(["French","English","Spanish","Japanese","Chinese"]),
 brief:text,scenario:text,environment:text,environmentAsset:z.string(),audioAsset:z.string(),audioMode:z.enum(["reference","locked"]),reviewed:z.boolean(),
 actors:z.array(z.object({name:z.string().min(1).max(80),description:text,asset:z.string()})).min(1).max(3),
 segments:z.array(z.object({action:text,dialogue:z.array(z.string().max(500)).max(3),sound:text,music:text})).min(1).max(8),
 chatStep:z.enum(["duration","resolution","relay","cast","brief","story","draft","references","render","settings","aspect","mode","language","edit","editReference","confirmEdit","pickReference","pickAudio"]).optional(),
 chatReturn:z.string().optional(),chatField:z.string().optional(),chatTarget:z.string().optional(),chatCorrection:text.optional(),
 staleTargets:z.array(z.string()).optional(),
 promptsStale:z.boolean().optional(),
}).refine(f=>f.segments.length===f.count,"One prompt is required per segment");
export type DirectorForm=z.infer<typeof directorFormSchema>;
export const blankSegment=()=>({action:"",dialogue:["","",""],sound:"Quiet natural room tone.",music:"N/A"});
export function defaultDirectorForm():DirectorForm{return {mode:"ref2va",count:1,aspect:"9:16 (Portrait Widescreen)",megapixels:.4,relay:"x2",language:"English",brief:"",scenario:"",environment:"",environmentAsset:"",audioAsset:"",audioMode:"reference",reviewed:false,actors:[{name:"Character 1",description:"",asset:""}],segments:[blankSegment()]};}
const line=(s:string)=>s.replace(/[\r\n]+/g," ").trim(),esc=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
/** Mechanical repair of misrouted dialogue and leaked section headings; it never invents or rewrites a spoken line. */
export function normalizeDirectorDialogue(f:DirectorForm){
 const changes:string[]=[],heading=/\[(?:visual directions|dialogue|action|sound|music|shot\s*\d+)\]/gi;
 const tidy=(s:string)=>s.replace(heading," ").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").replace(/[ \t]{2,}/g," ").trim();
 const normalized=(s:string)=>s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
 const speakers=f.actors.map((a,i)=>({index:i,name:normalized(a.name.replace(/^the\s+/i,""))})).filter(a=>a.name);
 const speaker=(raw:string)=>{const value=raw.trim().replace(/^\[dialogue\]\s*/i,"").trim(),numbered=/^\(?S(\d+)\)?$/i.exec(value);if(numbered)return Number(numbered[1])-1;return speakers.find(a=>a.name===normalized(value))?.index??-1;};
 const clean=(value:string,where:string)=>{const next=tidy(value);if(next!==value)changes.push(`Removed leaked section headings from ${where}.`);return next;};
 f.scenario=clean(f.scenario,"the story");f.environment=clean(f.environment,"the environment");
 f.segments.forEach((s,i)=>{
  const original=s.action,kept:string[]=[];
  for(const raw of original.replace(heading,"\n").split(/\n/)){
   const text=raw.trim();if(!text)continue;
   const match=/^(?:\[dialogue\]\s*)?(.{1,60}?)\s*:\s*(.+)$/i.exec(text),index=match?speaker(match[1]):-1;
   if(index>=0&&index<f.actors.length){
    const words=match![2].trim().replace(/^["“]|["”]$/g,"").trim();
    if(words&&!s.dialogue[index]?.trim()){s.dialogue[index]=words;changes.push(`Moved ${f.actors[index].name}'s spoken line out of the visual action in segment ${i+1}.`);continue;}
    if(words&&s.dialogue[index]?.trim()===words)continue;
   }
   kept.push(text);
  }
  const action=tidy(kept.join("\n"));if(action!==original){s.action=action;changes.push(`Cleaned the visual action in segment ${i+1}.`);}
  for(const key of ["sound","music"] as const){const next=tidy(s[key]);if(next!==s[key]){s[key]=next;changes.push(`Removed leaked section headings from segment ${i+1} ${key}.`);}}
 });
 return changes;
}
const identityKey=(s:string)=>s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
const castPlaceholder=(name:string)=>/^(?:Character|Personnage) \d+$/.test(name.trim());
const castStop=new Set(("the a an in at on he she they it their his her this that these those what why how when where who which is are was were do does did but and so then now later meanwhile final first second third one two three yes no okay well look wait hey hi hello thanks please sorry maybe of for with from as if because while after before during under over between around through against without about into onto upon toward towards across along behind beyond near off out up down another each every some any all both few many most none such only just even still yet ever never always sometimes often again once twice here there").split(" "));
/** Fill placeholder cast slots from names introduced in the approved story; never invents a name. */
export function assignStoryCastNames(f:DirectorForm){
 const names:string[]=[],seen=new Set<string>();
 const re=/(?<![\p{L}\p{N}])(\p{Lu}[\p{L}'’-]{1,20})(?=,|\s+(?:says|asks|whispers|replies|retorts|stares|watches|approaches|wipes|pauses|leans|freezes|holds|stands|sits|enters|looks|turns|nods|shrugs|smiles|sighs|mutters|shouts|adds|continues|explains|admits|answers|mumbles|grumbles|snaps|yells|calls|tells|begins|starts|stops|waits|walks|runs|opens|closes|picks|pulls|pushes|takes|gives|puts|sets|drops|catches|throws|grabs|reaches|points|waves|shakes|is|are|was|were|has|have|had)\b)/gu;
 for(const m of f.scenario.matchAll(re)){const name=m[1].trim(),key=identityKey(name);if(!key||castStop.has(key)||seen.has(key))continue;seen.add(key);names.push(name);}
 if(names.length<f.actors.length)return [];
 const used=new Set(f.actors.filter(a=>!castPlaceholder(a.name)).map(a=>identityKey(a.name))),assigned:string[]=[];let cursor=0;
 for(const a of f.actors){if(!castPlaceholder(a.name))continue;while(cursor<names.length&&used.has(identityKey(names[cursor])))cursor++;if(cursor>=names.length)break;const name=names[cursor++];a.name=name;used.add(identityKey(name));assigned.push(name);}
 return assigned;
}
/** Text-level checks only, not a claim of visual identity verification. */
export function duplicateDirectorActors(f:DirectorForm){
 const duplicate=new Set<number>();
 for(let i=0;i<f.actors.length;i++)for(let j=0;j<i;j++){
  const a=f.actors[i],b=f.actors[j],words=(s:string)=>new Set(identityKey(s).split(" ").filter(Boolean)),aw=words(a.description),bw=words(b.description),overlap=[...aw].filter(w=>bw.has(w)).length;
  if(identityKey(a.name)===identityKey(b.name)||a.description.trim()&&b.description.trim()&&(identityKey(a.description)===identityKey(b.description)||Math.min(aw.size,bw.size)>=12&&overlap/Math.max(aw.size,bw.size)>.85))duplicate.add(i);
 }return [...duplicate];
}
export function validateDirectorCast(f:DirectorForm){if(duplicateDirectorActors(f).length)throw new Error("Duplicate character names or descriptions. Repair and review the cast before generating references or video.");}
export function invalidateDirectorOutput(f:DirectorForm){f.staleTargets=[...new Set([...(f.staleTargets||[]),"video","relay"])];}
export function invalidateDirectorReference(f:DirectorForm,target:string){invalidateDirectorOutput(f);f.reviewed=false;f.staleTargets=[...new Set([...(f.staleTargets||[]),target])];if(target==="environment")f.environmentAsset="";else if(target.startsWith("actor:")){const a=f.actors[Number(target.split(":")[1])];if(a)a.asset="";}}
export function formAsset(c:Conversation,target:string,explicit=""){
 const known=[...c.artifacts,...c.attachments];
  if(explicit){const a=known.find(a=>a.id===explicit);if(!a)throw new Error("Unknown reference");return a;}
 if(c.director?.staleTargets?.includes(target))return undefined;
 const run=c.tools.findLast(t=>t.guidedTarget===target);
 return run?.job?c.artifacts.find(a=>a.job===run.job&&a.type===(target==="video"||target==="relay"?"video":"image")):undefined;
}
export function compileDirectorRun(c:Conversation,action:string,index=0,instruction=""):{app:string;values:Record<string,unknown>;files:Record<string,string>;target:string}{
 const f=directorFormSchema.parse(c.director||defaultDirectorForm()),files:Record<string,string>={};
 if(action==="actor"||action==="video")validateDirectorCast(f);
 if(action==="actor"||action==="environment"){
  const actor=f.actors[index];if(action==="actor"&&!actor)throw new Error("Unknown character");
  const description=action==="actor"?actor.description:f.environment;if(!description.trim())throw new Error("Write the description first");
  const template=promptGuidance({id:"moss-turbo",inputs:[]}).templates!.character_sheet;
  return {app:"moss-turbo",values:{prompt:action==="actor"?template.replace("[IDENTITY, FACE, HAIR, BUILD, COMPLETE OUTFIT INCLUDING SHOES]",`${actor.name}: ${line(description)}`):`Photorealistic EMPTY environment reference: ${line(description)}. One coherent location, no people, no faces, no silhouettes, no character sheet, no text or labels.`,rewrite:false,steps:8,cfg:1.5,aspect:action==="actor"?"16:9 (Widescreen)":f.aspect},files,target:action==="actor"?`actor:${index}`:"environment"};
 }
 if(action==="edit"){
  const target=index<0?"environment":`actor:${index}`,a=formAsset(c,target,index<0?f.environmentAsset:f.actors[index]?.asset);if(!a||!instruction.trim())throw new Error("Choose a reference and describe the correction");
  return {app:"qwen-image-edit-turbo",values:{instruction:`Edit <image1>: ${instruction}. Preserve all unrequested attributes and identity.`},files:{image:a.path},target};
 }
 if(action==="relay"){
  if(f.relay==="off")throw new Error("RelayVSR is disabled");
  const a=formAsset(c,"video");if(!a||!("type" in a)||a.type!=="video")throw new Error("Wait for a successful Pika video");
  return {app:"relayvsr-upscale",values:{unet_name:f.relay==="x2"?"relayvsr_x2_lightx2v_int8_convrot.safetensors":"relayvsr_x4_int8_convrot.safetensors"},files:{video:a.path},target:"relay"};
 }
 if(action!=="video")throw new Error("Unknown action");
 if(f.promptsStale)throw new Error("Prepare and review shot prompts after changing the story or cast before rendering");
 validateDirectorContent(f);
 let definitions=f.actors.map((a,i)=>`(S${i+1}) is ${line(a.name)}.`).join("\n");
 const imageSlots:number[]=[];
 if(f.mode==="ref2va"){
  if(!f.reviewed)throw new Error("Review and approve the references before rendering");
  definitions=f.actors.map((a,i)=>{const ref=formAsset(c,`actor:${i}`,a.asset);if(!ref)throw new Error(`Missing reference for ${a.name}`);files[`image${i+1}`]=ref.path;imageSlots.push(i);return `<Subject ${i+1}> is ${line(a.name)} from <Picture ${i+1}>, preserving only this single person's identity and wardrobe. (S${i+1}) is ${line(a.name)}.`;}).join("\n");
  const env=formAsset(c,"environment",f.environmentAsset);if(!env)throw new Error("Missing environment reference");files[`image${f.actors.length+1}`]=env.path;imageSlots.push(f.actors.length);definitions+=`\n<Subject ${f.actors.length+1}> is the environment from <Picture ${f.actors.length+1}>, preserving its layout and lighting.`;
 }
 const audioSlots:number[]=[];
 if(f.audioAsset){if(f.mode!=="ref2va")throw new Error("Audio references require Ref2VA with visual references in this app");const a=formAsset(c,"audio",f.audioAsset)!;files.audio1=a.path;audioSlots.push(0);if(f.audioMode==="reference")definitions+="\n<Audio 1> supplies the selected sound reference.";}
 const retention=f.actors.map((_,i)=>`<Subject ${i+1}>: fully_preserved - retain identity and wardrobe; never display sheet panels or alternate views.`).join("\n")+`\n<Subject ${f.actors.length+1}>: fully_preserved - retain environment layout and lighting.`+(audioSlots.length&&f.audioMode==="reference"?"\n<Audio 1>: reference - borrow the selected sound characteristics.":"");
 const prompts=f.segments.map((s,si)=>{
  if(!s.action.trim())throw new Error("Write every visual prompt");
  for(const [key,value] of [["action",s.action],["sound",s.sound],["music",s.music]] as const)if(/<d>[\s\S]*?<\/d>/i.test(value))throw new Error(`Remove native <d> dialogue tags from segment ${si+1} ${key}; spoken words belong in the dialogue field.`);
  const speakers=f.actors.map((a,i)=>({actor:a,index:i,words:s.dialogue[i]?.trim()||""})).filter(x=>x.words&&x.words.toUpperCase()!=="SILENT");
  const dialogue=speakers.map(({actor,index,words})=>{if(/[<>]/.test(words))throw new Error("Dialogue fields accept spoken words only, without tags");const subject=f.mode==="ref2va"?`<Subject ${index+1}>`:line(actor.name);return `${subject} (S${index+1}) says, <d>[${f.language}] ${line(words)}</d>`;}).join("\n");
  const spoken=speakers.length>0,speakerNames=speakers.map(x=>line(x.actor.name));
  const away=/\b(?:stares?|looks?|gazes?|glances?)\s+(?:blankly\s+)?(?:at|toward|to)\s+(?:the\s+)?(?:floor|ground|away|wall|side|window|door|back)|back to camera|facing away|head down|mouth (?:closed|shut)/i;
  const corrections=speakers.map(({actor})=>{const name=line(actor.name),near=new RegExp(`(?<![\\p{L}\\p{N}])${esc(name)}(?![\\p{L}\\p{N}])[^.!?\\n]{0,80}(?:${away.source})`,"iu"),possessive=/\b(?:woman|female|girl|lady|actress)\b/i.test(actor.description)?"her":/\b(?:man|male|boy|gentleman|actor)\b/i.test(actor.description)?"his":"their";return near.test(s.action)?`When ${name} speaks, ${name} lifts ${possessive} head and faces the camera with mouth clearly visible.`:"";}).filter(Boolean).join(" ");
  const staging=spoken?`${speakerNames.length===1?speakerNames[0]:speakerNames.join(" and ")} ${speakerNames.length===1?"is":"are"} on camera with face and mouth clearly visible while speaking.${f.actors.length>speakers.length?" Every other character stays silent with their mouth closed.":""}${speakers.length>1?" Keep all speaking characters in a stable two-shot while they speak; do not cut away or zoom to one speaker.":""}${corrections?` ${corrections}`:""}`:"";
  const sound=line(s.sound)||"Quiet natural room tone.";
  const continuity=`Exactly ${f.actors.length} distinct ${f.actors.length===1?"person":"people"}: ${f.actors.map(a=>line(a.name)).join(", ")}. Each appears once, live, never as sheet panels or alternate views. No other people, audience or camera crew. Keep the same set, lighting and wardrobe. Screens stay blank or abstract; no readable words, numbers, captions or logos.`;
  const visual=`[Shot 1] ${line(s.action)}${staging?` ${staging}`:""}${dialogue?`\n${dialogue}`:""}\n${continuity}`;
  const textVisual=`[Shot 1] ${line(s.action)}${staging?` ${staging}`:""}${dialogue?`\n${dialogue}`:""}\nCharacters: ${f.actors.map((a,i)=>`${line(a.name)} (S${i+1}): ${line(a.description).replace(/[.!?]+$/,"")}.`).join(" ")} Setting: ${line(f.environment).replace(/[.!?]+$/,"")}. ${continuity}`;
  return f.mode==="ref2va"?`subject_definitions:\n${definitions}\nsummary:\n[reference generation] One continuous scene featuring ${f.actors.map(a=>line(a.name)).join(", ")}.\nretention_analysis:\n${retention}\ndetailed_description:\n${visual}\noverall_soundscape:\n${sound}\nnon_diegetic_music:\n${line(s.music)||"N/A"}`:`integrated_multimodal_description:\n${textVisual}\noverall_soundscape:\n${sound}\nnon_diegetic_music:\n${line(s.music)||"N/A"}`;
 });
 const plan=planDirectorSegments({prompts,images:imageSlots,audios:audioSlots});
 return {app:"pika-studio-director",values:directorValues({flex_mode:f.mode,aspect:f.aspect,megapixels:f.megapixels,audio_mode:f.audioMode,video_audio:true,segment_windows:plan.segment_windows},files),files,target:"video"};
}

export function creativeField(form:DirectorForm,path:string){
 let target:any=form,key=path;
  if(path==="scenario")return {target,key,task:`Write the short scenario and script, maximum ${Math.min(180,form.count*50)} words, with a clear setup and a concrete ending. Plain prose only: no [Visual Directions] or [Dialogue] headings, no name-colon script labels and no <d> tags; quote spoken words inside the prose. Favor one small conflict, a specific intention the character tries to hide, restrained acting and an ending that can land in silence. Leave room for hesitation and held reactions rather than compressing many events. Use exactly ${form.actors.length} distinct characters and one unchanged location. No additional host, audience, crew, voices or unnamed people. If a slot is unnamed, give it a real unique name; never print placeholder IDs or context labels. For a mockumentary, include an observable awkward escalation and a specific comic payoff, not a generic cliffhanger. Convey quiz questions through the configured character's dialogue, never readable screens.`};
  if(path==="environment")return {target,key,task:"Describe the empty environment only, without people. One still location, maximum 60 words. No camera action, audience, readable text, logos or displayed questions. Screens are blank or abstract light; a physical question-mark sculpture is allowed."};
 const actor=/^actors\.(\d+)\.(name|description)$/.exec(path),segment=/^segments\.(\d+)\.(action|sound|music|dialogue\.\d+)$/.exec(path);
  if(actor){const index=Number(actor[1]);target=form.actors[index];key=actor[2];if(target){const others=form.actors.filter((_,i)=>i!==index).map(a=>`${a.name}: ${a.description}`).join("; ");const slot=`You are filling CHARACTER SLOT ${index+1} OF ${form.actors.length}, the ${["first","second","third"][index]} distinct person in the approved story. Identify that person from the story's introductions and dialogue attributions; "Character ${index+1}" and "Personnage ${index+1}" are slot labels, not names. Do not select the first character again for later slots. Other slots (do not duplicate): ${others}.`;
   return {target,key,task:slot+(key==="name"?" Give only a short character name or role for THIS slot, using the actual name from the approved story. Never return the placeholder \"Character ${index+1}\" or \"Personnage ${index+1}\". It must differ from every other slot name.":` Describe only ${target.name}, slot ${index+1}: distinct face, age, hair, build and complete wardrobe including shoes. Follow THIS person's story role, not another person's. No scene, background or actions.`)};}}
   if(segment){const i=Number(segment[1]);target=form.segments[i];key=segment[2];if(target){if(key.startsWith("dialogue.")){const speaker=Number(key.split(".")[1]);if(!form.actors[speaker])throw new Error("Unknown character");return {target:target.dialogue,key:String(speaker),task:`Write ONLY the words spoken by ${form.actors[speaker].name} in segment ${i+1}, in ${form.language}. Maximum 8 words; fewer is better when a look or silence communicates the beat. If the approved story gives this character a line in this beat, return those words (shortened to at most eight without changing their meaning), not SILENT. Return SILENT only when the story assigns this character no line in this segment. No speaker label, colon, quotes, directions or tags.`};}const speaking=target.dialogue.some((v:string)=>Boolean(v.trim())&&v.trim().toUpperCase()!=="SILENT");return {target,key,task:`Write only the ${key==="action"?"visual action and camera direction: ONE small physical beat, a subtle observable reaction and a held pause; prefer a static frame over needless movement. ONE camera instruction, maximum 55 words. Do not write spoken words, quoted lines, a name followed by a colon, [Dialogue]/[Visual Directions] headings, voice-over, narration or off-screen speech. If this beat has spoken lines, every speaking character must be on camera with face and mouth in view and a natural speaking posture; never describe a speaking character as looking down, away, hidden, back to camera or silent. If two or more characters speak, keep them both in a stable two-shot and do not zoom or cut away to one speaker. The words belong to the separate dialogue field.":key==="sound"?`room tone, physical sounds and each speaking character's non-verbal vocal delivery/breath where relevant, maximum 35 words. ${speaking?"One or more characters speak live on camera: describe their vocal texture and breath and the room tone; do not repeat the spoken words, do not call the segment silent, and do not imply voice-over.":"Allow genuine quiet; do not fill every second."} No voices from unconfigured people`:"intended background score, or N/A"} for segment ${i+1}/${form.count}, lasting 7.29 seconds. Use only the configured character names. No extra host, audience, crew, strangers or readable screen text. Keep set layout and lighting unchanged. No technical IDs, context labels or markup.`};}}
 throw new Error("The model may fill creative fields only");
}
