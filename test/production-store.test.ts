import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionError, ProductionStore } from "../server/production-store.ts";
import { buildProductionContext } from "../server/production-context.ts";
import { importSuite404 } from "../server/suite404-import.ts";
import { approvalChallenge, rollbackFingerprint, type CanonProposal, type HumanApproval } from "../server/production-types.ts";

const actor = { kind: "agent" as const, id: "test-agent" };
const human = (fingerprint: string, revision: number): HumanApproval => ({
  method: "interactive-cli", human: true, tty: true, approvedBy: "test-human",
  approvedAt: new Date().toISOString(), fingerprint, challenge: approvalChallenge(fingerprint), expectedRevision: revision,
});
const scene = (store: ProductionStore, productionId: string, id: string, episodeId: string, number: number) =>
  store.createScene(productionId, { id, episodeId, number, title: `Scene ${number}` }, actor, `scene:${id}`);

function fixture() {
  const out = mkdtempSync(join(tmpdir(), "riverfield-production-"));
  const store = new ProductionStore(out);
  store.createProduction({ id: "suite-404", title: "SUITE 404", logline: "test" }, actor, "production");
  store.createSeason("suite-404", { id: "suite-404-s01", number: 1, title: "Season 01" }, actor, "season");
  store.createEpisode("suite-404", { id: "suite-404-s01e01", seasonId: "suite-404-s01", number: 1, title: "Passion Max" }, actor, "episode");
  scene(store, "suite-404", "suite-404-s01e01-sc01", "suite-404-s01e01", 1);
  scene(store, "suite-404", "suite-404-s01e01-sc02", "suite-404-s01e01", 2);
  return { out, store };
}

