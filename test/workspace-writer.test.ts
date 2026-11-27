import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRegistry, repoRoot } from "../server/registry.ts";
import { validateWorkspaceWriter, workspaceSystemPrompt, writeWorkspacePrompt } from "../server/workspace-writer.ts";

const app = loadRegistry(repoRoot()).apps.find(row=>row.id==="prompt-enhancer")!;
const model = "halogen-test";
const writer = validateWorkspaceWriter({baseUrl:"http://127.0.0.1:8731/v1",model,vision:true});

test("Workspace uses the exact installed mode preset and ordered images", async () => {
 const mode = "ref2va";
 const expected=app.inputs.find(i=>i.id==="prompt_mode")?.options?.find(i=>i.value===mode)?.sets?.[0]?.value;
 assert.equal(workspaceSystemPrompt(app,mode),expected);
 const jpeg={bytes:Buffer.from([255,216,255,1]),name:"first.jpg"};
 const png={bytes:Buffer.from("89504e470d0a1a0a","hex"),name:"second.png"};
 const text=await writeWorkspacePrompt(writer,app,{mode,prompt:"Neutral storyboard",media:{image1:jpeg,image2:png}},async(url,init)=>{
  assert.equal(url,"http://127.0.0.1:8731/v1/chat/completions");
  const body=JSON.parse(String(init?.body));
  assert.equal(body.model,model);
  assert.equal(body.reasoning_effort,process.env.RIVERFIELD_WORKSPACE_WRITER_REASONING_EFFORT?.trim() || undefined);
  assert.equal(body.messages[0].content,expected);
  assert.match(body.messages[1].content[1].image_url.url,/^data:image\/jpeg/);
  assert.match(body.messages[1].content[2].image_url.url,/^data:image\/png/);
  assert.equal(init?.redirect,"error");
  return Response.json({choices:[{finish_reason:"stop",message:{content:"Finished prompt"}}]});
 });
 assert.equal(text,"Finished prompt");
});

test("Writer rejects remote endpoints, text-only reference use and truncated rewrites", async () => {
 for(const baseUrl of ["https://example.com/v1","http://127.0.0.1:8731/admin","http://user@127.0.0.1:8731/v1"])
  assert.throws(()=>validateWorkspaceWriter({baseUrl,model}),/active local/);
 await assert.rejects(writeWorkspacePrompt({...writer,vision:false},app,{mode:"ref2va",prompt:"draft",media:{image1:{bytes:Buffer.alloc(8)}}}),/image support/);
 await assert.rejects(writeWorkspacePrompt(writer,app,{mode:"t2va",prompt:"draft",media:{}},async()=>Response.json({choices:[{finish_reason:"length",message:{content:"partial"}}]})),/complete prompt/);
});


test("Workspace resolves a renamed generator and rejects ambiguous manifests", () => {
  const { gen, ...other } = app.graph!;
  const renamed = { ...app, graph: { ...other, model_writer: gen } };
  assert.equal(workspaceSystemPrompt(renamed, "t2va"), workspaceSystemPrompt(app, "t2va"));
  assert.throws(() => workspaceSystemPrompt({ ...renamed, graph: { ...renamed.graph, other_writer: gen } }, "t2va"), /system prompt binding/);
});

test("Workspace normalizes complete fences and rejects unfinished wrappers", async () => {
  for (const [content, expected] of [
    ["<think>notes</think>\n<ThInK>more</tHiNk>\n```text\r\nA quiet shot.\r\n```", "A quiet shot."],
    ["First line.\n```text\nA prompt example.\n```", "First line.\n```text\nA prompt example.\n```"],
    ["```text\nUnfinished", null],
    ["<think>unfinished", null],
    ["```text\nA shot.\n```\nOutro\n```", null],
  ] as const) {
    const result = writeWorkspacePrompt(writer, app, { mode: "t2va", prompt: "Draft", media: {} },
      async () => Response.json({ choices: [{ finish_reason: "stop", message: { content } }] }));
    if (expected === null) await assert.rejects(result, /complete prompt/);
    else assert.equal(await result, expected);
  }
});
