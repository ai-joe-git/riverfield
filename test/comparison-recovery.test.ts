import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { recoverComparison } from "../server/comparison-recovery.ts";

const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
const run = snapshot.productionRuns["phase3-suite404-pilot-001"];
const report = snapshot.observations[run.scenePlan[0].observationIds[0]].report;
const raw = readFileSync("out/observations/runs/obs-20261127013129746-6377a563/comparison-raw.txt", "utf8");

test("the failed first-scene comparison is recovered by one audited bracket insertion without inference", () => {
  const result = recoverComparison(raw, report, 4277);
  assert.equal(result.valid, true);
  assert.equal(result.insertion.index, 4277);
  assert.equal(result.insertion.character, "]");
  assert.match(result.rawHash, /^[a-f0-9]{64}$/);
  assert.match(result.recoveredJsonHash, /^[a-f0-9]{64}$/);
  assert.equal(result.effectiveComparison.findings.length, 8);
  assert.equal(result.effectiveComparison.proposedChanges.length, 0);
  assert.deepEqual(result.rejectedProposedChanges[0].reasons, ["missing factId", "unknown subject location"]);
  assert.equal(result.effectiveComparison.findings[3].classification, "uncertain");
  assert.equal(result.effectiveComparison.limitations.length, 4);
});

test("recovery rejects a requested position that is not a unique single-bracket repair", () => {
  const result = recoverComparison(raw, report, 0);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /not a valid single-bracket repair/);
});

test("recovery does not invent or replace model evidence identifiers", () => {
  const result = recoverComparison(raw, report, 4277);
  const evidence = new Set(result.effectiveComparison.findings.flatMap((finding) => finding.evidenceIds));
  assert.ok(evidence.has("audio-01"));
  assert.ok(evidence.has("frame-0003"));
  assert.equal(result.effectiveComparison.findings.some((finding) => finding.evidenceIds.some((id) => !report.evidence.some((item: any) => item.id === id))), false);
});

test("recovery records raw, unfenced, repaired-text, serialized and effective hashes separately", () => {
  const result = recoverComparison(raw, report, 4277);
  const delivered = readFileSync("out/observations/phase3-pilot/recovery/recovered-comparison.json");
  assert.equal(result.rawHash, "68c99df6b0657ab568e0faa3baa64029f21e230280600d0b8c15c911608cf98b");
  assert.equal(result.unfencedHash, "63956b085dc18bfc2347af2bfb10dbd61c1251b832848979d2ee7f3b7ee9e466");
  assert.equal(result.repairedTextHash, "bdb5ba5845d9124a41e63f3b1675f40b0107660e80461e75443c3e779dfbd7d3");
  assert.equal(result.serializedRecoveredJsonHash, "b54add18b72297bd794f061dab9be0ae17b95f294b2eb5ef7e21184e97700a3b");
  assert.equal(result.effectiveComparisonHash?.length, 64);
  assert.equal(createHash("sha256").update(delivered).digest("hex"), "e4b660e18ea6b322b7ef694c230fef34a97ac831d28814612fd6756dcca04f78");
  assert.notEqual(createHash("sha256").update(delivered).digest("hex"), result.serializedRecoveredJsonHash);
  assert.equal(result.semanticRepairCandidateCount, 6);
});
