#!/usr/bin/env node
// RiverField MCP server: lets an agent drive the studio the way the web UI does.
//
//   node --experimental-strip-types mcp/server.ts            # HTTP, http://127.0.0.1:3010/mcp
//   node --experimental-strip-types mcp/server.ts --stdio    # stdio, for clients that spawn it
//
// It is a thin client of RiverField's own API (server/server.ts), so it needs the web app running:
// every tool is one HTTP call, no ComfyUI knowledge here. start.sh launches this next to the app.
//
// Tools: list_apps, get_app, run_app, job, wait_job, cancel_job, history, gpu, examples.
// Files: pass absolute paths of this machine in `files` (the MCP runs beside the app).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { promptGuidance } from "./prompt-guidance.ts";
import {planDirectorSegments,directorRequest,directorValues,directorDurations,DIRECTOR_DEFAULTS,DIRECTOR_MANAGED_INPUTS,DIRECTOR_DELIVERY} from "../server/h3-plan.ts";
import {resolveApp} from "../server/app-reference.ts";
import {InputError,inputErrorBody} from "../server/input-error.ts";
import {normalizeRunInputs} from "../server/run-inputs.ts";

const BASE = (process.env.RIVERFIELD_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PORT = Number(process.env.RIVERFIELD_MCP_PORT || 3010);
const HOST = process.env.RIVERFIELD_MCP_HOST || "127.0.0.1";
const ROOT = resolve(import.meta.dirname, "..");
const OUT = process.env.RIVERFIELD_OUT || join(ROOT, "out");
const DONE = new Set(["succeeded", "failed", "canceled", "expired", "lost"]);

type Any = Record<string, any>;
class StudioHttpError extends Error{status:number;body:any;constructor(status:number,body:any,message:string){super(message);this.status=status;this.body=body;}}

async function api(path: string, init?: RequestInit, base=BASE): Promise<any> {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const why = body && typeof body === "object" && (body.error || body.message);
    throw new StudioHttpError(res.status,body,`${res.status} ${why || String(text).slice(0, 300)}`);
  }
  return body;
}

async function apps(base=BASE): Promise<Any[]> {
  const d = await api("/api/apps",undefined,base);
  return (d?.apps ?? []) as Any[];
}

async function manifest(id: string,base=BASE): Promise<Any> {
  const app=resolveApp(await apps(base) as Array<Any&{id:string;name:string}>,id);
  // Request recipes are distinct from historical gallery previews, which predate current validation.
  if(app.requestExample){const recipe=app.requestExample;return {...app,example:{values:directorValues(recipe.values),inputs:Object.entries(recipe.files||{}).map(([id,full])=>({id,full})),note:"Validated native-default request example; not a claim of generated output"}};}
  return app;
}

/** The same multipart the web UI posts: one field per input, files by path. */
async function form(id: string, values: Any, files: Any, preset?: string,base=BASE): Promise<FormData> {
  const app = await manifest(id,base);
  const inputs=new Map<string,Any>(app.inputs.map((input:Any)=>[input.id,input]));
   for(const key of [...Object.keys(values),...Object.keys(files)])if(!inputs.has(key))throw new InputError(`Unknown input ${key} for ${id}; read get_app instead of guessing parameter names`);
  for(const key of Object.keys(files))if(!["image","video","audio"].includes(inputs.get(key)?.type))throw new InputError(`${key} is not a file input`);
  for(const key of Object.keys(values))if(["image","video","audio"].includes(inputs.get(key)?.type))throw new InputError(`Pass ${key} in files, not values`);
  const fd = new FormData();
  for (const inp of app.inputs as Any[]) {
    const path = files[inp.id];
    if (path) {
      const abs = resolve(String(path));
      if (!existsSync(abs)) throw new InputError(`files.${inp.id}: no file at ${abs}`,[{code:"MISSING_FILE",field:`files.${inp.id}`,message:`No file at ${abs}`}]);
      fd.append(inp.id, new Blob([readFileSync(abs)]), basename(abs));
      continue;
    }
    const v = values[inp.id];
    if (v === undefined || v === null) continue;
    if (inp.type === "toggle") fd.append(inp.id, v ? "true" : "false");
    else if (inp.multiple) fd.append(inp.id, JSON.stringify(Array.isArray(v) ? v : []));
    else fd.append(inp.id, String(v));
  }
  if (preset) fd.append("preset", preset);
  return fd;
}

