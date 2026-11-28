// Studio Director — the Material Planner panel.
//
// A real director surface, not a form: a media bin on the left, a frame-accurate timeline in the
// middle (GEN windows you can drag and resize, video and audio clips you can move and trim), and
// the selected segment's prompt and ordered materials underneath.
//
// What it edits stays in the app's existing contract:
//   - f.files[imageN|videoN|audioN]   the uploads (same store the normal dropzones use)
//   - f.values.segment_windows        JSON read by the RiverField H3 Material Planner node:
//       { windows:[{start,end,prompt,images:[i],audios:[i]}],
//         videos: [{index,start,duration,trimStart,sourceDuration,width,height,hasAudio,referenceMode}],
//         audios: [{index,start,duration,trimStart}] }
//
// H3 lengths are 5+17n frames; new scenes use hard cuts (zero overlap), without gaps.
// Explicit overlaps are retained for continuous takes. Dragging is frame-accurate; the length snaps to a
// legal H3 value on release (or immediately with the H3 button in the segment editor).

import { directorConditioningMode, libraryImageSlot } from "./director-mode.js";
import { el, icon, toast, clamp, store } from "./util.js";
import { modal } from "./agent-controls.js";
import {
  renderProfileCapability,
  renderMetadata,
  resolveRenderProfile,
  switchRenderProfile,
  migrateRenderProfile,
  UPSCALE_FACTORS,
} from "./render-profile.js";

const FPS = 24;
const MAX_LENGTH = 3592;
const MIN_LEN = 5;
const SEAM = 0;

/** One prompt per line. `,13` sets seconds; `,13,3` also sets the overlap with the
 * previous segment. The modal slider supplies the overlap when the third value is absent. */
export function parseBatchPrompts(text, fallback, fallbackOverlap = SEAM / FPS) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let prompt = line, duration = fallback, overlap = fallbackOverlap;
    const two = /^(.*?)\s*,\s*(\d+(?:\.\d+)?)\s*s?\s*,\s*(\d+(?:\.\d+)?)\s*s?\s*$/i.exec(line);
    const one = /^(.*?)\s*,\s*(\d+(?:\.\d+)?)\s*s?\s*$/i.exec(line);
    if (two) {
      prompt = two[1].trim();
      duration = Number(two[2]);
      overlap = Number(two[3]);
    } else if (one) {
      prompt = one[1].trim();
      duration = Number(one[2]);
    }
    if (prompt) out.push({
      prompt,
      duration: Math.max(MIN_LEN / FPS, Math.min(30, duration)),
      overlap: Math.max(0, Math.min(30, overlap)),
    });
  }
  return out;
}

const MEDIA = {
  image: { label: "Pictures", icon: "image", slots: 9, accept: "image/*" },
  video: { label: "Videos", icon: "film", slots: 3, accept: "video/*" },
  audio: { label: "Audios", icon: "audio", slots: 3, accept: "audio/*" },
};

export function alignedLength(frames, minimum = MIN_LEN) {
  const lower = MIN_LEN + 17 * Math.max(0, Math.ceil((minimum - MIN_LEN) / 17));
  return Math.min(MAX_LENGTH, Math.max(lower, MIN_LEN + 17 * Math.max(0, Math.round((frames - MIN_LEN) / 17))));
}

/** H3 segments advance with no gap and an overlap of 0, 1 or 5 + 17n frames. */
export function legalOverlapFrames(frames, max = Number.POSITIVE_INFINITY) {
  const cap = Math.max(0, Math.floor(max));
  const values = [0, 1];
  for (let n = 0; 5 + 17 * n <= cap; n += 1) values.push(5 + 17 * n);
  return values.reduce((best, v) => (Math.abs(v - frames) < Math.abs(best - frames) ? v : best), 0);
}

export function nearestOverlap(frames, maximum) {
  const choices = [0, 1];
  for (let n = 5; n <= maximum; n += 17) choices.push(n);
  return choices.filter((n) => n <= maximum).reduce((best, n) => (Math.abs(n - frames) < Math.abs(best - frames) ? n : best), 0);
}

/** Ripple a duration/move edit without inventing overlap at any following cut. */
export function rippleH3Windows(windows, editedIndex, before, aligned = true) {
  for (let k = editedIndex + 1; k < windows.length; k += 1) {
    const prev = windows[k - 1], cur = windows[k];
    const len = cur.end - cur.start;
    const requested = Math.max(0, before[k - 1].end - before[k].start);
    const cap=Math.max(0,Math.min(len,prev.end-prev.start)-1);
    const overlap = aligned ? legalOverlapFrames(requested,cap) : Math.min(requested,cap);
    cur.start = prev.end - overlap;
    cur.end = cur.start + len;
  }
}

const fmt = (x) => (Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.0+$/, "");
const fmtMp = (x) => `${Number(x).toFixed(2).replace(/\.?0+$/, "")} MP`;

