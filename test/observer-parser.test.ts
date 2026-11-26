import { test } from "node:test";
import assert from "node:assert/strict";
import { QwenVisualObserver } from "../server/observer-inference.ts";
import type { App } from "../server/registry.ts";
import type { Runner } from "../server/runner.ts";
import type { ObservationReport } from "../server/production-types.ts";

const baseReport: Pick<ObservationReport, "visual" | "dialogue" | "technical" | "shots" | "evidence"> = {
  technical: {
    sourcePath: "x", sourceHash: "h", sourceVerified: true, fps: 24, duration: 4,
    sceneStartFrame: 0, sceneEndFrame: 96, sceneStartSeconds: 0, sceneEndSeconds: 4, audioStreams: [],
  },
  shots: [{ id: "shot-01", bindingId: "b1", segmentIndex: 0, startFrame: 0, endFrame: 96, startSeconds: 0, endSeconds: 4, detector: "native-segment", evidenceIds: ["frame-0001"] }],
  evidence: [
    { id: "frame-0001", kind: "opening_frame", file: "f.jpg", timestampSeconds: 0, frame: 0 },
    { id: "audio-01", kind: "audio", file: "a.wav", timestampSeconds: 0, frame: 0 },
  ],
  dialogue: {
    provider: "whisper-turbo", model: "large-v3-turbo", text: "i like the sound of that",
    utterances: [{ id: "u1", startSeconds: 0, endSeconds: 1, text: "i like the sound of that", speaker: { label: "Unknown", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"] }],
    limitations: [], evidenceIds: ["audio-01"],
  },
};

function observerFor(raw: unknown): QwenVisualObserver {
  const runner = {
    runTexts: async () => ({ outputs: [{ nodeId: "save", name: "observer.txt", text: JSON.stringify(raw) }] }),
  } as unknown as Runner;
  return new QwenVisualObserver(runner, {} as App);
}

test("comparison parser splits a visual/audio compound finding and does not confirm the sound", async () => {
  const observer = observerFor({
    findings: [{
      category: "event", expected: "A cartoon pop sound effect and a sweat drop", observed: "A sweat drop is visible on the temple.",
      classification: "confirmed", rationale: "The drop is visible.", evidence_ids: ["frame-0001"],
    }],
    proposed_changes: [],
    limitations: [],
  });
  const result = await observer.compare({
    intended: "One scene", canonicalOpening: "", observation: baseReport, coverage: "one frame",
  });
  assert.equal(result.comparison.findings.length, 2);
  assert.ok(result.comparison.findings.some((finding) => finding.classification === "not_observable" && finding.observed.includes("Not observable from visual evidence")));
});

test("comparison parser distinguishes exact and partial dialogue matches", async () => {
  const observer = observerFor({
    findings: [
      { category: "dialogue", expected: "S1: 'you're late'", observed: "ASR: 'you're late'", classification: "confirmed", rationale: "", evidence_ids: ["audio-01"] },
      { category: "dialogue", expected: "Mmm, I like the sound of that", observed: "ASR: 'i like the sound of that'", classification: "confirmed", rationale: "", evidence_ids: ["audio-01"] },
    ],
    proposed_changes: [],
    limitations: [],
  });
  const result = await observer.compare({
    intended: "One scene", canonicalOpening: "", observation: baseReport, coverage: "one audio clip",
  });
  assert.equal(result.comparison.findings[0]?.dialogueMatch, "exact");
  assert.equal(result.comparison.findings[1]?.dialogueMatch, "partial");
  assert.equal(result.comparison.findings[1]?.classification, "probable");
});

test("comparison parser rejects an unsupported proposed fact", async () => {
  const observer = observerFor({
    findings: [], proposed_changes: [
      { op: "add", category: "identity", text: "Akari has purple hair.", subject_ids: ["akari"], phase: "global" },
      { op: "add", category: "state", text: "A glass is on the bar.", subject_ids: ["akari"], phase: "opening", evidence_ids: ["frame-0001"] },
    ], limitations: [],
  });
  const result = await observer.compare({
    intended: "One scene", canonicalOpening: "", observation: baseReport, coverage: "one frame",
  });
  assert.equal(result.comparison.proposedChanges.length, 1);
  assert.equal(result.comparison.proposedChanges[0]?.category, "state");
});
