import {InputError,type InputIssue} from "./input-error.ts";

/** Prompt intent checks, not visual/speech verification or a second material planner. */
type Context={mode:"ref2va"|"fl2va";pictures:number;videos:number|null;audios:number|null;seconds:number};
const refSections=["subject_definitions","summary","retention_analysis","detailed_description","overall_soundscape","non_diegetic_music"];
const textSections=["integrated_multimodal_description","overall_soundscape","non_diegetic_music"];
const labels=(text:string,kind:string)=>[...text.matchAll(new RegExp(`\\b${kind}\\s+(\\d+)`,"gi"))].map(m=>Number(m[1]));

export function pikaPromptIssues(prompt:string,ctx:Context):InputIssue[]{
 const issues:InputIssue[]=[],expected=ctx.mode==="ref2va"?refSections:textSections;
 const add=(code:string,field:string,message:string)=>issues.push({code,field,message});
 const matches=[...prompt.matchAll(/^[ \t]*(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)[ \t]*:/gim)];
 const sections=new Map(matches.map((m,i)=>[m[1].toLowerCase(),prompt.slice(m.index!+m[0].length,matches[i+1]?.index??prompt.length).trim()]));
 if(matches.map(m=>m[1].toLowerCase()).join(",")!==expected.join(","))add("PIKA_SECTIONS","prompt",`Use these sections in order: ${expected.join(", ")}`);
 for(const name of expected)if(!sections.get(name))add("PIKA_EMPTY_SECTION",name,`${name} must not be empty (use N/A for no music)`);
 const definitions=sections.get("subject_definitions")||"",description=sections.get(ctx.mode==="ref2va"?"detailed_description":"integrated_multimodal_description")||"";
 if(/\[(?:dialogue|visual directions|action|sound|music)\]/i.test(description))add("PIKA_SECTION_LABEL","dialogue","Remove [Dialogue]/[Visual Directions] headings from the shot description; spoken words require native <d> tags");
 if(/(?:^|\n)\s*S[1-9]\d*\s*:\s*\S/.test(description))add("PIKA_SPEAKER_COLON","dialogue","Use a speaker marker followed by says, <d>[Language] ...</d>, not an S-number colon line");
 const leaked=/(?:^|\n)\s*([A-Z][\p{L}'’-]{1,30})\s*:\s*([^\n]+)/u.exec(description);
 if(leaked&&/\b(?:I|you|we|my|your|me|he|she|it)\b/i.test(leaked[2]))add("PIKA_SPEAKER_COLON","dialogue","Spoken dialogue must use native <d> tags instead of a name-colon line in the visual description");
 if(ctx.mode==="ref2va"){
  // Official ref2va.txt omits the task marker and Shot 1; these are guidance, not engine requirements.
  if(!/\b(?:fully_preserved|partially_preserved|attribute_transfer|weak_reference|removed|fully_copy|partially_copy)\b|(?:^|[:(])\s*reference\b/im.test(sections.get("retention_analysis")||""))add("PIKA_RETENTION","retention_analysis","retention_analysis requires an explicit retention relationship such as fully_preserved, partially_preserved, attribute_transfer or weak_reference");
  const subjects=new Set(labels(definitions,"Subject"));
  for(const n of new Set(labels(prompt,"Subject")))if(!subjects.has(n))add("PIKA_UNDEFINED_SUBJECT","subject_definitions",`Subject ${n} is not defined in subject_definitions`);
 }
 for(const [kind,count] of [["Picture",ctx.pictures],["Video",ctx.videos],["Audio",ctx.audios]] as const){
  if(count===null)continue; // Video slices and paired audio ordinals are owned by the backend planner.
  for(const n of new Set(labels(prompt,kind)))if(n<1||n>count)add("PIKA_UNBOUND_REFERENCE","references",`${kind} ${n} is unbound: this segment has ${count} local ${kind.toLowerCase()} inputs`);
  // A Picture inside a Subject definition is already bound. Standalone frame-anchor definitions are optional.
 }
 const tags=[...prompt.matchAll(/<d>([\s\S]*?)<\/d>/gi)];
 if(!tags.length&&/\(S[1-9]\d*\)/.test(description)&&/\b(says|replies|asks|whispers|shouts|speaks)\b/i.test(description))add("PIKA_DIALOGUE_TAGS","dialogue","Spoken dialogue requires native <d>[Language] ...</d> tags");
 if((prompt.match(/<\/?d>/gi)||[]).length!==tags.length*2)add("PIKA_DIALOGUE_TAGS","dialogue","Dialogue tags must be balanced <d>...</d>");
 const declared=new Set([...definitions.matchAll(/\((S[1-9]\d*(?:\s*,\s*S[1-9]\d*)*)\)/g)].flatMap(m=>m[1].match(/S\d+/g)||[]));
 const descriptionLabel=matches.find(m=>m[1].toLowerCase()===(ctx.mode==="ref2va"?"detailed_description":"integrated_multimodal_description"));
 let previous=descriptionLabel?descriptionLabel.index!+descriptionLabel[0].length:0;
 for(const tag of tags){
  if(!/^\s*\[([A-Za-z][A-Za-z -]*)\]\s*\S[\s\S]*$/.test(tag[1]))add("PIKA_DIALOGUE_LANGUAGE","dialogue",`Every dialogue tag requires a language and text: <d>[English] ...</d> (found: ${tag[0].replace(/\s+/g," ").slice(0,100)})`);
  const before=prompt.slice(previous,tag.index),marker=before.match(/\(S[1-9]\d*(?:\s*,\s*S[1-9]\d*)*\)/g)?.at(-1);
  if(!marker)add("PIKA_DIALOGUE_SPEAKER","dialogue",`Every dialogue line requires a preceding speaker marker (S1), (S2), ... (found before tag: ${before.replace(/\s+/g," ").slice(-100)})`);
  else if(declared.size)for(const id of marker.match(/S\d+/g)||[])if(!declared.has(id))add("PIKA_UNKNOWN_SPEAKER","dialogue",`Unknown speaker (${id}): not among the declared vocal sources`);
  // Inline speaker introduction is official syntax; a separate subject_definitions declaration is not required.
  if(!description.includes(tag[0]))add("PIKA_DIALOGUE_LOCATION","dialogue","Dialogue belongs in the shot description, not soundscape or music");
  previous=tag.index!+tag[0].length;
 }
 return issues;
}

export const validatePikaPrompt=(prompt:string,ctx:Context)=>pikaPromptIssues(prompt,ctx).map(i=>i.message);

export function validatePikaValues(values:Record<string,unknown>){
 const reject=(code:string,field:string,message:string):never=>{throw new InputError(message,[{code,field,message}]);};
 const mode=values.flex_mode;
 if(mode!=="ref2va"&&mode!=="fl2va")return reject("PIKA_MODE","flex_mode","Pika requires flex_mode ref2va or fl2va");
 const count=(kind:string,max:number)=>Array.from({length:max},(_,i)=>values[`${kind}${i+1}`]).filter(Boolean).length;
 const pictures=count("image",9),videos=count("video",3),audios=count("audio",3);
 if(mode==="fl2va"&&pictures+videos+audios)reject("PIKA_MATERIALS","files","FL2VA in Pika Director requires an empty material bin; use Ref2VA for references");
 if(mode==="ref2va"&&!pictures&&!videos)reject("PIKA_MATERIALS","files","Ref2VA requires a supplied picture or video; use FL2VA for text-only generation");
 if(!values.segment_windows&&String(values.segment_prompts||"").trim())reject("PIKA_PROMPT_INPUT","segment_prompts","Pika multi-line prompts must use global_prompt or segment_windows, not the line-split segment_prompts field");
 let spec:any;
 if(values.segment_windows){try{spec=typeof values.segment_windows==="string"?JSON.parse(values.segment_windows):values.segment_windows;}catch{return reject("PIKA_TIMELINE_JSON","segment_windows","segment_windows must be valid JSON");}}
 const windows=spec?.windows||[{prompt:values.segment_prompts||values.global_prompt,images:Array.from({length:9},(_,i)=>i).filter(i=>values[`image${i+1}`]),audios:Array.from({length:3},(_,i)=>i).filter(i=>values[`audio${i+1}`])}];
 if(values.audio_mode==="locked"&&windows.some((w:any)=>(w.audios||[]).length)){
  const selection=windows[0].audios||[];
  if(selection.length!==1||windows.some((w:any)=>!Array.isArray(w.audios)||w.audios.length!==1||w.audios[0]!==selection[0]))reject("PIKA_LOCKED_SOUNDTRACK","segment_windows.windows.audios","Finite sampling requires exactly the same one locked soundtrack in every segment; locked audio does not consume an Audio N reference label");
 }
 for(const [i,w] of windows.entries()){
  const images=w.images||[],audio=w.audios||[];
  for(const [slots,kind,max] of [[images,"image",9],[audio,"audio",3]] as const){
   if(!Array.isArray(slots)||slots.some(n=>!Number.isInteger(n)||n<0||n>=max||!values[`${kind}${n+1}`]))reject("PIKA_UNBOUND_SLOT",`segment_windows.windows.${i}.${kind}s`,`Pika segment ${i+1}: ${kind} slots must refer to supplied files (zero based)`);
   if(new Set(slots).size!==slots.length)reject("PIKA_DUPLICATE_SLOT",`segment_windows.windows.${i}.${kind}s`,`Pika segment ${i+1}: duplicate material slots`);
  }
  if(mode==="ref2va"&&!images.length&&!videos)reject("PIKA_MATERIALS",`segment_windows.windows.${i}.images`,`Pika segment ${i+1}: Ref2VA requires a visual reference assigned to this segment`);
  const issues=pikaPromptIssues(String(w.prompt||values.global_prompt||""),{mode,pictures:images.length,videos:videos?null:0,audios:videos?null:values.audio_mode==="locked"?0:audio.length,seconds:w.end!==undefined?(w.end-w.start)/24:Number(values.duration)||5}).map(issue=>({...issue,field:`segment_windows.windows.${i}.prompt.${issue.field}`}));
  if(issues.length)throw new InputError(`Pika segment ${i+1}: ${issues.map(issue=>issue.message).join("; ")}`,issues);
 }
}
