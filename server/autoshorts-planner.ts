// Automatic Material Planner adapter: storyboard -> a valid pika-studio-director run.
//
// AutoShorts is the producer; Pika Studio Director stays the video director and the
// generation engine. This module only translates an approved storyboard + canonical
// reference sheets into the exact fields the director's RiverFieldH3Planner node and
// the Material Planner panel already understand. It does not re-implement sampling,
// the Ref2VA/FL2VA adapter pairing or the timeline: those live in the app + node.
//
// Geometry mirrors comfy-nodes/riverfield-comfy-nodes/nodes/h3_planner.py and
// web/js/director.js (frames at 24 fps, H3 lengths 5+17n, seams default to the
// nearest legal overlap of 39 frames). test/autoshorts-planner.test.ts cross-checks
// these numbers against the Python node so the two cannot drift apart.
import { compileVideoPrompt, recipeFor, type MediaBinding } from "./autoshorts-recipes.ts";
import type { App } from "./registry.ts";

export const FPS = 24;
export const MAX_LENGTH = 3592;
export const MIN_LEN = 5;
export const SEAM = 39;
export const MAX_IMAGES = 9;
export const MAX_VIDEOS = 3;
export const MAX_AUDIOS = 3;

/** Nearest H3-valid length: 5 + 17*n frames, clamped to [aligned(minimum), 3592]. */
export function alignedLength(frames: number, minimum = MIN_LEN): number {
  const lower = MIN_LEN + 17 * Math.max(0, Math.ceil((minimum - MIN_LEN) / 17));
  return Math.min(MAX_LENGTH, Math.max(lower, MIN_LEN + 17 * Math.max(0, Math.round((frames - MIN_LEN) / 17))));
}

/** Nearest legal seam to `frames`, never above `maximum` (mirrors nearest_overlap). */
export function nearestOverlap(frames: number, maximum: number): number {
  const choices = [0, 1];
  for (let n = MIN_LEN; n <= maximum; n += 17) choices.push(n);
  const legal = choices.filter((n) => n <= maximum);
  return legal.reduce((best, n) => (Math.abs(n - frames) < Math.abs(best - frames) ? n : best), 0);
}

/** Sequential windows for a list of per-scene frame lengths, using the plugin's seam rule. */
export function windowsFor(lengths: number[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const length of lengths.map((f) => alignedLength(f))) {
    const prev = out[out.length - 1];
    const overlap = prev ? nearestOverlap(SEAM, Math.min(length, prev.end - prev.start) - 1) : 0;
    const start = prev ? prev.end - overlap : 0;
    out.push({ start, end: start + length });
  }
  return out;
}

export type DirectorScene = {
  id: string;
  duration: number;
  prompt: string;
  visual: string;
  continuity?: { entityIds: string[]; settingId: string };
  direction?: Record<string, string>;
  dialogueLines?: { speakerId: string; text: string; delivery?: string; language?: string }[];
  dialogue?: string;
  speechMode?: string;
};
export type ReferenceSheet = { entity: string; path: string; description: string };
export type DirectorWindow = { scene: string; start: number; end: number; seconds: number; prompt: string; images: number[] };
export type DirectorBatch = {
  scenes: string[];
  adapter: "ref2va";
  engine: string;
  windows: DirectorWindow[];
  segmentWindows: string;
  bindings: { slot: string; index: number; entity: string; path: string }[];
  values: Record<string, unknown>;
};

/**
 * Group consecutive scenes into director runs. A new batch starts when the per-run cap
 * is reached or the next scene's references would not fit the nine image slots.
 */
export function planBatches(scenes: DirectorScene[], perRun: number, maxImages = MAX_IMAGES): DirectorScene[][] {
  const batches: DirectorScene[][] = [];
  let current: DirectorScene[] = [], used = new Set<string>();
  const flush = () => { if (current.length) { batches.push(current); current = []; used = new Set(); } };
  for (const s of scenes) {
    const entities = s.continuity?.entityIds ?? [];
    const wouldUse = new Set(used); entities.forEach((e) => wouldUse.add(e));
    if (current.length && (current.length >= perRun || wouldUse.size > maxImages)) flush();
    current.push(s); entities.forEach((e) => used.add(e));
  }
  flush();
  return batches;
}

