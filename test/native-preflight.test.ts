import {test} from "node:test";
import assert from "node:assert/strict";
import {projectorBatchIssue,nativeFailureMessage} from "../server/native-preflight.ts";

test("the observed Gemma projector configuration is rejected before loading weights",()=>{
 const options={mmprojPath:"/models/mmproj-F16.gguf",batchSize:256,ubatchSize:64};assert.match(projectorBatchIssue(options,{"clip.has_vision_encoder":true},{"general.architecture":"gemma4"})!,/micro batch 64.*at least 70/);
 assert.equal(projectorBatchIssue({...options,batchSize:2048,ubatchSize:1024},{"clip.has_vision_encoder":true},{"general.architecture":"gemma4"}),null);
 assert.match(projectorBatchIssue(options,{"clip.projector_type":"gemma4v"})!,/micro batch 64/);assert.equal(projectorBatchIssue(options,{"clip.has_vision_encoder":false},{"general.architecture":"gemma4"}),null);assert.equal(projectorBatchIssue({...options,mmprojPath:""},{"clip.projector_type":"gemma4v"}),null);
});
test("startup errors retain the causal image-budget failure rather than cleanup messages",()=>{
 const logs=["E Gemma4Assistant requires ctx_other (normal during memory fitting)","W cap image_max_tokens (original=1120) to 64 (n_ubatch = 64)","E clip_init: load_hparams: image_max_pixels (147456) is less than image_min_pixels (161280)","E srv load_model: failed to load multimodal model", "I operator(): cleaning up before exit", "E server_run_i: exiting due to model loading error"];
 const result=nativeFailureMessage(1,null,logs,{ubatchSize:1024});assert.match(result,/image_max_pixels \(147456\).*image_min_pixels \(161280\)/);assert.match(result,/Effective micro batch 64/);assert.doesNotMatch(result,/cleaning up|ctx_other/);
});
