import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObserverApp } from "../server/observer-app.ts";
import { DEFAULT_OBSERVER_MODEL } from "../server/observer-models.ts";
import { QwenVisualObserver } from "../server/observer-inference.ts";
import type { Runner } from "../server/runner.ts";

test("the observer app binds model, CLIPLoader recipe, sampling budget and native media to the real graph", () => {
  const app = createObserverApp({ ...DEFAULT_OBSERVER_MODEL, file: "gemma4_e2b_it_int8_convrot.safetensors", label: "Gemma 4 E2B", clipType: "stable_diffusion" });
  const byId = new Map(app.inputs.map((input) => [input.id, input]));
  assert.deepEqual(byId.get("observer_model")?.bind?.[0], { node: "clip", field: "clip_name" });
  assert.deepEqual(byId.get("observer_clip_type")?.bind?.[0], { node: "clip", field: "type" });
  assert.deepEqual(byId.get("temperature")?.bind?.[0], { node: "gen", field: "sampling_mode.temperature" });
  assert.deepEqual(byId.get("max_output_tokens")?.bind?.[0], { node: "gen", field: "max_length" });
  assert.deepEqual(byId.get("video1")?.bind?.[0], { node: "video", field: "file" });
  assert.deepEqual(byId.get("video1")?.unlink?.[0], { node: "gen", field: "videos.video1" });
  assert.deepEqual(byId.get("audio1")?.bind?.[0], { node: "audio", field: "audio" });
  assert.deepEqual(byId.get("audio1")?.unlink?.[0], { node: "gen", field: "audios.audio1" });
  assert.equal(app.models[0]?.file, "gemma4_e2b_it_int8_convrot.safetensors");
  assert.equal((app.graph?.gen?.inputs["videos.video1"] as unknown[] | undefined)?.[0], "video_frames");
  assert.equal((app.graph?.gen?.inputs["audios.audio1"] as unknown[] | undefined)?.[0], "audio");
});

test("observer backend sends selected model, sampling values and native media to the workflow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "riverfield-observer-app-"));
  try {
    const image = join(dir, "frame.jpg");
    writeFileSync(image, "image");
    let captured: Record<string, unknown> = {};
    const runner = {
      runTexts: async (_app: unknown, values: Record<string, unknown>) => {
        captured = values;
        return { outputs: [{ nodeId: "save", name: "observer.txt", text: JSON.stringify({ limitations: [], uncertainties: [], characters: [] }) }] };
      },
    } as unknown as Runner;
    const observer = new QwenVisualObserver(runner, createObserverApp(DEFAULT_OBSERVER_MODEL), {
      model: "qwen3.5_9b_uncensored_w4a8.safetensors", clipType: "stable_diffusion",
      maxOutputTokens: 2048, temperature: 0.4, topK: 12, topP: 0.5, seed: 7, thinking: true,
    });
    const result = await observer.observe({
      technical: {
        sourcePath: "x", sourceHash: "h", sourceVerified: true, fps: 24, duration: 1,
        frameCount: 24, audioStreams: [], sceneStartFrame: 0, sceneEndFrame: 24, sceneStartSeconds: 0, sceneEndSeconds: 1,
      },
      shots: [{ id: "shot-01", bindingId: "b1", segmentIndex: 0, startFrame: 0, endFrame: 24, startSeconds: 0, endSeconds: 1, detector: "native-segment", evidenceIds: ["frame-0001"] }],
      frames: [{ id: "frame-0001", kind: "opening_frame", file: "frame.jpg", path: image, timestampSeconds: 0, frame: 0 }],
      video: { bytes: new Uint8Array([1]), name: "scene.mp4", type: "video/mp4" },
      audio: { bytes: new Uint8Array([2]), name: "scene.wav", type: "audio/wav" },
    });
    assert.equal(captured.observer_model, "qwen3.5_9b_uncensored_w4a8.safetensors");
    assert.equal(captured.observer_clip_type, "stable_diffusion");
    assert.equal(captured.max_output_tokens, 2048);
    assert.equal(captured.temperature, 0.4);
    assert.equal(captured.top_k, 12);
    assert.equal(captured.top_p, 0.5);
    assert.equal(captured.seed, 7);
    assert.equal(captured.thinking, true);
    assert.equal((captured.video1 as { name?: string }).name, "scene.mp4");
    assert.equal((captured.audio1 as { name?: string }).name, "scene.wav");
    assert.equal(result.configuration.maxLength, 2048);
    assert.deepEqual(result.inputModalities, { text: true, image: true, video: true, audio: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
