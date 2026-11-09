import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {AutoShorts,boardSchema,sceneSchema,narrationText} from "../server/autoshorts.ts";
import {recipeFor,compileVideoPrompt,canonicalImagePrompt,keyframeImagePrompt,type MediaBinding} from "../server/autoshorts-recipes.ts";
import {command} from "../server/autoshorts-media.ts";
import {loadRegistry} from "../server/registry.ts";
const apps=loadRegistry().apps;
const bible={style:"Live-action vertical drama",timeOfDay:"night",lighting:"Amber lamps",
  entities:[{id:"anna",kind:"character",description:"Anna, one woman with silver hair and a red coat",traits:{voice:"low, calm voice"},reference:"",approved:false},
    {id:"ben",kind:"character",description:"Ben, one man with dark hair and a navy jacket",traits:{voice:"quiet baritone"},reference:"",approved:false},
    {id:"hall",kind:"setting",description:"One mansion hallway at midnight",traits:{},reference:"",approved:false}]};
const shot=(extra:any={})=>sceneSchema.parse({id:"shot",order:0,duration:5,narration:"",visual:"Anna confronts Ben in the hall",prompt:"Anna holds the envelope and confronts Ben. He looks away.",engine:"pika-video",method:"video",
  continuity:{entityIds:["anna","ben","hall"],settingId:"hall",timeOfDay:"night",lighting:"Amber lamps",counts:{anna:1,ben:1,hall:1},transition:false,notes:"One continuous night"},
  direction:{framing:"Medium over-the-shoulder shot",camera:"Slow small push in",action:"Anna raises the envelope. Ben recoils.",startState:"Anna holds the unopened envelope low",endState:"Ben holds the opened envelope",emotion:"Anna suspicious; Ben ashamed",soundscape:"Quiet room tone, paper rustle",music:""},
  dialogueLines:[{speakerId:"anna",text:"Tu m'as menti.",delivery:"quietly, disappointed",language:"fr"},{speakerId:"ben",text:"Je voulais te protéger.",delivery:"softly",language:"fr"}],...extra});
const board=(engine="pika-video")=>boardSchema.parse({title:"Drama",hook:"An envelope",closing:"A reveal",narration:"",music:"",visualBible:structuredClone(bible),scenes:[shot({engine})]});
const binding=(input:string,path:string,role:MediaBinding["role"],entity?:string):MediaBinding=>({input,path,role,entity,description:entity||role});
async function done(service:AutoShorts,id:string){for(let i=0;i<800;i++){const p=service.get(id);if(!["queued","running"].includes(p.tasks.at(-1)!.status))return p;await new Promise(r=>setTimeout(r,10));}throw new Error("timeout");}

