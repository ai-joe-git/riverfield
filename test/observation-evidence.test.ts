import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractObservationEvidence } from "../server/observation-evidence.ts";
import { productionMediaRoots } from "../server/production-media.ts";
import type { Candidate, SceneRenderBinding } from "../server/production-types.ts";

const snapshot = "out/productions/suite-404/snapshot.json";
const candidateId = "suite404-20261126-144117031-d4dc";
const sceneId = "suite-404-s01e02-sc01";

test("Velvet Moon evidence extraction is capped at maxFrames and still covers every shot", { skip: !existsSync(snapshot) }, () => {
  const out = "out";
  const snap = JSON.parse(readFileSync(snapshot, "utf8"));
  const candidate = snap.candidates[candidateId];
  const bindings = (snap.bindings[candidateId] ?? []).filter((binding: { sceneId: string }) => binding.sceneId === sceneId);
  const input = {
    outDir: out, mediaRoots: productionMediaRoots(out), productionId: snap.production.id,
    sceneId, candidate, bindings, outputPath: candidate.outputs[0].path, outputHash: candidate.outputs[0].hash,
    config: { maxFrames: 12, visualFrames: 7, sampleIntervalSeconds: 2, sceneThreshold: 0.3, includeAudio: true },
  };
  const bundle = extractObservationEvidence(input);
  assert.equal(bundle.frames.length, 12, "maxFrames is a hard total cap");
  assert.equal(bundle.shots.length, 5);
  assert.equal(new Set(bundle.shots.map((shot) => shot.id)).size, 5);
  const visual = bundle.visualFrameIds.map((id) => bundle.frames.find((frame) => frame.id === id)!).filter(Boolean);
  assert.equal(visual.length, 7);
  const times = visual.map((frame) => frame.timestampSeconds ?? 0);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "visual frames are supplied chronologically");
  assert.deepEqual([...new Set(visual.map((frame) => frame.shotId))].sort(), bundle.shots.map((shot) => shot.id).sort());
  assert.ok(visual.some((frame) => frame.kind === "opening_frame"), "first shot opening is supplied");
  assert.ok(visual.some((frame) => frame.kind === "closing_frame" && frame.shotId === bundle.shots.at(-1)?.id), "last shot closing is supplied");
  assert.equal(bundle.technical.sceneEndFrame, 362, "binding end is exclusive and equals the actual frame count");
  assert.equal(bundle.nativeBoundaries[0]?.endFrame, 362);
  const tight = extractObservationEvidence({ ...input, config: { ...input.config, visualFrames: bundle.shots.length } });
  const tightShots = new Set(tight.visualFrameIds.map(id => tight.frames.find(frame => frame.id === id)?.shotId));
  assert.deepEqual([...tightShots], bundle.shots.map(shot => shot.id), "cover each shot when the number of slots equals the shot count");
});

test("implicit evidence budget covers long scenes and explicit limits remain strict", () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-evidence-budget-"));
  try {
    const dir = join(out, "media");
    mkdirSync(dir);
    const outputPath = join(dir, "candidate.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=16x16:r=24:d=15",
      "-c:v", "libx264", "-threads", "1", outputPath]);
    const bindings: SceneRenderBinding[] = Array.from({ length: 15 }, (_, segmentIndex) => ({
      id: `binding-${segmentIndex}`, sceneId: "scene", candidateId: "candidate", timebase: "final-output", segmentIndex,
      timelineStartFrame: segmentIndex * 24, timelineEndFrame: (segmentIndex + 1) * 24, fps: 24,
    }));
    const candidate: Candidate = {
      id: "candidate", productionId: "production", label: "Candidate", source: "manual", bindings, contentHash: "fixture",
      createdAt: "2026-11-28T00:00:00Z", createdBy: "test", outputs: [{ type: "video", file: "candidate.mp4", name: "candidate.mp4", path: outputPath }],
    };
    const input = { outDir: out, mediaRoots: [dir], productionId: "production", sceneId: "scene", candidate, bindings, outputPath };
    const evidence = extractObservationEvidence(input);
    assert.equal(evidence.shots.length, 15);
    assert.equal(evidence.config.maxFrames, 17);
    assert.equal(evidence.frames.length, 17);
    assert.equal(extractObservationEvidence(input).config.maxFrames, 17);
    assert.throws(() => extractObservationEvidence({ ...input, config: { maxFrames: 12 } }), /cannot cover 15 detected shots/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
