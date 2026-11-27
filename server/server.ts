// Minimal HTTP API for the web UI. Node's built-in http plus the Fetch API types; no framework.
//   GET    /api/apps                         catalog (what the UI needs to draw cards and forms)
//   GET    /api/apps/:id/workflow            the app's ComfyUI workflow in API format, as a download (open it in ComfyUI)
//   POST   /api/apps/:id/run                 multipart form: one field per input id, optional "preset"
//                                            → 202 with the history entry; the run continues in the background
//   GET    /api/history[?app=id]             every run started here, newest first (out/history/)
//   GET    /api/history/:id                  one run, with live progress while it is going
//   GET    /api/history/:id/files/:file      its inputs and outputs (byte ranges)
//   GET    /api/history/:id/preview          the latest live preview frame, when the backend sends them
//   POST   /api/history/:id/cancel           ask the backend to stop it
//   DELETE /api/history/:id                  forget it (and its files)
//   GET    /api/gpu[?device=1]               is the backend warm? (never wakes it; device=1 adds VRAM in use, only when warm)
//   POST   /api/gpu/wake                     start the GPU container now, while you prepare inputs
//   GET    /api/jobs/:id[/outputs/:oid]      raw SDK job view (kept for scripts)
//   GET    /api/flags                        lab examples marked "mediocre" from the UI (lab/flags.json)
//   POST   /api/flags                        JSON { key, mediocre, note? }: mark or unmark one example
//   GET    /api/directors/:app               durable Director project (timeline + media metadata)
//   PUT    /api/directors/:app               save a Director's editable values
//   POST   /api/directors/:app/media/:slot   store one picture/clip/sound for that timeline
//   DELETE /api/directors/:app/media/:slot   remove it
// Everything else is served from web/ when it exists (with byte ranges, so videos seek everywhere).
// Hosted (server/guard.ts): RIVERFIELD_PASSCODE closes every route behind a passcode, RIVERFIELD_MAX_RUNS_PER_DAY and
// RIVERFIELD_MAX_ACTIVE cap the runs (429 past them), lab marks become read-only and uploads are capped at
// RIVERFIELD_MAX_UPLOAD_MB, and each visitor sees only their own runs. Hosted or not, requests from other sites are
// refused (guard.ts foreign()). RIVERFIELD_OUT moves out/ (history, the run count), RIVERFIELD_HOST the listening address.
// web/examples/ holds one example per app, written by lab/publish.py; /api/apps carries it along.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { loadRegistry, repoRoot, isFileInput, type App } from "./registry.ts";
import { explainSubmitError, InputError, resolveValues, Runner, type Values } from "./runner.ts";
import { History } from "./history.ts";
import { DirectorStore } from "./director-store.ts";
import { Flags } from "./flags.ts";
import { DOOR_HTML, foreign, Guard, plainHttpToIp } from "./guard.ts";
import { InferenceQueue } from "./inference-queue.ts";
import { RiverfieldAgent } from "./agent.ts";
import { exportConversation } from "./agent-export.ts";
import { StudioMcp } from "./agent-mcp.ts";
import { discoverModels } from "./model-discovery.ts";
import { build as studioMcpServer } from "../mcp/server.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {MediaTools} from "./media.ts";
import {NativeRuntime} from "./native-runtime.ts";
import {complete,type Provider} from "./agent-providers.ts";
import {projectTool} from "./agent-project.ts";
import {askTool} from "./production.ts";
import {inputErrorBody} from "./input-error.ts";
import {defaultDirectorForm} from "./director-form.ts";
import {directorDurations,planDirectorSegments,directorPromptMode} from "./h3-plan.ts";
import { ProductionStore, ProductionError, type CreateAssetBuildInput, type CreateEpisodeInput, type CreateSceneInput, type CreateSeasonInput, type IndexAssetInput, type ProposeCanonInput, type RegisterCandidateInput, type RegisterObservationInput } from "./production-store.ts";
import { buildProductionContext } from "./production-context.ts";
import { hashFile, probeMedia, productionMediaRoots, resolveMediaPath } from "./production-media.ts";
import type { Actor, ProductionSnapshot } from "./production-types.ts";
import { ObservationManager, type StartObservationInput } from "./observation.ts";
import { runSeniorContinuityReview } from "./continuity-supervisor.ts";
import { ProductionRunEngine } from "./production-run.ts";
import { planProductionRun } from "./production-run-plan.ts";
import { ObservationError } from "./observation-evidence.ts";
import { DEFAULT_OBSERVER_MODEL_ID, discoverObserverModels } from "./observer-models.ts";
import { OBSERVER_PROFILES } from "./observer-profiles.ts";
import { P6_REFERENCE_WARNING, applyAssetCorrections, auditAssetCatalogue, buildAssetCorrectionBatch, readAssetCorrectionApplications, readAssetCorrectionDecisions, recordAssetCorrectionDecision } from "./asset-audit.ts";
import {parseNativeHelp,speculativeTypes} from "./native-options.ts";
import {productionRequestFromPreview,renderMetadataFor,renderProfileCapability} from "./render-profile.ts";

const root = repoRoot();
const { apps, problems } = loadRegistry(root);
for (const p of problems.filter((x) => x.severity === "error")) console.error(`[registry] ${p.app}: ${p.message}`);
const byId = new Map(apps.map((a) => [a.id, a]));
/** Registry facts used to validate a production plan; no workflow or model data leaves the server. */
const studioApps = () => [...byId.values()].map(a => ({ id: a.id, name: a.name, section: a.section, status: a.status,
  inputs: a.inputs.map(i => ({ id: i.id, type: i.type, options: i.options?.map(o => ({ value: o.value })) })) }));

// VRAM verdicts from tools/catalog.py (optional: the UI just shows less without it)
type VramRow = { id: string; whole_gb: number; largest_phase_gb: number; verdict_24gb: string; measured_peak_gb: number | null };
const vramFile = join(root, "docs", "vram-map.json");
const vram = new Map<string, VramRow>(
  existsSync(vramFile) ? (JSON.parse(readFileSync(vramFile, "utf-8")).apps as VramRow[]).map((r) => [r.id, r]) : [],
);
let runner: Runner | null = null;
const getRunner = () => (runner ??= new Runner());
const inference = new InferenceQueue();
const runControllers = new Map<string, AbortController>();
type PromptJob = {
  id: string; appId: string; status: "running" | "succeeded" | "failed";
  values?: Values; error?: string; progress: { done: number; total: number };
  startedAt: string; finishedAt?: string;
};
const promptJobs = new Map<string, PromptJob>();
const draftsAllowed = process.env.RIVERFIELD_DRAFTS === "1";
const outDir = process.env.RIVERFIELD_OUT || join(root, "out");
const guard = Guard.fromEnv(join(outDir, "limits.json"));
const maxUploadMb = Number(process.env.RIVERFIELD_MAX_UPLOAD_MB || (guard.hosted ? 100 : 0));
const host = process.env.RIVERFIELD_HOST || "127.0.0.1";
const origins = {
  loopbackOnly: ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host),
  allowedHosts: (process.env.RIVERFIELD_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
};

// the backend scales to zero 10 minutes after its last request (infra/modal_app.py scaledown_window).
// lastContact only moves on real work (a run, a wake): status checks must not keep the GPU alive.
const WARM_MS = 9 * 60 * 1000;
let lastContact = 0;
let waking: { since: number; error?: string } | null = null;
const contact = () => { lastContact = Date.now(); };
const history = new History(join(outDir, "history"), {
  onContact: contact,
  appInfo: (id) => {
    const app = apps.find((a) => a.id === id);
    if (!app) return undefined;
    const graph = app.graph ?? {};
    return { outputs: app.outputs.map((o) => o.node), nodes: Object.keys(graph).length, classOf: (n) => graph[n]?.class_type ?? null };
  },
  frames: (jobId, signal) => getRunner().frames(jobId, signal),
  recheck: (jobId) => getRunner().jobs().get(jobId),
});
const flags = new Flags(join(root, "lab", "flags.json"), apps);
const directors = new DirectorStore(outDir, byId);
const productions = new ProductionStore(outDir, { mediaRoots: productionMediaRoots(outDir) });
let observationManager: ObservationManager | null = null;
const snapshotAsset = (snap: ProductionSnapshot, assetId: string) => snap.assets[assetId];
const observations = () => observationManager ??= new ObservationManager({
  outDir, productions, inference: inference.run, runner: getRunner(),
  mediaRoots: productionMediaRoots(outDir), whisperApp: byId.get("whisper-turbo"),
});
const studioURL=`http://127.0.0.1:${process.env.PORT||3000}`;
const mcpURL=process.env.RIVERFIELD_AGENT_MCP_URL||`${studioURL}/mcp`;
const native=new NativeRuntime(join(outDir,"native-runtime"));
const nativeLoads=new Set<AbortController>();
const prepareNative=async(p:Provider,signal:AbortSignal)=>{
  if(!p.runtimeProfile){await native.unload();return p;}
  const profile=native.get(p.runtimeProfile!);
  if(native.status().phase!=="ready"||native.status().profile!==profile.id){
    if(process.env.COMFY_BASE_URL&&["127.0.0.1","localhost","[::1]"].includes(new URL(process.env.COMFY_BASE_URL).hostname))await getRunner().release(signal);
  }
  return {...p,...await native.load(profile.id,signal)};
};
/** Stop the managed LLM without waiting behind unrelated GPU work when it is already idle. */
async function unloadNative(label="Unload native agent"){
  const pendingLoad=nativeLoads.size>0;
  for(const controller of nativeLoads)controller.abort(new Error("Native model loading canceled by user"));
  native.cancelLoading();
  if(!pendingLoad&&native.status().phase==="unloaded")return native.status();
  return inference.run(label,()=>native.unload());
}
const agent=new RiverfieldAgent(outDir,root,inference.run,()=>new StudioMcp(mcpURL),complete,prepareNative);
const media=new MediaTools(outDir,root);
function localAccess(req:IncomingMessage){
  if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress||""))throw new InputError("Agent configuration and embedded MCP require a local connection");
  if(!["127.0.0.1","localhost","[::1]"].includes(new URL(`http://${req.headers.host}`).hostname))throw new InputError("Use a localhost URL for local studio controls");
  if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new InputError("Cross-origin studio requests are not permitted");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".obj": "model/obj", ".stl": "model/stl",
  ".ply": "model/ply", ".fbx": "application/octet-stream", ".usdz": "model/vnd.usdz+zip",
  ".spz": "application/octet-stream",
};

