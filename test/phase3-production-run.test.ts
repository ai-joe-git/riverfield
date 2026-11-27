import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionStore } from "../server/production-store.ts";
import { ProductionRunEngine, type RunAdapters } from "../server/production-run.ts";
import { planProductionRun } from "../server/production-run-plan.ts";
import { readFileSync } from "node:fs";
import type { ProductionRun, ProductionRunScene } from "../server/production-types.ts";

const actor = { kind: "agent" as const, id: "test" };
function scene(sceneId: string, order: number, overrides: Partial<ProductionRunScene> = {}): ProductionRunScene {
  return {
    sceneId, title: `Scene ${order}`, objective: "brief", intendedEvents: ["event"], dialogueRequirements: [],
    characterIds: [], locationIds: [], propIds: [], targetDurationSeconds: 8, intendedTransition: "cut",
    selectedApp: "h3-studio-director-flash", profile: "build", referenceAssetIds: [], renderConfig: { render_profile: "build", prompt_enhancer: true },
    observationIds: [], continuityReviewIds: [], status: "planned", jobIds: [], attempts: 0, errors: [], ...overrides,
  };
}
function fixture() {
  const out = mkdtempSync(join(tmpdir(), "riverfield-run-"));
  const store = new ProductionStore(out);
  store.createProduction({ id: "run-test", title: "Run Test" }, actor, "p");
  store.createSeason("run-test", { id: "run-test-s01", number: 1, title: "S01" }, actor, "s");
  store.createEpisode("run-test", { id: "run-test-s01e01", seasonId: "run-test-s01", number: 1, title: "E01" }, actor, "e");
  store.createScene("run-test", { id: "run-test-s01e01-sc01", episodeId: "run-test-s01e01", number: 1, title: "Scene 1" }, actor, "sc1");
  store.createScene("run-test", { id: "run-test-s01e01-sc02", episodeId: "run-test-s01e01", number: 2, title: "Scene 2" }, actor, "sc2");
  return { out, store };
}
function makeRun(store: ProductionStore, overrides: Partial<ProductionRun> = {}) {
  const input = store.createProductionRun("run-test", {
    id: "run-test-run", title: "Run", brief: "A tiny romantic comedy", profile: "build", episodeId: "run-test-s01e01",
    scenePlan: [scene("run-test-s01e01-sc01", 1), scene("run-test-s01e01-sc02", 2)],
    budget: { maxRendersPerScene: 1, maxTotalRenders: 2, maxPromptEnhancements: 2, maxObservationJobs: 2, maxComparisonCalls: 2, maxSeniorReviewBatches: 0, wallClockMinutes: 10 },
  }, actor, "create-run");
  if (Object.keys(overrides).length) {
    const run = input.productionRuns["run-test-run"];
    store.updateProductionRun("run-test", run.id, overrides, actor, "override-run");
  }
  return store.snapshot("run-test").productionRuns["run-test-run"];
}
function mockReport(sceneId = "run-test-s01e01-sc01") {
  return {
    schemaVersion: 1, reportVersion: 1, productionId: "run-test", episodeId: "run-test-s01e01", sceneId, candidateId: "candidate-1",
    sourceOutputHash: "source", bindingIds: ["existing-binding"], timebase: "final-output",
    technical: { sourcePath: "", sourceHash: "source", sourceVerified: true, fps: 24, frameCount: 100, duration: 4, audioStreams: [], sceneStartFrame: 0, sceneEndFrame: 100, sceneStartSeconds: 0, sceneEndSeconds: 4 },
    shots: [{ id: "shot", bindingId: "existing-binding", segmentIndex: 0, startFrame: 0, endFrame: 100, startSeconds: 0, endSeconds: 4, detector: "ffmpeg-scene", evidenceIds: [] }],
    evidence: [
      { id: "frame-open", kind: "opening_frame", file: "open.jpg", path: "/tmp/open.jpg", hash: "open", frame: 1, timestampSeconds: 0.04, shotId: "shot" },
      { id: "frame-close", kind: "closing_frame", file: "close.jpg", path: "/tmp/close.jpg", hash: "close", frame: 99, timestampSeconds: 3.95, shotId: "shot" },
      { id: "audio-01", kind: "audio", file: "audio.wav", path: "/tmp/audio.wav", hash: "audio" },
    ],
    visual: { characters: [], props: [], actions: [], expressions: [], composition: [], stylisticEffects: [], artifacts: [], uncertainties: [], claims: [], openingState: { description: "observed opening", evidenceIds: ["frame-open"] }, closingState: { description: "observed closing", evidenceIds: ["frame-close"] } },
    dialogue: { provider: "whisper-turbo", text: "observed line", utterances: [{ text: "observed line", startSeconds: 0, endSeconds: 1, unclear: false, evidenceIds: ["audio-01"] }], limitations: [], evidenceIds: ["audio-01"] },
    comparison: { findings: [], proposedChanges: [], limitations: [], comparedAt: "", comparisonPromptVersion: "test" }, observedEvents: [], confidence: "probable", uncertainties: [], limitations: [], stages: [],
  } as any;
}

