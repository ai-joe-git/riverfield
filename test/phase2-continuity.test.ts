import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAssetCorrections, auditAssetCatalogue, buildAssetCorrectionBatch, assertTrustedReferences, readAssetCorrectionApplications, readAssetCorrectionDecisions, recordAssetCorrectionDecision, P6_REFERENCE_WARNING } from "../server/asset-audit.ts";
import { classifyContinuityTransition } from "../server/continuity-analysis.ts";
import { deriveObservedState } from "../server/observed-state.ts";
import { ProductionStore } from "../server/production-store.ts";

const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
const legacyBatch = {
  id: "legacy-asset-correction-batch", status: "prepared-not-applied" as const, generatedAt: "2026-11-26T23:00:00.000Z",
  source: "actual-image-inspection" as const, instruction: "Apply only after human approval; media files and historical observations are never rewritten." as const,
  entries: [{
    assetId: "legacy-asset", currentLabel: "Old_Label", proposedLabel: "New_Label", currentCategory: "characters", proposedCategory: "characters",
    currentAliases: [], proposedAliases: ["Assets/Characters/New_Label.png"], currentPath: "/tmp/old.png", currentHash: "old",
    currentTags: [], proposedTags: ["official-catalog", "Assets/Characters/New_Label.png"], supersededTagChange: "none" as const,
    referenceSuitability: "character-multiview-reference" as const, semanticIdentity: "test identity", observedContent: "test content", reason: "legacy test fixture",
  }],
  ambiguous: [],
};

test("canonical assets are present with trusted registry names and no stale correction batch", () => {
  const audit = auditAssetCatalogue(snapshot);
  assert.equal(audit.length, 44);
  assert.equal(audit.filter((entry: any) => !entry.trusted).length, 0);
  const heart = audit.find((entry: any) => entry.currentLabel === "Inflatable_Heart_Prop");
  const key = audit.find((entry: any) => entry.currentLabel === "Suite_404_Key_Fob_Prop");
  const momo = audit.find((entry: any) => entry.currentLabel === "Momo_Mascot_Character_Sheet");
  assert.ok(heart && key && momo);
  assert.equal(heart.proposedLabel, "Inflatable_Heart_Prop");
  assert.equal(key.proposedLabel, "Suite_404_Key_Fob_Prop");
  assert.equal(momo.proposedLabel, "Momo_Mascot_Character_Sheet");
  assert.doesNotThrow(() => assertTrustedReferences(snapshot, [heart.assetId, key.assetId, momo.assetId]));
  const batch = buildAssetCorrectionBatch(snapshot);
  assert.equal(batch.entries.length, 0);
  assert.equal(batch.ambiguous.length, 0);
  assert.equal(snapshot.revision, 0);
});