test("Pika and H3 recipes select actual conditioning modes, not a generic video template",()=>{
  const get=(id:string)=>apps.find(a=>a.id===id)!;
  assert.equal(recipeFor(get("pika-text-to-video"),true).effectiveEngine,"pika-video");
  assert.equal(recipeFor(get("pika-video"),true).conditioning,"fl2va");
  assert.equal(recipeFor(get("h3-r2v-flex")).family,"Pika H3 Flex");
  assert.equal(recipeFor(get("h3-r2v")).family,"MiniMax H3");
  assert.equal(recipeFor(get("h3-r2v")).conditioning,"ref2va");
  assert.equal(recipeFor(get("h3-video-turbo"),true).cinemaSupported,false);
});
test("FL2VA uses real opening/ending markers, model-grid duration and native attributed dialogue tags",()=>{
  const recipe=recipeFor(apps.find(a=>a.id==="pika-video")!);
  const out=compileVideoPrompt(recipe,shot(),bible,[binding("first_frame","opening.png","first-frame"),binding("last_frame","ending.png","last-frame")],"fr");
  assert.match(out.prompt,/0\.00 seconds/);assert.match(out.prompt,/<Picture 2>.*5\.17-second/);
  assert.match(out.prompt,/integrated_multimodal_description:/);assert.match(out.prompt,/overall_soundscape:/);assert.match(out.prompt,/non_diegetic_music:\nN\/A/);
  assert.match(out.prompt,/anna \(S1\).*<d>\[French\] Tu m'as menti\.<\/d>/);
  assert.match(out.prompt,/ben \(S2\).*<d>\[French\] Je voulais te protéger\.<\/d>/);
  assert.equal(out.prompt.match(/Tu m'as menti/g)?.length,1,"do not duplicate spoken words into soundscape");
  assert.throws(()=>compileVideoPrompt(recipe,shot(),bible,[],"fr"),/approved opening/);
});
test("Ref2VA binds exact ordered identity and composition roles into its six sections",()=>{
  for(const id of ["h3-r2v-flex","h3-r2v"]){
    const recipe=recipeFor(apps.find(a=>a.id===id)!);
    const refs=[binding("image1","anna.png","identity","anna"),binding("image2","ben.png","identity","ben"),binding("image3","hall.png","setting","hall"),binding("image4","opening.png","first-frame")];
    const out=compileVideoPrompt(recipe,shot(),bible,refs,"en");
    for(const section of ["subject_definitions","summary","retention_analysis","detailed_description","overall_soundscape","non_diegetic_music"])assert.match(out.prompt,new RegExp(section+":"));
    assert.match(out.prompt,/<Subject 1> is anna from <Picture 1>/);assert.match(out.prompt,/<Subject 4> is first-frame from <Picture 4>/);
    assert.match(out.prompt,/fully_preserved/);assert.match(out.prompt,/attribute_transfer/);assert.doesNotMatch(out.prompt,/<Picture 5>/);
  }
});
test("native Cinema never synthesizes a narrator implicitly; explicit per-scene TTS still works",()=>{
  const s=shot({speechMode:"auto",narration:"A narrator that was not requested"});
  assert.equal(narrationText(s,{mode:"CINEMA",cinemaAudio:"native"}),"");
  assert.equal(narrationText({...s,speechMode:"narration"},{mode:"CINEMA",cinemaAudio:"native"}),s.narration);
  assert.equal(narrationText(s,{mode:"CINEMA",cinemaAudio:"narration"}),s.narration);
  assert.equal(narrationText({...s,narration:"Tu m'as menti."},{mode:"CINEMA",cinemaAudio:"narration"}),"","structured native lines must not be repeated by automatic TTS");
});
test("image prompts distinguish canonical roles from a single starting/ending state",()=>{
  assert.match(canonicalImagePrompt(bible.entities[0],bible,"z-image"),/single canonical actor/);
  assert.match(canonicalImagePrompt(bible.entities[2],bible,"z-image"),/canonical location shown consistently/);
  const first=keyframeImagePrompt(shot(),bible,["anna","ben","hall"]),last=keyframeImagePrompt(shot(),bible,["anna","ben","hall"],"last");
  assert.match(first,/OPENING state: Anna holds the unopened envelope low/);assert.doesNotMatch(first,/ENDING state: Ben holds/);
  assert.match(last,/ENDING state: Ben holds the opened envelope/);
  assert.throws(()=>boardSchema.parse({...board(),scenes:[shot({dialogueLines:[{speakerId:"hall",text:"Impossible"}]})]}),/visible canonical character/);
});

for(const engine of ["pika-video","h3-r2v-flex"]){
  test(`${engine}: produce prepares assets, waits for approval, then uses correctly bound prompts without TTS`,{timeout:60000},async()=>{
    const dir=mkdtempSync(join(tmpdir(),"rf-recipes-")),calls:{app:string;values:any}[]=[];
    try{
      const image=join(dir,"source.png"),video=join(dir,"source.mp4");
      await command("ffmpeg",["-y","-f","lavfi","-i","color=c=blue:s=160x96","-frames:v","1","-threads","1",image]);
      await command("ffmpeg",["-y","-f","lavfi","-i","color=c=blue:s=160x96:r=24:d=1","-c:v","libx264","-threads","1",video]);
      const service=new AutoShorts(join(dir,"projects"),apps,async(app,values)=>{
        assert.ok(!app.id.startsWith("tts"),"native Cinema must not launch TTS");calls.push({app:app.id,values});return {path:app.outputs.some(o=>o.type==="image")?image:video,job:`mock-${calls.length}`,seconds:0,modelLoading:null};
      });
      let p=service.create({mode:"CINEMA",profile:"custom",megapixels:.5,factor:1,endpointFrames:true});
      assert.equal(p.config.transition,0,"new Cinema projects should not force fade-to-black between every shot");
      assert.equal(p.config.cinemaAudio,"native");
      const script=board(engine);script.scenes[0].narration="This unwanted narrator must not be synthesized.";
      p=service.edit(p.id,{board:script});
      service.start(p.id,"audio","shot");p=await done(service,p.id);assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.equal(p.tasks.at(-1)?.review?.stage,"audio-policy");assert.equal(calls.length,0);
      service.start(p.id,"produce");p=await done(service,p.id);
      assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.equal(p.tasks.at(-1)?.review?.stage,"reference-review");assert.equal(calls.length,3);
      p.board!.visualBible!.entities.forEach(e=>e.approved=true);p=service.edit(p.id,{board:p.board});
      service.start(p.id,"prepare");p=await done(service,p.id);
      assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.equal(p.tasks.at(-1)?.review?.stage,"keyframe-review");
      assert.ok(p.states.shot.keyframe);assert.equal(!!p.states.shot.endKeyframe,engine==="pika-video");
      const afterImages=calls.length;
      service.start(p.id,"prepare");p=await done(service,p.id);assert.equal(calls.length,afterImages,"preparation must reuse already generated images");
      service.start(p.id,"approve-keyframe","shot");p=await done(service,p.id);
      if(engine==="pika-video"){service.start(p.id,"approve-keyframe-end","shot");p=await done(service,p.id);}
      const ready=service.describe(p.id).readiness;assert.equal(ready.pendingKeyframes,0);assert.equal(ready.issues.length,0);
      service.start(p.id,"produce");p=await done(service,p.id);
      assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.equal(p.tasks.at(-1)?.review?.stage,"clip-review");assert.equal(p.states.shot.audio,undefined);
      const generated=calls.at(-1)!;assert.equal(generated.app,engine);
      if(engine==="pika-video"){assert.ok(generated.values.first_frame.bytes);assert.ok(generated.values.last_frame.bytes);assert.match(generated.values.prompt,/<Picture 2>/);}
      else {for(const id of ["image1","image2","image3","image4"])assert.ok(generated.values[id].bytes);assert.match(generated.values.prompt,/subject_definitions:/);}
      assert.match(generated.values.prompt,/<d>\[French\]/);assert.equal(p.states.shot.media!.generation?.recipeVersion,1);
      const total=calls.length;service.start(p.id,"produce");p=await done(service,p.id);assert.equal(calls.length,total,"reviewing a clip must not regenerate it");
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
}

test("Cinema routes through Pika Studio Director Ref2VA with reused canonical sheets, no per-shot keyframe and no TTS",{timeout:60000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),"rf-director-")),calls:{app:string;values:any}[]=[];
  try{
    const image=join(dir,"s.png"),video=join(dir,"s.mp4");
    await command("ffmpeg",["-y","-f","lavfi","-i","color=c=blue:s=160x96","-frames:v","1","-threads","1",image]);
    await command("ffmpeg",["-y","-f","lavfi","-i","color=c=blue:s=160x96:r=24:d=1","-c:v","libx264","-threads","1",video]);
    const service=new AutoShorts(join(dir,"projects"),apps,async(app,values)=>{assert.ok(!app.id.startsWith("tts"),"native director Cinema must not launch TTS");calls.push({app:app.id,values});return {path:app.outputs.some(o=>o.type==="image")?image:video,job:`mock-${calls.length}`,seconds:0,modelLoading:null};});
    let p=service.create({mode:"CINEMA",profile:"custom",megapixels:.5,factor:1});
    assert.equal(p.config.videoEngine,"pika-studio-director","new Cinema projects default to the director");
    const script=board("pika-studio-director");
    p=service.edit(p.id,{board:script});
    service.start(p.id,"produce");p=await done(service,p.id);
    assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.equal(p.tasks.at(-1)?.review?.stage,"reference-review");assert.equal(calls.length,3);
    p.board!.visualBible!.entities.forEach(e=>e.approved=true);p=service.edit(p.id,{board:p.board});
    service.start(p.id,"produce");p=await done(service,p.id);
    assert.equal(p.tasks.at(-1)?.status,"waiting_review");assert.equal(p.tasks.at(-1)?.review?.stage,"clip-review");
    const gen=calls.at(-1)!;assert.equal(gen.app,"pika-studio-director");assert.equal(gen.values.flex_mode,"ref2va");
    assert.ok(gen.values.image1.bytes&&gen.values.image2.bytes&&gen.values.image3.bytes);
    const doc=JSON.parse(String(gen.values.segment_windows));assert.equal(doc.windows.length,1);assert.deepEqual(doc.windows[0].images,[0,1,2]);
    assert.match(String(doc.windows[0].prompt),/subject_definitions:/);assert.match(String(doc.windows[0].prompt),/<d>\[French\]/);
    assert.equal(p.states.shot.keyframe,undefined,"the director route needs no per-shot keyframe");
    assert.equal(p.states.shot.audio,undefined);assert.equal(p.states.shot.media!.generation?.recipe,"pika-studio-director:ref2va");
    const total=calls.length;service.start(p.id,"produce");p=await done(service,p.id);assert.equal(calls.length,total,"accepted director footage is not regenerated");
  }finally{rmSync(dir,{recursive:true,force:true});}
});
