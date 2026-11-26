import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnalysisImages } from "../server/evidence-images.ts";
import { QwenVisualObserver } from "../server/observer-inference.ts";
import { createObserverApp } from "../server/observer-app.ts";
import { DEFAULT_OBSERVER_MODEL } from "../server/observer-models.ts";
import type { Runner } from "../server/runner.ts";

function white(path: string) {
  execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=white:s=32x32", "-frames:v", "1", "-q:v", "2", path]);
}

test("analysis derivatives preserve originals and expose deterministic aliases", () => {
  const dir = mkdtempSync(join(tmpdir(), "riverfield-analysis-"));
  try {
    const frame = join(dir, "frame.jpg"); const ref = join(dir, "ref.png");
    white(frame); white(ref);
    const images = createAnalysisImages({
      frames: [{ id: "frame-0002", kind: "shot_frame", file: "frame.jpg", path: frame, hash: "original-frame-hash", timestampSeconds: 5.0833, frame: 122, shotId: "shot-02" }],
      references: [{ id: "suite404-official-akari-character-sheet", label: "Akari_Character_Sheet", path: ref, hash: "original-ref-hash" }],
      outputDir: join(dir, "analysis"),
    });
    assert.deepEqual(images.map((image) => image.alias), ["image-01", "image-02"]);
    assert.deepEqual(images.map((image) => image.evidenceId), ["frame-0002", "suite404-official-akari-character-sheet"]);
    assert.equal(images[0]?.originalHash, "original-frame-hash");
    assert.notEqual(images[0]?.derivativeHash, images[0]?.originalHash);
    assert.match(images[0]?.label ?? "", /frame-0002/);
    assert.match(images[0]?.label ?? "", /5\.083/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("model-facing alias citations resolve to immutable evidence ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "riverfield-alias-"));
  try {
    const frame = join(dir, "frame.jpg"); const ref = join(dir, "ref.png");
    white(frame); white(ref);
    const analysis = createAnalysisImages({
      frames: [{ id: "frame-0002", kind: "shot_frame", file: "frame.jpg", path: frame, hash: "original-frame-hash", timestampSeconds: 5.0833, frame: 122, shotId: "shot-02" }],
      references: [{ id: "suite404-official-akari-character-sheet", label: "Akari_Character_Sheet", path: ref, hash: "original-ref-hash" }],
      outputDir: join(dir, "analysis"),
    });
    let captured: Record<string, any> = {};
    const runner = {
      runTexts: async (_app: unknown, values: Record<string, any>) => {
        captured = values;
        return { outputs: [{ nodeId: "save", name: "observer.txt", text: JSON.stringify({
          characters: [{ description: "A woman.", identity_match: "matches", evidence_ids: ["image-01"] }],
          location: { description: "Bar.", evidence_ids: ["frame-0002"], confidence: "confirmed" },
          props: [], actions: [], composition: [], expressions: [], artifacts: [],
          uncertainties: [], limitations: [], claims: [],
        }) }] };
      },
    } as unknown as Runner;
    const observer = new QwenVisualObserver(runner, createObserverApp(DEFAULT_OBSERVER_MODEL), { maxImages: 9, maxReferenceImages: 1 });
    const result = await observer.observe({
      technical: { sourcePath: "x", sourceHash: "h", sourceVerified: true, fps: 24, duration: 1, frameCount: 24, audioStreams: [], sceneStartFrame: 0, sceneEndFrame: 24, sceneStartSeconds: 0, sceneEndSeconds: 1 },
      shots: [{ id: "shot-02", bindingId: "b1", segmentIndex: 0, startFrame: 0, endFrame: 24, startSeconds: 0, endSeconds: 1, detector: "native-segment", evidenceIds: ["frame-0002"] }],
      frames: [{ id: "frame-0002", kind: "shot_frame", file: "frame.jpg", path: frame, timestampSeconds: 5.0833, frame: 122, shotId: "shot-02" }],
      referenceFiles: [{ label: "reference:Akari", file: { bytes: new Uint8Array([1]), name: "ref.png", type: "image/png" } }],
      analysisImages: analysis,
    });
    assert.equal(result.visual.characters[0]?.evidenceIds[0], "frame-0002");
    assert.equal(result.images?.[0]?.id, "image-01");
    assert.equal(result.images?.[0]?.hash, analysis[0]?.derivativeHash);
    assert.equal(captured.frame1?.name, analysis[0]?.derivativePath.split("/").pop());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
