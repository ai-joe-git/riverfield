import {readFileSync} from "node:fs";
/** Inspect listeners, not process names. No model loading or inference requests. */
export function localCandidates(read:(file:string)=>string=f=>readFileSync(f,"utf8")){
  const urls=new Set<string>();
  for(const [file,v6] of [["/proc/net/tcp",false],["/proc/net/tcp6",true]] as const){
    let text="";try{text=read(file);}catch{continue;}
    for(const line of text.split("\n").slice(1)){
      const cols=line.trim().split(/\s+/);if(cols[3]!=="0A")continue;
      const [host,hex]=String(cols[1]).split(":"),port=parseInt(hex,16);if(!port)continue;
      // Wildcard-bound servers are probed through loopback, never a LAN address.
      if(!v6&&["0100007F","00000000"].includes(host))urls.add(`http://127.0.0.1:${port}/v1`);
      if(v6&&["00000000000000000000000001000000","00000000000000000000000000000000"].includes(host))urls.add(`http://[::1]:${port}/v1`);
    }
  }return [...urls];
}
export async function discoverModels(candidates=localCandidates(),doFetch:typeof fetch=fetch){
  const found:{url:string;models:string[]}[]=[];let next=0;
  await Promise.all(Array.from({length:Math.min(8,candidates.length)},async()=>{while(next<candidates.length){const url=candidates[next++];try{
    const r=await doFetch(`${url}/models`,{signal:AbortSignal.timeout(1200),redirect:"error"});if(!r.ok)continue;
    const d=await r.json() as any;if(!Array.isArray(d.data))continue;
    found.push({url,models:d.data.map((m:any)=>m.id).filter((m:any)=>typeof m==="string")});
  }catch{/* Non-HTTP listeners and unrelated services are not inference endpoints. */}}}));
  return found.sort((a,b)=>a.url.localeCompare(b.url));
}
