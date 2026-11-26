// Non-destructive SUITE 404 importer. It reads history metadata and existing output
// files; it never moves, copies or rewrites them. Candidate output paths remain in
// place, and no canonical approval is inferred from a successful render.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ProductionError, ProductionStore, type RegisterCandidateInput } from "./production-store.ts";
import { categoryForPrompt } from "./asset-category.ts";
import type { Actor, CandidateOutput, SceneRenderBinding } from "./production-types.ts";

type HistoryMeta = {
  id: string;
  app: string;
  status: string;
  values?: Record<string, unknown>;
  outputs?: { file: string; type: string; name: string; node: string }[];
};
type Window = { start: number; end: number; prompt?: string };
type PlannedBinding = {
  scene: number;
  window: Window;
  segmentIndex: number;
};

export type Suite404ImportReport = {
  productionId: string;
  seasons: number;
  episodes: number;
  scenes: number;
  candidates: number;
  assets: number;
  skipped: string[];
  canonicalDecisionsCreated: 0;
};

const actor: Actor = { kind: "import", id: "suite404-import" };
const RUN_WINDOWS = /(?:V\d+(?:_\d+)?_)?SEG(?:MENT)?[_-]?(\d{1,2})/i;
const RUN_SHOTS = /SH[_-]?(\d{1,2})(?:[_-]SH[_-]?(\d{1,2}))?/i;
const RUN_NATIVE = /V\d+.*Native/i;
const RUN_PILOT = /Pilot/i;

const hashFile = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

function parseWindows(meta: HistoryMeta): Window[] {
  const raw = meta.values?.segment_windows;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const spec = JSON.parse(raw) as { windows?: Window[] };
    return Array.isArray(spec.windows) ? spec.windows : [];
  } catch { return []; }
}

function sceneNumbers(meta: HistoryMeta, windowCount: number): number[] {
  const prefix = clean(meta.values?.filename_prefix);
  const shotMatch = RUN_SHOTS.exec(prefix);
  if (shotMatch) {
    const first = Number(shotMatch[1]);
    const second = shotMatch[2] ? Number(shotMatch[2]) : undefined;
    return second !== undefined ? [first, second] : [first];
  }
  const segment = RUN_WINDOWS.exec(prefix);
  if (segment) return [Number(segment[1])];
  if (windowCount > 0 && (RUN_NATIVE.test(prefix) || RUN_PILOT.test(prefix))) {
    return Array.from({ length: windowCount }, (_, index) => index + 1);
  }
  return [];
}

function outputFile(outDir: string, meta: HistoryMeta): { file: string; path: string; name: string } | null {
  const output = (meta.outputs ?? []).find((item) => item.type === "video");
  if (!output) return null;
  const path = join(outDir, "history", meta.id, output.file);
  return existsSync(path) ? { file: output.file, path, name: String(output.name || output.file) } : null;
}

function candidatePrompt(meta: HistoryMeta): string {
  const windows = parseWindows(meta);
  return String(windows[0]?.prompt ?? meta.values?.global_prompt ?? "").trim();
}

function bindingsFor(meta: HistoryMeta, candidateId: string, scenes: number[], windows: Window[]): SceneRenderBinding[] {
  if (!windows.length || !scenes.length) return [];
  const outputHash = outputHashCache.get(meta.id);
  return windows.slice(0, scenes.length).map((window, index) => ({
    id: `${candidateId}-b${String(index + 1).padStart(3, "0")}`,
    sceneId: suiteSceneId(scenes[index]),
    candidateId,
    runId: meta.id,
    timebase: "final-output" as const,
    timelineStartFrame: Number(window.start),
    timelineEndFrame: Number(window.end),
    segmentIndex: index,
    sourceStartFrame: 0,
    sourceEndFrame: Math.max(0, Number(window.end) - Number(window.start)),
    ...(outputHash ? { outputHash } : {}),
    fps: 24,
  }));
}

const outputHashCache = new Map<string, string>();

const suiteSceneId = (number: number) => `suite-404-s01e01-sc${String(number).padStart(2, "0")}`;

function relevantSuites(meta: HistoryMeta): "passion" | "velvet" | null {
  const prefix = clean(meta.values?.filename_prefix);
  if (prefix.includes("suite404/S01E01/")) return "passion";
  if (prefix === "riverfield/LOCKERS" && /velvet\s*moon/i.test(candidatePrompt(meta))) return "velvet";
  return null;
}

