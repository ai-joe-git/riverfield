// Durable Director projects: a small JSON state plus the pictures/clips/sounds the
// timeline refers to. They live under out/directors/<app>/ so a reload, another
// browser, or another machine on the LAN sees the same project. Local IndexedDB is
// still the fast path in the browser; this store is the shared, durable copy.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { App } from "./registry.ts";

export type DirectorMedia = {
  slot: string;
  name: string;
  mime: string;
  size: number;
  type: "image" | "video" | "audio";
  url?: string;
};
export type DirectorState = {
  app: string;
  savedAt: number;
  updatedAt: number;
  values: Record<string, unknown>;
  media: Record<string, DirectorMedia>;
};

const MEDIA_TYPES = new Set(["image", "video", "audio"]);
const MAX_VALUES_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/flac": ".flac",
  "audio/ogg": ".ogg", "audio/mp4": ".m4a",
};
const SAFE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm", ".mkv", ".mp3", ".wav", ".flac", ".ogg", ".m4a"]);

const clean = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);

export class DirectorStore {
  private root: string;
  private readonly apps: Map<string, App>;

  constructor(outDir: string, apps: Map<string, App>) {
    this.root = join(outDir, "directors");
    this.apps = apps;
  }

  private app(appId: string): App {
    const app = this.apps.get(appId);
    if (!app || !app.inputs.some((i) => i.id === "segment_windows")) throw new Error("not a Director app");
    return app;
  }

  private input(appId: string, slot: string) {
    const app = this.app(appId);
    if (!/^(?:image|video|audio)\d+$/.test(slot)) throw new Error("invalid media slot");
    const input = app.inputs.find((i) => i.id === slot && MEDIA_TYPES.has(i.type));
    if (!input && /^image[1-9]\d{0,5}$/.test(slot) && app.inputs.some(i=>i.id==="segment_count"))
      return {app,input:{id:slot,type:"image" as const}};
    if (!input) throw new Error("unknown media slot");
    return { app, input };
  }

  private dir(appId: string) { return join(this.root, appId); }
  private stateFile(appId: string) { return join(this.dir(appId), "state.json"); }
  private mediaDir(appId: string) { return join(this.dir(appId), "media"); }

  private write(state: DirectorState) {
    mkdirSync(this.dir(state.app), { recursive: true });
    const file = this.stateFile(state.app), temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(state));
    renameSync(temp, file);
  }

  private read(appId: string): DirectorState | null {
    this.app(appId);
    try {
      const raw = JSON.parse(readFileSync(this.stateFile(appId), "utf8")) as Partial<DirectorState>;
      if (!raw || typeof raw !== "object") return null;
      return {
        app: appId,
        savedAt: Number.isFinite(raw.savedAt) ? Number(raw.savedAt) : 0,
        updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : 0,
        values: raw.values && typeof raw.values === "object" && !Array.isArray(raw.values) ? raw.values : {},
        media: raw.media && typeof raw.media === "object" && !Array.isArray(raw.media) ? raw.media : {},
      };
    } catch {
      return null;
    }
  }

  /** State as the browser needs it: media entries carry a same-origin URL. */
  view(appId: string): DirectorState | null {
    const state = this.read(appId);
    if (!state) return null;
    for (const [slot, entry] of Object.entries(state.media)) {
      if (!entry || !MEDIA_TYPES.has(entry.type)) { delete state.media[slot]; continue; }
      entry.slot = slot;
      entry.url = `/api/directors/${appId}/media/${slot}`;
    }
    return state;
  }

  /** Persist the editable values. Media metadata is owned by putMedia/deleteMedia. */
  saveValues(appId: string, raw: unknown, savedAt: unknown): DirectorState {
    const app = this.app(appId);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("values must be an object");
    const values: Record<string, unknown> = {};
    for (const input of app.inputs) {
      if (MEDIA_TYPES.has(input.type)) continue;
      if (Object.prototype.hasOwnProperty.call(raw, input.id)) values[input.id] = (raw as Record<string, unknown>)[input.id];
    }
    if (Buffer.byteLength(JSON.stringify(values)) > MAX_VALUES_BYTES) throw new Error("Director project is too large");
    const state = this.read(appId) ?? { app: appId, savedAt: 0, updatedAt: 0, values: {}, media: {} };
    state.values = values;
    state.savedAt = Number.isFinite(Number(savedAt)) ? Math.max(0, Number(savedAt)) : Date.now();
    state.updatedAt = Date.now();
    this.write(state);
    return state;
  }

  /** Store one uploaded media file and point the slot at it. */
  putMedia(appId: string, slot: string, bytes: Uint8Array, name: unknown, mime: unknown): DirectorState {
    const { input } = this.input(appId, slot);
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("file is too large");
    const original = clean(name, 240) || slot;
    const requested = extname(original).toLowerCase();
    const type = clean(mime, 120) || "";
    const ext = SAFE_EXT.has(requested) ? requested : EXT[type] || (input.type === "image" ? ".png" : input.type === "video" ? ".mp4" : ".wav");
    const dir = this.mediaDir(appId);
    mkdirSync(dir, { recursive: true });
    // One file per slot: remove the previous extension before writing the new one.
    for (const stale of [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm", ".mkv", ".mp3", ".wav", ".flac", ".ogg", ".m4a"]) {
      if (stale === ext) continue;
      try { rmSync(join(dir, slot + stale)); } catch { /* absent */ }
    }
    writeFileSync(join(dir, slot + ext), bytes);
    const state = this.read(appId) ?? { app: appId, savedAt: 0, updatedAt: 0, values: {}, media: {} };
    state.media[slot] = { slot, name: original, mime: type || "application/octet-stream", size: bytes.byteLength, type: input.type as DirectorMedia["type"] };
    // Media alone does not claim a newer timeline: the browser pushes values separately.
    state.updatedAt = Date.now();
    this.write(state);
    return state;
  }

  deleteMedia(appId: string, slot: string): DirectorState {
    this.input(appId, slot);
    const state = this.read(appId);
    if (!state) return { app: appId, savedAt: 0, updatedAt: Date.now(), values: {}, media: {} };
    const dir = this.mediaDir(appId);
    for (const ext of SAFE_EXT) {
      try { rmSync(join(dir, slot + ext)); } catch { /* absent */ }
    }
    delete state.media[slot];
    state.updatedAt = Date.now();
    this.write(state);
    return state;
  }

  mediaPath(appId: string, slot: string): string | null {
    this.input(appId, slot);
    const state = this.read(appId);
    const entry = state?.media[slot];
    if (!entry || !MEDIA_TYPES.has(entry.type)) return null;
    const dir = this.mediaDir(appId);
    for (const ext of SAFE_EXT) {
      const file = join(dir, slot + ext);
      try { if (statSync(file).isFile()) return file; } catch { /* try next */ }
    }
    return null;
  }

}
