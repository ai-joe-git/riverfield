// Production Studio: the native Riverfield surface for the Production Engine.
// It is deliberately built from the same page, panel, tab, button and media components
// as the rest of the app. No inference starts from opening a production or a scene.
import { api, el, icon, store, toast, fmtSeconds } from "./util.js";
import { modal } from "./agent-controls.js";
import { apps, layoutOf } from "./catalog.js";

const LAST = "production.last";
const ASSET_FOLDERS = [["characters", "Characters"], ["environments", "Environments"], ["props", "Props"], ["tests", "Tests"], ["references", "References"]];
const ASSET_FOLDER_LABEL = Object.fromEntries(ASSET_FOLDERS);
const DIRECTOR_APPS = () => apps.filter((app) => layoutOf(app) === "director" && app.id !== "ltx-sequential-director");
const statusLabel = (state) => state === "canon" ? "Canonical" : state === "alternate" ? "Alternate" : state === "rejected" ? "Rejected" : state === "proposed" ? "Proposed" : state === "observed" ? "Observed" : "Draft";
const statusTag = (state) => el("span", { class: `tag ${state === "canon" ? "lime" : state === "rejected" ? "red" : state === "proposed" ? "violet" : "dark"}` }, statusLabel(state));
const dateLabel = (value) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const candidateUrl = (productionId, candidateId, index = 0) => `/api/productions/${encodeURIComponent(productionId)}/media?candidateId=${encodeURIComponent(candidateId)}&index=${index}`;
const assetUrl = (productionId, assetId, version = "") => `/api/productions/${encodeURIComponent(productionId)}/media?assetId=${encodeURIComponent(assetId)}${version ? `&v=${encodeURIComponent(version)}` : ""}`;

function field(label, value, type = "text") {
  const input = el(type === "textarea" ? "textarea" : "input", {
    type: type === "textarea" ? undefined : type, value: value ?? "", autocomplete: "off",
  });
  return { input, node: el("label", { class: "ag-field" }, el("span", {}, label), input) };
}

function command(productionId, proposalId) {
  return `npm run production -- approve ${productionId} ${proposalId}`;
}

async function createAssetBuild(productionId, appId, category, label, prompt) {
  const result = await api(`/api/productions/${encodeURIComponent(productionId)}/asset-builds`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: appId, category, label, prompt }),
  });
  return result.build;
}

function attachBuild(f, productionId, build, category) {
  f.values.production_id = productionId;
  f.values.production_build_id = build.id;
  f.values.production_asset_folder = category;
}

function proposalsFor(snapshot, sceneId) {
  return Object.values(snapshot.proposals).filter((proposal) => proposal.sceneDecision?.sceneId === sceneId && proposal.status === "proposed");
}

function candidateState(snapshot, sceneId, candidateId) {
  const decision = snapshot.sceneDecisions[sceneId];
  if (!decision) return "draft";
  if (decision.canonicalCandidateId === candidateId) return "canon";
  if (decision.alternateCandidateIds.includes(candidateId)) return "alternate";
  if (decision.rejectedCandidateIds.includes(candidateId)) return "rejected";
  return "draft";
}

function sceneCandidates(snapshot, sceneId) {
  return Object.values(snapshot.candidates).filter((candidate) => candidate.bindings.some((binding) => binding.sceneId === sceneId));
}

function coverFor(snapshot) {
  const asset = Object.values(snapshot.assets).find((item) => item.kind === "image" || item.kind === "video");
  if (asset) return { url: assetUrl(snapshot.production.id, asset.id, asset.hash), video: asset.kind === "video" };
  for (const candidate of Object.values(snapshot.candidates)) {
    const index = candidate.outputs.findIndex((output) => output.type === "image" || output.type === "video");
    if (index >= 0) return { url: candidateUrl(snapshot.production.id, candidate.id, index), video: candidate.outputs[index].type === "video" };
  }
  return null;
}

function summaryCover(item) {
  if (!item.cover) return null;
  return {
    url: item.cover.kind === "asset" ? `/api/productions/${encodeURIComponent(item.id)}/media?assetId=${encodeURIComponent(item.cover.id)}` : `/api/productions/${encodeURIComponent(item.id)}/media?candidateId=${encodeURIComponent(item.cover.id)}&index=${item.cover.outputIndex ?? 0}`,
    video: item.cover.type === "video",
  };
}

function coverNode(cover, alt = "") {
  if (!cover) return el("div", { class: "prod-cover empty" }, icon("film"));
  return cover.video
    ? el("video", { class: "prod-cover", src: cover.url, muted: true, playsinline: true, preload: "metadata" })
    : el("img", { class: "prod-cover", src: cover.url, alt, loading: "lazy" });
}

function openCreateProduction(onCreated) {
  const dialog = modal("New production", "A production is the persistent universe: seasons, episodes, scenes and canonical memory.");
  const title = field("Title", "");
  const logline = field("Short description", "");
  const style = field("Visual style", "");
  const description = field("Production notes", "", "textarea");
  const form = el("div", { class: "ag-dialog-form" }, title.node, logline.node, style.node, description.node);
  const create = el("button", { class: "btn lime", type: "button" }, icon("plus"), "Create production");
  create.onclick = async () => {
    try {
      const created = await api("/api/productions", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          title: title.input.value.trim(), logline: logline.input.value.trim(), style: style.input.value.trim(), description: description.input.value.trim(),
        }),
      });
      dialog.close();
      onCreated?.(created.production.id);
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(form, el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), create));
  dialog.showModal();
  title.input.focus();
}

function productionCard(item) {
  const cover = coverNode(summaryCover(item), item.title);
  const progress = item.scenes ? Math.round((item.canonicalScenes / item.scenes) * 100) : 0;
  return el("a", { class: "prod-card", href: `#/productions/${encodeURIComponent(item.id)}` },
    cover,
    el("div", { class: "prod-card-body" },
      el("div", { class: "prod-card-head" }, el("h3", {}, item.title), el("span", { class: `tag ${item.status === "active" ? "lime" : "dark"}` }, item.status === "active" ? "Active" : item.status)),
      el("p", {}, item.description || item.logline || item.style || "Persistent production"),
      el("div", { class: "prod-card-meta" },
        el("span", {}, `${item.seasons} season${item.seasons === 1 ? "" : "s"} · ${item.episodes} episode${item.episodes === 1 ? "" : "s"} · ${item.scenes} scene${item.scenes === 1 ? "" : "s"}`),
        el("span", {}, `${item.canonicalScenes}/${item.scenes} canonical`)),
      el("div", { class: "prod-progress" }, el("i", { style: { width: `${progress}%` } })),
      el("span", { class: "prod-open" }, "Open production", icon("chevR"))));
}

export function productionsView() {
  const node = el("div", { class: "page production-page" });
  const body = el("div", { class: "prod-grid" });
  const resume = el("a", { class: "pill-link", href: "#/productions", hidden: true }, icon("clock"), "Resume last production");
  const newButton = el("button", { class: "btn lime", type: "button", onclick: () => openCreateProduction((id) => { location.hash = `#/productions/${encodeURIComponent(id)}`; }) }, icon("plus"), "New production");
  const draw = async () => {
    body.replaceChildren(el("div", { class: "empty" }, "Loading productions…"));
    try {
      const data = await api("/api/productions");
      const list = data.productions || [];
      const last = store.get(LAST, "");
      if (last && list.some((item) => item.id === last)) {
        resume.hidden = false; resume.href = `#/productions/${encodeURIComponent(last)}`;
        resume.replaceChildren(icon("clock"), `Resume ${list.find((item) => item.id === last)?.title || last}`);
      } else resume.hidden = true;
      body.replaceChildren(...(list.length ? list.map(productionCard) : [
        el("div", { class: "prod-empty" }, icon("film"), el("h3", {}, "No productions yet"),
          el("p", {}, "Create a universe once, then keep its seasons, scenes and canonical memory across videos and Directors."),
          el("button", { class: "btn lime", type: "button", onclick: () => openCreateProduction((id) => { location.hash = `#/productions/${id}`; }) }, icon("plus"), "Create the first production")),
      ]));
    } catch (error) {
      body.replaceChildren(el("div", { class: "empty" }, `Could not load productions: ${error.message}`));
    }
  };
  node.append(
    el("div", { class: "prod-library-head" },
      el("div", {}, el("span", { class: "tag dark" }, icon("film"), "PRODUCTION ENGINE"), el("h1", { class: "display" }, "Productions"),
        el("p", {}, "Persistent universes, scenes and canonical memory. Directors remain your execution clients.")),
      el("div", { class: "row" }, resume, newButton)),
    body);
  void draw();
  return { node, active: "productions", title: "Productions · RiverField" };
}

function proposalDialog(productionId, snapshot, options = {}) {
  const dialog = modal("Prepare a canonical proposal", "This only prepares a proposal. A human must approve it from the interactive CLI.");
  const scene = options.scene;
  const candidates = options.candidates || (scene ? sceneCandidates(snapshot, scene.id) : []);
  let category = options.category || "identity";
  const categoryInput = el("select", { "aria-label": "Memory category" }, ...[["identity", "Identity"], ["state", "State"], ["episodic", "Episodic"], ["narrative", "Narrative"]].map(([value, label]) => el("option", { value, selected: String(value) === category }, label)));
  categoryInput.onchange = () => { category = categoryInput.value; };
  let phase = options.phase || (category === "episodic" ? "closing" : "opening");
  const phaseInput = el("select", { "aria-label": "Narrative phase" }, ...[["opening", "Opening — before this scene"], ["closing", "Closing — outcome of this scene"], ["global", "Global — production-wide"]].map(([value, label]) => el("option", { value, selected: String(value) === phase }, label)));
  phaseInput.onchange = () => { phase = phaseInput.value; };
  const text = field("Canonical fact or change", options.text || "", "textarea");
  const subjects = field("Subject IDs (comma separated)", (options.subjectIds || []).join(", "));
  const tags = field("Tags (comma separated; continuity/constraint are preserved first)", (options.tags || []).join(", "));
  const sceneField = field("Scene scope (optional; for historical state)", options.sceneId || scene?.id || "");
  const title = field("Proposal title", options.title || "Canonical update");
  const note = field("Review note", options.note || "", "textarea");
  const decisionWrap = scene ? el("div", { class: "prod-decision" },
    el("span", {}, "Scene decision"),
    el("select", { "aria-label": "Scene decision" }, ...(options.decision ? [[options.decision, options.decision]] : [["", "No scene decision"], ["canon", "Canon"], ["alternate", "Alternate"], ["reject", "Reject"]]).map(([value, label]) => el("option", { value, selected: String(value) === String(options.decision || "") }, label))),
    el("select", { "aria-label": "Candidate" }, ...candidates.map((candidate) => el("option", { value: candidate.id, selected: candidate.id === options.candidateId }, candidate.label)))) : null;
  const form = el("div", { class: "ag-dialog-form" },
    title.node,
    scene ? el("p", { class: "help" }, `Scene: ${scene.title}`) : null,
    decisionWrap,
    categoryInput, phaseInput,
    text.node, subjects.node, tags.node, sceneField.node, note.node);
  const submit = el("button", { class: "btn lime", type: "button" }, icon("check"), "Prepare proposal");
  submit.onclick = async () => {
    try {
      const decision = decisionWrap?.querySelectorAll("select")[0]?.value;
      const candidateId = decisionWrap?.querySelectorAll("select")[1]?.value;
      if (decision && !candidateId) throw new Error("Choose a candidate for the scene decision");
      const changes = text.input.value.trim() ? [{
        op: options.factId ? "update" : "add", category, ...(options.factId ? { factId: options.factId } : {}),
        text: text.input.value.trim(),
        subjectIds: subjects.input.value.split(",").map((x) => x.trim()).filter(Boolean),
        tags: tags.input.value.split(",").map((x) => x.trim()).filter(Boolean),
        ...(sceneField.input.value.trim() ? { sceneId: sceneField.input.value.trim() } : {}),
        phase,
      }] : [];
      const body = {
        title: title.input.value.trim() || "Canonical update",
        note: note.input.value.trim(), expectedRevision: snapshot.revision,
        ...(decision ? { sceneDecision: { sceneId: scene.id, candidateId, decision, bindingIds: candidates.find((candidate) => candidate.id === candidateId)?.bindings.filter((binding) => binding.sceneId === scene.id).map((binding) => binding.id) } } : {}),
        ...(changes.length ? { changes } : {}),
      };
      const result = await api(`/api/productions/${encodeURIComponent(productionId)}/proposals`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      dialog.close();
      const cmd = command(productionId, result.proposal.id);
      toast("Proposal prepared. Human approval is required.");
      const confirm = modal("Proposal prepared", "Nothing is canonical yet. Run this exact command in a terminal, review the fingerprint, and type the challenge.");
      confirm.append(el("pre", { class: "code prod-command" }, cmd), el("div", { class: "ag-dialog-actions" },
        el("button", { class: "btn ghost", type: "button", onclick: () => { void navigator.clipboard?.writeText(cmd).then(() => toast("Approval command copied")).catch(() => {}); } }, icon("copy"), "Copy command"),
        el("button", { class: "btn lime", type: "button", onclick: () => confirm.close() }, "Done")));
      confirm.showModal();
      options.onDone?.();
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(form, el("p", { class: "help" }, "The HTTP/MCP boundary cannot approve. The CLI checks the exact proposal fingerprint and expected canonical revision."),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), submit));
  dialog.showModal();
  title.input.focus();
}

function openObservation(productionId, snapshot, scene, onDone) {
  const dialog = modal("Record an observation", "Observations are evidence, not canonical facts. They never enter the Bible by themselves.");
  const text = field("What did the rendered result actually show?", "", "textarea");
  const confirm = el("button", { class: "btn lime", type: "button" }, icon("plus"), "Record observation");
  confirm.onclick = async () => {
    try {
      await api(`/api/productions/${encodeURIComponent(productionId)}/observations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sceneId: scene.id, text: text.input.value.trim() }),
      });
      dialog.close(); toast("Observation recorded."); onDone?.();
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(el("div", { class: "ag-dialog-form" }, el("p", { class: "help" }, scene.title), text.node),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), confirm));
  dialog.showModal(); text.input.focus();
}

function openRegisterRun(productionId, snapshot, scene, onDone) {
  const dialog = modal("Register a rendered run", "Index a succeeded history run as an immutable candidate. Files stay in History; the scene binding uses final-output frames.");
  const run = field("History run ID", "");
  const label = field("Candidate label", scene.title);
  const start = field("Timeline start frame", "0", "number");
  const end = field("Timeline end frame", "175", "number");
  const segment = field("Segment index", "0", "number");
  const note = field("Note", "", "textarea");
  const submit = el("button", { class: "btn lime", type: "button" }, icon("film"), "Register candidate");
  submit.onclick = async () => {
    try {
      const runId = run.input.value.trim();
      if (!runId) throw new Error("Enter a succeeded history run ID");
      const body = {
        runId, label: label.input.value.trim() || undefined, prompt: note.input.value.trim() || undefined,
        id: `scene-${scene.id}-${runId}`,
        bindings: [{ sceneId: scene.id, segmentIndex: Number(segment.input.value) || 0, timelineStartFrame: Number(start.input.value) || 0, timelineEndFrame: Number(end.input.value) || 1 }],
      };
      await api(`/api/productions/${encodeURIComponent(productionId)}/candidates`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      dialog.close(); toast("Candidate registered. It is not canonical."); onDone?.();
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(el("div", { class: "ag-dialog-form" }, run.node, label.node,
    el("div", { class: "ag-form-row" }, start.node, end.node, segment.node), note.node,
    el("p", { class: "help" }, "The candidate covers only this scene. Use the exact final-output frame range; repeated registration with the same ID is rejected, never duplicated.")),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), submit));
  dialog.showModal(); run.input.focus();
}

function openSceneEdit(productionId, scene, onDone) {
  const dialog = modal("Edit scene", "Editorial metadata only. This does not change candidates or canonical decisions.");
  const number = field("Number", String(scene.number), "number");
  const title = field("Title", scene.title);
  const summary = field("Brief / description", scene.summary || "", "textarea");
  const characters = field("Character IDs (comma separated)", (scene.characterIds || []).join(", "));
  const locations = field("Location IDs (comma separated)", (scene.locationIds || []).join(", "));
  const save = el("button", { class: "btn lime", type: "button" }, icon("check"), "Save scene");
  save.onclick = async () => {
    try {
      await api(`/api/productions/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(scene.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ number: Number(number.input.value), title: title.input.value.trim(), summary: summary.input.value.trim(), characterIds: characters.input.value.split(",").map((x) => x.trim()).filter(Boolean), locationIds: locations.input.value.split(",").map((x) => x.trim()).filter(Boolean) }),
      });
      dialog.close(); onDone?.();
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(el("div", { class: "ag-dialog-form" }, number.node, title.node, summary.node, characters.node, locations.node),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), save));
  dialog.showModal();
}

