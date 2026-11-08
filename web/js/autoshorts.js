// Three editing steps; technical workflow parameters stay out of the everyday path.
import { el, icon, toast } from "./util.js";
import { byId } from "./catalog.js";

async function api(path = "", method = "GET", body) {
  const r = await fetch(`/api/autoshorts${path}`, { method, headers: body instanceof FormData ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "The request failed");
  return result;
}
const button = (label, onclick, cls = "btn ghost", extra = {}) => el("button", { type: "button", class: cls, onclick, ...extra }, label);
function field(label, value, change, type = "text") {
  const input = el(type === "textarea" ? "textarea" : "input", { type: type === "textarea" ? null : type, step: type === "number" ? "any" : null, value: value ?? "", rows: type === "textarea" ? 3 : null });
  input.addEventListener("input", () => change(type === "number" ? Number(input.value) : input.value));
  return el("label", { class: "as-field" }, el("span", {}, label), input);
}
function select(label, value, options, change) {
  return el("label", { class: "as-field" }, el("span", {}, label), el("select", { onchange: e => change(e.target.value) },
    ...options.map(o => { const [v, name] = Array.isArray(o) ? o : [o, o]; return el("option", { value: v, selected: String(v) === String(value) }, name); })));
}
const disclosure = (title, ...children) => el("details", { class: "as-disclosure" }, el("summary", {}, title), el("div", { class: "as-detail-body" }, ...children));
const check = (label, value, change) => el("label", { class: "as-check" }, el("input", { type: "checkbox", checked: value, onchange: e => change(e.target.checked) }), el("span", {}, label));
const fileURL = (p, path) => `/api/autoshorts/${p.id}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
const basename = path => path?.split("/").at(-1) || "";
const seconds = n => n == null ? "—" : `${Math.round(n)} s`;
const aspectWidth = (aspect, height) => Math.round(height * (aspect === "9:16" ? 9 / 16 : aspect === "1:1" ? 1 : 16 / 9) / 2) * 2;
const busyProject = p => p?.tasks.some(t => ["queued", "running"].includes(t.status));

export function autoShortsView() {
  let p = null, projects = [], engines = [], assets = [], library = [], step = 0, selected = null, disposed = false, dirty = false, returnStep = null;
  const node = el("div", { class: "as-workspace" }), header = el("header", { class: "as-heading" }), steps = el("nav", { class: "as-steps", "aria-label": "Production steps" });
  const status = el("div", { class: "as-status", "aria-live": "polite" }), content = el("div", { class: "as-content" });
  node.append(header, steps, status, content);
  const safely = fn => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message, { error: true }); status.replaceChildren(el("div", { class: "as-notice error", role: "alert" }, e.message)); } };
  const changed = fn => value => { fn(value); dirty = true; };
  const set = key => changed(v => p.config[key] = v);
  function remember() { try { localStorage.setItem("riverfield.autoshorts.project", p.id); } catch {} }
  function syncProject() { const index = projects.findIndex(x => x.id === p.id); if (index === -1) projects.unshift(p); else projects[index] = p; }
  async function save() {
    if (!p) return;
    const invalid = content.querySelector("input:invalid,textarea:invalid");
    if (invalid) {
      invalid.scrollIntoView({ block: "center" });
      invalid.reportValidity();
      const label = invalid.closest(".as-field")?.querySelector("span")?.textContent?.trim();
      throw new Error(label ? `Fix the “${label}” field.` : "Fix the invalid field before continuing.");
    }
    const saved = await api(`/${p.id}`, "PATCH", { config: p.config, board: p.board });
    p.revision = saved.revision; p.updated = saved.updated; p.title = saved.title; dirty = false; syncProject();
  }
  async function refresh() { p = await api(`/${p.id}`); assets = p.assets || []; dirty = false; syncProject(); draw(); }
  async function open(id) { if (dirty) await save(); p = await api(`/${id}`); assets = p.assets || []; selected = p.board?.scenes[0]?.id || null; step = p.exports.length ? 2 : p.board ? 1 : 0; remember(); draw(); }
  async function create() { if (p && dirty) await save(); p = await api("", "POST", {}); assets = []; selected = null; step = 0; dirty = false; syncProject(); remember(); draw(); }
  const start = (action, scene, force = false) => safely(async () => {
    await save(); await api(`/${p.id}/tasks`, "POST", { action, scene, force });
    returnStep = action === "plan" ? 1 : action === "render" ? 2 : null;
    await refresh();
  });
  const chooseFile = (accept, done, multiple = false) => {
    const input = el("input", { type: "file", accept, multiple, onchange: safely(async () => {
      for (const file of input.files) { const form = new FormData(); form.set("file", file); const { path } = await api(`/${p.id}/import`, "POST", form); assets.push(path); await done(path); }
      dirty = true; draw();
    }) }); input.click();
  };
  const engineOptions = type => engines.filter(a => a.outputs.some(o => o.type === type) && a.inputs.some(i => ["prompt", "global_prompt", "text"].includes(i.id))).map(a => [a.id, a.name]);
  const go = next => () => { step = next; draw(); };
  function sceneList() { return [...(p.board?.scenes || [])].sort((a, b) => a.order - b.order); }
  function preview(media, label, cls = "") {
    if (!media) return el("div", { class: `as-media-empty ${cls}` }, icon("video"), el("span", {}, "No media yet"));
    return /\.(png|jpe?g|webp)$/i.test(media.path)
      ? el("img", { class: cls, src: fileURL(p, media.path), alt: label, loading: "lazy" })
      : el("video", { class: cls, src: fileURL(p, media.path), controls: true, preload: "metadata", playsinline: true });
  }
  function progress() {
    status.replaceChildren(); if (!p) return;
    const scenes = sceneList(), completed = scenes.filter(s => p.states[s.id]?.media).length, accepted = scenes.filter(s => s.decision === "accepted").length;
    const task = p.tasks.at(-1); if (!task) return;
    const busy = ["running", "queued"].includes(task.status), failure = ["failed", "interrupted"].includes(task.status);
    const sceneIndex = scenes.findIndex(s => s.id === task.scene);
    const title = failure ? "Production interrupted" : busy ? task.queue != null ? "Waiting in the inference queue" : "Production running" : task.status === "canceled" ? "Production stopped" : "Step finished";
    const error = task.error || "";
    const readable = /header too small|deserializing header/i.test(error)
      ? "The last upscale failed on an empty or invalid model file. Finished scenes are kept; resuming reuses their files."
      : failure ? error : `${completed}/${scenes.length} media ready · ${accepted} approved`;
    status.append(el("section", { class: `as-notice ${failure ? "error" : busy ? "working" : ""}` },
      el("div", { class: "as-notice-copy" }, el("strong", {}, title, sceneIndex >= 0 ? ` · scene ${sceneIndex + 1}/${scenes.length}` : ""), el("p", {}, readable),
        busy ? el("small", {}, task.operation || task.action, ` · ${seconds((Date.now() - Date.parse(task.started)) / 1000)}`,
          task.queue != null ? ` · file ${task.queue}` : "", task.progress?.step ? ` · ${task.progress.step}/${task.progress.steps}` : "") : null),
      busy ? button("Stop", safely(async () => { await api(`/${p.id}/cancel`, "POST", {}); await refresh(); }))
        : failure || task.status === "canceled" ? button("Resume without redoing everything", safely(async () => {
          if (dirty) await save(); await api(`/${p.id}/tasks`, "POST", { action: task.action, scene: task.action === "produce" ? undefined : task.scene }); await refresh();
        }), "btn lime") : null));
    if (failure) status.append(disclosure("Technical details of the error", el("code", {}, error), el("small", {}, task.operation || "", task.child ? ` · run ${task.child}` : "")));
  }
  function localSettings() {
    const c = p.config, found = el("div", { class: "as-inline" });
    return disclosure("Local LLM connection and advanced settings",
      el("div", { class: "as-fields" }, field("llama.cpp address", c.llmUrl, set("llmUrl")), field("Model (empty = server default)", c.model, set("model"))),
      el("div", { class: "as-inline" },
        button("Detect running llama.cpp servers", safely(async () => {
          const { servers } = await api("/llm-servers");
          if (!servers.length) { found.replaceChildren(); throw new Error("No running llama-server found on this machine. Start it, or enter its address."); }
          found.replaceChildren(...servers.map(s => button(`${s.url}${s.models[0] ? ` · ${s.models[0]}` : ""}`, () => {
            c.llmUrl = s.url; c.model = s.models[0] || ""; dirty = true; draw(); toast("llama.cpp server selected");
          })));
        })),
        button("Show available models", safely(async () => {
          const u = new URL(c.llmUrl); if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("Utilise un serveur local");
          const r = await fetch(`${c.llmUrl.replace(/\/$/, "")}/models`); if (!r.ok) throw new Error(`The local server answered ${r.status}`);
          const d = await r.json(); toast((d.data || []).map(m => m.id).join(", ") || "No model advertised");
        }))),
      found,
      el("div", { class: "as-fields" }, select("Image engine", c.imageEngine, engineOptions("image"), set("imageEngine")), select("Clip engine", c.videoEngine, engineOptions("video"), set("videoEngine"))),
      field("Director instructions", c.system, set("system"), "textarea"), field("Creativity (0–2)", c.temperature, set("temperature"), "number"),
      field("OmniVoice attributes, comma-separated", c.voiceTags.join(", "), changed(v => c.voiceTags = v.split(",").map(s => s.trim()).filter(Boolean))),
      jsonField("TTS parameters", c.speechParams, v => c.speechParams = v),
      field("Local transcription, /v1 URL (optional)", c.alignUrl, set("alignUrl")),
      field("Local vision review, /v1 URL (optional)", c.visionUrl, set("visionUrl")), field("Vision model", c.visionModel, set("visionModel")));
  }
  function jsonField(label, value, change) {
    const input = el("textarea", { rows: 3, value: JSON.stringify(value, null, 2) });
    input.addEventListener("input", () => { try { change(JSON.parse(input.value)); input.setCustomValidity(""); dirty = true; } catch { input.setCustomValidity("Invalid JSON"); } });
    return el("label", { class: "as-field" }, el("span", {}, label), input);
  }
  function setup() {
    const c = p.config;
    const modes = [["FAST", "Fast", "Images, imported media and camera motion."], ["HYBRID", "Balanced", "Images and a few generated clips. Recommended."], ["CINEMA", "Cinema", "Original scenes generated as video."]];
    return el("section", { class: "as-setup" },
      el("div", { class: "as-section-title" }, el("span", { class: "as-eyebrow" }, "01 / Project"), el("h2", { class: "display" }, "What story do you want to tell?"), el("p", { class: "dim" }, "Describe an idea or paste your script. You can edit every scene before production.")),
      field("Topic or script", c.topic, set("topic"), "textarea"),
      el("div", { class: "as-mode-cards" }, ...modes.map(([value, title, description]) => button(el("span", {}, el("strong", {}, title), el("small", {}, description)), () => { c.mode = value; dirty = true; draw(); }, `as-mode${c.mode === value ? " selected" : ""}`, { "aria-pressed": String(c.mode === value) }))),
      el("div", { class: "as-fields" }, select("Format", c.aspect, [["9:16", "Vertical · 9:16"], ["16:9", "Landscape · 16:9"], ["1:1", "Square · 1:1"]], changed(v => { c.aspect = v; c.height = v === "9:16" ? 1920 : 1080; })),
        field("Target duration (seconds)", c.duration, set("duration"), "number"), select("Language", c.language, [...new Map([["fr", "Français"], ["en", "English"], ["es", "Español"], ["de", "Deutsch"], ["it", "Italiano"], ["pt", "Português"], [c.language, c.language === "fr" ? "Français" : c.language]]).entries()], set("language"))),
      el("div", { class: "as-fields" }, select("Narrator voice", c.tts, engines.filter(a => ["tts", "tts-clone", "tts-omni", "tts-omni-clone"].includes(a.id)).map(a => [a.id, a.name]), changed(v => { c.tts = v; draw(); })),
        select("Clip quality", c.profile, [["x2", "Economy · 0.4 MP then x2"], ["native", "Native · no upscale"], ["x4", "Experimental · 0.2 MP then x4"], ["auto", "Automatic · local measurements"], ["custom", "Custom"]], changed(v => { c.profile = v; draw(); }))),
      c.tts.includes("clone") ? el("div", { class: "as-inline" }, el("span", {}, c.voice ? `Voice reference: ${basename(c.voice)}` : "Add a voice sample to clone"), button("Import a voice", () => chooseFile("audio/*", path => c.voice = path))) : null,
      c.profile === "x4" ? el("p", { class: "as-hint" }, "x4 is experimental. Some H3 engines do not accept 0.2 MP; their own limits still apply.") : null,
      c.profile === "custom" ? el("div", { class: "as-fields" }, field("Source megapixels", c.megapixels, set("megapixels"), "number"), select("Upscale", c.factor, [[1, "None"], [2, "x2"], [4, "x4"]], changed(v => c.factor = Number(v)))) : null,
      localSettings(),
      el("div", { class: "as-bottom-actions" }, button(p.board ? "Recreate storyboard" : "Create storyboard", start("plan"), "btn lime"), p.board ? button("Open scenes →", go(1)) : null),
      el("p", { class: "as-hint" }, "Creating the storyboard does not start video generation. Technical settings are collapsed above."));
  }
  function addScene() {
    const scenes = p.board.scenes, s = { id: `shot-${crypto.randomUUID().slice(0, 8)}`, order: Math.max(-1, ...scenes.map(s => s.order)) + 1, duration: 3,
      narration: "", visual: "", prompt: "Describe the scene", engine: p.config.imageEngine, method: "image", references: [], instructions: "", params: {}, profile: "auto", megapixels: .4, factor: 2, trim: 0, keepAudio: false, decision: "pending" };
    scenes.push(s); selected = s.id; dirty = true; draw();
  }
  function moveScene(s, delta) {
    const sorted = sceneList(), index = sorted.findIndex(x => x.id === s.id), other = sorted[index + delta];
    if (other) { [s.order, other.order] = [other.order, s.order]; dirty = true; draw(); }
  }
  function sceneBadge(s) {
    if (p.tasks.at(-1)?.scene === s.id && busyProject(p)) return "Running";
    return s.decision === "regenerate" ? "Redo" : s.decision === "accepted" ? "Approved" : p.states[s.id]?.media ? "To review" : "To create";
  }
  function scenesPanel() {
    if (!p.board) return el("section", { class: "as-empty-state" }, icon("film"), el("h2", {}, "Start with the script"), el("p", {}, "Create a storyboard from your topic, or import a storyboard JSON."), button("Set up the project", go(0), "btn lime"), boardEditor());
    const sorted = sceneList(); let s = sorted.find(x => x.id === selected) || sorted[0]; selected = s?.id;
    const ready = sorted.filter(s => p.states[s.id]?.media).length;
    const rail = el("aside", { class: "as-scene-rail", "aria-label": "Edit scenes" },
      el("div", { class: "as-rail-title" }, el("b", {}, `${sorted.length} scenes`), el("small", {}, `${ready} media ready`)),
      ...sorted.map((scene, index) => {
        const media = p.states[scene.id]?.media;
        const thumb = media && /\.(png|jpe?g|webp)$/i.test(media.path) ? el("img", { src: fileURL(p, media.path), alt: "", loading: "lazy" }) : icon(scene.method === "video" ? "film" : "image");
        return button(el("span", { class: "as-scene-pick-inner" }, el("span", { class: "as-rail-thumb" }, thumb), el("span", {}, el("b", {}, `Scene ${index + 1}`), el("small", {}, `${scene.duration} s · ${sceneBadge(scene)}`), el("span", { class: "as-rail-excerpt" }, scene.narration || scene.visual))),
          () => { selected = scene.id; draw(); }, `as-scene-pick${scene.id === selected ? " selected" : ""}`, { "aria-pressed": String(scene.id === selected) });
      }), button("+ Add a scene", addScene));
    if (!s) return el("div", {}, rail, button("Add a first scene", addScene));
    const state = p.states[s.id] || {}, index = sorted.indexOf(s), media = state.upscale || state.media;
    const editor = el("section", { class: "as-scene-editor" },
      el("div", { class: "as-editor-title" }, el("div", {}, el("span", { class: "as-eyebrow" }, `02 / Scene ${index + 1} of ${sorted.length}`), el("h2", { class: "display" }, s.narration.split(/[.!?]/)[0]?.slice(0, 65) || `Scene ${index + 1}`)), el("span", { class: `as-scene-badge ${s.decision}` }, sceneBadge(s))),
      el("div", { class: "as-shot-main" }, el("div", { class: "as-shot-preview" }, preview(media, s.visual),
        el("div", { class: "as-preview-meta" }, el("small", {}, state.upscale ? "Upscaled preview" : "Source media"), state.media ? el("a", { href: fileURL(p, state.media.path), target: "_blank", rel: "noopener" }, "Open original ↗") : null)),
        el("div", { class: "as-shot-copy" }, field("What the voice says", s.narration, changed(v => { s.narration = v; p.board.narration = sceneList().map(s => s.narration).join(" "); }), "textarea"),
          field("What the scene shows", s.visual, changed(v => s.visual = v), "textarea"), field("Minimum duration (seconds)", s.duration, changed(v => s.duration = v), "number"),
          state.audio ? el("div", { class: "as-narration-player" }, el("small", {}, "Listen to the narration"), el("audio", { src: fileURL(p, state.audio.path), controls: true, preload: "none" })) : el("p", { class: "as-hint" }, "Narration is generated during production."))),
      el("div", { class: "as-shot-actions" }, button(s.decision === "accepted" ? "✓ Scene approved" : "Approve the scene", safely(async () => { s.decision = "accepted"; dirty = true; await save(); draw(); }), s.decision === "accepted" ? "btn ghost" : "btn lime", { disabled: !state.media }),
        button(state.media ? "Regenerate visual" : "Generate visual", start("media", s.id, !!state.media)),
        button("Import another media", () => chooseFile("image/*,video/*", async path => {
          s.references = [path]; s.method = "import"; s.decision = "pending"; dirty = true; await save(); await api(`/${p.id}/tasks`, "POST", { action: "media", scene: s.id }); await refresh();
        }))),
      disclosure("Prompt, engine and options for this scene",
        field("Generation prompt", s.prompt, changed(v => s.prompt = v), "textarea"),
        el("div", { class: "as-fields" }, select("Media type", s.method, [["image", "Animated image"], ["video", "Generated clip"], ["import", "Imported media"]], changed(v => { s.method = v; if (v !== "import") s.engine = v === "image" ? p.config.imageEngine : p.config.videoEngine; draw(); })),
          select("Engine", s.engine, s.method === "import" ? [[s.engine, "Local media, no engine"]] : engineOptions(s.method), changed(v => s.engine = v))),
        select("Scene profile", s.profile, [["auto", "Project setting"], ["native", "Native"], ["x2", "0.4 MP + x2"], ["x4", "0.2 MP + x4 (experimental)"], ["custom", "Custom"]], changed(v => { s.profile = v; draw(); })),
        s.profile === "custom" ? el("div", { class: "as-fields" }, field("Source MP", s.megapixels, changed(v => s.megapixels = v), "number"), select("Upscale", s.factor, [1, 2, 4], changed(v => s.factor = Number(v)))) : null,
        field("References (project media paths, comma-separated)", s.references.join(", "), changed(v => s.references = v.split(",").map(x => x.trim()).filter(Boolean))),
        jsonField("Extra engine parameters", s.params, v => s.params = v),
        el("div", { class: "as-shot-actions" }, button(state.audio ? "Regenerate narration" : "Generate narration", start("audio", s.id, !!state.audio)), button("Re-time captions", start("align", s.id)),
          button(state.upscale ? "Recompute the upscale" : "Upscale the approved scene", start("upscale", s.id, !!state.upscale), "btn ghost", { disabled: s.decision !== "accepted" || s.method === "image" }),
          p.config.visionUrl ? button("Local vision review", start("evaluate", s.id)) : null),
        el("p", { class: "as-hint" }, `Visual: ${seconds(state.media?.seconds)} · Upscale: ${seconds(state.upscale?.seconds)} · Model loading: ${state.media?.modelLoading ?? "not measured"}`),
        state.audio ? el("p", { class: "as-hint" }, `Voice length: ${seconds(state.audio.duration)} · ${state.audio.alignment}`) : null,
        state.evaluation ? el("p", {}, String(state.evaluation)) : null),
      disclosure("Trimming and edit order",
        field("Media start time (seconds)", s.trim, changed(v => s.trim = v), "number"), check("Keep the clip audio under the narration", s.keepAudio, changed(v => s.keepAudio = v)),
        el("div", { class: "as-shot-actions" }, button("← Move earlier", () => moveScene(s, -1), "btn ghost", { disabled: index === 0 }), button("Move later →", () => moveScene(s, 1), "btn ghost", { disabled: index === sorted.length - 1 }),
          button("Remove from edit", () => { if (confirm("Remove this scene from the edit? Its files are kept.")) { p.board.scenes = p.board.scenes.filter(x => x.id !== s.id); dirty = true; draw(); } }))),
      el("div", { class: "as-bottom-actions" }, button("Continue production", start("produce"), "btn lime"), button("Go to export →", go(2))),
      check("Automatically approve new scenes and continue to export", p.config.autoAccept, set("autoAccept")));
    return el("div", { class: "as-storyboard-layout" }, rail, el("div", { class: "as-editor-stack" }, editor, mediaLibrary(), disclosure("Title, hook and closing", field("Video title", p.board.title, changed(v => p.board.title = v)), field("Hook", p.board.hook, changed(v => p.board.hook = v)), field("Closing", p.board.closing, changed(v => p.board.closing = v))), boardEditor()));
  }
  function boardEditor() {
    let raw = p.board ? JSON.stringify(p.board, null, 2) : "";
    return disclosure("Import or edit a storyboard JSON", field("JSON document", raw, v => raw = v, "textarea"), button("Validate and load", safely(async () => {
      p = await api(`/${p.id}`, "PATCH", { config: p.config, board: JSON.parse(raw) }); dirty = false; selected = p.board.scenes[0]?.id; step = 1; syncProject(); draw();
    })));
  }
  function mediaLibrary() {
    return disclosure("Project media and RiverField history", button("Import files", () => chooseFile("image/*,video/*,audio/*", () => {}, true)),
      ...assets.map(path => el("a", { href: fileURL(p, path), target: "_blank", rel: "noopener", title: path }, basename(path))),
      button("Browse previous generations", safely(async () => { const r = await fetch("/api/history"); if (!r.ok) throw new Error("History unavailable"); library = (await r.json()).entries.filter(e => e.status === "succeeded"); draw(); })),
      ...library.slice(0, 30).flatMap(e => e.outputs.filter(o => ["image", "video", "audio"].includes(o.type)).map(o => button(`${e.app} · ${o.name}`, safely(async () => {
        const data = await api(`/${p.id}/import`, "POST", { path: `history/${e.id}/${o.file}` }); assets.push(data.path); draw();
      })))));
  }
  function exportPanel() {
    const c = p.config, latest = p.exports.at(-1), scenes = sceneList(), ready = scenes.filter(s => p.states[s.id]?.media && p.states[s.id]?.audio && s.decision === "accepted").length;
    const heights = c.aspect === "9:16" ? [1920, 1280] : [1080, 720]; if (!heights.includes(c.height)) heights.push(c.height);
    return el("section", { class: "as-export-layout" },
      el("div", { class: "as-export-preview" }, latest ? preview({ path: latest.path }, "Final video") : el("div", { class: "as-empty-state" }, icon("film"), el("h2", {}, "Your film, coming here"), el("p", {}, `${ready} of ${scenes.length} scene${scenes.length === 1 ? "" : "s"} ready to edit.`), button("Review the scenes", go(1))),
        latest ? el("div", { class: "as-shot-actions" }, el("a", { class: "btn lime", href: fileURL(p, latest.path), download: "autoshorts.mp4" }, "Download the MP4"), el("a", { class: "btn ghost", href: fileURL(p, latest.srt), download: "captions.srt" }, "SRT captions"), el("small", { class: "dim" }, `Encoding: ${seconds(latest.seconds)}`)) : null,
        el("div", { class: "as-timeline", "aria-label": "Edit order" }, ...scenes.map((s, i) => button(el("span", {}, el("b", {}, `${i + 1}`), el("small", {}, `${Math.max(s.duration, p.states[s.id]?.audio?.duration || 0).toFixed(1)} s`), el("span", {}, s.narration.slice(0, 65))), () => { selected = s.id; step = 1; draw(); }, "as-timeline-scene")))),
      el("div", { class: "as-export-settings" }, el("span", { class: "as-eyebrow" }, "03 / Export"), el("h2", { class: "display" }, "Finish the edit"),
        select("Video size", c.height, heights.map(h => [h, `${aspectWidth(c.aspect, h)} × ${h}`]), changed(v => c.height = Number(v))),
        select("Captions", c.subtitles, [["burn", "Burned in · readable and animated"], ["karaoke", "Karaoke · highlighted word"], ["srt", "Separate SRT file"], ["none", "No captions"]], set("subtitles")),
        el("p", { class: "as-hint" }, c.alignUrl ? "Timing from the configured local transcription, or estimated if it fails." : "Timing is estimated from the real voice length. A local transcription engine can improve sync."),
        disclosure("Background music", el("p", { class: "dim" }, c.music ? `Imported track: ${basename(c.music)}` : p.music ? "A generated track is ready." : "No music added."),
          button("Import a track", () => chooseFile("audio/*", path => c.music = path)),
          c.music ? button("Remove the imported track", () => { c.music = ""; dirty = true; draw(); }) : null,
          field("Music volume (0–1)", c.musicVolume, set("musicVolume"), "number"),
          select("Music engine", c.musicEngine, engines.filter(a => ["music", "music-turbo", "music-turbo-hq", "music-yue2"].includes(a.id)).map(a => [a.id, a.name]), set("musicEngine")),
          field("Mood to generate", c.musicPrompt, set("musicPrompt"), "textarea"), button("Generate local music", start("music"))),
        disclosure("Edit settings and caption text", field("Frames per second", c.fps, set("fps"), "number"), select("Framing", c.fit, [["crop", "Fill · centered crop"], ["contain", "Keep everything · letterbox when needed"]], set("fit")), field("Fade duration (seconds)", c.transition, set("transition"), "number"),
          field("Caption text override (optional, estimated timing)", c.subtitleText, set("subtitleText"), "textarea")),
        button(latest ? "Export a new version" : "Render the final MP4", start("render"), "btn lime"), el("p", { class: "as-hint" }, "The edit reuses saved scenes. It does not rerun video models."),
        p.exports.length > 1 ? disclosure("Previous versions", ...p.exports.slice(0, -1).reverse().map(e => el("a", { href: fileURL(p, e.path), target: "_blank", rel: "noopener" }, new Date(e.created).toLocaleString()))) : null));
  }
  function draw() {
    if (disposed) return;
    header.replaceChildren(el("div", { class: "as-brand" }, el("span", { class: "as-eyebrow" }, "RiverField / Local video studio"), el("h1", { class: "display" }, "AutoShorts")),
      p ? el("div", { class: "as-project-title" }, el("strong", {}, p.board?.title || p.title), el("small", { class: "dim" }, "Project saved on this machine")) : null,
      el("div", { class: "as-project-actions" }, select("Project", p?.id || "", [["", "Choose a project"], ...projects.map(x => [x.id, x.id === p?.id ? p.board?.title || p.title : x.title])], safely(open)),
        button("+ New", safely(create)), p ? button("Save", safely(async () => {
          if (!content.querySelector("input:invalid,textarea:invalid")) { await save(); draw(); toast("Project saved"); } else content.querySelector(":invalid").reportValidity();
        })) : null));
    steps.replaceChildren(...["Create", "Scenes", "Export"].map((name, i) => button(el("span", {}, el("b", {}, String(i + 1).padStart(2, "0")), name), go(i), `as-step${step === i ? " active" : ""}`, { "aria-current": step === i ? "step" : null, disabled: !p })));
    progress();
    if (!p) { content.replaceChildren(el("section", { class: "as-welcome" }, el("span", { class: "as-eyebrow" }, "Idea → Scenes → Film"), el("h2", { class: "display" }, "Your next short film starts here."), el("p", { class: "dim" }, "A storyboard, your voice, scenes to approve, then a real edit. Everything stays local."), button("Create a project", safely(create), "btn lime"))); return; }
    content.replaceChildren(step === 0 ? setup() : step === 1 ? scenesPanel() : exportPanel());
    if (busyProject(p)) {
      content.querySelectorAll("input,textarea,select,button").forEach(e => { if (!e.matches(".as-scene-pick,.as-timeline-scene")) e.disabled = true; });
      header.querySelectorAll("input,select,button").forEach(e => e.disabled = true);
    }
  }
  safely(async () => {
    const [a, b] = await Promise.all([api(), api("/capabilities")]); projects = a.projects; engines = b.apps;
    let last; try { last = localStorage.getItem("riverfield.autoshorts.project"); } catch {}
    const previous = projects.find(x => x.id === last) || projects[0];
    if (previous) await open(previous.id); else draw();
  })();
  const timer = setInterval(async () => {
    if (disposed || !p || !busyProject(p)) return;
    try {
      const before = p.tasks.at(-1), next = await api(`/${p.id}`), after = next.tasks.at(-1);
      p = next; assets = p.assets || [];
      if (after?.status !== before?.status || after?.operation !== before?.operation) {
        if (after?.status === "succeeded" && returnStep != null) { step = returnStep; returnStep = null; }
        syncProject(); draw();
      } else progress();
    } catch { /* keep the saved project visible while the web server reconnects */ }
  }, 2000);
  return { node, active: "video", app: byId.get("autoshorts"), dispose: () => { disposed = true; clearInterval(timer); } };
}