function adapters(options: { failWaitOnce?: boolean; reviewCoverage?: boolean } = {}): RunAdapters & { counts: any } {
  const counts = { startRender: 0, reconcileRender: 0, startObservation: 0, reconcileObservation: 0, startReview: 0, validate: 0 };
  let failed = false;
  return {
    counts,
    async startRender() {
      counts.startRender += 1;
      return {
        jobId: "render-job-1",
        async wait() {
          if (options.failWaitOnce && !failed) { failed = true; throw new Error("mock render interruption"); }
          return { candidateId: "candidate-1" };
        },
      };
    },
    async reconcileRender() { counts.reconcileRender += 1; return { candidateId: "candidate-1" }; },
    async startObservation() { counts.startObservation += 1; return { jobId: "observation-job-1", async wait() { return { observationId: "observation-1", report: mockReport(), evidenceReferences: ["observation-1:frame-close"] }; } }; },
    async reconcileObservation() { counts.reconcileObservation += 1; return { observationId: "observation-1", report: mockReport(), evidenceReferences: ["observation-1:frame-close"] }; },
    async validate() { counts.validate += 1; return { ok: true }; },
    async startReview() { counts.startReview += 1; return { jobId: "review-job-1", async wait() { return { reviewId: "review-1", coverageComplete: options.reviewCoverage ?? true }; } }; },
  };
}

