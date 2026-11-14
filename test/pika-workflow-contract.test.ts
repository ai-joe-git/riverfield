import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {loadRegistry} from "../server/registry.ts";
import {applyInputs,resolveValues,InputError} from "../server/runner.ts";
import {directorValues,DIRECTOR_DELIVERY} from "../server/h3-plan.ts";

const apps=loadRegistry(process.cwd()).apps,pika=apps.find(a=>a.id==="pika-studio-director")!,relay=apps.find(a=>a.id==="relayvsr-upscale")!;
const file={bytes:new Uint8Array([1]),name:"reference.png"},example=JSON.parse(readFileSync("apps/pika-studio-director/request-example.json","utf8"));

test("effective Pika defaults retain LCM/six sigmas and use 0.4 MP, sparsity 0.85 and the default encoder",()=>{
 const values=resolveValues(pika,directorValues({...example.values,image1:file,image2:file,clip_name:"qwen3vl_32b_minimax_h3_ultra_uncensored_heretic_int8_convrot.safetensors",detail:.1,multiple:8,sla:false,codec:"av1",filename_prefix:"invented"})),graph=structuredClone(pika.graph!);
 applyInputs(pika,values,{json:graph,setInput:(node,field,value)=>{graph[node].inputs[field]=value;}},()=>"reference.png");
 assert.equal(graph[13].inputs.sampler_name,"lcm");assert.equal(graph[50].inputs.sigmas,"1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0");
 assert.equal(String(graph[50].inputs.sigmas).split(",").length-1,6);assert.equal(graph[40].inputs.strength_model,1);
 assert.equal(graph[41].inputs.megapixels,.4);assert.equal(graph[41].inputs.multiple,32);assert.equal(graph[42].inputs.sparsity_ratio,.85);assert.equal(graph[42].inputs.enabled,true);
 assert.equal(graph[2].inputs.clip_name,"qwen3vl_32b_minimax_h3_int8_convrot.safetensors");assert.equal(graph[29].inputs["format.codec"],"h264");assert.equal(graph[29].inputs.filename_prefix,"riverfield/pika-studio-director");
 assert.equal(graph.rfplan.inputs.two_stage,false);assert.equal(graph[30].inputs.continue_audio_latent,"match");assert.equal(graph[30].inputs.ref_image_size,"match");
});
test("global prompt fallback matches the native finite sampler; line-split multi-line prompts cannot slip through",()=>{
 const spec=JSON.parse(example.values.segment_windows),prompt=spec.windows[0].prompt;spec.windows[0].prompt="";spec.windows.push({...spec.windows[0],start:136,end:311});
 assert.doesNotThrow(()=>resolveValues(pika,{...example.values,global_prompt:prompt,segment_windows:JSON.stringify(spec),image1:file,image2:file}));
 spec.windows[0].prompt=prompt;assert.throws(()=>resolveValues(pika,{...example.values,global_prompt:prompt,segment_windows:JSON.stringify(spec),image1:file,image2:file}),/prompt for every segment/);
 assert.throws(()=>resolveValues(pika,{...example.values,segment_windows:"",segment_prompts:prompt,image1:file,image2:file}),(e:InputError)=>e.issues[0].code==="PIKA_PROMPT_INPUT");
});
test("locked soundtrack continuity is validated before model dispatch",()=>{
 const spec=JSON.parse(example.values.segment_windows);spec.windows[0].audios=[0];spec.windows.push({...spec.windows[0],start:136,end:311});
 const values={...example.values,segment_windows:JSON.stringify(spec),image1:file,image2:file,audio1:file,audio2:file,audio_mode:"locked"};assert.doesNotThrow(()=>resolveValues(pika,values));
 for(const selection of [[],[1],[0,1]]){spec.windows[1].audios=selection;assert.throws(()=>resolveValues(pika,{...values,segment_windows:JSON.stringify(spec)}),(e:InputError)=>e.issues[0].code==="PIKA_LOCKED_SOUNDTRACK");}
});
test("Relay's x2/x4 model pair is server-synchronized; mismatches fail before decode",()=>{
 const defaults=resolveValues(relay,{video:file});assert.match(String(defaults.unet_name),/_x2_/);assert.match(String(defaults.vae_name),/_x2_/);
 const x4=relay.inputs.find(i=>i.id==="unet_name")!.options![1].value,vae4=relay.inputs.find(i=>i.id==="vae_name")!.options![1].value;
 assert.equal(resolveValues(relay,{video:file,unet_name:x4}).vae_name,vae4);assert.equal(resolveValues(relay,{video:file,vae_name:vae4}).unet_name,x4);
 assert.throws(()=>resolveValues(relay,{video:file,unet_name:x4,vae_name:defaults.vae_name}),(e:InputError)=>e.issues[0].code==="RELAY_MODEL_PAIR");
 assert.equal(DIRECTOR_DELIVERY.defaultScale,"x2");assert.equal(DIRECTOR_DELIVERY.separateRun,true);assert.equal(.4*DIRECTOR_DELIVERY.pixelAreaMultipliers.x2,1.6);assert.equal(.4*DIRECTOR_DELIVERY.pixelAreaMultipliers.x4,6.4);
 assert.ok(!pika.inputs.some(i=>i.id==="relay_scale"),"Relay is not advertised as a non-existent Pika workflow input");
});