// one example per app (lab/publish.py); read on every catalog request so a new publish shows up without a restart
const examplesFile = join(root, "web", "examples", "index.json");
function loadExamples(): Record<string, unknown> {
  try {
    return existsSync(examplesFile) ? (JSON.parse(readFileSync(examplesFile, "utf-8")).apps ?? {}) : {};
  } catch {
    return {};
  }
}

const runnable = (a: App) => Boolean(a.workflowPath) && (a.status === "ready" || draftsAllowed);

function publicApp(a: App) {
  return {
    requestExample:(()=>{const p=join(a.dir,"request-example.json");return existsSync(p)?JSON.parse(readFileSync(p,"utf8")):null})(),
    id: a.id, name: a.name, section: a.section, summary: a.summary ?? "", status: a.status, pack: a.pack,
    rating: a.rating ?? null, rating_note: a.rating_note ?? null,
    runnable: runnable(a),
    layout: a.layout ?? null,
    panel_title: a.panel_title ?? null,
    /** explicit Build & Test / Production contract, derived from this app's own inputs */
    renderProfile: renderProfileCapability(a),
    higgsfield_feature: a.higgsfield_feature ?? null,
    modes: a.modes ?? null,
    mode_label: a.mode_label ?? null,
    inputs: a.inputs.map(({ bind: _bind, options, ...rest }) => ({
      ...rest, ...(options ? { options: options.map(({ sets: _sets, ...o }) => o) } : {}),
    })),
    presets: (a.presets ?? []).map((p) => ({ id: p.id, label: p.label })),
    outputs: a.outputs.map((o) => ({ type: o.type, label: o.label ?? null })),
    models: a.models.map((m) => ({
      name: m.file.split("/").pop(), repo: m.repo, gb: m.gb, license: m.license ?? null,
      gated: Boolean(m.gated), optional: Boolean(m.optional), local: Boolean(m.local), phase: m.phase,
    })),
    vram: vram.has(a.id) ? {
      whole_gb: vram.get(a.id)!.whole_gb, largest_phase_gb: vram.get(a.id)!.largest_phase_gb,
      verdict: vram.get(a.id)!.verdict_24gb, measured_gb: vram.get(a.id)!.measured_peak_gb,
    } : null,
    credits: a.credits ?? [],
    notes: a.notes ?? null,
    source: a.source ?? null,
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** A file from disk, honouring Range so <video> can seek. */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache = "no-cache") {
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes", "cache-control": cache });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": cache });
  if (req.method === "HEAD") return res.end();
  return createReadStream(file).pipe(res);
}

async function toRequest(req: IncomingMessage,limitMb=maxUploadMb): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).byteLength;
    if (limitMb && size > limitMb * 2 ** 20) throw new InputError(`uploads are limited to ${limitMb} MB here`);
    chunks.push(c as Buffer);
  }
  return new Request(`http://local${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

async function readValues(app: App, request: Request): Promise<{ values: Values; preset?: string; requestKey?:string }> {
  const form = await request.formData();
  const values: Values = {};
  for (const input of app.inputs) {
    const v = form.get(input.id);
    if (v === null) continue;
    if (isFileInput(input)) {
      if (typeof v === "string") throw new InputError(`${input.id}: expected a file upload`);
      values[input.id] = { bytes: new Uint8Array(await v.arrayBuffer()), name: v.name, type: v.type };
    } else {
      values[input.id] = v;
    }
  }
  const preset = form.get("preset");
  const key=form.get("request_id");if(key!==null&&(typeof key!=="string"||!key.length||key.length>200))throw new InputError("Invalid idempotency key");
  return { values, preset: typeof preset === "string" && preset ? preset : undefined,requestKey:typeof key==="string"?key:undefined };
}

async function jobView(id: string) {
  const job = await getRunner().jobs().get(id);
  return {
    id: job.id,
    status: job.status,
    error: job.error ?? null,
    outputs: job.outputs.map((o) => ({ id: o.id, node: o.nodeId, name: o.name, type: o.type, url: `/api/jobs/${job.id}/outputs/${o.id}` })),
  };
}

/**
 * Optional, context-aware Director preflight. It rewrites each Material Planner
 * segment in order, feeding the previous enhanced scenes into the next writer
 * call. The inline workflow enhancer is deliberately switched off afterwards so
 * the same prompt is not enhanced twice.
 */
async function enhanceDirectorValues(app: App, values: Values, runner: Runner, enhancer: App, only?: number, onProgress?: (done: number, total: number) => void): Promise<Values> {
  const next: Values = { ...values };
  type Target =
    | { kind: "windows"; spec: any; prompts: string[] }
    | { kind: "lines"; lines: string[]; prompts: string[] }
    | { kind: "prompt"; prompts: string[] }
    | { kind: "global"; prompts: string[] };
  let target: Target | null = null;
  let starts: number[] = [];
  if (typeof next.segment_windows === "string" && next.segment_windows.trim()) {
    try {
      const spec = JSON.parse(next.segment_windows);
      if (Array.isArray(spec?.windows) && spec.windows.length) {
        target = { kind: "windows", spec, prompts: spec.windows.map((w: any) => String(w.prompt ?? "")) };
        starts = spec.windows.map((w: any) => Number(w.start) / 24);
      }
    } catch { /* let the normal validator explain bad JSON */ }
  }
  if (!target && typeof next.segment_prompts === "string" && next.segment_prompts.trim()) {
    const lines = next.segment_prompts.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length) target = { kind: "lines", lines, prompts: lines };
  }
  if (!target && typeof next.prompt === "string" && next.prompt.trim()) {
    target = { kind: "prompt", prompts: [next.prompt] };
  }
  if (!target) target = { kind: "global", prompts: [String(next.global_prompt ?? "")] };
  if (!target.prompts.some((p) => p.trim())) return next;

  const flexMode = String(next.flex_mode ?? "");
  const hasSegmentReferences = target.kind === "windows" && target.spec.windows.some((w: any) => Array.isArray(w.images) && w.images.length);
  const hasVisual = ["image1","image2","image3","image4","image5","image6","image7","image8","image9","video1","video2","video3"].some((id) => next[id] !== undefined);
  const mode = directorPromptMode({ flexMode, hasVisual, hasSegmentReferences, ltx: app.id.startsWith("ltx-") });
  // Use the ordered references attached to THIS segment. The prompt writer has nine
  // picture slots, matching the Director media bin. Fall back to the global pictures
  // only when the segment has no explicit image order.
  const mediaForSegment = (i: number): Record<string, unknown> => {
    const media: Record<string, unknown> = {};
    const w = target!.kind === "windows" ? target!.spec.windows[i] : null;
    const refs = Array.isArray(w?.images) ? w.images : [];
    if (refs.length) {
      refs.slice(0, 9).forEach((slot: unknown, j: number) => {
        const value = next[`image${Number(slot) + 1}`];
        if (value !== undefined) media[`image${j + 1}`] = value;
      });
    } else {
      for (let j = 1; j <= 9; j += 1) if (next[`image${j}`] !== undefined) media[`image${j}`] = next[`image${j}`];
    }
    for (let j = 1; j <= 3; j += 1) if (next[`video${j}`] !== undefined) media[`video${j}`] = next[`video${j}`];
    return media;
  };
  const MAX_CONTEXT_CHARS = 14000;
  const clipPrompt = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
  // Bounded recall: older prompts are trimmed, not semantically summarized yet.
  const contextFor = (list: string[]): string => {
    if (!list.length) return "";
    const recent = list.slice(-4);
    const earlier = list.slice(0, -4);
    const parts: string[] = [];
    if (earlier.length) parts.push(`Earlier scenes (compact; preserve continuity):\n${earlier.map((p, n) => `[Segment ${n + 1}] ${clipPrompt(p, 320)}`).join("\n")}`);
    if (recent.length) parts.push(`Recent scenes (full):\n${recent.map((p, n) => `[Segment ${list.length - recent.length + n + 1}] ${clipPrompt(p, 1800)}`).join("\n\n")}`);
    const text = parts.join("\n\n");
    return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n…` : text;
  };
  let productionMemory = "";
  const productionId = String(next.production_id ?? "").trim();
  if (productionId) {
    try {
      const sceneId = String(next.production_scene_id ?? "").trim();
      productionMemory = buildProductionContext(productions.snapshot(productionId), sceneId ? { sceneId } : {}).text;
    } catch (error) {
      throw new InputError(`Production memory: ${(error as Error).message}`);
    }
  }
  const model = String(next.enhancer_model || "qwen3.8_27b_w4a8.safetensors");
  const order = only === undefined ? target.prompts.map((_, i) => i) : [only];
  if (order.some((i) => !Number.isInteger(i) || i < 0 || i >= target.prompts.length)) {
    throw new InputError(`Prompt enhancer segment must be between 0 and ${target.prompts.length - 1}`);
  }
  const done: string[] = [];
  for (const i of order) {
    const draft = target.prompts[i].trim() || String(next.global_prompt ?? "").trim();
    if (!draft) continue;
    const start = starts[i] ?? 0;
    const end = target.kind === "windows" ? Number(target.spec.windows[i].end) / 24 : null;
    const timing = end !== null ? `Starts at ${start.toFixed(2)} s and lasts ${(end - start).toFixed(2)} s.` : "";
    // For Generate all, each new scene sees the scenes already rewritten in this run.
    // For one segment, it sees the earlier prompts already in the timeline.
    const previous = only === undefined ? done : target.prompts.slice(0, i).filter(Boolean);
    const suppliedContext = target.kind === "prompt" ? String(next.prompt_context ?? "").trim() : "";
    const supplied = contextFor(suppliedContext ? [suppliedContext] : []);
    const segmentRefs = target.kind === "windows" ? (target.spec.windows[i]?.images || []) : [];
    const refsHint = segmentRefs.length
      ? `The supplied pictures are this segment's ordered references: ${segmentRefs.map((slot: unknown, n: number) => `Picture ${n + 1} = <Picture ${Number(slot) + 1}>`).join(", ")}. Preserve their order and reference relationships.`
      : "";
    const context = previous.length
      ? `Previous scenes, in order (use them for continuity; do not repeat them):\n${contextFor(previous)}`
      : supplied
        ? `Previous scenes, in order (use them for continuity; do not repeat them):\n${supplied}`
        : "This is the first scene in the timeline; there is no previous scene.";
    const prompt = [
      `You are writing segment ${i + 1} of ${target.prompts.length} for ${app.name}.`,
      timing,
      productionMemory ? `Canonical production memory (approved facts; do not contradict them):\n${productionMemory}` : "",
      context,
      `Current draft for segment ${i + 1}:\n${draft}`,
      refsHint,
      `Rewrite only segment ${i + 1}. Keep the story continuous with the previous scenes, preserve every named subject and spoken line, and return only the production-ready prompt for this segment. Do not add a segment heading or commentary.`,
    ].filter(Boolean).join("\n\n");
    const text = await runner.generateText(enhancer, {
      ...mediaForSegment(i),
      prompt_mode: mode,
      model,
      prompt,
    });
    if (!text) throw new Error(`Prompt enhancer returned an empty segment ${i + 1}`);
    target.prompts[i] = text;
    done.push(text);
    onProgress?.(done.length, order.length);
  }

  if (target.kind === "windows") {
    target.prompts.forEach((prompt, i) => { target!.spec.windows[i].prompt = prompt; });
    next.segment_windows = JSON.stringify(target.spec);
  } else if (target.kind === "lines") {
    next.segment_prompts = target.prompts.join("\n");
  } else if (target.kind === "prompt") {
    next.prompt = target.prompts[0];
  } else {
    next.global_prompt = target.prompts[0];
  }
  return next;
}

