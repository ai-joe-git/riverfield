import {openSync,readSync,closeSync,statSync} from "node:fs";

// Bounded GGUF metadata preflight, adapted from BlackRiver's gguf-metadata reader.
// Tensor payloads and tokenizer arrays are never returned to the UI/model.
export function ggufMetadata(path:string){
 const fd=openSync(path,"r");try{const buffer=Buffer.alloc(Math.min(statSync(path).size,16*1024**2));const length=readSync(fd,buffer,0,buffer.length,0);let offset=4;
  const need=(n:number)=>{if(!Number.isSafeInteger(n)||n<0||offset+n>length)throw new Error("Metadata exceeds the 16 MiB preflight window");};
  const u32=()=>{need(4);const v=buffer.readUInt32LE(offset);offset+=4;return v;};const u64=()=>{need(8);const n=buffer.readBigUInt64LE(offset);offset+=8;if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("Oversized GGUF metadata");return Number(n);};
  const str=(keep=true)=>{const n=u64();need(n);const value=keep?buffer.toString("utf8",offset,offset+Math.min(n,4000)):"";offset+=n;return value;};
  const sizes:Record<number,number>={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};
  const value=(type:number,keep:boolean,depth=0):unknown=>{if(depth>2)throw new Error("Nested metadata exceeds limits");if(type===8)return str(keep);if(type===9){const element=u32(),count=u64();if(count>10000000)throw new Error("Oversized metadata array");if(sizes[element]){need(sizes[element]*count);offset+=sizes[element]*count;}else for(let i=0;i<count;i++)value(element,false,depth+1);return undefined;}
   const size=sizes[type];if(!size)throw new Error("Unknown GGUF metadata type");need(size);let v:unknown;
   if(keep){if(type===4)v=buffer.readUInt32LE(offset);else if(type===5)v=buffer.readInt32LE(offset);else if(type===6)v=buffer.readFloatLE(offset);else if(type===7)v=!!buffer.readUInt8(offset);else if(type===10)v=String(buffer.readBigUInt64LE(offset));else if(type===11)v=String(buffer.readBigInt64LE(offset));else if(type===12)v=buffer.readDoubleLE(offset);else v=type===0?buffer.readUInt8(offset):type===1?buffer.readInt8(offset):type===2?buffer.readUInt16LE(offset):buffer.readInt16LE(offset);}
   offset+=size;return v;
  };
  u32();u64();const count=u64(),metadata:Record<string,unknown>=Object.create(null);if(count>100000)throw new Error("Oversized metadata dictionary");for(let i=0;i<count;i++){const key=str(),type=u32(),keep=/^(general\.(architecture|name|type|file_type)|clip\.projector_type|clip\.has_(?:vision|audio)_encoder|[\w.-]+\.(context_length|embedding_length|block_count|nextn_predict_layers|attention\.head_count(?:_kv)?))$/.test(key);const v=value(type,keep);if(keep&&v!==undefined)metadata[key]=v;}return {metadata,metadataError:null};
 }catch(e){return {metadata:{},metadataError:(e as Error).message};}finally{closeSync(fd);}
}
