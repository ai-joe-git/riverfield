import {test} from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Browser module is plain JavaScript, executed directly in production.
import {directorJobState} from "../web/js/agent-director-chat.js";

const snapshot=(status?:string)=>({tools:[{guidedTarget:"video",status:"done",job:"video-job"}],jobStates:status?{"video-job":{status}}:{}});
test("submitted GPU jobs remain pending after the submission tool is done",()=>{
 for(const status of [undefined,"starting","queued","running","uploading","unknown"]){const state=directorJobState(snapshot(status),"video");assert.equal(state.pending,true,status||"submitted");assert.equal(state.job,"video-job");}
});
test("terminal GPU jobs unlock the next explicit action",()=>{
 for(const status of ["succeeded","failed","canceled","expired","lost"])assert.equal(directorJobState(snapshot(status),"video").pending,false,status);
});
test("pre-dispatch and uncertain submissions remain locked without a job ID",()=>{
 for(const status of ["approved","proposed","running","uncertain"])assert.equal(directorJobState({tools:[{guidedTarget:"video",status}],jobStates:{}},"video").pending,true,status);
 assert.equal(directorJobState({tools:[{guidedTarget:"video",status:"error"}],jobStates:{}},"video").pending,false);
});
test("the latest target job wins; unrelated references and upscales do not overwrite its state",()=>{
 const c=snapshot("succeeded");c.tools.push({guidedTarget:"video",status:"done",job:"new-video"},{guidedTarget:"relay",status:"done",job:"relay-job"},{guidedTarget:"actor:0",status:"done",job:"reference-job"});
 assert.equal(directorJobState(c,"video").job,"new-video");assert.equal(directorJobState(c,"video").pending,true);assert.equal(directorJobState(c,"relay").pending,true);assert.equal(directorJobState(c,"actor:0").pending,true);assert.equal(directorJobState(c,"environment").pending,false);
});
