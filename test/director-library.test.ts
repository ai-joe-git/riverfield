import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadRegistry} from "../server/registry.ts";
import {DirectorStore} from "../server/director-store.ts";
import {resolveValues,applyInputs} from "../server/runner.ts";
import {resolveNativeWriter} from "../server/workspace-writer.ts";
import {directorWriterMedia,directorWriterMode} from "../server/director-writer-media.ts";
// @ts-ignore Shared browser/server helpers.
import {compactEndpointLibrary,directorConditioningMode} from "../web/js/director-mode.js";
// @ts-ignore Existing timeline helpers.
import {rippleH3Windows} from "../web/js/director.js";
// @ts-ignore Per-scene editor pure defaults.
import {blankSegment} from "../web/js/sequential-state.js";
const apps=loadRegistry(process.cwd()).apps;
const app=apps.find(a=>a.id==="h3-studio-director-flash")!;
const file=(i:number)=>({name:`picture-${i}.png`,bytes:Uint8Array.of(i%255)});

test("a large FL2VA library compacts only selected endpoints without mutating the saved timeline",()=>{
 const files=Object.fromEntries(Array.from({length:250},(_,i)=>[`image${i+1}`,file(i)]));
 const spec={windows:[{start:0,end:175,prompt:"A",images:[1,0],first_frame:249,last_frame:12,audios:[]},{start:175,end:350,prompt:"B",images:[],last_frame:249,audios:[]}],videos:[],audios:[]};
 const values={flex_mode:"fl2va",segment_windows:JSON.stringify(spec)};
 const result=compactEndpointLibrary(values,files);
 assert.deepEqual(Object.keys(result.files),["image1","image2"]);
 assert.equal(result.files.image1,files.image250);assert.equal(result.files.image2,files.image13);
 const rendered=JSON.parse(result.values.segment_windows);
 assert.deepEqual(rendered.windows.map((w:any)=>[w.first_frame??null,w.last_frame??null]),[[0,1],[null,0]]);
 assert.deepEqual(JSON.parse(values.segment_windows),spec);
 assert.equal(Object.keys(files).length,250);
});

test("FL2VA can bind more than nine distinct endpoints; Ref2VA keeps nine reference slots",()=>{
 const spec={windows:Array.from({length:6},(_,i)=>({start:i*175,end:(i+1)*175,prompt:"Scene",images:[],audios:[],first_frame:i*2,last_frame:i*2+1}))};
 const files=Object.fromEntries(Array.from({length:12},(_,i)=>[`image${i+1}`,file(i)]));
 const values=resolveValues(app,{...files,flex_mode:"fl2va",prompt_enhancer:false,segment_windows:JSON.stringify(spec)});
 const graph=structuredClone(app.graph!);applyInputs(app,values,{json:graph,setInput(node,field,value){graph[node].inputs[field]=value;}},f=>f.name);
 assert.equal(graph.rfplan.inputs.image12,"picture-11.png");
 assert.deepEqual(Object.values(directorWriterMedia(values,spec.windows[5]).media),[files.image11,files.image12]);
 assert.throws(()=>resolveValues(app,{...files,flex_mode:"ref2va",prompt_enhancer:false,segment_windows:JSON.stringify({windows:[{...spec.windows[0],images:[11]}]})}),/supplied file slots/);
});

test("extra library images remain durable across a reload without expanding Ref2VA manifests",()=>{
 const out=mkdtempSync(join(tmpdir(),"director-library-"));
 try{const store=new DirectorStore(out,new Map([[app.id,app]]));store.putMedia(app.id,"image250",Uint8Array.of(1),"many.png","image/png");
 assert.equal(new DirectorStore(out,new Map([[app.id,app]])).view(app.id)!.media.image250.name,"many.png");
 assert.ok(store.mediaPath(app.id,"image250"));store.deleteMedia(app.id,"image250");assert.equal(store.mediaPath(app.id,"image250"),null);
 assert.equal(app.inputs.filter(i=>/^image\d+$/.test(i.id)).length,9);
 }finally{rmSync(out,{recursive:true,force:true});}
});

test("pi-H3 Director is FL2VA-only and preserves the installed DWD recipe",()=>{
 const pi=apps.find(a=>a.id==="h3-piflow-director")!;
 assert.equal(pi.graph!['1'].inputs.unet_name,"minimax_h3_fl2va_pruned_int8_convrot.safetensors");
 const mode=pi.inputs.find(i=>i.id==="flex_mode")!;assert.deepEqual(mode.options!.map(o=>o.value),["fl2va"]);
 assert.equal(directorConditioningMode(resolveValues(pi,{global_prompt:"A quiet room",prompt_enhancer:false})),"fl2va");
 assert.deepEqual(pi.inputs.find(i=>i.id==="steps")!.options!.map(o=>o.value),[2,4,6]);
});

test("LTX new scenes are independent cuts and duration edits retain explicit old seams",()=>{
 const seq=apps.find(a=>a.id==="ltx-sequential-director")!;assert.equal(blankSegment(seq).cut,true);
 const before=[{start:0,end:360},{start:360,end:720},{start:681,end:1041}];const windows=structuredClone(before);windows[0].end=480;
 rippleH3Windows(windows,0,before,false);assert.equal(windows[1].start,480);assert.equal(windows[1].end-windows[2].start,39);
 for(const id of ["ltx-director","ltx-sequential-director","ltx-director-4seg"])assert.deepEqual(apps.find(a=>a.id===id)!.modes,["ltx-director","ltx-sequential-director","ltx-director-4seg"]);
});

test("every H3 and LTX conditioning combination routes to its exact installed writer preset",()=>{
 const h3=apps.find(a=>a.id==="prompt-enhancer")!,ltx=apps.find(a=>a.id==="ltx-prompt-generator")!;
 for(const [fields,expected] of [[{},"t2va"],[{first_frame:0},"i2va"],[{last_frame:1},"l2va"],[{first_frame:0,last_frame:1},"fl2va"]] as const){
   const values={flex_mode:"fl2va",image1:file(0),image2:file(1)};
   const window={images:[1,0],...fields};const mode=directorWriterMode(values,directorWriterMedia(values,window),window);
   assert.equal(mode,expected);assert.equal(resolveNativeWriter(h3,mode).mode,expected);
 }
 for(const [fields,expected] of [[{},"t2v"],[{image:file(0)},"first_frame"],[{last_frame:file(1)},"last_frame"],[{image:file(0),last_frame:file(1)},"first_last"]] as const){
   const mode=directorWriterMode(fields,directorWriterMedia(fields),undefined,true);
   assert.equal(mode,expected);assert.equal(resolveNativeWriter(ltx,mode).mode,expected);
 }
 const refs={flex_mode:"ref2va",image1:file(0)};assert.equal(directorWriterMode(refs,directorWriterMedia(refs,{images:[0]}),{images:[0]}),"ref2va");
 const keyframe={image1:file(0)};assert.equal(directorWriterMode(keyframe,directorWriterMedia(keyframe,{images:[0]}),{images:[0]},true),"first_frame");
});

test("an unassigned FL2VA library is never sent as global Ref2VA material",()=>{
 const values=resolveValues(app,{flex_mode:"fl2va",global_prompt:"Independent scene",image1:file(0),prompt_enhancer:false});
 assert.equal(directorWriterMedia(values).pictures,0);
 const graph=structuredClone(app.graph!);applyInputs(app,values,{json:graph,setInput(node,field,value){graph[node].inputs[field]=value;}},f=>f.name);
 assert.equal(graph.rfplan.inputs.conditioning_mode,"fl2va");
});
