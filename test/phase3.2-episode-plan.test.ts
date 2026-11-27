import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditAssetCatalogue } from "../server/asset-audit.ts";
import { planH3 } from "../server/h3-plan.ts";

const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
const run = snapshot.productionRuns["phase3.2-suite404-s01e03-production-001"];
const plan = JSON.parse(readFileSync("out/productions/suite-404/phase3.2/episode-plan.json", "utf8"));

test("the Phase 3.2 episode stops at its second human checkpoint", () => {
  assert.ok(run);
  assert.equal(run.status, "awaiting_human");
  assert.equal(run.stage, "awaiting_human");
  assert.equal(run.currentSceneIndex, 1);
  assert.equal(run.scenePlan.length, 12);
  assert.equal(run.scenePlan.every((scene: any) => Math.abs(scene.targetDurationSeconds - 362 / 24) < 1e-9), true);
  assert.equal(run.scenePlan.every((scene: any) => scene.renderConfig.target_frames === 362), true);
  assert.equal(run.scenePlan.every((scene: any) => scene.profile === "build"), true);
  assert.equal(run.scenePlan.every((scene: any) => scene.selectedApp === "h3-studio-director-flash"), true);
  assert.equal(run.scenePlan[1].status, "awaiting_human");
  assert.equal(run.scenePlan.slice(2).every((scene: any) => scene.status === "planned"), true);
  assert.equal(run.budget.rendersUsed, 2);
  assert.equal(run.budget.promptEnhancementsUsed, 2);
  assert.equal(run.budget.observationJobsUsed, 2);
  assert.equal(run.budget.comparisonCallsUsed, 2);
  assert.equal(run.budget.seniorReviewBatchesUsed, 0);
  assert.equal(run.scenePlan[0].status, "approved");
  assert.equal(run.scenePlan[0].validation.ok, true);
  assert.equal(run.scenePlan[0].observationIds.length, 2);
  assert.equal(run.scenePlan[1].status, "awaiting_human");
  assert.equal(run.scenePlan[1].validation.ok, false);
  assert.match(run.scenePlan[1].errors.join(" "), /unsupported value mismatch/);
  assert.equal(snapshot.revision, 0);
});

test("the episode budget and selective Senior Review policy are explicit", () => {
  assert.deepEqual({
    renders: run.budget.maxTotalRenders,
    prompts: run.budget.maxPromptEnhancements,
    observations: run.budget.maxObservationJobs,
    comparisons: run.budget.maxComparisonCalls,
    senior: run.budget.maxSeniorReviewBatches,
  }, { renders: 12, prompts: 12, observations: 12, comparisons: 12, senior: 2 });
  assert.deepEqual(run.scenePlan.filter((scene: any) => scene.seniorReview).map((scene: any) => scene.sceneId), [
    "suite-404-s01e03-sc04",
    "suite-404-s01e03-sc08",
  ]);
  assert.equal(plan.approvalPolicy.regeneration, "Zero automatic regenerations. A rejected scene returns to human planning; any replacement is a new explicit human decision.");
  assert.equal(plan.memoryStrategy.noCanonicalPromotion, "No provisional fact is promoted to the Bible during this run.");
});

