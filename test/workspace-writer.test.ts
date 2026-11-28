import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRegistry, repoRoot } from "../server/registry.ts";
import { readFileSync } from "node:fs";
import { applyInputs, resolveValues } from "../server/runner.ts";
import { resolveNativeWriter, validateWorkspaceWriter, workspaceSystemPrompt, workspaceWriterParameters, writeWorkspacePrompt, writerHash, plainDirectorDraft, type WriterReceipt } from "../server/workspace-writer.ts";

const app = loadRegistry(repoRoot()).apps.find(row=>row.id==="prompt-enhancer")!;
const model = "halogen-test";
const sampling = ["temperature", "top_p", "top_k", "min_p", "seed", "presence_penalty", "repetition_penalty"];
const writer = validateWorkspaceWriter({baseUrl:"http://127.0.0.1:8731/v1",model,vision:true,backend:"halogen",
  sampling,reasoningNone:true,enableThinking:true,noStore:true});

test("Workspace uses the exact installed mode preset and ordered images", async () => {
 const mode = "ref2va";
 const expected=app.inputs.find(i=>i.id==="prompt_mode")?.options?.find(i=>i.value===mode)?.sets?.[0]?.value;
 assert.equal(workspaceSystemPrompt(app,mode),expected);
 const jpeg={bytes:Buffer.from([255,216,255,1]),name:"first.jpg"};
 const png={bytes:Buffer.from("89504e470d0a1a0a","hex"),name:"second.png"};
 let receipt;
 const text=await writeWorkspacePrompt(writer,app,{mode,prompt:"Neutral storyboard",media:{image2:png,image1:jpeg},
  audit:{segment:1,brief:"Exact brief",references:[{slot:"image3",assetId:"actor",sha256:writerHash(jpeg.bytes),kind:"image"},
    {slot:"image2",assetId:"room",sha256:writerHash(png.bytes),kind:"image"}],save:value=>{receipt=value}}},async(url,init)=>{
  assert.equal(url,"http://127.0.0.1:8731/v1/chat/completions");
  const body=JSON.parse(String(init?.body));
  assert.equal(body.model,model);
  assert.equal(body.reasoning_effort,"none");
  assert.equal(body.enable_thinking,false);
  assert.equal(body.prompt_cache_policy,"no_store");
  assert.equal(body.max_tokens,4096);
  assert.deepEqual(sampling.map(key=>body[key]),[0.7,0.95,64,0.05,0,0,1.05]);
  assert.deepEqual(body.messages.map((message: {role:string})=>message.role),["system","user"]);
  assert.equal(body.messages[1].content[0].text,"Neutral storyboard");
  assert.equal(body.tools,undefined);
  assert.equal(body.messages[0].content,expected);
  assert.match(body.messages[1].content[1].image_url.url,/^data:image\/jpeg/);
  assert.match(body.messages[1].content[2].image_url.url,/^data:image\/png/);
  assert.equal(init?.redirect,"error");
  return Response.json({choices:[{finish_reason:"stop",message:{content:"Finished prompt"}}]});
 });
 assert.equal(text,"Finished prompt");
 assert.deepEqual([receipt!.brief, receipt!.systemSha256, receipt!.userMessage, receipt!.finalPromptSha256],
  ["Exact brief", writerHash(String(expected)), "Neutral storyboard", writerHash(text)]);
});

test("Writer rejects remote endpoints, text-only reference use and truncated rewrites", async () => {
 for(const baseUrl of ["https://example.com/v1","http://127.0.0.1:8731/admin","http://user@127.0.0.1:8731/v1"])
  assert.throws(()=>validateWorkspaceWriter({baseUrl,model}),/active local/);
 await assert.rejects(writeWorkspacePrompt({...writer,vision:false},app,{mode:"ref2va",prompt:"draft",media:{image1:{bytes:Buffer.alloc(8)}}}),/image support/);
 await assert.rejects(writeWorkspacePrompt(writer,app,{mode:"t2va",prompt:"draft",media:{}},async()=>Response.json({choices:[{finish_reason:"length",message:{content:"partial"}}]})),/complete prompt/);
});


