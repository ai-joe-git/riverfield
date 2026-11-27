import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
