import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validatePikaPrompt,validatePikaValues} from "../server/pika-prompt.ts";
import {planH3} from "../server/h3-plan.ts";
import {loadRegistry} from "../server/registry.ts";
import {resolveValues} from "../server/runner.ts";
import {promptGuidance} from "../mcp/prompt-guidance.ts";

export const pilot=`subject_definitions:
<Subject 1> is the same nervous contestant from <Picture 1>, a four-view identity sheet. (S1) is this one visible contestant. (S2) is an offscreen director, never visible.
<Subject 2> is the empty game-show studio from <Picture 2>, an environment reference, not a person.
summary:
[reference generation] A French mockumentary retry in the empty studio with one contestant.
retention_analysis:
<Subject 1> (fully_preserved): retain face, hair, clothing and proportions from Picture 1, not panels or duplicate people.
<Subject 2> (partially_preserved): preserve architecture and lighting from Picture 2 while adding only the contestant.
detailed_description:
[Shot 1] One continuous portrait medium shot. Exactly one contestant stands in the studio; no sheet panels, labels or duplicate bodies. The offscreen director (S2) says firmly, <d>[French] On la refait.</d> Then the candidate (S1) replies nervously, <d>[French] Oui, je suis prêt.</d> He forces a small smile. The director remains offscreen.
overall_soundscape:
Quiet studio room tone, short synchronized French dialogue, no narrator.
non_diegetic_music:
N/A`;
const ctx={mode:"ref2va" as const,pictures:2,videos:0,audios:0,seconds:124/24};
test("six-section Ref2VA pilot binds one character sheet and one empty environment",()=>{assert.deepEqual(validatePikaPrompt(pilot,ctx),[]);});
test("missing sections, bad dialogue, unknown speakers and unbound labels are rejected",()=>{
 for(const [bad,pattern] of [[pilot.replace("summary:","overview:"),/sections/],[pilot.replace("[French] On", "On"),/language/],[pilot.replace("director (S2) says","director (S3) says"),/Unknown speaker/],[pilot.replace("<Picture 2>","<Picture 3>"),/unbound/],[pilot.replace("<Subject 2> is","<Subject 4> is"),/Subject 2 is not defined/]] as const)assert.match(validatePikaPrompt(bad,ctx).join(";"),pattern);
});
test("missing native dialogue tags and speech too long for the window are rejected",()=>{
 assert.match(validatePikaPrompt(pilot.replace(/<d>|<\/d>/g,""),ctx).join(";"),/native.*tags/);
 assert.match(validatePikaPrompt(pilot.replace("Oui, je suis prêt.",Array(30).fill("oui").join(" ")),ctx).join(";"),/too long/);
});
test("FL2VA uses three sections and an empty material bin",()=>{
 const prompt="integrated_multimodal_description:\n[Shot 1] An empty studio.\noverall_soundscape:\nRoom tone.\nnon_diegetic_music:\nN/A";
 assert.deepEqual(validatePikaPrompt(prompt,{...ctx,mode:"fl2va",pictures:0}),[]);
 assert.doesNotThrow(()=>validatePikaValues({flex_mode:"fl2va",global_prompt:prompt,duration:5}));
 assert.throws(()=>validatePikaValues({flex_mode:"fl2va",global_prompt:prompt,image1:{}}),/empty material bin/);
});
test("per-segment material order and total duration stay separate from generation duration",()=>{
 const p=planH3({seconds:5,total_seconds:5,prompts:[pilot],segment_images:[[1,0]]});assert.equal(p.segmentFrames,124);assert.deepEqual(JSON.parse(p.segment_windows).windows[0].images,[1,0]);
 assert.throws(()=>planH3({seconds:30,total_seconds:30,prompts:Array(6).fill(pilot)}),/seconds is per segment/);
 assert.throws(()=>planH3({seconds:5,prompts:[pilot,pilot],segment_images:[[0]]}),/one entry per prompt/);
});
test("runner preserves exact 9:16 and 0.4 MP, rejects invalid geometry and prompts before GPU",()=>{
 const app=loadRegistry(process.cwd()).apps.find(a=>a.id==="pika-studio-director")!,file={bytes:new Uint8Array([1]),name:"ref.png"};
 const values={flex_mode:"ref2va",aspect:"9:16 (Portrait Widescreen)",megapixels:0.4,image1:file,image2:file,segment_windows:planH3({seconds:5,prompts:[pilot],images:[0,1]}).segment_windows};
 const out=resolveValues(app,values);assert.equal(out.aspect,values.aspect);assert.equal(out.megapixels,0.4);
 assert.throws(()=>resolveValues(app,{...values,aspect:"3:4"}),/not one of the options/);
 assert.throws(()=>resolveValues(app,{...values,segment_windows:JSON.stringify({windows:[{start:0,end:120,prompt:pilot,images:[0,1]}]})}),/5 \+ 17/);
 assert.throws(()=>resolveValues(app,{...values,segment_windows:planH3({seconds:5,prompts:["plain prose"],images:[0,1]}).segment_windows}),/sections/);
});
test("Qwen generic edit uses genuine Turbo and official eight-step recipe, no acceleration LoRA",()=>{
 const graph=JSON.parse(readFileSync("apps/qwen-image-edit-turbo/workflow.api.json","utf8"));
 assert.equal(graph[451].inputs.unet_name,"qwen_image_2.1_turbo_int8_convrot.safetensors");assert.equal(graph[507].inputs.cfg,1);assert.equal(graph[503].inputs.sampler_name,"euler");
 assert.deepEqual(graph[502].inputs.sigmas.split(",").map(Number),[1,.978453,.95418,.926626,.89508,.845148,.704534,.414568,0]);
 assert.ok(!Object.values(graph).some((n:any)=>/Lora|TurboPrediction/i.test(n.class_type)));
 const moss=loadRegistry(process.cwd()).apps.find(a=>a.id==="moss-turbo")!;assert.equal(moss.inputs.find(i=>i.id==="steps")!.default,8);assert.match(promptGuidance(moss).rules.join(" "),/SEPARATE empty environment/);
});
test("proposed MOSS calls are two separate valid references at eight steps",()=>{
 const calls=JSON.parse(readFileSync("docs/cinematic-pilot-reference-calls.json","utf8")),moss=loadRegistry(process.cwd()).apps.find(a=>a.id==="moss-turbo")!;
 assert.equal(calls.length,2);
 for(const call of calls){assert.equal(call.arguments.app,"moss-turbo");assert.equal(resolveValues(moss,call.arguments.values).steps,8);}
 assert.equal(calls[0].arguments.values.aspect,"16:9 (Widescreen)");
 assert.match(calls[0].arguments.values.prompt,/LEFT THIRD.*portrait.*RIGHT TWO THIRDS.*FRONT VIEW.*SIDE PROFILE.*BACK VIEW/);
 assert.match(calls[1].arguments.values.prompt,/EMPTY.*studio/);assert.match(calls[1].arguments.values.prompt,/Absolutely no people/);
});
