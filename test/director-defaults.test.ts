import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DIRECTOR_DEFAULTS,directorRequest,directorValues,directorDurations,planDirectorSegments} from "../server/h3-plan.ts";
import {loadRegistry} from "../server/registry.ts";
import {resolveValues} from "../server/runner.ts";

test("stable Director profile matches native default duration and interleaving",()=>{
 const manifest=JSON.parse(readFileSync("apps/pika-studio-director/app.json","utf8"));assert.equal(manifest.inputs.find((i:any)=>i.id==="duration").default,DIRECTOR_DEFAULTS.segmentSeconds);
 assert.ok(!("seconds" in directorRequest.shape));
 const plan=planDirectorSegments({prompts:Array(8).fill("Original prompt")});assert.equal(plan.ready,true);assert.equal(plan.segmentFrames,175);assert.equal(plan.overlapFrames,39);
 assert.deepEqual(JSON.parse(plan.segment_windows!).windows.map((w:any)=>[w.start,w.end]),[[0,175],[136,311],[272,447],[408,583],[544,719],[680,855],[816,991],[952,1127]]);
});
test("30 seconds yields five native windows, never duration guessing or exact-total rejection",()=>{
 for(const seconds of [10,10.5,11,30]){const incomplete=planDirectorSegments({seconds,total_seconds:30,prompts:["One","Two","Three"]});assert.equal(incomplete.ready,false);assert.equal(incomplete.requiredPrompts,5);assert.equal(incomplete.segment_windows,undefined);assert.equal(incomplete.segmentFrames,175);}
 const complete=planDirectorSegments({total_seconds:30,prompts:["One","Two","Three","Four","Five"]});assert.equal(complete.ready,true);assert.equal(complete.frames,719);assert.equal(complete.requestedSeconds,30);assert.equal(complete.seconds,719/24);
});
test("interview duration labels are computed with overlaps, never authored by the model",()=>{
 const choices=directorDurations();assert.deepEqual(choices.map(c=>[c.segments,c.frames,c.label]),[[1,175,"7.29 s (1 segment)"],[2,311,"12.96 s (2 segments)"],[3,447,"18.63 s (3 segments)"],[5,719,"29.96 s (5 segments)"]]);
 for(const c of choices)assert.equal(c.seconds,c.frames/24);
});
test("native geometry normalization preserves creative prompts, local bindings, audio tracks and resolution",()=>{
 const raw={duration:11,start_seconds:99,segment_count:2,aspect:"9:16 (Portrait Widescreen)",megapixels:.4,flex_mode:"ref2va",segment_windows:JSON.stringify({windows:[{start:0,end:260,prompt:"Keep this exact prompt",images:[1,0],audios:[0]},{start:221,end:481,prompt:"Second prompt",images:[0],audios:[]}],videos:[{index:0,start:0,duration:2}],audios:[{index:0,duration:3}]})};
 const normalized=directorValues(raw),spec=JSON.parse(normalized.segment_windows as string),original=JSON.parse(raw.segment_windows);
 assert.equal(normalized.duration,7.3);assert.equal(normalized.start_seconds,0);assert.equal(normalized.aspect,raw.aspect);assert.equal(normalized.megapixels,.4);
 assert.deepEqual(spec.windows.map((w:any)=>[w.start,w.end]),[[0,175],[136,311]]);assert.equal(spec.windows[0].prompt,original.windows[0].prompt);assert.deepEqual(spec.windows[0].images,[1,0]);assert.deepEqual(spec.windows[0].audios,[0]);assert.deepEqual(spec.videos,original.videos);assert.deepEqual(spec.audios,original.audios);
 assert.deepEqual(directorValues(normalized),normalized,"normalization is idempotent");
});
test("both actual app modes accept native segments; Ref2VA also binds optional sound references",()=>{
 const app=loadRegistry(process.cwd()).apps.find(a=>a.id==="pika-studio-director")!,file={bytes:new Uint8Array([1]),name:"ref.png"};
 const example=JSON.parse(readFileSync("apps/pika-studio-director/request-example.json","utf8"));
 const spec=JSON.parse(example.values.segment_windows);spec.windows[0].prompt=spec.windows[0].prompt.replace("summary:","<Audio 1> supplies a quiet apartment ambience reference.\nsummary:");spec.windows[0].audios=[0];
 assert.doesNotThrow(()=>resolveValues(app,{...example.values,segment_windows:JSON.stringify(spec),image1:file,image2:file,audio1:file,audio_mode:"reference"}));
 const fl=directorValues({flex_mode:"fl2va",global_prompt:"integrated_multimodal_description:\n[Shot 1] A quiet room at night.\noverall_soundscape:\nSoft room tone.\nnon_diegetic_music:\nN/A"});assert.doesNotThrow(()=>resolveValues(app,fl));
 assert.throws(()=>resolveValues(app,{...fl,image1:file}),/empty material bin/);
 assert.throws(()=>resolveValues(app,{...example.values,image1:file}),/supplied file slots/);
});
test("omitted mode follows the actual material files without overriding an explicit choice",()=>{
 assert.equal(directorValues({},{}).flex_mode,"fl2va");assert.equal(directorValues({},{image1:"known.png"}).flex_mode,"ref2va");assert.equal(directorValues({},{video1:"known.mp4"}).flex_mode,"ref2va");assert.equal(directorValues({flex_mode:"fl2va"},{image1:"known.png"}).flex_mode,"fl2va","explicit incompatible choices are validated, not silently changed");
});
