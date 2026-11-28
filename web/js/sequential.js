import {blankSegment} from "./sequential-state.js";
// LTX Sequential Director — a chain of LTX 2.5 I2V / first-and-last-frame runs.
//
// Each segment is its own History run. The panel always asks the server for the last
// frame export, then uploads that frame as the next run's first image. A "cut" checkbox
// deliberately replaces the handoff with a new start image. Nothing links the segment
// videos until the user approves them and presses Assemble; assembly is the bounded
// server-side fast concat.
import { api, el, icon, store, toast } from "./util.js";
import { modal } from "./agent-controls.js";
import { feed } from "./feed.js";

const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired", "lost"]);
const PER_SEGMENT = new Set(["image", "last_frame", "last_frame_enabled", "prompt", "duration", "last_frame_export"]);
const cache = new Map();
const MAX_SEGMENTS = 512;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultOf(app, id, fallback) {
  return app.inputs.find((i) => i.id === id)?.default ?? fallback;
}


function stateFor(app) {
  let st = cache.get(app.id);
  if (!st) {
    st = restore(app) || { selected: 0, start: null, startUrl: null, startData: null, segments: Array.from({ length: 4 }, () => blankSegment(app)), assembled: null, assembling: false, busyAll: false, stopAfter: false, autoError: null };
    if (!Number.isInteger(st.selected)) st.selected = 0;
    st.selected = Math.max(0, Math.min(st.segments.length - 1, st.selected));
    cache.set(app.id, st);
  }
  return st;
}

