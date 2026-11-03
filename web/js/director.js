// Studio Director — the Material Planner panel.
//
// A real director surface, not a form: a media bin on the left, a frame-accurate timeline in the
// middle (GEN windows you can drag and resize, video and audio clips), and the selected segment's
// prompt and materials underneath. Everything it edits lands in two places the app already knows:
//   - f.files[imageN|videoN|audioN]  the uploaded media (same store the normal dropzones use)
//   - f.values.segment_windows        JSON the RiverField H3 Material Planner node reads
//
// The layout follows the plugin's own geometry: H3 lengths are 5+17n frames, seams default to the
// nearest legal overlap (39 frames), and windows never gap.

import { el, icon, toast, clamp } from "./util.js";

const FPS = 24;
const MAX_LENGTH = 3592;
const MIN_LEN = 5;
const SEAM = 39;

const MEDIA = {
  image: { label: "Pictures", icon: "image", slots: 9, accept: "image/*" },
  video: { label: "Videos", icon: "film", slots: 3, accept: "video/*" },
  audio: { label: "Audios", icon: "audio", slots: 3, accept: "audio/*" },
};

export function alignedLength(frames, minimum = MIN_LEN) {
  const lower = MIN_LEN + 17 * Math.max(0, Math.ceil((minimum - MIN_LEN) / 17));
  return Math.min(MAX_LENGTH, Math.max(lower, MIN_LEN + 17 * Math.max(0, Math.round((frames - MIN_LEN) / 17))));
}

export function nearestOverlap(frames, maximum) {
  const choices = [0, 1];
  for (let n = 5; n <= maximum; n += 17) choices.push(n);
  return choices.filter((n) => n <= maximum).reduce((best, n) => (Math.abs(n - frames) < Math.abs(best - frames) ? n : best), 0);
}

function slotsOf(app, type) {
  return app.inputs.filter((i) => i.type === type && /^(image|video|audio)\d+$/.test(i.id)).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function mediaOf(app, f, type) {
  return slotsOf(app, type).map((inp, index) => {
    const x = f.files[inp.id];
    return x ? { index, slot: inp.id, name: x.file.name, url: x.url, file: x.file } : null;
  }).filter(Boolean);
}

function attach(app, f, type, file) {
  const free = slotsOf(app, type).find((i) => !f.files[i.id]);
  if (!free) { toast(`No free ${MEDIA[type].label.toLowerCase()} slot`, { error: true }); return false; }
  const maxMb = free.limits?.max_mb;
  if (maxMb && file.size > maxMb * 1e6) { toast(`${file.name}: max ${maxMb} MB`, { error: true }); return false; }
  f.files[free.id] = { file, url: URL.createObjectURL(file) };
  return true;
}

function removeSlot(f, slot) {
  const x = f.files[slot];
  if (x?.url) URL.revokeObjectURL(x.url);
  delete f.files[slot];
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
    } catch { /* fall through to a fresh state */ }
  }
  return emptyState(Number(f.values.duration) || 5);
}

const stateCache = new Map();

function stateFor(app, f) {
  if (!stateCache.has(app.id)) stateCache.set(app.id, parseState(f));
  return stateCache.get(app.id);
}

function persistState(app, f, st) {
  f.values.segment_windows = JSON.stringify(st);
  const first = st.windows[0];
  if (first) f.values.duration = +(((first.end - first.start) / FPS).toFixed(2));
  f.values.segment_count = st.windows.length;
}

const fmt = (x) => (Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.0+$/, "");

