import {test} from "node:test";
import assert from "node:assert/strict";
import {resolveApp} from "../server/app-reference.ts";
import {resolveProduction,approvalIssues,draftProduction} from "../server/production.ts";
import {loadRegistry} from "../server/registry.ts";
import {resolveProjectAsset,updateProject} from "../server/agent-project.ts";
import {AgentStore} from "../server/agent-store.ts";
import {mkdtempSync,rmSync} from "node:fs";

const apps=loadRegistry(process.cwd()).apps;
test("installed Pika resolves from its ID or actual display name without guessing",()=>{
 for(const name of ["pika-studio-director","Pika Studio Director"," pika studio director ","PIKA-STUDIO-DIRECTOR"])assert.equal(resolveApp(apps,name).id,"pika-studio-director");
 assert.throws(()=>resolveApp(apps,"Imaginary Pika Ultra"),/Unknown app/);
 assert.throws(()=>resolveApp([{id:"one",name:"Duplicate"},{id:"two",name:"Duplicate"}],"Duplicate"),/Ambiguous app.*one, two/);
});
test("old display-name plans resolve Pika and the unique actually used image engine",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-app-reference-");try{
  const c=new AgentStore(dir).create();
  const p=draftProduction(c,{format:"Vertical",style:"Comedy",platform:"Shorts",language:"English",aspect:"9:16",durationSeconds:5,engine:"Pika Studio Director",treatment:"One pilot",scenes:[{id:"pilot",title:"Pilot",prompt:"One contestant waits at a podium.",seconds:5,dialogue:[{speaker:"Candidate",line:"Ready."}]}]});
  const resolved=resolveProduction(p,apps,["moss-turbo","moss-turbo"]);
  assert.equal(resolved.engine,"pika-studio-director");assert.equal(resolved.imageEngine,"moss-turbo");assert.equal(resolved.status,"draft");assert.deepEqual(approvalIssues(resolved,apps),[]);
  assert.equal(p.engine,"Pika Studio Director","reading notes does not rewrite saved user data");
  assert.equal(resolveProduction(p,apps,["moss-turbo","create-image"]).imageEngine,"","ambiguous history must not select an engine");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("known asset paths, unique job IDs and filenames resolve to canonical IDs, never arbitrary files",()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-asset-reference-");try{
  const c=new AgentStore(dir).create();c.artifacts=[
   {id:"sarah-id",name:"out-01.png",path:"/known/job-sarah/out-01.png",job:"job-sarah",app:"moss-turbo",type:"image",mime:"image/png",url:"/a"},
   {id:"set-id",name:"out-01.png",path:"/known/job-set/out-01.png",job:"job-set",app:"moss-turbo",type:"image",mime:"image/png",url:"/b"},
  ];
  for(const reference of ["sarah-id","job-sarah","/known/job-sarah/out-01.png"])assert.equal(resolveProjectAsset(c,reference).id,"sarah-id");
  assert.throws(()=>resolveProjectAsset(c,"out-01.png"),/Ambiguous reference asset.*sarah-id.*set-id/);
  assert.throws(()=>resolveProjectAsset(c,"ref-sarah"),/Unknown reference asset.*sarah-id/);
  assert.throws(()=>resolveProjectAsset(c,"/etc/passwd"),/Unknown reference asset/);
  updateProject(c,{summary:"Use existing outputs",references:[{label:"Sarah",kind:"character",assetId:"job-sarah"},{label:"Set",kind:"location",assetId:"/known/job-set/out-01.png"}],scenes:[],activeScene:""});
  assert.deepEqual(c.project!.references.map(r=>r.assetId),["sarah-id","set-id"]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
