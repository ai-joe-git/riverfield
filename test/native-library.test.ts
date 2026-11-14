import {test} from "node:test";
import assert from "node:assert/strict";
import {basename} from "node:path";
import {groupNativeLibrary,libraryRole} from "../server/native-library.ts";
const file=(path:string)=>({path,name:basename(path),bytes:1024,version:3,tensors:10});
test("library sorts model groups naturally and keeps main variants/projectors/MTP separate",()=>{
 const paths=["/models/Qwen3.8-27B-GGUF/main-Q8_0.gguf","/models/Qwen3.8-27B-GGUF/main-Q4_K_M.gguf","/models/Qwen3.8-27B-GGUF/mmproj-F16.gguf","/models/Qwen3.8-27B-GGUF/mtp-model.gguf","/models/Qwen3.8-27B-GGUF/model-DFlash2-Q4_K_M.gguf","/models/gemma-4-E4B-it-qat-GGUF/model-Q4_K_XL.gguf","/models/gemma-4-E4B-it-qat-GGUF/mmproj-F16.gguf","/models/gemma-4-E4B-it-qat-GGUF/mtp-gemma.gguf","/models/gemma-4-E2B-it-qat-GGUF/model-Q4_K_XL.gguf","/models/Qwen3.8-27B-GGUF/imatrix_unsloth.gguf"];
 const r=groupNativeLibrary(paths.map(file),["/models","/models/Qwen3.8-27B-GGUF"]);assert.deepEqual(r.groups.map(g=>g.name),["gemma-4-E2B-it-qat","gemma-4-E4B-it-qat","Qwen3.8-27B"]);const q=r.groups[2];assert.equal(q.models.length,2);assert.equal(q.projectors.length,1);assert.equal(q.mtp.length,1);assert.equal(q.drafts.length,1);assert.equal(q.models[0].quantization,"Q4_K_M");assert.ok(q.projectors[0].path.startsWith(q.directory+"/"));assert.equal(r.groups[1].projectors[0].path,"/models/gemma-4-E4B-it-qat-GGUF/mmproj-F16.gguf");assert.equal(r.orphans.length,0);
});
test("flat libraries do not silently assign generic or ambiguous projectors to unrelated models",()=>{
 const r=groupNativeLibrary(["/models/Alpha-Q4_K_M.gguf","/models/Beta-Q8_0.gguf","/models/mmproj-F16.gguf","/models/mtp-Alpha.gguf"].map(file),["/models"]);assert.equal(r.groups.length,2);assert.equal(r.groups[0].mtp.length,1);assert.equal(r.groups[1].mtp.length,0);assert.ok(r.groups.every(g=>g.projectors.length===0));assert.equal(r.orphans[0].name,"mmproj-F16.gguf");
});
test("projector-only folders are not offered as main models and model files containing MTP are not mistaken for heads",()=>{
 const r=groupNativeLibrary(["/models/aux/mmproj-F16.gguf","/models/aux/mtp-other.gguf","/models/Qwen-MTP-GGUF/Qwen-MTP-Q4_K_M.gguf"].map(file),["/models"]);assert.equal(r.groups.length,1);assert.equal(r.groups[0].models.length,1);assert.equal(r.orphans.length,2);assert.equal(libraryRole("mtp-Qwen.gguf"),"mtp");assert.equal(libraryRole("Qwen-MTP-Q4_K_M.gguf"),"model");
});
test("duplicate scan roots and split parts do not create repeated selectable models",()=>{
 const a=file("/models/Big/Big-Q8_0-00001-of-00002.gguf"),b=file("/models/Big/Big-Q8_0-00002-of-00002.gguf");const r=groupNativeLibrary([a,a,b],["/models","/models/Big"]);assert.equal(r.groups.length,1);assert.equal(r.groups[0].models.length,1);assert.equal(r.groups[0].models[0].parts,2);
});
test("nested quantization folders retain the parent model's projector and MTP files",()=>{
 const r=groupNativeLibrary(["/models/Flash-Next-GGUF/quantizations/Q4/model-Q4_K_M.gguf","/models/Flash-Next-GGUF/quantizations/Q8/model-Q8_0.gguf","/models/Flash-Next-GGUF/mmproj-F16.gguf","/models/Flash-Next-GGUF/mtp-model.gguf"].map(file),["/models"]);assert.equal(r.groups.length,1);assert.equal(r.groups[0].name,"Flash-Next");assert.equal(r.groups[0].models.length,2);assert.equal(r.groups[0].projectors.length,1);assert.equal(r.groups[0].mtp.length,1);assert.equal(r.orphans.length,0);
});
