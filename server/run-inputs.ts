import {InputError} from "./input-error.ts";

type Manifest={id:string;name?:string;inputs:Array<{id:string;type:string;options?:unknown[];multiple?:unknown;min?:number;max?:number;help?:string}>};
const isFile=(input:{type:string})=>["image","video","audio"].includes(input.type);

/** Mechanical transport fixes only, using the actual manifest. Never infer a new reference. */
export function normalizeRunInputs(app:Manifest,rawValues:Record<string,unknown>={},rawFiles:Record<string,unknown>={}){
 const values={...rawValues},files={...rawFiles},inputs=app.inputs||[];
 for(const input of inputs){
  if(isFile(input)&&values[input.id]!==undefined){
   const path=values[input.id];
   if(typeof path!=="string")throw new InputError(`${input.id}: a file path is required in files`,[{code:"FILE_BINDING_TYPE",field:`files.${input.id}`,message:"Use a known file path, not a material index"}]);
   if(files[input.id]!==undefined&&files[input.id]!==path)throw new InputError(`${input.id}: conflicting file bindings`,[{code:"FILE_BINDING_CONFLICT",field:`files.${input.id}`,message:"values and files specify different paths; neither was selected"}]);
   files[input.id]=path;delete values[input.id];
  }
  if(input.id==="aspect"&&typeof values.aspect==="string"&&/^\d+:\d+$/.test(values.aspect)){
   const options=(input.options||[]).map(o=>o&&typeof o==="object"&&"value" in o?(o as {value:unknown}).value:o);
   const matches=options.filter(o=>typeof o==="string"&&o.split(" ")[0]===values.aspect);
   if(matches.length===1)values.aspect=matches[0];
  }
 }
 if(app.id==="pika-studio-director"&&!inputs.some(i=>i.id==="image")&&Array.isArray(values.image)){
  let spec:any;try{spec=typeof values.segment_windows==="string"?JSON.parse(values.segment_windows):values.segment_windows;}catch{/* Leave malformed timelines to the execution validator. */}
  const indices=values.image;
  if(indices.length&&indices.every(n=>Number.isInteger(n)&&Number(n)>=0&&inputs.some(i=>i.id===`image${Number(n)+1}`&&isFile(i))&&files[`image${Number(n)+1}`])&&Array.isArray(spec?.windows)&&spec.windows.length&&spec.windows.every((w:any)=>JSON.stringify(w?.images)===JSON.stringify(indices)))delete values.image;
 }
 return {values,files};
}