export function importSuite404(outDir: string, options: { productionId?: string } = {}): Suite404ImportReport {
  const historyDir = join(outDir, "history");
  if (!existsSync(historyDir)) throw new ProductionError("IMPORT_SOURCE", `No history directory at ${historyDir}`);
  const store = new ProductionStore(outDir);
  const productionId = options.productionId ?? "suite-404";
  store.createProduction({
    id: productionId, title: "SUITE 404", logline: "Persistent production fixture imported from existing SUITE 404 material.",
    status: "active",
  }, actor, "suite404:production");
  store.createSeason(productionId, { id: "suite-404-s01", number: 1, title: "Season 01" }, actor, "suite404:season:1");
  store.createEpisode(productionId, { id: "suite-404-s01e01", seasonId: "suite-404-s01", number: 1, title: "Passion Max", status: "draft" }, actor, "suite404:episode:1");
  store.createEpisode(productionId, { id: "suite-404-s01e02", seasonId: "suite-404-s01", number: 2, title: "Velvet Moon (experimental)", status: "draft" }, actor, "suite404:episode:2");
  for (let number = 1; number <= 15; number += 1) {
    store.createScene(productionId, {
      id: suiteSceneId(number), episodeId: "suite-404-s01e01", number, title: `Scene ${String(number).padStart(2, "0")}`,
      summary: "Imported draft scene; no creative or canonical approval was inferred.",
    }, actor, `suite404:scene:s01e01:${number}`);
  }
  store.createScene(productionId, {
    id: "suite-404-s01e02-sc01", episodeId: "suite-404-s01e02", number: 1, title: "Velvet Moon (experimental)",
    summary: "Experimental imported scene; not canonical E02.",
  }, actor, "suite404:scene:s01e02:1");

  const metas: HistoryMeta[] = [];
  for (const entry of readdirSync(historyDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(historyDir, entry.name, "meta.json");
    if (!existsSync(file)) continue;
    try {
      const meta = JSON.parse(readFileSync(file, "utf8")) as HistoryMeta;
      if (meta.status === "succeeded" && relevantSuites(meta)) metas.push(meta);
    } catch { /* ignore an incomplete or unrelated history entry */ }
  }

  const skipped: string[] = [];
  let candidates = 0;
  let assets = 0;
  for (const meta of metas.sort((a, b) => a.id.localeCompare(b.id))) {
    const video = outputFile(outDir, meta);
    if (!video) { skipped.push(`${meta.id}: no existing video output`); continue; }
    const outputHash = hashFile(video.path);
    outputHashCache.set(meta.id, outputHash);
    const suite = relevantSuites(meta);
    if (!suite) continue;
    const windows = parseWindows(meta);
    if (!windows.length) { skipped.push(`${meta.id}: no actual segment_windows`); continue; }
    const candidateId = `suite404-${meta.id}`;
    const prefix = clean(meta.values?.filename_prefix) || meta.id;
    const sceneNumbersForCandidate = suite === "passion" ? sceneNumbers(meta, windows.length) : [1];
    const targetScenes = suite === "passion" ? sceneNumbersForCandidate : [1];
    const output: CandidateOutput = { type: "video", file: video.file, name: video.name, path: video.path, hash: outputHash };
    const bindings = suite === "passion"
      ? bindingsFor(meta, candidateId, targetScenes, windows)
      : windows.slice(0, 1).map((window, index) => ({
          id: `${candidateId}-b${String(index + 1).padStart(3, "0")}`,
          sceneId: "suite-404-s01e02-sc01", candidateId, runId: meta.id,
          timebase: "final-output" as const, timelineStartFrame: Number(window.start), timelineEndFrame: Number(window.end),
          segmentIndex: index, sourceStartFrame: 0, sourceEndFrame: Math.max(0, Number(window.end) - Number(window.start)),
          outputHash, fps: 24,
        } satisfies SceneRenderBinding));
    if (!bindings.length) { skipped.push(`${meta.id}: no scene binding could be inferred`); continue; }
    store.registerCandidate(productionId, {
      id: candidateId, label: prefix, source: "import", sourceRunId: meta.id, app: meta.app,
      prompt: candidatePrompt(meta), outputs: [output], bindings: bindings.map(({ candidateId: _candidateId, ...binding }) => binding),
    }, actor, `suite404:candidate:${candidateId}`);
    candidates += 1;
  }

  // Index the image assets that were generated for SUITE 404, without copying them.
  for (const entry of readdirSync(historyDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(historyDir, entry.name, "meta.json");
    if (!existsSync(file)) continue;
    try {
      const meta = JSON.parse(readFileSync(file, "utf8")) as HistoryMeta;
      if (meta.status !== "succeeded" || !clean(meta.values?.filename_prefix).includes("Suite404_Assets")) continue;
      for (const [index, output] of (meta.outputs ?? []).entries()) {
        if (!["image", "video", "audio"].includes(output.type)) continue;
        const path = join(historyDir, entry.name, output.file);
        if (!existsSync(path)) continue;
        store.indexAsset(productionId, {
          id: `suite404-asset-${meta.id}-${index + 1}`, kind: output.type as "image" | "video" | "audio",
          label: output.name || output.file, sourceRunId: meta.id, path, hash: hashFile(path),
          category: categoryForPrompt(meta.values?.prompt ?? meta.values?.global_prompt ?? ""),
        }, actor, `suite404:asset:${meta.id}:${index + 1}`);
        assets += 1;
      }
    } catch { /* ignore incomplete asset entries */ }
  }

  const snapshot = store.snapshot(productionId);
  return {
    productionId,
    seasons: snapshot.seasons.length,
    episodes: snapshot.episodes.length,
    scenes: snapshot.scenes.length,
    candidates,
    assets,
    skipped,
    canonicalDecisionsCreated: 0,
  };
}