test("every scene brief is self-contained and every reference asset is trusted", () => {
  const audit = new Map(auditAssetCatalogue(snapshot).map((asset) => [asset.assetId, asset]));
  for (const [index, scene] of run.scenePlan.entries()) {
    assert.match(scene.objective, /Self-contained Director brief/);
    assert.match(scene.objective, new RegExp(`Scene ${String(index + 1).padStart(2, "0")}/12`));
    assert.match(scene.objective, /Dialogue \(native English/);
    assert.match(scene.objective, /Do not introduce other speaking characters/);
    assert.ok(scene.referenceAssetIds.length >= 3);
    for (const assetId of scene.referenceAssetIds) assert.equal(audit.get(assetId)?.trusted, true, assetId);
  }
  assert.equal(plan.requiredReferenceAssets.length, new Set(run.scenePlan.flatMap((scene: any) => scene.referenceAssetIds)).size);
});

test("the screenplay has a setup, escalating complications, emotional development and payoff", () => {
  const screenplay = JSON.parse(readFileSync("out/productions/suite-404/phase3.2/screenplay.json", "utf8"));
  assert.equal(screenplay.scenes.length, 12);
  assert.match(screenplay.structure.setup, /Scenes 01–03/);
  assert.match(screenplay.structure.escalatingComplications, /Scenes 04–06/);
  assert.match(screenplay.structure.emotionalDevelopment, /Scenes 07–09/);
  assert.match(screenplay.structure.payoff, /Scenes 10–12/);
  assert.match(screenplay.scenes.at(-1).dialogue.join(" "), /I call it a beginning/);
});

test("H3 preflight uses a legal 362-frame window and never reuses the 175-frame pilot", () => {
  const preflight = JSON.parse(readFileSync("out/productions/suite-404/phase3.2/preflight.json", "utf8"));
  const geometry = planH3({ seconds: 362 / 24, prompts: ["preflight"], images: [0, 1, 2, 3, 4] });
  assert.equal(geometry.frames, 362);
  assert.equal(geometry.segmentFrames, 362);
  assert.equal(geometry.seconds, 362 / 24);
  assert.equal((362 - 5) % 17, 0);
  assert.equal(preflight.frames.h3Legal, true);
  assert.equal(preflight.frames.targetFrames, 362);
  assert.equal(preflight.frames.previousPilotFrames, 175);
  assert.equal(preflight.frames.doesNotReusePilotDuration, true);
  assert.deepEqual(preflight.frames.plannedWindows.map((window: any) => [window.start, window.end]), [[0, 362]]);
  assert.equal(preflight.render.production_megapixels, 0.1);
  assert.equal(preflight.render.production_upscale, "");
  assert.equal(preflight.render.selectedApp, "h3-studio-director-flash");
});

test("the first scene reference manifest is ordered, trusted and hash-verified", () => {
  const preflight = JSON.parse(readFileSync("out/productions/suite-404/phase3.2/preflight.json", "utf8"));
  assert.deepEqual(preflight.referenceSlotOrder.map((ref: any) => ref.slot), [1, 2, 3, 4, 5]);
  assert.deepEqual(preflight.referenceSlotOrder.map((ref: any) => ref.assetId), [
    "suite404-official-akari-character-sheet",
    "suite404-official-daichi-character-sheet",
    "suite404-asset-20261124-220335005-2eb3-1",
    "suite404-asset-20261124-220640547-5d0c-1",
    "suite404-asset-20261125-004302381-a475-1",
  ]);
  assert.equal(preflight.referenceSlotOrder.every((ref: any) => ref.trusted && ref.exists && ref.hashMatches), true);
  assert.equal(preflight.referenceCapacity.supplied, 5);
  assert.equal(preflight.observation.referenceImages, 5);
  assert.equal(preflight.observation.visualFrames, 4);
  assert.equal(preflight.observation.totalImages, 9);
  assert.equal(run.scenePlan.every((scene: any) => scene.observerReferenceAssetIds.length + scene.observationVisualFrames <= 9), true);
  assert.equal(preflight.pendingAssetCorrectionsApplied, false);
  assert.equal(preflight.noInferenceStarted, true);
});

test("prop, voice and narrative corrections are explicit in the prepared scenes", () => {
  const first = run.scenePlan[0];
  assert.deepEqual(first.props.map((prop: any) => prop.id), ["room-key", "survey-folder"]);
  assert.equal(first.props.every((prop: any) => prop.assetStatus === "intended-only-untrusted"), true);
  const allPropIds = new Set(run.scenePlan.flatMap((scene: any) => scene.propIds));
  for (const id of ["room-key", "survey-folder", "masking-tape", "romance-panel", "karaoke-equipment", "cocktail-menu", "drinking-glasses"]) assert.equal(allPropIds.has(id), true, id);
  assert.deepEqual(run.scenePlan[1].voiceRequirements.map((voice: any) => voice.speaker), ["Kuroda"]);
  assert.deepEqual(run.scenePlan[3].voiceRequirements.map((voice: any) => voice.speaker), ["Yumi"]);
  assert.deepEqual(run.scenePlan[8].voiceRequirements.map((voice: any) => voice.speaker), ["Romance panel"]);
  assert.match(run.scenePlan[7].dialogueRequirements[0], /merged the keys/);
  assert.match(run.scenePlan[9].objective, /calibration toast/);
  assert.match(run.scenePlan[11].objective, /chosen rooftop toast/);
  assert.match(run.scenePlan[10].objective, /swapped his key fob into 404's slot/);
  for (const index of [6, 10]) {
    const words = run.scenePlan[index].dialogueRequirements.map((line: string) => line.replace(/^[^:]+:\s*/, "")).join(" ").match(/\b[\w']+\b/g) ?? [];
    assert.ok(words.length <= 30, `${run.scenePlan[index].sceneId} has ${words.length} spoken words`);
  }
});

test("Scene 01 preserves the failed observation and validates a recovered successor without inference", () => {
  const scene = run.scenePlan[0];
  const original = snapshot.observations[scene.observationIds[0]];
  const successor = snapshot.observations[scene.observationIds[1]];
  assert.equal(original.report.failure.stage, "comparison");
  assert.equal(original.report.comparison, undefined);
  assert.equal(successor.previousRevisionId, original.id);
  assert.equal(successor.revision, 2);
  assert.equal(successor.report.failure, undefined);
  assert.equal(successor.report.comparison.findings.length, 11);
  assert.equal(successor.report.comparison.proposedChanges.length, 0);
  assert.equal(successor.report.comparison.rejectedProposals?.length, 3);
  assert.equal(successor.report.comparison.rejectedProposals?.every((item: any) => item.original.category === "wardrobe"), true);
  assert.match(successor.report.comparison.limitations.join(" "), /Build mode: all canonical proposals were rejected individually/);
  assert.equal(scene.errors.some((error: string) => /unsupported category wardrobe/.test(error)), true);
  assert.equal(snapshot.revision, 0);
});

test("Scene 01 human retention is explicit and Scene 02 uses the accepted revision-2 context", () => {
  const scene1 = run.scenePlan[0];
  assert.equal(run.decisions.some((decision: any) => decision.sceneId === scene1.sceneId && decision.decision === "approved"), true);
  assert.equal(scene1.acceptedObservation.observationId, "f76bb88d-cbbc-4220-9fcc-9d64b2d4c66a-comparison-recovered-r2");
  assert.equal(scene1.acceptedObservation.revision, 2);
  assert.equal(scene1.acceptedObservation.selection, "human-selected");
  const scene2 = run.scenePlan[1];
  assert.equal(scene2.renderContext.priorObservationId, scene1.acceptedObservation.observationId);
  assert.equal(scene2.renderContext.priorObservationRevision, 2);
  assert.equal(scene2.renderContextHash, scene2.renderContext.effectiveContextHash);
  assert.ok(JSON.stringify(scene2.renderContext.persistentState.wardrobe).includes("maroon"));
  assert.equal(scene2.observerReferenceAssetIds.length, 3);
  assert.equal(scene2.observationVisualFrames, 6);
  assert.equal(scene2.observerReferenceAssetIds.length + scene2.observationVisualFrames, 9);
  assert.equal(run.scenePlan.slice(2).every((item: any) => item.status === "planned"), true);
  assert.equal(snapshot.revision, 0);
});

test("Scene 02 wall-clock accounting separates active production from human waiting", () => {
  const audit = JSON.parse(readFileSync("out/productions/suite-404/phase3.2/wall-clock-audit-scene02.json", "utf8"));
  assert.equal(audit.budgetResetOrExtended, false);
  assert.equal(audit.activeProduction.minutes > 0, true);
  assert.equal(audit.humanReviewWaiting.minutes > audit.activeProduction.minutes, true);
  assert.equal(audit.remaining.totalMinutes >= 0, true);
});