/** Load the durable Director media into FileValues for a prompt-only enhancement request. */
function directorMediaValues(app: App, appId: string): Values {
  const out: Values = {};
  // Sequential Director keeps its media in browser-local state and has no DirectorStore slots.
  if (!app.inputs.some((input) => input.id === "segment_windows")) return out;
  for (const input of app.inputs) {
    if (!isFileInput(input)) continue;
    const file = directors.mediaPath(appId, input.id);
    if (!file) continue;
    out[input.id] = {
      bytes: new Uint8Array(readFileSync(file)),
      name: file.split("/").pop() || input.id,
      type: input.type === "image" ? "image/png" : input.type === "video" ? "video/mp4" : "audio/wav",
    };
  }
  return out;
}

/**
 * Start a prompt-only Qwen job without holding a browser request open for minutes.
 * The browser polls prompt-jobs/:id; the job itself has no deadline. No video renderer
 * is submitted. This is intentionally separate from the synchronous /prompts endpoint
 * retained for compatibility with scripts.
 */
function startPromptJob(app: App, rawValues: Record<string, unknown>, index: number | undefined, all: boolean): PromptJob {
  const id = randomUUID();
  const job: PromptJob = { id, appId: app.id, status: "running", progress: { done: 0, total: all ? 1 : 1 }, startedAt: new Date().toISOString() };
  promptJobs.set(id, job);
  // Keep the in-memory job table bounded without ever touching generation work.
  if (promptJobs.size > 64) {
    for (const [key, old] of promptJobs) if (old.status !== "running") { promptJobs.delete(key); break; }
  }
  const enhancer = byId.get(app.id.startsWith("ltx-") ? "ltx-prompt-generator" : "prompt-enhancer");
  const values: Values = { ...rawValues, ...directorMediaValues(app, app.id) };
  void (async () => {
    try {
      if (!enhancer) throw new Error("Prompt enhancer app is not installed");
      if (all) {
        let total = 1;
        if (typeof values.segment_windows === "string" && values.segment_windows.trim()) {
          try {
            const windows = (JSON.parse(values.segment_windows) as { windows?: unknown[] }).windows;
            if (Array.isArray(windows) && windows.length) total = windows.length;
          } catch { /* let the enhancer report the invalid timeline */ }
        } else if (typeof values.segment_prompts === "string") {
          total = Math.max(1, values.segment_prompts.split(/\r?\n/).filter((line) => line.trim()).length);
        }
        job.progress.total = total;
      }
      const enhanced = await enhanceDirectorValues(app, values, getRunner(), enhancer, index, (done, total) => {
        job.progress = { done, total: Math.max(1, total) };
      });
      for (const input of app.inputs) if (isFileInput(input)) delete enhanced[input.id];
      job.values = enhanced;
      job.status = "succeeded";
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.error = (error as Error).message || String(error);
      job.finishedAt = new Date().toISOString();
    }
  })();
  return job;
}

/** Index the outputs of a successful Production asset build. No canonical state changes. */
async function completeProductionBuild(entry: import("./history.ts").Entry) {
  const productionId = String(entry.values.production_id ?? "").trim();
  const buildId = String(entry.values.production_build_id ?? "").trim();
  if (!productionId || !buildId) return;
  try {
    const snapshot = productions.snapshot(productionId);
    const build = snapshot.assetBuilds?.[buildId];
    if (!build || build.status !== "pending") return;
    const assetIds: string[] = [];
    for (const [index, output] of entry.outputs.entries()) {
      if (!["image", "video", "audio"].includes(output.type)) continue;
      const path = history.file(entry.id, output.file, entry.owner);
      if (!path) continue;
      const assetId = `build-${buildId}-${index + 1}`;
      try {
        productions.indexAsset(productionId, {
          id: assetId, kind: output.type as "image" | "video" | "audio",
          label: `${build.label}${entry.outputs.length > 1 ? ` — ${output.name}` : ""}`,
          sourceRunId: entry.id, path, category: build.category, tags: [build.app],
        }, { kind: "system", id: "asset-build" }, `asset:build:index:${buildId}:${index + 1}`);
        assetIds.push(assetId);
      } catch (error) {
        console.error(`[asset-build] ${buildId} output ${output.file}: ${(error as Error).message}`);
      }
    }
    productions.completeAssetBuild(productionId, buildId, entry.id, assetIds, { kind: "system", id: "asset-build" });
  } catch (error) {
    console.error(`[asset-build] ${buildId}: ${(error as Error).message}`);
  }
}

/** Submit in the background; the entry tells the UI how it goes. */
function startRun(app: App, values: Values, preset?: string, requestKey?: string, owner?: string, meta?: {render?:Record<string,unknown>;lineage?:Record<string,unknown>}) {
  if(requestKey){const old=history.findRequest(requestKey, owner);if(old){if(old.app!==app.id)throw new InputError("Idempotency key belongs to another app");return history.view(old);}}
  const entry = history.start(app, values, preset, requestKey, owner, meta);
  const controller = new AbortController();
  runControllers.set(entry.id, controller);
  void (async () => {
    try {
      await inference.run(app.name, async () => {
        await native.unload();
        let runValues = values;
        const enhancer = byId.get(app.id.startsWith("ltx-") ? "ltx-prompt-generator" : "prompt-enhancer");
        if (enhancer && app.inputs.some((input) => input.id === "prompt_enhancer") && values.prompt_enhancer === true) {
          runValues = await enhanceDirectorValues(app, values, getRunner(), enhancer);
          history.updateValues(entry, runValues);
        }
        // The preflight already rewrote the prompts; keep the inline branch off.
        const job = await getRunner().submit(app, { ...runValues, prompt_enhancer: false }, preset);
        const following = history.follow(entry, job);
        if(controller.signal.aborted) await history.cancel(entry.id);
        contact();
        await following;
        const done=history.get(entry.id);
        if(done?.status==="succeeded") await completeProductionBuild(done);
        if(done?.status==="failed")throw new Error(done.error?.message||"Workflow failed");
      },controller.signal,position=>history.setQueue(entry.id,position));
    } catch (e) {
      const explained = explainSubmitError(app, e);
      const message = explained ?? (e as Error).message ?? String(e);
      console.error(`[${app.id}] ${message}`);
      if(history.get(entry.id)?.status!=="failed")history.fail(entry, message, controller.signal.aborted?"canceled":"failed");
    } finally { runControllers.delete(entry.id); }
  })();
  return history.view(entry);
}

const DONE = ["succeeded", "failed", "canceled", "expired", "lost"];
// runs accepted whose upload is still being read count too, so two requests at once cannot both pass MAX_ACTIVE
let admitting = 0;
const activeRuns = () => history.list(undefined, 50).filter((e) => !DONE.includes(e.status)).length + admitting;

