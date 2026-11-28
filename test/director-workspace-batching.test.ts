import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { directorWriterMedia } from "../server/director-writer-media.ts";
import { directorPromptMode } from "../server/h3-plan.ts";
import { MediaTools } from "../server/media.ts";
import { loadRegistry, repoRoot } from "../server/registry.ts";
import { applyInputs, resolveValues } from "../server/runner.ts";
import { verifyWorkspaceGraph } from "../server/workspace-production.ts";
import { validateWriterReferences, writerHash } from "../server/workspace-writer.ts";

test("explicit zero references stay empty and selected pictures use local encoder numbering", () => {
  const values = { image1:{bytes:Buffer.from([1]),name:"room"}, image6:{bytes:Buffer.from([6]),name:"actor"} };
  const selected = directorWriterMedia(values, {images:[5,0]}, { image6:"actor",image1:"room" });
  assert.deepEqual(selected.media,{image1:values.image6,image2:values.image1});
  assert.deepEqual(selected.descriptions,["<Picture 1> = actor","<Picture 2> = room"]);
  assert.deepEqual(directorWriterMedia(values, {images:[]}).media,{});
  assert.deepEqual(directorWriterMedia(values, {}).media,{});
  assert.throws(()=>directorWriterMedia(values,{images:[5,5]}),/Duplicate/);
  assert.throws(()=>directorWriterMedia(values,{images:[3]}),/missing/);
  assert.throws(()=>validateWriterReferences("<Picture 6> is visible.",2),/supplied segment/);
  const mode = {hasVisual:true};
  assert.equal(directorPromptMode({...mode,first:true}),"i2va");
  assert.equal(directorPromptMode({...mode,last:true}),"l2va");
  assert.equal(directorPromptMode({...mode,first:true,last:true}),"fl2va");
  assert.equal(directorPromptMode({...mode,hasVisual:false,flexMode:"ref2va"}),"t2va");
});

test("lossless batch assembly preserves the planned 130-second video and its audio", { timeout: 20_000 }, async () => {
  const out=mkdtempSync(join(tmpdir(),"director-assembly-"));
  try {
    const paths=["a","b"].map(label=>join(out,label+".mp4"));
    for(const path of paths) execFileSync("ffmpeg", ["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=black:s=16x16:r=24",
      "-f","lavfi","-i","anullsrc=r=32000:cl=stereo","-t","65","-c:v","libx264","-threads","1","-c:a","aac",path]);
    const media = new MediaTools(out,out);
    const result = await media.concatMany(paths,[1560,1560]);
    assert.ok(Math.abs(result.outputs[0].metadata.duration-130)<0.1);
    assert.equal(result.outputs[0].metadata.audio,true);
    await assert.rejects(media.concatMany(paths,[1559,1560]),/planned 24 fps/);
  } finally { rmSync(out,{recursive:true,force:true}); }
});

test("the prepared hash must match the bound native renderer graph with the inline enhancer removed", () => {
  const app=loadRegistry(repoRoot()).apps.find(row=>row.id==="h3-studio-director-flash")!;
  const finalPrompt = "This is the audited writer output.";
  const values=resolveValues(app,{prompt_enhancer:false,segment_windows:JSON.stringify({
    windows:[{start:0,end:175,prompt:finalPrompt,images:[],audios:[]}],videos:[],audios:[],
  })});
  const graph=structuredClone(app.graph!);
  applyInputs(app,values,{json:graph,setInput(node,field,value){graph[node].inputs[field]=value}}, v=>v);
  assert.equal(Object.values(graph).some(node=>node.class_type==="TextGenerateV2"),false);
  const receipt=[{segment:1,finalPromptSha256:writerHash(finalPrompt)}];
  verifyWorkspaceGraph(app,values,graph,receipt);
  graph.rfplan.inputs.segment_windows = String(graph.rfplan.inputs.segment_windows).replace(finalPrompt, "Unexpected replacement");
  assert.throws(()=>verifyWorkspaceGraph(app,values,graph,receipt),/no longer matches/);
});