test("Workspace resolves a renamed generator and rejects ambiguous manifests", () => {
  const { gen, ...other } = app.graph!;
  const graph = structuredClone(other);
  for (const node of Object.values(graph)) for (const [key, value] of Object.entries(node.inputs))
    if (Array.isArray(value) && value[0] === "gen") node.inputs[key] = ["model_writer", value[1]];
  const renamed = { ...app, workflowPath: undefined, graph: { ...graph, model_writer: gen } };
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

test("Workspace observation uses no reasoning budget only for a compatible writer", async () => {
  const { observeWithWorkspace, validateWorkspaceObserver, workspaceAsr } = await import("../server/workspace-observer.ts");
  const chat = { baseUrl: "http://127.0.0.1:8731/v1", model: "active-halogen" };
  const observer = validateWorkspaceObserver({ chat, reasoningNone: true, asrError: "NPU host unavailable" });
  const requests: Record<string, unknown>[] = [];
  const request = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
  }) as typeof fetch;
  const values = { prompt: "Review", system_prompt: "Return JSON", thinking: false, max_output_tokens: 4096 };
  await observeWithWorkspace({ ...observer.chat, reasoningNone: observer.reasoningNone }, values, undefined, request);
  await observeWithWorkspace(observer.chat, values, undefined, request);
  assert.equal(requests[0].reasoning_effort, "none");
  assert.equal(requests[1].reasoning_effort, undefined);
  assert.equal(requests[0].max_tokens, 4096);
  await assert.rejects(workspaceAsr(undefined, request, observer.asrError).transcribe({
    audio: "unused", offsetSeconds: 0, fps: 24, bindingId: "binding",
  }), /NPU host unavailable/);
});

test("Workspace retries truncated review once with identical system prompt and evidence", async () => {
  const { observeWithWorkspace } = await import("../server/workspace-observer.ts");
  const chat = { baseUrl: "http://127.0.0.1:8731/v1", model: "active-halogen", vision: true, reasoningNone: true };
  const values = { prompt: "Review frame-001", system_prompt: "Exact native prompt", thinking: false, max_output_tokens: 4096,
    frame1: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), type: "image/jpeg", name: "frame.jpg" } };
  const requests: Record<string, unknown>[] = [];
  let alwaysTruncated = false;
  const request = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const limited = alwaysTruncated || requests.length === 1;
    return Response.json({ choices: [{ message: { content: limited ? "{" : "{}" }, finish_reason: limited ? "length" : "stop" }] });
  }) as typeof fetch;
  const result = await observeWithWorkspace(chat, values, undefined, request, 8192);
  assert.deepEqual(result, { text: "{}", maxOutputTokens: 8192 });
  assert.deepEqual(requests.map(row => row.max_tokens), [4096, 8192]);
  assert.deepEqual(requests[1], { ...requests[0], max_tokens: 8192 });

  alwaysTruncated = true;
  requests.length = 0;
  await assert.rejects(observeWithWorkspace(chat, values, undefined, request), /4096-token/);
  assert.equal(requests.length, 1);
  requests.length = 0;
  await assert.rejects(observeWithWorkspace(chat, values, undefined, request, 8192), /8192-token/);
  assert.equal(requests.length, 2);
});


