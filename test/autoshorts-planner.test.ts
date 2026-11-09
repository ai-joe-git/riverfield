import {test} from "node:test";
import assert from "node:assert/strict";
import {alignedLength,nearestOverlap,windowsFor,planBatches,buildDirectorBatch,buildDirectorPlan} from "../server/autoshorts-planner.ts";
import {loadRegistry} from "../server/registry.ts";
const apps=loadRegistry().apps;
const director=apps.find(a=>a.id==="pika-studio-director")!;
const bible={style:"Photorealistic",lighting:"Amber lamps",entities:[
  {id:"rosa",kind:"character",description:"One 70-year-old woman in a leopard coat"},
  {id:"car",kind:"vehicle",description:"Tiny red hatchback"},
  {id:"street",kind:"setting",description:"Marrakech at midnight"}]};
const scene=(id:string,order:number,entityIds:string[],extra:any={})=>({id,order,duration:5,narration:"",visual:`Shot ${id}`,prompt:`Action ${id}`,speechMode:"native",dialogueLines:[],continuity:{entityIds,settingId:"street",timeOfDay:"night",lighting:"Amber lamps",counts:Object.fromEntries(entityIds.map(e=>[e,1])),transition:false,notes:"x"},...extra});
const sheets:Record<string,string>={rosa:"references/rosa.png",car:"references/car.png",street:"references/street.png"};
const readSheet=(id:string)=>({entity:id,path:sheets[id]||"",description:bible.entities.find(e=>e.id===id)?.description||id});

// These numbers are the exact output of comfy-nodes/.../h3_planner.py (see the task notes).
test("director geometry mirrors the Python planner node",()=>{
  assert.equal(alignedLength(120),124);assert.equal(alignedLength(5),5);assert.equal(alignedLength(130),124);
  assert.equal(nearestOverlap(39,123),39);
  assert.deepEqual(windowsFor([124,124,124]),[{start:0,end:124},{start:85,end:209},{start:170,end:294}]);
});
test("batches respect the per-run cap and the nine image slots",()=>{
  const two=[scene("a",0,["rosa","car","street"]),scene("b",1,["rosa","car","street"])];
  assert.equal(planBatches(two,1).length,2);
  assert.equal(planBatches(two,3).length,1);
  // A second scene with nine fresh entities cannot share the nine slots with the first.
  const many=Array.from({length:9},(_,i)=>`e${i}`);
  const wide=[scene("a",0,many),scene("b",1,[...many,"extra"])];
  assert.equal(planBatches(wide,8).length,2);
});
test("buildDirectorBatch produces a valid segment_windows document with bound slots and Ref2VA prompts",()=>{
  const scenes=[scene("a",0,["rosa","car","street"]),scene("b",1,["rosa","street"])];
  const batch=buildDirectorBatch(director,scenes,bible,readSheet,{aspect:"9:16 (Portrait Widescreen)",megapixels:.5,language:"en",seed:42});
  assert.equal(batch.adapter,"ref2va");assert.equal(batch.engine,"pika-studio-director");
  assert.equal(batch.values.flex_mode,"ref2va");assert.equal(batch.values.segment_count,2);
  assert.deepEqual(batch.bindings.map(b=>b.slot),["image1","image2","image3"]);
  const doc=JSON.parse(String(batch.values.segment_windows));
  assert.equal(doc.windows.length,2);
  assert.deepEqual(doc.windows[0].images,[0,1,2]);assert.deepEqual(doc.windows[1].images,[0,2]);
  assert.deepEqual([doc.windows[0].start,doc.windows[0].end],[0,124]);
  assert.match(doc.windows[0].prompt,/subject_definitions:/);assert.match(doc.windows[0].prompt,/<Picture 1>/);
  assert.match(doc.windows[0].prompt,/rosa/);assert.match(doc.windows[0].prompt,/Tiny red hatchback/);
});
test("the plan reuses the same canonical sheets across shots and groups by perRun",()=>{
  const scenes=[scene("a",0,["rosa","car","street"]),scene("b",1,["rosa","car","street"]),scene("c",2,["rosa","street"])];
  const plan=buildDirectorPlan(director,scenes,bible,readSheet,{aspect:"9:16 (Portrait Widescreen)",megapixels:.5,language:"en",seed:42,perRun:2});
  assert.equal(plan.length,2);
  assert.deepEqual(plan[0].scenes,["a","b"]);assert.deepEqual(plan[1].scenes,["c"]);
  // Both batches bind the same shared files (no per-shot identity regeneration).
  assert.equal(plan[0].bindings.find(b=>b.entity==="rosa")!.path,"references/rosa.png");
  assert.equal(plan[1].bindings.find(b=>b.entity==="rosa")!.path,"references/rosa.png");
});