function deleteScene(productionId, snapshot, scene, onDone) {
  const dialog = modal("Delete scene", "Draft scenes without candidates can be removed. Canonical scenes and scenes with candidate bindings are protected.");
  dialog.append(el("p", { class: "help" }, `${scene.title} — ${sceneCandidates(snapshot, scene.id).length} candidates.`),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"),
      el("button", { class: "btn danger", type: "button", onclick: async () => { try { await api(`/api/productions/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(scene.id)}`, { method: "DELETE" }); dialog.close(); toast("Scene removed."); onDone?.(); } catch (error) { toast(error.message, { error: true }); } } }, icon("trash"), "Delete scene")));
  dialog.showModal();
}

function openAssetEdit(productionId, asset, onDone) {
  const dialog = modal("Edit asset metadata", "The original media file is never rewritten. Only the Production Engine index is edited.");
  const label = field("Label", asset.label);
  const category = el("select", { "aria-label": "Asset folder" }, ...ASSET_FOLDERS.map(([value, name]) => el("option", { value, selected: String(value) === String(asset.category || "references") }, name)));
  const tags = field("Tags (comma separated)", (asset.tags || []).join(", "));
  const save = el("button", { class: "btn lime", type: "button" }, icon("check"), "Save asset");
  save.onclick = async () => {
    try {
      await api(`/api/productions/${encodeURIComponent(productionId)}/assets/${encodeURIComponent(asset.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: label.input.value.trim(), category: category.value, tags: tags.input.value.split(",").map((x) => x.trim()).filter(Boolean) }) });
      dialog.close(); onDone?.();
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(el("div", { class: "ag-dialog-form" }, label.node, el("label", { class: "ag-field" }, el("span", {}, "Asset folder"), category), tags.node), el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), save));
  dialog.showModal();
}

function deleteAsset(productionId, asset, onDone) {
  const dialog = modal("Remove asset from production", "The source file stays on disk. Only its production index entry is removed.");
  dialog.append(el("p", { class: "help" }, asset.label),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"),
      el("button", { class: "btn danger", type: "button", onclick: async () => { try { await api(`/api/productions/${encodeURIComponent(productionId)}/assets/${encodeURIComponent(asset.id)}`, { method: "DELETE" }); dialog.close(); toast("Asset removed from production."); onDone?.(); } catch (error) { toast(error.message, { error: true }); } } }, icon("trash"), "Remove asset")));
  dialog.showModal();
}

function openAssetViewer(productionId, asset, onDone) {
  const dialog = modal(asset.label, `${ASSET_FOLDER_LABEL[asset.category || "references"] || asset.category || "References"} · asset viewer`);
  dialog.classList.add("prod-asset-viewer-dialog");
  const url = assetUrl(productionId, asset.id, asset.hash);
  const visual = asset.kind === "image"
    ? el("img", { src: url, alt: asset.label })
    : asset.kind === "video"
      ? el("video", { src: url, controls: true, playsinline: true, preload: "metadata" })
      : asset.kind === "audio"
        ? el("audio", { src: url, controls: true, preload: "metadata" })
        : el("div", { class: "prod-asset-viewer-icon" }, icon("file"));
  const visibleTags = (asset.tags || []);
  const meta = el("div", { class: "prod-asset-viewer-meta" },
    el("h3", {}, asset.label),
    el("div", { class: "prod-asset-tags" }, ...visibleTags.map((tag) => el("span", { class: "tag dark", title: tag }, tag))),
    el("dl", {},
      el("dt", {}, "Folder"), el("dd", {}, ASSET_FOLDER_LABEL[asset.category || "references"] || asset.category || "References"),
      el("dt", {}, "Kind"), el("dd", {}, asset.kind),
      asset.sourceRunId ? el("dt", {}, "History run") : null, asset.sourceRunId ? el("dd", {}, asset.sourceRunId) : null,
      asset.hash ? el("dt", {}, "SHA-256") : null, asset.hash ? el("dd", {}, asset.hash.slice(0, 24) + (asset.hash.length > 24 ? "…" : "")) : null,
      el("dt", {}, "Indexed"), el("dd", {}, dateLabel(asset.createdAt) || "—")),
    el("p", { class: "help" }, "The original media file is read in place. Editing metadata, removing this index entry or reusing the image never rewrites or deletes the source."),
    el("div", { class: "prod-asset-viewer-actions" },
      el("a", { class: "btn small lime", href: url, download: asset.label || asset.id, target: "_blank", rel: "noopener" }, icon("download"), "Download"),
      el("button", { class: "btn small ghost", type: "button", onclick: () => { dialog.close(); openAssetEdit(productionId, asset, onDone); } }, icon("sliders"), "Edit"),
      asset.kind === "image" ? el("button", { class: "btn small ghost", type: "button", onclick: () => { dialog.close(); void editAssetInApp("h3-image-edit", asset); } }, icon("wand"), "p-H3 Edit") : null,
      el("button", { class: "btn small ghost danger", type: "button", onclick: () => { dialog.close(); deleteAsset(productionId, asset, onDone); } }, icon("trash"), "Remove")));
  dialog.append(el("div", { class: "prod-asset-viewer" }, el("div", { class: "prod-asset-viewer-media" }, visual), meta),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Close")));
  dialog.showModal();
}

function openAssetBuilder(productionId) {
  const dialog = modal("Build a production asset", "Generate an image with H3 Image. A successful run is indexed automatically in the selected production folder.");
  const label = field("Asset label", "");
  const category = el("select", { "aria-label": "Asset folder" }, ...ASSET_FOLDERS.map(([value, name]) => el("option", { value, selected: String(value) === "references" }, name)));
  const prompt = field("Image prompt", "", "textarea");
  const build = el("button", { class: "btn lime", type: "button" }, icon("spark"), "Open H3 Image");
  build.onclick = async () => {
    try {
      if (!prompt.input.value.trim()) throw new Error("Write an image prompt first");
      const appId = "h3-image";
      const app = apps.find((item) => item.id === appId);
      if (!app) throw new Error("H3 Image is not installed");
      const { formFor } = await import("./workspace.js");
      const created = await createAssetBuild(productionId, appId, category.value, label.input.value.trim() || "Production image", prompt.input.value.trim());
      const f = formFor(app);
      attachBuild(f, productionId, created, category.value);
      f.values.prompt = prompt.input.value.trim();
      f.values.expand = true;
      if (app.inputs.some((input) => input.id === "aspect")) f.values.aspect = "16:9 (Widescreen)";
      dialog.close();
      location.hash = `#/app/${appId}`;
      toast(`Build ${created.id.slice(0, 8)} ready. A successful run will be indexed automatically in ${category.value}.`);
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(el("div", { class: "ag-dialog-form" }, label.node, el("label", { class: "ag-field" }, el("span", {}, "Asset folder"), category), prompt.node,
    el("p", { class: "help" }, "The asset is created only after the H3 Image run succeeds. Opening the builder or the app starts no inference.")),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), build));
  dialog.showModal(); label.input.focus();
}

function openCharacterSheet(productionId, snapshot) {
  const dialog = modal("Create a character sheet", "The H3 Image prompt expander is used for text-to-sheet; p-H3 Image Edit transforms an uploaded head, bust or full-body reference.");
  const name = field("Character name", "");
  const role = field("Role and personality", "");
  const age = field("Age / build", "");
  const faceHair = field("Face, hair, eyes", "");
  const wardrobe = field("Wardrobe", "");
  const style = field("Art direction", "Premium original traditional 2D Japanese mature romantic comedy anime, hand-painted background, cel animation, warm burgundy / dusty rose / ivory / amber brass / deep violet, fine confident line work, restrained film grain. Original design, no existing franchise character.");
  const views = field("Sheet views", "front, three-quarter, side and back full-body turnaround; four expression studies; one close-up bust; one wardrobe detail; neutral studio background", "textarea");
  const notes = field("Additional constraints", "Consistent identity and outfit across every panel. No text, labels, logos, watermark, extra people, duplicate faces, cropped limbs or chibi. Tasteful, opaque clothing.", "textarea");
  const file = el("input", { type: "file", accept: "image/*", "aria-label": "Optional head, bust or full-body reference" });
  const preview = el("img", { class: "prod-sheet-preview", alt: "", hidden: true });
  let image = null;
  file.onchange = () => {
    image = file.files?.[0] || null;
    if (image) { preview.src = URL.createObjectURL(image); preview.hidden = false; }
    else { preview.hidden = true; preview.removeAttribute("src"); }
  };
  const promptFor = () => {
    const parts = [
      "A professional character model sheet for one original character, designed as a production-ready reference.",
      `Character: ${name.input.value.trim() || "unnamed character"}.`,
      role.input.value.trim() ? `Role and personality: ${role.input.value.trim()}.` : "",
      age.input.value.trim() ? `Age and build: ${age.input.value.trim()}.` : "",
      faceHair.input.value.trim() ? `Face, hair and eyes: ${faceHair.input.value.trim()}.` : "",
      wardrobe.input.value.trim() ? `Wardrobe: ${wardrobe.input.value.trim()}.` : "",
      `Sheet views: ${views.input.value.trim() || "front, side, back turnaround and expression studies"}.`,
      style.input.value.trim(),
      notes.input.value.trim(),
    ].filter(Boolean);
    return parts.join(" ");
  };
  const textButton = el("button", { class: "btn lime", type: "button", disabled: true }, icon("spark"), "Open H3 Image");
  const editButton = el("button", { class: "btn ghost", type: "button", disabled: true }, icon("wand"), "Open p-H3 Edit");
  const refreshButtons = () => { textButton.disabled = Boolean(image); editButton.disabled = !image; };
  file.addEventListener("change", refreshButtons);
  const open = async (appId) => {
    try {
      const { formFor } = await import("./workspace.js");
      const app = apps.find((item) => item.id === appId);
      if (!app) throw new Error(`${appId} is not installed`);
      const prompt = promptFor();
      const label = `Character sheet — ${name.input.value.trim() || "character"}`;
      const build = await createAssetBuild(productionId, appId, "characters", label, prompt);
      const f = formFor(app);
      attachBuild(f, productionId, build, "characters");
      f.values.prompt = prompt;
      f.values.expand = true;
      if (app.inputs.some((input) => input.id === "aspect")) f.values.aspect = "16:9 (Widescreen)";
      if (image) {
        const input = app.inputs.find((item) => item.type === "image" && !f.files?.[item.id]);
        if (!input) throw new Error(`No empty image slot in ${app.name}`);
        f.files[input.id] = { file: image, url: URL.createObjectURL(image) };
      }
      dialog.close();
      location.hash = `#/app/${encodeURIComponent(app.id)}`;
      toast(`Asset build ready. When this ${image ? "p-H3 edit" : "H3 Image"} succeeds, it is indexed automatically in Characters.`);
    } catch (error) { toast(error.message, { error: true }); }
  };
  textButton.onclick = () => void open("h3-image");
  editButton.onclick = () => void open("h3-image-edit");
  dialog.append(el("div", { class: "ag-dialog-form prod-sheet-form" },
    el("div", { class: "ag-form-row" }, name.node, role.node),
    el("div", { class: "ag-form-row" }, age.node, faceHair.node),
    wardrobe.node, style.node, views.node, notes.node,
    el("label", { class: "ag-field" }, el("span", {}, "Optional head, bust or full-body image"), file),
    preview,
    el("p", { class: "help" }, "No image: opens H3 Image with the existing Qwen3.8 prompt expander. With an image: opens p-H3 Image Edit and preserves the uploaded reference as Picture 1. The generated sheet is not added to the production automatically; index its History output in Assets with folder Characters.")),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), textButton, editButton));
  dialog.showModal();
  refreshButtons();
  name.input.focus();
}

