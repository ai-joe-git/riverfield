import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {blackriverDraftSettings} from "../server/blackriver-draft.ts";
import {defaults,buildNativeArgs,nativeOptions} from "../server/native-options.ts";

test("draft defaults are three tokens and Q8 for both draft KV caches",()=>{
 assert.equal(defaults.specDraftNMax,3);assert.equal(defaults.specDraftCacheTypeK,"q8_0");assert.equal(defaults.specDraftCacheTypeV,"q8_0");const help=["--model","--alias","--host","--port",...nativeOptions.flatMap(o=>o.flags)].join("\n");const args=buildNativeArgs("/m.gguf","m",1,{specType:"draft-mtp"},help);assert.equal(args[args.indexOf("--spec-draft-n-max")+1],"3");assert.ok(!buildNativeArgs("/m.gguf","m",1,{},help).includes("--spec-draft-n-max"),"A default does not enable speculation");
});
test("BlackRiver draft combinations and exact-model settings are read without importing unrelated state",()=>{
 const dir=mkdtempSync("/tmp/opencode/blackriver-draft-"),path=join(dir,"state.json");try{const state={runtimeEnv:{SECRET:"PRIVATE"},modelProfiles:{"/models/gemma/model.gguf":{name:"Gemma",updatedAt:"2026-11-12",params:{specType:"draft-mtp,ngram-mod",specDraftNMax:3,specDraftNMin:0,specDraftPMin:.6,specDraftPSplit:.1,specDraftCacheTypeK:"q8_0",specDraftCacheTypeV:"q8_0",draftMode:"auto",contextSize:262144,extraArgs:"PRIVATE",apiKey:"PRIVATE"}},"/models/other/model.gguf":{params:{specType:"none",specDraftNMax:5}}}};writeFileSync(path,JSON.stringify(state));const before=readFileSync(path,"utf8"),result=blackriverDraftSettings(path,"/models/Gemma/MODEL.gguf");assert.equal(result.match?.options.specType,"draft-mtp,ngram-mod");assert.equal(result.match?.options.specDraftNMax,3);assert.equal(result.match?.options.specDraftPMin,.6);assert.equal(result.match?.draftSource,"automatic / embedded");assert.deepEqual(result.modes,["draft-mtp,ngram-mod","none"]);assert.ok(!JSON.stringify(result).includes("PRIVATE"));assert.equal(result.match?.options.contextSize,undefined);assert.equal(readFileSync(path,"utf8"),before);assert.equal(blackriverDraftSettings(path,"/unrelated/model.gguf").match,null);}finally{rmSync(dir,{recursive:true,force:true});}
});
test("missing or malformed BlackRiver state is nonfatal and invalid values are not imported",()=>{
 const dir=mkdtempSync("/tmp/opencode/blackriver-draft-"),path=join(dir,"state.json");try{assert.equal(blackriverDraftSettings(path).available,false);writeFileSync(path,"invalid");assert.equal(blackriverDraftSettings(path).match,null);writeFileSync(path,JSON.stringify({modelProfiles:{"/m.gguf":{params:{specType:"draft-mtp",specDraftNMin:.75}}}}));const result=blackriverDraftSettings(path,"/m.gguf");assert.equal(result.match,null);assert.ok(result.error);}finally{rmSync(dir,{recursive:true,force:true});}
});
test("matching BlackRiver batch parameters are separate from draft parameters and do not copy context",()=>{
 const dir=mkdtempSync("/tmp/opencode/blackriver-batch-"),path=join(dir,"state.json");try{writeFileSync(path,JSON.stringify({modelProfiles:{"/models/gemma.gguf":{params:{specType:"draft-mtp",specDraftNMax:3,batchSize:2048,ubatchSize:1024,contextSize:262144,extraArgs:"PRIVATE"}}}}));const result=blackriverDraftSettings(path,"/models/gemma.gguf");assert.deepEqual(result.match?.performance,{batchSize:2048,ubatchSize:1024});assert.equal(result.match?.options.batchSize,undefined);assert.ok(!("contextSize" in (result.match?.performance||{})));assert.ok(!JSON.stringify(result).includes("PRIVATE"));}finally{rmSync(dir,{recursive:true,force:true});}
});
