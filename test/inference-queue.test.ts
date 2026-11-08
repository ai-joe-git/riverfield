import { test } from "node:test";
import assert from "node:assert/strict";
import { InferenceQueue } from "../server/inference-queue.ts";

function gate() { let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}; }
const tick = () => new Promise<void>(r=>setImmediate(r));

test("one shared FIFO serializes LLM, prepare, generation and upscale until completion",async()=>{
  const queue=new InferenceQueue(), first=gate(), second=gate(), events:string[]=[];
  let active=0,max=0;
  const work=(label:string,wait?:Promise<void>)=>async()=>{
    active++;max=Math.max(max,active);events.push(`${label}:prepare`);
    if(wait)await wait;events.push(`${label}:complete`);active--;return label;
  };
  const a=queue.run("LLM",work("LLM",first.promise));
  const positions:(number|null)[]=[];
  const b=queue.run("H3",work("H3",second.promise),undefined,p=>positions.push(p));
  const c=queue.run("RelayVSR",work("RelayVSR"));
  assert.deepEqual(events,["LLM:prepare"]);assert.equal(queue.snapshot().waiting.length,2);
  first.resolve();await a;await tick();assert.deepEqual(events,["LLM:prepare","LLM:complete","H3:prepare"]);
  second.resolve();assert.deepEqual(await Promise.all([b,c]),["H3","RelayVSR"]);assert.equal(max,1);
  assert.deepEqual(events,["LLM:prepare","LLM:complete","H3:prepare","H3:complete","RelayVSR:prepare","RelayVSR:complete"]);
  assert.ok(positions.includes(1));assert.ok(positions.includes(null));
});

test("canceling a waiting job never submits or prepares its model",async()=>{
  const queue=new InferenceQueue(), held=gate(), controller=new AbortController();let submitted=false;
  const active=queue.run("active",()=>held.promise);
  const waiting=queue.run("queued",async()=>{submitted=true;},controller.signal);
  const rejection=assert.rejects(waiting);controller.abort();await rejection;
  assert.equal(submitted,false);assert.equal(queue.snapshot().waiting.length,0);
  held.resolve();await active;
});

test("canceling active inference retains the slot until actual backend completion",async()=>{
  const queue=new InferenceQueue(), backendStopped=gate(), controller=new AbortController();let nextStarted=false;
  const active=queue.run("active",async()=>{await backendStopped.promise;controller.signal.throwIfAborted();},controller.signal);
  const rejection=assert.rejects(active);
  const next=queue.run("next",async()=>{nextStarted=true;});
  controller.abort();await tick();assert.equal(nextStarted,false);assert.equal(queue.snapshot().active?.label,"active");
  backendStopped.resolve();await rejection;await next;assert.equal(nextStarted,true);
});

test("GPU context failure stops queued models rather than feeding the failed device",async()=>{
  const queue=new InferenceQueue(), held=gate();let nextStarted=false;
  const active=queue.run("TTS",async()=>{await held.promise;throw new Error("CUDA error: unspecified launch failure hipErrorLaunchFailure");});
  const waiting=queue.run("H3",async()=>{nextStarted=true;});
  const results=Promise.allSettled([active,waiting]);held.resolve();const outcomes=await results;
  assert.ok(outcomes.every(r=>r.status==="rejected"));assert.equal(nextStarted,false);assert.match(queue.snapshot().blocked||"",/context failure/);
  await assert.rejects(queue.run("another",async()=>{}),/Restart/);
});

test("an ordinary validation failure does not poison the queue",async()=>{
  const queue=new InferenceQueue();const first=queue.run("bad",async()=>{throw new Error("Missing reference image");});
  const next=queue.run("good",async()=>42);await assert.rejects(first,/Missing/);assert.equal(await next,42);assert.equal(queue.snapshot().blocked,null);
});

test("startup recovery is a barrier: no new prepare while an old backend job runs",async()=>{
  const queue=new InferenceQueue(), existing=gate();let prepare=false;
  const recovered=queue.run("recover",()=>existing.promise);
  const newJob=queue.run("new",async()=>{prepare=true;});await tick();assert.equal(prepare,false);
  existing.resolve();await Promise.all([recovered,newJob]);assert.equal(prepare,true);
});
