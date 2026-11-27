import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer, type Server } from "node:http";
import {once} from "node:events";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {build} from "../mcp/server.ts";
import {StudioMcp,resultData} from "../server/agent-mcp.ts";

/** A stub studio API, so the real MCP server can be exercised without ComfyUI or a GPU. */
function studio(received: any[] = []) {
  const app = { id: "z-image", name: "Z Image", section: "image", status: "ready", pack: "image",
    inputs: [
      { id: "prompt", type: "textarea", label: "Prompt" },
      { id: "render_profile", type: "select", label: "Render profile", options: [{ value: "build", label: "Build & Test" }, { value: "production", label: "Production" }] },
      { id: "production_megapixels", type: "slider", label: "Production resolution", min: 0.1, max: 3, step: 0.1, default: 0.4 },
      { id: "production_upscale", type: "select", label: "Production upscale", options: [{ value: "", label: "Off" }, { value: "x2", label: "X2" }, { value: "x4", label: "X4" }], default: "" },
      { id: "production_upscale_detail", type: "slider", label: "Production detail", min: 0, max: 1, step: 0.05, default: 1 },
    ],
    renderProfile: { supported: true, build_megapixels: 0.1, production_default_megapixels: 0.4, generation: { min: 0.1, max: 3, step: 0.1 }, upscale: null, detail: null },
    outputs: [{ node: "9", type: "image" }], models: [] };
  const catalog = [app, ...Array.from({ length: 24 }, (_, i) => ({
    id: `flash-director-${i}`, name: `Flash Director ${i}`, section: "video", status: "ready", pack: "h3",
  }))];
  const snapshot = {
    schemaVersion: 1, production: { id: "fixture", title: "Fixture", status: "active" }, revision: 2,
    seasons: [{ id: "s1", productionId: "fixture", number: 1, title: "Season" }],
    episodes: [{ id: "e1", seasonId: "s1", number: 1, title: "Episode" }],
    scenes: [{ id: "scene", episodeId: "e1", number: 1, title: "Scene" }],
    assets: {
      actor: { id: "actor", label: "Actor reference", kind: "image", category: "characters", path: "/fixture/actor.png" },
      set: { id: "set", label: "Environment", kind: "image", category: "environments", path: "/fixture/set.png" },
    },
    observations: { heavy: { report: "long observation evidence ".repeat(65_000) } },
    continuityReviews: {},
  };
  const server = createServer(async (req, res) => {
    const request = new Request(new URL(req.url!, "http://local"), { method: req.method, headers: req.headers as any, body: (["POST","PUT"].includes(req.method!) ? req : undefined) as any, duplex: "half" } as any);
    const url = new URL(request.url);
    const send = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/apps") return send({ apps: catalog });
    if (url.pathname === "/api/productions/fixture") return send(snapshot);
    if (url.pathname === "/api/apps/z-image/run") {
      const form = await request.formData();
      received.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : (v as File).name])));
      return send({ id: "job-1", app: "z-image", status: "succeeded" });
    }
    if (url.pathname === "/api/history/job-1/production") { received.push({ production: await request.json() as any }); return send({ id: "job-2", app: "z-image", status: "starting", preview: "job-1", render: { profile: "production" }, lineage: { preview: "job-1" } }); }
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
    for (const expected of ["list_apps", "get_app", "run_app", "job", "wait_job", "cancel_job", "history", "gpu", "examples", "media","plan_segments","render_production"])
      assert.ok(names.includes(expected), `MCP must expose ${expected}`);
    assert.ok(!names.includes("autoshorts"), "AutoShorts must no longer be an MCP tool");

    const listed = resultData(await client.call("list_apps", {}));
    assert.equal(listed.apps[0].id, "z-image");
    assert.equal(listed.count, 25);
    assert.equal(listed.apps.length, 16);
    assert.equal(listed.nextOffset, 16);
    const page = resultData(await client.call("list_apps", { section: "video", query: "director flash", limit: 3, offset: 2 }));
    assert.deepEqual(page.apps.map((a: { id: string }) => a.id), ["flash-director-2", "flash-director-3", "flash-director-4"]);
    assert.equal(page.nextOffset, 5);

    const metadata = await client.call("get_production", { productionId: "fixture" });
    const summary = resultData(metadata);
    assert.equal(summary.production.id, "fixture");
    assert.equal(summary.counts.observations, 1);
    assert.ok(JSON.stringify(metadata).length < 1024);
    assert.equal(summary.observations, undefined);
    const scope = resultData(await client.call("production_scope", { productionId: "fixture", episodeId: "e1", assetCategory: "characters" }));
    assert.equal(scope.scenes[0].id, "scene");
    assert.deepEqual(scope.assets.map((a: { path: string }) => a.path), ["/fixture/actor.png"]);
    assert.equal(scope.assetCount, 1);
    const full = resultData(await client.call("get_production", { productionId: "fixture", includeSnapshot: true }));
    assert.ok(full.observations.heavy.report.length > 1_000_000);

    const described = resultData(await client.call("get_app", { app: "z-image" }));
    assert.ok(described.prompting?.rules?.length, "get_app must return workflow prompting guidance");
    assert.ok(described.inputs[0].id === "prompt");
    assert.equal(described.renderProfile?.supported, true, "get_app exposes the render-profile contract");
    const named=resultData(await client.call("get_app",{app:"Z Image"}));assert.equal(named.id,"z-image");

    const plan=resultData(await client.call("plan_segments",{prompts:["Arrival","Exit"]}));assert.equal(plan.frames,311);assert.equal(plan.segmentFrames,175);assert.equal(plan.overlapFrames,39);assert.equal(received.length,0,"pure planning never submits a job");
    const invalid=await client.call("run_app",{app:"z-image",values:{prompt:"x",invented_model:"turbo"}});assert.equal(invalid.isError,true);assert.match(JSON.stringify(invalid),/Unknown input invented_model/);assert.equal(received.length,0,"invented parameters cannot be silently ignored");

    await client.call("run_app", { app: "z-image", values: { prompt: "a grandmother" }, request_id: "conv:tool" });
    assert.equal(received.at(-1).request_id, "conv:tool", "run_app must forward the idempotency key");
    const namedRun=await client.call("run_app",{app:"Z Image",values:{prompt:"named app"}});assert.ok(!namedRun.isError);assert.equal(received.at(-1).prompt,"named app");
    const profiled=await client.call("run_app",{app:"z-image",values:{prompt:"preview",render_profile:"build"}});assert.ok(!profiled.isError);assert.equal(received.at(-1).render_profile,"build","run_app forwards an explicit render profile");
    const productionRun=await client.call("run_app",{app:"z-image",values:{prompt:"production",render_profile:"production",production_megapixels:0.8,production_upscale:"x2",production_upscale_detail:0.4}});
    assert.ok(!productionRun.isError,JSON.stringify(productionRun));
    assert.equal(received.at(-1).render_profile,"production");assert.equal(received.at(-1).production_megapixels,"0.8");assert.equal(received.at(-1).production_upscale,"x2");assert.equal(received.at(-1).production_upscale_detail,"0.4","MCP forwards the same production controls the Director UI writes");
    const promoted=await client.call("render_production",{id:"job-1",production_megapixels:0.8,production_upscale:"x2",production_upscale_detail:0.5});
    assert.ok(!promoted.isError,JSON.stringify(promoted));assert.equal(resultData(promoted).id,"job-2");
    assert.deepEqual(received.at(-1).production,{production_megapixels:0.8,production_upscale:"x2",production_upscale_detail:0.5},"render_production forwards only explicit rendering choices");

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
