import type {DirectorForm} from "./director-form.ts";

export type DirectorContentIssue={field:string;message:string};
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const words=(s:string)=>s.trim().split(/\s+/u).filter(Boolean).length;
const roles=/\b(?:host|presenter|announcer|interviewer|interviewee|contestant|participant|caller|friend|assistant|cameraman|camera operator|camera crew|documentary crew|film crew|audience(?: members)?|crowd|spectators?|onlookers?|extras?|bystanders?|stranger|(?:another|second|additional|unidentified) (?:man|woman|person)|(?:blurred|shadowy|silhouetted|anonymous) figures)\b/gi;
const internal=/\b(?:existing segment actions|subject_definitions|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music|segment_windows|chatStep|creative brief|story beats)\b|\[(?:visual directions|dialogue|action|sound|music)\]|\bin (?:Character\s*\d+|Environment)\b|\bCHARACTER\s*\d+\b/gi;
const spoken=(s:string)=>Boolean(s.trim())&&s.trim().toUpperCase()!=="SILENT";
const actionConflict=/\b(?:voice[- ]?over|voiceover|narrat(?:ion|or)|off[- ]?screen|does not speak|doesn't speak|remains? (?:silent|still and silent)|mouth (?:stays |remains )?(?:closed|shut))\b/i;
const soundConflict=/\b(?:silence|silent|voice[- ]?over|voiceover|narrat(?:ion|or)|off[- ]?screen|only sound|no (?:one )?speaks)\b/i;
const negative=(s:string,index:number)=>/\b(?:no|without|not|never|exclude|excluding)\s+(?:(?:any|other|additional|visible|new|offscreen|human|audience|crowd|crew|extras|people|or|and|camera|documentary|film)[,\s]+)*$/i.test(s.slice(Math.max(0,index-100),index));
const liveSound="Live on-camera speech with natural room tone and quiet ambience.";
/** Deterministic repair for a sound field that contradicts a spoken line; null when no repair is needed. */
export function repairDialogueSound(f:DirectorForm,field:string,value:string){
 const segment=/^segments\.(\d+)\.sound$/.exec(field);
 if(!segment)return null;
 const beat=f.segments[Number(segment[1])];
 return beat?.dialogue.some(spoken)&&soundConflict.test(value)?liveSound:null;
}

/** Conservative text checks for known failure modes, not visual/semantic quality certification. */
export function directorFieldIssues(f:DirectorForm,field:string,value:string):DirectorContentIssue[]{
 const issues:DirectorContentIssue[]=[],add=(message:string)=>issues.push({field,message});
 if(internal.test(value))add("Internal field labels or character placeholders leaked into creative text");internal.lastIndex=0;
 const visual=field==="scenario"||field==="environment"||/^segments\.\d+\.(action|sound|music)$/.test(field);
 if((field==="environment"||/^segments\.\d+\.(action|sound|music)$/.test(field))&&/<\/?d\b/i.test(value))add("Native <d> dialogue tags belong in the character's dialogue slot, not the visual/sound text");
 if(/^segments\.\d+\.action$/.test(field)&&f.actors.some(a=>a.name.trim())){
  const names=f.actors.map(a=>escape(a.name.trim())).filter(Boolean);
  if(new RegExp(`(?:^|\\n|[.!?]\\s+)\\s*(?:\\[dialogue\\]\\s*)?(?:${names.join("|")}|S[1-9]\\d*)\\s*:\\s*\\S`,"i").test(value))add("Spoken dialogue belongs in the character's dialogue slot, not as a name-colon line in the visual action");
 }
 const segment=/^segments\.(\d+)\.(action|sound)$/.exec(field);
 if(segment){const beat=f.segments[Number(segment[1])],hasDialogue=beat?.dialogue.some(spoken);if(beat&&hasDialogue&&(segment[2]==="action"?actionConflict:soundConflict).test(value))add(segment[2]==="action"?"A segment with spoken dialogue cannot be staged as silent, voice-over, off-screen or mouth-closed; show the speaker on camera":"The sound field contradicts the spoken line; keep live on-camera speech instead of describing silence or voice-over");}
 if(visual){
  let masked=value;
  // Names and ordinary empty seating/prop labels are not additional people.
  for(const a of f.actors)for(const name of [a.name,a.name.replace(/^the\s+/i,"")])if(name.trim())masked=masked.replace(new RegExp(`\\b${escape(name)}\\b`,"gi"),"CAST_MEMBER");
  masked=masked.replace(/(?:["“]phone a friend["”]|phone[- ]a[- ]friend|(?:empty|unoccupied|vacant)\s+(?:audience\s+)?(?:seats|seating|chairs|stands)|audience (?:seats|seating|area)|host[’']s podium)/gi,"SET_PROP");
  const found=[...masked.matchAll(roles)].filter(m=>{
   if(negative(masked,m.index!))return false;
   const after=masked.slice(m.index!+m[0].length),before=masked.slice(0,m.index!);
   // "their friend, Silas" and "Silas, their friend" describe the same configured person, not an extra one.
   return !(/^\s*,?\s*CAST_MEMBER\b/.test(after)||/CAST_MEMBER\s*,\s*(?:their|his|her|the)\s*$/i.test(before));
  });
  const unnamed=f.actors.some(a=>/^(Character|Personnage) \d+$/.test(a.name));
  const distinct=new Set(found.map(m=>m[0].toLowerCase()));
  // The initial story may establish individual roles for unnamed slots, but never crowds/crews.
  if(found.length&&!(field==="scenario"&&unnamed&&distinct.size<=f.actors.length&&!found.some(m=>/audience|crowd|crew|spectator|onlooker|extras|bystander|figures/i.test(m[0]))))add(`Unassigned person/group: ${[...distinct].join(", ")}. Use only the configured character names`);
  const screenText=/\b(?:readable|legible|glowing|scrolling|written)\s+(?:text|words|letters|numbers|question)|\b(?:screen|display|monitor|board)\b[^.!?\n]{0,70}\b(?:reads?|question|answer|text|words|lettering)\b|\b(?:question|answer|text|words)\b[^.!?\n]{0,70}\b(?:screen|display|monitor|board)\b/gi;
  const screenSource=value.replace(/question mark/gi,"SYMBOL");
  if([...screenSource.matchAll(screenText)].some(m=>!negative(screenSource,m.index!)))add("Do not request readable screen text; use blank or abstract displays and spoken dialogue instead");
 }
 if(/^segments\.\d+\.action$/.test(field)&&words(value)>70)add("A native segment needs one concise action and one camera instruction (maximum 70 words)");
 if(/^segments\.\d+\.sound$/.test(field)&&words(value)>45)add("Keep sound descriptions concise (maximum 45 words)");
 if(/^segments\.\d+\.dialogue\.\d+$/.test(field)&&value.trim()!=="SILENT"&&words(value)>8)add("Use at most eight spoken words per character per segment");
 if(/^segments\.\d+\.dialogue\.\d+$/.test(field)&&value.trim()!=="SILENT"){
  if(/^\s*(?:\(?S[1-9]\d*\)?|[A-Z][\p{L}'’-]{1,30})\s*:/u.test(value))add("Dialogue is only the spoken words, without a speaker label or colon");
  if(/[<>[\]]/.test(value))add("Dialogue accepts spoken words only, without tags or bracketed labels");
 }
 return issues;
}
export function directorContentIssues(f:DirectorForm){
 const entries:[string,string][]=[["scenario",f.scenario],["environment",f.environment],...f.actors.map((a,i)=>[`actors.${i}.description`,a.description] as [string,string])];
 f.segments.forEach((s,i)=>{for(const key of ["action","sound","music"] as const)entries.push([`segments.${i}.${key}`,s[key]]);f.actors.forEach((_,j)=>entries.push([`segments.${i}.dialogue.${j}`,s.dialogue[j]||""]));});
 return entries.flatMap(([field,value])=>directorFieldIssues(f,field,value));
}
export function validateDirectorContent(f:DirectorForm){const issues=directorContentIssues(f);if(issues.length)throw new Error(`Creative text needs correction before GPU generation: ${issues.map(i=>`${i.field}: ${i.message}`).join("; ")}`);}
