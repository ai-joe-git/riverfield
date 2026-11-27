import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCompactBatchPrompt, buildContinuityPlan, planTransitionBatches,
  resolveActiveBindings, validateSeniorContinuityOutput, type SelectedScene,
} from "../server/continuity-scope.ts";
import { classifyContinuityTransition } from "../server/continuity-analysis.ts";

function report(sceneId: string, candidateId: string, episodeId: string, opening: string, closing: string, audio = true) {
  const openRef = "ev-open", closeRef = "ev-close", audioRef = "ev-audio";
  return {
    schemaVersion: 1, reportVersion: 1, productionId: "synthetic-prod", episodeId, sceneId, candidateId,
    sourceOutputHash: `hash-${sceneId}`, bindingIds: [`binding-${sceneId}`], timebase: "final-output",
    technical: { sourcePath: "", sourceHash: `source-${sceneId}`, sourceVerified: true, fps: 24, frameCount: 100, duration: 4, audioStreams: [], sceneStartFrame: 0, sceneEndFrame: 100, sceneStartSeconds: 0, sceneEndSeconds: 4 },
    shots: [{ id: `shot-${sceneId}`, bindingId: `binding-${sceneId}`, segmentIndex: 0, startFrame: 0, endFrame: 100, startSeconds: 0, endSeconds: 4, detector: "ffmpeg-scene", evidenceIds: [] }],
    evidence: [
      { id: openRef, kind: "opening_frame", file: `${sceneId}-open.jpg`, path: `/tmp/${sceneId}-open.jpg`, hash: `open-${sceneId}`, frame: 1, timestampSeconds: 0.04, shotId: `shot-${sceneId}` },
      { id: closeRef, kind: "closing_frame", file: `${sceneId}-close.jpg`, path: `/tmp/${sceneId}-close.jpg`, hash: `close-${sceneId}`, frame: 99, timestampSeconds: 3.95, shotId: `shot-${sceneId}` },
      ...(audio ? [{ id: audioRef, kind: "audio", file: `${sceneId}.wav`, path: `/tmp/${sceneId}.wav`, hash: `audio-${sceneId}` }] : []),
    ],
    visual: {
      characters: [{ description: "Mira", identityMatch: "probable", clothing: "grey coat", evidenceIds: [openRef, closeRef] }],
      props: [{ description: "lamp", state: "on table", evidenceIds: [openRef] }],
      actions: [{ description: "Mira crosses the room", evidenceIds: [closeRef] }],
      expressions: [], composition: [], stylisticEffects: [], artifacts: [], uncertainties: [], claims: [],
      openingState: { description: opening, evidenceIds: [openRef] },
      closingState: { description: closing, evidenceIds: [closeRef] },
    },
    dialogue: { provider: "whisper-turbo", text: "We need the lamp.", utterances: [{ text: "We need the lamp.", startSeconds: 0.2, endSeconds: 1, unclear: false, evidenceIds: [audioRef] }], limitations: [], evidenceIds: [audioRef], rawTranscript: "We need the lamp." },
    observedEvents: [{ text: "Mira crosses the room", evidenceIds: [closeRef], confidence: "probable" }],
    comparison: { findings: [], proposedChanges: [], limitations: [], comparedAt: "", comparisonPromptVersion: "test" },
    confidence: "probable", uncertainties: [], limitations: [], stages: [],
  } as any;
}

function review(id: string, status: string, kind: "deterministic" | "qwen", scenes: string[], obs: any[], candidates: string[], bindings: string[], episodeId: string, findings: any[] = [], canonicalRevision = 0) {
  return {
    id, productionId: "synthetic-prod", seasonId: "synth-s01", episodeId, sceneIds: scenes, bindingIds: bindings, candidateIds: candidates,
    observations: obs, canonicalRevision, reviewer: { model: kind === "qwen" ? "qwen-test" : "deterministic-test", kind, configuration: {} },
    evidenceReferences: [], status, findings, stateRecords: [], correctionPlans: [], limitations: [], revision: kind === "deterministic" ? 1 : 2, createdAt: "2026-01-01T00:00:00.000Z", createdBy: "test",
  } as any;
}