test("asset correction approval records a decision without rewriting historical assets", () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-asset-decision-"));
  try {
    const decision = recordAssetCorrectionDecision(out, legacyBatch, "approved", "test-human", "reviewed contact sheet");
    assert.equal(decision.decision, "approved");
    assert.equal(decision.entries, 1);
    assert.equal(decision.ambiguous, 0);
    assert.deepEqual(readAssetCorrectionDecisions(out).map((item) => item.decision), ["approved"]);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("asset corrections require individual approval and application remains a separate auditable operation", () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-asset-apply-"));
  try {
    const first = legacyBatch.entries[0];
    assert.throws(() => applyAssetCorrections(out, legacyBatch, [first.assetId], () => {}, "test-human"), /NOT_INDIVIDUALLY_APPROVED/);
    recordAssetCorrectionDecision(out, legacyBatch, "approved", "test-human", "batch decision only", undefined);
    assert.throws(() => applyAssetCorrections(out, legacyBatch, [first.assetId], () => {}, "test-human"), /NOT_INDIVIDUALLY_APPROVED/);
    recordAssetCorrectionDecision(out, legacyBatch, "approved", "test-human", "individual", first.assetId);
    const patches: any[] = [];
    const application = applyAssetCorrections(out, legacyBatch, [first.assetId], (assetId, patch) => patches.push({ assetId, patch }), "test-human", "explicit apply");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].assetId, first.assetId);
    assert.equal(application.before[first.assetId].label, first.currentLabel);
    assert.equal(application.after[first.assetId].label, first.proposedLabel);
    assert.equal(readAssetCorrectionApplications(out).length, 1);
    assert.equal(legacyBatch.ambiguous.length, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("the historical P6 observation keeps its contaminated reference provenance beside a separate warning", () => {
  const p6 = snapshot.observations["277e6cd4-9a50-42b0-a076-c4f8c822a01e"];
  assert.ok(p6);
  assert.equal(p6.report.reportVersion, 1);
  assert.equal(p6.report.sourceOutputHash, "8ad129e48c4f76f46491aceaeebda310151e42e53311927eb03dd5f84ad7f813");
  const provenance = JSON.stringify(p6.report);
  assert.match(provenance, /suite404-asset-20261124-234855840-40f7-1/);
  assert.match(provenance, /suite404-asset-20261124-235222479-02cb-1/);
  assert.deepEqual(P6_REFERENCE_WARNING.references, [
    "suite404-asset-20261124-234855840-40f7-1",
    "suite404-asset-20261124-235222479-02cb-1",
  ]);
  assert.equal(P6_REFERENCE_WARNING.status, "requires_review");
  assert.ok(existsSync("out/observations/phase2-asset-audit/p6-reference-audit-warning.json"));
});

test("the corrected P4 binding supersedes only the active association, not the historical journal", () => {
  const store = new ProductionStore("out");
  const active = store.activeBindings("suite-404", "suite404-20261125-125611401-84f5");
  assert.ok(active.some((binding) => binding.id === "suite404-20261125-125611401-84f5-b001-sc-corrected-001" && binding.sceneId === "suite-404-s01e01-sc04"));
  assert.equal(active.some((binding) => binding.id === "suite404-20261125-125611401-84f5-b001"), false);
  const original = snapshot.bindings["suite404-20261125-125611401-84f5"].find((binding: any) => binding.id === "suite404-20261125-125611401-84f5-b001");
  assert.equal(original.sceneId, "suite-404-s01e01-sc03");
  assert.equal(snapshot.bindingCorrections.find((item: any) => item.correctedBindingId === "suite404-20261125-125611401-84f5-b001-sc-corrected-001").correctedSceneId, "suite-404-s01e01-sc04");
});

test("P4-P6 reviews are immutable first-class revisions and remain non-canonical", () => {
  const deterministic = snapshot.continuityReviews["continuity-passion-max-p4-p6-deterministic"];
  const senior = snapshot.continuityReviews["continuity-passion-max-p4-p6-senior-prepared"];
  assert.ok(deterministic);
  assert.ok(senior);
  assert.equal(deterministic.status, "completed");
  assert.equal(deterministic.revision, 1);
  assert.equal(senior.status, "prepared");
  assert.equal(senior.revision, 2);
  assert.equal(senior.previousReviewId, deterministic.id);
  assert.equal(deterministic.canonicalRevision, 0);
  assert.equal(senior.canonicalRevision, 0);
  assert.equal(snapshot.revision, 0);
  assert.equal(senior.reviewer.model, "qwen3.8_27b_w4a8.safetensors");
  assert.deepEqual(senior.findings, []);
  assert.match(senior.limitations.join(" "), /explicit human approval/i);
  assert.equal(deterministic.observations.length, 3);
  assert.equal(deterministic.stateRecords.length, 3);
  assert.ok(deterministic.evidenceReferences.length > 0);
  const corrected = snapshot.continuityReviews["continuity-passion-max-p4-p6-senior-corrected-prepared"];
  const completed = snapshot.continuityReviews["continuity-4cf9219b-fc3c-4c67-b4fa-88e572fe0157"];
  assert.ok(corrected);
  assert.ok(completed);
  assert.equal(corrected.revision, 3);
  assert.equal(corrected.previousReviewId, senior.id);
  assert.equal(completed.revision, 4);
  assert.equal(completed.previousReviewId, corrected.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.reviewer.kind, "qwen");
  assert.equal(completed.canonicalRevision, 0);
  assert.equal(completed.findings.length, 3);
  assert.equal(completed.execution?.textBasedOnly, false);
  const supplied = JSON.parse(readFileSync(`${completed.execution.artifactDir}/supplied-evidence.json`, "utf8"));
  assert.equal(supplied.images.length, 8);
  assert.equal(supplied.audio.every((item: any) => item.suppliedToModel === false), true);
  assert.equal(supplied.textBasedOnly, false);
  for (const state of corrected.stateRecords) {
    assert.equal(state.events.length >= 0, true);
    assert.equal(state.persistent.observed_events.length, 0);
  }
  const seniorOutput = readFileSync(`${completed.execution.artifactDir}/raw-output.txt`, "utf8");
  assert.match(seniorOutput, /finding-001/);
  assert.match(seniorOutput, /recommendedDisposition/);
});

test("P4-P6 findings preserve wetness uncertainty, prop visibility and environmental persistence", () => {
  const review = JSON.parse(readFileSync("out/observations/phase1.3-passion-max-pilot/continuity-review.json", "utf8"));
  assert.ok(review.transitions.length >= 2);
  for (const transition of review.transitions) {
    assert.notEqual(transition.classification, "confirmed_contradiction");
  }
  const text = JSON.stringify(review);
  assert.match(text, /insufficient/i);
  assert.match(text, /petal/i);
  assert.match(text, /not visible|not.*proof|absence/i);
  const p6 = deriveObservedState("277e6cd4-9a50-42b0-a076-c4f8c822a01e", snapshot.observations["277e6cd4-9a50-42b0-a076-c4f8c822a01e"].report);
  assert.equal(p6.sceneId, "suite-404-s01e01-sc06");
  assert.ok(p6.unknown.some((item) => item.includes("temporary_physical_conditions")));
});

test("opening state is boundary evidence only; late events and scene-wide details cannot leak into it", () => {
  const p4 = deriveObservedState("7cd5be4a-2965-4ef3-8c3b-d00360a3d888", snapshot.observations["7cd5be4a-2965-4ef3-8c3b-d00360a3d888"].report);
  const openingText = JSON.stringify(p4.opening);
  assert.doesNotMatch(openingText, /leans over the toilet|sits in the bathtub|adjusts his shirt/i);
  assert.deepEqual(p4.boundaryEvidence.opening.map((item) => item.id), ["frame-0008"]);
  assert.deepEqual(p4.boundaryEvidence.closing.map((item) => item.id), ["frame-0009"]);
  assert.ok(p4.events.some((event) => /leans over the toilet/i.test(event.description) && (event.observedAtSeconds ?? 0) > 8));
  assert.ok(p4.events.every((event, index, list) => index === 0 || (event.observedAtSeconds ?? 0) >= (list[index - 1].observedAtSeconds ?? 0)));
  const openingIds = new Set(p4.boundaryEvidence.opening.map((item) => item.id));
  assert.ok(p4.opening.character_identity.every((value) => value.evidenceReferences.every((ref) => openingIds.has(ref.split(":").at(-1)!))), "boundary identity must cite opening evidence only");
  assert.ok(p4.persistent.character_identity.length > 0);
  assert.equal(p4.persistent.observed_events.length, 0, "events live in the chronological event list");
  assert.notDeepEqual(p4.opening, p4.closing);
});

test("P5 preserves boundary-specific wetness evidence while P6 wetness remains unknown", () => {
  const p5 = deriveObservedState("e7d95d04-0a8f-4d3d-b7b2-006dd5de7a08", snapshot.observations["e7d95d04-0a8f-4d3d-b7b2-006dd5de7a08"].report);
  const p6 = deriveObservedState("277e6cd4-9a50-42b0-a076-c4f8c822a01e", snapshot.observations["277e6cd4-9a50-42b0-a076-c4f8c822a01e"].report);
  const p5Opening = p5.opening.temporary_physical_conditions[0];
  const p5Closing = p5.closing.temporary_physical_conditions[0];
  assert.ok(p5Opening);
  assert.ok(p5Closing);
  assert.deepEqual(p5Opening.evidenceReferences, ["e7d95d04-0a8f-4d3d-b7b2-006dd5de7a08:frame-0004"]);
  assert.deepEqual(p5Closing.evidenceReferences, ["e7d95d04-0a8f-4d3d-b7b2-006dd5de7a08:frame-0005"]);
  assert.equal(p5Opening.confidence, "probable");
  assert.equal(p5.opening.temporary_physical_conditions.length, 1);
  assert.equal(p5.closing.temporary_physical_conditions.length, 1);
  assert.equal(p6.opening.temporary_physical_conditions.length, 0);
  assert.equal(p6.closing.temporary_physical_conditions.length, 0);
  assert.ok(p6.unknown.some((item) => item.includes("closing:temporary_physical_conditions")));
  assert.equal(p6.unknown.some((item) => item.includes("key_fob") || item.includes("heart_not_sampled")), false);
});

test("a controlled contradictory fixture is classified as a contradiction, not compatible", () => {
  const contradiction = classifyContinuityTransition(
    { characters: ["daichi"], wetness: "wet", props: { key: "present" } },
    { characters: ["daichi"], wetness: "dry", props: { key: "present" } },
  );
  assert.equal(contradiction.classification, "confirmed_contradiction");
  assert.ok(contradiction.reasons.some((reason) => /wet|dry/i.test(reason)));
  const unknown = classifyContinuityTransition(
    { characters: ["daichi"], wetness: "wet", props: { key: "present" } },
    { characters: ["daichi"], wetness: "unknown", props: { key: "unknown" } },
  );
  assert.equal(unknown.classification, "insufficient_evidence");
});

test("continuity review storage is append-only, versioned and never advances canonical revision", () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-continuity-"));
  const store = new ProductionStore(out);
  try {
    const actor = { kind: "agent" as const, id: "test-agent" };
    store.createProduction({ id: "suite-404", title: "SUITE 404" }, actor, "p");
    store.createSeason("suite-404", { id: "suite-404-s01", number: 1, title: "Season 01" }, actor, "s");
    store.createEpisode("suite-404", { id: "suite-404-s01e01", seasonId: "suite-404-s01", number: 1, title: "Episode" }, actor, "e");
    store.createScene("suite-404", { id: "suite-404-s01e01-sc01", episodeId: "suite-404-s01e01", number: 1, title: "Scene" }, actor, "sc");
    const report = {
      reportVersion: 1, sceneId: "suite-404-s01e01-sc01", sourceOutputHash: "hash-1",
      productionId: "suite-404", episodeId: "suite-404-s01e01", sourceRunId: "run",
      bindingIds: [], timebase: "final-output", evidence: [], shots: [], visual: {}, dialogue: {},
      limitations: [], createdAt: new Date().toISOString(),
    } as never;
    const withObservation = store.recordObservation("suite-404", { id: "obs-1", sceneId: "suite-404-s01e01-sc01", text: "observed", report }, actor, "obs");
    assert.equal(withObservation.revision, 0);
    const first = store.recordContinuityReview("suite-404", {
      id: "review-1", sceneIds: ["suite-404-s01e01-sc01"],
      observations: [{ observationId: "obs-1", sceneId: "suite-404-s01e01-sc01", revision: 1, sourceHash: "ignored" }],
      reviewer: { model: "deterministic", kind: "deterministic" }, status: "completed", findings: [{ classification: "compatible" }],
    }, actor, "review:1");
    assert.equal(first.continuityReviews["review-1"].canonicalRevision, 0);
    assert.equal(first.continuityReviews["review-1"].observations[0].sourceHash, "hash-1");
    assert.equal(first.continuityReviews["review-1"].revision, 1);
    const second = store.recordContinuityReview("suite-404", {
      id: "review-2", sceneIds: ["suite-404-s01e01-sc01"],
      observations: [{ observationId: "obs-1", sceneId: "suite-404-s01e01-sc01", revision: 1, sourceHash: "hash-1" }],
      reviewer: { model: "qwen", kind: "qwen" }, status: "prepared", findings: [],
    }, actor, "review:2");
    assert.equal(second.continuityReviews["review-2"].revision, 2);
    assert.equal(second.continuityReviews["review-2"].previousReviewId, "review-1");
    assert.equal(second.revision, 0, "recording a review never canonizes a fact");
    const eventsBefore = store.events("suite-404").length;
    assert.throws(() => store.recordContinuityReview("suite-404", {
      id: "review-1", sceneIds: ["suite-404-s01e01-sc01"],
      observations: [{ observationId: "obs-1", sceneId: "suite-404-s01e01-sc01", revision: 1, sourceHash: "hash-1" }],
      reviewer: { model: "forged", kind: "deterministic" }, status: "completed",
    }, actor, "review:forged"), (error: unknown) => error instanceof Error && /immutable/.test(error.message));
    assert.equal(store.events("suite-404").length, eventsBefore, "an existing review is never overwritten");
    assert.equal(store.events("suite-404").filter((event) => event.type === "continuity.reviewed").length, 2);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
