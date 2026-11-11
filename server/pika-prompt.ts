/** Cheap preflight only: these checks cannot verify identity, speech or visual quality. */
type Context={mode:"ref2va"|"fl2va";pictures:number;videos:number|null;audios:number|null;seconds:number};
const refSections=["subject_definitions","summary","retention_analysis","detailed_description","overall_soundscape","non_diegetic_music"];
const textSections=["integrated_multimodal_description","overall_soundscape","non_diegetic_music"];
const labels=(text:string,kind:string)=>[...text.matchAll(new RegExp(`\\b${kind}\\s+(\\d+)`,"gi"))].map(m=>Number(m[1]));

export function validatePikaPrompt(prompt:string,ctx:Context){
 const issues:string[]=[],expected=ctx.mode==="ref2va"?refSections:textSections;
 const matches=[...prompt.matchAll(/^\s*(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:/gim)];
 const sections=new Map(matches.map((m,i)=>[m[1].toLowerCase(),prompt.slice(m.index!+m[0].length,matches[i+1]?.index??prompt.length).trim()]));
 if(matches.map(m=>m[1].toLowerCase()).join(",")!==expected.join(","))issues.push(`Use exactly these sections in order: ${expected.join(", ")}`);
 for(const name of expected)if(!sections.get(name))issues.push(`${name} must not be empty (use N/A for no music)`);
 const definitions=sections.get("subject_definitions")||"",description=sections.get(ctx.mode==="ref2va"?"detailed_description":"integrated_multimodal_description")||"";
 if(!/\[Shot 1\]/i.test(description))issues.push("The description requires [Shot 1]");
 if(ctx.mode==="ref2va"){
  if(!/^\[(reference generation|video editing|video continuation)(?:\s*\+[^\]]+)?\]/i.test(sections.get("summary")||""))issues.push("summary must start with a Ref2VA task marker such as [reference generation]");
  if(!/fully_preserved|partially_preserved|attribute_transfer|weak_reference|removed|fully_copy/i.test(sections.get("retention_analysis")||""))issues.push("retention_analysis requires an explicit retention relationship");
  const subjects=new Set(labels(definitions,"Subject"));
  for(const n of new Set(labels(prompt,"Subject")))if(!subjects.has(n))issues.push(`Subject ${n} is not defined in subject_definitions`);
 }
 for(const [kind,count] of [["Picture",ctx.pictures],["Video",ctx.videos],["Audio",ctx.audios]] as const){
  if(count===null)continue; // Video slicing and paired audio ordinals belong to the backend material planner.
  for(const n of new Set(labels(prompt,kind)))if(n<1||n>count)issues.push(`${kind} ${n} is unbound: this segment has ${count} local ${kind.toLowerCase()} inputs`);
  if(ctx.mode==="ref2va")for(let n=1;n<=count;n++)if(!labels(definitions,kind).includes(n))issues.push(`Define ${kind} ${n} using this segment's actual material-bin order`);
 }
 const tags=[...prompt.matchAll(/<d>([\s\S]*?)<\/d>/gi)];
 if((prompt.match(/<\/?d>/gi)||[]).length!==tags.length*2)issues.push("Dialogue tags must be balanced <d>...</d>");
 const declared=new Set(definitions.match(/\(S\d+\)/g)||[]);
 let previous=0,words=0;
 for(const tag of tags){
  const line=/^\s*\[([A-Za-z][A-Za-z -]*)\]\s*(\S[\s\S]*)$/.exec(tag[1]);
  if(!line)issues.push("Every dialogue tag requires a language and text: <d>[French] ...</d>");
  else words+=line[2].trim().split(/\s+/).length;
  const before=prompt.slice(Math.max(previous,tag.index!-260),tag.index),speaker=before.match(/\(S\d+\)/g)?.at(-1);
  if(!speaker)issues.push("Every dialogue line requires a preceding speaker marker (S1), (S2), ...");
  else if(ctx.mode==="ref2va"&&!declared.has(speaker))issues.push(`Unknown speaker ${speaker}: declare it in subject_definitions`);
  if(!description.includes(tag[0]))issues.push("Dialogue belongs in the shot description, not soundscape or music");
  previous=tag.index!+tag[0].length;
 }
 if(/\(S\d+\)/.test(description)&&!tags.length)issues.push("Speaker dialogue requires native <d>[Language] ...</d> tags");
 if(words>Math.max(8,Math.ceil(ctx.seconds*3.5)))issues.push(`Dialogue is too long for ${ctx.seconds.toFixed(2)} seconds (${words} words)`);
 return [...new Set(issues)];
}

export function validatePikaValues(values:Record<string,unknown>){
 const mode=values.flex_mode;
 if(mode!=="ref2va"&&mode!=="fl2va")throw new Error("Pika requires flex_mode ref2va or fl2va");
 const count=(kind:string,max:number)=>Array.from({length:max},(_,i)=>values[`${kind}${i+1}`]).filter(Boolean).length;
 const pictures=count("image",9),videos=count("video",3),audios=count("audio",3);
 if(mode==="fl2va"&&pictures+videos+audios)throw new Error("FL2VA in Pika Director requires an empty material bin; use Ref2VA for references");
 if(mode==="ref2va"&&!pictures&&!videos)throw new Error("Ref2VA requires a supplied picture or video; use FL2VA for text-only generation");
 const raw=values.segment_windows;
 const spec=raw?(typeof raw==="string"?JSON.parse(raw):raw) as {windows:any[]}:undefined;
 const windows=spec?.windows||[{prompt:values.segment_prompts||values.global_prompt,images:Array.from({length:9},(_,i)=>i).filter(i=>values[`image${i+1}`]),audios:Array.from({length:3},(_,i)=>i).filter(i=>values[`audio${i+1}`])}];
 for(const [i,w] of windows.entries()){
  const images=w.images||[],audio=w.audios||[];
  if(new Set(images).size!==images.length||new Set(audio).size!==audio.length)throw new Error(`Pika segment ${i+1}: duplicate material slots`);
  if(mode==="ref2va"&&!images.length&&!videos)throw new Error(`Pika segment ${i+1}: Ref2VA requires a visual reference assigned to this segment`);
  const issues=validatePikaPrompt(String(w.prompt||""),{mode,pictures:images.length,videos:videos?null:0,audios:videos?null:values.audio_mode==="locked"?0:audio.length,seconds:w.end!==undefined?(w.end-w.start)/24:Number(values.duration)||5});
  if(issues.length)throw new Error(`Pika segment ${i+1}: ${issues.join("; ")}`);
 }
}
