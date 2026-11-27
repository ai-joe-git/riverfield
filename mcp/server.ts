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
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { promptGuidance } from "./prompt-guidance.ts";
import {planH3,planDirectorSegments,directorRequest,directorValues,directorDurations,DIRECTOR_DEFAULTS,DIRECTOR_MANAGED_INPUTS,DIRECTOR_DELIVERY} from "../server/h3-plan.ts";
import {resolveApp} from "../server/app-reference.ts";
import {InputError,inputErrorBody} from "../server/input-error.ts";
import {normalizeRunInputs} from "../server/run-inputs.ts";

const BASE = (process.env.RIVERFIELD_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PORT = Number(process.env.RIVERFIELD_MCP_PORT || 3010);
const HOST = process.env.RIVERFIELD_MCP_HOST || "127.0.0.1";
const ROOT = resolve(import.meta.dirname, "..");
const OUT = process.env.RIVERFIELD_OUT || join(ROOT, "out");
const localWriter = z.object({baseUrl:z.string(),model:z.string(),vision:z.boolean().optional()});
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

const text = (v: unknown, compact = false) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, compact ? undefined : 2) }],
});
const fail = (e: unknown) => {
 const data=e instanceof InputError?inputErrorBody(e):e instanceof StudioHttpError?{...((e.body&&typeof e.body==="object")?e.body:{}),error:e.body?.error||e.message,status:e.status,code:e.body?.code||"HTTP_ERROR",retryable:e.status>=500}:undefined;
 return {content:[{type:"text" as const,text:data?JSON.stringify(data):`Error: ${e instanceof Error?e.message:String(e)}`}],...(data?{structuredContent:data}:{}),isError:true};
};

