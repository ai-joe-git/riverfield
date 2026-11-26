import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = "out/observations/benchmark-20261126";
const rows = ["A1", "A2", "A3", "A4", "B1", "B2"];

test("the six-model Velvet Moon benchmark remains a complete regression fixture", { skip: !existsSync(`${root}/metrics.json`) }, () => {
  const metrics = JSON.parse(readFileSync(`${root}/metrics.json`, "utf8"));
  for (const row of rows) {
    const run = metrics[row];
    assert.ok(run, `${row} must exist`);
    assert.equal(run.imageKinds.evidence, 7);
    assert.equal(run.imageKinds.reference, 2);
    assert.equal(run.jobId.startsWith("obs-"), true);
    assert.equal(typeof run.observationId, "string");
  }
  assert.equal(metrics.B1.rawParse.comparison, false);
  assert.equal(existsSync(`${root}/runs/B1/comparison-raw.recovered.txt`), true);
  assert.ok(metrics.B2.rawCitationErrors.visual.includes("frame-0100"));
  assert.equal(metrics.A4.findings.withoutEvidence, 7);
  assert.equal(metrics.B2.findings.withoutEvidence, 10);
  assert.equal(existsSync("out/observations/packages/velvet-moon-first-observation.zip"), true);
  const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.observations["c756930b-e443-4aa0-baa7-fea855267758"].revision, 1);
  assert.equal(Object.keys(snapshot.proposals).length, 0);
  assert.equal(existsSync("out/observations/velvet-moon-multimodal-benchmark.zip"), true);
});