function openAssetFromHistory(productionId, snapshot, onDone) {
  const dialog = modal("Add from History", "Browse your generated library. Click an image, clip or sound to index it in the selected production folder. The original file stays in History.");
  const category = el("select", { "aria-label": "Asset folder" }, ...ASSET_FOLDERS.map(([value, name]) => el("option", { value, selected: String(value) === "references" }, name)));
  const search = el("input", { class: "prod-search", type: "search", placeholder: "Search app, run ID or file" });
  const library = el("div", { class: "prod-history-picker" });
  const status = el("span", { class: "tag dark" }, "Loading History…");
  let entries = [];
  let query = "";
  const draw = () => {
    const q = query.trim().toLowerCase();
    let shown = 0;
    library.replaceChildren();
    for (const entry of entries) {
      for (const [index, output] of (entry.outputs || []).entries()) {
        if (!["image", "video", "audio"].includes(output.type)) continue;
        if (q && !`${entry.app} ${entry.id} ${output.name} ${output.file}`.toLowerCase().includes(q)) continue;
        shown += 1;
        const card = el("button", { class: "prod-history-card", type: "button", title: `Add ${output.name}` },
          output.type === "image" ? el("img", { src: output.url, alt: "", loading: "lazy" })
            : output.type === "video" ? el("video", { src: output.url, muted: true, preload: "metadata" })
              : el("span", { class: "prod-history-audio" }, icon("audio")),
          el("span", { class: "prod-history-label" }, el("b", {}, output.name || output.file), el("small", {}, `${entry.app} · ${dateLabel(entry.created)}`)),
          el("span", { class: "prod-history-add" }, icon("plus"), "Add"));
        card.onclick = async () => {
          if (card.classList.contains("added")) return;
          card.classList.add("adding");
          try {
            await api(`/api/productions/${encodeURIComponent(productionId)}/assets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: entry.id, outputIndex: index, category: category.value }) });
            card.classList.remove("adding"); card.classList.add("added");
            status.textContent = `Added ${output.name}`;
            toast(`Added ${output.name} to ${category.value}.`);
            onDone?.();
          } catch (error) {
            card.classList.remove("adding"); toast(error.message, { error: true });
          }
        };
        library.append(card);
        if (shown >= 180) break;
      }
      if (shown >= 180) break;
    }
    if (!shown) library.append(el("div", { class: "prod-empty" }, icon("film"), el("h3", {}, "No generated media in this search"), el("p", {}, "Try another app, filename or run ID.")));
    status.textContent = `${shown} media result${shown === 1 ? "" : "s"}`;
  };
  search.oninput = () => { query = search.value; draw(); };
  dialog.append(el("div", { class: "prod-history-toolbar" }, el("label", { class: "search" }, icon("search"), search), el("label", { class: "ag-field" }, el("span", {}, "Add to folder"), category), status),
    library,
    el("p", { class: "help" }, "Only succeeded runs are shown. Clicking adds a production index entry; the History file is never copied or modified."),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Close")));
  dialog.showModal();
  void api("/api/history").then((data) => {
    entries = (data.entries || []).filter((entry) => entry.status === "succeeded" && (entry.outputs || []).some((output) => ["image", "video", "audio"].includes(output.type)));
    draw();
  }).catch((error) => { library.replaceChildren(el("div", { class: "prod-empty" }, `Could not load History: ${error.message}`)); });
}

async function editAssetInApp(appId, asset) {
  try {
    const productionId = location.hash.match(/^#\/productions\/([\w-]+)/)?.[1] || "";
    if (!productionId) throw new Error("Open this asset from a production");
    const { formFor } = await import("./workspace.js");
    const app = apps.find((item) => item.id === appId);
    if (!app) throw new Error(`${appId} is not installed`);
    const f = formFor(app);
    const slots = app.inputs.filter((input) => input.type === "image");
    const slot = slots.find((input) => !f.files?.[input.id]);
    if (!slot) throw new Error(`No empty picture slot in ${app.name}; remove a picture there first`);
    const category = asset.category || "references";
    const label = `Edited asset — ${asset.label}`;
    const prompt = String(f.values.prompt || "");
    const build = await createAssetBuild(productionId, appId, category, label, prompt);
    const blob = await fetch(assetUrl(productionId, asset.id, asset.hash)).then((response) => {
      if (!response.ok) throw new Error(`Asset media answered ${response.status}`);
      return response.blob();
    });
    const file = new File([blob], asset.label || `${asset.id}.png`, { type: blob.type || "image/png" });
    f.files[slot.id] = { file, url: URL.createObjectURL(file) };
    attachBuild(f, productionId, build, category);
    toast(`Loaded ${asset.label} in ${slot.label || slot.id}. Successful run will be indexed as a new ${category} asset; the source is unchanged.`);
    location.hash = `#/app/${encodeURIComponent(app.id)}`;
  } catch (error) { toast(error.message, { error: true }); }
}

function openDirectorHandoff(productionId, snapshot, scene) {
  const directors = DIRECTOR_APPS();
  if (!directors.length) return toast("No Director application is installed.", { error: true });
  const dialog = modal("Open scene in a Director", "The Director keeps its normal UI and profiles. The Production Engine supplies the association, brief and selected references without replacing existing bins.");
  const appSelect = el("select", { "aria-label": "Director app" }, ...directors.map((app) => el("option", { value: app.id }, app.name)));
  const brief = field("Scene brief", scene.summary || "", "textarea");
  const imageAssets = Object.values(snapshot.assets).filter((asset) => asset.kind === "image");
  const selected = [];
  const refs = el("div", { class: "prod-ref-picker" }, ...imageAssets.slice(0, 24).map((asset) => {
    const checkbox = el("input", { type: "checkbox", value: asset.id, "aria-label": asset.label });
    checkbox.onchange = () => {
      const index = selected.indexOf(asset.id);
      if (checkbox.checked && index < 0) selected.push(asset.id);
      else if (!checkbox.checked && index >= 0) selected.splice(index, 1);
    };
    return el("label", { class: "prod-ref-choice" }, checkbox, el("img", { src: assetUrl(productionId, asset.id, asset.hash), alt: "" }), el("span", {}, asset.label));
  }));
  const note = el("p", { class: "help" }, "Opening never starts inference. Selected images fill only empty picture slots in the Director; an existing saved timeline or occupied slot is never silently replaced.");
  const open = el("button", { class: "btn lime", type: "button" }, icon("ext"), "Open Director");
  open.onclick = () => {
    store.set("production.handoff", {
      app: appSelect.value, productionId, sceneId: scene.id, sceneTitle: scene.title,
      brief: brief.input.value.trim(), referenceAssetIds: selected,
    });
    dialog.close();
    location.hash = `#/app/${encodeURIComponent(appSelect.value)}/director`;
  };
  dialog.append(el("div", { class: "ag-dialog-form" }, el("label", { class: "ag-field" }, el("span", {}, "Director app"), appSelect), brief.node,
    imageAssets.length ? el("div", { class: "prod-ref-section" }, el("b", {}, "Reference images"), el("p", { class: "help" }, "Selection order is the reference order: selected files fill the next empty picture slots."), refs) : null,
    note),
    el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), open));
  dialog.showModal();
}

function analysisTag(value) {
  const tone = value === "confirmed" ? "lime" : value === "probable" ? "violet" : value === "not_observable" ? "red" : "dark";
  return el("span", { class: `tag ${tone}` }, String(value ?? "uncertain").replace(/_/g, " "));
}

function reportEvidenceUrl(productionId, jobId, evidence) {
  return `/api/observation-jobs/${encodeURIComponent(jobId)}/evidence?file=${encodeURIComponent(evidence.file || "")}`;
}

function reportEvidenceCard(productionId, jobId, evidence) {
  const src = reportEvidenceUrl(productionId, jobId, evidence);
  const media = evidence.mime?.startsWith("audio/")
    ? el("audio", { src, controls: true, preload: "metadata" })
    : evidence.mime?.startsWith("video/") || evidence.kind === "video"
      ? el("video", { src, controls: true, preload: "metadata" })
      : el("img", { src, alt: evidence.label || evidence.id, loading: "lazy" });
  return el("figure", { class: "prod-analysis-evidence-card" }, media,
    el("figcaption", {}, el("b", {}, evidence.id), el("small", {}, `${evidence.kind}${evidence.timestampSeconds !== undefined ? ` · ${fmtSeconds(evidence.timestampSeconds)}` : ""}`)));
}

function observationReportNode(productionId, job, observation, onPropose) {
  const report = observation?.report;
  if (!report) return el("div", { class: "prod-empty small" }, "No structured report was recorded for this job.");
  const evidenceById = new Map((report.evidence || []).map((item) => [item.id, item]));
  const evidenceCards = (report.evidence || []).filter((item) => item.kind !== "audio").slice(0, 24).map((item) => reportEvidenceCard(productionId, job.id, item));
  const dialogue = report.dialogue?.utterances?.length
    ? el("div", { class: "prod-analysis-list" }, ...report.dialogue.utterances.map((utterance) => el("div", { class: "prod-analysis-line" },
      el("b", {}, `${fmtSeconds(utterance.startSeconds)}–${fmtSeconds(utterance.endSeconds)}`),
      el("p", {}, utterance.text),
      el("small", {}, `${utterance.speaker?.label || "Unattributed"} · speaker ${utterance.speaker?.attribution || "unknown"}${utterance.unclear ? " · unclear" : ""}`))))
    : el("p", { class: "help" }, report.dialogue?.limitations?.join(" ") || "ASR did not return timestamped utterances.");
  const findings = report.comparison?.findings?.length
    ? el("div", { class: "prod-analysis-findings" }, ...report.comparison.findings.map((finding) => el("article", { class: "prod-analysis-finding" },
      el("div", { class: "prod-analysis-line-head" }, el("b", {}, finding.category), analysisTag(finding.classification)),
      el("p", {}, el("strong", {}, "Expected: "), finding.expected || "—"),
      el("p", {}, el("strong", {}, "Observed: "), finding.observed || "—"),
      finding.rationale ? el("small", {}, finding.rationale) : null,
      finding.evidenceIds?.length ? el("small", { class: "dim" }, `Evidence: ${finding.evidenceIds.join(", ")}`) : null)))
    : el("p", { class: "help" }, "No comparison findings were recorded.");
  const proposed = report.comparison?.proposedChanges?.length
    ? el("div", { class: "prod-analysis-proposals" }, el("p", { class: "help" }, "These are proposals only. A human must approve any canonical change."),
      ...report.comparison.proposedChanges.map((change) => el("div", { class: "prod-analysis-proposal" },
        el("b", {}, `${change.category} · ${change.phase || "opening"}`), el("p", {}, change.text))),
      el("button", { class: "btn small ghost", type: "button", onclick: () => onPropose?.(observation.id) }, icon("check"), "Prepare canonical proposal"))
    : null;
  const nativeEvidence = report.nativeEvidence?.length
    ? el("div", { class: "prod-analysis-native" }, el("h3", {}, "Native evidence sources"),
      ...report.nativeEvidence.map((item) => el("div", { class: "prod-analysis-native-line" },
        el("b", {}, `${item.id} · ${item.kind}`),
        el("span", {}, `${fmtSeconds(item.startSeconds)}–${fmtSeconds(item.endSeconds)} · ${item.durationSeconds?.toFixed?.(3) ?? item.durationSeconds}s${item.fps ? ` · ${item.fps} fps` : ""}${item.sampleRate ? ` · ${item.sampleRate} Hz` : ""}`),
        el("small", { class: "dim" }, `hash ${item.hash}${item.backendPreprocessing ? ` · ${item.backendPreprocessing}` : ""}`))))
    : null;
  const av = report.audiovisual;
  const avRow = (label, items) => items?.length
    ? el("div", { class: "prod-analysis-av-group" }, el("b", {}, label),
      ...items.map((item) => el("p", {}, `${item.description} `, analysisTag(item.confidence), el("small", { class: "dim" }, ` ${item.evidenceIds.join(", ")}`))))
    : null;
  const audiovisual = av
    ? el("div", { class: "prod-analysis-av" }, el("h3", {}, "Audiovisual observation"),
      avRow("Temporal actions", av.temporalActions), avRow("Dialogue and reactions", av.dialogueAndReactions),
      avRow("Music", av.music), avRow("Environmental sound", av.environmentalSound),
      avRow("Sound effects", av.soundEffects), avRow("Synchronization", av.synchronization),
      avRow("Voice delivery", av.voiceDelivery), avRow("Audio artifacts", av.audioArtifacts),
      avRow("Visual artifacts", av.visualArtifacts),
      av.limitations?.length ? el("p", { class: "help" }, av.limitations.join(" ")) : null)
    : null;
  const stages = el("div", { class: "prod-analysis-stages" }, ...(report.stages || []).map((stage) => el("span", { class: `tag ${stage.status === "succeeded" ? "lime" : stage.status === "failed" ? "red" : stage.status === "skipped" ? "dark" : "violet"}`, title: stage.error || "" }, `${stage.name}: ${stage.status}`)));
  return el("div", { class: "prod-analysis-report" },
    el("div", { class: "prod-analysis-stats" },
      el("span", { class: "tag dark" }, `report v${report.reportVersion}`),
      el("span", { class: "tag dark" }, `${report.shots.length} shot${report.shots.length === 1 ? "" : "s"}`),
      el("span", { class: "tag dark" }, `${report.evidence.length} evidence items`),
      el("span", { class: "tag dark" }, report.technical?.width ? `${report.technical.width}×${report.technical.height}` : "technical unknown"),
      el("span", { class: "tag dark" }, report.observer?.observationMode || "visual"),
      report.nativeEvidence?.length ? el("span", { class: "tag violet" }, `${report.nativeEvidence.length} native evidence source${report.nativeEvidence.length === 1 ? "" : "s"}`) : null,
      analysisTag(report.confidence)),
    el("div", { class: "prod-analysis-model-meta" },
      el("small", {}, `Visual: ${report.observer?.visualCheckpoint?.label || report.observer?.model || "unknown"}${report.observer?.visualCheckpoint?.quantization ? ` · ${report.observer.visualCheckpoint.quantization}` : ""}`),
      el("small", {}, `Comparison: ${report.observer?.comparisonCheckpoint?.label || report.observer?.model || "unknown"}${report.observer?.comparisonCheckpoint?.quantization ? ` · ${report.observer.comparisonCheckpoint.quantization}` : ""}`),
      report.observer?.inputModalities ? el("small", {}, `Inputs: ${Object.entries(report.observer.inputModalities).filter(([, on]) => on).map(([name]) => name).join(", ")}`) : null),
    stages,
    el("h3", {}, "Evidence"),
    evidenceCards.length ? el("div", { class: "prod-analysis-evidence" }, ...evidenceCards) : el("p", { class: "help" }, "No visual evidence frames are available."),
    nativeEvidence,
    el("h3", {}, "Shot timeline"),
    el("div", { class: "prod-analysis-shots" }, ...(report.shots || []).map((shot) => el("div", { class: "prod-analysis-shot" },
      el("b", {}, shot.id), el("span", {}, `${fmtSeconds(shot.startSeconds)}–${fmtSeconds(shot.endSeconds)}`), el("small", {}, `${shot.detector} · ${shot.evidenceIds.join(", ")}`)))),
    el("h3", {}, "Actual dialogue (ASR, uncorrected)"),
    dialogue,
    audiovisual,
    el("h3", {}, "Opening / closing state"),
    el("div", { class: "prod-analysis-states" },
      el("div", {}, el("b", {}, "Opening"), el("p", {}, report.visual?.openingState?.description || "Not observable")),
      el("div", {}, el("b", {}, "Closing"), el("p", {}, report.visual?.closingState?.description || "Not observable"))),
    el("h3", {}, "Intent versus observed"),
    findings,
    proposed,
    el("details", { class: "prod-details" }, el("summary", {}, "Limitations and uncertainties"),
      el("pre", { class: "prod-prompt" }, JSON.stringify({ limitations: report.limitations, uncertainties: report.uncertainties }, null, 2))));
}

function openAnalyzeScene(productionId, snapshot, scene, candidate, bindings, onDone) {
  const dialog = modal(`Analyze ${scene.title}`, "Runs an explicit evidence-only observation on this immutable candidate. No candidate, scene or canonical fact is changed.");
  const status = el("div", { class: "prod-analysis-status" }, "Not started. The independent visual pass receives no intended prompt.");
  const progress = el("div", { class: "prod-progress wide" }, el("i", { style: { width: "0%" } }));
  const profileSelect = el("select", { "aria-label": "Observer profile" }, el("option", { value: "custom" }, "Custom"));
  const profileNote = el("p", { class: "help" }, "Profiles supply defaults; changing a model switches to Custom.");
  const previousForSenior = Object.values(snapshot.observations || {})
    .filter((observation) => observation.sceneId === scene.id && observation.candidateId === candidate.id && observation.report)
    .sort((a, b) => (a.revision || 0) - (b.revision || 0));
  const sourceObservationSelect = el("select", { "aria-label": "Senior Review source observation", disabled: !previousForSenior.length },
    ...(previousForSenior.length ? previousForSenior.map((observation) => el("option", { value: observation.id }, `Revision ${observation.revision || "?"} · ${dateLabel(observation.createdAt)}`)) : [el("option", { value: "" }, "No structured observation available")]));
  if (previousForSenior.length) sourceObservationSelect.value = previousForSenior.at(-1).id;
  const sourceField = el("label", { class: "ag-field", hidden: true }, el("span", {}, "Senior Review source observation"), sourceObservationSelect,
    el("small", { class: "help" }, "Senior Review reuses this observation and its evidence; it does not rerun extraction, ASR or the visual pass."));
  const visualModelSelect = el("select", { "aria-label": "Visual observer checkpoint" }, el("option", { value: "" }, "Discovering installed observer checkpoints…"));
  const comparisonModelSelect = el("select", { "aria-label": "Comparison observer checkpoint" }, el("option", { value: "" }, "Discovering installed observer checkpoints…"));
  const nativeVideo = el("input", { type: "checkbox", disabled: true, "aria-label": "Native scene video input" });
  const nativeAudio = el("input", { type: "checkbox", disabled: true, "aria-label": "Native scene audio input" });
  const temperature = el("input", { type: "number", value: "0.1", min: "0.01", max: "2", step: "0.01", "aria-label": "Observer temperature" });
  const maxTokens = el("input", { type: "number", value: "4096", min: "1", max: "32768", step: "1", "aria-label": "Observer output token budget" });
  const topK = el("input", { type: "number", value: "64", min: "0", max: "1000", step: "1", "aria-label": "Observer top-k" });
  const topP = el("input", { type: "number", value: "0.9", min: "0", max: "1", step: "0.01", "aria-label": "Observer top-p" });
  const capabilityNote = el("p", { class: "help" }, "Loading the installed checkpoint list…");
  const modelById = new Map();
  const profileById = new Map();
  let modelsLoaded = false;
  const markCustom = () => {
    if (profileSelect.value !== "custom") profileSelect.value = "custom";
    sourceField.hidden = true;
    profileNote.textContent = "Custom model selection and inference controls are active.";
  };
  const applyProfile = () => {
    const profile = profileById.get(profileSelect.value);
    sourceField.hidden = profileSelect.value !== "senior";
    if (!profile) return;
    if (profile.id === "custom") {
      profileNote.textContent = profile.description || "Custom model selection and inference controls are active.";
      return;
    }
    visualModelSelect.value = profile.visualModel;
    comparisonModelSelect.value = profile.comparisonModel;
    nativeVideo.checked = Boolean(profile.nativeVideo);
    nativeAudio.checked = Boolean(profile.nativeAudio);
    profileNote.textContent = profile.description || "Profiles supply defaults; changing a model switches to Custom.";
    updateCapabilities();
  };
  profileSelect.onchange = applyProfile;
  const updateCapabilities = () => {
    const selected = modelById.get(visualModelSelect.value);
    const video = Boolean(selected?.modalities?.video);
    const audio = Boolean(selected?.modalities?.audio);
    nativeVideo.disabled = !video;
    nativeAudio.disabled = !audio;
    if (!video) nativeVideo.checked = false;
    if (!audio) nativeAudio.checked = false;
    capabilityNote.textContent = selected
      ? `${selected.label} · ${selected.quantization} · ${selected.clipType} · inputs: ${Object.entries(selected.modalities).filter(([, on]) => on).map(([name]) => name).join(", ")}${video || audio ? "" : " · images only"}`
      : "No installed compatible checkpoint was discovered.";
  };
  const modelOptions = (models) => models.map((model) => el("option", { value: model.id }, `${model.label}${model.compatible ? "" : " · unavailable"}`));
  void api("/api/observer-profiles").then((result) => {
    const profiles = result.profiles || [];
    for (const profile of profiles) profileById.set(profile.id, profile);
    profileSelect.replaceChildren(...profiles.map((profile) => el("option", { value: profile.id }, profile.label)));
    profileSelect.value = result.defaultProfile || "custom";
    applyProfile();
  }).catch((error) => { profileNote.textContent = `Could not load observer profiles: ${error.message}`; });
  void api("/api/observer-models").then((result) => {
    const installed = (result.models || []).filter((model) => model.installed && model.compatible);
    for (const model of installed) modelById.set(model.id, model);
    visualModelSelect.replaceChildren(...modelOptions(installed));
    comparisonModelSelect.replaceChildren(...modelOptions(installed));
    const fallback = installed.find((model) => model.id === result.defaultModelId)?.id || installed[0]?.id || "";
    visualModelSelect.value = fallback;
    comparisonModelSelect.value = fallback;
    modelsLoaded = installed.length > 0;
    visualModelSelect.disabled = !modelsLoaded;
    comparisonModelSelect.disabled = !modelsLoaded;
    if (!modelsLoaded) capabilityNote.textContent = "No installed compatible observer checkpoint was discovered in ComfyUI text_encoders.";
    updateCapabilities();
    if (profileSelect.value !== "custom") applyProfile();
    if (startButton) startButton.disabled = !modelsLoaded;
  }).catch((error) => {
    capabilityNote.textContent = `Could not discover observer checkpoints: ${error.message}`;
  });
  visualModelSelect.onchange = () => { markCustom(); updateCapabilities(); };
  comparisonModelSelect.onchange = markCustom;
  nativeVideo.onchange = markCustom;
  nativeAudio.onchange = markCustom;
  const modelField = el("div", { class: "prod-observer-models" },
    el("label", { class: "ag-field" }, el("span", {}, "Observer profile"), profileSelect),
    profileNote, sourceField,
    el("label", { class: "ag-field" }, el("span", {}, "Visual observation model"), visualModelSelect),
    el("label", { class: "ag-field" }, el("span", {}, "Comparison model (independent)"), comparisonModelSelect),
    el("div", { class: "prod-observer-modalities" },
      el("label", {}, nativeVideo, " Native scene video"),
      el("label", {}, nativeAudio, " Native scene audio")),
    capabilityNote);
  const tuningField = el("details", { class: "prod-details" }, el("summary", {}, "Effective inference configuration"),
    el("div", { class: "prod-observer-tuning" },
      el("label", { class: "ag-field" }, el("span", {}, "Temperature"), temperature),
      el("label", { class: "ag-field" }, el("span", {}, "Output token budget"), maxTokens),
      el("label", { class: "ag-field" }, el("span", {}, "Top-k"), topK),
      el("label", { class: "ag-field" }, el("span", {}, "Top-p"), topP)),
    el("p", { class: "help" }, "These values are written to the actual CLIPLoader + TextGenerateV2 graph; they are not report-only metadata."));
  const characterAssets = Object.values(snapshot.assets).filter((asset) => asset.kind === "image" && asset.category === "characters");
  const referenceSelect = el("select", { multiple: true, size: "4", "aria-label": "Identity reference assets" },
    ...characterAssets.map((asset) => el("option", { value: asset.id }, asset.label)));
  void api("/api/asset-audit").then((result) => {
    const audit = new Map((result.assets || []).map((item) => [item.assetId, item]));
    for (const option of referenceSelect.options) {
      const item = audit.get(option.value);
      if (item && !item.trusted) { option.disabled = true; option.textContent = `${option.textContent} · requires catalogue review`; }
    }
  }).catch(() => {});
  const referenceField = characterAssets.length
    ? el("label", { class: "ag-field" }, el("span", {}, "Identity references (optional; limited by the nine-image capacity)"), referenceSelect,
      el("small", { class: "help" }, "Evidence frames and references share nine workflow slots; over-budget requests fail instead of dropping an image."))
    : null;
  const body = el("div", { class: "prod-analysis-body" });
  let job = null;
  let timer = null;
  const cancelButton = el("button", { class: "btn small ghost danger", type: "button", disabled: true }, icon("x"), "Cancel analysis");
  const startButton = el("button", { class: "btn lime", type: "button", disabled: true }, icon("play"), "Start analysis");
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const render = () => {
    if (!job) return;
    const pct = Math.max(0, Math.min(100, Number(job.progress?.percent) || 0));
    progress.firstElementChild.style.width = `${pct}%`;
    status.replaceChildren(el("b", {}, `${job.status} · ${job.progress?.stage || "queued"} · ${pct}%`),
      job.error ? el("small", { class: "dim" }, job.error) : null);
  };
  const loadObservation = async () => {
    const snap = await api(`/api/productions/${encodeURIComponent(productionId)}`);
    const all = Object.values(snap.observations).filter((observation) => observation.sceneId === scene.id && observation.candidateId === candidate.id && observation.report);
    const latest = job?.observationId ? snap.observations[job.observationId] : all.sort((a, b) => (a.revision || 0) - (b.revision || 0)).at(-1);
    body.replaceChildren();
    if (latest?.report) body.append(observationReportNode(productionId, job, latest, (observationId) => proposeObservedChanges(productionId, observationId, () => loadObservation())));
    const previous = all.filter((observation) => observation.id !== latest?.id);
    if (previous.length) body.append(el("section", { class: "prod-section" }, el("h3", {}, "Previous observation revisions"),
      ...previous.map((observation) => el("details", { class: "prod-details" }, el("summary", {}, `Revision ${observation.revision || "?"} · ${dateLabel(observation.createdAt)}`),
        el("p", { class: "help" }, observation.text),
        observation.report ? el("p", { class: "help" }, `${observation.report.shots.length} shots · ${observation.report.dialogue?.utterances.length || 0} transcript utterances`) : null))));
  };
  const poll = async () => {
    if (!job) return;
    try {
      job = await api(`/api/observation-jobs/${encodeURIComponent(job.id)}`);
      render();
      if (["succeeded", "failed", "canceled", "lost"].includes(job.status)) {
        stop(); startButton.disabled = true; cancelButton.disabled = true;
        if (job.status === "succeeded") await loadObservation();
        else body.replaceChildren(el("p", { class: "help" }, job.error || "The analysis job ended before a report was recorded. Extracted evidence is retained."));
      }
    } catch (error) {
      stop(); status.textContent = `Could not read the analysis job: ${error.message}`;
    }
  };
  startButton.onclick = async () => {
    if (!modelsLoaded) return toast("No installed compatible observer checkpoint is available.", { error: true });
    startButton.disabled = true;
    status.textContent = "Submitting the observation job…";
    try {
      job = await api(`/api/productions/${encodeURIComponent(productionId)}/observation-jobs`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          sceneId: scene.id, candidateId: candidate.id, bindingIds: bindings.map((binding) => binding.id),
          referenceAssetIds: [...referenceSelect.selectedOptions].map((option) => option.value),
          profile: profileSelect.value,
          ...(profileSelect.value === "senior" && sourceObservationSelect.value ? { sourceObservationId: sourceObservationSelect.value } : {}),
          options: {
            profile: profileSelect.value,
            maxFrames: 12, visualFrames: Math.max(1, 9 - [...referenceSelect.selectedOptions].length),
            sampleIntervalSeconds: 2, sceneThreshold: 0.3, includeAudio: true, visual: true, asr: true, comparison: true,
            visualModel: visualModelSelect.value, comparisonModel: comparisonModelSelect.value,
            nativeVideo: nativeVideo.checked, nativeAudio: nativeAudio.checked,
            temperature: Number(temperature.value), maxOutputTokens: Number(maxTokens.value),
            topK: Number(topK.value), topP: Number(topP.value),
          },
        }),
      });
      cancelButton.disabled = false; render();
      timer = setInterval(() => { void poll(); }, 1500);
      void poll();
    } catch (error) {
      startButton.disabled = false;
      status.textContent = error.message;
      toast(error.message, { error: true });
    }
  };
  cancelButton.onclick = async () => {
    if (!job) return;
    cancelButton.disabled = true;
    try { job = await api(`/api/observation-jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" }); render(); }
    catch (error) { toast(error.message, { error: true }); }
  };
  const previous = Object.values(snapshot.observations).filter((observation) => observation.sceneId === scene.id && observation.candidateId === candidate.id).sort((a, b) => (a.revision || 0) - (b.revision || 0));
  if (previous.length) body.append(el("section", { class: "prod-section" }, el("h3", {}, "Previous observations"),
    ...previous.map((observation) => el("div", { class: "prod-observation" }, el("b", {}, `Revision ${observation.revision || "?"} · ${dateLabel(observation.createdAt)}`), el("p", {}, observation.text)))));
  dialog.append(status, progress, modelField, tuningField, referenceField, body,
    el("p", { class: "help" }, "The source video is verified and read only. Evidence is cached under out/observations; a failed stage never removes the candidate."),
    el("div", { class: "ag-dialog-actions" },
      el("button", { class: "btn ghost", type: "button", onclick: () => { stop(); dialog.close(); onDone?.(); } }, "Close"),
      cancelButton, startButton));
  dialog.showModal();
}

async function proposeObservedChanges(productionId, observationId, onDone) {
  try {
    const result = await api(`/api/productions/${encodeURIComponent(productionId)}/observations/${encodeURIComponent(observationId)}/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    toast("Canonical proposal prepared. Human approval is still required.");
    onDone?.(result);
  } catch (error) { toast(error.message, { error: true }); }
}

function openCompareCandidates(productionId, scene, candidates, snapshot) {
  const dialog = modal(`Compare ${scene.title}`, "Each candidate keeps its own scene decision. A run covering several scenes is never globally approved.");
  const grid = el("div", { class: "prod-compare-grid" }, ...candidates.map((candidate) => {
    const binding = candidate.bindings.find((item) => item.sceneId === scene.id);
    return el("article", { class: "prod-candidate" },
      el("div", { class: "prod-candidate-head" }, el("div", {}, el("b", {}, candidate.label), el("small", {}, candidate.sourceRunId ? `run ${candidate.sourceRunId}` : candidate.id)), statusTag(candidateState(snapshot, scene.id, candidate.id))),
      mediaPreview(productionId, candidate, binding),
      candidate.prompt ? el("details", { class: "prod-details" }, el("summary", {}, "Submitted prompt"), el("pre", { class: "prod-prompt" }, candidate.prompt)) : null);
  }));
  dialog.append(grid, el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Close")));
  dialog.showModal();
}

function mediaPreview(productionId, candidate, binding, videoOnly = false) {
  const output = candidate.outputs.find((item) => item.type === "video") || candidate.outputs.find((item) => item.type === "image") || candidate.outputs[0];
  if (!output) return el("div", { class: "prod-media empty" }, "No media");
  const index = candidate.outputs.indexOf(output);
  const url = candidateUrl(productionId, candidate.id, index);
  if (output.type === "video") {
    const start = (binding?.timelineStartFrame ?? 0) / (binding?.fps || 24);
    const end = (binding?.timelineEndFrame ?? 0) / (binding?.fps || 24);
    const video = el("video", { class: "prod-media", src: url, controls: true, muted: true, playsinline: true, preload: "metadata" });
    if (binding) {
      video.addEventListener("loadedmetadata", () => { try { video.currentTime = start; } catch { /* metadata may be short */ } });
      video.addEventListener("timeupdate", () => { if (end > start && video.currentTime >= end) video.pause(); });
    }
    return el("div", { class: "prod-media-wrap" }, video,
      binding ? el("small", {}, `final ${binding.timelineStartFrame}–${binding.timelineEndFrame} · ${fmtSeconds((binding.timelineEndFrame - binding.timelineStartFrame) / (binding.fps || 24))}`) : null);
  }
  if (output.type === "image") return el("img", { class: "prod-media", src: url, alt: candidate.label, loading: "lazy" });
  if (output.type === "audio") return el("audio", { class: "prod-media", src: url, controls: true });
  return el("div", { class: "prod-media empty" }, output.name);
}

function sceneStatus(snapshot, scene) {
  const decision = snapshot.sceneDecisions[scene.id];
  if (decision?.status === "canon") return "canon";
  if (proposalsFor(snapshot, scene.id).length) return "proposed";
  if (Object.values(snapshot.observations).some((observation) => observation.sceneId === scene.id)) return "observed";
  if (sceneCandidates(snapshot, scene.id).length) return "draft";
  return "draft";
}

function sceneThumb(snapshot, scene) {
  const candidates = sceneCandidates(snapshot, scene.id);
  for (const candidate of candidates) {
    const videoIndex = candidate.outputs.findIndex((output) => output.type === "video");
    const imageIndex = candidate.outputs.findIndex((output) => output.type === "image");
    if (videoIndex >= 0) {
      const binding = candidate.bindings.find((item) => item.sceneId === scene.id);
      const video = el("video", { class: "prod-scene-thumb", src: candidateUrl(snapshot.production.id, candidate.id, videoIndex), muted: true, playsinline: true, preload: "metadata" });
      if (binding) video.addEventListener("loadedmetadata", () => { try { video.currentTime = binding.timelineStartFrame / (binding.fps || 24); } catch { /* leave poster frame */ } });
      return video;
    }
    if (imageIndex >= 0) return el("img", { class: "prod-scene-thumb", src: candidateUrl(snapshot.production.id, candidate.id, imageIndex), alt: "" });
  }
  return el("div", { class: "prod-scene-thumb empty" }, icon("film"));
}

export function productionView(productionId) {
  const node = el("div", { class: "page production-studio" });
  const body = el("div", { class: "prod-studio-body" });
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const initialTab = params.get("tab");
  const state = {
    snapshot: null, tab: ["bible", "history", "assets"].includes(initialTab) ? initialTab : "episodes",
    seasonId: params.get("season") || "", episodeId: params.get("episode") || "", sceneId: params.get("scene") || "",
    history: null, historyOpen: false, error: "", subject: "", assetFilter: "all", assetQuery: "",
  };
  const draw = async () => {
    body.replaceChildren(el("div", { class: "empty" }, "Loading production…"));
    try {
      state.snapshot = await api(`/api/productions/${encodeURIComponent(productionId)}`);
      const snap = state.snapshot;
      store.set(LAST, productionId);
      if (!state.seasonId) state.seasonId = snap.seasons[0]?.id || "";
      if (!state.episodeId) state.episodeId = snap.episodes.find((episode) => episode.seasonId === state.seasonId)?.id || snap.episodes[0]?.id || "";
      if (!state.sceneId) state.sceneId = snap.scenes.find((scene) => scene.episodeId === state.episodeId)?.id || snap.scenes[0]?.id || "";
      paint();
      if (state.tab === "history" && !state.history) void loadHistory();
    } catch (error) {
      body.replaceChildren(el("div", { class: "empty" }, `Could not load production: ${error.message}`));
    }
  };
  const reload = () => void draw();
  const paint = () => {
    const snap = state.snapshot;
    if (!snap) return;
    const cover = coverFor(snap);
    const progress = snap.scenes.length ? Math.round((Object.values(snap.sceneDecisions).filter((decision) => decision.status === "canon").length / snap.scenes.length) * 100) : 0;
    const tabs = el("div", { class: "prod-tabs", role: "tablist" },
      ...[["episodes", "Episodes"], ["bible", "Production Bible"], ["assets", "Assets"], ["runs", "Production Run"], ["continuity", "Continuity"], ["history", "Canon history"]].map(([id, label]) =>
        el("button", { type: "button", role: "tab", "aria-selected": String(state.tab === id), onclick: () => { state.tab = id; if (id === "history") void loadHistory(); paint(); } }, label)));
    const head = el("div", { class: "prod-hero" },
      coverNode(cover, snap.production.title),
      el("div", { class: "prod-hero-copy" },
        el("a", { class: "more", href: "#/productions" }, icon("chevL"), "Productions"),
        el("h1", { class: "display" }, snap.production.title),
        el("p", {}, snap.production.description || snap.production.logline || "Persistent production"),
        el("div", { class: "prod-pills" },
          el("span", { class: `tag ${snap.production.status === "active" ? "lime" : "dark"}` }, snap.production.status === "active" ? "Active" : snap.production.status),
          snap.production.style ? el("span", { class: "tag dark" }, snap.production.style) : null,
          el("span", { class: "tag dark" }, `${snap.scenes.length} scenes`),
          el("span", { class: "tag dark" }, `${Object.keys(snap.candidates).length} candidates`),
          el("span", { class: "tag dark" }, `canon revision ${snap.revision}`)),
        el("div", { class: "prod-progress wide" }, el("i", { style: { width: `${progress}%` } }), el("span", {}, `${progress}% canonical`))));
    body.replaceChildren(head, el("div", { class: "prod-studio-bar" }, tabs,
      el("div", { class: "row" }, el("button", { class: "btn small ghost", type: "button", onclick: reload }, icon("redo"), "Refresh"))),
      state.tab === "episodes" ? episodesPanel(snap) : state.tab === "bible" ? biblePanel(snap) : state.tab === "assets" ? assetsPanel(snap) : state.tab === "runs" ? runsPanel(snap) : state.tab === "continuity" ? continuityPanel(snap) : historyPanel(snap));
  };
  const loadHistory = async () => {
    try {
      const data = await api(`/api/productions/${encodeURIComponent(productionId)}/events`);
      state.history = data.events || [];
      if (state.tab === "history") paint();
    } catch (error) { state.error = error.message; }
  };

  function episodesPanel(snap) {
    const seasons = snap.seasons;
    const season = seasons.find((item) => item.id === state.seasonId) || seasons[0];
    const episodes = snap.episodes.filter((episode) => !season || episode.seasonId === season.id);
    const episode = episodes.find((item) => item.id === state.episodeId) || episodes[0];
    const scenes = snap.scenes.filter((scene) => !episode || scene.episodeId === episode.id).sort((a, b) => a.number - b.number);
    const scene = scenes.find((item) => item.id === state.sceneId) || scenes[0];
    const decisions = scene ? snap.sceneDecisions[scene.id] : null;
    const candidates = scene ? sceneCandidates(snap, scene.id) : [];
    const proposals = scene ? Object.values(snap.proposals).filter((proposal) => proposal.sceneDecision?.sceneId === scene.id) : [];
    const observations = scene ? Object.values(snap.observations).filter((observation) => observation.sceneId === scene.id) : [];
    const addSeason = el("button", { class: "btn small ghost", type: "button", onclick: () => openSeason(productionId, snap, reload) }, icon("plus"), "Season");
    const addEpisode = el("button", { class: "btn small ghost", type: "button", onclick: () => openEpisode(productionId, snap, season, reload) }, icon("plus"), "Episode");
    const addScene = el("button", { class: "btn small ghost", type: "button", onclick: () => openScene(productionId, snap, episode, reload) }, icon("plus"), "Scene");
    const seasonPills = el("div", { class: "pills" }, ...seasons.map((item) => el("button", { type: "button", "aria-pressed": String(season?.id === item.id), onclick: () => { state.seasonId = item.id; state.episodeId = snap.episodes.find((ep) => ep.seasonId === item.id)?.id || ""; state.sceneId = ""; paint(); } }, item.title)));
    const episodePills = el("div", { class: "pills" }, ...episodes.map((item) => el("button", { type: "button", "aria-pressed": String(episode?.id === item.id), onclick: () => { state.episodeId = item.id; state.sceneId = ""; paint(); } }, item.title)));
    const sceneList = el("div", { class: "prod-scene-list" }, ...scenes.map((item) => {
      const status = sceneStatus(snap, item);
      const count = sceneCandidates(snap, item.id).length;
      return el("button", { type: "button", class: `prod-scene${scene?.id === item.id ? " on" : ""}`, onclick: () => { state.sceneId = item.id; paint(); } },
        sceneThumb(snap, item),
        el("span", { class: "prod-scene-copy" }, el("b", {}, `${String(item.number).padStart(2, "0")} · ${item.title}`),
          el("small", {}, item.summary || "No scene brief yet."),
          el("span", { class: "prod-scene-badges" }, statusTag(status), el("span", { class: "tag dark" }, `${count} candidate${count === 1 ? "" : "s"}`))));
    }));
    if (!scenes.length) sceneList.append(el("div", { class: "prod-empty small" }, "No scenes in this episode yet."));
    const detail = scene ? el("div", { class: "prod-detail" },
      el("div", { class: "prod-detail-head" }, el("div", {}, el("span", { class: "tag dark" }, `Scene ${String(scene.number).padStart(2, "0")}`), el("h2", {}, scene.title), el("p", {}, scene.summary || "No scene brief yet.")),
        el("div", { class: "row" },
          candidates.length > 1 ? el("button", { class: "btn small ghost", type: "button", onclick: () => openCompareCandidates(productionId, scene, candidates, snap) }, icon("compare"), "Compare") : null,
          el("button", { class: "btn small ghost", type: "button", onclick: () => openDirectorHandoff(productionId, snap, scene) }, icon("ext"), "Open in Director"),
          el("button", { class: "btn small ghost", type: "button", onclick: () => openRegisterRun(productionId, snap, scene, reload) }, icon("plus"), "Register run"),
          el("button", { class: "btn small ghost", type: "button", onclick: () => openObservation(productionId, snap, scene, reload) }, icon("eye"), "Observe"),
          el("button", { class: "btn small ghost", type: "button", onclick: () => openSceneEdit(productionId, scene, reload) }, icon("sliders"), "Edit scene"),
          el("button", { class: "btn small ghost danger", type: "button", title: "Delete this draft scene; canonical scenes and scenes with candidates are protected", onclick: () => deleteScene(productionId, snap, scene, reload) }, icon("trash"), "Delete"))),
      el("div", { class: "prod-scene-summary" },
        el("span", { class: "tag dark" }, `Decision: ${statusLabel(decisions?.status || "draft")}`),
        decisions?.canonicalCandidateId ? el("span", { class: "tag lime" }, `Canonical: ${snap.candidates[decisions.canonicalCandidateId]?.label || decisions.canonicalCandidateId}`) : null,
        decisions?.alternateCandidateIds?.length ? el("span", { class: "tag violet" }, `${decisions.alternateCandidateIds.length} alternate`) : null,
        decisions?.rejectedCandidateIds?.length ? el("span", { class: "tag red" }, `${decisions.rejectedCandidateIds.length} rejected`) : null),
      candidates.length ? el("div", { class: "prod-candidate-grid" }, ...candidates.map((candidate) => candidateCard(snap, scene, candidate, decisions, proposals, reload))) : el("div", { class: "prod-empty" }, "No candidates yet. Open the scene in a Director or register an existing run."),
      observations.length ? el("section", { class: "prod-section" }, el("h3", {}, "Observations"), ...observations.map((observation) => el("div", { class: "prod-observation" }, el("b", {}, dateLabel(observation.createdAt)), el("p", {}, observation.text)))) : null,
      proposals.length ? proposalsSection(snap, proposals) : null,
      decisions?.canonicalCandidateId ? rollbackHint(snap) : null) : el("div", { class: "prod-empty" }, "Select a scene.");
    return el("div", { class: "prod-workspace" },
      el("div", { class: "prod-sidebar" },
        el("div", { class: "prod-toolbar" }, el("div", {}, el("h2", {}, "Episodes"), el("p", {}, "Scenes are narrative units; candidates are immutable render results.")), el("div", { class: "row" }, addSeason, addEpisode, addScene)),
        seasons.length ? seasonPills : el("div", { class: "prod-empty small" }, "No seasons yet."),
        episodes.length ? episodePills : el("div", { class: "prod-empty small" }, "No episodes yet."),
        el("div", { class: "prod-scene-head" }, el("span", {}, `${scenes.length} scenes`), scene ? el("span", { class: "tag dark" }, episode?.title || "") : null),
        sceneList),
      detail);
  }

  function continuityPanel(snap) {
    const root = el("section", { class: "prod-section prod-continuity" }, el("h2", {}, "Continuity"), el("p", { class: "help" }, "Immutable non-canonical reviews of existing observations. Opening this panel starts no inference."));
    const reviews = el("div", { class: "prod-analysis-list" }, el("p", { class: "help" }, "Loading continuity reviews…"));
    const assets = el("div", { class: "prod-analysis-list" }, el("p", { class: "help" }, "Loading asset audit…"));
    root.append(el("div", { class: "prod-toolbar" }, el("div", {}, el("h3", {}, "Review history"), el("p", {}, "Prepared or completed reviews linked to exact observation revisions.")),
      el("button", { class: "btn small ghost", type: "button", onclick: () => prepareContinuity(snap, reload) }, icon("plus"), "Prepare senior review")), reviews, el("h3", {}, "Asset catalogue warnings"), assets);
    void api(`/api/productions/${encodeURIComponent(productionId)}/continuity-reviews`).then((data) => {
      const list = data.reviews || [];
      reviews.replaceChildren(...(list.length ? list.map((review) => el("details", { class: "prod-details" },
        el("summary", {}, `v${review.revision} · ${review.status} · ${review.sceneIds.length} scene(s) · ${dateLabel(review.createdAt)}`),
        el("p", { class: "help" }, `Reviewer: ${review.reviewer?.model || "?"} (${review.reviewer?.kind || "?"}) · canonical revision ${review.canonicalRevision}`),
        el("p", { class: "help" }, `Observations: ${review.observations.map((o) => `${o.observationId}@r${o.revision}`).join(", ")}`),
        el("p", { class: "help" }, `Evidence references: ${review.evidenceReferences?.length || 0}`),
        review.limitations?.length ? el("p", { class: "help" }, review.limitations.join(" ")) : null,
        el("details", { class: "prod-details" }, el("summary", {}, "Adjacent opening / closing states"),
          el("pre", { class: "prod-prompt" }, JSON.stringify(review.stateRecords || [], null, 2))),
        el("details", { class: "prod-details" }, el("summary", {}, "Findings, uncertainties and correction plans"),
          el("pre", { class: "prod-prompt" }, JSON.stringify({ findings: review.findings, correctionPlans: review.correctionPlans, uncertainties: (review.stateRecords || []).flatMap((state) => state.unknown || []) }, null, 2))))) : [el("p", { class: "help" }, "No continuity reviews recorded yet.")]));
    }).catch((error) => reviews.replaceChildren(el("p", { class: "help" }, error.message)));
    void api("/api/asset-audit").then((data) => {
      const bad = (data.assets || []).filter((a) => !a.trusted);
      assets.replaceChildren(el("p", { class: "help" }, data.p6ReferenceWarning?.warning || ""), ...bad.map((a) => el("div", { class: "prod-analysis-finding" }, el("b", {}, `${a.currentLabel} → ${a.proposedLabel}`), el("p", {}, a.reason), el("small", { class: "dim" }, `${a.assetId} · ${a.status}`))));
    }).catch((error) => assets.replaceChildren(el("p", { class: "help" }, error.message)));
    return root;
  }

  function prepareContinuity(snap, reload) {
    const observations = Object.values(snap.observations).filter((o) => o.report);
    const dialog = modal("Prepare senior continuity review", "Creates a prepared, immutable review request from existing observations. No model inference starts.");
    const selected = new Set();
    const rows = observations.map((o) => {
      const checkbox = el("input", { type: "checkbox", value: o.id }); checkbox.onchange = () => checkbox.checked ? selected.add(o) : selected.delete(o);
      return el("label", { class: "prod-ref-choice" }, checkbox, el("span", {}, `${o.sceneId} · revision ${o.revision || "?"} · ${o.id}`));
    });
    const submit = el("button", { class: "btn lime", type: "button" }, icon("check"), "Prepare review");
    submit.onclick = async () => {
      const chosen = [...selected];
      if (!chosen.length) return toast("Select at least one existing observation.", { error: true });
      const sceneIds = [...new Set(chosen.map((o) => o.sceneId))];
      try {
        await api(`/api/productions/${encodeURIComponent(productionId)}/continuity-reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          seasonId: snap.episodes.find((e) => e.id === chosen[0].report?.episodeId)?.seasonId,
          episodeId: chosen[0].report?.episodeId, sceneIds,
          bindingIds: chosen.flatMap((o) => o.report?.bindingIds || []), candidateIds: chosen.map((o) => o.candidateId),
          observations: chosen.map((o) => ({ observationId: o.id, sceneId: o.sceneId, revision: o.report.reportVersion, sourceHash: o.report.sourceOutputHash })),
          reviewer: { model: "qwen3.8_27b_w4a8.safetensors", kind: "qwen", configuration: { profile: "senior" } },
          status: "prepared", findings: [], correctionPlans: [], limitations: ["Prepared from existing observations; no supervisor inference launched."],
        }) });
        dialog.close(); toast("Continuity review prepared."); reload?.();
      } catch (error) { toast(error.message, { error: true }); }
    };
    dialog.append(el("div", { class: "ag-dialog-form" }, el("p", { class: "help" }, "Select existing observation revisions. No new observation or inference is created."), ...rows),
      el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), submit));
    dialog.showModal();
  }

  function sceneDuration(bindings) {
    const ranges = bindings.map((binding) => [binding.timelineStartFrame, binding.timelineEndFrame, binding.fps || 24]).sort((a, b) => a[0] - b[0]);
    let total = 0, cursor = -1;
    for (const [start, end] of ranges) {
      const fps = ranges.find((range) => range[0] === start)?.[2] || 24;
      const from = Math.max(start, cursor);
      if (end > from) total += (end - from) / fps;
      cursor = Math.max(cursor, end);
    }
    return total;
  }

  function openCandidatePlayback(productionId, candidate, bindings) {
    const ordered = bindings.slice().sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
    const output = candidate.outputs.find((item) => item.type === "video");
    if (!output || !ordered.length) return toast("This candidate has no video binding for the scene.", { error: true });
    const video = el("video", { class: "prod-media", src: candidateUrl(productionId, candidate.id, candidate.outputs.indexOf(output)), controls: true, muted: true, playsinline: true, preload: "metadata" });
    const status = el("p", { class: "help" }, `Scene duration ${fmtSeconds(sceneDuration(ordered))}`);
    let index = 0;
    const seek = () => {
      const binding = ordered[index];
      video.currentTime = binding.timelineStartFrame / (binding.fps || 24);
      status.textContent = `Binding ${index + 1}/${ordered.length} · final ${binding.timelineStartFrame}–${binding.timelineEndFrame} · scene duration ${fmtSeconds(sceneDuration(ordered))}`;
    };
    video.addEventListener("loadedmetadata", seek);
    video.addEventListener("timeupdate", () => {
      const binding = ordered[index];
      if (!binding) return;
      if (video.currentTime >= binding.timelineEndFrame / (binding.fps || 24)) {
        index += 1;
        if (index < ordered.length) seek(); else { index = ordered.length - 1; video.pause(); }
      }
    });
    const replay = el("button", { class: "btn small ghost", type: "button", onclick: () => { index = 0; seek(); void video.play(); } }, icon("redo"), "Replay scene");
    const d = modal(`Play ${candidate.label}`, "Bindings are played in narrative order and clipped to their final-output frame ranges.");
    d.append(video, status, el("div", { class: "ag-dialog-actions" }, replay, el("button", { class: "btn ghost", type: "button", onclick: () => d.close() }, "Close")));
    d.showModal();
    requestAnimationFrame(() => { seek(); void video.play().catch(() => {}); });
  }

  function candidateProvenance(snap, candidate, bindings) {
    const provenance = candidate.provenance;
    const segmentRows = provenance?.segments?.length
      ? provenance.segments.map((segment) => el("div", { class: "prod-segment" },
          el("b", {}, `Segment ${segment.index + 1}`),
          el("span", {}, `refs ${segment.images.length ? segment.images.map((n) => `<Picture ${n + 1}>`).join(", ") : "none"}${segment.audios.length ? ` · audio ${segment.audios.map((n) => n + 1).join(", ")}` : ""}`),
          el("p", {}, segment.prompt)))
      : null;
    return el("details", { class: "prod-details" },
      el("summary", {}, "Rendering provenance"),
      provenance?.brief ? el("p", { class: "help" }, `Brief: ${provenance.brief}`) : null,
      segmentRows ? el("div", { class: "prod-segments" }, ...segmentRows) : el("p", { class: "help" }, "Exact per-segment prompts are not embedded in this legacy candidate; history recovery is available below."),
      el("div", { class: "prod-fact-meta" },
        el("span", {}, `scene duration ${fmtSeconds(sceneDuration(bindings))}`),
        provenance?.output ? el("span", {}, `output ${provenance.output.verified ? "verified" : "unverified"}${provenance.output.fps ? ` · ${provenance.output.fps.toFixed(2)} fps` : ""}${provenance.output.frameCount ? ` · ${provenance.output.frameCount} frames` : ""}`) : el("span", {}, "output probe not recorded"),
        provenance?.overlaps?.length ? el("span", {}, `overlaps ${provenance.overlaps.join(", ")} frames`) : null),
      provenance?.render ? el("pre", { class: "prod-prompt" }, JSON.stringify(provenance.render, null, 2)) : null);
  }

  function candidateCard(snap, scene, candidate, decision, proposals, reload) {
    const bindings = candidate.bindings.filter((binding) => binding.sceneId === scene.id);
    const stateName = candidateState(snap, scene.id, candidate.id);
    const otherScenes = new Set(candidate.bindings.map((binding) => binding.sceneId)).size - 1;
    const card = el("article", { class: `prod-candidate${stateName === "canon" ? " canonical" : ""}` },
      el("div", { class: "prod-candidate-head" }, el("div", {}, el("b", {}, candidate.label), el("small", {}, candidate.sourceRunId ? `run ${candidate.sourceRunId}` : candidate.id)), statusTag(stateName),
        otherScenes > 0 ? el("span", { class: "tag dark" }, `also covers ${otherScenes} scene${otherScenes === 1 ? "" : "s"}`) : null),
      bindings.map((binding) => mediaPreview(productionId, candidate, binding)),
      candidateProvenance(snap, candidate, bindings),
      candidate.prompt ? el("details", { class: "prod-details" }, el("summary", {}, "Submitted prompt"), el("pre", { class: "prod-prompt" }, candidate.prompt)) : null,
      candidate.render ? el("details", { class: "prod-details" }, el("summary", {}, "Rendering parameters"), el("pre", { class: "prod-prompt" }, JSON.stringify(candidate.render, null, 2))) : null,
      el("div", { class: "prod-candidate-actions" },
        el("button", { class: "btn small ghost", type: "button", onclick: () => openCandidatePlayback(productionId, candidate, bindings) }, icon("play"), "Play scene"),
        el("button", { class: "btn small ghost", type: "button", onclick: () => openAnalyzeScene(productionId, snap, scene, candidate, bindings, reload) }, icon("eye"), "Analyze scene"),
        el("button", { class: "btn small ghost", type: "button", onclick: () => proposalDialog(productionId, snap, { scene, candidates: [candidate], candidateId: candidate.id, decision: "canon", title: `Canonize ${scene.title}`, onDone: reload }) }, icon("check"), "Canon proposal"),
        el("button", { class: "btn small ghost", type: "button", onclick: () => proposalDialog(productionId, snap, { scene, candidates: [candidate], candidateId: candidate.id, decision: "alternate", title: `Keep ${scene.title} alternate`, onDone: reload }) }, icon("layers"), "Alternate"),
        el("button", { class: "btn small ghost danger", type: "button", onclick: () => proposalDialog(productionId, snap, { scene, candidates: [candidate], candidateId: candidate.id, decision: "reject", title: `Reject ${scene.title} candidate`, onDone: reload }) }, icon("x"), "Reject")),
      proposals.filter((proposal) => proposal.sceneDecision?.candidateId === candidate.id).map(proposalRow));
    if (!candidate.provenance && candidate.sourceRunId) {
      void api(`/api/history/${encodeURIComponent(candidate.sourceRunId)}`).then((run) => {
        if (!run) return;
        const windows = (() => {
          const raw = run.values?.segment_windows;
          if (typeof raw !== "string") return [];
          try { return JSON.parse(raw)?.windows ?? []; } catch { return []; }
        })();
        const details = el("details", { class: "prod-details" }, el("summary", {}, "Recovered rendering provenance"),
          windows.length ? el("div", { class: "prod-segments" }, ...windows.map((window, index) => el("div", { class: "prod-segment" },
            el("b", {}, `Segment ${index + 1}`),
            el("span", {}, `refs ${(window.images || []).length ? (window.images || []).map((n) => `<Picture ${n + 1}>`).join(", ") : "none"}${(window.audios || []).length ? ` · audio ${(window.audios || []).map((n) => n + 1).join(", ")}` : ""}`),
            el("p", {}, window.prompt || "No prompt recorded")))) : el("p", { class: "help" }, "No segment prompts recorded in History."),
          run.render ? el("pre", { class: "prod-prompt" }, JSON.stringify(run.render, null, 2)) : null,
          el("small", { class: "dim" }, "Recovered from History; this legacy candidate has no embedded probe metadata."));
        card.insertBefore(details, card.querySelector(".prod-candidate-actions"));
      }).catch(() => {});
    }
    return card;
  }

  function proposalRow(proposal) {
    return el("div", { class: "prod-proposal" },
      el("div", {}, el("b", {}, proposal.title), el("small", {}, `${proposal.status} · expected revision ${proposal.expectedRevision}`)),
      proposal.changes?.length ? el("p", {}, proposal.changes.map((change) => change.text).join(" · ")) : null,
      proposal.status === "proposed" ? el("pre", { class: "prod-command" }, command(productionId, proposal.id)) : null);
  }

  function proposalsSection(snap, proposals) {
    return el("section", { class: "prod-section" }, el("h3", {}, "Canonical proposals"),
      ...proposals.map((proposal) => el("div", { class: "prod-proposal" },
        el("div", {}, el("b", {}, proposal.title), el("small", {}, `${proposal.status} · expected revision ${proposal.expectedRevision}`)),
        proposal.sceneDecision ? el("p", {}, `${proposal.sceneDecision.decision} · ${snap.candidates[proposal.sceneDecision.candidateId]?.label || proposal.sceneDecision.candidateId}`) : null,
        proposal.changes?.length ? el("p", {}, proposal.changes.map((change) => change.text).join(" · ")) : null,
        proposal.status === "proposed" ? el("pre", { class: "prod-command" }, command(productionId, proposal.id)) : null)));
  }

  function rollbackHint(snap) {
    return el("section", { class: "prod-section" }, el("h3", {}, "Canon history"),
      el("p", { class: "help" }, `Current canonical revision: ${snap.revision}. Rollback is a human CLI operation; it appends a restoration event and never deletes the journal.`),
      el("pre", { class: "prod-command" }, `npm run production -- rollback ${productionId} <targetRevision>`));
  }

  function biblePanel(snap) {
    const facts = Object.fromEntries(["identity", "state", "episodic", "narrative"].map((category) => [category, snap.bible[category]]));
    const subjects = [...new Set([...Object.values(facts).flat().flatMap((fact) => fact.subjectIds), ...snap.scenes.flatMap((scene) => [...scene.characterIds, ...scene.locationIds])])].sort();
    const filter = state.subject || "";
    const categories = el("div", { class: "prod-bible" }, ...["identity", "state", "episodic", "narrative"].map((category) => {
      const list = facts[category].filter((fact) => !filter || fact.subjectIds.includes(filter));
      return el("section", { class: "prod-bible-section" },
        el("div", { class: "prod-section-head" }, el("h3", {}, category === "identity" ? "Identity" : category === "state" ? "State" : category === "episodic" ? "Episodic" : "Narrative"),
          el("button", { class: "btn small ghost", type: "button", onclick: () => proposalDialog(productionId, snap, { category, title: `Add ${category} fact`, onDone: reload }) }, icon("plus"), "Add")),
        list.length ? list.map((fact) => factCard(snap, fact)) : el("p", { class: "help" }, "No canonical facts in this category yet."));
    }));
    const assets = Object.values(snap.assets).sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
    const assetGrid = el("div", { class: "prod-assets" }, ...assets.map((asset) => el("figure", { class: "prod-asset" },
      asset.kind === "image" ? el("img", { src: assetUrl(productionId, asset.id, asset.hash), alt: asset.label, loading: "lazy" })
        : asset.kind === "video" ? el("video", { src: assetUrl(productionId, asset.id, asset.hash), muted: true, preload: "metadata" })
          : el("span", { class: "prod-asset-icon" }, icon("audio")),
      el("figcaption", {}, asset.label, el("small", {}, asset.sourceRunId ? ` · ${asset.sourceRunId}` : "")))));
    return el("div", { class: "prod-bible-layout" },
      el("div", { class: "prod-bible-main" },
        el("div", { class: "prod-toolbar" }, el("div", {}, el("h2", {}, "Production Bible"), el("p", {}, "Canonical facts only. Editing creates a proposal; nothing changes until human approval.")),
          el("button", { class: "btn small ghost", type: "button", onclick: () => proposalDialog(productionId, snap, { category: "identity", title: "Add canonical fact", onDone: reload }) }, icon("plus"), "Add fact")),
        el("div", { class: "prod-subjects" }, el("span", { class: "help" }, "Subjects — characters, locations, props"), ...["", ...subjects].map((subject) => el("button", { type: "button", class: `chip${filter === subject ? " on" : ""}`, onclick: () => { state.subject = subject; paint(); } }, subject || "All"))),
        categories),
      el("aside", { class: "prod-bible-side" }, el("div", { class: "prod-section-head" }, el("h3", {}, "Reference assets"), el("span", { class: "tag dark" }, String(assets.length))),
        assets.length ? assetGrid : el("p", { class: "help" }, "No assets indexed yet.")));
  }

  function factCard(snap, fact) {
    return el("article", { class: "prod-fact" },
      el("div", { class: "prod-fact-head" }, el("b", {}, fact.text), el("button", { class: "btn small ghost", type: "button", onclick: () => proposalDialog(productionId, snap, { category: fact.category, factId: fact.id, text: fact.text, subjectIds: fact.subjectIds, tags: fact.tags, sceneId: fact.sceneId, phase: fact.phase, title: `Update ${fact.id}`, onDone: reload }) }, icon("sliders"), "Propose edit")),
      el("div", { class: "prod-fact-meta" },
        el("span", {}, fact.provenance?.source || "unknown"),
        el("span", {}, `revision ${fact.revision}`),
        el("span", {}, `approved by ${fact.approvedBy}`),
        fact.sceneId ? el("span", {}, `scene ${snap.scenes.find((scene) => scene.id === fact.sceneId)?.title || fact.sceneId}`) : el("span", {}, "production-global"),
        fact.tags.length ? el("span", {}, fact.tags.join(", ")) : null),
      fact.provenance?.sourceEventId ? el("small", { class: "dim" }, `evidence event ${fact.provenance.sourceEventId}`) : null);
  }

  function runsPanel(snap) {
    const runs = Object.values(snap.productionRuns || {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const panel = el("div", { class: "prod-section" },
      el("div", { class: "prod-toolbar" }, el("div", {}, el("h2", {}, "Production Run"), el("p", { class: "help" }, "Durable, resumable orchestration. Opening this tab starts no inference; each control is explicit.")),
        el("button", { class: "btn small ghost", type: "button", onclick: () => openRunPlanner(snap, reload) }, icon("plus"), "Plan run")),
      runs.length ? el("div", { class: "prod-analysis-list" }, ...runs.map((run) => runCard(run, snap))) : el("div", { class: "prod-empty" }, icon("film"), el("h3", {}, "No production runs"), el("p", {}, "Prepare an editable brief or load the prepared pilot.")));
    return panel;
  }

  function runCard(run, snap) {
    const current = run.scenePlan[run.currentSceneIndex];
    let selectedObservationId = current?.acceptedObservation?.observationId || current?.observationIds?.at(-1) || "";
    const observationSelect = current && current.observationIds.length > 1
      ? el("select", { "aria-label": "Accepted observation revision" }, ...current.observationIds.map((id) => el("option", { value: id, selected: id === selectedObservationId }, id)))
      : null;
    if (observationSelect) observationSelect.onchange = () => { selectedObservationId = observationSelect.value; };
    const control = (action, label, disabled = false) => {
      const button = el("button", { class: "btn small ghost", type: "button", disabled }, icon(action === "cancel" ? "x" : "film"), label);
      button.onclick = async () => { try { await api(`/api/productions/${encodeURIComponent(productionId)}/runs/${encodeURIComponent(run.id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); toast(`Run ${action}.`); reload(); } catch (error) { toast(error.message, { error: true }); } };
      return button;
    };
    const decide = (decision) => {
      if (!current) return null;
      const ready = current.validation?.ok === true;
      const button = el("button", { class: `btn small ${decision === "approved" ? "lime" : "ghost"}`, type: "button", disabled: !ready, title: ready ? "Human decision" : "Validation is incomplete; inspect the failure first" }, icon(decision === "approved" ? "check" : "x"), decision === "approved" ? "Approve scene" : "Reject scene");
      button.onclick = async () => { try { await api(`/api/productions/${encodeURIComponent(productionId)}/runs/${encodeURIComponent(run.id)}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sceneId: current.sceneId, decision, note: "Production Studio human decision", ...(selectedObservationId ? { observationId: selectedObservationId } : {}) }) }); toast(`Scene ${decision}.`); reload(); } catch (error) { toast(error.message, { error: true }); } };
      return button;
    };
    return el("details", { class: "prod-details", open: true },
      el("summary", {}, `${run.title} · ${run.status} · ${run.stage} · ${run.profile}`),
      el("p", { class: "help" }, run.brief),
      el("div", { class: "row" }, el("span", { class: "tag dark" }, `run revision ${run.revision}`), el("span", { class: "tag dark" }, `canonical ${snap.revision}`),
        el("span", { class: "tag dark" }, `renders ${run.budget.rendersUsed}/${run.budget.maxTotalRenders}`), el("span", { class: "tag dark" }, `obs ${run.budget.observationJobsUsed}/${run.budget.maxObservationJobs}`), el("span", { class: "tag dark" }, `senior ${run.budget.seniorReviewBatchesUsed}/${run.budget.maxSeniorReviewBatches}`)),
      el("div", { class: "prod-analysis-list" }, ...run.scenePlan.map((scene, index) => {
        const candidate = scene.candidateId ? snap.candidates[scene.candidateId] : null;
        const output = candidate?.outputs?.find((item) => item.type === "video" || item.type === "image");
        const outputIndex = output ? candidate.outputs.indexOf(output) : -1;
        const preview = output && outputIndex >= 0 ? (output.type === "video"
          ? el("video", { src: candidateUrl(productionId, candidate.id, outputIndex), controls: true, muted: true, preload: "metadata", style: { maxWidth: "320px", maxHeight: "180px", borderRadius: "6px" } })
          : el("img", { src: candidateUrl(productionId, candidate.id, outputIndex), alt: scene.title, style: { maxWidth: "320px", maxHeight: "180px", borderRadius: "6px" } })) : null;
        return el("div", { class: "prod-analysis-finding" },
          el("b", {}, `${index + 1}. ${scene.title} · ${scene.status}`),
          el("p", {}, scene.objective),
          preview,
          el("small", { class: "dim" }, `${scene.selectedApp} · ${scene.profile} · ${scene.targetDurationSeconds}s · ${scene.intendedTransition}`),
          scene.candidateId ? el("small", { class: "dim" }, `Candidate ${scene.candidateId}`) : null,
          scene.observationIds.length ? el("small", { class: "dim" }, `Observations ${scene.observationIds.join(", ")}`) : null,
          scene.acceptedObservation ? el("small", { class: "dim" }, `Accepted observation ${scene.acceptedObservation.observationId} · revision ${scene.acceptedObservation.revision} · ${scene.acceptedObservation.selection}`) : null,
          scene.validation ? el("small", { class: "dim" }, `Validation ${scene.validation.ok ? "passed" : "incomplete"} · ${scene.validation.errors.join(" · ")}`) : null,
          scene.errors.length ? el("small", { class: "dim" }, scene.errors.join(" · ")) : null);
      })),
      run.provisionalFacts.length ? el("div", {}, el("h3", {}, "Provisional timeline"), ...run.provisionalFacts.map((fact) => el("p", { class: "help" }, `${fact.sceneId}: ${fact.text} · ${fact.status} · ${fact.sourceObservationId}`))) : null,
      run.decisions.length ? el("div", {}, el("h3", {}, "Human decisions"), ...run.decisions.map((d) => el("p", { class: "help" }, `${d.sceneId}: ${d.decision} · ${d.actor} · ${dateLabel(d.at)}`))) : null,
      el("div", { class: "row" }, ...(observationSelect ? [el("label", { class: "ag-field" }, el("span", {}, "Accepted observation revision"), observationSelect)] : []), control("start", "Start", run.status !== "prepared"), control("pause", "Pause", !["running", "prepared"].includes(run.status)), control("resume", "Resume", !["paused"].includes(run.status)), control("cancel", "Cancel", ["completed", "canceled"].includes(run.status)),
        run.status === "awaiting_human" ? decide("approved") : null, run.status === "awaiting_human" ? decide("rejected") : null));
  }

  function openRunPlanner(snap, onDone) {
    const dialog = modal("Plan a production run", "Editable scene plan from a natural-language brief. No scene generation or inference starts here.");
    const title = field("Run title", "New production run");
    const brief = field("Creative brief", "", "textarea");
    const count = field("Scenes", "2", "number");
    const profile = el("select", { "aria-label": "Run profile" }, el("option", { value: "build" }, "Build — 0.1 MP, no upscale, Fast Review"), el("option", { value: "production" }, "Production — 0.3 MP, RelayVSR x2, Detailed Review"));
    const planButton = el("button", { class: "btn lime", type: "button" }, icon("spark"), "Prepare run");
    planButton.onclick = async () => {
      try {
        const result = await api(`/api/productions/${encodeURIComponent(productionId)}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: title.input.value.trim() || "Production run", brief: brief.input.value.trim(), sceneCount: Number(count.input.value) || 2, profile: profile.value }) });
        dialog.close(); toast(`Prepared run ${result.run.id}`); onDone?.();
      } catch (error) { toast(error.message, { error: true }); }
    };
    dialog.append(el("div", { class: "ag-dialog-form" }, title.node, brief.node, count.node, el("label", { class: "ag-field" }, el("span", {}, "Profile"), profile), el("p", { class: "help" }, "The existing Director prompt enhancer writes detailed model prompts. Canonical approval remains a separate human CLI boundary.")),
      el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), planButton));
    dialog.showModal();
  }

  function assetsPanel(snap) {
    const all = Object.values(snap.assets)
      .filter((asset) => !state.assetQuery || `${asset.label} ${(asset.tags || []).join(" ")} ${asset.sourceRunId || ""} ${asset.category || ""}`.toLowerCase().includes(state.assetQuery.toLowerCase()))
      .sort((a, b) => (ASSET_FOLDER_LABEL[a.category || "references"] || a.category).localeCompare(ASSET_FOLDER_LABEL[b.category || "references"] || b.category) || a.label.localeCompare(b.label));
    const search = el("input", { class: "prod-search", type: "search", placeholder: "Search assets, tags, folders or run IDs", value: state.assetQuery });
    search.oninput = () => { state.assetQuery = search.value; paint(); };
    const filters = el("div", { class: "pills" }, ...[["all", "All"], ...ASSET_FOLDERS].map(([value, label]) =>
      el("button", { type: "button", "aria-pressed": String(state.assetFilter === value), onclick: () => { state.assetFilter = value; paint(); } }, label)));
    const folders = (state.assetFilter === "all" ? ASSET_FOLDERS : ASSET_FOLDERS.filter(([id]) => id === state.assetFilter))
      .map(([id, label]) => {
        const list = all.filter((asset) => (asset.category || "references") === id);
        if (!list.length) return null;
        return el("section", { class: "prod-asset-folder" },
          el("div", { class: "prod-section-head" }, el("h3", {}, label), el("span", { class: "tag dark" }, `${list.length}`)),
          el("div", { class: "prod-assets large" }, ...list.map(assetCard)));
      }).filter(Boolean);
    if (!folders.length) folders.push(el("div", { class: "prod-empty" }, icon("image"), el("h3", {}, "No assets in this folder"), el("p", {}, "Add an existing History output, or generate a new image with MiniMax H3 Image.")));
    const corrections = el("div", { class: "prod-asset-corrections" });
    void assetCorrectionBatchPanel(productionId, corrections);
    return el("div", { class: "prod-assets-layout" },
      el("div", { class: "prod-toolbar" }, el("div", {}, el("h2", {}, "Production assets"), el("p", {}, "Classified reference stills, plates, characters and generated media. Assets are indexed in place; removing one never deletes the original file.")),
        el("div", { class: "row" },
          el("button", { class: "btn small ghost", type: "button", onclick: () => openAssetFromHistory(productionId, snap, reload) }, icon("plus"), "Add from History"),
          el("button", { class: "btn small ghost", type: "button", onclick: () => openCharacterSheet(productionId, snap) }, icon("user"), "New character sheet"),
          el("button", { class: "btn small lime", type: "button", onclick: () => openAssetBuilder(productionId) }, icon("spark"), "New asset"))),
      el("div", { class: "prod-assets-toolbar" }, el("label", { class: "search" }, icon("search"), search), filters, el("span", { class: "tag dark" }, `${all.length} assets`)),
      ...folders,
      corrections);
  }

  async function assetCorrectionBatchPanel(productionId, host) {
    try {
      const [audit, history] = await Promise.all([api("/api/asset-audit"), api("/api/asset-corrections/decisions")]);
      const batch = audit.correctionBatch;
      if (!batch?.entries?.length) return;
      const last = [...(history.decisions || [])].reverse().find((item) => item.batchId === batch.id);
      const status = el("span", { class: "tag dark" }, last ? `human ${last.decision} · ${last.createdAt}` : "prepared · not applied");
      const rows = batch.entries.map((entry) => {
        const approved = (history.decisions || []).some((item) => item.assetId === entry.assetId && item.decision === "approved");
        const approveEntry = el("button", { class: `btn small ${approved ? "lime" : "ghost"}`, type: "button" }, icon(approved ? "check" : "plus"), approved ? "Individually approved" : "Approve this correction");
        approveEntry.onclick = async () => {
          try {
            await api("/api/asset-corrections/decisions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId: batch.id, assetId: entry.assetId, decision: "approved", note: "Production Studio per-asset review" }) });
            toast("Individual correction approved. Application is separate."); await assetCorrectionBatchPanel(productionId, host);
          } catch (error) { toast(error.message, { error: true }); }
        };
        return el("article", { class: "prod-analysis-finding" },
          el("div", { class: "row" },
            el("img", { src: assetUrl(productionId, entry.assetId, entry.currentHash), alt: entry.currentLabel, style: { width: "120px", height: "72px", objectFit: "cover", borderRadius: "6px" } }),
            el("div", {}, el("b", {}, `${entry.currentLabel} → ${entry.proposedLabel}`),
              el("p", {}, `Category: ${entry.currentCategory} → ${entry.proposedCategory} · Reference: ${entry.referenceSuitability}`),
              el("small", { class: "dim" }, `Aliases: ${entry.proposedAliases.join(", ") || "none"} · tags: ${entry.proposedTags.join(", ")}`),
              el("p", {}, entry.reason), approveEntry)));
      });
      const ambiguous = (batch.ambiguous || []).map((entry) => el("div", { class: "prod-analysis-finding" },
        el("b", {}, `${entry.currentLabel} → ${entry.proposedLabel}`), el("p", {}, entry.reason), el("small", { class: "dim" }, "Kept under review; never selected as a trusted reference.")));
      const approve = el("button", { class: "btn small lime", type: "button" }, icon("check"), "Approve batch review");
      const reject = el("button", { class: "btn small ghost danger", type: "button" }, icon("x"), "Reject batch");
      const approvedIds = (history.decisions || []).filter((item) => item.decision === "approved" && item.assetId).map((item) => item.assetId);
      const apply = el("button", { class: "btn small ghost", type: "button", disabled: !approvedIds.length }, icon("sliders"), `Apply ${approvedIds.length} individually approved`);
      const decide = async (decision) => {
        try {
          await api("/api/asset-corrections/decisions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId: batch.id, decision, note: "Production Studio human review" }) });
          toast(`Correction batch ${decision}. Metadata is not applied automatically.`);
          await assetCorrectionBatchPanel(productionId, host);
        } catch (error) { toast(error.message, { error: true }); }
      };
      approve.onclick = () => void decide("approved");
      reject.onclick = () => void decide("rejected");
      apply.onclick = async () => {
        try {
          await api("/api/asset-corrections/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId: batch.id, assetIds: approvedIds, confirm: true, note: "Production Studio explicit application" }) });
          toast("Approved corrections applied; historical events and media hashes preserved."); await assetCorrectionBatchPanel(productionId, host);
        } catch (error) { toast(error.message, { error: true }); }
      };
      const summary = last ? "human decision recorded" : "prepared · not applied";
      host.replaceChildren(el("details", { class: "prod-section prod-corrections" },
        el("summary", {}, `Catalogue correction batch · ${batch.entries.length} proposed corrections · ${summary}`),
        el("p", { class: "help" }, "Prepared from actual images. Approval records the decision only; original media and historical observations are never rewritten, and the batch is not applied automatically."),
        ...rows, ambiguous.length ? el("h3", {}, "Ambiguous hallway asset") : null, ...ambiguous,
        el("div", { class: "row" }, approve, reject, apply)));
    } catch (error) { /* assets remain usable; batch review is optional */ }
  }

  function assetCard(asset) {
    const media = asset.kind === "image" ? el("img", { src: assetUrl(productionId, asset.id, asset.hash), alt: asset.label, loading: "lazy" })
      : asset.kind === "video" ? el("video", { src: assetUrl(productionId, asset.id, asset.hash), muted: true, preload: "metadata" })
        : el("div", { class: "prod-asset-icon" }, icon(asset.kind === "audio" ? "audio" : "file"));
    const visibleTags = (asset.tags || []).filter((tag) => !tag.startsWith("Assets/") && !tag.startsWith("official-category:"));
    const card = el("article", { class: "prod-asset-card" },
      el("button", { class: "prod-asset-open", type: "button", title: `Open ${asset.label}`, "aria-label": `Open ${asset.label}` }, media),
      el("div", { class: "prod-asset-copy" }, el("b", { title: asset.label }, asset.label),
        el("small", { title: asset.sourceRunId || "" }, `${ASSET_FOLDER_LABEL[asset.category || "references"] || asset.category}${asset.sourceRunId ? ` · ${asset.sourceRunId}` : ""}`),
        visibleTags.length ? el("span", { class: "prod-asset-tags" }, ...visibleTags.slice(0, 5).map((tag) => el("span", { class: "tag dark", title: tag }, tag)),
          visibleTags.length > 5 ? el("span", { class: "tag dark", title: visibleTags.slice(5).join(", ") }, `+${visibleTags.length - 5}`) : null) : null),
      el("div", { class: "prod-asset-actions" },
        el("button", { class: "btn small ghost", type: "button", onclick: () => openAssetViewer(productionId, asset, reload) }, icon("eye"), "View"),
        el("button", { class: "btn small ghost", type: "button", onclick: () => openAssetEdit(productionId, asset, reload) }, icon("sliders"), "Edit"),
        asset.kind === "image" ? el("button", { class: "btn small ghost", type: "button", onclick: () => void editAssetInApp("h3-image-edit", asset) }, icon("wand"), "p-H3 Edit") : null,
        el("button", { class: "btn small ghost danger", type: "button", onclick: () => deleteAsset(productionId, asset, reload) }, icon("trash"), "Remove")));
    card.addEventListener("click", (event) => { if (event.target.closest?.(".prod-asset-actions")) return; openAssetViewer(productionId, asset, reload); });
    return card;
  }

  function historyPanel(snap) {
    const events = state.history || [];
    return el("div", { class: "prod-history-layout" },
      el("section", { class: "prod-history" }, el("div", { class: "prod-toolbar" }, el("div", {}, el("h2", {}, "Canon history"), el("p", {}, "Append-only event journal. Rollback is a new restoration event, never a deletion.")),
        el("div", { class: "row" }, el("span", { class: "tag dark" }, `revision ${snap.revision}`), el("button", { class: "btn small ghost", type: "button", onclick: async () => { await loadHistory(); paint(); } }, icon("redo"), "Refresh"))),
        events.length ? events.slice().reverse().map((event) => el("div", { class: "prod-event" },
          el("div", { class: "prod-event-head" }, el("b", {}, event.type), el("small", {}, `#${event.seq} · ${dateLabel(event.at)} · ${event.actor?.kind || "system"}`)),
          event.type === "canon.approved" ? el("p", {}, `Approved ${event.payload?.proposal?.title || event.payload?.proposalId || "proposal"} — ${event.payload?.approval?.approvedBy || "human"}`) : null,
          event.type === "canon.rolled_back" ? el("p", {}, `Restored canonical revision ${event.payload?.targetRevision}`) : null,
          event.type === "canon.proposed" ? el("p", {}, event.payload?.proposal?.title || "Proposed changes") : null,
          event.type === "candidate.registered" ? el("p", {}, `Immutable candidate ${event.payload?.candidate?.label || event.payload?.candidate?.id}`) : null,
          event.type === "scene.created" || event.type === "episode.created" || event.type === "season.created" ? el("p", {}, event.payload?.scene?.title || event.payload?.episode?.title || event.payload?.season?.title || "Structure created") : null)) : el("div", { class: "prod-empty" }, "No events yet.")),
      el("aside", { class: "prod-history-side" },
        el("div", { class: "prod-section-head" }, el("h3", {}, "Pending proposals"), el("span", { class: "tag dark" }, String(Object.values(snap.proposals).filter((proposal) => proposal.status === "proposed").length))),
        ...Object.values(snap.proposals).filter((proposal) => proposal.status === "proposed").map(proposalRow),
        el("div", { class: "prod-section" }, el("h3", {}, "Rollback"), el("p", { class: "help" }, "Prepare a rollback request in your terminal. The interface never mutates the journal."), el("pre", { class: "prod-command" }, `npm run production -- rollback ${productionId} <targetRevision>`))));
  }

  node.append(body);
  void draw();
  return { node, active: "productions", title: "Production · RiverField", dispose: () => {} };
}

function openSeason(productionId, snapshot, onDone) {
  const dialog = modal("New season", "Seasons organise the production chronology.");
  const number = field("Number", String((snapshot.seasons.at(-1)?.number || 0) + 1), "number");
  const title = field("Title", "Season");
  const add = el("button", { class: "btn lime", type: "button" }, icon("plus"), "Create season");
  add.onclick = async () => {
    try {
      await api(`/api/productions/${encodeURIComponent(productionId)}/seasons`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ number: Number(number.input.value), title: title.input.value.trim() }) });
      dialog.close(); onDone?.();
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(el("div", { class: "ag-dialog-form" }, number.node, title.node), el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), add));
  dialog.showModal();
}