let gpuCache: { at: number; body: unknown } | null = null;
async function gpuStatus(withDevice = false) {
  const configured = Boolean(process.env.COMFY_BASE_URL);
  const host = configured ? (guard.hosted ? "Modal" : new URL(process.env.COMFY_BASE_URL!).host) : null;
  const warm = Date.now() - lastContact < WARM_MS;
  const running = activeRuns();
  const base = { configured, host, warm, last_contact: lastContact ? new Date(lastContact).toISOString() : null,
    waking: waking ? { seconds: Math.round((Date.now() - waking.since) / 1000), error: waking.error ?? null } : null,
    running, demo: guard.hosted ? guard.status(running) : null };
  // only on request and only while warm: looking never starts a GPU, and the background poll never touches it
  if (!withDevice || !warm || !configured) return { ...base, device: null };
  if (gpuCache && Date.now() - gpuCache.at < 5000) return { ...base, device: gpuCache.body };
  let device: unknown = null;
  try {
    const r = getRunner();
    const res = await fetch(`${r.baseUrl}/riverfield/status`, {
      headers: r.token ? { authorization: `Bearer ${r.token}` } : {}, signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const s = (await res.json()) as { app?: string; comfyui?: { devices?: { name?: string; vram_total?: number; vram_free?: number }[] } };
      const d = s.comfyui?.devices?.[0];
      device = { app: s.app ?? null, name: d?.name ?? null,
        vram_total_gb: d?.vram_total ? +(d.vram_total / 2 ** 30).toFixed(1) : null,
        vram_used_gb: d?.vram_total && d.vram_free !== undefined ? +((d.vram_total - d.vram_free) / 2 ** 30).toFixed(1) : null };
    }
  } catch { /* status is best effort */ }
  gpuCache = { at: Date.now(), body: device };
  return { ...base, device };
}

function wake() {
  if (waking && !waking.error) return;
  const r = getRunner();   // throws without COMFY_BASE_URL: the caller answers 400
  waking = { since: Date.now() };
  const started = waking;
  fetch(`${r.baseUrl}/health`, { signal: AbortSignal.timeout(15 * 60 * 1000) })
    .then((res) => {
      if (!res.ok) throw new Error(`/health answered ${res.status}`);
      contact();
      if (waking === started) waking = null;
    })
    .catch((e) => { if (waking === started) waking = { ...started, error: (e as Error).message }; });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://local");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const refusedOrigin = foreign(req, origins);
    if (refusedOrigin) return send(res, 403, { error: refusedOrigin });
    if (guard.passcode) {
      const key = url.searchParams.get("key");
      const cookie = key !== null ? guard.login(key, !plainHttpToIp(req)) : null;
      if (cookie) {   // the passcode leaves the address bar and lives on as a cookie
        url.searchParams.delete("key");
        res.writeHead(303, { "set-cookie": cookie, location: url.pathname + url.search, "cache-control": "no-store" });
        return res.end();
      }
      if (!guard.admits(req.headers.cookie)) {
        if (parts[0] === "api") return send(res, 401, { error: "this demo needs its passcode: open the link you were given" });
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(DOOR_HTML);
      }
    }
    const visitor = guard.visitor(req.headers.cookie, !plainHttpToIp(req));   // hosted: this browser's id; locally undefined (no filter)
    if (visitor.setCookie) res.setHeader("set-cookie", visitor.setCookie);
    const me = visitor.id;
    if(parts[0]==="mcp"){
      localAccess(req);if(guard.hosted)return send(res,403,{error:"Embedded studio MCP is disabled on hosted demos"});
      const mcp=studioMcpServer(studioURL),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.on("close",()=>{void transport.close();void mcp.close();});await mcp.connect(transport);await transport.handleRequest(req,res);return;
    }
    if (parts[0] === "api") {
      const [, area, id, sub, arg] = parts;
      if (area === "productions") {
        // Production Engine is a local, human-controlled boundary. No approval endpoint is
        // exposed here: canonical decisions are made by the interactive production CLI.
        localAccess(req);
        const actor: Actor = { kind: "agent", id: String(req.headers["x-riverfield-actor"] || "api") };
        const jsonBody = async (limit = 32): Promise<Record<string, unknown>> => {
          const body = await (await toRequest(req, limit)).json().catch(() => null);
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Expected a JSON object");
          return body as Record<string, unknown>;
        };
        if (req.method === "GET" && !id) return send(res, 200, { productions: productions.list() });
        if (req.method === "POST" && !id) {
          const body = await jsonBody();
          return send(res, 201, productions.createProduction({
            ...(typeof body.id === "string" ? { id: body.id } : {}),
            title: String(body.title ?? ""), logline: typeof body.logline === "string" ? body.logline : undefined,
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.style === "string" ? { style: body.style } : {}),
            status: body.status === "active" || body.status === "archived" || body.status === "draft" ? body.status : undefined,
          }, actor, typeof body.commandKey === "string" ? body.commandKey : undefined));
        }
        if (id && req.method === "GET" && !sub) return send(res, 200, productions.snapshot(id));
        if (id && req.method === "GET" && sub === "events") return send(res, 200, { events: productions.events(id) });
        if (id && req.method === "GET" && sub === "media") {
          const candidateId = url.searchParams.get("candidateId");
          const assetId = url.searchParams.get("assetId");
          const snap = productions.snapshot(id);
          let path: string | undefined;
          if (candidateId) {
            const candidate = snap.candidates[candidateId];
            const index = Number(url.searchParams.get("index") || 0);
            path = candidate?.outputs[index]?.path;
          } else if (assetId) path = snap.assets[assetId]?.path;
          if (!path) return send(res, 404, { error: "not found" });
          try {
            return sendFile(req, res, resolveMediaPath(path, productionMediaRoots(outDir)), "private, max-age=31536000, immutable");
          } catch {
            return send(res, 404, { error: "media unavailable" });
          }
        }
        if (id && req.method === "GET" && sub === "context") {
          const numbers = (name: string) => (url.searchParams.get(name) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
          const context = buildProductionContext(productions.snapshot(id), {
            ...(url.searchParams.get("sceneId") ? { sceneId: url.searchParams.get("sceneId")! } : {}),
            characterIds: numbers("characterIds"), locationIds: numbers("locationIds"), threadIds: numbers("threadIds"),
            recentScenes: url.searchParams.get("recentScenes") ? Number(url.searchParams.get("recentScenes")) : undefined,
            maxChars: url.searchParams.get("maxChars") ? Number(url.searchParams.get("maxChars")) : undefined,
          });
          return send(res, 200, context);
        }
        if (id && req.method === "POST" && sub === "seasons") return send(res, 201, productions.createSeason(id, await jsonBody() as CreateSeasonInput, actor));
        if (id && req.method === "POST" && sub === "episodes") return send(res, 201, productions.createEpisode(id, await jsonBody() as CreateEpisodeInput, actor));
        if (id && req.method === "POST" && sub === "scenes") return send(res, 201, productions.createScene(id, await jsonBody() as CreateSceneInput, actor));
        if (id && req.method === "GET" && sub === "scenes" && arg && parts[5] === "observations") {
          localAccess(req);
          const snap = productions.snapshot(id);
          if (!snap.scenes.some((scene) => scene.id === arg)) return send(res, 404, { error: "unknown scene" });
          return send(res, 200, { observations: Object.values(snap.observations).filter((observation) => observation.sceneId === arg).sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0) || a.createdAt.localeCompare(b.createdAt)) });
        }
        if (id && req.method === "PATCH" && sub === "scenes" && arg) return send(res, 200, productions.updateScene(id, arg, await jsonBody() as { title?: string; summary?: string; characterIds?: string[]; locationIds?: string[]; number?: number }, actor));
        if (id && req.method === "DELETE" && sub === "scenes" && arg) return send(res, 200, productions.removeScene(id, arg, actor));
        if (id && req.method === "POST" && sub === "observation-jobs") {
          localAccess(req);
          const body = await jsonBody();
          if (typeof body.sceneId !== "string" || typeof body.candidateId !== "string") throw new InputError("sceneId and candidateId are required");
          const job = observations().start(id, {
            sceneId: body.sceneId, candidateId: body.candidateId,
            ...(Array.isArray(body.bindingIds) ? { bindingIds: body.bindingIds.map(String) } : {}),
            ...(body.options && typeof body.options === "object" && !Array.isArray(body.options) ? { options: body.options as Record<string, never> } : {}),
            ...(typeof body.profile === "string" ? { profile: body.profile as StartObservationInput["profile"] } : {}),
            ...(typeof body.sourceObservationId === "string" ? { sourceObservationId: body.sourceObservationId } : {}),
            ...(Array.isArray(body.referenceAssetIds) ? { referenceAssetIds: body.referenceAssetIds.map(String) } : {}),
            ...(typeof body.requestKey === "string" ? { requestKey: body.requestKey } : {}),
          }, actor);
          return send(res, 202, job);
        }
        if (id && req.method === "GET" && sub === "continuity-reviews" && !arg) {
          const snap = productions.snapshot(id);
          return send(res, 200, { reviews: Object.values(snap.continuityReviews ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
        }
        if (id && req.method === "GET" && sub === "continuity-reviews" && arg) {
          const snap = productions.snapshot(id);
          const review = snap.continuityReviews?.[arg];
          return review ? send(res, 200, review) : send(res, 404, { error: "unknown continuity review" });
        }
        if (id && req.method === "GET" && sub === "runs" && !arg) {
          const snap = productions.snapshot(id);
          return send(res, 200, { runs: Object.values(snap.productionRuns ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
        }
        if (id && req.method === "GET" && sub === "runs" && arg) {
          const snap = productions.snapshot(id);
          const run = snap.productionRuns?.[arg];
          return run ? send(res, 200, run) : send(res, 404, { error: "unknown production run" });
        }
        if (id && req.method === "POST" && sub === "runs" && arg === "plan") {
          const body = await jsonBody();
          const plan = planProductionRun(productions.snapshot(id), {
            brief: String(body.brief ?? ""), ...(body.sceneCount !== undefined ? { sceneCount: Number(body.sceneCount) } : {}),
            ...(body.profile === "build" || body.profile === "production" ? { profile: body.profile } : {}),
            ...(typeof body.episodeId === "string" ? { episodeId: body.episodeId } : {}), ...(typeof body.seasonId === "string" ? { seasonId: body.seasonId } : {}),
            ...(typeof body.selectedApp === "string" ? { selectedApp: body.selectedApp } : {}), ...(Array.isArray(body.sceneIds) ? { sceneIds: body.sceneIds.map(String) } : {}),
          });
          return send(res, 200, { plan, note: "Editable plan only; no scenes, candidates or inference were created." });
        }
        if (id && req.method === "POST" && sub === "runs" && !arg) {
          const body = await jsonBody();
          const plan = body.plan && typeof body.plan === "object" ? body.plan as ReturnType<typeof planProductionRun> : planProductionRun(productions.snapshot(id), {
            brief: String(body.brief ?? ""), ...(body.sceneCount !== undefined ? { sceneCount: Number(body.sceneCount) } : {}),
            ...(body.profile === "build" || body.profile === "production" ? { profile: body.profile } : {}),
            ...(typeof body.episodeId === "string" ? { episodeId: body.episodeId } : {}), ...(typeof body.seasonId === "string" ? { seasonId: body.seasonId } : {}),
          });
          const runId = typeof body.runId === "string" ? body.runId : undefined;
          const created = productions.createProductionRun(id, {
            ...(runId ? { id: runId } : {}), title: String(body.title ?? "Production run"), brief: plan.brief, profile: plan.profile,
            ...(plan.seasonId ? { seasonId: plan.seasonId } : {}), ...(plan.episodeId ? { episodeId: plan.episodeId } : {}),
            scenePlan: plan.scenes, selectedApplications: plan.selectedApplications, referenceAssets: plan.referenceAssets,
            renderConfig: plan.renderConfig, ...(body.budget && typeof body.budget === "object" ? { budget: body.budget } : {}),
          }, actor, typeof body.commandKey === "string" ? body.commandKey : undefined);
          return send(res, 201, { run: created.productionRuns[runId ?? Object.keys(created.productionRuns).at(-1)!], plan });
        }
        if (id && req.method === "POST" && sub === "runs" && arg) {
          const snap = productions.snapshot(id);
          const runId = arg;
          const action = parts[5];
          const engine = new ProductionRunEngine(productions);
          const body = await jsonBody();
          if (!snap.productionRuns?.[runId]) throw new InputError("unknown production run");
          if (action === "start") return send(res, 202, await engine.start(id, runId));
          if (action === "resume") return send(res, 202, await engine.resume(id, runId));
          if (action === "pause") return send(res, 200, await engine.pause(id, runId));
          if (action === "cancel") return send(res, 200, await engine.cancel(id, runId));
          if (action === "decide") {
            if (typeof body.sceneId !== "string" || !["approved", "rejected", "replace", "reuse"].includes(String(body.decision))) throw new InputError("sceneId and decision are required");
            return send(res, 200, await engine.decide(id, runId, body.sceneId, body.decision as "approved" | "rejected" | "replace" | "reuse", typeof body.note === "string" ? body.note : ""));
          }
          throw new InputError("unknown production run action");
        }
        if (id && req.method === "POST" && sub === "continuity-reviews" && arg === "run-senior") {
          const body = await jsonBody();
          if (body.confirm !== true) throw new InputError("confirm:true is required for the single authorized senior inference pass");
          if (typeof body.preparedReviewId !== "string") throw new InputError("preparedReviewId is required");
          if (typeof body.baselineReviewId !== "string") throw new InputError("baselineReviewId is required; no baseline fallback is permitted");
          let result;
          try {
            result = await runSeniorContinuityReview({
              store: productions, runner: getRunner(), outDir, productionId: id,
              preparedReviewId: body.preparedReviewId, baselineReviewId: body.baselineReviewId,
              ...(typeof body.maxImages === "number" ? { maxImages: body.maxImages } : {}),
              ...(Array.isArray(body.humanAuditFindings) ? { humanAuditFindings: body.humanAuditFindings } : {}),
              actor: { kind: "agent", id: "senior-continuity-review" },
            });
          } catch (error) {
            if ((error as Error).message.startsWith("SENIOR_")) throw new InputError((error as Error).message);
            throw error;
          }
          return send(res, 201, result);
        }
        if (id && req.method === "POST" && sub === "continuity-reviews") {
          const body = await jsonBody();
          if (!Array.isArray(body.sceneIds) || !Array.isArray(body.observations) || !body.reviewer || typeof body.reviewer !== "object") {
            throw new InputError("sceneIds, observations and reviewer are required");
          }
          return send(res, 201, productions.recordContinuityReview(id, {
            ...(typeof body.id === "string" ? { id: body.id } : {}),
            ...(typeof body.seasonId === "string" ? { seasonId: body.seasonId } : {}),
            ...(typeof body.episodeId === "string" ? { episodeId: body.episodeId } : {}),
            sceneIds: body.sceneIds.map(String),
            ...(Array.isArray(body.bindingIds) ? { bindingIds: body.bindingIds.map(String) } : {}),
            ...(Array.isArray(body.candidateIds) ? { candidateIds: body.candidateIds.map(String) } : {}),
            observations: body.observations as never,
            reviewer: body.reviewer as never,
            ...(Array.isArray(body.evidenceReferences) ? { evidenceReferences: body.evidenceReferences.map(String) } : {}),
            ...(typeof body.status === "string" ? { status: body.status as never } : {}),
            ...(Array.isArray(body.findings) ? { findings: body.findings } : {}),
            ...(Array.isArray(body.stateRecords) ? { stateRecords: body.stateRecords } : {}),
            ...(Array.isArray(body.correctionPlans) ? { correctionPlans: body.correctionPlans } : {}),
            ...(Array.isArray(body.limitations) ? { limitations: body.limitations.map(String) } : {}),
            ...(body.execution && typeof body.execution === "object" ? { execution: body.execution as Record<string, unknown> } : {}),
          }, actor, typeof body.commandKey === "string" ? body.commandKey : undefined));
        }
        if (id && req.method === "POST" && sub === "binding-corrections") {
          const body = await jsonBody();
          if (typeof body.candidateId !== "string" || typeof body.originalBindingId !== "string" || typeof body.correctedSceneId !== "string" || typeof body.sourceHash !== "string") {
            throw new InputError("candidateId, originalBindingId, correctedSceneId and sourceHash are required");
          }
          return send(res, 201, productions.correctBinding(id, {
            candidateId: body.candidateId, originalBindingId: body.originalBindingId,
            correctedSceneId: body.correctedSceneId, sourceHash: body.sourceHash,
            reason: String(body.reason ?? "Human-authorized narrative binding correction"),
            ...(Array.isArray(body.sources) ? { sources: body.sources.map(String) } : {}),
          }, { kind: "human", id: String(req.headers["x-riverfield-actor"] || "phase1.3-authorized") }, "binding:correct:" + body.candidateId + ":" + body.originalBindingId));
        }
        if (id && req.method === "GET" && sub === "observation-jobs") {
          localAccess(req);
          return send(res, 200, { jobs: observations().list(id, url.searchParams.get("sceneId") || undefined) });
        }
        if (id && req.method === "POST" && sub === "observations" && arg && parts[5] === "propose") {
          localAccess(req);
          return send(res, 201, observations().proposeChanges(id, arg, actor, "Proposed from an evidence-backed observation"));
        }
        if (id && req.method === "POST" && sub === "observations") return send(res, 201, productions.recordObservation(id, await jsonBody() as RegisterObservationInput, actor));
        if (id && req.method === "POST" && sub === "asset-builds") return send(res, 201, productions.createAssetBuild(id, await jsonBody() as CreateAssetBuildInput, actor));
        if (id && req.method === "POST" && sub === "assets") {
          const body = await jsonBody();
          let input = body as unknown as IndexAssetInput;
          if (typeof body.runId === "string") {
            const run = history.get(body.runId, me);
            if (!run || run.status !== "succeeded") throw new InputError("Only a succeeded history run can provide an asset");
            const index = Number.isInteger(body.outputIndex) ? Number(body.outputIndex) : 0;
            const output = run.outputs[index];
            if (!output) throw new InputError(`History output ${index} is missing`);
            const path = history.file(run.id, output.file, me);
            if (!path) throw new InputError("History output file is missing");
            if (!["image", "video", "audio"].includes(output.type)) throw new InputError("That output is not a production asset");
            input = {
              id: typeof body.id === "string" ? body.id : `asset-${run.id}-${index + 1}`,
              kind: output.type as "image" | "video" | "audio",
              label: typeof body.label === "string" ? body.label : output.name || output.file,
              sourceRunId: run.id, path,
              ...(typeof body.category === "string" ? { category: body.category } : {}),
              ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
            };
          }
          return send(res, 201, productions.indexAsset(id, input, actor, typeof body.runId === "string" ? `asset:history:${body.runId}:${Number.isInteger(body.outputIndex) ? body.outputIndex : 0}` : undefined));
        }
        if (id && req.method === "PATCH" && sub === "assets" && arg) return send(res, 200, productions.updateAsset(id, arg, await jsonBody() as { label?: string; tags?: string[]; category?: string }, actor));
        if (id && req.method === "DELETE" && sub === "assets" && arg) return send(res, 200, productions.removeAsset(id, arg, actor));
        if (id && req.method === "POST" && sub === "proposals") return send(res, 201, productions.propose(id, await jsonBody() as ProposeCanonInput, actor));
        if (id && req.method === "POST" && sub === "candidates") {
          const body = await jsonBody();
          let input = body as unknown as RegisterCandidateInput;
          if (typeof body.runId === "string") {
            const run = history.get(body.runId, me);
            if (!run) throw new InputError(`Unknown history run ${body.runId}`);
            if (run.status !== "succeeded") throw new InputError("Only a succeeded history run can become a candidate");
            // History is authoritative. Caller-supplied outputs, prompts and render settings
            // are ignored so a request cannot replace a real run with an arbitrary file.
            const windows = (() => {
              const raw = run.values.segment_windows;
              if (typeof raw !== "string") return [] as { start?: number; end?: number; prompt?: string; images?: number[]; audios?: number[] }[];
              try { return ((JSON.parse(raw) as { windows?: { start?: number; end?: number; prompt?: string; images?: number[]; audios?: number[] }[] }).windows ?? []); } catch { return []; }
            })();
            const outputs = run.outputs.map((output) => {
              const path = history.file(run.id, output.file, me);
              if (!path) throw new InputError(`History output ${output.file} is missing`);
              const hash = hashFile(path);
              const probe = output.type === "video" ? probeMedia(path) : null;
              return {
                type: output.type as "video" | "image" | "audio" | "text" | "file", file: output.file, name: output.name, path, hash,
                ...(probe?.fps ? { fps: probe.fps } : {}), ...(probe?.frameCount ? { frameCount: probe.frameCount } : {}),
                ...(probe?.duration ? { duration: probe.duration } : {}), ...(probe ? { verified: probe.verified } : {}),
              };
            });
            const videoProbe = outputs.find((output) => output.type === "video");
            input = {
              ...input,
              label: String(input.label ?? run.values.filename_prefix ?? run.id),
              source: "history", sourceRunId: run.id, app: run.app,
              prompt: windows[0]?.prompt ?? String(run.values.global_prompt ?? ""),
              outputs,
              render: run.render,
              provenance: {
                brief: String(run.values.global_prompt ?? ""),
                segments: windows.map((window, index) => ({
                  index, prompt: String(window.prompt ?? ""), images: window.images ?? [], audios: window.audios ?? [],
                  ...(window.start !== undefined ? { startFrame: Number(window.start) } : {}), ...(window.end !== undefined ? { endFrame: Number(window.end) } : {}),
                })),
                render: run.render,
                ...(videoProbe ? { output: { ...(videoProbe.fps ? { fps: videoProbe.fps } : {}), ...(videoProbe.frameCount ? { frameCount: videoProbe.frameCount } : {}), ...(videoProbe.duration ? { duration: videoProbe.duration } : {}), verified: Boolean(videoProbe.verified) } } : {}),
                timebase: "final-output" as const,
                overlaps: windows.slice(1).map((window, index) => Math.max(0, Number(windows[index]?.end ?? 0) - Number(window.start ?? 0))),
              },
            };
          }
          return send(res, 201, productions.registerCandidate(id, input, actor));
        }
        return send(res, 404, { error: "not found" });
      }
      if (area === "directors") {
        // Local-only: Director projects contain private media, and hosted demos are per-visitor.
        if (guard.hosted) return send(res, 404, { error: "Director projects are local-only" });
        const app = id ? byId.get(id) : undefined;
        // Sequential Director projects are browser-local; the prompt-only endpoint still
        // accepts them when they expose the Qwen enhancer, without requiring segment_windows.
        const directorProject = Boolean(app?.inputs.some((i) => i.id === "segment_windows"));
        const promptTool = Boolean(app?.inputs.some((i) => i.id === "prompt_enhancer"));
        if (!app || (!directorProject && !promptTool)) return send(res, 404, { error: "unknown Director app" });
        if (req.method === "GET" && !sub) return send(res, 200, directors.view(id!));
        if (req.method === "POST" && sub === "prompts" && arg === "jobs") {
          if (!app.inputs.some((input) => input.id === "prompt_enhancer")) throw new InputError("This Director has no prompt enhancer");
          const raw = await (await toRequest(req, 24)).json() as { values?: unknown; index?: unknown; all?: unknown };
          if (!raw || typeof raw.values !== "object" || raw.values === null || Array.isArray(raw.values)) throw new InputError("Expected values");
          const index = Number.isInteger(raw.index) ? Number(raw.index) : undefined;
          if (raw.all !== true && index === undefined) throw new InputError("Pass index for one segment or all:true for the whole timeline");
          try {
            await getRunner().ping();
          } catch (error) {
            return send(res, 503, { error: (error as Error).message, code: "BACKEND_UNAVAILABLE" });
          }
          return send(res, 202, startPromptJob(app, raw.values as Record<string, unknown>, index, raw.all === true));
        }
        if (req.method === "GET" && sub === "prompt-jobs" && arg) {
          const job = promptJobs.get(arg);
          if (!job || job.appId !== app.id) return send(res, 404, { error: "unknown prompt job" });
          return send(res, 200, job.status === "succeeded" ? { ...job, values: job.values } : job);
        }
        if (req.method === "POST" && sub === "prompts") {
          const enhancer = byId.get(app.id.startsWith("ltx-") ? "ltx-prompt-generator" : "prompt-enhancer");
          if (!enhancer) throw new InputError("Prompt enhancer app is not installed");
          if (!app.inputs.some((input) => input.id === "prompt_enhancer")) throw new InputError("This Director has no prompt enhancer");
          const raw = await (await toRequest(req, 24)).json() as { values?: unknown; index?: unknown; all?: unknown };
          if (!raw || typeof raw.values !== "object" || raw.values === null || Array.isArray(raw.values)) throw new InputError("Expected values");
          const values: Values = { ...(raw.values as Record<string, unknown>), ...directorMediaValues(app, id!) };
          const index = Number.isInteger(raw.index) ? Number(raw.index) : undefined;
          if (raw.all !== true && index === undefined) throw new InputError("Pass index for one segment or all:true for the whole timeline");
          const enhanced = await enhanceDirectorValues(app, values, getRunner(), enhancer, index);
          // Never send FileValues back to the browser.
          for (const input of app.inputs) if (isFileInput(input)) delete enhanced[input.id];
          return send(res, 200, { values: enhanced });
        }
        if (req.method === "PUT" && !sub) {
          const raw = await (await toRequest(req, 24)).json() as { values?: unknown; savedAt?: unknown };
          return send(res, 200, directors.saveValues(id!, raw?.values, raw?.savedAt));
        }
        if (sub === "media" && arg) {
          if (req.method === "GET" || req.method === "HEAD") {
            const file = directors.mediaPath(id!, arg);
            if (!file) return send(res, 404, { error: "no such Director media" });
            return sendFile(req, res, file, "private, no-cache");
          }
          if (req.method === "POST") {
            const form = await (await toRequest(req, 512)).formData();
            const f = form.get("file");
            if (!f || typeof f === "string") throw new InputError("Upload a file");
            return send(res, 200, directors.putMedia(id!, arg, new Uint8Array(await f.arrayBuffer()), f.name, f.type));
          }
          if (req.method === "DELETE") return send(res, 200, directors.deleteMedia(id!, arg));
        }
        return send(res, 404, { error: "Unknown Director route" });
      }
      if(area==="agent"){
        localAccess(req);if(guard.hosted)return send(res,403,{error:"Agent provider settings are disabled on public hosted demos"});
        const body=async()=>await (await toRequest(req,22)).json();
        if(id==="runtime"){
          if(req.method==="GET"&&!sub)return send(res,200,native.catalogue());
          if(req.method==="GET"&&sub==="binaries")return send(res,200,{binaries:native.binaries()});
          if(req.method==="GET"&&sub==="library")return send(res,200,native.library(url.searchParams.get("refresh")==="1"));
          if(req.method==="GET"&&sub==="draft-settings")return send(res,200,native.draftSettings(url.searchParams.get("model")||""));
          if(req.method==="POST"&&sub==="scan"){const raw=await body() as any;if(typeof raw.directory!=="string")throw new InputError("Expected a local directory");return send(res,200,{files:native.scan(raw.directory)});}
          if(req.method==="POST"&&sub==="help"){const raw=await body() as any;if(typeof raw.executable!=="string")throw new InputError("Expected llama-server path");const help=await native.help(raw.executable);return send(res,200,{help,options:parseNativeHelp(help),speculativeTypes:speculativeTypes(help)});}
          if(req.method==="POST"&&sub==="inspect"){const raw=await body() as any;if(typeof raw.path!=="string")throw new InputError("Expected GGUF path");return send(res,200,native.inspect(raw.path));}
          if(req.method==="POST"&&sub==="profiles")return send(res,201,await native.save(await body()));
          if(req.method==="DELETE"&&sub==="profiles"&&arg){if(agent.providers.list().some(p=>p.runtimeProfile===arg))throw new InputError("Delete its managed provider connection first");native.remove(arg);return send(res,200,{removed:true});}
          if(req.method==="POST"&&sub==="unload"){const raw=await body().catch(()=>({})) as any,providerId=typeof raw?.provider==="string"?raw.provider:"";if(providerId&&!agent.providers.get(providerId).runtimeProfile)throw new InputError("Riverfield unloads only its integrated GGUF runtime; use the external engine's own unload control");await unloadNative();return send(res,200,native.status());}
          if(req.method==="POST"&&sub==="load"){const raw=await body() as any;const id=String(raw.profile||"");native.get(id);const controller=new AbortController();nativeLoads.add(controller);try{await inference.run("Load native agent",()=>prepareNative({runtimeProfile:id} as Provider,controller.signal),controller.signal);}finally{nativeLoads.delete(controller);}return send(res,200,native.status());}
        }
        if(id==="providers"){
          if(req.method==="GET"&&!sub)return send(res,200,{providers:agent.providers.list()});
          if(req.method==="POST"&&!sub){const raw=await body() as any;if(raw.runtimeProfile){const p=native.get(String(raw.runtimeProfile));Object.assign(raw,{location:"local",kind:"openai",baseURL:"http://127.0.0.1:1/v1",model:`riverfield-${p.id}`,contextTokens:native.provider(p.id).contextTokens});}return send(res,201,agent.providers.save(raw));}
          if(req.method==="GET"&&arg==="models"){const p=agent.providers.get(sub);return send(res,200,{models:p.runtimeProfile?[{id:`riverfield-${p.runtimeProfile}`,contextTokens:native.provider(p.runtimeProfile).contextTokens,outputTokens:null}]:await agent.providers.models(sub,url.searchParams.get("refresh")==="1")});}
          if(req.method==="GET"&&arg==="limits"){const p=agent.providers.get(sub);return send(res,200,p.runtimeProfile?{model:`riverfield-${p.runtimeProfile}`,contextTokens:native.provider(p.runtimeProfile).contextTokens,outputTokens:null,source:"managed GGUF profile"}:await agent.providers.limits(sub,url.searchParams.get("model")||p.model));}
          if(req.method==="DELETE"&&sub){agent.providers.remove(sub);return send(res,200,{removed:true});}
        }
        if(id==="discover"&&req.method==="GET")return send(res,200,{servers:await discoverModels()});
        if(id==="director-options"&&req.method==="GET"){const eight=planDirectorSegments({prompts:Array(8).fill("Timing only")});return send(res,200,{form:defaultDirectorForm(),durations:[...directorDurations(),{segments:8,label:`${eight.seconds.toFixed(2)} s (8 segments)`}]});}
        if(id==="tools"&&req.method==="GET"){const client=new StudioMcp(mcpURL);try{return send(res,200,{tools:[...(await client.tools()).filter(t=>!["project_state",askTool.name,"production_plan"].includes(t.name)),projectTool,askTool]});}finally{await client.close();}}
        if(id==="conversations"){
          if(!sub&&req.method==="GET")return send(res,200,{conversations:agent.list()});
          if(!sub&&req.method==="POST"){const raw=await body() as any;return send(res,201,agent.store.create(typeof raw.provider==="string"?raw.provider:"",typeof raw.model==="string"?raw.model:""));}
          if(sub&&!arg){if(req.method==="GET")return send(res,200,agent.get(sub));if(req.method==="PATCH"){
            const raw=await body() as any,lock=raw.project?.lock;
            if(lock?.app){const app=byId.get(lock.app);if(!app||app.section!==lock.section)throw new InputError("Project lock must name an app from the selected studio");for(const [key,value] of Object.entries(lock.values||{})){const input=app.inputs.find(i=>i.id===key);if(!input||isFileInput(input))throw new InputError(`Unknown/non-parameter locked input ${key}`);if(input.type==="select"&&!input.options?.some(o=>o.value===value))throw new InputError(`Locked ${key} is not a supported option`);}}
            else if(lock&&Object.keys(lock.values||{}).length)throw new InputError("Choose an app before locking its input values");
            const before=agent.store.get(sub),oldProvider=before.provider,oldModel=before.model,edited=agent.edit(sub,raw);
            const changed=(typeof raw.provider==="string"&&raw.provider!==oldProvider)||(typeof raw.model==="string"&&raw.model!==oldModel);
            const configs=agent.providers.list(),nextProvider=typeof raw.provider==="string"?raw.provider:oldProvider;
            const managedChange=!!(configs.find(p=>p.id===oldProvider)?.runtimeProfile||configs.find(p=>p.id===nextProvider)?.runtimeProfile);
            if(changed&&managedChange)await unloadNative("Unload previous agent model");
            return send(res,200,edited);
          }if(req.method==="DELETE"){await agent.remove(sub);return send(res,200,{removed:true});}}
          if(arg==="events"&&req.method==="GET"){
            const c=agent.get(sub);res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-store",connection:"keep-alive","x-accel-buffering":"no"});
            const event=(type:string,value:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);event("state",c);
            const off=agent.subscribe(sub,event),timer=setInterval(()=>res.write(": heartbeat\n\n"),15000);res.on("close",()=>{off();clearInterval(timer);});return;
          }
          if(arg==="production"&&req.method==="GET")return send(res,200,agent.productionView(sub,studioApps()));
          if(arg==="export"&&req.method==="GET"){
            const c=agent.store.get(sub),format=url.searchParams.get("format")||"markdown";
            if(!["markdown","json"].includes(format))throw new InputError("Choose Markdown or JSON export");
            const provider=agent.providers.list().find(p=>p.id===c.provider),out=exportConversation(c,provider,s=>agent.providers.redactText(s),url.searchParams.get("details")!=="0");
            const text=format==="json"?JSON.stringify(out.json,null,2):out.markdown;
            res.writeHead(200,{"content-type":format==="json"?"application/json; charset=utf-8":"text/markdown; charset=utf-8","content-disposition":`attachment; filename="riverfield-${c.id}.${format==="json"?"json":"md"}"`,"cache-control":"no-store"});return res.end(text);
          }
          if(arg==="files"&&parts[5]&&(req.method==="GET"||req.method==="HEAD")){const c=agent.store.get(sub);return sendFile(req,res,agent.store.file(c,parts[5]),"private, no-cache");}
          if(req.method==="POST"){
            if(arg==="director"){
              const raw=await body() as any;
              if(raw.action==="start")return send(res,200,agent.startDirector(sub));
              if(raw.action==="choose")return send(res,200,agent.chooseDirector(sub,String(raw.key),String(raw.value||""),String(raw.target||"")));
              if(raw.action==="say")return send(res,200,await agent.sayDirector(sub,String(raw.text||""),raw.attachments||[]));
              if(raw.action==="prepare")return send(res,200,await agent.prepareDirector(sub));
              if(raw.action==="references")return send(res,202,await agent.referenceDirector(sub));
              if(raw.action==="save")return send(res,200,agent.saveDirector(sub,raw.form));
              if(raw.action==="write")return send(res,200,await agent.writeDirector(sub,String(raw.field)));
              if(raw.action==="run")return send(res,202,await agent.runDirector(sub,String(raw.kind),Number(raw.index||0),String(raw.instruction||"")));
              throw new InputError("Unknown Director action");
            }
            if(arg==="messages")return send(res,202,agent.message(sub,await body()));
            if(arg==="answers")return send(res,202,await agent.answer(sub,await body()));
            if(arg==="production"){
              const raw=await body() as any;
              if(typeof raw.pilot==="string")return send(res,202,agent.approvePilot(sub,raw.pilot,studioApps()));
              if(raw.approve===true)return send(res,202,agent.approveProduction(sub,studioApps()));
              if(raw.plan!==undefined)return send(res,200,agent.saveProduction(sub,raw.plan,studioApps()));
              throw new InputError("Expected a plan, approve=true or a produced pilot artifact");
            }
            if(arg==="continue")return send(res,202,agent.resume(sub));
            if(arg==="stop")return send(res,200,await agent.stop(sub));
            if(arg==="jobs")return send(res,200,await agent.refreshJobs(sub));
            if(arg==="approve"){const raw=await body() as any;if(typeof raw.tool!=="string"||typeof raw.allow!=="boolean")throw new InputError("Expected tool ID and approval boolean");return send(res,202,agent.approve(sub,raw.tool,raw.allow));}
            if(arg==="upload"){
              const f=(await (await toRequest(req,22)).formData()).get("file");if(!f||typeof f==="string")throw new InputError("Upload a file");const c=agent.store.get(sub);if(c.status==="running")throw new InputError("Wait for the current turn before uploading");return send(res,201,agent.store.upload(c,new Uint8Array(await f.arrayBuffer()),f.name,f.type));
            }
            if(arg==="reuse"){const c=agent.store.get(sub),raw=await body() as any,a=[...c.artifacts,...c.attachments].find(a=>a.id===raw.artifact);if(!a)throw new InputError("Unknown artifact");if(c.status==="running")throw new InputError("Wait for current turn");if(raw.audio===true){const result=await media.run({operation:"audio",path:a.path}),output=result.outputs?.[0],current=agent.store.get(sub);if(!output)throw new InputError("No soundtrack was extracted");if(current.status==="running")throw new InputError("Wait for current turn before attaching the extracted soundtrack");return send(res,201,agent.store.upload(current,new Uint8Array(readFileSync(output.path)),`${a.name.replace(/\.[^.]+$/,"")}-soundtrack.wav`,"audio/wav"));}if(!c.attachments.some(x=>x.id===a.id))c.attachments.push(a);agent.store.save(c);return send(res,200,a);}
          }
        }
        return send(res,404,{error:"Unknown Agent route"});
      }
      if(req.method==="GET" && area==="inference")return send(res,200,inference.snapshot());
      if(req.method==="GET" && area==="asset-audit" && parts.length===2){
        const snap=productions.snapshot("suite-404");
        const assets=auditAssetCatalogue(snap);
        const correctionBatch=buildAssetCorrectionBatch(snap);
        return send(res,200,{productionId:"suite-404",assets,correctionBatch,summary:{total:assets.length,trusted:assets.filter(a=>a.trusted).length,requiresReview:assets.filter(a=>!a.trusted).length,independentlyVerified:assets.filter(a=>a.semanticStatus==="visually-verified").length,notIndependentlyVerified:assets.filter(a=>a.semanticStatus==="not-independently-verified").length,correctionBatchEntries:correctionBatch.entries.length,ambiguous:correctionBatch.ambiguous.length},p6ReferenceWarning:P6_REFERENCE_WARNING,note:"Semantic audit; corrections are proposals, original media and historical reports are unchanged."});
      }
      if (req.method === "GET" && area === "asset-corrections" && id === "decisions") {
        localAccess(req);
        return send(res, 200, { decisions: readAssetCorrectionDecisions(outDir), applications: readAssetCorrectionApplications(outDir) });
      }
      if (req.method === "POST" && area === "asset-corrections" && id === "decisions") {
        localAccess(req);
        const body = await (await toRequest(req, 32)).json().catch(() => null) as Record<string, unknown> | null;
        if (!body || typeof body.batchId !== "string" || !["approved", "rejected"].includes(String(body.decision))) throw new InputError("batchId and decision approved|rejected are required");
        const snap = productions.snapshot("suite-404");
        const batch = buildAssetCorrectionBatch(snap);
        if (body.batchId !== batch.id) throw new InputError("unknown asset correction batch");
        const decision = recordAssetCorrectionDecision(outDir, batch, body.decision as "approved" | "rejected", "human-ui", typeof body.note === "string" ? body.note : "", typeof body.assetId === "string" ? body.assetId : undefined);
        return send(res, 201, { decision, note: "A decision is not an application; asset metadata is not rewritten automatically." });
      }
      if (req.method === "POST" && area === "asset-corrections" && id === "apply") {
        localAccess(req);
        const body = await (await toRequest(req, 32)).json().catch(() => null) as Record<string, unknown> | null;
        if (!body || body.confirm !== true || typeof body.batchId !== "string" || !Array.isArray(body.assetIds)) throw new InputError("confirm:true, batchId and assetIds are required");
        const snap = productions.snapshot("suite-404");
        const batch = buildAssetCorrectionBatch(snap);
        if (body.batchId !== batch.id) throw new InputError("unknown asset correction batch");
        const application = applyAssetCorrections(outDir, batch, body.assetIds.map(String), (assetId, patch) => {
          const asset = snapshotAsset(productions.snapshot("suite-404"), assetId);
          if (!asset) throw new InputError(`unknown asset ${assetId}`);
          productions.updateAsset("suite-404", assetId, patch, { kind: "human", id: "asset-correction-application" }, `asset:apply:${batch.id}:${assetId}`);
        }, "human-ui", typeof body.note === "string" ? body.note : "");
        return send(res, 201, { application, note: "Only individually approved entries were applied; historical events and media hashes remain." });
      }
      if(req.method==="GET" && area==="observer-profiles" && parts.length===2)return send(res,200,{ profiles: OBSERVER_PROFILES, defaultProfile: "custom", note: "Profiles only supply defaults; explicit options and custom model selection remain available. Senior Review reuses an existing observation." });
      if(req.method==="GET" && area==="observer-models" && parts.length===2)return send(res,200,{
        models: discoverObserverModels(), defaultModelId: DEFAULT_OBSERVER_MODEL_ID,
        source: "local ComfyUI text_encoders safetensors headers; no weights downloaded",
        generatedAt: new Date().toISOString(),
      });
      if(area==="media"){
        localAccess(req);if(guard.hosted)throw new InputError("Local media tools are disabled on hosted demos");
        if(req.method==="POST"&&!id)return send(res,200,await media.run(await (await toRequest(req,1)).json()));
        if(req.method==="GET"&&sub==="files"&&arg)return sendFile(req,res,media.file(id,arg));
      }
      if (req.method === "GET" && area === "apps" && parts.length === 2) {
        // Newly added app folders are discoverable by every MCP client without an agent schema rewrite.
        for(const a of loadRegistry(root).apps)if(!byId.has(a.id)){apps.push(a);byId.set(a.id,a);}
        const order = { image: 0, video: 1, audio: 2, utility: 3 } as Record<string, number>;
        const sorted = [...apps].sort((a, b) => order[a.section] - order[b.section]
          || Number(b.status === "ready") - Number(a.status === "ready") || a.name.localeCompare(b.name));
        const examples = loadExamples();
        return send(res, 200, { apps: sorted.map((a) => ({ ...publicApp(a), example: examples[a.id] ?? null })), drafts: draftsAllowed,
          hosted: guard.hosted });
      }
      if (req.method === "GET" && area === "apps" && sub === "workflow") {
        // the app's ComfyUI workflow (API format) as a file: drag it onto ComfyUI's canvas to open the app as nodes
        const app = byId.get(id);
        if (!app?.workflowPath) return send(res, 404, { error: "no workflow" });
        const body = readFileSync(app.workflowPath);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": body.byteLength, "cache-control": "no-cache",
          "content-disposition": `attachment; filename="riverfield-${app.id}.json"` });
        return res.end(body);
      }
      if (req.method === "POST" && area === "apps" && sub === "run") {
        const app = byId.get(id);
        if (!app) return send(res, 404, { error: "unknown app" });
        if (!app.workflowPath) throw new InputError(`${app.id} has no workflow yet`);
        if (!runnable(app)) throw new InputError(`${app.id} is a draft; start the server with RIVERFIELD_DRAFTS=1 to run it anyway`);
        const refused = guard.refuse(activeRuns());
        if (refused) return send(res, 429, { error: refused });
        admitting++;
        let view;
        try {
          const { values, preset, requestKey } = await readValues(app, await toRequest(req));
          const resolved = resolveValues(app, values);
          try {
            await getRunner().ping();
          } catch (error) {
            return send(res, 503, { error: (error as Error).message, code: "BACKEND_UNAVAILABLE" });
          }
          view = startRun(app, resolved, preset, requestKey, me, { render: renderMetadataFor(app, resolved) ?? undefined });
        } finally {
          admitting--;
        }
        guard.record();
        return send(res, 202, view);
      }
      if (area === "sequences" && req.method === "POST" && id === "assemble") {
        const body = await (await toRequest(req)).json().catch(() => null) as { segments?: unknown } | null;
        const segments = Array.isArray(body?.segments) ? body.segments : [];
        if (!segments.length || segments.length > 512) throw new InputError("assemble needs 1 to 512 approved segments");
        const paths = segments.map((seg) => {
          const s = seg as { id?: unknown; file?: unknown };
          if (typeof s.id !== "string" || typeof s.file !== "string") throw new InputError("every segment needs a history id and a video file");
          const file = history.file(s.id, s.file, me);
          if (!file) throw new InputError(`segment ${s.id}: unknown video ${s.file}`);
          return file;
        });
        try {
          return send(res, 200, await media.concatMany(paths));
        } catch (e) {
          // Short chains can still be normalised by the bounded CPU editor if the fast copy
          // rejects mixed codecs; long chains must share the settings to be assembled.
          if (paths.length <= 8) return send(res, 200, await media.run({ operation: "concat", paths }));
          throw e;
        }
      }
      if (area === "history") {
        if (req.method === "GET" && !id) {const key=url.searchParams.get("request_id"),entry=key?history.findRequest(key, me):undefined;return send(res,200,{entries:key?(entry?[history.view(entry)]:[]):history.list(url.searchParams.get("app")||undefined, 300, me)});}
        if (req.method === "GET" && id && !sub) {
          const e = history.get(id, me);
          return e ? send(res, 200, e) : send(res, 404, { error: "unknown run" });
        }
        if (req.method === "POST" && id && sub === "production") {
          const preview = history.get(id, me);
          if (!preview) return send(res, 404, { error: "unknown run" });
          if (preview.status !== "succeeded" || !preview.outputs.some((o) => o.type === "video")) {
            throw new InputError("Only a succeeded video preview can be rendered in Production");
          }
          if (preview.render?.profile === "production") throw new InputError("This run is already a Production render");
          if (preview.values.seed === undefined || preview.values.seed === null || preview.values.seed === -1 || preview.values.seed === "-1") {
            throw new InputError("The preview has no resolved seed to preserve; render a new preview before promoting it");
          }
          const app = byId.get(preview.app);
          const capability = app ? renderProfileCapability(app) : null;
          if (!app || !capability) throw new InputError("This app has no Build & Test / Production profiles");
          const raw = (await (await toRequest(req, 24)).json().catch(() => ({}))) as Record<string, unknown> | null;
          if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) throw new InputError("Expected a production settings object");
          const requestKey = typeof raw?.request_id === "string" && raw.request_id.length && raw.request_id.length <= 200 ? raw.request_id : undefined;
          if (requestKey) {
            const old = history.findRequest(requestKey, me);
            if (old) {
              if (old.app !== app.id || old.lineage?.preview !== id) throw new InputError("This idempotency key belongs to another run");
              return send(res, 202, { ...history.view(old), preview: id });
            }
          }
          // The saved Director project owns the durable production preferences. An MCP
          // request may override them explicitly, but it never changes the creative payload.
          // Director projects are local-only, so a hosted demo always uses the preview payload.
          const saved = guard.hosted ? {} : directors.view(app.id)?.values ?? {};
          const choices = {
            production_megapixels: raw?.production_megapixels ?? saved.production_megapixels,
            production_upscale: raw?.production_upscale ?? saved.production_upscale,
            production_upscale_detail: raw?.production_upscale_detail ?? saved.production_upscale_detail,
          };
          const production = productionRequestFromPreview(app, preview.values as Values, choices);
          const values: Values = { ...production.values, prompt_enhancer: false };
          for (const input of preview.inputs) {
            const file = history.file(id, input.file, me);
            if (!file) throw new InputError(`The preview input ${input.id} is no longer on disk`);
            values[input.id] = { bytes: new Uint8Array(readFileSync(file)), name: input.name };
          }
          const resolved = resolveValues(app, values);
          const entry = startRun(app, resolved, preview.preset ?? undefined, requestKey, me, {
            render: renderMetadataFor(app, resolved) ?? undefined,
            lineage: {
              relation: "new_generation_from_preview",
              preview: id,
              note: "New Production generation from the preview's exact creative payload; not a pixel-identical reconstruction.",
            },
          });
          history.linkProduction(id, entry.id, me);
          return send(res, 202, { ...(history.get(entry.id, me) ?? entry), preview: id });
        }
        if ((req.method === "GET" || req.method === "HEAD") && sub === "files" && arg) {
          const file = history.file(id, arg, me);
          return file ? sendFile(req, res, file, "private, max-age=31536000, immutable") : send(res, 404, { error: "not found" });
        }
        if (req.method === "GET" && sub === "preview") {
          const p = history.preview(id, me);
          if (!p) return send(res, 404, { error: "no preview" });
          res.writeHead(200, { "content-type": p.type, "content-length": p.bytes.byteLength, "cache-control": "no-store" });
          return res.end(p.bytes);
        }
        if (req.method === "POST" && sub === "cancel") {
          const submitted = runControllers.has(id);
          runControllers.get(id)?.abort();
          return send(res, 200, { canceled: (await history.cancel(id, me)) || submitted });
        }
        if (req.method === "DELETE" && id && !sub) {
          runControllers.get(id)?.abort();
          return send(res, history.remove(id, me) ? 200 : 404, { removed: id });
        }
      }
      if (area === "observation-jobs") {
        localAccess(req);
        if (req.method === "GET" && !id) return send(res, 200, { jobs: observations().list() });
        if (req.method === "GET" && id && !sub) {
          const job = observations().get(id);
          return job ? send(res, 200, job) : send(res, 404, { error: "unknown observation job" });
        }
        if (req.method === "POST" && id && sub === "cancel") {
          const job = observations().cancel(id);
          return job ? send(res, 200, job) : send(res, 404, { error: "unknown observation job" });
        }
        if (req.method === "GET" && id && sub === "evidence") {
          const file = observations().evidenceFile(id, url.searchParams.get("file") || "");
          return file ? sendFile(req, res, file, "private, max-age=31536000, immutable") : send(res, 404, { error: "evidence not found" });
        }
      }
      if (area === "gpu") {
        if (req.method === "GET" && !id) return send(res, 200, await gpuStatus(url.searchParams.get("device") === "1"));
        if (req.method === "POST" && id === "wake") {
          try { wake(); } catch (e) { throw new InputError((e as Error).message); }
          return send(res, 202, await gpuStatus());
        }
      }
      if (area === "flags" && parts.length === 2) {
        if (req.method === "GET") return send(res, 200, { mediocre: flags.list() });
        if (req.method === "POST") {
          if (guard.hosted) return send(res, 403, { error: "lab marks are read-only on the hosted demo" });
          const body = await (await toRequest(req)).json().catch(() => null) as { key?: unknown; mediocre?: unknown; note?: unknown } | null;
          if (!body || typeof body.key !== "string" || typeof body.mediocre !== "boolean") throw new InputError("expected JSON { key, mediocre, note? }");
          try {
            return send(res, 200, { mediocre: flags.set(body.key, body.mediocre, typeof body.note === "string" ? body.note : undefined) });
          } catch (e) {
            throw new InputError((e as Error).message);
          }
        }
      }
      // the raw job view reaches any backend job by id, past the history's per-visitor view: local scripts only
      if (area === "jobs" && guard.hosted) return send(res, 404, { error: "not found" });
      if (req.method === "GET" && area === "jobs" && parts.length === 3) {
        return send(res, 200, await jobView(id));
      }
      if (req.method === "GET" && area === "jobs" && sub === "outputs" && arg) {
        const job = await getRunner().jobs().get(id);
        const out = job.outputs.find((o) => o.id === arg);
        if (!out) return send(res, 404, { error: "unknown output" });
        const bytes = await out.toBytes();
        res.writeHead(200, { "content-type": out.contentType || "application/octet-stream", "content-length": bytes.byteLength });
        return res.end(bytes);
      }
      return send(res, 404, { error: "not found" });
    }
    // static web/
    const webRoot = join(root, "web");
    const rel = normalize(url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1))).replace(/^(\.\.[/\\])+/, "");
    const file = join(webRoot, rel);
    if (file.startsWith(webRoot) && existsSync(file) && statSync(file).isFile()) return sendFile(req, res, file);
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof ProductionError) return send(res, 400, { error: e.message, code: e.code });
    if (e instanceof ObservationError) return send(res, 400, { error: e.message, code: e.code });
    if(e instanceof InputError){const body=inputErrorBody(e);if(req.url?.startsWith("/api/agent")){body.error=agent.providers.redact(e);body.issues=body.issues.map(i=>({...i,message:agent.providers.redactText(i.message)}));}return send(res,400,body);}
    const status = (e as NodeJS.ErrnoException).code === "ENOENT" ? 404 : e instanceof InputError || req.url?.startsWith("/api/agent") ? 400 : 500;
    if (status === 500) console.error(e);
    return send(res, status, { error: req.url?.startsWith("/api/agent")?agent.providers.redact(e):(e as Error).message });
  }
});

// runs that were still going when the server stopped are followed again
void inference.run("Recover existing backend jobs", () => history.resume(async (jobId) => getRunner().jobs().get(jobId))).catch(e=>console.error("[recovery]",e));

const port = Number(process.env.PORT ?? 3000);
server.listen(port, host, () => console.log(`riverfield on http://${host}:${port} (${apps.length} apps)`
  + (guard.passcode ? " · passcode required" : "") + (guard.maxRunsPerDay ? ` · ${guard.maxRunsPerDay} runs a day` : "")));

let closing=false;
async function shutdown(){if(closing)return;closing=true;server.close();for(const controller of nativeLoads)controller.abort();native.cancelLoading();try{await agent.close();}finally{await native.close();process.exit(0);}}
process.once("SIGTERM",()=>void shutdown());process.once("SIGINT",()=>void shutdown());
