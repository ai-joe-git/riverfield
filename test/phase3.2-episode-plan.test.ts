import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditAssetCatalogue } from "../server/asset-audit.ts";

const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
const run = snapshot.productionRuns["phase3.2-suite404-s01e03-production-001"];
const plan = JSON.parse(readFileSync("out/productions/suite-404/phase3.2/episode-plan.json", "utf8"));

test("the Phase 3.2 episode is prepared but not launched", () => {
  assert.ok(run);
  assert.equal(run.status, "prepared");
  assert.equal(run.stage, "plan");
  assert.equal(run.currentSceneIndex, 0);
  assert.equal(run.scenePlan.length, 12);
  assert.equal(run.scenePlan.every((scene: any) => scene.targetDurationSeconds === 15), true);
  assert.equal(run.scenePlan.every((scene: any) => scene.profile === "build"), true);
  assert.equal(run.scenePlan.every((scene: any) => scene.selectedApp === "h3-studio-director-flash"), true);
  assert.equal(run.scenePlan.every((scene: any) => scene.status === "planned"), true);
  assert.equal(run.budget.rendersUsed, 0);
  assert.equal(run.budget.promptEnhancementsUsed, 0);
  assert.equal(run.budget.observationJobsUsed, 0);
  assert.equal(run.budget.comparisonCallsUsed, 0);
  assert.equal(run.budget.seniorReviewBatchesUsed, 0);
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