/** A history entry with absolute paths, so an agent can open the files directly. */
function local(entry: Any): Any {
  if (!entry) return entry;
  const dir = join(OUT, "history", String(entry.id));
  return {
    ...entry,
    inputs: (entry.inputs ?? []).map((i: Any) => ({ ...i, path: join(dir, i.file) })),
    outputs: (entry.outputs ?? []).map((o: Any) => ({ ...o, path: join(dir, o.file) })),
  };
}

const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (e: unknown) => {
 const data=e instanceof InputError?inputErrorBody(e):e instanceof StudioHttpError?{...((e.body&&typeof e.body==="object")?e.body:{}),error:e.body?.error||e.message,status:e.status,code:e.body?.code||"HTTP_ERROR",retryable:e.status>=500}:undefined;
 return {content:[{type:"text" as const,text:data?JSON.stringify(data):`Error: ${e instanceof Error?e.message:String(e)}`}],...(data?{structuredContent:data}:{}),isError:true};
};

export function build(base=BASE): McpServer {
  const call=(path:string,init?:RequestInit)=>api(path,init,base);
  const server = new McpServer({ name: "riverfield", version: "1.0.0" });

  server.registerTool("plan_segments",{title:"Use native Director segments",description:"Stable Pika geometry/material assignment, no GPU. Segment length and interleaving are fixed native defaults: 175 frames at 24 fps, 39-frame overlap. Do NOT calculate durations or change these values. total_seconds is an approximate STORY target: omit prompts initially to get the required count/windows, then write exactly that many prompts. ready=false returns no runnable segment_windows; adapt the script, not the technical settings. Complete prompts pass through unchanged; this tool does not write/validate Pika prose. images/audios are zero-based slots; segment_images/segment_audios specify ordered inputs for each segment. Use get_app/examples for the Ref2VA/FL2VA text and copy the returned segment_windows unchanged.",inputSchema:directorRequest.shape,annotations:{readOnlyHint:true}},async args=>{try{return text(planDirectorSegments(args));}catch(e){return fail(e);}});

  server.registerTool("list_apps", {
    title: "List RiverField apps",
    description: "Every app of the studio with its section, status and pack. Filter by section (image, video, audio, 3d, utility).",
    inputSchema: {
      section: z.enum(["image", "video", "audio", "3d", "utility"]).optional().describe("only this studio"),
      status: z.enum(["ready", "draft"]).optional().describe("only this status"),
    },
  }, async ({ section, status }) => {
    try {
      const all = await apps(base);
      const list = all
        .filter((a) => (!section || a.section === section) && (!status || a.status === status))
        .map((a) => ({ id: a.id, name: a.name, section: a.section, status: a.status, summary: a.summary, pack: a.pack }));
      return text({ count: list.length, apps: list });
    } catch (e) { return fail(e); }
  });

  server.registerTool("get_app", {
    title: "Describe an app",
    description: "The full manifest of one app: every input with its type, defaults and options, the outputs, the models and the notes. Read this before run_app.",
    inputSchema: { app: z.string().describe("app id, e.g. create-image") },
  }, async ({ app }) => {
    try {
      const a = await manifest(app,base);
      return text({
        id: a.id, name: a.name, section: a.section, status: a.status, summary: a.summary, pack: a.pack, 
        inputs: a.inputs.map((i: Any) => ({
          id: i.id, type: i.type, label: i.label, required: Boolean(i.required),
          default: i.default, min: i.min, max: i.max, step: i.step,
          options: (i.options ?? []).map((o: Any) => o.value), multiple: i.multiple ?? null, help: i.help ?? null,
          // type image/video/audio: pass an absolute path in run_app.files, not in values
          file: ["image", "video", "audio"].includes(i.type),
          // managed by a custom panel in the web UI; still settable from here (e.g. segment_windows)
          panel: Boolean(i.hidden),
          ...(a.id==="pika-studio-director"&&(DIRECTOR_MANAGED_INPUTS as readonly string[]).includes(i.id)?{agentManaged:true}:{}),
        })),
        presets: (a.presets ?? []).map((p: Any) => ({ id: p.id, label: p.label })),
        outputs: a.outputs, models: (a.models ?? []).map((m: Any) => m.name),
        notes: a.notes ?? a.source?.notes ?? null, source: a.source ?? null,
        prompting: promptGuidance(a as any),
        ...(a.id==="pika-studio-director"?{agentDefaults:DIRECTOR_DEFAULTS,actualDurations:directorDurations(),delivery:DIRECTOR_DELIVERY,effectiveTechnicalDefaults:Object.fromEntries(a.inputs.filter((i:Any)=>(DIRECTOR_MANAGED_INPUTS as readonly string[]).includes(i.id)).map((i:Any)=>[i.id,i.default])),agentWritableInputs:a.inputs.filter((i:Any)=>!(DIRECTOR_MANAGED_INPUTS as readonly string[]).includes(i.id)&&!["advanced_timeline_json","segment_prompts"].includes(i.id)).map((i:Any)=>i.id)}:{}),
        example: a.example ? { values: a.example.values, inputs: a.example.inputs } : null,
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("run_app", {
    title: "Run an app",
    description: "Start a generation. Returns the history entry (id) at once; use wait_job to get the files. `values` are the app's inputs (numbers, strings, booleans, arrays for multi-selects, JSON strings such as studio-director's segment_windows); `files` maps a file input id (image/video/audio) to an absolute path on this machine.",
    inputSchema: {
      app: z.string().describe("app id"),
      values: z.record(z.string(), z.any()).optional().describe("input values, by input id"),
      files: z.record(z.string(), z.string()).optional().describe("file inputs, by input id: absolute path"),
      preset: z.string().optional().describe("preset id, when the app has presets"),
      request_id: z.string().max(200).optional().describe("optional durable idempotency key; retrying this key returns the original job, never a second generation"),
    },
  }, async ({ app, values, files, preset,request_id }) => {
    try {
      const canonical=await manifest(app,base);
      if(canonical.id==="pika-studio-director"&&values?.advanced_timeline_json)throw new InputError("Automated Pika uses native Director segments; raw advanced_timeline_json is reserved for manual editing");
      const normalized=normalizeRunInputs(canonical as any,values??{},files??{});
      const fd = await form(canonical.id, canonical.id==="pika-studio-director"?directorValues(normalized.values,normalized.files):normalized.values, normalized.files, preset,base);
      if(request_id)fd.append("request_id",request_id);
      const entry = await call(`/api/apps/${encodeURIComponent(canonical.id)}/run`, { method: "POST", body: fd });
      return text({ id: entry.id, app: entry.app, status: entry.status, created: entry.created });
    } catch (e) { return fail(e); }
  });

  server.registerTool("job", {
    title: "Job status",
    description: "One run: status, progress, queue position, and the outputs already written (with absolute paths).",
    inputSchema: { id: z.string().describe("history entry id returned by run_app") },
  }, async ({ id }) => {
    try {
      const e = await call(`/api/history/${encodeURIComponent(id)}`);
      const v = local(e);
      return text({ id: v.id, app: v.app, status: v.status, error: v.error ?? null,
        progress: v.progress ?? null, queue: v.queue ?? null,
        outputs: v.outputs.map((o: Any) => ({ type: o.type, path: o.path, url: o.url, file: o.file })) });
    } catch (e) { return fail(e); }
  });

  server.registerTool("wait_job", {
    title: "Wait for a job",
    description: "Poll a run until it finishes (or the timeout, 10 minutes by default) and return its outputs with absolute paths.",
    inputSchema: {
      id: z.string().describe("history entry id"),
      timeout_s: z.number().int().min(5).max(3600).optional().describe("give up after this many seconds (default 600)"),
      poll_s: z.number().min(1).max(30).optional().describe("seconds between checks (default 3)"),
    },
  }, async ({ id, timeout_s, poll_s },extra) => {
    const deadline = Date.now() + (timeout_s ?? 600) * 1000;
    const every = (poll_s ?? 3) * 1000;
    try {
      for (;;) {
        extra.signal.throwIfAborted();
        const e = await call(`/api/history/${encodeURIComponent(id)}`,{signal:extra.signal});
        if (DONE.has(e.status)) {
          const v = local(e);
          return text({ id: v.id, app: v.app, status: v.status, error: v.error ?? null,
            seconds: v.seconds ?? null,
            outputs: v.outputs.map((o: Any) => ({ type: o.type, path: o.path, file: o.file })) });
        }
        if (Date.now() > deadline) {
          return text({ id, status: e.status, timed_out: true,
            note: "still running; call wait_job again or job to poll" });
        }
        await new Promise((r) => setTimeout(r, every));
      }
    } catch (e) { return fail(e); }
  });

  server.registerTool("cancel_job", {
    title: "Cancel a job",
    description: "Ask the backend to stop a run.",
    inputSchema: { id: z.string().describe("history entry id") },
  }, async ({ id }) => {
    try {
      const r = await call(`/api/history/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      return text({ id, canceled: true, entry: r?.status ?? null });
    } catch (e) { return fail(e); }
  });

  server.registerTool("history", {
    title: "Recent runs",
    description: "The studio's history, newest first: what was run, with what values, and where the files are.",
    inputSchema: {
      app: z.string().optional().describe("only this app"),
      limit: z.number().int().min(1).max(100).optional().describe("how many (default 20)"),
      request_id:z.string().max(200).optional().describe("recover a specific idempotent submission without resubmitting it"),
    },
  }, async ({ app, limit,request_id }) => {
    try {
      const q = new URLSearchParams();
      if (app) q.set("app", app);
      if(request_id)q.set("request_id",request_id);
      const raw = await call(`/api/history${q.size ? `?${q}` : ""}`);
      const list = (Array.isArray(raw) ? raw : (raw?.entries ?? [])) as Any[];
      const out = list.slice(0, limit ?? 20).map((e) => {
        const v = local(e);
        return { id: v.id, app: v.app, status: v.status, created: v.created, seconds: v.seconds ?? null,
          values: v.values, outputs: v.outputs.map((o: Any) => o.path) };
      });
      return text({ count: out.length, runs: out });
    } catch (e) { return fail(e); }
  });

  server.registerTool("gpu", {
    title: "GPU and backend status",
    description: "Is the backend warm, which app is loaded, and how much VRAM is in use.",
    inputSchema: { device: z.boolean().optional().describe("include VRAM figures (only when warm)") },
  }, async ({ device }) => {
    try {
      return text(await call(`/api/gpu${device ? "?device=1" : ""}`));
    } catch (e) { return fail(e); }
  });

  server.registerTool("examples", {
    title: "Lab examples",
    description: "The example each app ships with: the values and input files that made it. Use it as a working starting point for run_app.",
    inputSchema: { app: z.string().describe("app id") },
  }, async ({ app }) => {
    try {
      const a = await manifest(app,base);
      if (!a.example) return text({ app, example: null, note: "this app has no example" });
      return text({
        app, values: a.example.values,
        inputs: (a.example.inputs ?? []).map((i: Any) => ({ id: i.id, file: i.full || i.src })),
        note: "paths are relative to web/; pass them to run_app.files as absolute: " + join(ROOT, "web"),
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("media",{
    title:"Scoped local media utilities",
    description:"Generic CPU probe/frame/concat/mix. Paths must be existing History media, user Agent uploads, web examples or outputs of this tool. No arbitrary shell/filters. probe returns dimensions/duration/audio; frame extracts one timestamp; concat normalizes and exports H264/AAC MP4; mix combines up to four audio streams. Editing is bounded to 120 seconds and 4.2 MP. Outputs are real files reusable by run_app.",
    inputSchema:{operation:z.enum(["probe","frame","concat","mix"]),path:z.string().optional(),paths:z.array(z.string()).max(8).optional(),seconds:z.number().min(0).max(36000).optional(),volumes:z.array(z.number().min(0).max(2)).max(4).optional()},
  },async input=>{try{return text(await call("/api/media",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)}));}catch(e){return fail(e);}});

  return server;
}

async function main() {
  if (process.argv.includes("--stdio")) {
    const server = build();
    await server.connect(new StdioServerTransport());
    console.error(`riverfield mcp: stdio, app at ${BASE}`);
    return;
  }

  const http = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (url === "/health" || url.startsWith("/health?")) {
      let appOk = false;
      try { await api("/api/gpu"); appOk = true; } catch { /* app down */ }
      res.writeHead(appOk ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: appOk, app: BASE, port: PORT }));
      return;
    }
    if (!url.startsWith("/mcp")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the MCP endpoint is /mcp" }));
      return;
    }
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  http.listen(PORT, HOST, () => {
    console.error(`riverfield mcp: http://${HOST}:${PORT}/mcp  (app: ${BASE})`);
  });
}

if(resolve(process.argv[1]||"")===fileURLToPath(import.meta.url))void main();
