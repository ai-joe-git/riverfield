import {test} from "node:test";
import assert from "node:assert/strict";
import {normalizeRunInputs} from "../server/run-inputs.ts";
import {loadRegistry} from "../server/registry.ts";
import {InputError} from "../server/input-error.ts";

const apps=loadRegistry(process.cwd()).apps,pika=apps.find(a=>a.id==="pika-studio-director")!,moss=apps.find(a=>a.id==="moss-turbo")!,qwen=apps.find(a=>a.id==="qwen-image-edit-turbo")!;
const timeline=JSON.stringify({windows:[0,136,272].map(start=>({start,end:start+175,prompt:"Unchanged creative text",images:[0,1],audios:[]}))});
test("Maya failure 1: declared image paths in values are routed to files without changing the script",()=>{
 const raw={segment_windows:timeline,image1:"/known/maya.png",image2:"/known/corridor.png"};
 const n=normalizeRunInputs(pika,raw);assert.deepEqual(n.files,{image1:"/known/maya.png",image2:"/known/corridor.png"});assert.deepEqual(n.values,{segment_windows:timeline});assert.equal(raw.image1,"/known/maya.png");
});
test("Maya failure 2: remove only the provably redundant misplaced image-index list",()=>{
 const files={image1:"/known/maya.png",image2:"/known/corridor.png"};
 assert.deepEqual(normalizeRunInputs(pika,{segment_windows:timeline,image:[0,1]},files),{values:{segment_windows:timeline},files});
 for(const indices of [[1,0],[0],[0,2]])assert.deepEqual(normalizeRunInputs(pika,{segment_windows:timeline,image:indices},files).values.image,indices,"ambiguous intent must not be silently changed");
 assert.throws(()=>normalizeRunInputs(pika,{image1:"/other.png"},files),(e:InputError)=>e.issues[0].code==="FILE_BINDING_CONFLICT");
});
test("aspect shorthand is canonicalized only to a unique actual option, never to a guessed ratio",()=>{
 assert.equal(normalizeRunInputs(moss,{aspect:"16:9"}).values.aspect,"16:9 (Widescreen)");
 assert.equal(normalizeRunInputs(pika,{aspect:"9:16"}).values.aspect,"9:16 (Portrait Widescreen)");
 assert.equal(normalizeRunInputs(pika,{aspect:"17:9"}).values.aspect,"17:9");
});
