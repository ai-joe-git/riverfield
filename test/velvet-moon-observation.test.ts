import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const packageDir = "out/observations/packages/velvet-moon-first-observation";

test("the preserved Velvet Moon package is a valid Phase 1 regression fixture", { skip: !existsSync(`${packageDir}/validation.json`) }, () => {
  const validation = JSON.parse(readFileSync(`${packageDir}/validation.json`, "utf8"));
  assert.equal(validation.extractedFrames, 15, "the original fixture remains the 15-frame extraction");
  assert.equal(validation.visualFramesSupplied, 7);
  assert.equal(validation.referencesSupplied, 2);
  assert.equal(validation.totalImagesSupplied, 9);
  assert.equal(validation.detectedShots, 5);
  assert.equal(validation.allShotsCovered, true);
  assert.deepEqual(validation.invalidVisualEvidenceIds, []);
  assert.deepEqual(validation.invalidComparisonEvidenceIds, []);
  assert.deepEqual(validation.unsupportedRawFindings, []);
  assert.equal(validation.canonicalRevision, 0);

  const validated = JSON.parse(readFileSync(`${packageDir}/structured-report.validated.json`, "utf8"));
  const dialogue = validated.comparison.findings.filter((finding: { category: string }) => finding.category === "dialogue");
  assert.equal(dialogue.length, 3);
  assert.ok(dialogue.every((finding: { evidenceIds: string[] }) => finding.evidenceIds.includes("audio-01")));
  assert.equal(validated.validation.findingCorrections.length, 3);

  const review = readFileSync(`${packageDir}/REVIEW.md`, "utf8");
  assert.match(review, /7 evidence frames \+ 2 reference images = 9 images/);
  assert.match(review, /The remaining 8 extracted frames were \*\*not supplied\*\*/);
});
