// LTX Sequential Director — a chain of LTX 2.5 I2V / first-and-last-frame runs.
//
// Each segment is its own History run. The panel always asks the server for the last
// frame export, then uploads that frame as the next run's first image. A "cut" checkbox
// deliberately replaces the handoff with a new start image. Nothing links the segment
// videos until the user approves them and presses Assemble; assembly is the bounded
// server-side ffmpeg concat.
import { api, el, icon, toast } from "./util.js";

const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired", "lost"]);
const cache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultOf(app, id, fallback) {
  const input = app.inputs.find((i) => i.id === id);
  return input?.default ?? fallback;
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
    st = {
      start: null,
      startUrl: null,
      aspect: defaultOf(app, "aspect", "16:9 (Widescreen)"),
      megapixels: Number(defaultOf(app, "megapixels", 0.9)),
      segments: Array.from({ length: 4 }, () => blankSegment(app)),
      assembled: null,
      assembling: false,
    };
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
  const ext = (/\.([a-z0-9]+)(?:\?|$)/i.exec(url)?.[1] || "png").toLowerCase();
  return new File([blob], name.replace(/\.[^.]+$/, `.${ext}`), { type: blob.type || "image/png" });
}

function invalidationFrom(st, index) {
  for (let i = index; i < st.segments.length; i += 1) {
    if (i > index && st.segments[i].cut) break;
    const seg = st.segments[i];
    seg.approved = false;
    if (seg.videoUrl) seg.stale = true;
  }
}

function button(label, iconName, onclick, cls = "btn small ghost") {
  return el("button", { class: cls, type: "button", onclick },
    iconName ? icon(iconName) : null, label);
}

function pickImage(label, onFile) {
  const input = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) onFile(file);
  });
  return el("span", { style: { display: "contents" } },
    el("button", { class: "btn small ghost", type: "button", onclick: () => input.click() }, icon("image"), label),
    input);
}

function thumb(url, label) {
  if (!url) return null;
  return el("img", {
    src: url, alt: label, title: label,
    style: { width: "132px", height: "74px", objectFit: "cover", borderRadius: "8px", border: "1px solid #303640" },
  });
}

function cardStyle() {
  return {
    display: "grid", gap: "10px", padding: "14px", border: "1px solid #2b313c",
    borderRadius: "12px", background: "#10151d",
  };
}

