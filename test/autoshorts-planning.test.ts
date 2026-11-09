import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {AutoShorts} from "../server/autoshorts.ts";
import {planningConstraints} from "../server/autoshorts-planning.ts";
import {loadRegistry} from "../server/registry.ts";

const brief="Create EXACTLY TWO consecutive 5-second shots. Midnight. Native sound only. No narrator, no spoken dialogue, no background music.";
const valid=()=>({title:"Midnight",hook:"A visual hook",narration:"",closing:"A visual ending",music:"",visualBible:{
  style:"Photorealistic",timeOfDay:"night",lighting:"Amber streetlights",
  entities:[{id:"rosa",kind:"character",description:"One 70-year-old woman",traits:{wardrobe:"Leopard coat"},reference:"",approved:false},
    {id:"car",kind:"vehicle",description:"Tiny red hatchback",traits:{color:"red"},reference:"",approved:false},
    {id:"street",kind:"setting",description:"Marrakech at midnight",traits:{},reference:"",approved:false}]},
  scenes:[1,2].map(i=>({id:`shot_${i}`,order:i,duration:5,narration:"",dialogue:"",speechMode:"native",method:"video",engine:"pika-video",visual:"Midnight street",prompt:"One woman beside a red hatchback at midnight",references:[],instructions:"Native engines and ambience only",continuity:{entityIds:["rosa","car","street"],settingId:"street",timeOfDay:"night",lighting:"Amber streetlights",counts:{rosa:1,car:1,street:1},transition:false,notes:"Continuous door action"}}))});

async function run(response:()=>any,inspect?:(request:any)=>void){
  const dir=mkdtempSync(join(tmpdir(),"rf-planning-"));let requests=0;
  const server=createServer(async(req,res)=>{let raw="";for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);inspect?.(data);requests++;res.setHeader("content-type","application/json");res.end(JSON.stringify(response()));});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const service=new AutoShorts(dir,loadRegistry().apps,async()=>{throw new Error("No media/TTS inference allowed");});
  const p=service.create({topic:brief,mode:"CINEMA",videoEngine:"pika-video",duration:10,llmUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`});
  service.start(p.id,"plan");
  try{
    for(let i=0;i<200;i++){const result=service.get(p.id);if(!["queued","running"].includes(result.tasks.at(-1)!.status)){
      const diagnostics=JSON.parse(readFileSync(service.file(p.id,result.tasks.at(-1)!.planning!.path),"utf8"));return {p:result,requests,diagnostics};
    }await new Promise(r=>setTimeout(r,10));}throw new Error("Plan timed out");
  }finally{server.close();await once(server,"close");rmSync(dir,{recursive:true,force:true});}
}

test("explicit shot count and prohibited speech/music become planner constraints",()=>{
  assert.deepEqual(planningConstraints(brief),{count:2,noNarration:true,noDialogue:true,noMusic:true});
  assert.equal(planningConstraints("exactly six scenes").count,6);
  assert.equal(planningConstraints("Describe a film with a narrator").noNarration,false);
  assert.equal(planningConstraints("No narration in shot 1; narration in shot 2").noNarration,false);
  assert.equal(planningConstraints("No music during the first shot").noMusic,false);
});
test("the planner sees the exact JSON structure and honors a two-shot native-only brief",async()=>{
  const result=await run(()=>({choices:[{finish_reason:"stop",message:{content:JSON.stringify(valid())}}]}),request=>{
    const schema=request.response_format.json_schema.schema,shot=schema.properties.scenes.items.properties;
    assert.equal(schema.properties.scenes.minItems,2);assert.equal(schema.properties.scenes.maxItems,2);
    assert.equal(shot.method.const,"video");assert.equal(shot.engine.const,"pika-video");
    assert.doesNotMatch(JSON.stringify(schema),/"pattern"|"format"|"propertyNames"|"patternProperties"|"uniqueItems"/,"grammar must not send unsupported keywords");
    assert.equal(shot.narration.const,"");assert.equal(shot.dialogue.const,"");assert.equal(shot.speechMode.const,"native");
    assert.equal(request.chat_template_kwargs.enable_thinking,false);assert.equal(request.max_tokens,8192);
    const instructions=request.messages.map((m:any)=>m.content).join("\n");
    assert.match(instructions,/entityIds MUST include settingId/);assert.match(instructions,/"vehicle_1"/);
    assert.doesNotMatch(instructions,/Include hook and closing in scene narration/);
  });
  assert.equal(result.requests,1);assert.equal(result.p.tasks.at(-1)?.status,"succeeded");
  assert.equal(result.p.board?.scenes.length,2);assert.ok(result.p.board?.scenes.every(s=>!s.narration&&!s.dialogue));
  assert.equal(result.diagnostics.valid,true);
});
test("the observed duplicate IDs / generic counts remain invalid and their exact errors are saved",async()=>{
  const invalid=valid();invalid.visualBible.entities[1]={...invalid.visualBible.entities[0]};
  invalid.scenes[0].continuity.counts={people:1} as any;
  const result=await run(()=>({choices:[{finish_reason:"stop",message:{content:JSON.stringify(invalid)}}]}));
  assert.equal(result.requests,3);assert.equal(result.p.tasks.at(-1)?.status,"failed");assert.equal(result.p.board,undefined);
  assert.match(result.p.tasks.at(-1)?.error||"",/entity IDs must be unique/);
  assert.match(result.diagnostics.error,/unknown entity car/);assert.match(result.diagnostics.error,/count for absent entity people/);
  assert.ok(result.diagnostics.response);assert.ok(result.diagnostics.request);assert.equal(result.diagnostics.valid,false);
});
test("truncated completions are not accepted even if the returned prefix parses",async()=>{
  const result=await run(()=>({choices:[{finish_reason:"length",message:{content:JSON.stringify(valid())}}]}));
  assert.equal(result.p.tasks.at(-1)?.status,"failed");assert.match(result.diagnostics.error,/truncated/);
});
