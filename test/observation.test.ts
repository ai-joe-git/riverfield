import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionStore } from "../server/production-store.ts";
import { ObservationManager, type ObservationDeps } from "../server/observation.ts";
import type { ObservationEvidenceBundle } from "../server/observation-evidence.ts";
import type { Runner } from "../server/runner.ts";
import type {
  Actor, ObservationComparison, ObservationDialogue, ObservationEvidence, ObservationVisual,
} from "../server/production-types.ts";

const actor: Actor = { kind: "agent", id: "observer-test" };
const now = "2026-11-26T18:00:00.000Z";

function fixture() {
  const out = mkdtempSync(join(tmpdir(), "riverfield-observation-"));
  const media = join(out, "media");
  mkdirSync(media, { recursive: true });
  const file = join(media, "candidate.mp4");
  writeFileSync(file, Buffer.from("not a real video; the fake evidence extractor never reads it"));
  const store = new ProductionStore(out);
  store.createProduction({ id: "suite-404", title: "SUITE 404" }, actor, "prod");
  store.createSeason("suite-404", { id: "suite-404-s01", number: 1, title: "Season 01" }, actor, "season");
  store.createEpisode("suite-404", { id: "suite-404-s01e02", seasonId: "suite-404-s01", number: 2, title: "Velvet Moon" }, actor, "episode");
  store.createScene("suite-404", { id: "scene-a", episodeId: "suite-404-s01e02", number: 1, title: "Velvet Moon", summary: "Akari and Daichi meet in the bar.", characterIds: ["akari", "daichi"] }, actor, "scene-a");
  store.createScene("suite-404", { id: "scene-b", episodeId: "suite-404-s01e02", number: 2, title: "Other scene" }, actor, "scene-b");
  const candidate = store.registerCandidate("suite-404", {
    id: "candidate-a", label: "Velvet Moon candidate", source: "import", sourceRunId: "run-a", prompt: "intended scene",
    outputs: [{ type: "video", file: "out.mp4", name: "out.mp4", path: file }],
    bindings: [
      { id: "binding-a", sceneId: "scene-a", segmentIndex: 0, timelineStartFrame: 0, timelineEndFrame: 100, fps: 24 },
      { id: "binding-b", sceneId: "scene-b", segmentIndex: 1, timelineStartFrame: 100, timelineEndFrame: 200, fps: 24 },
    ],
  }, actor, "candidate-a");
  return { out, store, candidate: candidate.candidates["candidate-a"]! };
}

function fakeEvidence(input: Parameters<NonNullable<ObservationDeps["evidence"]>>[0]): ObservationEvidenceBundle {
  const dir = join(input.outDir, "observations", "test-evidence");
  mkdirSync(join(dir, "frames"), { recursive: true });
  mkdirSync(join(dir, "audio"), { recursive: true });
  execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=white:s=16x16", "-frames:v", "1", "-q:v", "2", join(dir, "frames", "frame-0001.jpg")]);
  writeFileSync(join(dir, "audio", "audio-01.wav"), "audio");
  const frame: ObservationEvidence = {
    id: "frame-0001", kind: "opening_frame", file: "frames/frame-0001.jpg", path: join(dir, "frames", "frame-0001.jpg"),
    timestampSeconds: 0.1, frame: 2, bindingId: input.bindings[0]!.id, shotId: "shot-01", mime: "image/jpeg", hash: "frame-hash",
  };
  const audio: ObservationEvidence = {
    id: "audio-01", kind: "audio", file: "audio/audio-01.wav", path: join(dir, "audio", "audio-01.wav"),
    timestampSeconds: 0.1, frame: 2, bindingId: input.bindings[0]!.id, mime: "audio/wav", hash: "audio-hash",
  };
  return {
    cacheKey: "cache-test", dir,
    source: { path: input.outputPath, hash: "source-hash", verified: true },
    technical: {
      sourcePath: input.outputPath, sourceHash: "source-hash", sourceVerified: true, width: 1472, height: 832,
      fps: 24, frameCount: 100, duration: 4.16, audioStreams: [{ codec: "aac", sampleRate: 32000, channels: 2 }],
      sceneStartFrame: 0, sceneEndFrame: 100, sceneStartSeconds: 0, sceneEndSeconds: 4.16,
    },
    nativeBoundaries: input.bindings.map((binding) => ({
      bindingId: binding.id, segmentIndex: binding.segmentIndex,
      startFrame: binding.timelineStartFrame, endFrame: binding.timelineEndFrame,
      startSeconds: binding.timelineStartFrame / 24, endSeconds: binding.timelineEndFrame / 24,
    })),
    shots: [{
      id: "shot-01", bindingId: input.bindings[0]!.id, segmentIndex: input.bindings[0]!.segmentIndex,
      startFrame: 0, endFrame: 100, startSeconds: 0, endSeconds: 4.16, detector: "native-segment", evidenceIds: ["frame-0001"],
    }],
    frames: [frame], audio: [audio], visualFrameIds: ["frame-0001"],
    config: { maxFrames: 12, visualFrames: 9, sampleIntervalSeconds: 2, sceneThreshold: 0.3, includeAudio: true },
    sourceHash: "source-hash",
  };
}