test("all H3 and LTX preset prompts and sampling match the applied standalone graphs", () => {
  for (const [id, modes] of [
    ["prompt-enhancer", ["ref2va","t2va","i2va","fl2va","l2va"]],
    ["ltx-prompt-generator", ["t2v","i2v","first_frame","last_frame","first_last"]],
  ] as const) {
    const enhancer = loadRegistry(repoRoot()).apps.find(row=>row.id===id)!;
    for (const mode of modes) {
      const graph = JSON.parse(readFileSync(enhancer.workflowPath!, "utf8"));
      applyInputs(enhancer, resolveValues(enhancer,{prompt:"Fixture",prompt_mode:mode}), {
        json:graph, setInput(node,field,value){graph[node].inputs[field]=value},
      }, file=>file);
      const gen = graph.gen.inputs;
      const native = resolveNativeWriter(enhancer,mode);
      assert.equal(native.system,graph[gen.system_prompt[0]].inputs.value);
      assert.equal(native.maxTokens,gen.max_length);
      assert.equal(native.thinking,gen.thinking);
      for (const key of sampling) assert.equal(native.sampling[key as keyof typeof native.sampling],gen["sampling_mode."+key]);
    }
  }
  const inline = loadRegistry(repoRoot()).apps.find(row=>row.id==="h3-studio-director-flash")!;
  assert.notEqual(workspaceSystemPrompt(app,"ref2va"),inline.graph!.enh_sys.inputs.value);
  const native = resolveNativeWriter(app,"t2va");
  const llama = workspaceWriterParameters({...writer,backend:"llama.cpp"},native);
  assert.equal(llama.requestParameters.repeat_penalty,1.05);
  assert.equal(llama.requestParameters.repetition_penalty,undefined);
  assert.deepEqual(llama.requestParameters.chat_template_kwargs,{enable_thinking:false});
  const unspecified = workspaceWriterParameters(validateWorkspaceWriter({baseUrl:writer.baseUrl,model}),native);
  assert.equal(unspecified.requestParameters.top_k,undefined);
  assert.match(unspecified.differences.join(" "),/top_k/);
});

test("the writer rejects changes to verbatim dialogue or impossible Picture numbers", async () => {
  const completion = (content: string): typeof fetch => async () => Response.json({ choices: [{ finish_reason:"stop", message:{content} }] });
  const input = { prompt:"Frame the scene.", mode:"t2va", media:{},
    audit:{segment:1,brief:"<d>Exactly this!</d>",references:[],save:()=>{}}, allowedPictures:0 };
  await assert.rejects(writeWorkspacePrompt(writer,app,input,completion("<d>[English] Almost this!</d>")),/changed explicitly/);
  await assert.rejects(writeWorkspacePrompt(writer,app,input,completion("<Picture 9> <d>[English] Exactly this!</d>")),/supplied segment/);
  assert.equal(await writeWorkspacePrompt(writer,app,input,completion("<d>[English] Exactly this!</d>")),"<d>[English] Exactly this!</d>");
});

test("native H3 owns dialogue formatting and reports altered words in the receipt", async () => {
  const dialogue = ['Momo: "Hello there."', 'Daichi: "Did it work?"'];
  const brief = "Momo opens the window.\nDialogue:\n" + dialogue.join("\n");
  const outputs = [
    "<d>[English] Hello there! Did it work?</d>",
    "<d>[English] Hello there! It worked.</d>",
  ];
  for (const [index, message] of outputs.entries()) {
    let receipt: WriterReceipt | undefined;
    const final = await writeWorkspacePrompt(writer,app,{prompt:brief,mode:"t2va",media:{},h3Dialogue:dialogue,
      audit:{segment:1,brief,references:[],save:value=>{receipt=value;}}},async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(request.messages, [
        {role:"system",content:workspaceSystemPrompt(app,"t2va")}, {role:"user",content:brief},
      ]);
      return Response.json({choices:[{finish_reason:"stop",message:{content:message}}]});
    });
    assert.equal(final,message);
    assert.ok(receipt);
    assert.equal(receipt.differences.some(note=>note.includes("native writer's dialogue differs")),index===1);
  }
  assert.equal(plainDirectorDraft('Momo says <d>[English] Hello there.</d>'),'Momo says "Hello there."');
});
