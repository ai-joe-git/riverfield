// Structured continuity is a reviewable constraint, not a promise of visual identity.
import { z } from "zod";

const identifier=z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(v=>!["__proto__","constructor","prototype"].includes(v));
export const timeOfDay=z.enum(["night","day","dawn","dusk","interior"]);
export const bibleSchema=z.object({
  style:z.string().min(1).max(3000), timeOfDay, lighting:z.string().min(1).max(2000),
  entities:z.array(z.object({id:identifier,kind:z.enum(["character","vehicle","setting","prop"]),
    description:z.string().min(1).max(3000), traits:z.record(z.string(),z.string()).default({}),
    reference:z.string().max(500).default(""), approved:z.boolean().default(false),
    imagePrompt:z.string().max(8000).default(""),
  })).min(1).max(12),
});
export const shotStateSchema=z.object({
  entityIds:z.array(identifier).min(1).max(12), settingId:identifier,
  timeOfDay, lighting:z.string().min(1).max(2000),
  counts:z.record(z.string(),z.number().int().min(0).max(20)).default({}),
  transition:z.boolean().default(false),
  notes:z.string().max(2000).default(""),
});
type Bible=z.infer<typeof bibleSchema>;
type Shot={id:string;prompt:string;visual:string;dialogue?:string;continuity?:z.infer<typeof shotStateSchema>};

export function continuityIssues(bible:Bible|undefined,scenes:Shot[]):string[] {
  if(!bible)return [];
  const issues:string[]=[], ids=new Set(bible.entities.map(e=>e.id));
  if(ids.size!==bible.entities.length)issues.push("Visual bible entity IDs must be unique");
  let prior=bible.timeOfDay;
  for(const s of scenes){
    const state=s.continuity;if(!state){issues.push(`${s.id}: missing explicit continuity state`);continue;}
    if(new Set(state.entityIds).size!==state.entityIds.length)issues.push(`${s.id}: duplicate entity IDs`);
    for(const entity of state.entityIds)if(!ids.has(entity))issues.push(`${s.id}: unknown entity ${entity}`);
    if(!state.entityIds.includes(state.settingId)||!bible.entities.some(e=>e.id===state.settingId&&e.kind==="setting"))issues.push(`${s.id}: settingId must reference an included canonical setting`);
    if(state.timeOfDay!==prior&&!state.transition)issues.push(`${s.id}: time-of-day change needs an explicit transition`);
    prior=state.timeOfDay;
    const text=`${s.prompt} ${s.visual} ${state.lighting}`.replace(/\b(?:no|not|without|never)\s+(?:any\s+)?(?:daylight|daytime|midday|noon|sunny|sunlit|broad daylight|midnight|moonlit|nighttime)\b/gi,"");
    if(state.timeOfDay==="night"&&/\b(daylight|midday|noon|sunny|sunlit|broad daylight)\b/i.test(text))issues.push(`${s.id}: daylight contradicts night state`);
    if(state.timeOfDay==="day"&&/\b(midnight|moonlit|nighttime)\b/i.test(text))issues.push(`${s.id}: night contradicts day state`);
    const characters=bible.entities.filter(e=>e.kind==="character"&&state.entityIds.includes(e.id));
    if(characters.length===1&&/\b(two|2|multiple|duplicate)\s+(?:(?:elderly|old|identical)\s+)?(?:grandmothers|women|men|copies)\b/i.test(text))issues.push(`${s.id}: shot text duplicates a single canonical character`);
    for(const [entity,count] of Object.entries(state.counts)){
      if(!state.entityIds.includes(entity))issues.push(`${s.id}: count for absent entity ${entity}`);
      if(bible.entities.some(e=>e.id===entity&&e.kind==="character")&&count>1)issues.push(`${s.id}: canonical character ${entity} duplicated (count ${count})`);
    }
    for(const e of bible.entities.filter(e=>state.entityIds.includes(e.id))){
      // Conservative checks for explicit canonical traits, never arbitrary semantic claims.
      if(e.kind==="vehicle"&&e.traits.color){
        const colors=[...text.matchAll(/\b(red|blue|green|white|black|yellow|silver)\s+(?:(?:tiny|compact|small|three-door|modified|luxury|sports)\s+){0,3}(?:car|hatchback|sedan|convertible|suv)\b(?!\s+(?:underglow|wheels|headlights|trim|interior))/gi)];
        if(colors.some(m=>m[1].toLowerCase()!==e.traits.color.toLowerCase()))issues.push(`${s.id}: vehicle color contradicts ${e.id} (${e.traits.color})`);
      }
    }
  }
  return issues;
}

export function shotPrompt(bible:Bible|undefined,scene:Shot):string {
  let text=scene.prompt;
  if(bible&&scene.continuity){const state=scene.continuity;
    const entities=bible.entities.filter(e=>state.entityIds.includes(e.id));
    text=`VISUAL BIBLE — reproduce canonical reference identities, not lookalikes. ${bible.style}\n`+
      entities.map(e=>`${e.kind.toUpperCase()} ${e.id}: ${e.description}. Traits: ${JSON.stringify(e.traits)}. Visible count: ${state.counts[e.id]??1}.`).join("\n")+
      `\nSETTING ${state.settingId}. Time: ${state.timeOfDay}. Lighting: ${state.lighting}. Global lighting: ${bible.lighting}. No unlisted people or duplicate characters.\nShot state: ${state.notes}\nAction and framing: ${scene.prompt}\nVisual: ${scene.visual}`;
  }
  if(scene.dialogue?.trim())text+=`\nCHARACTER DIALOGUE (native soundtrack, not external narration): ${scene.dialogue}. Preserve ambience and sound effects. No subtitles or on-screen text.`;
  return text;
}