const fakeVisual: ObservationVisual = {
  characters: [{ description: "A woman with dark hair in a red dress.", identityMatch: "probable", evidenceIds: ["frame-0001"] }],
  location: { description: "A dimly lit bar.", evidenceIds: ["frame-0001"], confidence: "confirmed" },
  props: [], actions: [{ description: "She looks toward the left.", evidenceIds: ["frame-0001"] }],
  composition: [], expressions: [], artifacts: [],
  openingState: { description: "The woman stands in the bar.", evidenceIds: ["frame-0001"] },
  closingState: { description: "She remains in the bar.", evidenceIds: ["frame-0001"] },
  uncertainties: ["The sampled frame cannot establish her identity."], claims: [{ text: "A woman is visible.", evidenceIds: ["frame-0001"], confidence: "confirmed" }],
};

const fakeDialogue: ObservationDialogue = {
  provider: "whisper-turbo", model: "large-v3-turbo", text: "Hello.", language: "en",
  utterances: [{
    id: "utterance-001", startSeconds: 0.2, endSeconds: 1.0, startFrame: 5, endFrame: 24,
    text: "Hello.", language: "en", confidence: null,
    speaker: { label: "Unattributed speaker", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"],
  }],
  limitations: ["ASR only; speaker attribution is unknown."], evidenceIds: ["audio-01"],
};

const fakeComparison: ObservationComparison = {
  findings: [{
    id: "finding-001", category: "dialogue", expected: "Hello.", observed: "Hello.",
    classification: "confirmed", rationale: "The transcript matches.", evidenceIds: ["frame-0001"],
  }],
  proposedChanges: [{ op: "add", category: "episodic", text: "Akari greets Daichi in the bar.", phase: "closing", evidenceIds: ["frame-0001"] }],
  limitations: ["One sampled frame."], comparedAt: now, comparisonPromptVersion: "test-v1",
};

function manager(store: ProductionStore, out: string, seen: { bindings: string[] }): ObservationManager {
  return new ObservationManager({
    outDir: out, productions: store, runner: {} as Runner, inference: async (_label, work) => work(),
    evidence: (input) => { seen.bindings.push(...input.bindings.map((binding) => binding.id)); return fakeEvidence(input); },
    observer: {
      observe: async () => ({ visual: fakeVisual, model: "mock-qwen", version: "test", promptVersion: "test-visual", configuration: {}, rawText: "{}" }),
      compare: async () => ({ comparison: fakeComparison, rawText: "{}", promptVersion: "test-compare" }),
    },
    asr: { transcribe: async () => fakeDialogue },
    now: () => new Date(now), mediaRoots: [join(out, "media")],
  });
}

async function finished(manager: ObservationManager, id: string) {
  for (let i = 0; i < 100; i += 1) {
    const job = manager.get(id);
    if (job && ["succeeded", "failed", "canceled", "lost"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("observation job did not finish");
}

test("observer analyzes only the selected scene binding and records a structured immutable report", async () => {
  const { out, store } = fixture();
  try {
    const seen = { bindings: [] as string[] };
    const observations = manager(store, out, seen);
    const job = observations.start("suite-404", { sceneId: "scene-a", candidateId: "candidate-a" }, actor);
    const done = await finished(observations, job.id);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(seen.bindings, ["binding-a"], "unrelated scene bindings must never be analyzed");
    assert.ok(done.observationId);
    const snap = store.snapshot("suite-404");
    assert.equal(snap.revision, 0, "observation must not change the canonical revision");
    const observation = snap.observations[done.observationId!]!;
    assert.equal(observation.kind, "analysis");
    assert.equal(observation.report?.sceneId, "scene-a");
    assert.equal(observation.report?.bindingIds[0], "binding-a");
    assert.equal(observation.report?.shots.length, 1);
    assert.equal(observation.report?.dialogue?.utterances[0]?.text, "Hello.");
    assert.equal(observation.report?.comparison?.findings[0]?.classification, "confirmed");
    assert.equal(observation.report?.visual?.characters[0]?.identityMatch, "probable");
    assert.equal(observation.report?.observer?.visualCheckpoint?.file, "qwen3.8_27b_w4a8.safetensors");
    assert.equal(observation.report?.observer?.comparisonCheckpoint?.file, "qwen3.8_27b_w4a8.safetensors");
    assert.deepEqual(observation.report?.observer?.inputModalities, { text: true, image: true, video: false, audio: false });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("a second observation creates a new revision and preserves the earlier report", async () => {
  const { out, store } = fixture();
  try {
    const observations = manager(store, out, { bindings: [] });
    const first = await finished(observations, observations.start("suite-404", { sceneId: "scene-a", candidateId: "candidate-a" }, actor).id);
    const second = await finished(observations, observations.start("suite-404", { sceneId: "scene-a", candidateId: "candidate-a" }, actor).id);
    const snap = store.snapshot("suite-404");
    const list = Object.values(snap.observations).filter((item) => item.sceneId === "scene-a");
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((item) => item.revision).sort(), [1, 2]);
    assert.equal(snap.observations[second.observationId!]!.previousRevisionId, first.observationId);
    assert.equal(snap.observations[second.observationId!]!.report?.reportVersion, 2);
    assert.equal(snap.revision, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("observed changes become a normal proposal, never a canonical approval", async () => {
  const { out, store } = fixture();
  try {
    const observations = manager(store, out, { bindings: [] });
    const done = await finished(observations, observations.start("suite-404", { sceneId: "scene-a", candidateId: "candidate-a" }, actor).id);
    const result = observations.proposeChanges("suite-404", done.observationId!, actor);
    const snap = store.snapshot("suite-404");
    assert.equal(snap.revision, 0);
    assert.equal(Object.keys(snap.proposals).length, 1);
    assert.equal(Object.values(snap.proposals)[0]?.status, "proposed");
    assert.equal(Object.values(snap.proposals)[0]?.changes[0]?.category, "episodic");
    assert.equal(Object.keys(snap.bible.episodic).length, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("a failed visual stage keeps the evidence and still records a partial report", async () => {
  const { out, store } = fixture();
  try {
    const observations = new ObservationManager({
      outDir: out, productions: store, runner: {} as Runner, inference: async (_label, work) => work(),
      evidence: (input) => fakeEvidence(input),
      observer: { observe: async () => { throw new Error("observer unavailable"); }, compare: async () => ({ comparison: fakeComparison, rawText: "{}", promptVersion: "test" }) },
      asr: { transcribe: async () => fakeDialogue }, mediaRoots: [join(out, "media")], now: () => new Date(now),
    });
    const done = await finished(observations, observations.start("suite-404", { sceneId: "scene-a", candidateId: "candidate-a" }, actor).id);
    assert.equal(done.status, "succeeded");
    const observation = store.snapshot("suite-404").observations[done.observationId!]!;
    assert.equal(observation.report?.visual, undefined);
    assert.equal(observation.report?.dialogue?.text, "Hello.");
    assert.ok(observation.report?.stages.some((stage) => stage.name === "visual" && stage.status === "failed"));
    assert.ok(observation.report?.evidence.length);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("observed wardrobe becomes scene state, not permanent identity", async () => {
  const { out, store } = fixture();
  try {
    const observations = new ObservationManager({
      outDir: out, productions: store, runner: {} as Runner, inference: async (_label, work) => work(),
      evidence: (input) => fakeEvidence(input),
      observer: {
        observe: async () => ({ visual: fakeVisual, model: "mock", version: "test", promptVersion: "test", configuration: {}, rawText: "{}" }),
        compare: async () => ({
          comparison: {
            ...fakeComparison,
            proposedChanges: [{
              op: "add", category: "identity", text: "Akari wears a red satin dress and robe.",
              subjectIds: ["akari"], evidenceIds: ["frame-0001"], phase: "opening",
            }],
          },
          rawText: "{}", promptVersion: "test",
        }),
      },
      asr: { transcribe: async () => fakeDialogue }, mediaRoots: [join(out, "media")], now: () => new Date(now),
    });
    const done = await finished(observations, observations.start("suite-404", { sceneId: "scene-a", candidateId: "candidate-a" }, actor).id);
    const result = observations.proposeChanges("suite-404", done.observationId!, actor);
    const snap = store.snapshot("suite-404");
    const proposal = Object.values(snap.proposals)[0]!;
    assert.equal(proposal.changes[0]?.category, "state");
    assert.ok(proposal.changes[0]?.tags?.includes("wardrobe-not-identity"));
    assert.deepEqual(proposal.changes[0]?.evidenceIds, ["frame-0001"]);
    assert.equal(snap.revision, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});


test("an unsupported native modality is rejected instead of silently dropped", () => {
  const { out, store } = fixture();
  try {
    const observations = manager(store, out, { bindings: [] });
    assert.throws(() => observations.start("suite-404", {
      sceneId: "scene-a", candidateId: "candidate-a", options: { nativeAudio: true },
    }, actor), /does not expose native audio/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("Senior Review reuses an existing observation and skips extraction, ASR and visual inference", async () => {
  const { out, store } = fixture();
  try {
    let evidenceCalls = 0;
    let asrCalls = 0;
    const observations = new ObservationManager({
      outDir: out, productions: store, runner: {} as Runner, inference: async (_label, work) => work(),
      evidence: (input) => { evidenceCalls += 1; return fakeEvidence(input); },
      observer: {
        observe: async () => ({ visual: fakeVisual, model: "mock", version: "test", promptVersion: "test", configuration: {}, rawText: "{}" }),
        compare: async () => ({ comparison: fakeComparison, rawText: "{}", promptVersion: "test" }),
      },
      asr: { transcribe: async () => { asrCalls += 1; return fakeDialogue; } },
      mediaRoots: [join(out, "media")], now: () => new Date(now),
    });
    const first = await finished(observations, observations.start("suite-404", { sceneId: "scene-a", candidateId: "candidate-a" }, actor).id);
    const evidenceAfterFirst = evidenceCalls, asrAfterFirst = asrCalls;
    assert.equal(evidenceAfterFirst, 1);
    assert.equal(asrAfterFirst, 1);
    const senior = await finished(observations, observations.start("suite-404", {
      sceneId: "scene-a", candidateId: "candidate-a", profile: "senior", sourceObservationId: first.observationId!,
    }, actor).id);
    assert.equal(senior.status, "succeeded");
    assert.equal(evidenceCalls, evidenceAfterFirst, "Senior Review must not re-extract evidence");
    assert.equal(asrCalls, asrAfterFirst, "Senior Review must not re-run ASR");
    const report = store.snapshot("suite-404").observations[senior.observationId!]!.report!;
    assert.equal(report.seniorReview?.sourceObservationId, first.observationId);
    assert.equal(report.seniorReview?.reusedEvidence, true);
    assert.ok(report.comparison);
    assert.ok(report.stages.some((stage) => stage.name === "evidence" && stage.status === "skipped"));
    assert.ok(report.stages.some((stage) => stage.name === "asr" && stage.status === "skipped"));
    assert.ok(report.stages.some((stage) => stage.name === "visual" && stage.status === "skipped"));
    assert.equal(store.snapshot("suite-404").revision, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("Fast Review profile binds the Gemma visual and comparison model", async () => {
  const { out, store } = fixture();
  try {
    const observations = manager(store, out, { bindings: [] });
    const job = observations.start("suite-404", { sceneId: "scene-a", candidateId: "candidate-a", profile: "fast" }, actor);
    assert.equal(job.options.profile, "fast");
    assert.equal(job.options.visualModel, "gemma4-12b-heretic-w4a8");
    assert.equal(job.options.comparisonModel, "gemma4-12b-heretic-w4a8");
    assert.equal(job.options.nativeVideo, false);
    assert.equal(job.options.nativeAudio, false);
    await finished(observations, job.id);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