function revoke(url) {
  if (typeof url === "string" && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

async function fileFromUrl(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read ${url}`);
  const blob = await res.blob();
  const ext = (/\\.([a-z0-9]+)(?:\\?|$)/i.exec(url)?.[1] || "png").toLowerCase();
  return new File([blob], name.replace(/\\.[^.]+$/, `.${ext}`), { type: blob.type || "image/png" });
}

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    if (!file || file.size > 3_500_000 || typeof FileReader === "undefined") return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function dataUrlToFile(data, name) {
  const res = await fetch(data);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || "image/png" });
}

function invalidationFrom(st, index) {
  for (let i = index; i < st.segments.length; i += 1) {
    if (i > index && st.segments[i].cut) break;
    const seg = st.segments[i];
    seg.approved = false;
    if (seg.videoUrl) seg.stale = true;
  }
}

function settingsKey(app, f) {
  const values = {};
  for (const inp of app.inputs) {
    if (PER_SEGMENT.has(inp.id) || ["prompt_enhancer", "enhancer_model", "prompt_context"].includes(inp.id)) continue;
    values[inp.id] = f.values[inp.id];
  }
  return JSON.stringify(values);
}

function persist(st, app) {
  const clone = {
    ...st,
    start: null,
    segments: st.segments.map((s) => ({ ...s, last: null, cutStart: null })),
  };
  if (typeof clone.startUrl === "string" && (clone.startUrl.startsWith("blob:") || clone.startUrl.startsWith("data:"))) clone.startUrl = null;
  for (const seg of clone.segments) {
    if (typeof seg.lastUrl === "string" && (seg.lastUrl.startsWith("blob:") || seg.lastUrl.startsWith("data:"))) seg.lastUrl = null;
    if (typeof seg.cutStartUrl === "string" && (seg.cutStartUrl.startsWith("blob:") || seg.cutStartUrl.startsWith("data:"))) seg.cutStartUrl = null;
  }
  store.set(`seq.${app.id}`, clone);
}

function restore(app) {
  const saved = store.get(`seq.${app.id}`);
  if (!saved || !Array.isArray(saved.segments) || !saved.segments.length) return null;
  const st = {
    ...saved,
    start: null,
    assembling: false,
    busyAll: false,
    stopAfter: false,
    segments: saved.segments.map((s) => ({
      ...blankSegment(app),
      ...s,
      last: null,
      cutStart: null,
      running: false,
      error: s.running ? "Interrupted by a page reload; generate this segment again." : s.error,
    })),
  };
  if (typeof st.startUrl === "string" && st.startUrl.startsWith("blob:")) st.startUrl = null;
  if (!st.startUrl && st.startData) st.startUrl = st.startData;
  for (const seg of st.segments) {
    if (typeof seg.lastUrl === "string" && seg.lastUrl.startsWith("blob:")) seg.lastUrl = null;
    if (typeof seg.cutStartUrl === "string" && seg.cutStartUrl.startsWith("blob:")) seg.cutStartUrl = null;
    if (!seg.lastUrl && seg.lastData) seg.lastUrl = seg.lastData;
    if (!seg.cutStartUrl && seg.cutStartData) seg.cutStartUrl = seg.cutStartData;
  }
  return st;
}

function fmt(n) {
  return (Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\\.0+$/, "");
}

function hiddenFile(onFile, accept = "image/*") {
  const input = el("input", { type: "file", accept, style: { display: "none" } });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) onFile(file);
  });
  return input;
}

function rememberData(obj, key, file, st, app) {
  obj[key] = null;
  fileToDataUrl(file).then((data) => {
    if (!data) return;
    obj[key] = data;
    persist(st, app);
  });
}

function mediaChip(label, url, { onPick, onClear, ghost = false, title = "" } = {}) {
  const input = onPick ? hiddenFile(onPick) : null;
  const chip = el(onPick ? "button" : "span", {
    class: `dir-chip ${url ? "on" : ""} ${ghost ? "ghost" : ""}`.trim(),
    type: onPick ? "button" : null,
    title: title || label,
    onclick: onPick ? () => input.click() : null,
  },
  url ? el("img", { src: url, alt: "" }) : icon("image"),
  el("span", {}, label));
  if (url && onClear) {
    chip.append(el("span", { class: "dir-x", title: "Clear", role: "button", onclick: (e) => { e.stopPropagation(); onClear(); } }, "×"));
  }
  if (input) chip.append(input);
  return chip;
}

function summary(f, app) {
  const aspect = f.values.aspect ?? defaultOf(app, "aspect", "16:9");
  const mp = f.values.megapixels ?? defaultOf(app, "megapixels", 0.9);
  const fps = f.values.fps ?? defaultOf(app, "fps", 24);
  return `${String(aspect).split(" (")[0]} · ${mp} MP · ${fps} fps`;
}

function parseBatch(text, fallback) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const hit = /\s*,\s*(\d+(?:\.\d+)?)\s*s?\s*$/i.exec(line);
    const duration = hit ? Math.max(1, Math.min(30, Math.round(Number(hit[1])))) : fallback;
    const prompt = (hit ? line.slice(0, hit.index) : line).trim();
    if (prompt) out.push({ prompt, duration });
  }
  return out;
}

function resumeIndex(segments) {
  let start = segments.findIndex((s) => !s.approved || !s.videoFile || s.stale);
  if (start < 0) return -1;
  // A non-cut segment needs the previous segment's extracted last frame. If that frame
  // is missing, walk back until the chain has a usable handoff or a hard cut.
  while (start > 0 && !segments[start].cut) {
    const prev = segments[start - 1];
    if (prev.approved && prev.videoFile && prev.lastFrameUrl && !prev.stale) break;
    start -= 1;
  }
  return start;
}

export function sequentialDirectorView(app, f) {
  const st = stateFor(app);
  const root = el("div", { class: "dir dir-sequential" });

  function checkSettings() {
    const key = settingsKey(app, f);
    if (st.settings === undefined) { st.settings = key; return; }
    if (st.settings === key) return;
    st.settings = key;
    for (const seg of st.segments) {
      seg.approved = false;
      if (seg.videoUrl) seg.stale = true;
    }
    persist(st, app);
  }
  if (st.settings === undefined) st.settings = settingsKey(app, f);
  checkSettings();
  const head = el("div", { class: "dir-head" });
  const body = el("div", { class: "dir-body", style: { gridTemplateColumns: "minmax(0, 1fr)" } });
  const main = el("div", { class: "dir-main" });
  const stage = el("div", { class: "dir-stage" });
  const editor = el("div", { class: "dir-seg" });
  const foot = el("div", { class: "dir-foot" });
  let finalEl = null;
  main.append(stage, editor, foot);
  body.append(main);
  root.append(head, body);

  function select(i) {
    st.selected = Math.max(0, Math.min(st.segments.length - 1, i));
    persist(st, app);
    draw();
  }

  function openBatch() {
    const dialog = modal("Paste prompts", "One prompt per line. Add an optional duration suffix: ,13 for 13 seconds. Without a suffix the default below is used.");
    const ta = el("textarea", { class: "dir-prompt", rows: "12", placeholder: "A woman walks into the room,13\nShe sits down,8\nClose-up on her eyes,5" });
    const fallback = el("input", { class: "dir-num", type: "number", min: "1", max: "30", step: "1", value: String(st.segments[st.selected]?.duration || defaultOf(app, "duration", 5)) });
    const info = el("p", { class: "help", style: { margin: "0" } }, "0 segments");
    const refresh = () => {
      const parsed = parseBatch(ta.value, Math.max(1, Math.min(30, Number(fallback.value) || 5)));
      info.textContent = `${parsed.length} segment${parsed.length === 1 ? "" : "s"} · one inference each`;
    };
    ta.addEventListener("input", refresh);
    fallback.addEventListener("input", refresh);
    const make = (replace) => {
      const parsed = parseBatch(ta.value, Math.max(1, Math.min(30, Number(fallback.value) || 5)));
      if (!parsed.length) return toast("Paste at least one prompt.", { error: true });
      if ((replace ? 0 : st.segments.length) + parsed.length > MAX_SEGMENTS) return toast(`${MAX_SEGMENTS} segments is the current maximum.`, { error: true });
      const added = parsed.map((p) => ({ ...blankSegment(app), prompt: p.prompt, duration: p.duration }));
      if (replace) {
        st.segments = added;
        st.selected = 0;
        st.assembled = null;
      } else {
        st.selected = st.segments.length;
        st.segments.push(...added);
        st.assembled = null;
      }
      persist(st, app);
      dialog.close();
      draw();
      toast(`${parsed.length} segment${parsed.length === 1 ? "" : "s"} ${replace ? "created" : "added"}.`);
    };
    dialog.append(
      el("div", { class: "ag-dialog-form" },
        ta,
        el("div", { class: "dir-seg-fields" }, el("label", {}, "default length", fallback, el("span", { class: "unit" }, "s")), info),
        el("p", { class: "help", style: { margin: "0" } }, "A trailing comma-number is removed from the prompt and becomes that segment’s duration. Prompts keep their internal spaces and commas. Replace clears existing cuts/keyframes; Append keeps them."),
        el("div", { class: "ag-dialog-actions" },
          el("button", { class: "btn ghost", type: "button", onclick: () => make(false) }, icon("plus"), "Append segments"),
          el("button", { class: "btn lime", type: "button", onclick: () => make(true) }, icon("film"), "Replace segments"))));
    dialog.showModal();
    ta.focus();
    refresh();
  }

  const enhancerAvailable = app.inputs.some((input) => input.id === "prompt_enhancer");
  let promptBusy = false;
  function promptContextAt(index) {
    return st.segments.slice(0, index).map((seg, i) => seg.prompt.trim() ? `[Segment ${i + 1}] ${seg.prompt.trim()}` : "").filter(Boolean).join("\n\n");
  }
  async function generatePrompt(index, all = false) {
    if (!enhancerAvailable || promptBusy || st.busyAll) return;
    promptBusy = true;
    try {
      const first = all ? 0 : index;
      const last = all ? st.segments.length - 1 : index;
      for (let i = first; i <= last; i += 1) {
        const seg = st.segments[i];
        if (!seg.prompt.trim()) continue;
        const body=new FormData();
        body.append("prompt",seg.prompt);body.append("prompt_context",promptContextAt(i));
        body.append("enhancer_model",f.values.enhancer_model || defaultOf(app,"enhancer_model","qwen3.8_27b_w4a8.safetensors"));
        body.append("index","0");
        let firstFrame=null;try{firstFrame=await firstFileFor(i);}catch{}
        if(firstFrame)body.append("image",firstFrame,firstFrame.name);
        let lastFrame=seg.last;
        if(!lastFrame && seg.lastUrl && !seg.lastUrl.startsWith("blob:"))lastFrame=await fileFromUrl(seg.lastUrl,`scene-${i+1}-last.png`);
        if(lastFrame)body.append("last_frame",lastFrame,lastFrame.name);
        const result = await api(`/api/directors/${app.id}/prompts`, {method:"POST",body});
        if (result?.values?.prompt) {
          seg.prompt = result.values.prompt;
          invalidationFrom(st, i);
        }
        st.selected = i;
        persist(st, app);
        draw();
      }
      toast(all ? "LTX prompts generated. No video render was started." : `LTX prompt generated for segment ${index + 1}. No video render was started.`);
    } catch (e) {
      toast(`Prompt generation failed: ${e.message}`, { error: true });
    } finally {
      promptBusy = false;
      persist(st, app);
      draw();
    }
  }

  function runStopButton() {
    if (st.busyAll) {
      return el("button", {
        type: "button", class: "dir-toggle on", disabled: st.stopAfter,
        onclick: () => { st.stopAfter = true; persist(st, app); draw(); toast("Stopping after the current segment."); },
      }, icon("stop"), st.stopAfter ? "Stopping…" : "Stop after current");
    }
    return el("button", { type: "button", class: "dir-toggle on", onclick: () => void generateAll() },
      icon("spark"), "Generate all");
  }

  function drawHead() {
    const total = st.segments.reduce((n, s) => n + s.duration, 0);
    const approved = st.segments.filter((s) => s.approved && s.videoFile).length;
    head.replaceChildren(
      el("div", { class: "dir-brand" }, icon("film"),
        el("span", {}, app.panel_title || "LTX Sequential Director"),
        el("small", {}, `${st.segments.length} scenes · ${fmt(total)}s · ${approved}/${st.segments.length} approved${st.busyAll ? ` · generating ${st.selected + 1}/${st.segments.length}` : ""}`)),
      el("div", { class: "dir-head-right" },
        enhancerAvailable ? el("button", { type: "button", class: "dir-toggle", title: "Generate every segment prompt only; no video render", disabled: promptBusy || st.busyAll, onclick: () => void generatePrompt(0, true) }, icon("spark"), "Generate all prompts") : null,
        el("button", { type: "button", class: "dir-toggle", disabled: st.busyAll, onclick: () => openBatch() }, icon("code"), "Paste prompts"),
        el("button", { type: "button", class: "dir-toggle", disabled: st.busyAll, onclick: () => {
          if (st.segments.length >= MAX_SEGMENTS) return toast(`${MAX_SEGMENTS} segments is the current maximum.`, { error: true });
          st.segments.push(blankSegment(app));
          st.selected = st.segments.length - 1;
          persist(st, app);
          draw();
        } }, icon("plus"), "Add segment"),
        st.autoError ? el("span", { class: "tag red", title: st.autoError }, "chain stopped") : null));
  }

  function drawStage() {
    const total = Math.max(1, st.segments.reduce((n, s) => n + s.duration, 0));
    const ruler = el("div", { class: "dir-ruler", style: { width: "100%" } });
    let start = 0;
    for (let i = 0; i < st.segments.length; i += 1) {
      const left = (start / total) * 100;
      ruler.append(el("span", { class: "dir-tick", style: { left: `${left}%` } }, el("i"), `${fmt(start)}s`));
      start += st.segments[i].duration;
    }
    ruler.append(el("span", { class: "dir-tick", style: { left: "100%" } }, el("i"), `${fmt(total)}s`));

    const track = el("div", { class: "dir-track gen", style: { width: "100%" } });

    function startResize(e, target, edge) {
      if (st.busyAll || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const pxPerSec = Math.max(1, track.getBoundingClientRect().width) / Math.max(1, total);
      const startX = e.clientX;
      const startDuration = st.segments[target].duration;
      let moved = false;
      const move = (ev) => {
        const delta = (ev.clientX - startX) / pxPerSec;
        if (Math.abs(delta) < 0.15) return;
        const next = Math.max(1, Math.min(30, Math.round(startDuration + delta)));
        if (next === st.segments[target].duration) return;
        moved = true;
        st.segments[target].duration = next;
        invalidationFrom(st, target);
        draw();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        document.body.classList.remove("dir-dragging");
        if (moved) { persist(st, app); draw(); }
        else select(Math.max(target, 0));
      };
      document.body.classList.add("dir-dragging");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    }

    let cursor = 0;
    st.segments.forEach((seg, i) => {
      const left = (cursor / total) * 100;
      const width = (seg.duration / total) * 100;
      const win = el("div", {
        class: `dir-win${i === st.selected ? " on" : ""}`,
        style: { left: `${left}%`, width: `${width}%` },
        title: `Segment ${i + 1}`,
        onclick: () => select(i),
      });
      if (seg.lastFrameUrl) win.append(el("img", {
        src: seg.lastFrameUrl, alt: "",
        style: { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover", opacity: ".34", pointerEvents: "none" },
      }));
      win.append(
        el("span", { class: "dir-win-tag" }, `SEG ${i + 1}`),
        el("span", { class: "dir-win-time" }, `${fmt(seg.duration)}s`),
        el("span", { class: "dir-win-prompt" }, seg.prompt || "Empty segment"));
      if (seg.approved) win.append(el("span", { title: "Approved", style: { position: "absolute", top: "5px", right: "9px", color: "var(--mint)", fontSize: "12px", fontWeight: "800" } }, "✓"));
      else if (seg.error) win.append(el("span", { title: seg.error, style: { position: "absolute", top: "5px", right: "9px", color: "var(--bad)", fontSize: "11px", fontWeight: "700" } }, "!"));
      if (i > 0) win.append(el("span", { class: "dir-handle l", title: "Drag to resize the previous segment", onclick: (e) => e.stopPropagation(), onpointerdown: (e) => startResize(e, i - 1, "l") }));
      win.append(el("span", { class: "dir-handle r", title: "Drag to resize this segment", onclick: (e) => e.stopPropagation(), onpointerdown: (e) => startResize(e, i, "r") }));
      track.append(win);
      cursor += seg.duration;
    });

    stage.replaceChildren(el("div", { class: "dir-scroll" }, el("div", { class: "dir-canvas" }, ruler, track)));
  }

  function drawEditor() {
    const i = st.selected;
    const seg = st.segments[i];
    const startAt = st.segments.slice(0, i).reduce((n, s) => n + s.duration, 0);
    const endAt = startAt + seg.duration;
    const prev = i > 0 ? st.segments[i - 1] : null;
    const needsPrev = i > 0 && !seg.cut;
    const ready = i === 0 ? Boolean(st.start || st.startData || st.startUrl) : seg.cut ? Boolean(seg.cutStart || seg.cutStartData || seg.cutStartUrl) : Boolean(prev?.approved && prev?.lastFrameUrl);
    const status = seg.running ? "running" : seg.error ? "failed" : seg.approved ? "approved" : seg.videoUrl ? "review" : "empty";

    const duration = el("input", { class: "dir-num", type: "number", min: "1", max: "30", step: "1", value: String(seg.duration), disabled: st.busyAll });
    duration.addEventListener("input", () => { seg.duration = Math.max(1, Math.min(30, Number(duration.value) || 5)); invalidationFrom(st, i); persist(st, app); });
    const cut = el("input", { type: "checkbox", checked: seg.cut, disabled: st.busyAll });
    cut.addEventListener("change", () => {
      seg.cut = cut.checked;
      if (!seg.cut) { revoke(seg.cutStartUrl); seg.cutStart = null; seg.cutStartUrl = null; }
      invalidationFrom(st, i);
      persist(st, app);
      draw();
    });

    const generate = el("button", { class: "btn small lime", type: "button", disabled: st.busyAll, onclick: () => void runSegment(i) },
      icon("film"), seg.videoUrl ? "Regenerate" : "Generate segment");
    const approve = seg.videoUrl && !seg.approved ? el("button", {
      class: "btn small ghost", type: "button", disabled: st.busyAll, onclick: () => {
        checkSettings();
        if (seg.stale) return toast("Regenerate this changed segment before approving.", { error: true });
        seg.approved = true;
        invalidationFrom(st, i + 1);
        persist(st, app);
        draw();
      },
    }, icon("check"), "Approve") : null;
    const remove = st.segments.length > 1 ? el("button", {
      class: "btn small ghost danger", type: "button", disabled: st.busyAll, onclick: () => {
        revoke(seg.lastUrl); revoke(seg.cutStartUrl);
        st.segments.splice(i, 1);
        st.selected = Math.min(i, st.segments.length - 1);
        invalidationFrom(st, Math.max(0, i - 1));
        persist(st, app);
        draw();
      },
    }, icon("x"), "Remove") : null;

    const prompt = el("textarea", { class: "dir-prompt", rows: "3", placeholder: "What happens in this segment?", disabled: st.busyAll });
    prompt.value = seg.prompt;
    prompt.addEventListener("input", () => { seg.prompt = prompt.value; invalidationFrom(st, i); persist(st, app); });
    const promptBox = el("div", { class: "dir-prompt-box" }, prompt,
      enhancerAvailable ? el("div", { class: "dir-prompt-tools" },
        el("button", { type: "button", class: "btn small ghost dir-enhance", title: "Rewrite this segment with Qwen3.8; no video render", disabled: st.busyAll || promptBusy, onclick: () => void generatePrompt(i, false) }, icon("spark"), "Generate prompt")) : null);

    const firstChip = i === 0
      ? mediaChip(st.start ? "Start image" : "Choose start image", st.startUrl, {
        onPick: (file) => { revoke(st.startUrl); st.start = file; st.startUrl = URL.createObjectURL(file); invalidationFrom(st, 0); rememberData(st, "startData", file, st, app); persist(st, app); draw(); },
        onClear: () => { revoke(st.startUrl); st.start = null; st.startUrl = null; st.startData = null; invalidationFrom(st, 0); persist(st, app); draw(); },
      })
      : seg.cut
        ? mediaChip(seg.cutStart ? "Cut start image" : "Choose cut image", seg.cutStartUrl, {
          onPick: (file) => { revoke(seg.cutStartUrl); seg.cutStart = file; seg.cutStartUrl = URL.createObjectURL(file); invalidationFrom(st, i); rememberData(seg, "cutStartData", file, st, app); persist(st, app); draw(); },
          onClear: () => { revoke(seg.cutStartUrl); seg.cutStart = null; seg.cutStartUrl = null; seg.cutStartData = null; invalidationFrom(st, i); persist(st, app); draw(); },
        })
        : (() => {
          const chooseAnother = (file) => {
            revoke(seg.cutStartUrl);
            seg.cut = true;
            seg.cutStart = file;
            seg.cutStartUrl = URL.createObjectURL(file);
            invalidationFrom(st, i);
            rememberData(seg, "cutStartData", file, st, app);
            persist(st, app);
            draw();
          };
          return el("span", { style: { display: "inline-flex", gap: "6px", flexWrap: "wrap", alignItems: "center" } },
            mediaChip(prev?.lastFrameUrl ? "Previous segment’s last frame" : "Previous frame not ready", prev?.lastFrameUrl, {
              onPick: chooseAnother,
              title: "Click to use another picture as this segment’s first frame (creates a hard cut)",
            }),
            mediaChip("Choose another image", null, {
              onPick: chooseAnother,
              title: "Use a new first image for this segment instead of the previous last frame",
            }));
        })();

    const keyframe = mediaChip(seg.last ? "Final keyframe" : "Add final keyframe", seg.lastUrl, {
      onPick: (file) => { revoke(seg.lastUrl); seg.last = file; seg.lastUrl = URL.createObjectURL(file); invalidationFrom(st, i); rememberData(seg, "lastData", file, st, app); persist(st, app); draw(); },
      onClear: () => { revoke(seg.lastUrl); seg.last = null; seg.lastUrl = null; seg.lastData = null; invalidationFrom(st, i); persist(st, app); draw(); },
    });

    const preview = seg.videoUrl ? el("div", { style: { display: "flex", gap: "12px", alignItems: "flex-start", flexWrap: "wrap" } },
      el("video", { src: seg.videoUrl, controls: true, playsinline: true, style: { width: "min(520px, 100%)", borderRadius: "10px", background: "#000" } }),
      seg.lastFrameUrl ? el("div", { style: { display: "grid", gap: "5px" } },
        el("small", { class: "dim" }, "Extracted last frame"),
        el("img", { src: seg.lastFrameUrl, alt: "", style: { width: "150px", borderRadius: "8px", border: "1px solid var(--line-2)" } })) : null) : null;

    editor.replaceChildren(...[
      el("div", { class: "dir-seg-head" },
        el("span", { class: "dir-seg-title" }, `Segment ${i + 1}`),
        el("div", { class: "dir-seg-fields" },
          el("label", {}, "length", duration, el("span", { class: "unit" }, "s")),
          el("label", { style: { textTransform: "none", letterSpacing: "0" } }, cut, "hard cut")),
        el("span", { class: "dir-seg-time" }, `${fmt(startAt)}s → ${fmt(endAt)}s`),
        el("div", { class: "dir-seg-actions" },
          el("span", { class: "tag dark" }, status), generate, approve, remove)),
      promptBox,
      el("div", { class: "dir-assign" },
        el("span", { class: "dir-assign-lbl" }, "First frame"), el("div", { class: "dir-chips" }, firstChip),
        el("span", { class: "dir-assign-lbl" }, "Final keyframe"), el("div", { class: "dir-chips" }, keyframe),
        el("span", { class: "dir-assign-lbl" }, "Previous handoff"),
        el("div", { class: "dir-chips" }, prev?.lastFrameUrl
          ? [el("span", { class: "dir-chip ghost on" }, el("img", { src: prev.lastFrameUrl, alt: "" }), el("span", {}, `Segment ${i} last frame`))]
          : [el("span", { class: "dim" }, needsPrev ? "Waiting for the previous segment to be approved" : "Independent cut")])),
      !ready && !seg.running ? el("p", { class: "help", style: { margin: "6px 0 0" } },
        i === 0 ? "Choose the start image above." : seg.cut ? "Choose the new start image for this cut." : "Approve the previous segment and keep its last frame available, or turn on hard cut.") : null,
      seg.error ? el("p", { class: "help", style: { color: "var(--bad)", margin: "6px 0 0" } }, seg.error) : null,
      seg.stale ? el("p", { class: "help", style: { color: "var(--warn)", margin: "6px 0 0" } }, "Changed after the last render — regenerate before approving.") : null,
      preview,
    ].filter(Boolean));
  }

  function drawFoot() {
    const approved = st.segments.filter((s) => s.approved && s.videoFile && !s.stale).length;
    const total = st.segments.reduce((n, s) => n + s.duration, 0);
    foot.replaceChildren(
      el("div", { class: "dir-global-wrap" },
        el("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
          el("span", { class: "dir-chip ghost on" }, icon("film"), el("span", {}, `${approved}/${st.segments.length} approved`)),
          el("span", { class: "dir-chip ghost" }, icon("clock"), el("span", {}, `${fmt(total)}s total`)),
          st.assembled ? el("a", { class: "dir-chip on", href: st.assembled, download: "riverfield-sequential.mp4" }, icon("download"), el("span", {}, "Download final cut")) : null,
          st.autoError ? el("span", { class: "dir-chip", style: { color: "var(--bad)" } }, icon("info"), el("span", {}, st.autoError)) : null)),
      el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
        (() => {
          const b = runStopButton();
          b.className = "btn dir-go";
          return b;
        })(),
        el("button", { class: "btn ghost", type: "button", disabled: st.busyAll || st.assembling, onclick: () => void assemble() }, icon("film"), st.assembling ? "Assembling…" : "Assemble approved")));
    finalEl?.remove();
    finalEl = null;
    if (st.assembled) {
      finalEl = el("div", { class: "dir-seg" },
        el("div", { class: "dir-seg-head" }, el("span", { class: "dir-seg-title" }, "Final cut"), el("span", { class: "dir-seg-time" }, "Hard cuts · original audio")),
        el("video", { src: st.assembled, controls: true, playsinline: true, style: { width: "min(720px, 100%)", borderRadius: "10px" } }));
      main.insertBefore(finalEl, foot);
    }
  }

  function draw() {
    checkSettings();
    drawHead();
    drawStage();
    drawEditor();
    drawFoot();
  }

  async function firstFileFor(i) {
    const seg = st.segments[i];
    if (i === 0) {
      if (st.start) return st.start;
      if (st.startUrl && !st.startUrl.startsWith("blob:")) return fileFromUrl(st.startUrl, "segment-1-start.png");
      throw new Error("Choose the start image for segment 1.");
    }
    if (seg.cut) {
      if (seg.cutStart) return seg.cutStart;
      if (seg.cutStartUrl && !seg.cutStartUrl.startsWith("blob:")) return fileFromUrl(seg.cutStartUrl, `segment-${i + 1}-cut.png`);
      throw new Error("Choose the new start image for this cut.");
    }
    const prev = st.segments[i - 1];
    if (!prev?.approved || !prev.lastFrameUrl) throw new Error("Approve the previous segment and keep its last frame available.");
    return fileFromUrl(prev.lastFrameUrl, `segment-${i}-last-frame.png`);
  }

  async function runSegment(i) {
    const seg = st.segments[i];
    if (seg.running) return false;
    checkSettings();
    let first;
    try { first = await firstFileFor(i); } catch (e) { toast(e.message, { error: true }); return false; }
    seg.running = true; seg.error = null; seg.approved = false; seg.stale = false;
    seg.videoUrl = null; seg.videoFile = null; seg.lastFrameUrl = null; seg.lastFrameFile = null;
    invalidationFrom(st, i + 1);
    draw();
    let ok = false;
    try {
      const fd = new FormData();
      fd.append("image", first, first.name || `segment-${i + 1}-first.png`);
      let lastFrame = seg.last;
      if (!lastFrame && seg.lastUrl && !seg.lastUrl.startsWith("blob:")) lastFrame = await fileFromUrl(seg.lastUrl, `segment-${i + 1}-last.png`);
      if (lastFrame) fd.append("last_frame", lastFrame, lastFrame.name || `segment-${i + 1}-last.png`);
      fd.append("prompt", seg.prompt.trim() || "Continue the shot.");
      fd.append("duration", String(seg.duration));
      fd.append("last_frame_export", "true");
      const previousPrompts = promptContextAt(i);
      if (previousPrompts) fd.append("prompt_context", previousPrompts);
      for (const inp of app.inputs) {
        if (PER_SEGMENT.has(inp.id)) continue;
        const v = f.values[inp.id];
        if (v === undefined || v === null) continue;
        if (v === "") { if (inp.allow_empty) fd.append(inp.id, ""); continue; }
        if (inp.type === "seed" && (v === -1 || v === "-1")) continue;
        fd.append(inp.id, inp.type === "toggle" ? (v ? "true" : "false") : String(v));
      }
      const started = await api(`/api/apps/${app.id}/run`, { method: "POST", body: fd });
      seg.jobId = started.id;
      void feed.load(app.id).catch(() => {});
      let entry = started;
      while (!TERMINAL.has(entry.status)) {
        await sleep(1800);
        entry = await api(`/api/history/${started.id}`);
      }
      if (entry.status !== "succeeded") throw new Error(entry.error?.message || `Run ${entry.status}`);
      let video = entry.outputs.find((o) => o.type === "video");
      let frame = entry.outputs.find((o) => o.type === "image");
      if (!video) throw new Error("The segment finished without a video output.");
      if (!frame) {
        // The history row is saved after its files; give a slow disk one more read before
        // treating a missing extracted frame as a chain failure.
        await sleep(1000);
        entry = await api(`/api/history/${started.id}`);
        video = entry.outputs.find((o) => o.type === "video");
        frame = entry.outputs.find((o) => o.type === "image");
        if (!video) throw new Error("The segment finished without a video output.");
      }
      seg.videoUrl = video.url;
      seg.videoFile = video.file;
      seg.lastFrameUrl = frame?.url || null;
      seg.lastFrameFile = frame?.file || null;
      const inputUrl = (id) => entry.inputs?.find((x) => x.id === id)?.url || null;
      if (i === 0 && inputUrl("image")) { st.start = null; st.startData = null; st.startUrl = inputUrl("image"); }
      if (seg.cut && inputUrl("image")) { seg.cutStart = null; seg.cutStartData = null; seg.cutStartUrl = inputUrl("image"); }
      if (seg.last && inputUrl("last_frame")) { seg.last = null; seg.lastData = null; seg.lastUrl = inputUrl("last_frame"); }
      if (!seg.lastFrameUrl) seg.error = "The video succeeded, but no last frame was extracted. Add a cut or a final keyframe for the next segment.";
      else ok = true;
      persist(st, app);
    } catch (e) {
      seg.error = e.message;
    } finally {
      seg.running = false;
      persist(st, app);
      draw();
      void feed.load(app.id).catch(() => {});
    }
    return ok;
  }

  async function generateAll() {
    if (st.busyAll) return;
    checkSettings();
    const start = resumeIndex(st.segments);
    if (start < 0) { await assemble(); return; }
    if (start === 0 && !st.start && !st.startData && !st.startUrl) {
      toast("Choose the start image for segment 1.", { error: true });
      return;
    }
    for (let i = Math.max(1, start); i < st.segments.length; i += 1) {
      if (st.segments[i].cut && !st.segments[i].cutStart && !st.segments[i].cutStartData && !st.segments[i].cutStartUrl) {
        toast(`Segment ${i + 1} is a cut: choose its start image first.`, { error: true });
        return;
      }
    }
    st.busyAll = true;
    st.stopAfter = false;
    st.autoError = null;
    st.assembled = null;
    draw();
    try {
      for (let i = start; i < st.segments.length; i += 1) {
        st.selected = i;
        st.segments[i].approved = false;
        st.segments[i].stale = false;
        draw();
        const ok = await runSegment(i);
        if (!ok) {
          st.autoError = `Stopped at segment ${i + 1}; ${st.segments[i]?.error || "fix it and run again."}`;
          toast(st.autoError, { error: true });
          return;
        }
        st.segments[i].approved = true;
        st.segments[i].stale = false;
        persist(st, app);
        draw();
        if (st.stopAfter) {
          st.autoError = `Stopped after segment ${i + 1}. Resume when ready.`;
          toast(st.autoError);
          return;
        }
      }
      await assemble();
    } finally {
      st.busyAll = false;
      st.stopAfter = false;
      persist(st, app);
      draw();
    }
  }

  async function assemble() {
    if (st.assembling) return;
    checkSettings();
    if (st.segments.some((s) => !s.approved || !s.videoFile || s.stale)) {
      toast("Approve every up-to-date segment before assembling.", { error: true });
      return;
    }
    st.assembling = true;
    st.assembled = null;
    draw();
    try {
      const result = await api("/api/sequences/assemble", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments: st.segments.map((s) => ({ id: s.jobId, file: s.videoFile })) }),
      });
      st.assembled = result.outputs?.[0]?.url || null;
      if (!st.assembled) throw new Error("The assembler returned no video.");
      st.autoError = null;
      persist(st, app);
      toast("Sequential cut assembled.");
    } catch (e) {
      st.autoError = `Assembly failed: ${e.message}`;
      toast(st.autoError, { error: true });
    } finally {
      st.assembling = false;
      persist(st, app);
      draw();
      void feed.load(app.id).catch(() => {});
    }
  }

  draw();
  return root;
}