function openEpisode(productionId, snapshot, season, onDone) {
  if (!season) return toast("Create a season first.", { error: true });
  const dialog = modal("New episode", "An episode is a draft narrative unit until its scenes are reviewed.");
  const number = field("Number", String((snapshot.episodes.filter((episode) => episode.seasonId === season.id).at(-1)?.number || 0) + 1), "number");
  const title = field("Title", "Episode");
  const add = el("button", { class: "btn lime", type: "button" }, icon("plus"), "Create episode");
  add.onclick = async () => {
    try {
      await api(`/api/productions/${encodeURIComponent(productionId)}/episodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seasonId: season.id, number: Number(number.input.value), title: title.input.value.trim() }) });
      dialog.close(); onDone?.();
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(el("div", { class: "ag-dialog-form" }, number.node, title.node), el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), add));
  dialog.showModal();
}

function openScene(productionId, snapshot, episode, onDone) {
  if (!episode) return toast("Create an episode first.", { error: true });
  const dialog = modal("New scene", "Scenes are narrative units; candidates and canonical decisions stay separate.");
  const number = field("Number", String((snapshot.scenes.filter((scene) => scene.episodeId === episode.id).at(-1)?.number || 0) + 1), "number");
  const title = field("Title", "Scene");
  const summary = field("Brief / description", "", "textarea");
  const add = el("button", { class: "btn lime", type: "button" }, icon("plus"), "Create scene");
  add.onclick = async () => {
    try {
      await api(`/api/productions/${encodeURIComponent(productionId)}/scenes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ episodeId: episode.id, number: Number(number.input.value), title: title.input.value.trim(), summary: summary.input.value.trim() }) });
      dialog.close(); onDone?.();
    } catch (error) { toast(error.message, { error: true }); }
  };
  dialog.append(el("div", { class: "ag-dialog-form" }, number.node, title.node, summary.node), el("div", { class: "ag-dialog-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => dialog.close() }, "Cancel"), add));
  dialog.showModal();
}