/**
 * Build the pika-studio-director values for one batch: the segment_windows document,
 * the ordered image slots (canonical sheets reused across shots) and the compiled
 * Ref2VA prompt per window. `readSheet` resolves an entity id to its approved file.
 */
export function buildDirectorBatch(
  app: App,
  scenes: DirectorScene[],
  bible: { style: string; lighting: string; entities: { id: string; kind: string; description: string }[] },
  readSheet: (entity: string) => ReferenceSheet,
  opts: { aspect: string; megapixels: number; language: string; seed: number },
): DirectorBatch {
  const recipe = recipeFor(app);
  if (recipe.conditioning !== "ref2va") throw new Error(`${app.id}: the director plan expects the Ref2VA adapter`);
  // Assign every entity used in this batch to a stable image slot, in bible order.
  const used = new Set(scenes.flatMap((s) => s.continuity?.entityIds ?? []));
  const ordered = bible.entities.filter((e) => used.has(e.id)).map((e) => e.id);
  for (const id of used) if (!ordered.includes(id)) ordered.push(id);
  if (ordered.length > MAX_IMAGES) throw new Error(`director batch needs ${ordered.length} reference images, more than ${MAX_IMAGES} slots; split the batch`);
  const slotOf = new Map(ordered.map((id, i) => [id, i]));
  const bindings = ordered.map((id, i) => { const sheet = readSheet(id); return { slot: `image${i + 1}`, index: i, entity: id, path: sheet.path }; });

  const lengths = scenes.map((s) => alignedLength(Math.max(MIN_LEN, Math.round(s.duration * FPS))));
  const windows = windowsFor(lengths);
  const segWindows = windows.map((w, i) => {
    const s = scenes[i];
    const sceneBindings: MediaBinding[] = (s.continuity?.entityIds ?? []).map((id) => {
      const i2 = slotOf.get(id)!; const sheet = readSheet(id);
      return { input: `image${i2 + 1}`, path: sheet.path, role: sheet.description ? (bible.entities.find((e) => e.id === id)?.kind === "setting" ? "setting" : "identity") : "identity", entity: id, description: sheet.description };
    });
    const prompt = compileVideoPrompt(recipe, { ...s, duration: (w.end - w.start) / FPS }, bible as any, sceneBindings, opts.language, s.speechMode !== "mute").prompt;
    return { scene: s.id, start: w.start, end: w.end, seconds: +((w.end - w.start) / FPS).toFixed(3), prompt, images: (s.continuity?.entityIds ?? []).map((id) => slotOf.get(id)!) };
  });
  const segmentWindows = JSON.stringify({ windows: segWindows.map((w) => ({ start: w.start, end: w.end, prompt: w.prompt, images: w.images, audios: [] })), videos: [], audios: [] });
  const values: Record<string, unknown> = {
    segment_windows: segmentWindows,
    segment_count: segWindows.length,
    duration: segWindows[0]?.seconds ?? 5,
    global_prompt: `${bible.style}. Lighting: ${bible.lighting}.`,
    flex_mode: "ref2va",
    aspect: opts.aspect,
    megapixels: opts.megapixels,
    seed: opts.seed,
  };
  return { scenes: scenes.map((s) => s.id), adapter: "ref2va", engine: app.id, windows: segWindows, segmentWindows, bindings, values };
}

/** Full plan across the storyboard, grouped into batches. */
export function buildDirectorPlan(
  app: App,
  scenes: DirectorScene[],
  bible: { style: string; lighting: string; entities: { id: string; kind: string; description: string }[] },
  readSheet: (entity: string) => ReferenceSheet,
  opts: { aspect: string; megapixels: number; language: string; seed: number; perRun: number },
): DirectorBatch[] {
  const sorted = [...scenes].sort((a, b) => (a as any).order - (b as any).order);
  return planBatches(sorted, opts.perRun).map((batch) => buildDirectorBatch(app, batch, bible, readSheet, opts));
}
