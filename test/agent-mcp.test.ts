import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer, type Server } from "node:http";
import {once} from "node:events";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {build} from "../mcp/server.ts";
import {StudioMcp,resultData} from "../server/agent-mcp.ts";

/** A stub studio API, so the real MCP server can be exercised without ComfyUI or a GPU. */
function studio(received: any[] = []) {
  const app = { id: "z-image", name: "Z Image", section: "image", status: "ready", pack: "image", inputs: [{ id: "prompt", type: "textarea", label: "Prompt" }], outputs: [{ node: "9", type: "image" }], models: [] };
  const server = createServer(async (req, res) => {
    const request = new Request(new URL(req.url!, "http://local"), { method: req.method, headers: req.headers as any, body: (["POST","PUT"].includes(req.method!) ? req : undefined) as any, duplex: "half" } as any);
    const url = new URL(request.url);
    const send = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/apps") return send({ apps: [app] });
    if (url.pathname === "/api/apps/z-image/run") {
      const form = await request.formData();
      received.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : (v as File).name])));
      return send({ id: "job-1", app: "z-image", status: "succeeded" });
    }
    if (url.pathname === "/api/history/job-1") return send({ id: "job-1", app: "z-image", status: "succeeded", outputs: [{ file: "out-01.png", type: "image" }], inputs: [] });
    if (url.pathname === "/api/media") { received.push({ media: await request.json() as any }); return send({ id: "m1", outputs: [] }); }
    res.writeHead(404); res.end("{}");
  });
  return { server, received };
}

async function serve(base: string) {
  const http = createServer(async (req, res) => {
    const mcp = build(base);   // one server per request, exactly like mcp/server.ts
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return { http, url: `http://127.0.0.1:${(http.address() as any).port}/mcp` };
}

test("the agent talks to the real MCP server: discovery, guidance, idempotent run and media", async () => {
  const { server: api, received } = studio();
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const base = `http://127.0.0.1:${(api.address() as any).port}`;
  const { http, url } = await serve(base);
  const client = new StudioMcp(url);
  try {
    const tools = await client.tools();
    const names = tools.map((t) => t.name);
    for (const expected of ["list_apps", "get_app", "run_app", "job", "wait_job", "cancel_job", "history", "gpu", "examples", "media","plan_segments"])
      assert.ok(names.includes(expected), `MCP must expose ${expected}`);
    assert.ok(!names.includes("autoshorts"), "AutoShorts must no longer be an MCP tool");

    const listed = resultData(await client.call("list_apps", {}));
    assert.equal(listed.apps[0].id, "z-image");

    const described = resultData(await client.call("get_app", { app: "z-image" }));
    assert.ok(described.prompting?.rules?.length, "get_app must return workflow prompting guidance");
    assert.ok(described.inputs[0].id === "prompt");

    const plan=resultData(await client.call("plan_segments",{seconds:5,prompts:["Arrival","Exit"]}));assert.equal(plan.frames,209);assert.equal(received.length,0,"pure planning never submits a job");
    const invalid=await client.call("run_app",{app:"z-image",values:{prompt:"x",invented_model:"turbo"}});assert.equal(invalid.isError,true);assert.match(JSON.stringify(invalid),/Unknown input invented_model/);assert.equal(received.length,0,"invented parameters cannot be silently ignored");

    await client.call("run_app", { app: "z-image", values: { prompt: "a grandmother" }, request_id: "conv:tool" });
    assert.equal(received.at(-1).request_id, "conv:tool", "run_app must forward the idempotency key");

    const job = resultData(await client.call("job", { id: "job-1" }));
    assert.equal(job.status, "succeeded");
    assert.ok(String(job.outputs[0].path).endsWith("out-01.png"), "job returns real absolute artifact paths");

    await client.call("media", { operation: "probe", path: "/etc/hostname" });
    assert.equal(received.at(-1).media.operation, "probe", "media is exposed through the same MCP server");
  } finally {
    await client.close(); http.closeAllConnections?.(); api.closeAllConnections?.(); await new Promise<void>(r => http.close(() => r())); await new Promise<void>(r => api.close(() => r()));
  }
});

test("the agent refuses a non-loopback MCP endpoint", () => {
  assert.throws(() => new StudioMcp("https://example.com/mcp"), /local studio MCP/);
});
