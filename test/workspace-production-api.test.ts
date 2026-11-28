import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { StudioMcp, resultData } from "../server/agent-mcp.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGKILL");
  await done;
}

test("Workspace prepares, reviews and reconciles a production through HTTP and MCP", { timeout: 30_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-workspace-api-"));
  const rewritten = "A steady camera tracks a paper boat across the pond.";
  let writes = 0;
  const writerRequests: any[] = [];
  let failWriterAt = 0;
  let backendSubmissions = 0;
  let parkRequests = 0;
  const backend = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.once("end", () => {
        writes++;
        writerRequests.push(JSON.parse(body));
        if (writes === failWriterAt) {
          res.statusCode = 503;
          return res.end("{}");
        }
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "```text\n" + rewritten + "\n```" } }] }));
      });
    } else if (req.url === "/riverfield/workspace-comfy") {
      if (req.method === "POST") parkRequests++;
      res.end(JSON.stringify({ managed: true, state: "parked" }));
    } else if (req.url === "/riverfield/prepare") {
      // Leave the saved History job pending. No workflow reaches ComfyUI.
      backendSubmissions++;
      req.resume();
    } else res.end("{}");
  });
  const backendPort = await listen(backend);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const writer = { baseUrl: backendUrl + "/v1", model: "workspace-fixture" };
  const productionId = "workspace-fixture";
  const runId = "take-01";
  const route = `/api/productions/${productionId}/runs/${runId}`;
  let child: ChildProcess | undefined;
  let client: StudioMcp | undefined;
  let log = "";

  async function json(path: string, data?: unknown) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(2_000),
      ...(data === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  }

  async function park(headers: Record<string, string>) {
    return fetch(base + "/api/gpu/workspace", { method: "POST", headers, signal: AbortSignal.timeout(2_000) });
  }

  async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
    for (let attempt = 0; attempt < 150; attempt++) {
      const value = await read();
      if (value !== undefined) return value;
      await sleep(30);
    }
    throw new Error("Expected API state was not reached. " + log);
  }

  async function start() {
    log = "";
    child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/server.ts"], {
      env: { ...process.env, PORT: String(port), RIVERFIELD_HOST: "127.0.0.1", RIVERFIELD_OUT: out, COMFY_BASE_URL: backendUrl,
        RIVERFIELD_PASSCODE: "", RIVERFIELD_MAX_ACTIVE: "0", RIVERFIELD_MAX_RUNS_PER_DAY: "0", RIVERFIELD_PRODUCTION_JOB_TIMEOUT_MS: "1800" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { log += chunk; });
    child.stderr!.on("data", chunk => { log += chunk; });
    await until(async () => log.includes("riverfield on") ? true : undefined);
    client = new StudioMcp(base + "/mcp");
  }

  async function restart() {
    await client!.close();
    await stop(child!);
    await start();
  }

  const scope = { productionId, runId };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await client!.call(name, args);
    return { isError: result.isError === true, data: resultData(result) };
  };
  const read = async (request_id: string) => {
    const result = await tool("get_production_run", { ...scope, request_id });
    assert.equal(result.isError, false, JSON.stringify(result.data));
    return result.data;
  };
  const control = (request_id: string, action = "start", extra = {}) =>
    tool("control_production_run", { ...scope, action, background: true, request_id, ...extra });

  try {
    await start();
    assert.deepEqual((await json("/api/gpu/workspace")).body, { managed: true, state: "parked" });
    assert.equal((await park({})).status, 403);
    assert.equal((await park({ "x-riverfield-workspace": "1", origin: base })).status, 403);
    assert.equal(parkRequests, 0);
    assert.equal((await park({ "x-riverfield-workspace": "1" })).status, 200);
    assert.equal(parkRequests, 1);
    const app = "h3-studio-director-flash";
    const standalone = await tool("prepare_app_run", { app, writer, values: { prompt_enhancer: false, global_prompt: "A paper boat floats.", steps: 8 } });
    assert.equal(standalone.isError, false, JSON.stringify(standalone.data));
    assert.equal(standalone.data.values.global_prompt, rewritten);
    assert.equal(standalone.data.values.prompt_enhancer, false);
    assert.equal(backendSubmissions, 0);

    assert.equal((await json("/api/productions", { id: productionId, title: "Workspace fixture", logline: "Fixture" })).status, 201);
    const production = `/api/productions/${productionId}`;
    const seasonId = "fixture-s01";
    const episodeId = "fixture-e01";
    const sceneId = "fixture-sc01";
    assert.equal((await json(production + "/seasons", { id: seasonId, number: 1, title: "Season" })).status, 201);
    assert.equal((await json(production + "/episodes", { id: episodeId, seasonId, number: 1, title: "Episode" })).status, 201);
    assert.equal((await json(production + "/scenes", { id: sceneId, episodeId, number: 1, title: "Scene" })).status, 201);
    const plan = (await json(production + "/runs/plan", { brief: "A paper boat floats.", profile: "build", sceneCount: 1, selectedApp: app, sceneIds: [sceneId] })).body.plan;
    plan.scenes[0].renderConfig.steps = 8;
    assert.equal((await json(production + "/runs", { runId, plan })).status, 201);
    const missing = await control("no-preparation");
    assert.equal(missing.isError, true);
    assert.match(missing.data.error, /needs prompt preparation/);
    assert.equal((await read("no-preparation")).workspaceDispatch, undefined);

    const old = (await tool("prepare_production_render", { ...scope, writer })).data;
    assert.equal(old.applied, true, JSON.stringify(old));
    assert.equal(old.prompts.segment_windows.windows[0].prompt, rewritten);
    assert.equal(old.model, writer.model);
    assert.equal((await tool("prepare_production_render", { ...scope, writer })).data.preparationId, old.preparationId);
    assert.equal(writes,2);
    assert.equal((await json(route + "/pause", {})).status, 200);
    const stale = await control("stale", "resume", { preparation_id: old.preparationId });
    assert.equal(stale.isError, true);
    assert.match(stale.data.error, /older scene revision/);

    const prepared = (await tool("prepare_production_render", { ...scope, writer })).data;
    assert.equal(prepared.applied, true, JSON.stringify(prepared));
    assert.notEqual(prepared.revision, old.revision);
    assert.equal(writes, 3);
    await restart();
    assert.deepEqual((await json(route + "?preparationId=" + prepared.preparationId)).body, prepared);

    const first = await control("render-1", "resume", { preparation_id: prepared.preparationId });
    assert.equal(first.isError, false, JSON.stringify(first.data));
    assert.deepEqual(first.data.workspaceDispatch, { requestKey: "render-1", active: true, status: "running" });
    const running = await until(async () => {
      const run = await read("render-1");
      return backendSubmissions === 1 && run.jobs.some((job: any) => job.kind === "render" && job.jobId) ? run : undefined;
    });
    const jobId = running.jobs.find((job: any) => job.kind === "render").jobId;
    assert.equal((await control("render-1")).data.workspaceDispatch.active, true);
    assert.equal((await control("other", "resume")).data.status, 409);
    assert.equal((await park({ "x-riverfield-workspace": "1" })).status, 409);
    assert.equal(parkRequests, 1);
    const timedOut = await until(async () => {
      const run = await read("render-1");
      return run.workspaceDispatch?.active === false ? run : undefined;
    });
    assert.equal(timedOut.workspaceDispatch.status, "timeout", JSON.stringify(timedOut.workspaceDispatch));
    assert.equal(timedOut.status, "paused");
    assert.equal(timedOut.jobs.find((job: any) => job.kind === "render").jobId, jobId);
    assert.equal(backendSubmissions, 1);

    assert.equal((await control("render-2", "resume")).data.workspaceDispatch.active, true);
    await restart();
    assert.equal((await read("render-2")).workspaceDispatch.status, "interrupted");
    const replay = await control("render-1");
    assert.deepEqual(replay.data.workspaceDispatch, timedOut.workspaceDispatch);
    assert.equal((await control("render-3", "resume")).data.workspaceDispatch.active, true);
    const lost = await until(async () => {
      const run = await read("render-3");
      return run.workspaceDispatch?.active === false ? run : undefined;
    });
    assert.equal(lost.workspaceDispatch.status, "lost", JSON.stringify(lost.workspaceDispatch));
    assert.equal(lost.status, "paused");
    assert.equal(lost.jobs.find((job: any) => job.kind === "render").jobId, jobId);
    assert.equal(backendSubmissions, 1);
    assert.equal(writes, 3);
    const firstReceipt = JSON.parse(readFileSync(join(out, "workspace-preparations", prepared.preparationId + ".json"), "utf8"));
    assert.equal(firstReceipt.segments[0].finalPrompt, rewritten);
    const productionAudit = JSON.parse(readFileSync(join(out, "workspace-render-audit", jobId + ".json"), "utf8"));
    assert.equal(productionAudit.preparationId, prepared.preparationId);
    assert.equal(productionAudit.prompts[0].finalPromptSha256, firstReceipt.segments[0].finalPromptSha256);

    const imageIds = Array.from({length: 11}, (_, index) => "fixture-image-" + index);
    mkdirSync(join(out, "media"), { recursive: true });
    for (const [index, id] of imageIds.entries()) {
      const path = join(out, "media", id + ".png");
      writeFileSync(path, Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"), Buffer.from([index])]));
      assert.equal((await json(production + "/assets", {id,kind:"image",label:id,path})).status, 201);
    }
    const requested = {productionId,segments:[
      {frames:175,brief:"First setup.",imageAssetIds:imageIds.slice(0,8)},
      {frames:192,brief:"Second shot.",imageAssetIds:[imageIds[8],imageIds[0]]},
      {frames:209,brief:"Third shot.",imageAssetIds:[imageIds[9],imageIds[10]]},
      {frames:226,brief:"A clean text-only ending.",imageAssetIds:[]},
    ]};
    const planned = await tool("plan_director_batches",requested);
    assert.equal(planned.isError,false,JSON.stringify(planned.data));
    assert.deepEqual(planned.data.batches.map((batch: any) => [batch.frames,batch.refs,batch.mode]),[[367,9,"ref2va"],[209,2,"ref2va"],[226,0,"fl2va"]]);
    assert.equal(planned.data.frames,802);
    const batch = { app, director_batch:{planId:planned.data.planId,index:1}, values:{render_profile:"build",steps:8} };
    const invalid = await tool("run_app",{...batch,workspace_managed:true});
    assert.match(invalid.data.error,/requires native prompt preparation/);
    const unavailable = await tool("prepare_app_run",batch);
    assert.match(unavailable.data.error,/active BlackRiver local model/);
    failWriterAt = 5;
    const partial = await tool("prepare_app_run",{...batch,writer:{...writer,vision:true}});
    assert.equal(partial.isError,true);
    assert.equal(writes,5);
    await restart();
    const receipts = await Promise.all([tool("prepare_app_run",{...batch,writer:{...writer,vision:true}}),tool("prepare_app_run",{...batch,writer:{...writer,vision:true}})]);
    const receipt = receipts[0].data;
    assert.equal(receipts[0].isError,false,JSON.stringify(receipt));
    assert.equal(receipt.preparationId,receipts[1].data.preparationId);
    assert.equal(writes,6,"only the unfinished segment is retried after an interruption");
    const requests = [writerRequests[3], writerRequests[5]];
    assert.equal(requests[0].messages[1].content.length,9);
    assert.equal(requests[1].messages[1].content.length,3);
    assert.deepEqual(requests[1].messages.slice(0,2).map((row: any)=>row.role),["system","user"]);
    assert.match(requests[1].messages[1].content[0].text,/<Picture 1> = fixture-image-8; <Picture 2> = fixture-image-0/);
    const audit = JSON.parse(readFileSync(join(out,"workspace-app-preparations",receipt.preparationId + ".json"),"utf8"));
    assert.deepEqual(audit.segments[1].references.map((ref: any)=>ref.assetId),[imageIds[8],imageIds[0]]);
    await restart();
    const saved = await tool("prepare_app_run",batch);
    assert.equal(saved.data.preparationId,receipt.preparationId);
    assert.equal(writes,6,"restart reuses the saved receipt without a writer");
    const tampered = await tool("run_app",{...batch,values:{...batch.values,steps:6},workspace_managed:true,workspace_preparation_id:receipt.preparationId});
    assert.match(tampered.data.error,/different render inputs/);
    const direct = await tool("run_app",{...batch,workspace_managed:true,workspace_preparation_id:receipt.preparationId});
    assert.equal(direct.isError,false,JSON.stringify(direct.data));
    assert.equal(direct.data.render.workspacePreparation.preparationId,receipt.preparationId);
    assert.equal(direct.data.values.prompt_enhancer,false);
    assert.equal(JSON.parse(direct.data.values.segment_windows).windows[1].prompt,rewritten);
    assert.equal((await tool("run_app",{...batch,workspace_managed:true,workspace_preparation_id:receipt.preparationId})).data.id,direct.data.id);
    assert.equal(writes,6);
  } finally {
    await client?.close();
    if (child) await stop(child);
    backend.closeAllConnections();
    await new Promise<void>(resolve => backend.close(() => resolve()));
    rmSync(out, { recursive: true, force: true });
  }
});