export function build(base=BASE): McpServer {
  const call=(path:string,init?:RequestInit)=>api(path,init,base);
  const server = new McpServer({ name: "riverfield", version: "1.0.0" });

  server.registerTool("plan_segments", {
    title:"Plan Director windows with the selected app",
    description:"Return real 24 fps timeline windows, legal lengths, overlaps and ordered attachments. Pika uses fixed native windows. H3 Studio Director Flash accepts segment_seconds and overlap_frames, including 0 for clean cuts. Pass the exact app ID. If you omit prompts, use the returned count and then prepare that many drafts. No generation.",
    inputSchema:{ ...directorRequest.shape, app:z.enum(["pika-studio-director","h3-studio-director-flash"]).optional(),
      segment_seconds:z.number().min(.5).max(60).optional(), overlap_frames:z.number().int().min(0).max(3591).optional().describe("H3 Flash only. 0 places each new segment immediately after the previous one.") },
    annotations:{readOnlyHint:true},
  },async ({app,segment_seconds,overlap_frames,...args})=>{
    try {
      if(app!=="h3-studio-director-flash"){
        if(segment_seconds!==undefined||overlap_frames!==undefined)throw new InputError("Only H3 Studio Director Flash accepts custom segment lengths and overlap. Pika uses fixed native windows.");
        return text(planDirectorSegments(args));
      }
      const seconds=segment_seconds??7.3;
      const one=planH3({seconds,overlap_frames,prompts:["Draft"]});
      const estimate=args.total_seconds?Math.round((args.total_seconds*24-one.overlapFrames)/(one.segmentFrames-one.overlapFrames)):1;
      const count=args.prompts.length||Math.max(1,Math.min(64,estimate));
      const plan=planH3({...args,seconds,overlap_frames,total_seconds:undefined,prompts:args.prompts.length?args.prompts:Array(count).fill("Draft")});
      if(args.prompts.length) return text({...plan,app,ready:true,requiredPrompts:count,requestedSeconds:args.total_seconds??null});
      const {segment_windows,...geometry}=plan;
      return text({...geometry,app,ready:false,requiredPrompts:count,requestedSeconds:args.total_seconds??null,
        windows:JSON.parse(segment_windows).windows.map((window:Any)=>({...window,prompt:""}))});
    } catch(e) {return fail(e);}
  });

  server.registerTool("list_apps", {
    title: "Find Riverfield apps",
    description: "Find one page of apps by name or capability. Filter by query, section or status. Use nextOffset to page or get_app for one exact manifest.",
    inputSchema: {
      section: z.enum(["image", "video", "audio", "3d", "utility"]).optional().describe("only this studio"),
      status: z.enum(["ready", "draft"]).optional().describe("only this status"),
      query: z.string().max(160).optional().describe("app name or keywords, for example director flash"),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(40).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ section, status, query, offset = 0, limit = 16 }) => {
    try {
      const words = (query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const list = (await apps(base)).filter(app => {
        if ((section && app.section !== section) || (status && app.status !== status)) return false;
        const label = [app.id, app.name, app.summary, app.pack].join(" ").toLowerCase();
        return words.every(word => label.includes(word));
      });
      const page = list.slice(offset, offset + limit).map(app => ({
        id: app.id, name: app.name, section: app.section, status: app.status, summary: app.summary, pack: app.pack,
      }));
      return text({ count: list.length, apps: page, ...(offset + limit < list.length ? { nextOffset: offset + limit } : {}) }, true);
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
          // consumed by the shared render-profile resolver, not bound to a ComfyUI node
          derived: Boolean(i.derived),
          ...(a.id==="pika-studio-director"&&(DIRECTOR_MANAGED_INPUTS as readonly string[]).includes(i.id)?{agentManaged:true}:{}),
        })),
        presets: (a.presets ?? []).map((p: Any) => ({ id: p.id, label: p.label })),
        outputs: a.outputs, models: (a.models ?? []).map((m: Any) => m.name),
        renderProfile: a.renderProfile ?? null,
        notes: a.notes ?? a.source?.notes ?? null, source: a.source ?? null,
        prompting: promptGuidance(a as any),
        ...(a.id==="pika-studio-director"?{agentDefaults:DIRECTOR_DEFAULTS,actualDurations:directorDurations(),delivery:DIRECTOR_DELIVERY,effectiveTechnicalDefaults:Object.fromEntries(a.inputs.filter((i:Any)=>(DIRECTOR_MANAGED_INPUTS as readonly string[]).includes(i.id)).map((i:Any)=>[i.id,i.default])),agentWritableInputs:a.inputs.filter((i:Any)=>!(DIRECTOR_MANAGED_INPUTS as readonly string[]).includes(i.id)&&!["advanced_timeline_json","segment_prompts"].includes(i.id)).map((i:Any)=>i.id)}:{}),
        example: a.example ? { values: a.example.values, inputs: a.example.inputs } : null,
      }, true);
    } catch (e) { return fail(e); }
  });

  server.registerTool("run_app", {
    title: "Run an app",
    description: "Start a generation. Returns the history entry (id) at once; use wait_job to get the files. `values` are the app's inputs (numbers, strings, booleans, arrays for multi-selects. Director segment_windows can be an object with windows, videos and audios, or its JSON string); `files` maps a file input id (image/video/audio) to an absolute path on this machine. H3 Directors: render_profile 'build' forces 0.1 MP and no upscale; 'production' uses the app's production default (0.3 MP on the current H3 directors) and production_upscale x2 by default; omitting render_profile uses the manifest's declared starting profile (Production on the current H3 directors), or legacy settings for a manifest that declares none. Directors also accept the hidden production_id and production_scene_id fields: when set, approved canonical Production Engine memory is injected into the prompt enhancer; when absent the existing Director context is used unchanged.",
    inputSchema: {
      app: z.string().describe("app id"),
      values: z.record(z.string(), z.any()).optional().describe("input values, by input id. Director segment_windows accepts a timeline object; call plan_segments without prompts to obtain timings first."),
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
      return text({ id: entry.id, app: entry.app, status: entry.status, created: entry.created,
        render: entry.render ?? null, lineage: entry.lineage ?? null });
    } catch (e) { return fail(e); }
  });

  server.registerTool("prepare_app_run", {
    title: "Prepare render prompts on the active local writer",
    description: "Use Riverfield's real enhancer instructions, production memory and ordered references to prepare one app request. Returns only its validated prompt fields. Does not submit any render or start ComfyUI. BlackRiver supplies its active local model.",
    inputSchema: { app:z.string(), values:z.record(z.string(),z.any()).optional(), files:z.record(z.string(),z.string()).optional(), writer:localWriter },
  }, async ({app, values, files, writer}) => {
    try {
      const canonical = await manifest(app,base);
      if (!canonical.inputs.some((input: Any) => input.id === "prompt_enhancer")) return text({applied:false});
      const normalized = normalizeRunInputs(canonical as any, values ?? {}, files ?? {});
      const fd = await form(canonical.id, canonical.id==="pika-studio-director"?directorValues(normalized.values,normalized.files):normalized.values,normalized.files,undefined,base);
      fd.append("workspace_writer",JSON.stringify(writer));
      return text(await call(`/api/apps/${encodeURIComponent(canonical.id)}/prepare-prompts`,{method:"POST",body:fd}));
    } catch(e) { return fail(e); }
  });

  server.registerTool("production_scope", {
    title: "Find a production's seasons, episodes, scenes and reference assets",
    description: "Start here for an existing production. Use episodeId to narrow scenes. Use assetCategory or assetQuery to resolve matching reference paths. Use offset to page assets.",
    inputSchema: {
      productionId: z.string(), episodeId: z.string().optional(),
      assetCategory: z.string().max(80).optional().describe("for example characters or environments"),
      assetQuery: z.string().max(160).optional(), offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ productionId, episodeId, assetCategory, assetQuery, offset = 0 }) => {
    try {
      const snap = await call(`/api/productions/${encodeURIComponent(productionId)}`);
      const compact = (rows: Any[], parent: string) => rows.slice(0, 60).map(row => ({
        id: row.id, title: row.title, number: row.number, [parent]: row[parent],
      }));
      const terms = (assetQuery ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const category = assetCategory?.trim().toLowerCase();
      const assets = Object.values((snap.assets ?? {}) as Record<string, Any>).filter(row =>
        (!category || row.category?.toLowerCase() === category) &&
        terms.every(term => [row.id, row.label, row.category, ...(row.tags ?? [])].join(" ").toLowerCase().includes(term)));
      const scenes = (snap.scenes ?? []).filter((row: Any) => !episodeId || row.episodeId === episodeId);
      return text({
        production: snap.production && { id: snap.production.id, title: snap.production.title },
        seasons: compact(snap.seasons ?? [], "productionId"), episodes: compact(snap.episodes ?? [], "seasonId"),
        scenes: compact(scenes, "episodeId"), sceneCount: scenes.length,
        assets: assets.slice(offset, offset + 24).map(row => ({
          id: row.id, label: row.label, kind: row.kind, category: row.category, ...(terms.length || category ? { path: row.path } : {}),
        })),
        assetCount: assets.length, ...(assets.length > offset + 24 ? { nextOffset: offset + 24 } : {}),
      }, true);
    } catch (e) { return fail(e); }
  });

  server.registerTool("list_productions", {
    title: "List productions",
    description: "List persistent Production Engine universes. Read-only; canonical approvals are not exposed through MCP.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text(await call("/api/productions")); } catch (e) { return fail(e); }
  });

  server.registerTool("create_production", {
    title: "Create a production",
    description: "Create a draft production universe (series or film). This is organizational, not a canonical approval. Use create_season, create_episode and create_scene next.",
    inputSchema: {
      id: z.string().optional().describe("stable lowercase slug; derived from the title when omitted"),
      title: z.string().min(1),
      logline: z.string().optional(),
      description: z.string().optional(),
      style: z.string().optional(),
    },
  }, async (args) => {
    try {
      return text(await call("/api/productions", { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(args) }));
    } catch (e) { return fail(e); }
  });

  server.registerTool("get_production", {
    title: "Read a production summary",
    description: "Read production identity, revision and record counts. Use production_scope for hierarchy and references, get_scene_context for continuity, or includeSnapshot only for an explicit full export.",
    inputSchema: { productionId: z.string(), includeSnapshot: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ productionId, includeSnapshot }) => {
    try {
      const snapshot = await call(`/api/productions/${encodeURIComponent(productionId)}`);
      if (includeSnapshot === true) return text(snapshot, true);
      const { id, title, status, logline } = snapshot.production;
      const fields = ["seasons", "episodes", "scenes", "assets", "candidates", "observations", "continuityReviews", "productionRuns"];
      const counts = Object.fromEntries(fields.map(field => [field, Object.keys(snapshot[field] ?? {}).length]));
      return text({
        production: { id, title, status, logline: typeof logline === "string" ? logline.slice(0, 500) : logline },
        revision: snapshot.revision, counts,
        guidance: "Use production_scope for IDs and reference paths, and get_scene_context for canonical continuity.",
      }, true);
    } catch (e) { return fail(e); }
  });

  server.registerTool("create_season", {
    title: "Create a season",
    description: "Create a season inside a production. No canonical content is approved.",
    inputSchema: { productionId: z.string(), number: z.number().int().positive(), title: z.string().min(1), id: z.string().optional() },
  }, async ({ productionId, ...body }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/seasons`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) })); } catch (e) { return fail(e); }
  });

  server.registerTool("create_episode", {
    title: "Create an episode",
    description: "Create a draft episode inside a season. No canonical content is approved.",
    inputSchema: { productionId: z.string(), seasonId: z.string(), number: z.number().int().positive(), title: z.string().min(1), status: z.enum(["draft", "active", "archived"]).optional(), id: z.string().optional() },
  }, async ({ productionId, ...body }) => {
    try {
      const snapshot = await call(`/api/productions/${encodeURIComponent(productionId)}/episodes`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) });
      const entries = Object.values((snapshot.episodes || {}) as Record<string, Any>);
      const entity = entries.find(row => body.id ? row.id === body.id : row.number === body.number && row.title === body.title && row.seasonId === body.seasonId);
      return text({ productionId, episode: entity || null });
    } catch (e) { return fail(e); }
  });

  server.registerTool("create_scene", {
    title: "Create a scene",
    description: "Create a draft scene inside an episode. Candidates and decisions are separate.",
    inputSchema: {
      productionId: z.string(), episodeId: z.string(), number: z.number().int().positive(), title: z.string().min(1),
      characterIds: z.array(z.string()).optional(), locationIds: z.array(z.string()).optional(), summary: z.string().optional(), id: z.string().optional(),
    },
  }, async ({ productionId, ...body }) => {
    try {
      const snapshot = await call(`/api/productions/${encodeURIComponent(productionId)}/scenes`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) });
      const entries = Object.values((snapshot.scenes || {}) as Record<string, Any>);
      const entity = entries.find(row => body.id ? row.id === body.id : row.number === body.number && row.title === body.title && row.episodeId === body.episodeId);
      return text({ productionId, scene: entity || null });
    } catch (e) { return fail(e); }
  });

  server.registerTool("get_scene_context", {
    title: "Get canonical scene context",
    description: "Return typed, bounded Identity/State/Episodic/Narrative memory and recent canonical scenes. This is independent of the chosen writer or video engine.",
    inputSchema: {
      productionId: z.string(), sceneId: z.string().optional(), characterIds: z.array(z.string()).optional(),
      locationIds: z.array(z.string()).optional(), threadIds: z.array(z.string()).optional(),
      recentScenes: z.number().int().min(0).max(20).optional(), maxChars: z.number().int().min(500).max(64000).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ productionId, ...query }) => {
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, Array.isArray(value) ? value.join(",") : String(value));
      return text(await call(`/api/productions/${encodeURIComponent(productionId)}/context?${params}`));
    } catch (e) { return fail(e); }
  });

  server.registerTool("register_candidate", {
    title: "Register an immutable candidate",
    description: "Index a succeeded history run as an immutable render candidate. Outputs stay in history; nothing is copied. Bindings use final-output frame ranges and can cover several scenes. Returns the exact candidate_id and binding IDs to use with analyze_scene. No scene obtains canonical status automatically.",
    inputSchema: {
      productionId: z.string(), runId: z.string().describe("succeeded history run id"),
      label: z.string().optional(), prompt: z.string().optional(), id: z.string().optional(),
      bindings: z.array(z.object({
        sceneId: z.string(), segmentIndex: z.number().int().min(0),
        timelineStartFrame: z.number().int().min(0), timelineEndFrame: z.number().int().min(1),
        sourceStartFrame: z.number().int().min(0).optional(), sourceEndFrame: z.number().int().min(0).optional(),
        fps: z.number().positive().optional(), outputHash: z.string().optional(), id: z.string().optional(),
      })).min(1),
    },
  }, async ({ productionId, ...body }) => {
    try {
      const id = body.id ?? randomUUID();
      const snapshot = await call(`/api/productions/${encodeURIComponent(productionId)}/candidates`, {
        method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" },
        body: JSON.stringify({ ...body, id }),
      });
      const candidate = snapshot.candidates?.[id];
      if (!candidate) throw Error("Riverfield returned no exact candidate receipt. Read the saved production before retrying.");
      return text({
        productionId, revision: snapshot.revision, candidate_id: candidate.id, run_id: candidate.sourceRunId,
        label: candidate.label, bindings: candidate.bindings,
      }, true);
    } catch (e) { return fail(e); }
  });

  server.registerTool("record_scene_observation", {
    title: "Record an observation",
    description: "Record observed evidence or a human note against a scene/candidate. An observation is never canonical by itself; it can be referenced by a later proposal.",
    inputSchema: {
      productionId: z.string(), sceneId: z.string(), candidateId: z.string().optional(), runId: z.string().optional(),
      text: z.string().min(1), evidence: z.array(z.object({ type: z.string(), path: z.string(), startFrame: z.number().int().optional(), endFrame: z.number().int().optional() })).optional(),
      id: z.string().optional(),
    },
  }, async ({ productionId, ...body }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/observations`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) })); } catch (e) { return fail(e); }
  });

  server.registerTool("propose_canonical_changes", {
    title: "Propose canonical changes",
    description: "Create a proposed scene decision and/or Identity/State/Episodic/Narrative facts. This is only a proposal: it cannot approve itself. A human must run the interactive approval CLI. Expected revision, exact candidate, scene and changes are fingerprinted.",
    inputSchema: {
      productionId: z.string(),
      title: z.string().optional(), note: z.string().optional(), expectedRevision: z.number().int().min(0).optional(), id: z.string().optional(),
      sceneDecision: z.object({ sceneId: z.string(), candidateId: z.string(), decision: z.enum(["canon", "alternate", "reject"]), bindingIds: z.array(z.string()).optional() }).optional(),
      changes: z.array(z.object({
        op: z.enum(["add", "update"]), category: z.enum(["identity", "state", "episodic", "narrative"]),
        factId: z.string().optional(), text: z.string().min(1), subjectIds: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(), data: z.any().optional(), sceneId: z.string().optional(),
        phase: z.enum(["opening", "closing", "global"]).optional(),
        provenance: z.record(z.string(), z.any()).optional(),
      })).optional(),
    },
  }, async ({ productionId, ...body }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/proposals`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) })); } catch (e) { return fail(e); }
  });

  server.registerTool("render_production", {
    title: "Render Production from a preview",
    description: "Promote a succeeded H3 Director Build & Test preview to a new Production generation. The preview's exact creative payload (timeline, prompts, references, seed, checkpoint, sampler, steps, aspect) is preserved; only rendering parameters change (default 0.3 MP and RelayVSR x2, with off/x4 optional). Both outputs stay in history and are linked. This is a new generation, NOT a pixel-identical reconstruction of the preview.",
    inputSchema: {
      id: z.string().describe("history entry id of the succeeded preview"),
      production_megapixels: z.number().min(0.1).max(16).optional().describe("generation resolution in MP; defaults to the Director's saved production preference, or the app's production_megapixels default (0.3 on the current H3 directors)"),
      production_upscale: z.enum(["off", "x2", "x4"]).optional().describe("RelayVSR factor; 'off' disables upscaling"),
      production_upscale_detail: z.number().min(0).max(1).optional().describe("RelayVSR decoder detail, when upscaling"),
      request_id: z.string().max(200).optional().describe("optional durable idempotency key"),
    },
  }, async ({ id, production_megapixels, production_upscale, production_upscale_detail, request_id }) => {
    try {
      const body: Any = {};
      if (production_megapixels !== undefined) body.production_megapixels = production_megapixels;
      if (production_upscale !== undefined) body.production_upscale = production_upscale === "off" ? "" : production_upscale;
      if (production_upscale_detail !== undefined) body.production_upscale_detail = production_upscale_detail;
      if (request_id) body.request_id = request_id;
      const entry = await call(`/api/history/${encodeURIComponent(id)}/production`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return text({ id: entry.id, app: entry.app, status: entry.status, created: entry.created,
        preview: entry.preview ?? id, render: entry.render ?? null, lineage: entry.lineage ?? null });
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
        render: v.render ?? null, lineage: v.lineage ?? null,
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
            render: v.render ?? null, lineage: v.lineage ?? null,
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
          values: v.values, render: v.render ?? null, lineage: v.lineage ?? null, outputs: v.outputs.map((o: Any) => o.path) };
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

  server.registerTool("list_observer_models", {
    title: "List installed observer models",
    description: "Discover the observer checkpoints installed under ComfyUI text_encoders, their exact filenames, CLIPLoader recipe, quantization and proven input modalities. Read-only; it does not load weights or start inference.",
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text(await call("/api/observer-models")); } catch (e) { return fail(e); }
  });

  server.registerTool("list_observer_profiles", {
    title: "List observer profiles",
    description: "List the Fast, Detailed, Senior and Experimental Audiovisual observer profiles. Profiles supply defaults; custom model selection and inference controls remain available. This tool is read-only.",
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text(await call("/api/observer-profiles")); } catch (e) { return fail(e); }
  });

  server.registerTool("list_production_runs", {
    title: "List production runs",
    description: "List durable production runs with their plan, stage, budget, jobs, candidates, provisional facts and human decisions. Read-only; no inference.",
    inputSchema: { productionId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ productionId }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/runs`)); } catch (e) { return fail(e); }
  });

  server.registerTool("plan_production_run", {
    title: "Plan a production run",
    description: "Create an editable scene plan from a natural-language brief using existing production context and trusted assets. Planning creates no scenes, candidates or inference.",
    inputSchema: { productionId: z.string(), brief: z.string().min(1), sceneCount: z.number().int().min(1).max(8).optional(), profile: z.enum(["build", "production"]).optional(), seasonId: z.string().optional(), episodeId: z.string().optional(), selectedApp: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ productionId, ...body }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/runs/plan`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) })); } catch (e) { return fail(e); }
  });

  server.registerTool("create_production_run", {
    title: "Create a prepared production run",
    description: "Persist a prepared run from a plan or brief. It does not start rendering or inference. A human must later authorize the run and every human approval boundary.",
    inputSchema: { productionId: z.string(), title: z.string().min(1), brief: z.string().optional(), runId: z.string().optional(), budget: z.record(z.string(), z.any()).optional(), plan: z.record(z.string(), z.any()).optional(), commandKey: z.string().optional() },
  }, async ({ productionId, ...body }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/runs`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) })); } catch (e) { return fail(e); }
  });

  server.registerTool("get_production_run", {
    title: "Read a production run",
    description: "Read one durable run: scope, plan, budget ledger, stage, persisted job ids, candidates, observation revisions, reviews, provisional state, decisions and errors.",
    inputSchema: { productionId: z.string(), runId: z.string(), request_id:z.string().max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ productionId, runId, request_id }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/runs/${encodeURIComponent(runId)}${request_id?"?requestKey="+encodeURIComponent(request_id):""}`)); } catch (e) { return fail(e); }
  });

  server.registerTool("prepare_production_render", {
    title:"Prepare the current production scene with the BlackRiver local writer",
    description:"Prepare and return the final prompts for the current scene revision, including its references and approved continuity. Pass preparationId to the background render after review. This tool only writes prompts.",
    inputSchema:{productionId:z.string(),runId:z.string(),writer:localWriter},
  },async ({productionId,runId,writer})=>{
    try{return text(await call(`/api/productions/${encodeURIComponent(productionId)}/runs/${encodeURIComponent(runId)}/prepare-workspace`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({writer})}));}
    catch(e){return fail(e);}
  });

  server.registerTool("control_production_run", {
    title: "Start, pause, resume or cancel a production run",
    description: "Durable run controls. A background start or resume of a fresh scene with enhancement enabled requires preparation_id from prepare_production_render, or explicit use_riverfield_enhancer. Resuming an existing job keeps its original prompts.",
    inputSchema: { productionId: z.string(), runId: z.string(), action: z.enum(["start", "pause", "resume", "cancel"]), background:z.boolean().optional(), request_id:z.string().max(200).optional(), preparation_id:z.string().uuid().optional(), use_riverfield_enhancer:z.boolean().optional(), workspace_observation_mode:z.enum(["defer", "local"]).optional(), workspace_observer:z.unknown().optional() },
  }, async ({ productionId, runId, action, ...params }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(params) })); } catch (e) { return fail(e); }
  });

  server.registerTool("decide_production_run_scene", {
    title: "Record a production run decision",
    description: "Record explicit human review for a run scene. Approval advances the run plan; it does not canonize a candidate. Rejection/replacement invalidates downstream provisional assumptions without deleting media.",
    inputSchema: { productionId: z.string(), runId: z.string(), sceneId: z.string(), decision: z.enum(["approved", "rejected", "replace", "reuse"]), note: z.string().optional() },
  }, async ({ productionId, runId, ...body }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/runs/${encodeURIComponent(runId)}/decide`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) })); } catch (e) { return fail(e); }
  });

  server.registerTool("list_continuity_reviews", {
    title: "List continuity reviews",
    description: "Immutable, non-canonical continuity reviews for a production, linked to exact observations, scene bindings and candidates. Read-only.",
    inputSchema: { productionId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ productionId }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/continuity-reviews`)); } catch (e) { return fail(e); }
  });

  server.registerTool("get_continuity_review", {
    title: "Read a continuity review",
    description: "One immutable continuity review with reviewer configuration, evidence references, states, findings and limitations. Read-only.",
    inputSchema: { productionId: z.string(), reviewId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ productionId, reviewId }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/continuity-reviews/${encodeURIComponent(reviewId)}`)); } catch (e) { return fail(e); }
  });

  server.registerTool("prepare_continuity_review", {
    title: "Prepare a continuity review",
    description: "Record an immutable prepared (or completed) continuity review from existing observations. This never launches inference, changes candidates, canonizes, or regenerates media. Pass the exact observation revision and source hash; sceneIds and observations are required.",
    inputSchema: {
      productionId: z.string(),
      id: z.string().optional(),
      seasonId: z.string().optional(),
      episodeId: z.string().optional(),
      sceneIds: z.array(z.string()).min(1),
      bindingIds: z.array(z.string()).optional(),
      candidateIds: z.array(z.string()).optional(),
      observations: z.array(z.object({ observationId: z.string(), sceneId: z.string(), revision: z.number().int().positive(), sourceHash: z.string() })).min(1),
      reviewer: z.object({ model: z.string(), kind: z.enum(["qwen", "deterministic", "human"]), configuration: z.record(z.string(), z.any()).optional() }),
      evidenceReferences: z.array(z.string()).optional(),
      status: z.enum(["prepared", "completed", "superseded", "rejected"]).optional(),
      findings: z.array(z.any()).optional(),
      stateRecords: z.array(z.any()).optional(),
      correctionPlans: z.array(z.any()).optional(),
      limitations: z.array(z.string()).optional(),
    },
  }, async ({ productionId, ...body }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/continuity-reviews`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) })); } catch (e) { return fail(e); }
  });

  server.registerTool("run_senior_continuity_review", {
    title: "Run one senior continuity review",
    description: "Execute the production-independent senior review using an explicit deterministic baseline. Requires confirm=true. It never retries automatically, never regenerates media, and never approves or canonizes.",
    inputSchema: {
      productionId: z.string(), preparedReviewId: z.string(), baselineReviewId: z.string(),
      maxImages: z.number().int().min(4).max(9).optional(),
      confirm: z.literal(true),
    },
  }, async ({ productionId, ...body }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/continuity-reviews/run-senior`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(body) })); } catch (e) { return fail(e); }
  });

  server.registerTool("get_asset_correction_decisions", {
    title: "Read asset correction decisions",
    description: "Read human decisions on the prepared asset correction batch. A decision never applies metadata automatically. Read-only.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text(await call("/api/asset-corrections/decisions")); } catch (e) { return fail(e); }
  });

  server.registerTool("get_asset_audit", {
    title: "Read asset catalogue audit",
    description: "Semantic asset catalogue audit: trusted assets, proposed corrections, review-required assets and the historical P6 reference warning. Proposals do not alter original media or reports. Read-only.",
    inputSchema: { productionId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ productionId }) => {
    try { return text(await call(`/api/asset-audit`)); } catch (e) { return fail(e); }
  });

  server.registerTool("analyze_scene", {
    title: "Analyze a scene candidate",
    description: "Start an explicit, evidence-only observation of one immutable candidate and one scene binding set. It extracts cached FFmpeg evidence, runs the selected installed multimodal observer and the Whisper Turbo ASR adapter through the shared queue, then records a structured observation report. It does not approve or canonize anything.",
    inputSchema: {
      productionId: z.string(), sceneId: z.string(), candidateId: z.string(),
      bindingIds: z.array(z.string()).optional().describe("only these scene bindings; default all bindings for the scene"),
      maxFrames: z.number().int().min(1).max(48).optional(),
      visualFrames: z.number().int().min(1).max(9).optional(),
      sampleIntervalSeconds: z.number().min(0.25).max(30).optional(),
      sceneThreshold: z.number().gt(0).lt(1).optional(),
      includeAudio: z.boolean().optional(), visual: z.boolean().optional(), asr: z.boolean().optional(), comparison: z.boolean().optional(),
      profile: z.enum(["custom", "fast", "detailed", "senior", "experimental-av"]).optional().describe("observer profile; Senior Review reuses an existing observation and evidence"),
      sourceObservationId: z.string().optional().describe("existing observation to review in Senior Review; defaults to the latest structured observation for the scene/candidate"),
      visualModel: z.string().optional().describe("installed observer model id for the independent visual pass; list_observer_models returns ids"),
      comparisonModel: z.string().optional().describe("independent installed observer model id for the comparison pass"),
      nativeVideo: z.boolean().optional().describe("supply an actual scene video through TextGenerateV2 videos; rejected if the visual model lacks video support"),
      nativeAudio: z.boolean().optional().describe("supply actual scene audio through TextGenerateV2 audios; rejected if the visual model lacks audio support"),
      temperature: z.number().min(0.01).max(2).optional(),
      maxOutputTokens: z.number().int().min(1).max(32768).optional(),
      topK: z.number().int().min(0).max(1000).optional(),
      topP: z.number().min(0).max(1).optional(),
      referenceAssetIds: z.array(z.string()).optional().describe("production image assets to compare against identity; not proof of appearance"),
      request_id: z.string().max(200).optional(),
      workspace_observer: z.unknown().optional().describe("Local BlackRiver runtime routing supplied by the desktop integration."),
    },
  }, async ({ productionId, request_id, ...body }) => {
    try {
      const payload: Any = { ...body };
      const optionKeys = ["maxFrames", "visualFrames", "sampleIntervalSeconds", "sceneThreshold", "includeAudio", "visual", "asr", "comparison", "visualModel", "comparisonModel", "nativeVideo", "nativeAudio", "temperature", "maxOutputTokens", "topK", "topP"] as const;
      if (optionKeys.some((key) => body[key] !== undefined)) {
        payload.options = Object.fromEntries(optionKeys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
        for (const key of optionKeys) delete payload[key];
      }
      if (request_id) payload.requestKey = request_id;
      // profile/sourceObservationId are job-level fields, not inference options.
      delete payload.profile; delete payload.sourceObservationId;
      if (body.profile) payload.profile = body.profile;
      if (body.sourceObservationId) payload.sourceObservationId = body.sourceObservationId;
      return text(await call(`/api/productions/${encodeURIComponent(productionId)}/observation-jobs`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: JSON.stringify(payload) }));
    } catch (e) { return fail(e); }
  });

  server.registerTool("find_observation_job", {
    title: "Recover a previously submitted observation",
    description: "Read the observation receipt for one exact request key without submitting a job.",
    inputSchema: {productionId:z.string(), request_id:z.string().min(1).max(200)},
    annotations:{readOnlyHint:true},
  }, async ({productionId,request_id}) => {
    try {
      const result=await call(`/api/productions/${encodeURIComponent(productionId)}/observation-jobs?requestKey=${encodeURIComponent(request_id)}`);
      return text({runs:result.jobs||[]});
    } catch(e) { return fail(e); }
  });

  server.registerTool("get_observation_job", {
    title: "Observation job status",
    description: "Read a durable observation job: stage, percent, failures, evidence directory and the observation id once recorded.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    try { return text(await call(`/api/observation-jobs/${encodeURIComponent(id)}`)); } catch (e) { return fail(e); }
  });

  server.registerTool("cancel_observation_job", {
    title: "Cancel an observation",
    description: "Cancel a running observation. Already extracted evidence is retained and the candidate is untouched.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    try { return text(await call(`/api/observation-jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" })); } catch (e) { return fail(e); }
  });

  server.registerTool("get_scene_observations", {
    title: "Read scene observations",
    description: "All immutable manual and automated observations for one scene, ordered by revision. Structured reports are never canonical facts.",
    inputSchema: { productionId: z.string(), sceneId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ productionId, sceneId }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/observations`)); } catch (e) { return fail(e); }
  });

  server.registerTool("get_observation_evidence", {
    title: "Read observation evidence",
    description: "Evidence files and their frame/time references for one observation job. Paths are relative to the evidence directory and are served by the local studio.",
    inputSchema: { jobId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ jobId }) => {
    try {
      const job = await call(`/api/observation-jobs/${encodeURIComponent(jobId)}`);
      if (!job?.observationId) return text({ job, evidence: [], note: "No structured observation was recorded; inspect the job stages." });
      const observations = await call(`/api/productions/${encodeURIComponent(job.productionId)}/scenes/${encodeURIComponent(job.sceneId)}/observations`);
      const observation = (observations.observations || []).find((item: Any) => item.id === job.observationId);
      return text({ jobId, observationId: job.observationId, evidenceDir: job.evidenceDir, evidence: observation?.report?.evidence ?? [], shots: observation?.report?.shots ?? [], limitations: observation?.report?.limitations ?? [] });
    } catch (e) { return fail(e); }
  });

  server.registerTool("compare_scene", {
    title: "Read the observation comparison",
    description: "Read the comparison already produced by an observation: intended scene, observed evidence, canonical opening context, findings and proposed changes. This does not canonize or approve.",
    inputSchema: { productionId: z.string(), sceneId: z.string(), observationId: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ productionId, sceneId, observationId }) => {
    try {
      const result = await call(`/api/productions/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/observations`);
      const list = (result.observations || []).filter((item: Any) => item.report?.comparison);
      const observation = observationId ? list.find((item: Any) => item.id === observationId) : list.at(-1);
      if (!observation) return text({ comparison: null, note: "No comparison has been recorded for this scene yet." });
      return text({ observationId: observation.id, comparison: observation.report.comparison, limitations: observation.report.limitations });
    } catch (e) { return fail(e); }
  });

  server.registerTool("propose_observed_state_changes", {
    title: "Prepare observed changes",
    description: "Turn the proposed State/Episodic/Narrative changes of a structured observation into a normal canonical proposal. A human must still approve it through the interactive CLI; this tool cannot canonize.",
    inputSchema: { productionId: z.string(), observationId: z.string() },
  }, async ({ productionId, observationId }) => {
    try { return text(await call(`/api/productions/${encodeURIComponent(productionId)}/observations/${encodeURIComponent(observationId)}/propose`, { method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "agent" }, body: "{}" })); } catch (e) { return fail(e); }
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
    if (url === "/api/gpu/workspace" && (req.method === "GET" || req.method === "POST")) {
      try {
        const localNames = ["127.0.0.1", "localhost", "[::1]"];
        const host = new URL("http://" + req.headers.host).hostname;
        const studio = new URL(BASE);
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "") ||
            !localNames.includes(host) || !localNames.includes(studio.hostname) || studio.protocol !== "http:" ||
            req.headers.origin || (req.method === "POST" && req.headers["x-riverfield-workspace"] !== "1")) {
          res.writeHead(403, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "Workspace worker controls require a local application request" }));
        }
        const response = await fetch(new URL(url, studio), {
          method: req.method, redirect: "error", signal: AbortSignal.timeout(req.method === "POST" ? 32_000 : 7_000),
          headers: { "x-riverfield-workspace": "1" },
        });
        const body = await response.text();
        res.writeHead(response.status, { "content-type": "application/json" });
        return res.end(body);
      } catch {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Riverfield could not verify the Workspace worker" }));
      }
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