test("ProductionStore persists hierarchy and immutable multi-scene candidates", () => {
  const { out, store } = fixture();
  try {
    const candidate = store.registerCandidate("suite-404", {
      id: "candidate-a", label: "V7", source: "import", sourceRunId: "run-a", app: "h3-studio-director-flash",
      prompt: "the intended scene", outputs: [{ type: "video", file: "out.mp4", name: "out.mp4", path: "/tmp/out.mp4" }],
      bindings: [
        { id: "candidate-a-b1", sceneId: "suite-404-s01e01-sc01", segmentIndex: 0, timelineStartFrame: 0, timelineEndFrame: 294 },
        { id: "candidate-a-b2", sceneId: "suite-404-s01e01-sc01", segmentIndex: 1, timelineStartFrame: 200, timelineEndFrame: 494 },
        { id: "candidate-a-b3", sceneId: "suite-404-s01e01-sc02", segmentIndex: 2, timelineStartFrame: 294, timelineEndFrame: 588 },
      ],
    }, actor, "candidate-a");
    assert.equal(candidate.candidates["candidate-a"]?.bindings.length, 3);
    assert.equal(candidate.candidates["candidate-a"]?.prompt, "the intended scene");
    assert.equal("status" in (candidate.candidates["candidate-a"] as object), false, "candidates have no global canonical status");
    assert.equal(store.snapshot("suite-404").candidates["candidate-a"]?.bindings[1]?.sceneId, "suite-404-s01e01-sc01");
    assert.equal(store.snapshot("suite-404").candidates["candidate-a"]?.bindings[2]?.sceneId, "suite-404-s01e01-sc02");

    const proposal = store.propose("suite-404", {
      sceneDecision: { sceneId: "suite-404-s01e01-sc01", candidateId: "candidate-a", decision: "canon" },
      changes: [{ op: "add", category: "identity", factId: "akari-identity", text: "Akari is the hotel guest.", subjectIds: ["akari"] }],
    }, actor, "proposal-a").proposal;
    assert.equal(proposal.status, "proposed");
    const approved = store.approveProposal("suite-404", proposal.id, human(proposal.fingerprint, 0), "approve-a");
    assert.equal(approved.revision, 1);
    assert.equal(approved.sceneDecisions["suite-404-s01e01-sc01"]?.canonicalCandidateId, "candidate-a");
    assert.equal(approved.sceneDecisions["suite-404-s01e01-sc01"]?.canonicalBindingIds.length, 2, "a scene may use several segments");
    assert.equal(approved.sceneDecisions["suite-404-s01e01-sc02"]?.status, "draft", "the other scene keeps its own decision");
    const observed = store.recordObservation("suite-404", { sceneId: "suite-404-s01e01-sc01", candidateId: "candidate-a", text: "Observed: the model added a reflection." }, actor, "obs-a");
    assert.equal(observed.observations ? Object.values(observed.observations)[0]?.text : "", "Observed: the model added a reflection.");
    const context = buildProductionContext(store.snapshot("suite-404"), { sceneId: "suite-404-s01e01-sc01" });
    assert.doesNotMatch(context.text, /model added a reflection/, "observations are not canonical facts");
    assert.equal(approved.bible.identity[0]?.approvedBy, "test-human");
    assert.equal(approved.bible.identity[0]?.revision, 1);
    const events = store.events("suite-404").length;
    store.createScene("suite-404", { id: "suite-404-s01e01-sc01", episodeId: "suite-404-s01e01", number: 1, title: "ignored" }, actor, "scene:suite-404-s01e01-sc01");
    assert.equal(store.events("suite-404").length, events, "a duplicate command key does not append");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("revision checks, rollback and snapshot rebuild preserve the journal", () => {
  const { out, store } = fixture();
  try {
    const first = store.propose("suite-404", { changes: [{ op: "add", category: "episodic", factId: "event-1", text: "The first event." }] }, actor, "p1").proposal;
    store.approveProposal("suite-404", first.id, human(first.fingerprint, 0), "a1");
    const second = store.propose("suite-404", { changes: [{ op: "add", category: "narrative", factId: "thread-1", text: "The open thread." }] }, actor, "p2").proposal;
    store.approveProposal("suite-404", second.id, human(second.fingerprint, 1), "a2");
    const before = store.events("suite-404").length;
    const fingerprint = rollbackFingerprint("suite-404", 1, 2);
    const restored = store.rollback("suite-404", 1, human(fingerprint, 2), "rollback-1");
    assert.equal(restored.revision, 3);
    assert.equal(restored.bible.episodic.length, 1);
    assert.equal(restored.bible.narrative.length, 0, "facts after the target revision are not canonical");
    assert.equal(store.events("suite-404").length, before + 1, "rollback appends, never truncates");
    rmSync(join(out, "productions", "suite-404", "snapshot.json"));
    const rebuilt = store.snapshot("suite-404");
    assert.equal(rebuilt.revision, 3);
    assert.equal(rebuilt.bible.episodic[0]?.id, "event-1");
    assert.equal(rebuilt.bible.narrative.length, 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("stale and forged proposals are rejected at the human boundary", () => {
  const { out, store } = fixture();
  try {
    const stale = store.propose("suite-404", { expectedRevision: 0, changes: [{ op: "add", category: "state", text: "stale" }] }, actor, "stale").proposal;
    const first = store.propose("suite-404", { expectedRevision: 0, changes: [{ op: "add", category: "state", text: "fresh" }] }, actor, "fresh").proposal;
    store.approveProposal("suite-404", first.id, human(first.fingerprint, 0), "fresh-approval");
    assert.throws(() => store.approveProposal("suite-404", stale.id, human(stale.fingerprint, 0)), (error: unknown) =>
      error instanceof ProductionError && error.code === "STALE_PROPOSAL");
    const next = store.propose("suite-404", { expectedRevision: 1, changes: [{ op: "add", category: "state", text: "next" }] }, actor, "next").proposal;
    assert.throws(() => store.approveProposal("suite-404", next.id, {
      ...human(next.fingerprint, 1), challenge: "APPROVE wrong",
    }), (error: unknown) => error instanceof ProductionError && error.code === "HUMAN_APPROVAL_REQUIRED");
    assert.throws(() => store.approveProposal("suite-404", next.id, human(next.fingerprint, 0)), (error: unknown) =>
      error instanceof ProductionError && error.code === "HUMAN_APPROVAL_REQUIRED");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("ProductionContext is typed, bounded and canonical-only", () => {
  const { out, store } = fixture();
  try {
    const proposal = store.propose("suite-404", {
      expectedRevision: 0,
      changes: [
        { op: "add", category: "identity", factId: "identity-1", text: "Akari, hotel guest, violet-black hair.", subjectIds: ["akari"] },
        { op: "add", category: "state", factId: "state-1", text: "Daichi has a wet shirt.", subjectIds: ["daichi"] },
        { op: "add", category: "episodic", factId: "episodic-1", text: "Momo falsified Daichi's evaluation." },
        { op: "add", category: "narrative", factId: "narrative-1", text: "Daichi and Momo's rivalry is becoming a running gag.", tags: ["open"] },
      ],
    }, actor, "facts").proposal;
    store.approveProposal("suite-404", proposal.id, human(proposal.fingerprint, 0), "facts-approved");
    const context = buildProductionContext(store.snapshot("suite-404"), { sceneId: "suite-404-s01e01-sc01", maxChars: 500 });
    assert.equal(context.revision, 1);
    assert.equal(context.sections.identity.facts.length, 1);
    assert.equal(context.sections.narrative.facts.length, 1);
    assert.match(context.text, /Canonical|PRODUCTION BIBLE/);
    assert.ok(context.text.length <= 500 + 200, "headers can exceed the fact budget but the fact selection is bounded");
    assert.equal(context.sections.identity.facts[0]?.approvedBy, "test-human");
    const narrow = buildProductionContext(store.snapshot("suite-404"), { maxChars: 500, characterIds: ["daichi"] });
    assert.ok(narrow.sections.state.facts.length <= 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("SUITE 404 importer is idempotent, non-destructive and never canonizes", () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-suite404-"));
  try {
    const history = join(out, "history");
    const writeRun = (id: string, prefix: string, windows: number, prompt = "shot") => {
      const dir = join(history, id);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "out-01.mp4");
      writeFileSync(file, Buffer.from(`video-${id}`));
      const segment_windows = JSON.stringify({ windows: Array.from({ length: windows }, (_, index) => ({
        start: index * 294, end: (index + 1) * 294, prompt, images: [], audios: [],
      })), videos: [], audios: [] });
      writeFileSync(join(dir, "meta.json"), JSON.stringify({
        id, app: "h3-studio-director-flash", status: "succeeded",
        values: { filename_prefix: prefix, segment_windows, seed: 404 },
        outputs: [{ file: "out-01.mp4", type: "video", name: `${id}.mp4`, node: "29" }],
      }));
      return file;
    };
    const v6 = writeRun("run-v6-seg01", "riverfield/suite404/S01E01/V6_SEG01_Preview_01", 1, "V6 segment one");
    const v7 = writeRun("run-v7-native", "riverfield/suite404/S01E01/V7_Native_Build_01", 15, "V7 segment");
    const velvet = writeRun("run-velvet", "riverfield/LOCKERS", 1, "Velvet Moon bar");
    const assetDir = join(history, "run-asset");
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(join(assetDir, "out-01.png"), Buffer.from("image"));
    writeFileSync(join(assetDir, "meta.json"), JSON.stringify({
      id: "run-asset", app: "h3-image", status: "succeeded",
      values: { filename_prefix: "riverfield/Suite404_Assets" },
      outputs: [{ file: "out-01.png", type: "image", name: "asset.png", node: "9" }],
    }));
    const before = createHash("sha256").update(readFileSync(v6)).digest("hex");
    const first = importSuite404(out);
    const second = importSuite404(out);
    assert.equal(first.candidates, 3);
    assert.equal(second.candidates, 3, "a second import does not duplicate candidates");
    assert.equal(first.canonicalDecisionsCreated, 0);
    const snapshot = new ProductionStore(out).snapshot("suite-404");
    assert.equal(snapshot.scenes.length, 16);
    assert.equal(snapshot.episodes[0]?.title, "Passion Max");
    assert.equal(snapshot.episodes[1]?.status, "draft");
    assert.equal(snapshot.candidates["suite404-run-v7-native"]?.bindings.length, 15);
    assert.equal(Object.values(snapshot.sceneDecisions).every((decision) => decision.status === "draft"), true);
    assert.equal(snapshot.revision, 0, "import creates no canonical approval");
    assert.equal(Object.keys(snapshot.assets).length, 1);
    assert.equal(createHash("sha256").update(readFileSync(v6)).digest("hex"), before, "original media is untouched");
    assert.ok(snapshot.assets["suite404-asset-run-asset-1"]?.path.endsWith("out-01.png"));
    assert.equal(velvet.endsWith("out-01.mp4"), true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