function rowStyle() {
  return { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
}

function tag(text, color = "") {
  return el("span", { class: `tag dark${color ? ` ${color}` : ""}` }, text);
}

export function sequentialDirectorView(app) {
  const st = stateFor(app);
  const root = el("div", { style: { padding: "18px", overflow: "auto", display: "grid", gap: "14px" } });

  const aspectInput = app.inputs.find((i) => i.id === "aspect");
  const mpInput = app.inputs.find((i) => i.id === "megapixels");

  function draw() {
    const total = st.segments.length;
    const approved = st.segments.filter((s) => s.approved && s.videoFile).length;
    const head = el("div", { class: "card", style: { display: "grid", gap: "12px" } },
      el("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "start", flexWrap: "wrap" } },
        el("div", {},
          el("h2", { class: "display", style: { margin: 0 } }, "Sequential Director"),
          el("p", { class: "help", style: { margin: "4px 0 0" } },
            "Each segment uses the previous approved segment's last frame as its first image. A cut replaces that handoff with a new picture.")),
        el("div", { style: rowStyle() }, tag(`${approved}/${total} approved`), tag(total >= 8 ? "8 max" : "hard cuts"))),
      el("div", { style: { ...rowStyle(), gap: "14px" } },
        el("label", { class: "field", style: { display: "grid", gap: "4px" } },
          el("span", { class: "lbl" }, "Aspect ratio"),
          (() => {
            const sel = el("select", { class: "selrow", style: { minWidth: "180px" } },
              ...(aspectInput?.options || []).map((o) => el("option", { value: o.value }, o.label)));
            sel.value = st.aspect;
            sel.addEventListener("change", () => { st.aspect = sel.value; st.segments.forEach((s) => { s.approved = false; }); draw(); });
            return sel;
          })()),
        el("label", { class: "field", style: { display: "grid", gap: "4px" } },
          el("span", { class: "lbl" }, "Resolution (MP)"),
          (() => {
            const inp = el("input", {
              type: "number", min: mpInput?.min ?? 0.2, max: mpInput?.max ?? 2,
              step: mpInput?.step ?? 0.1, value: String(st.megapixels), style: { width: "100px" },
            });
            inp.addEventListener("input", () => {
              st.megapixels = Number(inp.value) || 0.9;
              st.segments.forEach((s) => { s.approved = false; });
            });
            return inp;
          })())),
      el("div", { style: rowStyle() },
        thumb(st.startUrl, "Start image"),
        pickImage(st.start ? "Replace start image" : "Choose start image", (file) => {
          revoke(st.startUrl);
          st.start = file;
          st.startUrl = URL.createObjectURL(file);
          invalidationFrom(st, 0);
          draw();
        }),
        st.startUrl ? button("Clear", "x", () => {
          revoke(st.startUrl);
          st.start = null;
          st.startUrl = null;
          invalidationFrom(st, 0);
          draw();
        }, "btn small ghost danger") : null));
    root.replaceChildren(head);

    st.segments.forEach((seg, i) => {
      const segCard = el("div", { style: cardStyle() });
      const status = seg.running ? "running" : seg.error ? "failed" : seg.approved ? "approved" : seg.videoUrl ? "review" : "empty";
      segCard.append(el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" } },
        el("div", { style: rowStyle() }, el("b", {}, `Segment ${i + 1}`), tag(status, seg.approved ? "lime" : seg.error ? "red" : "")),
        el("div", { style: rowStyle() },
          i > 0 ? el("label", { class: "field", style: rowStyle() },
            el("input", {
              type: "checkbox", checked: seg.cut,
              onchange: (e) => {
                seg.cut = e.target.checked;
                if (!seg.cut) { revoke(seg.cutStartUrl); seg.cutStart = null; seg.cutStartUrl = null; }
                invalidationFrom(st, i);
                draw();
              },
            }),
            el("span", { class: "lbl" }, "Hard cut / new start image")) : null,
          st.segments.length > 1 ? button("", "x", () => {
            revoke(seg.lastUrl);
            revoke(seg.cutStartUrl);
            st.segments.splice(i, 1);
            invalidationFrom(st, Math.max(0, i - 1));
            draw();
          }) : null)));

      const prompt = el("textarea", {
        rows: "3", placeholder: "What happens in this segment?",
        style: { width: "100%", resize: "vertical", minHeight: "66px" },
      });
      prompt.value = seg.prompt;
      prompt.addEventListener("input", () => { seg.prompt = prompt.value; invalidationFrom(st, i); });
      segCard.append(prompt);

      const duration = el("input", {
        type: "number", min: "1", max: "30", step: "1", value: String(seg.duration), style: { width: "84px" },
      });
      duration.addEventListener("input", () => { seg.duration = Math.max(1, Math.min(30, Number(duration.value) || 5)); invalidationFrom(st, i); });
      const settings = el("div", { style: rowStyle() },
        el("label", { style: rowStyle() }, el("span", { class: "lbl" }, "Seconds"), duration),
        i > 0 && !seg.cut ? el("span", { class: "help" }, "First frame: previous segment's last frame") : null,
        i === 0 ? el("span", { class: "help" }, "First frame: the start image") : null);
      segCard.append(settings);

      if (i > 0 && seg.cut) {
        segCard.append(el("div", { style: rowStyle() },
          thumb(seg.cutStartUrl, `Segment ${i + 1} cut image`),
          pickImage(seg.cutStart ? "Replace cut image" : "Choose cut image", (file) => {
            revoke(seg.cutStartUrl);
            seg.cutStart = file;
            seg.cutStartUrl = URL.createObjectURL(file);
            invalidationFrom(st, i);
            draw();
          })));
      }

      segCard.append(el("div", { style: rowStyle() },
        thumb(seg.lastUrl, "Optional final keyframe"),
        pickImage(seg.last ? "Replace final keyframe" : "Optional final keyframe", (file) => {
          revoke(seg.lastUrl);
          seg.last = file;
          seg.lastUrl = URL.createObjectURL(file);
          invalidationFrom(st, i);
          draw();
        }),
        seg.lastUrl ? button("Clear keyframe", "x", () => {
          revoke(seg.lastUrl);
          seg.last = null;
          seg.lastUrl = null;
          invalidationFrom(st, i);
          draw();
        }) : null));

      const canStart = i === 0 ? Boolean(st.start) : seg.cut ? Boolean(seg.cutStart) : Boolean(st.segments[i - 1]?.approved && st.segments[i - 1]?.lastFrameUrl);
      const actions = el("div", { style: rowStyle() },
        button(seg.videoUrl ? "Regenerate segment" : "Generate segment", "film", () => void runSegment(i), "btn small lime"),
        seg.videoUrl && !seg.approved && !seg.stale ? button("Approve", "check", () => {
          if (seg.stale) { toast("Regenerate this changed segment before approving.", { error: true }); return; }
          seg.approved = true;
          invalidationFrom(st, i + 1);
          draw();
        }, "btn small lime") : null,
        !canStart ? el("span", { class: "help" }, i > 0 && !seg.cut ? "Approve the previous segment first, or use a cut." : "Choose the first image.") : null,
        seg.error ? el("span", { class: "help", style: { color: "var(--bad)" } }, seg.error) : null);
      segCard.append(actions);

      if (seg.videoUrl) {
        segCard.append(el("div", { style: { ...rowStyle(), alignItems: "start" } },
          el("video", {
            src: seg.videoUrl, controls: true, playsinline: true,
            style: { width: "min(520px, 100%)", borderRadius: "10px", background: "#000" },
          }),
          seg.lastFrameUrl ? el("div", { style: { display: "grid", gap: "5px" } },
            el("small", { class: "dim" }, "Last frame"),
            thumb(seg.lastFrameUrl, "Last frame")) : null));
        if (seg.stale) segCard.append(el("small", { class: "help", style: { color: "var(--warn)" } }, "This segment changed after it was approved. Regenerate it before assembly."));
      }
      root.append(segCard);
    });

    root.append(el("div", { class: "card", style: { display: "grid", gap: "10px" } },
      el("div", { style: rowStyle() },
        button("Add segment", "plus", () => {
          if (st.segments.length >= 8) return toast("Eight segments is the current maximum.", { error: true });
          st.segments.push(blankSegment(app));
          draw();
        }),
        button(st.assembling ? "Assembling…" : "Assemble approved segments", "film", () => void assemble(), "btn lime"),
        st.assembled ? el("a", { class: "btn ghost", href: st.assembled, download: "riverfield-sequential.mp4" }, icon("download"), "Download") : null),
      el("p", { class: "help", style: { margin: 0 } },
        "Approve every segment, then assemble. Assembly is a hard-cut concat with the original audio; it is bounded by the server's 120-second CPU editor."),
      st.assembled ? el("video", { src: st.assembled, controls: true, playsinline: true, style: { width: "min(720px, 100%)", borderRadius: "10px" } }) : null));
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
    try {
      first = await firstFileFor(i);
    } catch (e) {
      toast(e.message, { error: true });
      return;
    }
    seg.running = true;
    seg.error = null;
    seg.approved = false;
    seg.stale = false;
    seg.videoUrl = null;
    seg.videoFile = null;
    seg.lastFrameUrl = null;
    seg.lastFrameFile = null;
    invalidationFrom(st, i + 1);
    draw();

    try {
      const fd = new FormData();
      fd.append("image", first, first.name || `segment-${i + 1}-first.png`);
      if (seg.last) fd.append("last_frame", seg.last, seg.last.name || `segment-${i + 1}-last.png`);
      fd.append("prompt", seg.prompt.trim() || "Continue the shot.");
      fd.append("duration", String(seg.duration));
      fd.append("aspect", st.aspect);
      fd.append("megapixels", String(st.megapixels));
      fd.append("last_frame_export", "true");
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
      if (!seg.lastFrameUrl) {
        seg.error = "The video succeeded, but no last frame was extracted. Keep the final keyframe option or add a cut for the next segment.";
      }
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