export function directorView(app, f, { onSubmit, onDirty }) {
  const st = stateFor(app, f);
  let selected = 0;
  let zoom = 70; // px per second
  let drag = null;
  let winNodes = [];
  let clipNodes = new Map();

  const root = el("div", { class: "dir" });
  let stage, binEl, segEl, headEl, footEl;

  const totalFrames = () => Math.max(...st.windows.map((w) => w.end), 1);
  const totalSeconds = () => totalFrames() / FPS;

  function changed() {
    persistState(app, f, st);
    onDirty?.();
    draw();
  }

  // ---------------------------------------------------------------- media bin
  function binSection(type) {
    const list = mediaOf(app, f, type);
    const items = list.map((m) => {
      const assigned = st.windows.some((w) => (type === "image" ? w.images : type === "audio" ? w.audios : [])?.includes(m.index));
      const selectedWin = st.windows[selected];
      const inSeg = selectedWin ? (type === "image" ? selectedWin.images : type === "audio" ? selectedWin.audios : [])?.includes(m.index) : false;
      const thumb = type === "image"
        ? el("img", { src: m.url, alt: m.name })
        : el("span", { class: "dir-media-icon" }, icon(type === "video" ? "film" : "audio"));
      const node = el("div", {
        class: `dir-media${inSeg ? " on" : ""}${assigned ? " used" : ""}`,
        title: `${m.name}\n${type === "image" ? "Click: assign to the selected segment" : "Drag on the timeline"}`,
        onclick: () => {
          if (type === "video") return;
          const w = st.windows[selected];
          if (!w) return;
          const key = type === "image" ? "images" : "audios";
          w[key] = w[key].includes(m.index) ? w[key].filter((i) => i !== m.index) : [...w[key], m.index];
          changed();
        },
      }, el("div", { class: "dir-media-thumb" }, thumb),
         el("span", { class: "dir-media-name" }, m.name),
         el("button", {
           class: "dir-x", type: "button", title: "Remove",
           onclick: (e) => { e.stopPropagation(); removeSlot(f, m.slot); changed(); },
         }, "×"));
      if (type !== "image") {
        node.draggable = true;
        node.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/riverfield-media", JSON.stringify({ type, index: m.index }));
          e.dataTransfer.effectAllowed = "copy";
        });
      }
      return node;
    });

    const input = el("input", { type: "file", accept: MEDIA[type].accept, multiple: "true", hidden: "true" });
    input.addEventListener("change", () => {
      let any = false;
      for (const file of input.files || []) any = attach(app, f, type, file) || any;
      input.value = "";
      if (any) changed();
    });

    const drop = el("div", { class: "dir-drop" }, icon("plus"), el("span", {}, `Drop ${MEDIA[type].label.toLowerCase()} or click`));
    drop.onclick = () => input.click();
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("over");
      let any = false;
      for (const file of e.dataTransfer?.files || []) any = attach(app, f, type, file) || any;
      if (any) changed();
    });

    let extra = null;
    if (type === "audio") {
      const mode = el("select", { class: "dir-mini", title: "Audio mode for every reference audio" },
        el("option", { value: "reference" }, "Reference"),
        el("option", { value: "locked" }, "Keep original"));
      mode.value = f.values.audio_mode || "reference";
      mode.onchange = () => { f.values.audio_mode = mode.value; onDirty?.(); };
      extra = mode;
    } else if (type === "video") {
      const on = f.values.video_audio !== false;
      const b = el("button", { type: "button", class: `dir-mini-btn${on ? " on" : ""}`, title: "Use the videos' own sound" },
        icon(on ? "volume" : "mute"), on ? "sound" : "muted");
      b.onclick = () => { f.values.video_audio = !(f.values.video_audio !== false); changed(); };
      extra = b;
    }

    return el("section", { class: "dir-bin-sec" },
      el("h4", {}, icon(MEDIA[type].icon), MEDIA[type].label, extra, el("span", { class: "dir-count" }, `${list.length}/${MEDIA[type].slots}`)),
      el("div", { class: "dir-media-list" }, ...items),
      drop, input);
  }

  // ---------------------------------------------------------------- timeline
  function px(frame) { return (frame / FPS) * zoom; }

  function windowNode(w, i) {
    const left = px(w.start);
    const width = Math.max(28, px(w.end - w.start));
    const node = el("div", {
      class: `dir-win${i === selected ? " on" : ""}`,
      style: { left: `${left}px`, width: `${width}px` },
      title: `${fmt(w.start / FPS)}s – ${fmt(w.end / FPS)}s · ${w.end - w.start} frames`,
      onclick: (e) => { e.stopPropagation(); selected = i; draw(); },
    },
      el("span", { class: "dir-win-tag" }, `GEN ${i + 1}`),
      el("span", { class: "dir-win-time" }, `${fmt(w.start / FPS)}–${fmt(w.end / FPS)}s`),
      w.prompt ? el("span", { class: "dir-win-prompt" }, w.prompt) : null,
      el("span", { class: "dir-handle l", "data-edge": "l" }),
      el("span", { class: "dir-handle r", "data-edge": "r" }));

    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const edge = e.target?.dataset?.edge || null;
      drag = { kind: "win", i, edge, x0: e.clientX, snap: JSON.parse(JSON.stringify(st.windows)) };
      node.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    node.addEventListener("pointermove", (e) => {
      if (!drag || drag.kind !== "win" || drag.i !== i) return;
      const delta = Math.round(((e.clientX - drag.x0) / zoom) * FPS);
      st.windows = JSON.parse(JSON.stringify(drag.snap));
      const cur = st.windows[i];
      if (drag.edge === "l") {
        const minStart = i === 0 ? 0 : st.windows[i - 1].end - Math.min(SEAM, cur.end - cur.start - 1);
        cur.start = Math.round(clamp(cur.start + delta, Math.max(0, minStart), cur.end - MIN_LEN));
      } else if (drag.edge === "r") {
        cur.end = cur.start + alignedLength(cur.end - cur.start + delta, MIN_LEN);
      } else {
        const len = cur.end - cur.start;
        const start = Math.max(i === 0 ? 0 : -Infinity, cur.start + delta);
        cur.start = start; cur.end = start + len;
      }
      for (let k = i + 1; k < st.windows.length; k++) {
        const prev = st.windows[k - 1];
        const len = st.windows[k].end - st.windows[k].start;
        const overlap = Math.max(0, Math.min(SEAM, Math.min(len, prev.end - prev.start) - 1));
        st.windows[k].start = prev.end - overlap;
        st.windows[k].end = st.windows[k].start + len;
      }
      selected = i;
      persistState(app, f, st);
      st.windows.forEach((x, k) => {
        const n = winNodes[k];
        if (!n) return;
        n.style.left = `${px(x.start)}px`;
        n.style.width = `${Math.max(28, px(x.end - x.start))}px`;
        n.querySelector(".dir-win-time").textContent = `${fmt(x.start / FPS)}–${fmt(x.end / FPS)}s`;
      });
    });
    node.addEventListener("pointerup", () => { if (drag?.kind === "win") { drag = null; changed(); } });
    return node;
  }

  function clipNode(type, m, item) {
    const seconds = Number(item?.duration) || (st.windows[selected] ? (st.windows[selected].end - st.windows[selected].start) / FPS : 5);
    const start = Number(item?.start) || 0;
    const width = Math.max(24, seconds * zoom);
    const node = el("div", {
      class: `dir-clip ${type}`,
      style: { left: `${start * zoom}px`, width: `${width}px` },
      title: `${m.name} · ${fmt(start)}s +${fmt(seconds)}s`,
    },
      el("span", { class: "dir-clip-name" }, m.name));
    node.addEventListener("pointerdown", (e) => {
      drag = { kind: "clip", type, index: m.index, x0: e.clientX, start, seconds };
      node.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    node.addEventListener("pointermove", (e) => {
      if (!drag || drag.kind !== "clip" || drag.type !== type || drag.index !== m.index) return;
      const next = Math.max(0, drag.start + (e.clientX - drag.x0) / zoom);
      const list = type === "video" ? st.videos : st.audios;
      const found = list.find((x) => x.index === m.index);
      if (found) found.start = +next.toFixed(3); else list.push({ index: m.index, start: +next.toFixed(3), duration: drag.seconds, trimStart: 0 });
      persistState(app, f, st);
      node.style.left = `${next * zoom}px`;
    });
    node.addEventListener("pointerup", () => { if (drag?.kind === "clip") { drag = null; changed(); } });
    return node;
  }

  let raf = 0;
  function requestDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; drawTracks(); });
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
    const ruler = drawRuler(width);
    const gen = el("div", { class: "dir-track gen", style: { width: `${width}px` } });
    winNodes = [];
    st.windows.forEach((w, i) => { const n = windowNode(w, i); winNodes.push(n); gen.append(n); });

    const vids = el("div", { class: "dir-track vid", style: { width: `${width}px` } });
    for (const m of mediaOf(app, f, "video")) {
      const item = st.videos.find((x) => x.index === m.index) || { index: m.index, start: 0, duration: (st.windows[0] ? (st.windows[0].end - st.windows[0].start) / FPS : 5) };
      if (!st.videos.find((x) => x.index === m.index)) st.videos.push(item);
      vids.append(clipNode("video", m, item));
    }
    const auds = el("div", { class: "dir-track aud", style: { width: `${width}px` } });
    for (const m of mediaOf(app, f, "audio")) {
      let item = st.audios.find((x) => x.index === m.index);
      if (!item) { item = { index: m.index, start: 0, duration: (st.windows[0] ? (st.windows[0].end - st.windows[0].start) / FPS : 5), trimStart: 0 }; st.audios.push(item); }
      auds.append(clipNode("audio", m, item));
    }

    const playhead = el("div", { class: "dir-playhead", style: { left: "0px" } });
    const wrap = el("div", { class: "dir-scroll" },
      el("div", { class: "dir-canvas", style: { width: `${width}px` } },
        ruler,
        el("div", { class: "dir-track-lbl" }, "GEN"),
        gen,
        el("div", { class: "dir-track-lbl" }, "VID"),
        vids,
        el("div", { class: "dir-track-lbl" }, "AUD"),
        auds,
        playhead));

    wrap.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".dir-win, .dir-clip")) return;
      const x = e.clientX - wrap.getBoundingClientRect().left + wrap.scrollLeft - 56;
      const frame = Math.max(0, Math.round((x / zoom) * FPS));
      playhead.style.left = `${px(frame)}px`;
    });

    stage.replaceChildren(wrap);
  }

  // ---------------------------------------------------------------- segment editor
  function drawSegment() {
    const w = st.windows[selected] || st.windows[0];
    if (!w) { segEl.replaceChildren(el("p", { class: "dim" }, "No segment")); return; }
    const dur = (w.end - w.start) / FPS;
    const prompt = el("textarea", {
      class: "dir-prompt", rows: "3", placeholder: "Prompt for this segment (empty: the global prompt is used)",
      value: w.prompt || "",
    });
    prompt.addEventListener("input", () => { w.prompt = prompt.value; persistState(app, f, st); onDirty?.(); });

    const imgs = mediaOf(app, f, "image");
    const auds = mediaOf(app, f, "audio");
    const chip = (type, m) => {
      const key = type === "image" ? "images" : "audios";
      const on = w[key].includes(m.index);
      return el("button", {
        type: "button", class: `dir-chip${on ? " on" : ""}`, title: m.name,
        onclick: () => {
          w[key] = on ? w[key].filter((i) => i !== m.index) : [...w[key], m.index];
          changed();
        },
      }, type === "image" ? el("img", { src: m.url, alt: m.name }) : icon("audio"), el("span", {}, m.name));
    };

    segEl.replaceChildren(
      el("div", { class: "dir-seg-head" },
        el("span", { class: "dir-seg-title" }, `Segment ${selected + 1}`),
        el("span", { class: "dir-seg-time" }, `${fmt(w.start / FPS)}s → ${fmt(w.end / FPS)}s · ${w.end - w.start} frames · ${fmt(dur)}s`),
        el("div", { class: "dir-seg-actions" },
          el("button", { type: "button", class: "btn small ghost", onclick: () => {
            const last = st.windows[st.windows.length - 1];
            const len = last.end - last.start;
            const start = last.end - Math.min(SEAM, len - 1);
            st.windows.push({ start, end: start + len, prompt: "", images: [...last.images], audios: [...last.audios] });
            selected = st.windows.length - 1; changed();
          } }, icon("plus"), "Segment"),
          el("button", { type: "button", class: "btn small ghost", disabled: st.windows.length <= 1 ? "true" : undefined, onclick: () => {
            if (st.windows.length <= 1) return;
            st.windows.splice(selected, 1);
            selected = Math.max(0, selected - 1);
            const first = st.windows[0];
            if (first) { first.start = 0; }
            changed();
          } }, "Remove"))),
      prompt,
      el("div", { class: "dir-assign" },
        el("span", { class: "dir-assign-lbl" }, "Pictures"),
        imgs.length ? el("div", { class: "dir-chips" }, ...imgs.map((m) => chip("image", m))) : el("span", { class: "dim" }, "none — drop pictures in the bin"),
        el("span", { class: "dir-assign-lbl" }, "Audio"),
        auds.length ? el("div", { class: "dir-chips" }, ...auds.map((m) => chip("audio", m))) : el("span", { class: "dim" }, "none")));
  }

  function drawHead() {
    const two = el("button", {
      type: "button", class: `dir-toggle${f.values.two_stage ? " on" : ""}`,
      onclick: () => { f.values.two_stage = !f.values.two_stage; onDirty?.(); draw(); },
    }, icon("spark"), "Two-stage");
    let upscaler = null;
    if (f.values.two_stage) {
      const options = (app.inputs.find((i) => i.id === "upscaler")?.options || []).filter((o) => o.value);
      const sel = el("select", { class: "dir-sel", title: "Latent upscaler" },
        ...options.map((o) => el("option", { value: o.value }, o.label || o.value)));
      sel.value = f.values.upscaler || (options[0]?.value ?? "");
      sel.onchange = () => { f.values.upscaler = sel.value; onDirty?.(); };
      const steps = el("input", { class: "dir-num", type: "number", min: "0", max: "20", step: "1", value: String(f.values.high_steps ?? 2), title: "High-resolution steps" });
      steps.onchange = () => { f.values.high_steps = Math.max(0, Math.min(20, Number(steps.value) || 0)); onDirty?.(); };
      upscaler = el("div", { class: "dir-two" }, sel, el("span", {}, "hi-steps"), steps);
    }
    const zoomOut = el("button", { type: "button", class: "dir-zoom", title: "Zoom out", onclick: () => { zoom = Math.max(18, zoom - 14); draw(); } }, "−");
    const zoomIn = el("button", { type: "button", class: "dir-zoom", title: "Zoom in", onclick: () => { zoom = Math.min(300, zoom + 14); draw(); } }, "+");
    headEl.replaceChildren(
      el("div", { class: "dir-brand" }, icon("film"), el("span", {}, "Material Planner"), el("small", {}, `${st.windows.length} segment${st.windows.length > 1 ? "s" : ""} · ${fmt(totalSeconds())}s · ${totalFrames()} frames`)),
      el("div", { class: "dir-head-right" }, two, upscaler, el("div", { class: "dir-zoombox" }, zoomOut, el("span", {}, `${Math.round(zoom)} px/s`), zoomIn)));
  }

  function drawFoot() {
    const prompt = el("textarea", { class: "dir-global", rows: "2", placeholder: "Global prompt — used by every segment whose own prompt is empty", value: f.values.global_prompt || "" });
    prompt.addEventListener("input", () => { f.values.global_prompt = prompt.value; onDirty?.(); });
    const go = el("button", { class: "btn dir-go", type: "button" }, icon("spark"), "Generate");
    go.onclick = () => onSubmit?.();
    footEl.replaceChildren(el("div", { class: "dir-global-wrap" }, prompt), go);
  }

  function draw() {
    binEl.replaceChildren(binSection("image"), binSection("video"), binSection("audio"));
    drawHead();
    drawSegment();
    drawFoot();
    stage = stage || el("div", { class: "dir-stage" });
    drawTracks();
  }

  binEl = el("aside", { class: "dir-bin" });
  stage = el("section", { class: "dir-stage" });
  segEl = el("section", { class: "dir-seg" });
  headEl = el("header", { class: "dir-head" });
  footEl = el("footer", { class: "dir-foot" });

  root.append(headEl, el("div", { class: "dir-body" }, binEl, el("div", { class: "dir-main" }, stage, segEl)), footEl);
  draw();
  persistState(app, f, st);
  return root;
}