function fixture(sceneCount = 2, episodeId = "synth-ep-01") {
  const scenes = Array.from({ length: sceneCount }, (_, index) => `synth-sc-${String(index + 1).padStart(2, "0")}`);
  const candidateId = "synthetic-candidate";
  const bindings = scenes.map((sceneId, index) => ({ id: `synthetic-binding-${index + 1}`, candidateId, sceneId, segmentIndex: index, timelineStartFrame: index * 100, timelineEndFrame: (index + 1) * 100, outputHash: `hash-${sceneId}`, timebase: "final-output" as const }));
  const observations: Record<string, any> = {};
  for (const [index, sceneId] of scenes.entries()) {
    const observationId = `synthetic-observation-${index + 1}`;
    const observationReport = report(sceneId, candidateId, episodeId, `opening ${sceneId}`, `closing ${sceneId}`);
    observationReport.bindingIds = [bindings[index].id];
    observations[observationId] = { id: observationId, productionId: "synthetic-prod", sceneId, candidateId, kind: "analysis", revision: 1, text: "synthetic", report: observationReport, createdAt: "2026-01-01T00:00:00.000Z", createdBy: "test", source: "agent" };
  }
  const obs = scenes.map((sceneId, index) => ({ observationId: `synthetic-observation-${index + 1}`, sceneId, revision: 1, sourceHash: `hash-${sceneId}` }));
  const baselineFindings = [{ id: "baseline-synthetic-001", summary: "The lamp remains present.", from: scenes[0], to: scenes[1], closingEvidence: [`synthetic-observation-1:ev-close`], openingEvidence: [`synthetic-observation-2:ev-open`] }];
  const baseline = review("synthetic-baseline-a", "completed", "deterministic", scenes, obs, [candidateId], bindings.map((binding) => binding.id), episodeId, baselineFindings);
  const prepared = review("synthetic-prepared", "prepared", "qwen", scenes, obs, [candidateId], bindings.map((binding) => binding.id), episodeId);
  const otherBaseline = review("synthetic-baseline-b", "completed", "deterministic", scenes, obs, [candidateId], bindings.map((binding) => binding.id), "synth-ep-other", baselineFindings);
  const snapshot = {
    schemaVersion: 1, production: { id: "synthetic-prod", title: "Synthetic Production" }, seasons: [], episodes: [{ id: episodeId, seasonId: "synth-s01", number: 1, title: "Episode" }],
    scenes: scenes.map((id, index) => ({ id, episodeId, number: index + 1, title: `Synthetic scene ${index + 1}` })),
    candidates: { [candidateId]: { id: candidateId, productionId: "synthetic-prod", label: "C1", bindings, outputs: [] } },
    bindings: { [candidateId]: bindings }, bindingCorrections: [], observations,
    continuityReviews: { [baseline.id]: baseline, [prepared.id]: prepared, [otherBaseline.id]: otherBaseline },
    sceneDecisions: {}, bible: { identity: [], state: [], episodic: [], narrative: [] }, proposals: {}, assets: {}, assetBuilds: {}, revision: 0, lastEventSeq: 0, lastEventHash: null, updatedAt: "2026-01-01T00:00:00.000Z",
  } as any;
  return { snapshot, scenes, candidateId, bindings, baseline, prepared, otherBaseline, obs };
}

test("the generic planner works on a different production and never leaks Passion Max identifiers", () => {
  const { snapshot } = fixture(3);
  const plan = buildContinuityPlan(snapshot, { preparedReviewId: "synthetic-prepared", baselineReviewId: "synthetic-baseline-a" });
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.scenes.map((scene) => scene.alias), ["S01", "S02", "S03"]);
  assert.equal(plan.baselineFindingsCount, 1);
  assert.match(plan.baselineContentHash, /^[a-f0-9]{64}$/);
  const prompt = buildCompactBatchPrompt(plan, plan.batches[0]).input;
  assert.doesNotMatch(prompt, /P4|P5|P6|suite-404|7cd5be4a|e7d95d04|277e6cd4|Inflatable_Heart|Key_Fob/);
  assert.match(prompt, /Synthetic Production|S01|baseline-synthetic-001/);
  assert.match(prompt, /baselineDispositions/);
});

test("the planner resolves corrected active bindings instead of the superseded association", () => {
  const { snapshot, candidateId, bindings } = fixture(2);
  const original = bindings[0];
  snapshot.bindingCorrections = [{ candidateId, originalBindingId: original.id, originalSceneId: original.sceneId, correctedBindingId: `${original.id}-sc-corrected-001`, correctedSceneId: "synth-sc-02", sourceHash: original.outputHash, reason: "test correction" }];
  const active = resolveActiveBindings(snapshot, candidateId);
  assert.ok(active.some((binding) => binding.id === `${original.id}-sc-corrected-001` && binding.sceneId === "synth-sc-02"));
  assert.equal(active.some((binding) => binding.id === original.id), false);
});

test("explicit baseline scope and episode are enforced with no unrelated fallback", () => {
  const { snapshot, otherBaseline } = fixture(2);
  assert.throws(() => buildContinuityPlan(snapshot, { preparedReviewId: "synthetic-prepared", baselineReviewId: "missing-baseline" }), /SENIOR_BASELINE_MISSING/);
  assert.throws(() => buildContinuityPlan(snapshot, { preparedReviewId: "synthetic-prepared", baselineReviewId: otherBaseline.id }), /SENIOR_BASELINE_EPISODE_MISMATCH/);
});

test("missing observations are rejected before any inference planning", () => {
  const { snapshot } = fixture(2);
  delete snapshot.observations["synthetic-observation-2"];
  assert.throws(() => buildContinuityPlan(snapshot, { preparedReviewId: "synthetic-prepared", baselineReviewId: "synthetic-baseline-a" }), /SENIOR_SCOPE_OBSERVATION_MISSING/);
});

