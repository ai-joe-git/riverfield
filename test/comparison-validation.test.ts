import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateComparisonPayload } from "../server/comparison-validation.ts";
import { QwenVisualObserver } from "../server/observer-inference.ts";
import { comparisonPrompt } from "../server/observer-prompts.ts";

const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
const report = snapshot.observations["f76bb88d-cbbc-4220-9fcc-9d64b2d4c66a"].report;
const raw = readFileSync("out/observations/runs/obs-20261127030536591-2b39ab5c/comparison-raw-recovered.txt", "utf8");
const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));

test("valid findings survive an invalid wardrobe proposal and the rejection keeps the original", () => {
  const result = validateComparisonPayload(parsed, report, {
    allowCanonicalProposals: false,
    comparisonPromptVersion: "test-build",
  });
  assert.equal(result.comparison.findings.length, 11);
  assert.equal(result.comparison.proposedChanges.length, 0);
  assert.equal(result.proposalRejections.length, 3);
  assert.equal(result.proposalRejections[0].code, "BUILD_MODE_PROPOSALS_DISABLED");
  assert.equal((result.proposalRejections[0].original as any).category, "wardrobe");
  assert.equal((result.proposalRejections[0].original as any).text, "Akari wears a red dress.");
  assert.equal(result.comparison.findings.filter((finding) => finding.category === "dialogue").every((finding) => finding.classification === "probable"), true);
});

test("Build-mode comparison prompt omits proposed_changes", () => {
  const build = comparisonPrompt({ intended: "x", canonicalOpening: "", observationJson: {}, coverage: "x", allowCanonicalProposals: false });
  const normal = comparisonPrompt({ intended: "x", canonicalOpening: "", observationJson: {}, coverage: "x", allowCanonicalProposals: true });
  assert.doesNotMatch(build, /"proposed_changes"\s*:/);
  assert.match(build, /findings only/i);
  assert.match(normal, /Propose memory changes/i);
});

test("raw output is handed to the caller immediately after inference and before schema validation", async () => {
  const captured: any[] = [];
  const runner = {
    async runTexts() {
      return { job: { id: "fake-job-1" }, outputs: [{ text: raw }] };
    },
  } as any;
  const observer = new QwenVisualObserver(runner, { id: "fake-app" } as any, {});
  const result = await observer.compare({
    intended: "scene",
    canonicalOpening: "",
    observation: {
      visual: report.visual, audiovisual: report.audiovisual, nativeEvidence: report.nativeEvidence,
      dialogue: report.dialogue, technical: report.technical, shots: report.shots, evidence: report.evidence,
    },
    coverage: "test",
    allowCanonicalProposals: false,
    onRawResponse: (meta) => captured.push(meta),
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].rawText, raw);
  assert.equal(captured[0].jobId, "fake-job-1");
  assert.match(captured[0].systemPrompt, /comparison analyst/i);
  assert.match(captured[0].inputPrompt, /INTENDED SCENE/);
  assert.equal(result.jobId, "fake-job-1");
  assert.equal(result.comparison.findings.length, 11);
  assert.equal(result.comparison.proposedChanges.length, 0);
  assert.equal(result.proposalRejections?.length, 3);
});
