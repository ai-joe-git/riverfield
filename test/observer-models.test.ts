import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertObserverModalities, discoverObserverModels, observerModel } from "../server/observer-models.ts";

function safetensorsHeader(file: string, tensors: string[], metadata: Record<string, string> = {}) {
  const header = Buffer.from(JSON.stringify({
    __metadata__: metadata,
    ...Object.fromEntries(tensors.map((key) => [key, { dtype: "F16", shape: [1], data_offsets: [0, 2] }])),
  }));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.byteLength), 0);
  writeFileSync(file, Buffer.concat([prefix, header]));
}

test("observer discovery reads actual safetensors modality tensors", () => {
  const dir = mkdtempSync(join(tmpdir(), "riverfield-observer-models-"));
  const previous = process.env.RIVERFIELD_TEXT_ENCODERS_DIR;
  process.env.RIVERFIELD_TEXT_ENCODERS_DIR = dir;
  try {
    safetensorsHeader(join(dir, "gemma4_12b_it_uncensored_heretic_w4a8.safetensors"), [
      "model.layers.0.self_attn.q_proj.weight", "vision_model.patch_dense.weight", "audio_projector.embedding_projection.weight",
    ], { model_type: "gemma4_unified", model_variant: "Gemma 4 12B" });
    safetensorsHeader(join(dir, "qwen3.5_9b_uncensored_w4a8.safetensors"), [
      "model.language_model.layers.0.input_layernorm.weight", "model.visual.merger.linear_fc2.weight",
    ]);
    const models = discoverObserverModels();
    const gemma = models.find((model) => model.id === "gemma4-12b-heretic-w4a8")!;
    const qwen = models.find((model) => model.id === "qwen3.5-9b-uncensored-w4a8")!;
    const absent = models.find((model) => model.id === "gemma4-e2b-int8-convrot")!;
    assert.equal(gemma.installed, true);
    assert.deepEqual(gemma.modalities, { text: true, image: true, video: true, audio: true });
    assert.equal(gemma.quantization, "w4a8");
    assert.equal(gemma.capabilityEvidence.visionTensors, true);
    assert.equal(gemma.capabilityEvidence.audioTensors, true);
    assert.equal(qwen.installed, true);
    assert.deepEqual(qwen.modalities, { text: true, image: true, video: true, audio: false });
    assert.equal(absent.installed, false);
    assert.equal(observerModel("qwen3.5-9b-uncensored-w4a8").file, "qwen3.5_9b_uncensored_w4a8.safetensors");
    assert.throws(() => assertObserverModalities(qwen, { audio: true }), /does not expose native audio/);
    assert.doesNotThrow(() => assertObserverModalities(gemma, { video: true, audio: true }));
  } finally {
    if (previous === undefined) delete process.env.RIVERFIELD_TEXT_ENCODERS_DIR;
    else process.env.RIVERFIELD_TEXT_ENCODERS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
