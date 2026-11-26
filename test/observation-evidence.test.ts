import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractObservationEvidence } from "../server/observation-evidence.ts";
import { productionMediaRoots } from "../server/production-media.ts";

const snapshot = "out/productions/suite-404/snapshot.json";
const candidateId = "suite404-20261126-144117031-d4dc";
const sceneId = "suite-404-s01e02-sc01";

test("Velvet Moon evidence extraction is capped at maxFrames and still covers every shot", { skip: !existsSync(snapshot) }, () => {
  const out = "out";
  const snap = JSON.parse(readFileSync(snapshot, "utf8"));
  const candidate = snap.candidates[candidateId];
  const bindings = (snap.bindings[candidateId] ?? []).filter((binding: { sceneId: string }) => binding.sceneId === sceneId);
  const bundle = extractObservationEvidence({
    outDir: out, mediaRoots: productionMediaRoots(out), productionId: snap.production.id,
    sceneId, candidate, bindings, outputPath: candidate.outputs[0].path, outputHash: candidate.outputs[0].hash,
    config: { maxFrames: 12, visualFrames: 7, sampleIntervalSeconds: 2, sceneThreshold: 0.3, includeAudio: true },
  });
  assert.equal(bundle.frames.length, 12, "maxFrames is a hard total cap");
  assert.equal(bundle.shots.length, 5);
  assert.equal(new Set(bundle.shots.map((shot) => shot.id)).size, 5);
  const visual = bundle.frames.filter((frame) => bundle.visualFrameIds.includes(frame.id));
  assert.equal(visual.length, 7);
  assert.deepEqual([...new Set(visual.map((frame) => frame.shotId))].sort(), bundle.shots.map((shot) => shot.id).sort());
  assert.ok(visual.some((frame) => frame.kind === "opening_frame"), "first shot opening is supplied");
  assert.ok(visual.some((frame) => frame.kind === "closing_frame" && frame.shotId === bundle.shots.at(-1)?.id), "last shot closing is supplied");
  assert.equal(bundle.technical.sceneEndFrame, 362, "binding end is exclusive and equals the actual frame count");
  assert.equal(bundle.nativeBoundaries[0]?.endFrame, 362);
});