function slotsOf(app, type, files = {}, library = false) {
  const inputs = [...app.inputs];
  if (library && type === "image") for (const slot of Object.keys(files)) if (libraryImageSlot(slot) && !inputs.some(i=>i.id===slot)) inputs.push({id:slot,type:"image"});
  return inputs.filter((i) => i.type === type && /^(image|video|audio)\d+$/.test(i.id))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function mediaOf(app, f, type) {
  const library = app.inputs.some(i=>i.id==="segment_count") && directorConditioningMode({...f.values,...f.files})==="fl2va";
  return slotsOf(app, type, f.files, library).map((inp) => {
    const index = Number(inp.id.replace(/\D/g,""))-1;
    const x = f.files[inp.id];
    return x ? { index, slot: inp.id, name: x.file.name, url: x.url, file: x.file } : null;
  }).filter(Boolean);
}

/** Drop references to media slots that have no uploaded file: files do not survive a reload. */
export function pruneMedia(st, app, f) {
  const has = (type, index) => {
    const slot = `${type}${index+1}`;
    return Boolean(f.files[slot] && (app.inputs.some(i=>i.id===slot) || (type==="image" && libraryImageSlot(slot) && app.inputs.some(i=>i.id==="segment_count"))));
  };
  let changed = false;
  for (const w of st.windows) {
    const images = (w.images || []).filter((i) => has("image", i));
    const audios = (w.audios || []).filter((i) => has("audio", i));
    for (const key of ["first_frame", "last_frame"]) {
      if (w[key] !== undefined && !has("image", w[key])) { delete w[key]; changed = true; }
    }
    if (images.length !== (w.images || []).length) { w.images = images; changed = true; }
    if (audios.length !== (w.audios || []).length) { w.audios = audios; changed = true; }
  }
  const videos = st.videos.filter((v) => has("video", v.index));
  const audios = st.audios.filter((a) => has("audio", a.index));
  if (videos.length !== st.videos.length) { st.videos = videos; changed = true; }
  if (audios.length !== st.audios.length) { st.audios = audios; changed = true; }
  return changed;
}

/** Duration/size of a dropped file, read once from a throwaway media element. */
function probe(url, type) {
  return new Promise((resolve) => {
    if (type === "image") {
      const img = new Image();
      img.onload = () => resolve({ duration: 0, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ duration: 0, width: 0, height: 0 });
      img.src = url;
      return;
    }
    const m = document.createElement(type === "video" ? "video" : "audio");
    m.preload = "metadata";
    m.onloadedmetadata = () => resolve({ duration: Number(m.duration) || 0, width: m.videoWidth || 0, height: m.videoHeight || 0 });
    m.onerror = () => resolve({ duration: 0, width: 0, height: 0 });
    m.src = url;
  });
}

const DIRECTOR_DB = "riverfield-director";
let directorDbPromise = null;
function directorDb() {
  if (!directorDbPromise) {
    directorDbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
      const req = indexedDB.open(DIRECTOR_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return directorDbPromise;
}
function mediaPut(key, value) {
  return directorDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("images", "readwrite");
    tx.objectStore("images").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function mediaDelete(key) {
  return directorDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("images", "readwrite");
    tx.objectStore("images").delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function mediaEntries(prefix) {
  return directorDb().then((db) => new Promise((resolve, reject) => {
    const out = [], tx = db.transaction("images", "readonly"), req = tx.objectStore("images").openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith(prefix)) out.push([String(cursor.key), cursor.value]);
      cursor.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  }));
}

export function directorView(app, f, { onSubmit, onDirty, onRestored }) {
  const st = stateFor(app, f);
  // The browser app object does not include the server-side graph. Every H3 Material
  // Planner manifest exposes segment_count; the LTX directors do not, so this is the
  // reliable client-side discriminator for the native frame cadence.
  const h3Planner = app.inputs.some((i) => i.id === "segment_count");
  const defaultSeam = SEAM;
  const endpointMode = () => h3Planner && directorConditioningMode({ ...f.values, ...f.files }) === "fl2va";
  const snapOverlap = (seconds) => h3Planner ? legalOverlapFrames(Math.round(Number(seconds) * FPS), 30 * FPS) / FPS : Math.max(0, Math.min(30, Number(seconds) || 0));
  // Durable project state lives on the server (out/directors/<app>). IndexedDB remains
  // the fast local copy; the server copy makes a reload or another browser on the LAN
  // show the same timeline and the same pictures.
  const mediaInputs = new Set(app.inputs.filter((i) => i.type === "image" || i.type === "video" || i.type === "audio").map((i) => i.id));
  const validMediaSlot = slot => mediaInputs.has(slot) || (h3Planner && libraryImageSlot(slot));
  const valueInputs = new Set(app.inputs.filter((i) => !(i.type === "image" || i.type === "video" || i.type === "audio")).map((i) => i.id));
  let localSavedAt = Number(store.get(`dir.saved.${app.id}`)) || 0;
  // Profiles are derived from this app's own manifest. Apps without the contract keep
  // their existing controls untouched.
  const profiles = app.renderProfile?.supported ? app.renderProfile : renderProfileCapability(app);
  const freshSession = !localSavedAt
    && !(typeof f.values.segment_windows === "string" && f.values.segment_windows.trim())
    && !f.values.render_profile;
  let restoring = true;
  let serverLoaded = false;
  let serverSaveTimer = 0;
  let profileDirty = false;
  function saveDirty() {
    if (!restoring) {
      localSavedAt = Date.now();
      store.set(`dir.saved.${app.id}`, localSavedAt);
    }
    onDirty?.();
    if (!restoring && serverLoaded) scheduleServerSave();
  }
  function scheduleServerSave() {
    if (!serverLoaded) return;
    clearTimeout(serverSaveTimer);
    serverSaveTimer = setTimeout(() => { void pushServerState(); }, 350);
  }
  function projectValues() {
    const values = {};
    for (const [key, value] of Object.entries(f.values)) if (valueInputs.has(key)) values[key] = value;
    return values;
  }
  const enhancerAvailable = app.inputs.some((input) => input.id === "prompt_enhancer");
  let promptBusy = false;
  let promptProgress = null;
  const promptSpinner = () => el("span", { class: "dir-spinner", "aria-hidden": "true" });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Rewrite one selected segment, or all segments in order. The HTTP start call is short;
   * the writer job is polled so a long Qwen generation is never held open by the browser.
   * No generation deadline is applied. This never starts the H3 renderer. */
  async function generatePrompts(index, all = false) {
    if (!enhancerAvailable || promptBusy) return;
    promptBusy = true;
    promptProgress = { done: 0, total: 1 };
    draw();
    try {
      const body = all ? { values: projectValues(), all: true } : { values: projectValues(), index };
      const started = await fetch(`/api/directors/${app.id}/prompts/jobs`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const startData = await started.json().catch(() => ({}));
      if (!started.ok) throw new Error(startData.error || `${started.status} ${started.statusText}`);
      const jobId = startData.id;
      if (!jobId) throw new Error("Prompt writer did not return a job id");
      let data = null;
      for (;;) {
        await sleep(1200);
        const res = await fetch(`/api/directors/${app.id}/prompt-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const status = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(status.error || `${res.status} ${res.statusText}`);
        if (status.progress) {
          promptProgress = status.progress;
          drawHead();
        }
        if (status.status === "succeeded") { data = status.values; break; }
        if (status.status === "failed") throw new Error(status.error || "The prompt writer failed");
      }
      Object.assign(f.values, data || {});
      const parsed = parseState(f);
      st.windows = parsed.windows;
      st.videos = parsed.videos;
      st.audios = parsed.audios;
      persistState(app, f, st);
      stateCache.set(app.id, { raw: f.values.segment_windows, state: st });
      saveDirty();
      draw();
      const field = segEl.querySelector(".dir-prompt");
      if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }
      toast(all ? "Prompts generated. Video not started." : `Prompt generated for segment ${selected + 1}. Video not started.`);
    } catch (err) {
      const message = err?.message === "Failed to fetch"
        ? "Lost the connection to the prompt writer. The writer may still be running; retry when the studio is reachable."
        : err.message;
      toast(`Prompt generation failed: ${message}`, { error: true });
    } finally {
      promptBusy = false;
      promptProgress = null;
      draw();
    }
  }
  function adoptProfile(values) {
    let changed = false;
    for (const [key, value] of Object.entries(values || {})) {
      if (value === undefined) continue;
      if (f.values[key] !== value) { f.values[key] = value; changed = true; }
    }
    return changed;
  }
  /** Give an unprofiled project a profile once, without changing its creative payload. */
  function ensureRenderProfile(fresh) {
    if (!profiles) return false;
    const result = migrateRenderProfile(app, f.values, { fresh });
    if (result.errors.length) { toast(result.errors[0].message, { error: true }); return false; }
    if (!adoptProfile(result.values)) return false;
    profileDirty = true;
    saveDirty();
    return true;
  }
  /** The only profile switch path: saves values and redraws. It never submits a generation. */
  function chooseRenderProfile(profile) {
    const result = switchRenderProfile(app, f.values, profile);
    if (result.errors.length) { toast(result.errors[0].message, { error: true }); return; }
    if (!adoptProfile(result.values)) { draw(); return; }
    saveDirty();
    draw();
  }
  async function pushServerState() {
    if (!serverLoaded) return;
    clearTimeout(serverSaveTimer);
    try {
      const res = await fetch(`/api/directors/${app.id}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: projectValues(), savedAt: localSavedAt || Date.now() }),
      });
      if (!res.ok) return;
      const state = await res.json();
      if (state && Number.isFinite(Number(state.savedAt))) {
        localSavedAt = Number(state.savedAt);
        store.set(`dir.saved.${app.id}`, localSavedAt);
      }
    } catch { /* local fallback stays usable */ }
  }
  async function uploadServerMedia(slot, file) {
    const form = new FormData();
    form.append("file", file, file.name || slot);
    const res = await fetch(`/api/directors/${app.id}/media/${slot}`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`media upload answered ${res.status}`);
    return res.json();
  }
  async function deleteServerMedia(slot) {
    try { await fetch(`/api/directors/${app.id}/media/${slot}`, { method: "DELETE" }); } catch { /* local only */ }
  }
  async function loadServerState() {
    try {
      const res = await fetch(`/api/directors/${app.id}`, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
  function applyServerValues(values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) return false;
    for (const [key, value] of Object.entries(values)) if (valueInputs.has(key)) f.values[key] = value;
    const next = parseState(f);
    st.windows = next.windows;
    st.videos = next.videos;
    st.audios = next.audios;
    selected = Math.min(selected, Math.max(0, st.windows.length - 1));
    stateCache.set(app.id, { raw: f.values.segment_windows, state: st });
    // A saved project may predate profiles. Give it the matching profile without
    // changing its resolution, timeline or references.
    if (profiles) ensureRenderProfile(false);
    return true;
  }
  async function loadServerMedia(remote, overwrite) {
    const media = remote?.media && typeof remote.media === "object" ? remote.media : {};
    for (const [slot, entry] of Object.entries(media)) {
      if (!validMediaSlot(slot) || (!overwrite && f.files[slot])) continue;
      try {
        const res = await fetch(`/api/directors/${app.id}/media/${slot}`, { cache: "no-store" });
        if (!res.ok) continue;
        const blob = await res.blob();
        const file = new File([blob], entry.name || slot, { type: entry.mime || blob.type || "application/octet-stream" });
        if (f.files[slot]?.url) URL.revokeObjectURL(f.files[slot].url);
        f.files[slot] = { file, url: URL.createObjectURL(file) };
        if (entry.type === "image") rememberMedia(slot, file);
      } catch { /* keep the local copy when the server copy is unreadable */ }
    }
  }
  /** One-shot handoff from Production Studio. It associates the existing Director project
   * with a production scene; it never clears the timeline or starts a render. */
  async function applyProductionHandoff() {
    const handoff = store.get("production.handoff");
    if (!handoff || handoff.app !== app.id || !handoff.productionId || !handoff.sceneId) return;
    store.set("production.handoff", null);
    f.values.production_id = handoff.productionId;
    f.values.production_scene_id = handoff.sceneId;
    if (handoff.brief && !String(f.values.global_prompt || "").trim()) f.values.global_prompt = handoff.brief;
    // Transfer selected images into EMPTY picture slots only. Never overwrite an existing
    // picture or silently clear the saved Director project.
    const chosen = Array.isArray(handoff.referenceAssetIds) ? handoff.referenceAssetIds : [];
    const slots = app.inputs.filter((input) => input.type === "image").map((input) => input.id);
    const free = slots.filter((slot) => !f.files?.[slot]);
    let loaded = 0;
    for (const [index, assetId] of chosen.entries()) {
      const slot = free[index];
      if (!slot) break;
      try {
        const response = await fetch(`/api/productions/${encodeURIComponent(handoff.productionId)}/media?assetId=${encodeURIComponent(String(assetId))}`);
        if (!response.ok) continue;
        const blob = await response.blob();
        const file = new File([blob], `production-reference-${index + 1}.${(blob.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: blob.type || "image/png" });
        f.files[slot] = { file, url: URL.createObjectURL(file) };
        loaded += 1;
      } catch { /* leave the slot empty; the Director remains usable */ }
    }
    persistState(app, f, st);
    localSavedAt = Date.now();
    store.set(`dir.saved.${app.id}`, localSavedAt);
    saveDirty();
    draw();
    toast(`Associated with ${handoff.productionId} · ${handoff.sceneTitle || handoff.sceneId}${loaded ? ` · ${loaded} reference${loaded === 1 ? "" : "s"} loaded` : ""}. Canonical memory will be used by the prompt enhancer.`);
  }

  async function restoreProject() {
    await restoreMediaFiles();
    const remote = await loadServerState();
    const localSaved = localSavedAt;
    const remoteSaved = Number(remote?.savedAt) || 0;
    const hasLocalTimeline = typeof f.values.segment_windows === "string" && f.values.segment_windows.trim().length > 0;
    const hasRemoteTimeline = Boolean(remote?.values) && typeof remote.values.segment_windows === "string" && remote.values.segment_windows.trim().length > 0;
    const useServer = hasRemoteTimeline && (!hasLocalTimeline || remoteSaved > localSaved + 1000);
    if (useServer) {
      applyServerValues(remote.values);
      localSavedAt = remoteSaved;
      store.set(`dir.saved.${app.id}`, localSavedAt);
    }
    await loadServerMedia(remote, useServer);
    const remoteMedia = remote?.media && typeof remote.media === "object" ? remote.media : {};
    for (const [slot, item] of Object.entries(f.files)) {
      if (!validMediaSlot(slot) || !item?.file) continue;
      const saved = remoteMedia[slot];
      if (saved && saved.name === item.file.name && Number(saved.size) === item.file.size) continue;
      try { await uploadServerMedia(slot, item.file); } catch { /* keep local */ }
    }
    if (pruneMedia(st, app, f) || fillDefaultPictures()) {
      persistState(app, f, st);
      localSavedAt = Date.now();
      store.set(`dir.saved.${app.id}`, localSavedAt);
    }
    if (profiles) ensureRenderProfile(false);
    serverLoaded = true;
    restoring = false;
    onDirty?.();
    const push = !useServer || profileDirty;
    profileDirty = false;
    if (push) await pushServerState();
    draw();
    if (useServer && root.isConnected) onRestored?.();
    void applyProductionHandoff();
  }
  async function restoreMediaFiles() {
    try {
      // Migrate the short-lived localStorage image cache from the previous build into
      // IndexedDB before removing it; IndexedDB has the storage budget for real pictures.
      const legacyKey = `dirfiles.${app.id}`;
      const legacy = store.get(legacyKey) || {};
      for (const [slot, entry] of Object.entries(legacy)) {
        if (!slot.startsWith("image") || !entry?.data || f.files[slot]) continue;
        try {
          const blob = await (await fetch(entry.data)).blob();
          const file = new File([blob], entry.name || "image.png", { type: entry.type || blob.type || "image/png" });
          f.files[slot] = { file, url: URL.createObjectURL(file) };
          await mediaPut(`${app.id}:${slot}`, { blob: file, name: file.name, type: file.type });
        } catch { /* corrupt legacy entry */ }
      }
      try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
      const entries = await mediaEntries(`${app.id}:`);
      for (const [key, value] of entries) {
        const slot = key.slice(app.id.length + 1);
        if (!slot.startsWith("image") || f.files[slot] || !value?.blob) continue;
        const blob = value.blob;
        const file = blob instanceof File ? blob : new File([blob], value.name || "image.png", { type: value.type || blob.type || "image/png" });
        f.files[slot] = { file, url: URL.createObjectURL(file) };
      }
    } catch { /* IndexedDB unavailable or corrupt */ }
  }
  function rememberMedia(slot, file) {
    if (!slot.startsWith("image") || !file) return;
    void mediaPut(`${app.id}:${slot}`, { blob: file, name: file.name, type: file.type }).catch(() => {});
  }
  function forgetMedia(slot) {
    if (slot.startsWith("image")) void mediaDelete(`${app.id}:${slot}`).catch(() => {});
  }
  function normalizeOverlaps() {
    if (!h3Planner || !st.windows.length) return false;
    let changed = false;
    const first = st.windows[0];
    const firstLen = Math.max(MIN_LEN, first.end - first.start);
    if (first.start !== 0) { first.start = 0; first.end = firstLen; changed = true; }
    for (let i = 1; i < st.windows.length; i += 1) {
      const prev = st.windows[i - 1], cur = st.windows[i];
      const len = Math.max(MIN_LEN, cur.end - cur.start);
      const prevLen = Math.max(MIN_LEN, prev.end - prev.start);
      const max = Math.max(0, Math.min(prevLen - 1, len - 1));
      const desired = Math.max(0, prev.end - cur.start);
      const overlap = legalOverlapFrames(desired, max);
      const start = Math.max(0, prev.end - overlap);
      const end = start + len;
      if (start !== cur.start || end !== cur.end) { cur.start = start; cur.end = end; changed = true; }
    }
    return changed;
  }
  const allPictures = () => mediaOf(app, f, "image").map((m) => m.index);
  function fillDefaultPictures() {
    if (!h3Planner || endpointMode()) return false;
    const pictures = allPictures();
    if (!pictures.length) return false;
    let changed = false;
    for (const w of st.windows) {
      const rank = new Map(pictures.map((index, pos) => [index, pos]));
      const current = (w.images || []).filter((index) => rank.has(index));
      const next = current.length ? current : [...pictures];
      if (JSON.stringify(next) !== JSON.stringify(w.images || [])) { w.images = next; changed = true; }
    }
    return changed;
  }
  let selected = 0;
  let zoom = Number(store.get("dir.zoom")) || 70;
  let drag = null;
  let winNodes = [];

  const meta = mediaMeta();
  const root = el("div", { class: "dir" });
  root.addEventListener("director-mode-change", () => { persistState(app, f, st); saveDirty(); draw(); });
  let ghostEl = null;
  let renderEl = null;

  /** Premium pointer drag: rAF ghost, persistent preview, cancel on Escape/blur. */
  function pointerDrag(e, { build, move, end, click, source }) {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let active = false, raf = 0, last = null;

    const cleanup = (fire) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKey);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      document.body.classList.remove("dir-dragging");
      source?.classList.remove("dragging");
      ghostEl?.remove();
      ghostEl = null;
      if (fire) end?.();
    };
    const onMove = (ev) => {
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        active = true;
        source?.classList.add("dragging");
        ghostEl = el("div", { class: "dir-ghost" }, build());
        document.body.append(ghostEl);
        document.body.classList.add("dir-dragging");
      }
      last = ev;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        if (ghostEl && last) ghostEl.style.transform = `translate3d(${last.clientX + 14}px, ${last.clientY + 12}px, 0)`;
      });
      move?.(ev);
    };
    const onUp = (ev) => {
      const was = active;
      cleanup(false);
      if (was) end?.(ev); else click?.(ev);
    };
    const onCancel = () => cleanup(true);
    const onKey = (ev) => { if (ev.key === "Escape") cleanup(true); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKey);
  }

  function clearDropHints() {
    document.querySelectorAll(".dir-track.over").forEach((n) => n.classList.remove("over"));
    document.querySelectorAll(".dir-win.hover").forEach((n) => n.classList.remove("hover"));
    document.querySelectorAll(".dir-drop-preview").forEach((n) => n.remove());
  }
  let stage, binEl, segEl, headEl, footEl;
  let pendingMeta = 0;

  const totalFrames = () => Math.max(...st.windows.map((w) => w.end), 1);
  const totalSeconds = () => totalFrames() / FPS;

  let playheadFrame = 0;
  let snapLine = null;
  const SNAP_PX = 9;
  const snapTol = () => Math.max(1, Math.round((SNAP_PX / zoom) * FPS));

  function snapCandidates(exceptWindow = -1, exceptClip = null) {
    const out = [0, playheadFrame];
    st.windows.forEach((w, k) => { if (k !== exceptWindow) out.push(w.start, w.end); });
    for (const c of [...st.videos, ...st.audios]) {
      if (exceptClip && c.type === exceptClip.type && c.index === exceptClip.index) continue;
      out.push(Math.round(c.start * FPS), Math.round((c.start + c.duration) * FPS));
    }
    return out;
  }

  function snap(frame, exceptWindow = -1, exceptClip = null) {
    const tol = snapTol();
    let best = null;
    for (const c of snapCandidates(exceptWindow, exceptClip)) {
      const d = Math.abs(frame - c);
      if (d <= tol && (best === null || d < best.d)) best = { d, frame: c };
    }
    if (!best) { showSnap(null); return frame; }
    showSnap(best.frame);
    return best.frame;
  }

  function showSnap(frame) {
    if (!snapLine) return;
    if (frame === null || frame === undefined) { snapLine.style.display = "none"; return; }
    snapLine.style.display = "block";
    snapLine.style.left = `${56 + px(frame)}px`;
  }

  function changed() {
    normalizeOverlaps();
    pruneMedia(st, app, f);
    persistState(app, f, st);
    saveDirty();
    draw();
  }

  function attachMedia(type, file) {
    let free = slotsOf(app, type).find(i => !f.files[i.id]);
    if (type === "image" && endpointMode()) {
      let index=1;while(f.files[`image${index}`])index++;
      free={id:`image${index}`,type:"image"};
    }
    if (!free) { toast(`No free ${MEDIA[type].label.toLowerCase()} slot`, { error: true }); return false; }
    const maxMb = free.limits?.max_mb;
    if (maxMb && file.size > maxMb * 1e6) { toast(`${file.name}: max ${maxMb} MB`, { error: true }); return false; }
    const url = URL.createObjectURL(file);
    f.files[free.id] = { file, url };
    if (type === "image") rememberMedia(free.id, file);
    void uploadServerMedia(free.id, file).catch(() => {});
    if (h3Planner && type === "image") fillDefaultPictures();
    pendingMeta++;
    probe(url, type).then((m) => {
      meta.set(free.id, m);
      pendingMeta--;
      if (pendingMeta === 0) changed(); else draw();
    });
    return true;
  }

  function removeSlot(slot) {
    const x = f.files[slot];
    if (x?.url) URL.revokeObjectURL(x.url);
    delete f.files[slot];
    meta.delete(slot);
    forgetMedia(slot);
    void deleteServerMedia(slot);
    const type = slot.replace(/\d+$/, "");
    const index = Number(slot.replace(/\D/g, "")) - 1;
    for (const w of st.windows) {
      if (type === "image") {
        w.images = (w.images || []).filter((i) => i !== index);
        for (const key of ["first_frame", "last_frame"]) if (w[key] === index) delete w[key];
      }
      if (type === "audio") w.audios = (w.audios || []).filter((i) => i !== index);
    }
    if (type === "video") st.videos = st.videos.filter((v) => v.index !== index);
    if (type === "audio") st.audios = st.audios.filter((a) => a.index !== index);
  }

  // ---------------------------------------------------------------- media bin
  let pictureQuery="";
  function binSection(type) {
    const list = mediaOf(app, f, type);
    const items = list.map((m) => {
      const info = meta.get(m.slot);
      const selectedWin = st.windows[selected];
      const inSeg = selectedWin && type !== "video" ? (type === "image"
        ? (endpointMode() ? [selectedWin.first_frame, selectedWin.last_frame] : selectedWin.images)
        : selectedWin.audios)?.includes(m.index) : false;
      const thumb = type === "image"
        ? el("img", { src: m.url, alt: m.name })
        : el("span", { class: "dir-media-icon" }, icon(type === "video" ? "film" : "audio"));
      const sub = info?.duration ? `${fmt(info.duration)}s${info.width ? ` · ${info.width}×${info.height}` : ""}` : "";
      const node = el("div", {
        class: `dir-media${inSeg ? " on" : ""}`,
        title: `${m.name}${sub ? `\n${sub}` : ""}`,
        onclick: () => {
          if (type === "video") return;
          const w = st.windows[selected];
          if (!w) return;
          const key = type === "image" ? "images" : "audios";
          w[key] = w[key].includes(m.index) ? w[key].filter((i) => i !== m.index) : [...w[key], m.index];
          changed();
        },
      }, el("div", { class: "dir-media-thumb" }, thumb),
         el("div", { class: "dir-media-txt" }, el("span", { class: "dir-media-name" }, m.name), sub ? el("small", {}, sub) : null),
         el("button", { class: "dir-x", type: "button", title: "Remove", onclick: (e) => { e.stopPropagation(); removeSlot(m.slot); changed(); } }, "×"));
      node.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(".dir-x")) return;
        let previewEl = null, overTrack = null, overWin = null, drop = null;
        const clear = () => {
          previewEl?.remove(); previewEl = null;
          overTrack?.classList.remove("over"); overTrack = null;
          overWin?.classList.remove("hover"); overWin = null;
        };
        pointerDrag(e, {
          source: node,
          build: () => [
            type === "image" ? el("img", { src: m.url, alt: "" }) : el("span", { class: "gh-icon" }, icon(type === "video" ? "film" : "audio")),
            el("span", {}, m.name),
            type !== "image" ? el("small", {}, `${fmt(meta.get(m.slot)?.duration || 0)}s`) : null,
          ],
          move: (ev) => {
            const hit = document.elementFromPoint(ev.clientX, ev.clientY);
            if (type === "image") {
              const win = hit?.closest(".dir-win") || null;
              if (win !== overWin) { overWin?.classList.remove("hover"); overWin = win; overWin?.classList.add("hover"); }
              drop = win ? winNodes.indexOf(win) : null;
              return;
            }
            const track = hit?.closest(type === "video" ? ".dir-track.vid" : ".dir-track.aud") || null;
            if (track !== overTrack) {
              overTrack?.classList.remove("over");
              overTrack = track;
              overTrack?.classList.add("over");
              if (previewEl) { previewEl.remove(); previewEl = null; }
            }
            if (!track) { drop = null; return; }
            const info = meta.get(m.slot);
            const dur = Math.max(MIN_LEN / FPS, info?.duration || 5);
            const rect = track.getBoundingClientRect();
            const start = Math.max(0, snap(Math.round((((ev.clientX - rect.left) - (dur * zoom) / 2) / zoom) * FPS)));
            if (!previewEl) previewEl = el("div", { class: "dir-drop-preview" });
            previewEl.style.left = `${px(start)}px`;
            previewEl.style.width = `${Math.max(24, dur * zoom)}px`;
            if (previewEl.parentElement !== track) track.append(previewEl);
            drop = start / FPS;
          },
          end: () => {
            const where = drop;
            clear();
            if (where === null || where === undefined) return;
            if (type === "image") {
              const w = st.windows[where];
              if (w && endpointMode()) { selected = where; drawSegment(); toast("Choose First frame or Last frame below."); }
              else if (w && !w.images.includes(m.index)) { selected = where; w.images = [...w.images, m.index]; changed(); }
              return;
            }
            const item = clipFor(type, m.index);
            item.start = where;
            changed();
          },
          click: () => {
            if (type === "video") return;
            const w = st.windows[selected];
            if (!w) return;
            const key = type === "image" ? "images" : "audios";
            w[key] = w[key].includes(m.index) ? w[key].filter((i) => i !== m.index) : [...w[key], m.index];
            changed();
          },
        });
      });
      return node;
    });

    const input = el("input", { type: "file", accept: MEDIA[type].accept, multiple: "true", hidden: "true" });
    input.addEventListener("change", () => {
      let any = false;
      for (const file of input.files || []) any = attachMedia(type, file) || any;
      input.value = "";
      if (any) draw();
    });
    const drop = el("div", { class: "dir-drop" }, icon("plus"), el("span", {}, `Drop ${MEDIA[type].label.toLowerCase()} or click`));
    drop.onclick = () => input.click();
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("over");
      let any = false;
      for (const file of e.dataTransfer?.files || []) any = attachMedia(type, file) || any;
      if (any) draw();
    });

    let extra = null;
    if (type === "audio") {
      const mode = el("select", { class: "dir-mini", title: "Audio mode for every reference audio" },
        el("option", { value: "reference" }, "Reference"), el("option", { value: "locked" }, "Keep original"));
      mode.value = f.values.audio_mode || "reference";
      mode.onchange = () => { f.values.audio_mode = mode.value; changed(); };
      extra = mode;
    } else if (type === "video") {
      const on = f.values.video_audio !== false;
      const b = el("button", { type: "button", class: `dir-mini-btn${on ? " on" : ""}`, title: "Use the videos' own sound" },
        icon(on ? "volume" : "mute"), on ? "sound" : "muted");
      b.onclick = () => { f.values.video_audio = !(f.values.video_audio !== false); changed(); };
      extra = b;
    }

    const library=type==="image" && endpointMode();
    const filter=()=>items.forEach((node,i)=>{node.style.display=list[i].name.toLowerCase().includes(pictureQuery.toLowerCase())?"":"none";});
    const search=library?el("input",{class:"dir-library-search",type:"search",placeholder:"Search pictures",value:pictureQuery,"aria-label":"Search picture library",oninput:e=>{pictureQuery=e.target.value;filter();}}):null;
    if(library)filter();
    return el("section", { class: `dir-bin-sec${library?" dir-image-library":""}` },
      el("h4", {}, icon(MEDIA[type].icon), MEDIA[type].label, extra, el("span", { class: "dir-count" }, library ? `${list.length} in library` : `${list.length}/${slotsOf(app, type).length}`)),
      search,el("div", { class: "dir-media-list" }, ...items), drop, input);
  }

  // ---------------------------------------------------------------- clips
  function clipFor(type, index) {
    const list = type === "video" ? st.videos : st.audios;
    let item = list.find((x) => x.index === index);
    const slot = mediaOf(app, f, type).find((m) => m.index === index)?.slot;
    const info = slot ? meta.get(slot) : null;
    const fallback = (st.windows[0] ? (st.windows[0].end - st.windows[0].start) / FPS : 5);
    if (!item) {
      item = {
        index, start: 0,
        duration: Math.max(MIN_LEN / FPS, Math.min(info?.duration || fallback, fallback)),
        trimStart: 0,
        sourceDuration: info?.duration || fallback,
      };
      if (type === "video") Object.assign(item, { width: info?.width || 0, height: info?.height || 0, hasAudio: f.values.video_audio !== false, referenceMode: "guide" });
      list.push(item);
    }
    // a clip created before its media finished probing gets corrected here: never claim more
    // source than the file really has
    if (info?.duration) {
      if (!item.sourceDuration || item.sourceDuration > info.duration + 0.05) item.sourceDuration = info.duration;
      const max = Math.max(MIN_LEN / FPS, item.sourceDuration - (item.trimStart || 0));
      if (item.duration > max) item.duration = max;
      if (type === "video") { item.width = info.width || item.width || 0; item.height = info.height || item.height || 0; }
    }
    return item;
  }

  function clipNode(type, m, item) {
    const narrow = item.duration * zoom < 96;
    const node = el("div", {
      class: `dir-clip ${type}${narrow ? " narrow" : ""}`, style: { left: `${item.start * zoom}px`, width: `${Math.max(26, item.duration * zoom)}px` },
      title: `${m.name} · start ${fmt(item.start)}s · ${fmt(item.duration)}s${item.trimStart ? ` · trim ${fmt(item.trimStart)}s` : ""}`,
    },
      el("span", { class: "dir-clip-name" }, m.name),
      el("span", { class: "dir-clip-dur" }, `${fmt(item.duration)}s`),
      el("button", { class: "dir-clip-x", type: "button", title: "Remove this clip",
        onclick: (e) => { e.stopPropagation(); removeSlot(m.slot); changed(); } }, "×"),
      el("span", { class: "dir-handle l", "data-edge": "l" }),
      el("span", { class: "dir-handle r", "data-edge": "r" }));

    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".dir-clip-x")) return;
      drag = { kind: "clip", type, index: m.index, edge: e.target?.dataset?.edge || null, x0: e.clientX,
               start: item.start, duration: item.duration, trimStart: item.trimStart || 0, sourceDuration: item.sourceDuration || item.duration + (item.trimStart || 0) };
      node.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    node.addEventListener("pointermove", (e) => {
      if (!drag || drag.kind !== "clip" || drag.type !== type || drag.index !== m.index) return;
      const d = (e.clientX - drag.x0) / zoom;
      const min = MIN_LEN / FPS;
      if (drag.edge === "r") {
        const max = Math.max(min, (drag.sourceDuration || Infinity) - drag.trimStart);
        const candidate = drag.duration + d;
        const snapped = snap(Math.round((drag.start + candidate) * FPS), -1, { type, index: m.index }) / FPS - drag.start;
        item.duration = clamp(Math.abs(snapped - candidate) < 0.2 ? snapped : candidate, min, max);
      } else if (drag.edge === "l") {
        const dTrim = clamp(d, -drag.trimStart, drag.duration - min);
        item.trimStart = drag.trimStart + dTrim;
        item.duration = drag.duration - dTrim;
        item.start = Math.max(0, drag.start + dTrim);
      } else {
        const raw = Math.max(0, drag.start + d);
        item.start = Math.max(0, snap(Math.round(raw * FPS), -1, { type, index: m.index }) / FPS);
      }
      node.style.left = `${item.start * zoom}px`;
      node.style.width = `${Math.max(26, item.duration * zoom)}px`;
      node.querySelector(".dir-clip-dur").textContent = `${fmt(item.duration)}s`;
    });
    node.addEventListener("pointerup", () => { if (drag?.kind === "clip") { drag = null; changed(); } });
    return node;
  }

  // ---------------------------------------------------------------- timeline
  const px = (frame) => (frame / FPS) * zoom;

  function windowNode(w, i) {
    const node = el("div", {
      class: `dir-win${i === selected ? " on" : ""}`,
      style: { left: `${px(w.start)}px`, width: `${Math.max(28, px(w.end - w.start))}px` },
      title: `${fmt(w.start / FPS)}s – ${fmt(w.end / FPS)}s · ${w.end - w.start} frames`,
    },
      el("span", { class: "dir-win-tag" }, `GEN ${i + 1}`),
      el("span", { class: "dir-win-time" }, `${fmt(w.start / FPS)}–${fmt(w.end / FPS)}s`),
      w.prompt ? el("span", { class: "dir-win-prompt" }, w.prompt) : null,
      el("span", { class: "dir-handle l", "data-edge": "l" }),
      el("span", { class: "dir-handle r", "data-edge": "r" }));

    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { kind: "win", i, edge: e.target?.dataset?.edge || null, x0: e.clientX,
               snap: JSON.parse(JSON.stringify(st.windows)) };
      if (selected !== i) {
        selected = i;
        winNodes.forEach((n, k) => n.classList.toggle("on", k === i));
        drawSegment();
      }
      node.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    node.addEventListener("pointermove", (e) => {
      if (!drag || drag.kind !== "win" || drag.i !== i) return;
      const delta = Math.round(((e.clientX - drag.x0) / zoom) * FPS);
      st.windows = JSON.parse(JSON.stringify(drag.snap));
      const cur = st.windows[i];
      if (drag.edge === "l") {
        const minStart = i === 0 ? 0 : Math.max(0, st.windows[i - 1].end - Math.min(Math.max(0, drag.snap[i - 1].end - drag.snap[i].start), cur.end - cur.start - 1));
        cur.start = clamp(snap(Math.round(cur.start + delta), i), minStart, cur.end - MIN_LEN);
      } else if (drag.edge === "r") {
        cur.end = Math.max(cur.start + MIN_LEN, snap(Math.round(cur.end + delta), i));
      } else {
        const len = cur.end - cur.start;
        const start = Math.max(0, cur.start + delta);
        const snappedStart = snap(Math.round(start), i);
        const snappedEnd = snap(Math.round(start + len), i);
        if (snappedStart !== Math.round(start)) { cur.start = snappedStart; cur.end = snappedStart + len; }
        else if (snappedEnd !== Math.round(start + len)) { cur.end = snappedEnd; cur.start = snappedEnd - len; }
        else { cur.start = start; cur.end = start + len; }
      }
      rippleH3Windows(st.windows, i, drag.snap, h3Planner);
      persistState(app, f, st);
      st.windows.forEach((x, k) => {
        const n = winNodes[k];
        if (!n) return;
        n.style.left = `${px(x.start)}px`;
        n.style.width = `${Math.max(28, px(x.end - x.start))}px`;
        n.querySelector(".dir-win-time").textContent = `${fmt(x.start / FPS)}–${fmt(x.end / FPS)}s`;
      });
      drawSegmentTime();
    });
    node.addEventListener("pointerup", () => {
      if (drag?.kind !== "win") return;
      const w = st.windows[i];
      // snap the length to a legal H3 value once the mouse is released
      w.end = w.start + alignedLength(w.end - w.start, MIN_LEN);
      rippleH3Windows(st.windows, i, drag.snap, h3Planner);
      drag = null;
      changed();
    });
    return node;
  }

  function drawRuler(width) {
    const ruler = el("div", { class: "dir-ruler", style: { width: `${width}px` } });
    const step = zoom >= 80 ? 1 : zoom >= 40 ? 2 : 5;
    for (let s = 0; s <= totalSeconds() + step; s += step) {
      ruler.append(el("span", { class: "dir-tick", style: { left: `${s * zoom}px` } }, el("i"), `${s}s`));
    }
    return ruler;
  }

  function drawTracks() {
    const width = Math.max(px(totalFrames()) + 80, stage.clientWidth - 24);
    const gen = el("div", { class: "dir-track gen", style: { width: `${width}px` } });
    winNodes = [];
    st.windows.forEach((w, i) => { const n = windowNode(w, i); winNodes.push(n); gen.append(n); });

    const vids = el("div", { class: "dir-track vid", style: { width: `${width}px` } });
    for (const m of mediaOf(app, f, "video")) vids.append(clipNode("video", m, clipFor("video", m.index)));
    const auds = el("div", { class: "dir-track aud", style: { width: `${width}px` } });
    for (const m of mediaOf(app, f, "audio")) auds.append(clipNode("audio", m, clipFor("audio", m.index)));



    const playhead = el("div", { class: "dir-playhead", style: { left: "0px" } });
    snapLine = el("div", { class: "dir-snap", style: { display: "none" } });
    const wrap = el("div", { class: "dir-scroll" },
      el("div", { class: "dir-canvas", style: { width: `${width}px` } },
        drawRuler(width),
        el("div", { class: "dir-track-lbl", style: { top: "34px" } }, "GEN"), gen,
        el("div", { class: "dir-track-lbl", style: { top: "108px" } }, "VID"), vids,
        el("div", { class: "dir-track-lbl", style: { top: "158px" } }, "AUD"), auds,
        playhead, snapLine));

    wrap.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".dir-win, .dir-clip")) return;
      const x = e.clientX - wrap.getBoundingClientRect().left + wrap.scrollLeft - 56;
      playheadFrame = Math.max(0, Math.round((x / zoom) * FPS));
      playhead.style.left = `${56 + px(playheadFrame)}px`;
    });
    stage.replaceChildren(wrap);
  }

  // ---------------------------------------------------------------- segment editor
  function drawSegmentTime() {
    const w = st.windows[selected];
    const node = segEl.querySelector(".dir-seg-time");
    if (w && node) node.textContent = `${fmt(w.start / FPS)}s → ${fmt(w.end / FPS)}s · ${w.end - w.start} frames · ${fmt((w.end - w.start) / FPS)}s`;
  }

  function drawSegment() {
    const w = st.windows[selected] || st.windows[0];
    if (!w) { segEl.replaceChildren(el("p", { class: "dim" }, "No segment")); return; }

    const startField = el("input", { class: "dir-num wide", type: "number", min: "0", step: String(1 / FPS), value: (w.start / FPS).toFixed(3), title: "Start (s)" });
    const lenField = el("input", { class: "dir-num wide", type: "number", min: String(MIN_LEN / FPS), step: String(1 / FPS), value: ((w.end - w.start) / FPS).toFixed(3), title: "Length (s)" });
    startField.onchange = () => {
      const start = clamp(Math.round(Number(startField.value) * FPS) || 0, 0, w.end - MIN_LEN);
      w.start = start; changed();
    };
    lenField.onchange = () => {
      const before = st.windows.map(w => ({ ...w }));
      const len = Math.max(MIN_LEN, Math.round(Number(lenField.value) * FPS) || MIN_LEN);
      w.end = w.start + len;
      rippleH3Windows(st.windows, selected, before, h3Planner);
      changed();
    };
    const snap = el("button", { type: "button", class: "btn small ghost", title: "Snap this window's length to an H3-legal 5+17n frame count",
      onclick: () => {
        const before = st.windows.map(w => ({ ...w }));
        w.end = w.start + alignedLength(w.end - w.start, MIN_LEN);
        rippleH3Windows(st.windows, selected, before, h3Planner);
        changed();
      } }, h3Planner ? "H3" : "Snap");

    const prompt = el("textarea", { class: "dir-prompt", rows: "3", placeholder: "Prompt for this segment (empty: the global prompt is used)", value: w.prompt || "" });
    prompt.addEventListener("input", () => { w.prompt = prompt.value; persistState(app, f, st); saveDirty(); drawTracks(); });
    const promptBox = el("div", { class: "dir-prompt-box" }, prompt,
      enhancerAvailable ? el("div", { class: "dir-prompt-tools" },
        el("button", {
          type: "button", class: `btn small ghost dir-enhance${promptBusy ? " busy" : ""}`, disabled: promptBusy,
          title: promptBusy ? "Qwen is writing this prompt; the video renderer is not running" : "Rewrite this segment prompt with Qwen3.8; this does not start the video renderer",
          "aria-busy": promptBusy ? "true" : undefined,
          onclick: () => void generatePrompts(selected, false),
        }, promptBusy ? promptSpinner() : icon("spark"), promptBusy ? (promptProgress && promptProgress.total > 1 ? `Writing ${promptProgress.done}/${promptProgress.total}…` : "Writing…") : "Generate prompt")) : null);

    const imgs = mediaOf(app, f, "image");
    const auds = mediaOf(app, f, "audio");
    const videos = mediaOf(app, f, "video");
    const move = (list, from, to) => {
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
      const [x] = list.splice(from, 1);
      list.splice(to, 0, x);
    };

    const assignedChip = (type, index, pos, total) => {
      const key = type === "image" ? "images" : "audios";
      const m = (type === "image" ? imgs : auds).find((x) => x.index === index);
      if (!m) return null;
      const locked = type === "audio" && (f.values.audio_mode || "reference") === "locked";
      const ordinal = type === "image" ? pos + 1 : w.audios.slice(0, pos + 1).filter((i) => (f.values.audio_mode || "reference") !== "locked").length;
      const label = type === "image" ? `<Picture ${ordinal}>` : locked ? "LOCK" : `<Audio ${ordinal}>`;
      const chip = el("div", { class: `dir-chip on ordered${locked ? " locked" : ""}`, draggable: "true", title: `${m.name} — drag to reorder` },
        el("b", { class: "dir-chip-ord" }, label),
        type === "image" ? el("img", { src: m.url, alt: m.name }) : icon("audio"),
        el("span", {}, m.name),
        el("span", { class: "dir-chip-move" },
          el("button", { type: "button", class: "dir-mv", title: "Move earlier", disabled: pos === 0 ? "true" : undefined, onclick: (e) => { e.stopPropagation(); move(w[key], pos, pos - 1); changed(); } }, "◀"),
          el("button", { type: "button", class: "dir-mv", title: "Move later", disabled: pos === total - 1 ? "true" : undefined, onclick: (e) => { e.stopPropagation(); move(w[key], pos, pos + 1); changed(); } }, "▶")),
        el("button", { type: "button", class: "dir-mv x", title: "Remove from this segment", onclick: (e) => { e.stopPropagation(); w[key] = w[key].filter((i) => i !== index); changed(); } }, "×"));
      chip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button")) return;
        let to = pos;
        const clear = () => document.querySelectorAll(".dir-chip.drop-before, .dir-chip.drop-after")
          .forEach((n) => n.classList.remove("drop-before", "drop-after"));
        pointerDrag(e, {
          source: chip,
          build: () => [type === "image" ? el("img", { src: m.url, alt: "" }) : el("span", { class: "gh-icon" }, icon("audio")), el("b", {}, label), el("span", {}, m.name)],
          move: (ev) => {
            const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".dir-chip.ordered");
            if (!over) { clear(); return; }
            if (over === chip) { clear(); return; }
            const rect = over.getBoundingClientRect();
            const after = ev.clientX > rect.left + rect.width / 2;
            clear();
            over.classList.add(after ? "drop-after" : "drop-before");
            const target = Number(over.dataset.pos);
            to = after ? target + 1 : target;
          },
          end: () => {
            clear();
            if (to === pos) return;
            const list = w[key];
            const [x] = list.splice(pos, 1);
            list.splice(to > pos ? to - 1 : to, 0, x);
            changed();
          },
        });
      });
      chip.dataset.pos = String(pos);
      return chip;
    };

    const addChip = (type, m) => el("button", {
      type: "button", class: "dir-chip", title: "Add to this segment",
      onclick: () => { const key = type === "image" ? "images" : "audios"; w[key] = [...w[key], m.index]; changed(); },
    }, type === "image" ? el("img", { src: m.url, alt: m.name }) : icon("audio"), el("span", {}, m.name));

    // video clips overlapping this window: read-only, they follow the timeline
    const overlaps = st.windows[selected] ? st.videos.filter((v) => {
      const end = v.start + v.duration;
      return end > w.start / FPS && v.start < w.end / FPS;
    }) : [];
    const videoChips = overlaps.map((v) => {
      const m = videos.find((x) => x.index === v.index);
      if (!m) return null;
      const mode = el("select", { class: "dir-mini", title: "Reference mode for this clip" },
        el("option", { value: "guide" }, "guide"),
        el("option", { value: "edit" }, "edit"),
        el("option", { value: "boundary" }, "boundary"));
      mode.value = v.referenceMode || "guide";
      mode.onchange = () => { v.referenceMode = mode.value; persistState(app, f, st); saveDirty(); };
      return el("span", { class: "dir-chip on ghost", title: `${m.name} · ${fmt(v.start)}s → ${fmt(v.start + v.duration)}s` },
        icon("film"), el("span", {}, m.name), el("small", {}, `${fmt(v.duration)}s`), mode);
    }).filter(Boolean);

    const framePicker = (key, label) => {
      const selectedFrame = imgs.find(m => m.index === w[key]);
      const select = el("select", { class: "dir-frame-select", "aria-label": `${label} (optional)`,
        onchange: e => {
          if (e.target.value === "") delete w[key]; else w[key] = Number(e.target.value);
          changed();
        } },
        el("option", { value: "" }, "None — optional"),
        ...imgs.map(m => el("option", { value: String(m.index) }, m.name)));
      select.value = selectedFrame ? String(selectedFrame.index) : "";
      return [el("span", { class: "dir-assign-lbl" }, label),
        el("div", { class: "dir-chips dir-frame", "data-frame": key },
          selectedFrame ? el("img", { src: selectedFrame.url, alt: `${label}: ${selectedFrame.name}` }) : null,
          select)];
    };
    const imageControls = endpointMode()
      ? [...framePicker("first_frame", "First frame"), ...framePicker("last_frame", "Last frame"),
        el("span", {class:"dir-assign-lbl"}, "Conditioning"),
        el("span", {class:"dim"}, "Both frames are optional. Leave both empty for text-to-video.")]
      : [el("span", { class: "dir-assign-lbl" }, "Add picture"),
        imgs.length
          ? (imgs.some(m => !w.images.includes(m.index))
            ? el("div", {class:"dir-chips"}, ...imgs.filter(m => !w.images.includes(m.index)).map(m => addChip("image", m)))
            : el("span", {class:"dim"}, "all pictures assigned"))
          : el("span", {class:"dim"}, "none — optional, pure text-to-video")];

    segEl.replaceChildren(
      el("div", { class: "dir-seg-head" },
        el("span", { class: "dir-seg-title" }, `Segment ${selected + 1}`),
        el("div", { class: "dir-seg-fields" },
          el("label", {}, "start", startField, el("span", { class: "unit" }, "s")),
          el("label", {}, "length", lenField, el("span", { class: "unit" }, "s"), snap)),
        el("span", { class: "dir-seg-time" }, `${fmt(w.start / FPS)}s → ${fmt(w.end / FPS)}s · ${w.end - w.start} frames · ${fmt((w.end - w.start) / FPS)}s`),
        el("div", { class: "dir-seg-actions" },
          el("button", { type: "button", class: "btn small ghost", onclick: () => {
            const last = st.windows[st.windows.length - 1];
            const len = last.end - last.start;
            const start = last.end - Math.min(defaultSeam, len - 1);
            st.windows.push({ start, end: start + len, prompt: "", images: h3Planner ? (endpointMode() ? [] : allPictures()) : [...last.images], audios: [...last.audios] });
            selected = st.windows.length - 1; changed();
          } }, icon("plus"), "Segment"),
          el("button", { type: "button", class: "btn small ghost", disabled: st.windows.length <= 1 ? "true" : undefined, onclick: () => {
            if (st.windows.length <= 1) return;
            const [removed] = st.windows.splice(selected, 1);
            const gap = Math.max(0, removed.end - removed.start);
            for (let i = selected; i < st.windows.length; i++) {
              const w = st.windows[i];
              w.start = Math.max(0, w.start - gap);
              w.end = Math.max(w.start + MIN_LEN, w.end - gap);
            }
            selected = Math.max(0, selected - 1);
            if (st.windows[0]) st.windows[0].start = 0;
            changed();
          } }, "Remove"))),
      promptBox,
      el("div", { class: "dir-assign" },
        el("span", { class: "dir-assign-lbl" }, endpointMode() ? "Audio in segment" : "In this segment"),
        el("div", { class: "dir-chips" },
          ...(endpointMode() ? [] : w.images.map((idx, pos) => assignedChip("image", idx, pos, w.images.length)).filter(Boolean)),
          ...w.audios.map((idx, pos) => assignedChip("audio", idx, pos, w.audios.length)).filter(Boolean),
          (endpointMode() || !w.images.length) && !w.audios.length ? el("span", { class: "dim" }, "nothing yet") : null),
        el("span", { class: "dir-assign-lbl" }, "Videos here"),
        videoChips.length ? el("div", { class: "dir-chips" }, ...videoChips) : el("span", { class: "dim" }, "no video clip overlaps this window"),
        ...imageControls,
        el("span", { class: "dir-assign-lbl" }, "Add audio"),
        auds.length
          ? (auds.some((m) => !w.audios.includes(m.index))
            ? el("div", { class: "dir-chips" }, ...auds.filter((m) => !w.audios.includes(m.index)).map((m) => addChip("audio", m)))
            : el("span", { class: "dim" }, "all audio assigned"))
          : el("span", { class: "dim" }, "none")));
  }

  function openBatch() {
    const fixed = app.id === "ltx-director-4seg" ? 4 : null;
    const countMax = Number(app.inputs.find((i) => i.id === "segment_count")?.max);
    const max = fixed ?? (Number.isFinite(countMax) && countMax > 0 ? countMax : 512);
    const selectedWindow = st.windows[selected];
    const fallbackSeconds = selectedWindow ? Math.max(MIN_LEN / FPS, (selectedWindow.end - selectedWindow.start) / FPS) : (Number(f.values.duration) || 5);
    const dialog = modal("Paste prompts", "One prompt per line. Add ,13 for 13 seconds, or ,13,3 for 13 seconds with a 3-second overlap. Lines without values use hard cuts by default. Use overlap only to extend the same continuous camera take, for example beyond 15 seconds.");
    const ta = el("textarea", { class: "dir-prompt", rows: "12", placeholder: "Wide shot of the room,13\nShe turns toward the window,8\nClose-up on her eyes,5" });
    const fallback = el("input", { class: "dir-num", type: "number", min: String(MIN_LEN / FPS), max: "30", step: "0.1", value: String(fallbackSeconds) });
    const overlap = el("input", { class: "dir-num wide", type: "range", min: "0", max: "10", step: "0.1", value: String(defaultSeam / FPS), style: { width: "160px" } });
    const overlapValue = el("span", { class: "unit" }, `${(defaultSeam / FPS).toFixed(1)}s`);
    const forceAll = el("input", { type: "checkbox" });
    const info = el("p", { class: "help", style: { margin: "0" } }, "0 segments");
    const refresh = () => {
      const snapped = snapOverlap(Number(overlap.value));
      overlapValue.textContent = `${snapped.toFixed(2)}s`;
      const parsed = parseBatchPrompts(ta.value, Math.max(MIN_LEN / FPS, Math.min(30, Number(fallback.value) || 5)), snapped);
      info.textContent = `${parsed.length} segment${parsed.length === 1 ? "" : "s"} · ${max} max · ${snapped.toFixed(2)}s default overlap`;
    };
    ta.addEventListener("input", refresh);
    fallback.addEventListener("input", refresh);
    overlap.addEventListener("input", refresh);
    forceAll.addEventListener("change", refresh);
    const make = (replace) => {
      let prompts = parseBatchPrompts(ta.value, Math.max(MIN_LEN / FPS, Math.min(30, Number(fallback.value) || 5)), Number(overlap.value));
      if (forceAll.checked) prompts = prompts.map((p) => ({ ...p, overlap: snapOverlap(Number(overlap.value)) }));
      else prompts = prompts.map((p) => ({ ...p, overlap: snapOverlap(p.overlap) }));
      if (replace && fixed && prompts.length < fixed) {
        while (prompts.length < fixed) prompts.push({ prompt: "", duration: Math.max(MIN_LEN / FPS, Number(fallback.value) || fallbackSeconds), overlap: snapOverlap(Number(overlap.value)) });
      }
      if (!prompts.length) return toast("Paste at least one prompt.", { error: true });
      if ((replace ? 0 : st.windows.length) + prompts.length > max) {
        return toast(`This director accepts at most ${max} segments.`, { error: true });
      }
      const old = st.windows;
      const next = [];
      const everyPicture = h3Planner ? (endpointMode() ? [] : allPictures()) : null;
      for (let index = 0; index < prompts.length; index += 1) {
        const item = prompts[index];
        const len = alignedLength(Math.max(MIN_LEN, Math.round(item.duration * FPS)), MIN_LEN);
        const previous = next.length ? next[next.length - 1] : (replace ? null : old[old.length - 1]);
        const overlapFrames = previous
          ? Math.max(0, Math.min(Math.round(item.overlap * FPS), len - 1, (previous.end - previous.start) - 1))
          : 0;
        const start = previous ? Math.max(0, previous.end - overlapFrames) : (replace ? 0 : (old[old.length - 1]?.end ?? 0));
        const end = start + len;
        if (end > MAX_LENGTH) return toast(`The batch goes past ${MAX_LENGTH} frames.`, { error: true });
        const media = replace ? old[index] : old[old.length - 1];
        next.push({
          start, end, prompt: item.prompt,
          images: h3Planner ? (endpointMode() ? [...(media?.images || [])] : [...everyPicture]) : [...(media?.images || [])],
          ...(replace && media?.first_frame !== undefined ? {first_frame:media.first_frame} : {}),
          ...(replace && media?.last_frame !== undefined ? {last_frame:media.last_frame} : {}),
          audios: [...(media?.audios || [])],
        });
      }
      if (replace) {
        st.windows = next;
        selected = 0;
      } else {
        selected = st.windows.length;
        st.windows.push(...next);
      }
      persistState(app, f, st);
      saveDirty();
      dialog.close();
      changed();
      toast(`${prompts.length} segment${prompts.length === 1 ? "" : "s"} ${replace ? "created" : "added"}.`);
    };
    dialog.append(el("div", { class: "ag-dialog-form" },
      ta,
      el("div", { class: "dir-seg-fields" },
        el("label", {}, "default length", fallback, el("span", { class: "unit" }, "s")),
        el("label", {}, "overlap (0 = hard cut)", overlap, overlapValue),
        info),
      el("label", { style: { display: "flex", alignItems: "center", gap: "7px", fontSize: "11.5px", color: "var(--dim)" } },
        forceAll, "Apply the slider overlap to every pasted segment"),
      el("p", { class: "help", style: { margin: "0" } },
        h3Planner
          ? "H3 overlaps snap to 0, 1 or 5 + 17n frames; a requested 3s becomes the nearest legal value (~3.04s). A trailing ,N is duration; a second ,N is overlap. Existing pictures and sounds are kept by index on Replace; Append copies the last segment’s assignments."
          : "A trailing ,N becomes duration; a second ,N becomes the overlap with the previous segment. Existing pictures and sounds are kept by segment index on Replace; Append copies the last segment’s assignments."),
      el("div", { class: "ag-dialog-actions" },
        el("button", { class: "btn ghost", type: "button", onclick: () => make(false) }, icon("plus"), "Append segments"),
        el("button", { class: "btn lime", type: "button", onclick: () => make(true) }, icon("film"), "Replace segments"))));
    dialog.showModal();
    ta.focus();
    refresh();
  }

  /** Compact Build & Test / Production strip. It only edits render settings; Generate stays in the footer. */
  function drawRenderProfile() {
    if (!renderEl) return;
    if (!profiles) { renderEl.replaceChildren(); renderEl.hidden = true; return; }
    renderEl.hidden = false;
    const active = f.values.render_profile === "production" ? "production" : "build";
    const group = el("div", { class: "dir-profile-seg", role: "group", "aria-label": "Render profile" },
      ...["build", "production"].map((id) => el("button", {
        type: "button", "aria-pressed": String(active === id),
        title: id === "build" ? `${fmtMp(profiles.build_megapixels)} preview, upscale disabled` : "Production generation at its own resolution",
        onclick: () => chooseRenderProfile(id),
      }, id === "build" ? "Build & Test" : "Production")));
    const meta = renderMetadata(app, f.values);
    if (active === "build") {
      const prefMp = Number(f.values.production_megapixels);
      const prefFactor = UPSCALE_FACTORS[String(f.values.production_upscale || "")] || UPSCALE_FACTORS[""];
      const kept = Number.isFinite(prefMp) && (prefFactor.linear > 1 || Math.abs(prefMp - profiles.production_default_megapixels) > 1e-6);
      const note = el("span", { class: "dir-render-note" },
        el("b", {}, fmtMp(profiles.build_megapixels)), " · native, no upscale",
        kept ? el("small", {}, `Production kept: ${fmtMp(prefMp)} · ${prefFactor.label}`) : null);
      const native = meta?.generation?.width ? `${meta.generation.width} × ${meta.generation.height} · ${meta.generation.megapixels.toFixed(2)} MP` : "native resolution";
      renderEl.replaceChildren(group, note, el("span", { class: "dir-render-res single" }, el("small", {}, "Preview"), el("b", {}, native)));
      return;
    }
    const gen = profiles.generation;
    const currentMp = Number(f.values.production_megapixels ?? profiles.production_default_megapixels);
    const readout = el("span", { class: "dir-render-res" });
    const updateReadout = () => {
      const next = renderMetadata(app, f.values);
      if (!next?.generation?.width || !next.output) { readout.replaceChildren(); return; }
      const native = `${next.generation.width} × ${next.generation.height}`;
      const final = `${next.output.width} × ${next.output.height}`;
      readout.replaceChildren(
        el("span", { class: "dir-render-res-item" }, el("small", {}, "Native"), el("b", {}, native), el("small", {}, `${next.generation.megapixels.toFixed(2)} MP`)),
        el("span", { class: "dir-render-arrow" }, "→"),
        el("span", { class: "dir-render-res-item final" }, el("small", {}, "Final ≈"), el("b", {}, final), el("small", {},
          next.upscale === "off" ? `${next.output.megapixels.toFixed(2)} MP · no upscale` : `${next.output.megapixels.toFixed(2)} MP · ${next.upscale_linear_factor}× linear · ${next.upscale_pixel_area_factor}× pixels`)));
    };
    const mp = el("input", { class: "dir-range", type: "range", min: String(gen.min), max: String(gen.max), step: String(gen.step), value: String(currentMp), "aria-label": "Production generation resolution" });
    const mpValue = el("b", { class: "dir-render-value" }, fmtMp(currentMp));
    mp.addEventListener("input", () => {
      const value = Number(mp.value);
      f.values.production_megapixels = value;
      f.values.megapixels = value;
      mpValue.textContent = fmtMp(value);
      saveDirty();
      updateReadout();
    });
    const resolution = el("label", { class: "dir-render-field" }, el("span", {}, "Resolution"), mp, mpValue);
    let upscale = null;
    if (profiles.upscale) {
      const chosenRaw = String(f.values.production_upscale ?? "");
      const chosen = chosenRaw === "off" ? "" : chosenRaw;
      upscale = el("div", { class: "dir-render-field", role: "group", "aria-label": "Production upscale" },
        el("span", {}, "RelayVSR"),
        el("div", { class: "dir-upscale-seg" }, ...profiles.upscale.options.map((option) => el("button", {
          type: "button", "aria-pressed": String(option.value === chosen), title: `${option.label} · ${option.linear_factor}× linear, ${option.pixel_area_factor}× pixel area`,
          onclick: () => {
            const result = resolveRenderProfile(app, { ...f.values, render_profile: "production", production_upscale: option.value, upscale: option.value });
            if (result.errors.length) { toast(result.errors[0].message, { error: true }); return; }
            adoptProfile(result.values);
            saveDirty();
            draw();
          },
        }, option.value ? option.value.toUpperCase() : "Off"))));
    }
    let detail = null;
    const detailUpscale = String(f.values.production_upscale || "") === "off" ? "" : String(f.values.production_upscale || "");
    if (profiles.detail && detailUpscale) {
      const value = Number(f.values.production_upscale_detail ?? profiles.detail.default);
      const slider = el("input", { class: "dir-range", type: "range", min: String(profiles.detail.min), max: String(profiles.detail.max), step: String(profiles.detail.step), value: String(value), "aria-label": "RelayVSR detail", title: "How much of the Flash decoder restoration on top of a plain bicubic upscale is kept. 1 is the full model output." });
      const shown = el("b", { class: "dir-render-value" }, fmt(value));
      slider.addEventListener("input", () => {
        const next = Number(slider.value);
        f.values.production_upscale_detail = next;
        f.values.upscale_detail = next;
        shown.textContent = fmt(next);
        saveDirty();
      });
      detail = el("label", { class: "dir-render-field" }, el("span", {}, "Detail"), slider, shown);
    }
    updateReadout();
    renderEl.replaceChildren(...[group, resolution, upscale, detail, readout].filter(Boolean));
  }

  function drawHead() {
    const hasTwoStage = app.inputs.some((i) => i.id === "two_stage");
    const two = hasTwoStage ? el("button", {
      type: "button", class: `dir-toggle${f.values.two_stage ? " on" : ""}`,
      onclick: () => { f.values.two_stage = !f.values.two_stage; saveDirty(); draw(); },
    }, icon("spark"), "Two-stage") : null;
    let upscaler = null;
    if (f.values.two_stage) {
      const options = (app.inputs.find((i) => i.id === "upscaler")?.options || []).filter((o) => o.value);
      const sel = el("select", { class: "dir-sel", title: "Latent upscaler" }, ...options.map((o) => el("option", { value: o.value }, o.label || o.value)));
      sel.value = f.values.upscaler || (options[0]?.value ?? "");
      sel.onchange = () => { f.values.upscaler = sel.value; saveDirty(); };
      const steps = el("input", { class: "dir-num", type: "number", min: "0", max: "20", step: "1", value: String(f.values.high_steps ?? 2), title: "High-resolution steps" });
      steps.onchange = () => { f.values.high_steps = clamp(Number(steps.value) || 0, 0, 20); saveDirty(); };
      upscaler = el("div", { class: "dir-two" }, sel, el("span", {}, "hi-steps"), steps);
    }
    const ws = root.closest(".ws");
    const collapsed = ws?.classList.contains("collapsed");
    const settings = el("button", { type: "button", class: `dir-toggle${collapsed ? "" : " on"}`, title: "Show or hide the technical settings",
      onclick: () => { ws?.classList.toggle("collapsed"); draw(); } }, icon("sliders"), collapsed ? "Settings" : "Hide settings");
    const zoomOut = el("button", { type: "button", class: "dir-zoom", title: "Zoom out", onclick: () => { zoom = Math.max(18, zoom - 14); store.set("dir.zoom", zoom); draw(); } }, "−");
    const zoomIn = el("button", { type: "button", class: "dir-zoom", title: "Zoom in", onclick: () => { zoom = Math.min(300, zoom + 14); store.set("dir.zoom", zoom); draw(); } }, "+");
    headEl.replaceChildren(
      el("div", { class: "dir-brand" }, icon("film"), el("span", {}, app.panel_title || "Material Planner"), el("small", {}, `${st.windows.length} segment${st.windows.length > 1 ? "s" : ""} · ${fmt(totalSeconds())}s · ${totalFrames()} frames`)),
      el("div", { class: "dir-head-right" }, ...[
        String(f.values.production_id || "").trim() ? el("a", {
          class: "dir-toggle", href: `#/productions/${encodeURIComponent(String(f.values.production_id))}`,
          title: "Open this scene in Production Studio",
        }, icon("film"), "Production") : null,
        enhancerAvailable ? el("button", {
          type: "button", class: `dir-toggle${promptBusy ? " busy" : ""}`, disabled: promptBusy,
          title: promptBusy ? "Qwen is writing the whole timeline; the video renderer is not running" : "Generate prompts for every segment with Qwen3.8; this does not start the video renderer",
          "aria-busy": promptBusy ? "true" : undefined,
          onclick: () => void generatePrompts(undefined, true),
        }, promptBusy ? promptSpinner() : icon("spark"), promptBusy ? (promptProgress ? `Writing ${promptProgress.done}/${promptProgress.total}…` : "Writing prompts…") : "Generate all prompts") : null,
        el("button", { type: "button", class: "dir-toggle", onclick: () => openBatch() }, icon("code"), "Paste prompts"),
        settings, two, upscaler, el("div", { class: "dir-zoombox" }, zoomOut, el("span", {}, `${Math.round(zoom)} px/s`), zoomIn),
      ].filter(Boolean)));
  }

  function drawFoot() {
    const prompt = el("textarea", { class: "dir-global", rows: "2", placeholder: "Global prompt — used by every segment whose own prompt is empty", value: f.values.global_prompt || "" });
    prompt.addEventListener("input", () => { f.values.global_prompt = prompt.value; saveDirty(); });
    const go = el("button", { class: "btn dir-go", type: "button" }, icon("spark"), "Generate");
    go.onclick = () => {
      if (normalizeOverlaps()) { persistState(app, f, st); saveDirty(); draw(); }
      onSubmit?.();
    };
    footEl.replaceChildren(el("div", { class: "dir-global-wrap" }, prompt), go);
  }

  function draw() {
    // Existing timelines can carry an overlap created before the H3 snapping rule. Repair
    // it on load and on every redraw, not only when the user presses Generate.
    if (normalizeOverlaps()) { persistState(app, f, st); saveDirty(); }
    // normalise clip durations against the probed media before anything renders
    for (const m of mediaOf(app, f, "video")) clipFor("video", m.index);
    for (const m of mediaOf(app, f, "audio")) clipFor("audio", m.index);
    binEl.replaceChildren(binSection("image"), binSection("video"), binSection("audio"));
    drawHead();
    drawRenderProfile();
    drawSegment();
    drawFoot();
    drawTracks();
  }

  binEl = el("aside", { class: "dir-bin" });
  stage = el("section", { class: "dir-stage" });
  segEl = el("section", { class: "dir-seg" });
  headEl = el("header", { class: "dir-head" });
  footEl = el("footer", { class: "dir-foot" });
  renderEl = el("div", { class: "dir-render" });

  ensureRenderProfile(freshSession);
  root.append(headEl, renderEl, el("div", { class: "dir-body" }, binEl, el("div", { class: "dir-main" }, stage, segEl)), footEl);
  draw();
  for (const [slot, x] of Object.entries(f.files)) if (slot.startsWith("image") && x?.file) rememberMedia(slot, x.file);
  persistState(app, f, st);
  saveDirty();
  void restoreProject();
  return root;
}

// -------------------------------------------------------------------- state
const stateCache = new Map();
const META_CACHE = new Map();

function mediaMeta() {
  return META_CACHE;
}

function emptyState(seconds) {
  const len = alignedLength(Math.max(MIN_LEN, Math.round(seconds * FPS)));
  return { windows: [{ start: 0, end: len, prompt: "", images: [], audios: [] }], videos: [], audios: [] };
}

function parseState(f) {
  const raw = f.values.segment_windows;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.windows) && s.windows.length) {
        s.videos = Array.isArray(s.videos) ? s.videos : [];
        s.audios = Array.isArray(s.audios) ? s.audios : [];
        for (const w of s.windows) {
          w.images = Array.isArray(w.images) ? w.images : [];
          w.audios = Array.isArray(w.audios) ? w.audios : [];
          w.prompt = w.prompt || "";
        }
        return s;
      }
    } catch { /* fresh state below */ }
  }
  return emptyState(Number(f.values.duration) || 5);
}

function stateFor(app, f) {
  // The state is derived from values.segment_windows; keying only by app.id kept the
  // old timeline after Load this example (or any external value change). Compare the
  // raw string and re-parse when it moved.
  const raw = typeof f.values.segment_windows === "string" ? f.values.segment_windows : "";
  const hit = stateCache.get(app.id);
  if (hit && hit.raw === raw) return hit.state;
  const state = parseState(f);
  stateCache.set(app.id, { raw, state });
  return state;
}

function persistState(app, f, st) {
  if (app.inputs.some(i => i.id === "segment_count")) st.conditioning_mode = directorConditioningMode({...f.values, ...f.files});
  f.values.segment_windows = JSON.stringify(st);
  const first = st.windows[0];
  if (first) f.values.duration = +(((first.end - first.start) / FPS).toFixed(2));
  f.values.segment_count = st.windows.length;
}
