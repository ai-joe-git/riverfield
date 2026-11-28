import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../server/registry.ts";
import { resolveValues, applyInputs } from "../server/runner.ts";
import { directorWriterMedia } from "../server/director-writer-media.ts";
import { planH3, directorValues, directorPromptMode } from "../server/h3-plan.ts";
// @ts-ignore Shared browser module.
import { directorConditioningMode } from "../web/js/director-mode.js";
// @ts-ignore Browser controls and cleanup helpers.
import { pruneMedia } from "../web/js/director.js";

const apps = loadRegistry(process.cwd()).apps;
const file = (name:string, byte:number) => ({name,bytes:Uint8Array.from([byte])});
const image1 = file("first.png",1), image2 = file("last.png",2);
const brief = "integrated_multimodal_description:\n[Shot 1] A quiet room.\noverall_soundscape:\nRoom tone.\nnon_diegetic_music:\nN/A";
const spec = (endpoints:Record<string,unknown>={}) => ({windows:[{start:0,end:175,prompt:brief,images:[1,0],audios:[],...endpoints}],videos:[],audios:[]});

test("all H3 Directors with FL2VA checkpoints bind segment endpoints and ignore dormant Ref2VA assignments",()=>{
  for (const id of ["studio-director","pika-studio-director","h3-studio-director-flash"]) {
    const app = apps.find(a=>a.id===id)!;
    for (const endpoints of ([{},{first_frame:1},{last_frame:0},{first_frame:1,last_frame:0},{first_frame:0,last_frame:0}] as {first_frame?:number;last_frame?:number}[])) {
      const values = resolveValues(app,{flex_mode:"fl2va",unet_name:"minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        prompt_enhancer:false,image1,image2,segment_windows:JSON.stringify(spec(endpoints))});
      const timeline = JSON.parse(String(values.segment_windows));
      assert.equal(timeline.conditioning_mode,"fl2va",id);
      assert.deepEqual(timeline.windows[0].images,[1,0],"keep dormant references for switching back");
      const selection=directorWriterMedia(values,timeline.windows[0]);
      const expected=[endpoints.first_frame,endpoints.last_frame].filter(n=>n!==undefined).map(n=>n===0?image1:image2);
      assert.deepEqual(Object.values(selection.media),expected);
      assert.equal(directorPromptMode({flexMode:"fl2va",hasVisual:!!expected.length,
        first:selection.frames.includes("first_frame"),last:selection.frames.includes("last_frame")}),
        endpoints.first_frame!==undefined?(endpoints.last_frame!==undefined?"fl2va":"i2va"):(endpoints.last_frame!==undefined?"l2va":"t2va"));
      const graph=structuredClone(app.graph!);
      applyInputs(app,values,{json:graph,setInput(node,field,value){graph[node].inputs[field]=value;}},v=>v);
      assert.deepEqual(JSON.parse(String(graph.rfplan.inputs.segment_windows)).windows[0],timeline.windows[0]);
    }
  }
});

test("actual selected model decides the mode, and raw timeline metadata cannot override it",()=>{
  assert.equal(directorConditioningMode({unet_name:"minimax_h3_fl2va_pruned_int8_convrot.safetensors"}),"fl2va");
  assert.equal(directorConditioningMode({unet_name:"minimax_h3_ref2va.safetensors"}),"ref2va");
  assert.equal(directorConditioningMode({flex_mode:"auto",image1,segment_windows:spec({last_frame:1})}),"fl2va");
  const app=apps.find(a=>a.id==="h3-studio-director-flash")!;
  const values=resolveValues(app,{flex_mode:"ref2va",image1,image2,prompt_enhancer:false,
    segment_windows:JSON.stringify({...spec({first_frame:0}),conditioning_mode:"fl2va"})});
  assert.equal(JSON.parse(String(values.segment_windows)).conditioning_mode,"ref2va");
  assert.deepEqual(Object.values(directorWriterMedia(values,spec({first_frame:0}).windows[0]).media),[image2,image1]);
});

test("invalid or unavailable endpoint slots fail before writing or rendering",()=>{
  const app=apps.find(a=>a.id==="h3-studio-director-flash")!;
  for (const endpoint of [-1,9,true,"0",0.5,1]) {
    assert.throws(()=>resolveValues(app,{flex_mode:"fl2va",image1,prompt_enhancer:false,
      segment_windows:JSON.stringify(spec({first_frame:endpoint}))}),/first_frame/);
  }
});

test("removing an uploaded picture clears only endpoints and references pointing to its slot",()=>{
  const app=apps.find(a=>a.id==="h3-studio-director-flash")!;
  const state:any=spec({first_frame:0,last_frame:1});
  assert.equal(pruneMedia(state,app,{files:{image2:{file:image2}}}),true);
  assert.equal(state.windows[0].first_frame,undefined);
  assert.equal(state.windows[0].last_frame,1);
  assert.deepEqual(state.windows[0].images,[1]);
});

test("MCP planner arrays keep first and last endpoint roles across independent scenes",()=>{
 const plan=planH3({seconds:7.3,prompts:["A","B","C"],segment_first_frames:[1,null,0],segment_last_frames:[null,0,1]});
 const windows=JSON.parse(plan.segment_windows).windows;
 assert.deepEqual(windows.map((w:any)=>[w.first_frame??null,w.last_frame??null]),[[1,null],[null,0],[0,1]]);
 assert.equal(windows[1].start,windows[0].end);
 assert.equal(directorValues({segment_windows:plan.segment_windows},{image1,image2}).flex_mode,"fl2va");
 assert.throws(()=>planH3({seconds:7.3,prompts:["A","B"],segment_first_frames:[0]}),/one entry per prompt/);
});
