import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {AgentStore} from "../server/agent-store.ts";
import {projectOf,checkProject,updateProject} from "../server/agent-project.ts";
import {planH3,validateH3} from "../server/h3-plan.ts";
import {loadRegistry} from "../server/registry.ts";
import {resolveValues} from "../server/runner.ts";

test("project engine and adapter locks do not prevent other studios from preparing references",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-project-test-");try{const store=new AgentStore(dir),c=store.create();c.project={...projectOf(c),lock:{section:"video",app:"pika-studio-director",values:{adapter:"ref2va"}}};
 assert.throws(()=>checkProject(c,"h3-r2v","video",{},{}),/locked video engine/);assert.throws(()=>checkProject(c,"pika-studio-director","video",{adapter:"fl2va"},{}),/locked adapter/);assert.doesNotThrow(()=>checkProject(c,"pika-studio-director","video",{adapter:"ref2va"},{}));assert.doesNotThrow(()=>checkProject(c,"create-image","image",{},{}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("canonical character and location references persist; unknown/substituted references are rejected",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-project-test-");try{const store=new AgentStore(dir),c=store.create();c.attachments=[{id:"actor",name:"Actor",path:"/known/actor.png",url:"/a",mime:"image/png"},{id:"set",name:"Set",path:"/known/set.png",url:"/b",mime:"image/png"}];c.project={...projectOf(c),brief:"User brief",lock:{section:"video",app:"pika-studio-director",values:{}}};
 const state={summary:"Use the established cast",references:[{label:"Lena",kind:"character",assetId:"actor"},{label:"Apartment",kind:"location",assetId:"set"}],scenes:[{id:"scene-1",title:"Arrival",requiredReferences:["Lena","Apartment"],status:"planned"}],activeScene:"scene-1"};updateProject(c,state);assert.equal(c.project.brief,"User brief");assert.equal(c.project.lock.app,"pika-studio-director");store.save(c);assert.equal(projectOf(store.get(c.id)).references.length,2);
 assert.throws(()=>checkProject(c,"pika-studio-director","video",{},{image1:"/known/actor.png"}),/requires canonical Apartment/);assert.doesNotThrow(()=>checkProject(c,"pika-studio-director","video",{},{image1:"/known/actor.png",image2:"/known/set.png"}));
 assert.throws(()=>updateProject(c,{...state,references:[{label:"Lena",kind:"character",assetId:"invented"}]}),/Unknown reference asset/);assert.throws(()=>updateProject(c,{...state,brief:"overwrite user"}),/Unrecognized/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("H3 planning constructs legal geometry for every supported duration and short segments",()=>{
 for(const seconds of [5/24,.5,1,5,10,150]){const plan=planH3({seconds,prompts:["Arrival","Conversation","Exit"]});assert.doesNotThrow(()=>validateH3({segment_windows:plan.segment_windows}));const windows=JSON.parse(plan.segment_windows).windows;assert.ok(windows.every((w:any)=>(w.end-w.start-5)%17===0));assert.equal(plan.frames,windows.at(-1).end);}
 const p=planH3({seconds:5,prompts:["One","Two"]});assert.equal(p.segmentFrames,124);assert.equal(p.overlapFrames,39);assert.equal(p.frames,209);
});
test("bad H3 prompts, alignment, gaps and missing file slots fail before GPU submission",()=>{
 const good=JSON.parse(planH3({seconds:5,prompts:["One","Two"],images:[0]}).segment_windows);
 assert.throws(()=>validateH3({segment_windows:JSON.stringify(good)}),/supplied file slots/);
 const values={segment_windows:JSON.stringify(good),image1:{bytes:new Uint8Array([1])}};assert.doesNotThrow(()=>validateH3(values));
 for(const windows of [[{start:0,end:120,prompt:"x"}],[{start:1,end:125,prompt:"x"}],[{start:0,end:124,prompt:"x"},{start:125,end:249,prompt:"x"}],[{start:0,end:124,prompt:""}]])assert.throws(()=>validateH3({segment_windows:JSON.stringify({windows})}),/Segment|prompt/);
 const app=loadRegistry(process.cwd()).apps.find(a=>a.id==="pika-studio-director")!;assert.throws(()=>resolveValues(app,{global_prompt:"x",segment_windows:JSON.stringify({windows:[{start:0,end:120,prompt:"x"}]})}),/5 \+ 17/);
});
