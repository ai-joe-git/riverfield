import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {AgentStore} from "../server/agent-store.ts";
import {MediaTools,command} from "../server/media.ts";

test("soundtrack inspection extracts bounded mono WAV on CPU without modifying the video",async()=>{
 const dir=mkdtempSync("/tmp/opencode/riverfield-audio-extract-");try{
  const path=join(dir,"fixture.mp4");await command("ffmpeg",["-y","-f","lavfi","-i","color=c=black:s=16x16:d=1","-f","lavfi","-i","sine=frequency=440:duration=1","-c:v","libx264","-threads","1","-c:a","aac","-shortest",path]);
  const store=new AgentStore(join(dir,"agent")),c=store.create(),bytes=readFileSync(path),a=store.upload(c,bytes,"sample.mp4","video/mp4"),media=new MediaTools(dir,process.cwd()),result=await media.run({operation:"audio",path:a.path});
  const output=result.outputs?.[0];assert.ok(output);assert.equal(output.type,"audio");assert.ok(output.path.endsWith(".wav"));assert.equal(output.metadata.audio,true);assert.ok(output.metadata.duration<1.2);assert.deepEqual(readFileSync(a.path),bytes);
  const info=JSON.parse(await command("ffprobe",["-v","error","-show_entries","stream=sample_rate,channels","-of","json",output.path]));assert.equal(info.streams[0].sample_rate,"24000");assert.equal(info.streams[0].channels,1);
  await assert.rejects(()=>media.run({operation:"audio",path:"/etc/passwd"}),/Unsupported|outside/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