test("the state machine stops at human approval and keeps provisional state non-canonical", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    const engine = new ProductionRunEngine(store, adapters());
    const run = await engine.start("run-test", "run-test-run");
    assert.equal(run.status, "awaiting_human");
    assert.equal(run.currentSceneIndex, 0);
    assert.equal(run.scenePlan[0].candidateId, "candidate-1");
    assert.equal(run.scenePlan[0].observationIds[0], "observation-1");
    assert.equal(run.provisionalFacts[0].status, "provisional");
    assert.equal(run.provisionalFacts[0].text, "observed closing");
    assert.equal(run.provisionalFacts[0].intent[0], "event");
    assert.equal(run.scenePlan[0].status, "awaiting_human");
    assert.equal((run as any).budget.comparisonCallsUsed, 1);
    assert.equal(store.snapshot("run-test").bible.identity.length, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("a restart reconciles a persisted job and never submits a duplicate render", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    const first = new ProductionRunEngine(store, adapters({ failWaitOnce: true }));
    const failed = await first.start("run-test", "run-test-run");
    assert.equal(failed.status, "paused");
    assert.ok(failed.jobs.some((job) => job.kind === "render" && job.status === "submitted"));
    const secondAdapters = adapters();
    const second = new ProductionRunEngine(store, secondAdapters);
    const resumed = await second.resume("run-test", "run-test-run");
    assert.equal(secondAdapters.counts.startRender, 0);
    assert.equal(secondAdapters.counts.reconcileRender, 1);
    assert.equal(resumed.scenePlan[0].candidateId, "candidate-1");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("budget exhaustion stops before submitting a render", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    store.updateProductionRun("run-test", "run-test-run", { budget: { ...store.snapshot("run-test").productionRuns["run-test-run"].budget, maxTotalRenders: 0 } }, actor, "no-render-budget");
    const a = adapters();
    const engine = new ProductionRunEngine(store, a);
    const run = await engine.start("run-test", "run-test-run");
    assert.equal(run.status, "paused");
    assert.equal(a.counts.startRender, 0);
    assert.match(run.errors.join(" "), /render budget/i);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("rejection invalidates downstream provisional assumptions without deleting anything", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    const engine = new ProductionRunEngine(store, adapters());
    await engine.start("run-test", "run-test-run");
    const rejected = await engine.decide("run-test", "run-test-run", "run-test-s01e01-sc01", "rejected", "not approved");
    assert.equal(rejected.status, "paused");
    assert.equal(rejected.scenePlan[1].status, "stale");
    assert.equal(rejected.provisionalFacts.some((fact) => fact.status === "invalidated"), true);
    assert.equal(store.snapshot("run-test").revision, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("approval advances to the next scene and resumes without regenerating the approved candidate", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    mkdirSync(join(out, "media"), { recursive: true });
    const candidatePath = join(out, "media", "candidate-1.png");
    writeFileSync(candidatePath, Buffer.from("89504e470d0a1a0a", "hex"));
    store.registerCandidate("run-test", { id: "candidate-1", label: "candidate", outputs: [{ type: "image", file: "candidate-1.png", name: "candidate-1.png", path: candidatePath }], bindings: [{ id: "candidate-1-binding", sceneId: "run-test-s01e01-sc01", segmentIndex: 0, timelineStartFrame: 0, timelineEndFrame: 100 }] }, actor, "candidate-1");
    const a = adapters();
    const engine = new ProductionRunEngine(store, a);
    await engine.start("run-test", "run-test-run");
    store.recordObservation("run-test", { id: "observation-1", sceneId: "run-test-s01e01-sc01", candidateId: "candidate-1", text: "observed", report: mockReport() }, actor, "observation-1");
    await engine.decide("run-test", "run-test-run", "run-test-s01e01-sc01", "approved", "approved scene one");
    const resumed = await engine.resume("run-test", "run-test-run");
    assert.equal(resumed.status, "awaiting_human");
    assert.equal(resumed.currentSceneIndex, 1);
    assert.equal(resumed.scenePlan[0].status, "approved");
    assert.equal(a.counts.startRender, 2, "only the second scene is rendered");
    assert.equal(resumed.provisionalFacts[0].status, "approved");
    assert.equal((resumed.scenePlan[1].renderContext as any)?.priorSceneId, "run-test-s01e01-sc01");
    assert.equal((resumed.scenePlan[1].renderContext as any)?.status, "run-provisional-not-canonical");
    assert.equal((resumed.scenePlan[1].renderContext as any)?.closingState != null, true);
    assert.equal(store.snapshot("run-test").revision, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("incomplete senior coverage cannot become an automatic acceptance", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    const current = store.snapshot("run-test").productionRuns["run-test-run"];
    store.updateProductionRun("run-test", "run-test-run", { budget: { ...current.budget, maxSeniorReviewBatches: 1 } }, actor, "senior-budget");
    const a = adapters({ reviewCoverage: false });
    const engine = new ProductionRunEngine(store, a);
    const run = await engine.start("run-test", "run-test-run");
    assert.equal(run.status, "awaiting_human");
    assert.equal(a.counts.startRender, 1);
    assert.equal(a.counts.startReview, 1);
    assert.equal(run.budget.seniorReviewBatchesUsed, 1);
    assert.match(run.scenePlan[0].errors.join(" "), /coverage is incomplete/i);
    assert.equal(run.provisionalFacts.every((fact) => fact.status === "provisional"), true);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("an existing candidate with an observation is adopted without generation or observation", async () => {
  const { out, store } = fixture();
  try {
    mkdirSync(join(out, "media"), { recursive: true });
    const path = join(out, "media", "existing.png");
    writeFileSync(path, Buffer.from("89504e470d0a1a0a", "hex"));
    store.registerCandidate("run-test", { id: "candidate-existing", label: "existing", outputs: [{ type: "image", file: "existing.png", name: "existing.png", path }], bindings: [{ id: "existing-binding", sceneId: "run-test-s01e01-sc01", segmentIndex: 0, timelineStartFrame: 0, timelineEndFrame: 100 }] }, actor, "candidate-existing");
    store.createProductionRun("run-test", { id: "reuse-run", title: "Reuse", brief: "reuse", profile: "build", episodeId: "run-test-s01e01", scenePlan: [
      scene("run-test-s01e01-sc01", 1, { reuseCandidateId: "candidate-existing", observationIds: ["observation-existing"] }),
      scene("run-test-s01e01-sc02", 2),
    ], budget: { maxRendersPerScene: 1, maxTotalRenders: 1, maxPromptEnhancements: 1, maxObservationJobs: 1, maxComparisonCalls: 1, maxSeniorReviewBatches: 0, wallClockMinutes: 10 } }, actor, "reuse-run");
    const a = adapters(); const engine = new ProductionRunEngine(store, a);
    const run = await engine.start("run-test", "reuse-run");
    assert.equal(run.status, "awaiting_human");
    assert.equal(a.counts.startRender, 0);
    assert.equal(a.counts.startObservation, 0);
    assert.equal(run.scenePlan[0].candidateId, "candidate-existing");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("concurrent start requests cannot execute the same run twice", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    let release: ((value: any) => void) | undefined;
    const base = adapters();
    const a = { ...base, async startRender() { base.counts.startRender += 1; return { jobId: "render-gate", wait: () => new Promise<{ candidateId: string }>((resolve) => { release = resolve; }) }; } };
    const engine = new ProductionRunEngine(store, a);
    const first = engine.start("run-test", "run-test-run");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() => engine.start("run-test", "run-test-run"), /RUN_CONCURRENT|already active/);
    release?.({ candidateId: "candidate-1" });
    await first;
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("pause during rendering is not overwritten by the late result", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    let release: ((value: any) => void) | undefined;
    const base = adapters();
    const a = { ...base, async startRender() { base.counts.startRender += 1; return { jobId: "render-slow", wait: () => new Promise<{ candidateId: string }>((resolve) => { release = resolve; }) }; } };
    const engine = new ProductionRunEngine(store, a);
    const running = engine.start("run-test", "run-test-run");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const paused = await engine.pause("run-test", "run-test-run");
    assert.equal(paused.status, "paused");
    release?.({ candidateId: "late-candidate" });
    const final = await running;
    assert.equal(final.status, "paused");
    assert.equal(final.scenePlan[0].candidateId, undefined);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("invalid candidate adoption fails closed instead of rendering", async () => {
  const { out, store } = fixture();
  try {
    store.createProductionRun("run-test", { id: "invalid-adopt", title: "Invalid", brief: "brief", profile: "build", episodeId: "run-test-s01e01", scenePlan: [scene("run-test-s01e01-sc01", 1, { reuseCandidateId: "missing-candidate", observationIds: ["missing-observation"] })], budget: { maxRendersPerScene: 1, maxTotalRenders: 1, maxPromptEnhancements: 1, maxObservationJobs: 1, maxComparisonCalls: 1, maxSeniorReviewBatches: 0, wallClockMinutes: 10 } }, actor, "invalid-adopt");
    const a = adapters(); const engine = new ProductionRunEngine(store, a);
    const run = await engine.start("run-test", "invalid-adopt");
    assert.equal(run.status, "paused");
    assert.equal(a.counts.startRender, 0);
    assert.match(run.errors.join(" "), /does not exist/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("missing comparison budget and missing validation adapter fail closed", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    const current = store.snapshot("run-test").productionRuns["run-test-run"];
    store.updateProductionRun("run-test", "run-test-run", { budget: { ...current.budget, maxComparisonCalls: 0 } }, actor, "no-comparison");
    const a = adapters(); const engine = new ProductionRunEngine(store, a);
    const run = await engine.start("run-test", "run-test-run");
    assert.equal(run.status, "paused");
    assert.equal(a.counts.startObservation, 0);
    assert.match(run.errors.join(" "), /comparison budget/i);
  } finally { rmSync(out, { recursive: true, force: true }); }
  const second = fixture();
  try {
    makeRun(second.store);
    const a = adapters(); const engine = new ProductionRunEngine(second.store, { ...a, validate: undefined });
    const run = await engine.start("run-test", "run-test-run");
    assert.equal(run.status, "paused");
    assert.match(run.errors.join(" "), /validation adapter/i);
  } finally { rmSync(second.out, { recursive: true, force: true }); }
});

test("an incomplete observation report cannot create provisional state", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    const a = adapters();
    a.startObservation = async () => ({ jobId: "observation-no-report", wait: async () => ({ observationId: "observation-empty" }) });
    const engine = new ProductionRunEngine(store, a);
    const run = await engine.start("run-test", "run-test-run");
    assert.equal(run.status, "paused");
    assert.equal(run.provisionalFacts.length, 0);
    assert.match(run.errors.join(" "), /no structured report/i);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("cancellation is durable and stops further execution", async () => {
  const { out, store } = fixture();
  try {
    makeRun(store);
    const engine = new ProductionRunEngine(store, adapters());
    const canceled = await engine.cancel("run-test", "run-test-run");
    assert.equal(canceled.status, "canceled");
    await assert.rejects(() => engine.resume("run-test", "run-test-run"), /not resumable|RUN_NOT_RESUMABLE|canceled/i);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("the editable planner uses trusted assets and leaves detailed prompts to the Director enhancer", () => {
  const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
  const plan = planProductionRun(snapshot, { brief: "Akari and Daichi return to the Velvet Moon Bar for an awkward toast. Later, they continue the conversation in the Suite 404 bedroom.", sceneCount: 2, profile: "build", episodeId: "suite-404-s01e02" });
  assert.equal(plan.scenes.length, 2);
  assert.equal(plan.profile, "build");
  assert.equal(plan.promptStrategy, "director-prompt-enhancer");
  assert.ok(plan.referenceAssets.length > 0);
  for (const assetId of plan.referenceAssets) assert.equal(plan.scenes.flatMap((scene) => scene.referenceAssetIds).includes(assetId), true);
  assert.ok(plan.scenes.every((scene) => !/cinematic|shot\s+\d+|[0-9]+mm/i.test(scene.objective)));
  assert.ok(plan.unresolved.length >= 0);
});

test("the SUITE 404 pilot remains non-canonical and within its first-scene budget", () => {
  const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
  const run = snapshot.productionRuns["phase3-suite404-pilot-001"];
  assert.ok(run);
  assert.ok(["prepared", "awaiting_human"].includes(run.status));
  assert.equal(run.profile, "build");
  assert.equal(run.scenePlan.length, 2);
  assert.deepEqual(run.scenePlan.map((scene: any) => scene.sceneId), ["suite-404-s01e02-sc02", "suite-404-s01e02-sc03"]);
  assert.equal(run.budget.maxRendersPerScene, 1);
  assert.equal(run.budget.maxTotalRenders, 2);
  assert.equal(run.budget.rendersUsed, 2);
  assert.equal(snapshot.revision, 0);
});