test("observations must match the exact candidate, scene and active binding scope", () => {
  const { snapshot } = fixture(2);
  snapshot.observations["synthetic-observation-1"].candidateId = "other-candidate";
  assert.throws(() => buildContinuityPlan(snapshot, { preparedReviewId: "synthetic-prepared", baselineReviewId: "synthetic-baseline-a" }), /OBSERVATION_CANDIDATE_MISMATCH/);
  const { snapshot: second } = fixture(2);
  second.continuityReviews["synthetic-baseline-a"].bindingIds = [];
  assert.throws(() => buildContinuityPlan(second, { preparedReviewId: "synthetic-prepared", baselineReviewId: "synthetic-baseline-a" }), /BASELINE_BINDING_MISMATCH/);
});

test("evidence from an unrelated observation cannot enter a transition batch", () => {
  const { snapshot } = fixture(2);
  snapshot.continuityReviews["synthetic-baseline-a"].findings[0].closingEvidence = ["unrelated-observation:ev-close"];
  const plan = buildContinuityPlan(snapshot, { preparedReviewId: "synthetic-prepared", baselineReviewId: "synthetic-baseline-a" });
  assert.equal(plan.batches.every((batch) => batch.images.every((image) => image.observationId.startsWith("synthetic-observation-"))), true);
});

test("missing selected evidence is recorded, never silently treated as a supported finding", () => {
  const { snapshot } = fixture(2);
  snapshot.observations["synthetic-observation-1"].report.evidence = [];
  snapshot.observations["synthetic-observation-2"].report.evidence = [];
  const plan = buildContinuityPlan(snapshot, { preparedReviewId: "synthetic-prepared", baselineReviewId: "synthetic-baseline-a" });
  assert.ok(plan.batches.every((batch) => batch.images.length === 0));
  assert.ok(plan.batches.some((batch) => batch.missingEvidence.length > 0));
});

test("large scene ranges split into bounded batches that respect image capacity", () => {
  const { snapshot } = fixture(8);
  const plan = buildContinuityPlan(snapshot, { preparedReviewId: "synthetic-prepared", baselineReviewId: "synthetic-baseline-a", maxImages: 9 });
  assert.ok(plan.batches.length > 1);
  for (const batch of plan.batches) assert.ok(batch.images.length <= 9, `${batch.id} exceeded capacity`);
  assert.ok(plan.batches.some((batch) => batch.sceneAliases.length >= 3));
  assert.ok(plan.batches.every((batch) => batch.sceneAliases.length <= 4));
});

test("baseline dispositions require coverage for every finding and reject unknown references", () => {
  const { snapshot } = fixture(3);
  const plan = buildContinuityPlan(snapshot, { preparedReviewId: "synthetic-prepared", baselineReviewId: "synthetic-baseline-a" });
  const batch = plan.batches[0];
  const valid = validateSeniorContinuityOutput({ findings: [], baselineDispositions: plan.baseline.findings.map((finding) => ({ baselineFindingId: finding.id, disposition: "confirms", reason: "test" })), correctionPlans: [] }, plan, batch);
  assert.equal(valid.coverageComplete, true);
  const missing = validateSeniorContinuityOutput({ findings: [], baselineDispositions: [], correctionPlans: [] }, plan, batch);
  assert.equal(missing.coverageComplete, false);
  assert.deepEqual(missing.unreviewedBaselineFindings, plan.baseline.findings.map((finding) => finding.id));
  const unknown = validateSeniorContinuityOutput({ findings: [], baselineDispositions: [{ baselineFindingId: "invented", disposition: "challenges" }], correctionPlans: [] }, plan, batch);
  assert.equal(unknown.coverageComplete, false);
});

test("deliberate contradictory boundary fixtures still classify as contradictions", () => {
  assert.equal(classifyContinuityTransition({ characters: ["mira"], wetness: "wet", props: { lamp: "present" } }, { characters: ["mira"], wetness: "dry", props: { lamp: "present" } }).classification, "confirmed_contradiction");
});

test("the existing Passion Max plan is generic, compact and resolves its corrected binding", () => {
  const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
  const plan = buildContinuityPlan(snapshot, { preparedReviewId: "continuity-passion-max-p4-p6-senior-corrected-prepared", baselineReviewId: "continuity-passion-max-p4-p6-deterministic" });
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.scenes[0].bindingIds.includes("suite404-20261125-125611401-84f5-b001-sc-corrected-001"), true);
  const prompt = buildCompactBatchPrompt(plan, plan.batches[0]).input;
  assert.ok(prompt.length < 20000, `prompt too large: ${prompt.length}`);
  assert.doesNotMatch(prompt, /[0-9a-f]{8}-[0-9a-f-]{20,}/i);
  assert.doesNotMatch(prompt, /P4|P5|P6/);
  assert.equal(plan.referenceWarnings.length, 0);
  assert.doesNotMatch(JSON.stringify(plan.referenceWarnings), /P6 historical|P6 observation retains/);
});

test("planTransitionBatches is generic for selected scenes and capacity", () => {
  const scenes = Array.from({ length: 5 }, (_, index) => ({ alias: `S0${index + 1}`, sceneId: `scene-${index + 1}` } as SelectedScene));
  const batches = planTransitionBatches(scenes, 9);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.sceneAliases.length <= 4));
});
