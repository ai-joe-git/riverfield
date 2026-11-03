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
// Geometry follows the plugin: H3 lengths are 5+17n frames, seams default to the nearest legal
// overlap (39 frames), and windows never gap. Dragging is frame-accurate; the length snaps to a
// legal H3 value on release (or immediately with the H3 button in the segment editor).

import { el, icon, toast, clamp, store } from "./util.js";

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

const fmt = (x) => (Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.0+$/, "");

function slotsOf(app, type) {
  return app.inputs.filter((i) => i.type === type && /^(image|video|audio)\d+$/.test(i.id))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function mediaOf(app, f, type) {
  return slotsOf(app, type).map((inp, index) => {
    const x = f.files[inp.id];
    return x ? { index, slot: inp.id, name: x.file.name, url: x.url, file: x.file } : null;
  }).filter(Boolean);
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

export function directorView(app, f, { onSubmit, onDirty }) {
  const st = stateFor(app, f);
  let selected = 0;
  let zoom = Number(store.get("dir.zoom")) || 70;
  let drag = null;
  let winNodes = [];

  const meta = mediaMeta();
  const root = el("div", { class: "dir" });
  let ghostEl = null;

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
    persistState(app, f, st);
    onDirty?.();
    draw();
  }

  function attachMedia(type, file) {
    const free = slotsOf(app, type).find((i) => !f.files[i.id]);
    if (!free) { toast(`No free ${MEDIA[type].label.toLowerCase()} slot`, { error: true }); return false; }
    const maxMb = free.limits?.max_mb;
    if (maxMb && file.size > maxMb * 1e6) { toast(`${file.name}: max ${maxMb} MB`, { error: true }); return false; }
    const url = URL.createObjectURL(file);
    f.files[free.id] = { file, url };
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
  }

  // ---------------------------------------------------------------- media bin
  function binSection(type) {
    const list = mediaOf(app, f, type);
    const items = list.map((m) => {
      const info = meta.get(m.slot);
      const selectedWin = st.windows[selected];
      const inSeg = selectedWin && type !== "video" ? (type === "image" ? selectedWin.images : selectedWin.audios)?.includes(m.index) : false;
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
              if (w && !w.images.includes(m.index)) { selected = where; w.images = [...w.images, m.index]; changed(); }
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

    return el("section", { class: "dir-bin-sec" },
      el("h4", {}, icon(MEDIA[type].icon), MEDIA[type].label, extra, el("span", { class: "dir-count" }, `${list.length}/${MEDIA[type].slots}`)),
      el("div", { class: "dir-media-list" }, ...items), drop, input);
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
        const minStart = i === 0 ? 0 : Math.max(0, st.windows[i - 1].end - Math.min(SEAM, cur.end - cur.start - 1));
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
      for (let k = i + 1; k < st.windows.length; k++) {
        const prev = st.windows[k - 1];
        const len = st.windows[k].end - st.windows[k].start;
        const overlap = Math.max(0, Math.min(SEAM, Math.min(len, prev.end - prev.start) - 1));
        st.windows[k].start = prev.end - overlap;
        st.windows[k].end = st.windows[k].start + len;
      }
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
      for (let k = i + 1; k < st.windows.length; k++) {
        const prev = st.windows[k - 1];
        const len = st.windows[k].end - st.windows[k].start;
        const overlap = Math.max(0, Math.min(SEAM, Math.min(len, prev.end - prev.start) - 1));
        st.windows[k].start = prev.end - overlap;
        st.windows[k].end = st.windows[k].start + len;
      }
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
      const len = Math.max(MIN_LEN, Math.round(Number(lenField.value) * FPS) || MIN_LEN);
      w.end = w.start + len; changed();
    };
    const snap = el("button", { type: "button", class: "btn small ghost", title: "Snap this window's length to an H3-legal 5+17n frame count",
      onclick: () => { w.end = w.start + alignedLength(w.end - w.start, MIN_LEN); changed(); } }, "H3");

    const prompt = el("textarea", { class: "dir-prompt", rows: "3", placeholder: "Prompt for this segment (empty: the global prompt is used)", value: w.prompt || "" });
    prompt.addEventListener("input", () => { w.prompt = prompt.value; persistState(app, f, st); onDirty?.(); drawTracks(); });

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
      mode.onchange = () => { v.referenceMode = mode.value; persistState(app, f, st); onDirty?.(); };
      return el("span", { class: "dir-chip on ghost", title: `${m.name} · ${fmt(v.start)}s → ${fmt(v.start + v.duration)}s` },
        icon("film"), el("span", {}, m.name), el("small", {}, `${fmt(v.duration)}s`), mode);
    }).filter(Boolean);

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
            const start = last.end - Math.min(SEAM, len - 1);
            st.windows.push({ start, end: start + len, prompt: "", images: [...last.images], audios: [...last.audios] });
            selected = st.windows.length - 1; changed();
          } }, icon("plus"), "Segment"),
          el("button", { type: "button", class: "btn small ghost", disabled: st.windows.length <= 1 ? "true" : undefined, onclick: () => {
            if (st.windows.length <= 1) return;
            st.windows.splice(selected, 1);
            selected = Math.max(0, selected - 1);
            if (st.windows[0]) st.windows[0].start = 0;
            changed();
          } }, "Remove"))),
      prompt,
      el("div", { class: "dir-assign" },
        el("span", { class: "dir-assign-lbl" }, "In this segment"),
        el("div", { class: "dir-chips" },
          ...w.images.map((idx, pos) => assignedChip("image", idx, pos, w.images.length)).filter(Boolean),
          ...w.audios.map((idx, pos) => assignedChip("audio", idx, pos, w.audios.length)).filter(Boolean),
          !w.images.length && !w.audios.length ? el("span", { class: "dim" }, "nothing yet") : null),
        el("span", { class: "dir-assign-lbl" }, "Videos here"),
        videoChips.length ? el("div", { class: "dir-chips" }, ...videoChips) : el("span", { class: "dim" }, "no video clip overlaps this window"),
        el("span", { class: "dir-assign-lbl" }, "Add picture"),
        imgs.length
          ? (imgs.some((m) => !w.images.includes(m.index))
            ? el("div", { class: "dir-chips" }, ...imgs.filter((m) => !w.images.includes(m.index)).map((m) => addChip("image", m)))
            : el("span", { class: "dim" }, "all pictures assigned"))
          : el("span", { class: "dim" }, "none — drop pictures in the bin"),
        el("span", { class: "dir-assign-lbl" }, "Add audio"),
        auds.length
          ? (auds.some((m) => !w.audios.includes(m.index))
            ? el("div", { class: "dir-chips" }, ...auds.filter((m) => !w.audios.includes(m.index)).map((m) => addChip("audio", m)))
            : el("span", { class: "dim" }, "all audio assigned"))
          : el("span", { class: "dim" }, "none")));
  }

  function drawHead() {
    const two = el("button", {
      type: "button", class: `dir-toggle${f.values.two_stage ? " on" : ""}`,
      onclick: () => { f.values.two_stage = !f.values.two_stage; onDirty?.(); draw(); },
    }, icon("spark"), "Two-stage");
    let upscaler = null;
    if (f.values.two_stage) {
      const options = (app.inputs.find((i) => i.id === "upscaler")?.options || []).filter((o) => o.value);
      const sel = el("select", { class: "dir-sel", title: "Latent upscaler" }, ...options.map((o) => el("option", { value: o.value }, o.label || o.value)));
      sel.value = f.values.upscaler || (options[0]?.value ?? "");
      sel.onchange = () => { f.values.upscaler = sel.value; onDirty?.(); };
      const steps = el("input", { class: "dir-num", type: "number", min: "0", max: "20", step: "1", value: String(f.values.high_steps ?? 2), title: "High-resolution steps" });
      steps.onchange = () => { f.values.high_steps = clamp(Number(steps.value) || 0, 0, 20); onDirty?.(); };
      upscaler = el("div", { class: "dir-two" }, sel, el("span", {}, "hi-steps"), steps);
    }
    const ws = root.closest(".ws");
    const collapsed = ws?.classList.contains("collapsed");
    const settings = el("button", { type: "button", class: `dir-toggle${collapsed ? "" : " on"}`, title: "Show or hide the technical settings",
      onclick: () => { ws?.classList.toggle("collapsed"); draw(); } }, icon("sliders"), collapsed ? "Settings" : "Hide settings");
    const zoomOut = el("button", { type: "button", class: "dir-zoom", title: "Zoom out", onclick: () => { zoom = Math.max(18, zoom - 14); store.set("dir.zoom", zoom); draw(); } }, "−");
    const zoomIn = el("button", { type: "button", class: "dir-zoom", title: "Zoom in", onclick: () => { zoom = Math.min(300, zoom + 14); store.set("dir.zoom", zoom); draw(); } }, "+");
    headEl.replaceChildren(
      el("div", { class: "dir-brand" }, icon("film"), el("span", {}, "Material Planner"), el("small", {}, `${st.windows.length} segment${st.windows.length > 1 ? "s" : ""} · ${fmt(totalSeconds())}s · ${totalFrames()} frames`)),
      el("div", { class: "dir-head-right" }, settings, two, upscaler, el("div", { class: "dir-zoombox" }, zoomOut, el("span", {}, `${Math.round(zoom)} px/s`), zoomIn)));
  }

  function drawFoot() {
    const prompt = el("textarea", { class: "dir-global", rows: "2", placeholder: "Global prompt — used by every segment whose own prompt is empty", value: f.values.global_prompt || "" });
    prompt.addEventListener("input", () => { f.values.global_prompt = prompt.value; onDirty?.(); });
    const go = el("button", { class: "btn dir-go", type: "button" }, icon("spark"), "Generate");
    go.onclick = () => onSubmit?.();
    footEl.replaceChildren(el("div", { class: "dir-global-wrap" }, prompt), go);
  }

  function draw() {
    // normalise clip durations against the probed media before anything renders
    for (const m of mediaOf(app, f, "video")) clipFor("video", m.index);
    for (const m of mediaOf(app, f, "audio")) clipFor("audio", m.index);
    binEl.replaceChildren(binSection("image"), binSection("video"), binSection("audio"));
    drawHead();
    drawSegment();
    drawFoot();
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
  if (!stateCache.has(app.id)) stateCache.set(app.id, parseState(f));
  return stateCache.get(app.id);
}

function persistState(app, f, st) {
  f.values.segment_windows = JSON.stringify(st);
  const first = st.windows[0];
  if (first) f.values.duration = +(((first.end - first.start) / FPS).toFixed(2));
  f.values.segment_count = st.windows.length;
}
