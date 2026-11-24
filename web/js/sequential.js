// LTX Sequential Director — a chain of LTX 2.5 I2V / first-and-last-frame runs.
//
// Each segment is its own History run. The panel always asks the server for the last
// frame export, then uploads that frame as the next run's first image. A "cut" checkbox
// deliberately replaces the handoff with a new start image. Nothing links the segment
// videos until the user approves them and presses Assemble; assembly is the bounded
// server-side ffmpeg concat.
import { api, el, icon, toast } from "./util.js";

const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired", "lost"]);
const PER_SEGMENT = new Set(["image", "last_frame", "last_frame_enabled", "prompt", "duration", "last_frame_export"]);
const cache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultOf(app, id, fallback) {
  return app.inputs.find((i) => i.id === id)?.default ?? fallback;
}

function blankSegment(app) {
  return {
    prompt: "",
    duration: Number(defaultOf(app, "duration", 5)),
    last: null,
    lastUrl: null,
    cut: false,
    cutStart: null,
    cutStartUrl: null,
    approved: false,
    running: false,
    jobId: null,
    videoUrl: null,
    videoFile: null,
    lastFrameUrl: null,
    lastFrameFile: null,
    stale: false,
    error: null,
  };
}

function stateFor(app) {
  let st = cache.get(app.id);
  if (!st) {
    st = { selected: 0, start: null, startUrl: null, segments: Array.from({ length: 4 }, () => blankSegment(app)), assembled: null, assembling: false };
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

function invalidationFrom(st, index) {
  for (let i = index; i < st.segments.length; i += 1) {
    if (i > index && st.segments[i].cut) break;
    const seg = st.segments[i];
    seg.approved = false;
    if (seg.videoUrl) seg.stale = true;
  }
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

export function sequentialDirectorView(app, f) {
  const st = stateFor(app);
  const root = el("div", { class: "dir" });
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
    draw();
  }

  function drawHead() {
    const total = st.segments.reduce((n, s) => n + s.duration, 0);
    const approved = st.segments.filter((s) => s.approved && s.videoFile).length;
    head.replaceChildren(
      el("div", { class: "dir-brand" }, icon("film"),
        el("span", {}, app.panel_title || "LTX Sequential Director"),
        el("small", {}, `${st.segments.length} segments · ${fmt(total)}s · ${approved}/${st.segments.length} approved · ${summary(f, app)}`)),
      el("div", { class: "dir-head-right" },
        el("button", { type: "button", class: "dir-toggle", onclick: () => {
          if (st.segments.length >= 8) return toast("Eight segments is the current maximum.", { error: true });
          st.segments.push(blankSegment(app));
          st.selected = st.segments.length - 1;
          draw();
        } }, icon("plus"), "Add segment"),
        el("button", { type: "button", class: "dir-toggle on", onclick: () => void assemble() },
          icon("film"), st.assembling ? "Assembling…" : "Assemble")));
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
      track.append(win);
      cursor += seg.duration;
    });

    const playhead = el("div", { class: "dir-playhead", style: { left: `${((st.segments.slice(0, st.selected).reduce((n, s) => n + s.duration, 0)) / total) * 100}%` } });
    stage.replaceChildren(el("div", { class: "dir-scroll" }, el("div", { class: "dir-canvas" }, ruler, track, playhead)));
  }

  function drawEditor() {
    const i = st.selected;
    const seg = st.segments[i];
    const startAt = st.segments.slice(0, i).reduce((n, s) => n + s.duration, 0);
    const endAt = startAt + seg.duration;
    const prev = i > 0 ? st.segments[i - 1] : null;
    const needsPrev = i > 0 && !seg.cut;
    const ready = i === 0 ? Boolean(st.start) : seg.cut ? Boolean(seg.cutStart) : Boolean(prev?.approved && prev?.lastFrameUrl);
    const status = seg.running ? "running" : seg.error ? "failed" : seg.approved ? "approved" : seg.videoUrl ? "review" : "empty";

    const duration = el("input", { class: "dir-num", type: "number", min: "1", max: "30", step: "1", value: String(seg.duration) });
    duration.addEventListener("input", () => { seg.duration = Math.max(1, Math.min(30, Number(duration.value) || 5)); invalidationFrom(st, i); });
    const cut = el("input", { type: "checkbox", checked: seg.cut });
    cut.addEventListener("change", () => {
      seg.cut = cut.checked;
      if (!seg.cut) { revoke(seg.cutStartUrl); seg.cutStart = null; seg.cutStartUrl = null; }
      invalidationFrom(st, i);
      draw();
    });

    const generate = el("button", { class: "btn small lime", type: "button", onclick: () => void runSegment(i) },
      icon("film"), seg.videoUrl ? "Regenerate" : "Generate segment");
    const approve = seg.videoUrl && !seg.approved ? el("button", {
      class: "btn small ghost", type: "button", onclick: () => {
        if (seg.stale) return toast("Regenerate this changed segment before approving.", { error: true });
        seg.approved = true;
        invalidationFrom(st, i + 1);
        draw();
      },
    }, icon("check"), "Approve") : null;
    const remove = st.segments.length > 1 ? el("button", {
      class: "btn small ghost danger", type: "button", onclick: () => {
        revoke(seg.lastUrl); revoke(seg.cutStartUrl);
        st.segments.splice(i, 1);
        st.selected = Math.min(i, st.segments.length - 1);
        invalidationFrom(st, Math.max(0, i - 1));
        draw();
      },
    }, icon("x"), "Remove") : null;

    const prompt = el("textarea", { class: "dir-prompt", rows: "3", placeholder: "What happens in this segment?" });
    prompt.value = seg.prompt;
    prompt.addEventListener("input", () => { seg.prompt = prompt.value; invalidationFrom(st, i); });

    const firstChip = i === 0
      ? mediaChip(st.start ? "Start image" : "Choose start image", st.startUrl, {
        onPick: (file) => { revoke(st.startUrl); st.start = file; st.startUrl = URL.createObjectURL(file); invalidationFrom(st, 0); draw(); },
        onClear: () => { revoke(st.startUrl); st.start = null; st.startUrl = null; invalidationFrom(st, 0); draw(); },
      })
      : seg.cut
        ? mediaChip(seg.cutStart ? "Cut start image" : "Choose cut image", seg.cutStartUrl, {
          onPick: (file) => { revoke(seg.cutStartUrl); seg.cutStart = file; seg.cutStartUrl = URL.createObjectURL(file); invalidationFrom(st, i); draw(); },
          onClear: () => { revoke(seg.cutStartUrl); seg.cutStart = null; seg.cutStartUrl = null; invalidationFrom(st, i); draw(); },
        })
        : el("span", { class: `dir-chip ${prev?.lastFrameUrl ? "on" : ""}`.trim(), title: "First frame from the previous approved segment" },
          prev?.lastFrameUrl ? el("img", { src: prev.lastFrameUrl, alt: "" }) : icon("image"),
          el("span", {}, prev?.lastFrameUrl ? "Previous segment’s last frame" : "Previous segment not approved yet"));

    const keyframe = mediaChip(seg.last ? "Final keyframe" : "Add final keyframe", seg.lastUrl, {
      onPick: (file) => { revoke(seg.lastUrl); seg.last = file; seg.lastUrl = URL.createObjectURL(file); invalidationFrom(st, i); draw(); },
      onClear: () => { revoke(seg.lastUrl); seg.last = null; seg.lastUrl = null; invalidationFrom(st, i); draw(); },
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
      prompt,
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
          st.assembled ? el("a", { class: "dir-chip on", href: st.assembled, download: "riverfield-sequential.mp4" }, icon("download"), el("span", {}, "Download final cut")) : null)),
      el("button", { class: "btn dir-go", type: "button", onclick: () => void assemble() }, icon("spark"), st.assembling ? "Assembling…" : "Assemble approved"));
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
    drawHead();
    drawStage();
    drawEditor();
    drawFoot();
  }

  async function firstFileFor(i) {
    const seg = st.segments[i];
    if (i === 0) {
      if (!st.start) throw new Error("Choose the start image for segment 1.");
      return st.start;
    }
    if (seg.cut) {
      if (!seg.cutStart) throw new Error("Choose the new start image for this cut.");
      return seg.cutStart;
    }
    const prev = st.segments[i - 1];
    if (!prev?.approved || !prev.lastFrameUrl) throw new Error("Approve the previous segment and keep its last frame available.");
    return fileFromUrl(prev.lastFrameUrl, `segment-${i}-last-frame.png`);
  }

  async function runSegment(i) {
    const seg = st.segments[i];
    if (seg.running) return;
    let first;
    try { first = await firstFileFor(i); } catch (e) { toast(e.message, { error: true }); return; }
    seg.running = true; seg.error = null; seg.approved = false; seg.stale = false;
    seg.videoUrl = null; seg.videoFile = null; seg.lastFrameUrl = null; seg.lastFrameFile = null;
    invalidationFrom(st, i + 1);
    draw();
    try {
      const fd = new FormData();
      fd.append("image", first, first.name || `segment-${i + 1}-first.png`);
      if (seg.last) fd.append("last_frame", seg.last, seg.last.name || `segment-${i + 1}-last.png`);
      fd.append("prompt", seg.prompt.trim() || "Continue the shot.");
      fd.append("duration", String(seg.duration));
      fd.append("last_frame_export", "true");
      for (const inp of app.inputs) {
        if (PER_SEGMENT.has(inp.id)) continue;
        const v = f.values[inp.id];
        if (v === undefined || v === null || v === "") continue;
        if (inp.type === "seed" && (v === -1 || v === "-1")) continue;
        fd.append(inp.id, inp.type === "toggle" ? (v ? "true" : "false") : String(v));
      }
      const started = await api(`/api/apps/${app.id}/run`, { method: "POST", body: fd });
      seg.jobId = started.id;
      let entry = started;
      while (!TERMINAL.has(entry.status)) {
        await sleep(1800);
        entry = await api(`/api/history/${started.id}`);
      }
      if (entry.status !== "succeeded") throw new Error(entry.error?.message || `Run ${entry.status}`);
      const video = entry.outputs.find((o) => o.type === "video");
      const frame = entry.outputs.find((o) => o.type === "image");
      if (!video) throw new Error("The segment finished without a video output.");
      seg.videoUrl = video.url;
      seg.videoFile = video.file;
      seg.lastFrameUrl = frame?.url || null;
      seg.lastFrameFile = frame?.file || null;
      if (!seg.lastFrameUrl) seg.error = "The video succeeded, but no last frame was extracted. Add a cut or a final keyframe for the next segment.";
    } catch (e) {
      seg.error = e.message;
    } finally {
      seg.running = false;
      draw();
    }
  }

  async function assemble() {
    if (st.assembling) return;
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
      toast("Sequential cut assembled.");
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      st.assembling = false;
      draw();
    }
  }

  draw();
  return root;
}
