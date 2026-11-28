import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../server/registry.ts";
import { applyInputs, resolveValues, type Settable, type Values } from "../server/runner.ts";
import { directorPromptMode, planDirectorSegments } from "../server/h3-plan.ts";
import { DirectorStore } from "../server/director-store.ts";
import { History } from "../server/history.ts";
import { renderMetadataFor, productionRequestFromPreview, renderProfileCapability } from "../server/render-profile.ts";
import {
  BUILD_MEGAPIXELS,
  productionValuesFromPreview,
  relayVSRPair,
  renderMetadata,
  resolveRenderProfile,
  switchRenderProfile,
  migrateRenderProfile,
  resolutionFor,
} from "../web/js/render-profile.js";

const { apps } = loadRegistry();
const byId = (id: string) => apps.find((a) => a.id === id)!;
const FLASH = "h3-studio-director-flash";
const flash = byId(FLASH);
const PIFLOW = "h3-piflow-director";
const piflow = byId(PIFLOW);
const TIMELINE = planDirectorSegments({ prompts: ["A quiet arrival by the window."], images: [0] }).segment_windows as string;
const IMAGE = { bytes: new Uint8Array([1, 2, 3]), name: "ref.png", type: "image/png" };

function creative(extra: Record<string, unknown> = {}) {
  return {
    render_profile: "build",
    segment_windows: TIMELINE,
    image1: IMAGE,
    global_prompt: "A quiet arrival by the window.",
    flex_mode: "ref2va",
    aspect: "16:9 (Widescreen)",
    steps: 8,
    seed: 4242,
    ...extra,
  };
}

function graph(app: typeof flash): Settable & { json: Record<string, any> } {
  const json = JSON.parse(JSON.stringify(app.graph));
  return {
    json,
    setInput(node: string, field: string, value: unknown) {
      if (!json[node]) throw new Error(`missing node ${node}`);
      json[node].inputs[field] = value;
    },
  };
}

const renderingKeys = [
  "render_profile", "megapixels", "upscale", "upscale_detail",
  "production_megapixels", "production_upscale", "production_upscale_detail",
];
function withoutRendering(values: Record<string, unknown>) {
  const copy = { ...values };
  for (const key of renderingKeys) delete copy[key];
  return copy;
}

test("the H3 directors advertise the profile contract; other H3 engines do not inherit it", () => {
  const capability = renderProfileCapability(flash)!;
  assert.equal(capability.build_megapixels, 0.1);
  assert.equal(capability.production_default_megapixels, 0.3);
  assert.equal(capability.generation.min, 0.1);
  assert.equal(capability.generation.max, 3.0);
  assert.deepEqual(capability.upscale?.options.map((o: any) => o.value), ["", "x2", "x4"]);
  assert.deepEqual(renderProfileCapability(piflow)?.upscale?.options.map((o: any) => o.value), ["", "x2", "x4"], "pi-H3 Director exposes RelayVSR");
  assert.deepEqual(renderProfileCapability(byId("pika-studio-director"))?.upscale?.options.map((o: any) => o.value), ["", "x2", "x4"], "Pika Director exposes RelayVSR");
  assert.deepEqual(renderProfileCapability(byId("studio-director"))?.upscale?.options.map((o: any) => o.value), ["", "x2", "x4"], "Studio Director exposes RelayVSR");
  assert.equal(renderProfileCapability(byId("studio-director"))?.production_default_megapixels, 0.3);
  assert.deepEqual(renderProfileCapability(byId("ltx-director"))?.upscale?.options.map((o: any) => o.value), ["", "x2", "x4"], "LTX Director exposes RelayVSR");
});

test("Build & Test forces 0.1 MP and disables upscale, without forgetting Production preferences", () => {
  const values = resolveValues(flash, creative({
    megapixels: 2.0,
    upscale: "x4",
    upscale_detail: 0.5,
    production_megapixels: 0.8,
    production_upscale: "x4",
    production_upscale_detail: 0.6,
  })) as Record<string, any>;
  assert.equal(values.megapixels, BUILD_MEGAPIXELS);
  assert.equal(values.upscale, "");
  assert.equal(values.production_megapixels, 0.8, "the remembered Production resolution survives");
  assert.equal(values.production_upscale, "x4", "the remembered Production upscale survives");
  assert.equal(values.production_upscale_detail, 0.6);
  assert.equal(values.seed, 4242);
  assert.equal(values.steps, 8);
  assert.equal(values.segment_windows, TIMELINE);

  const meta = renderMetadataFor(flash, values)!;
  assert.equal(meta.profile, "build");
  assert.equal(meta.resolved, true);
  assert.equal(meta.generation.width, 416);
  assert.equal(meta.generation.height, 256);
  assert.equal(meta.upscale, "off");
  assert.equal(meta.upscale_linear_factor, 1);
  assert.equal(meta.upscale_pixel_area_factor, 1);
  assert.equal(meta.output?.width, 416);
  assert.equal(meta.output?.height, 256);
});

test("Production defaults to 0.3 MP with RelayVSR x2", () => {
  const values = resolveValues(flash, creative({ render_profile: "production" })) as Record<string, any>;
  assert.equal(values.megapixels, 0.3);
  assert.equal(values.upscale, "x2");
  const meta = renderMetadataFor(flash, values)!;
  assert.equal(meta.profile, "production");
  assert.equal(meta.generation.requested_megapixels, 0.3);
  assert.equal(meta.generation.width, 736);
  assert.equal(meta.generation.height, 416);
  assert.equal(meta.upscale, "x2");
  assert.equal(meta.output?.width, 1472);
  assert.equal(meta.output?.height, 832);
});

test("Production resolution is adjustable and X2/X4 use the right linear and area factors", () => {
  for (const [upscale, linear, area] of [["x2", 2, 4], ["x4", 4, 16]] as const) {
    const values = resolveValues(flash, creative({
      render_profile: "production",
      production_megapixels: 0.8,
      production_upscale: upscale,
      production_upscale_detail: 0.55,
    })) as Record<string, any>;
    assert.equal(values.megapixels, 0.8);
    assert.equal(values.upscale, upscale);
    assert.equal(values.upscale_detail, 0.55);
    const meta = renderMetadataFor(flash, values)!;
    assert.equal(meta.generation.width, 1216);
    assert.equal(meta.generation.height, 672);
    assert.equal(meta.output?.width, 1216 * linear);
    assert.equal(meta.output?.height, 672 * linear);
    assert.equal(meta.upscale_linear_factor, linear);
    assert.equal(meta.upscale_pixel_area_factor, area);
    assert.match(String(meta.upscale), new RegExp(upscale));
  }
  assert.throws(() => resolveValues(flash, creative({ render_profile: "production", production_megapixels: 4.0 })), /between 0.1 and 3/);
});

test("FL2VA director mode keeps the same Production recipe and auto-selects for an empty bin", () => {
  const empty = resolveValues(flash, {
    render_profile: "production",
    flex_mode: "auto",
    global_prompt: "A quiet room with no references.",
  }) as Record<string, any>;
  assert.equal(empty.flex_mode, "fl2va", "empty bin -> FL2VA");
  assert.equal(empty.steps, 8);
  assert.equal(empty.detail, 0.8);
  assert.equal(empty.clip_name, "p-h3-image_text_encoder_int8_convrot.safetensors");
  assert.equal(empty.megapixels, 0.3);
  assert.equal(empty.upscale, "x2");
  assert.equal(empty.prompt_enhancer, true);
  assert.equal(empty.enhancer_model, "qwen3.8_27b_uncensored_heretic_w4a8_convrot_v2.safetensors");
  const referenced = resolveValues(flash, { render_profile: "production", flex_mode: "auto", image1: IMAGE, global_prompt: "A referenced room." }) as Record<string, any>;
  assert.equal(referenced.flex_mode, "ref2va", "a picture keeps the reference mode");

  const pika = byId("pika-studio-director");
  const pikaText = "integrated_multimodal_description:\n[Shot 1] An empty studio.\noverall_soundscape:\nRoom tone.\nnon_diegetic_music:\nN/A";
  const pikaEmpty = resolveValues(pika, { render_profile: "production", flex_mode: "auto", global_prompt: pikaText }) as Record<string, any>;
  assert.equal(pikaEmpty.flex_mode, "fl2va", "Pika empty bin -> FL2VA");
  assert.equal(pikaEmpty.detail, 0.8);
  assert.equal(pikaEmpty.clip_name, "p-h3-image_text_encoder_int8_convrot.safetensors");
  assert.equal(pikaEmpty.production_megapixels, 0.3);
  assert.equal(pikaEmpty.upscale, "x2");
  assert.equal(pikaEmpty.prompt_enhancer, true);
  assert.equal(pikaEmpty.enhancer_model, "qwen3.8_27b_uncensored_heretic_w4a8_convrot_v2.safetensors");
});

test("auto flex mode resolves the writer guide from the actual material", () => {
  assert.equal(directorPromptMode({ flexMode: "auto", hasVisual: true }), "ref2va");
  assert.equal(directorPromptMode({ flexMode: "auto", hasVisual: false }), "t2va");
  assert.equal(directorPromptMode({ flexMode: "fl2va", hasVisual: true }), "t2va", "explicit FL2VA keeps its text-to-video writer");
  assert.equal(directorPromptMode({ flexMode: undefined, hasVisual: true }), "ref2va");
  assert.equal(directorPromptMode({ flexMode: "auto", hasVisual: true, ltx: true }), "t2v");
});

test("a Production request cannot force RelayVSR onto an app that has no upscale input", () => {
  const studio = byId("studio-director");
  const noUpscale = { ...studio, inputs: studio.inputs.filter((i) => !["upscale", "upscale_detail", "production_upscale", "production_upscale_detail"].includes(i.id)) };
  assert.throws(
    () => resolveValues(noUpscale, { render_profile: "production", production_megapixels: 0.4, production_upscale: "x2", global_prompt: "x", image1: IMAGE, segment_windows: TIMELINE }),
    /no RelayVSR upscale option/,
  );
  const values = resolveValues(noUpscale, { render_profile: "production", production_megapixels: 0.4, global_prompt: "x", image1: IMAGE, segment_windows: TIMELINE }) as Record<string, any>;
  assert.equal(values.megapixels, 0.4, "compatible H3 directors get the shared production default");
});

test("switching profiles preserves the timeline, prompts, references and seed, and remembers Production", () => {
  const original = creative({
    render_profile: "production",
    production_megapixels: 0.8,
    production_upscale: "x4",
    production_upscale_detail: 0.6,
    megapixels: 0.8,
    upscale: "x4",
    upscale_detail: 0.6,
  }) as Record<string, any>;
  const before = JSON.stringify(original);
  const toBuild = switchRenderProfile(flash, original, "build");
  assert.deepEqual(toBuild.errors, []);
  assert.equal(toBuild.values.render_profile, "build");
  assert.equal(toBuild.values.megapixels, 0.1);
  assert.equal(toBuild.values.upscale, "");
  assert.equal(toBuild.values.production_megapixels, 0.8);
  assert.equal(toBuild.values.production_upscale, "x4");
  assert.equal(toBuild.values.production_upscale_detail, 0.6);
  for (const key of ["segment_windows", "global_prompt", "seed", "steps", "image1", "aspect", "flex_mode"]) {
    assert.deepEqual(toBuild.values[key], original[key], `${key} must survive the switch`);
  }
  assert.equal(JSON.stringify(original), before, "the switch is a pure copy");

  const back = switchRenderProfile(flash, toBuild.values, "production");
  assert.equal(back.values.megapixels, 0.8);
  assert.equal(back.values.upscale, "x4");
  assert.equal(back.values.upscale_detail, 0.6);
  assert.equal(back.values.seed, 4242);
  assert.equal(back.values.segment_windows, TIMELINE);
  assert.deepEqual(JSON.parse(String(back.values.segment_windows)), JSON.parse(TIMELINE), "native segment geometry is untouched");
});

test("a new session defaults to Build & Test; an unprofiled legacy project keeps its resolution", () => {
  const fresh = migrateRenderProfile(flash, { megapixels: 1.0, upscale: "x2", segment_windows: TIMELINE }, { fresh: true });
  assert.equal(fresh.values.render_profile, "build");
  assert.equal(fresh.values.megapixels, 0.1);
  assert.equal(fresh.values.upscale, "");

  const legacy = {
    megapixels: 1.0,
    upscale: "x4",
    upscale_detail: 0.75,
    segment_windows: TIMELINE,
    global_prompt: "Keep this exact prompt",
    seed: 77,
  };
  const migrated = migrateRenderProfile(flash, legacy, { fresh: false });
  assert.equal(migrated.values.render_profile, "production");
  assert.equal(migrated.values.production_megapixels, 1.0);
  assert.equal(migrated.values.production_upscale, "x4");
  assert.equal(migrated.values.megapixels, 1.0);
  assert.equal(migrated.values.upscale, "x4");
  assert.equal(migrated.values.segment_windows, TIMELINE);
  assert.equal(migrated.values.seed, 77);
});

test("an app without a declared profile keeps the legacy manifest meaning", () => {
  const legacyApp = { ...flash, inputs: flash.inputs.map((input) => input.id === "render_profile" ? { ...input, default: undefined } : input) };
  const values = resolveValues(legacyApp, {
    segment_windows: TIMELINE,
    image1: IMAGE,
    global_prompt: "x",
    megapixels: 1.0,
    upscale: "x4",
    seed: 5,
  }) as Record<string, any>;
  assert.equal(values.megapixels, 1.0);
  assert.equal(values.upscale, "x4");
  const meta = renderMetadataFor(flash, values)!;
  assert.equal(meta.profile, "legacy");
  assert.equal(meta.resolved, false);
  assert.equal(meta.upscale, "x4");
  assert.equal(meta.upscale_linear_factor, 4);
  assert.equal(meta.upscale_pixel_area_factor, 16);
});

test("preview -> production copies the exact creative payload and only replaces rendering parameters", () => {
  const preview = resolveValues(flash, creative({ seed: 99 })) as Record<string, any>;
  const production = productionValuesFromPreview(flash, preview, { production_megapixels: 0.8, production_upscale: "x2", production_upscale_detail: 0.4 });
  assert.deepEqual(production.errors, []);
  const values = production.values as Record<string, any>;
  assert.equal(values.seed, 99, "the preview seed is preserved");
  assert.equal(values.segment_windows, preview.segment_windows, "timeline bytes are preserved");
  assert.deepEqual(withoutRendering(values), withoutRendering(preview), "only rendering parameters changed");
  assert.equal(values.render_profile, "production");
  assert.equal(values.megapixels, 0.8);
  assert.equal(values.upscale, "x2");
  assert.equal(values.upscale_detail, 0.4);
  assert.deepEqual(JSON.parse(String(values.segment_windows)), JSON.parse(TIMELINE));
});

test("RelayVSR x2/x4 use the matching DIT and Flash VAE; a mismatched manifest is rejected", () => {
  assert.deepEqual(relayVSRPair(flash, "x2"), {
    factor: "x2",
    unet: "relayvsr_x2_lightx2v_int8_convrot.safetensors",
    vae: "relayvsr_flash_vae_x2_fp32.safetensors",
  });
  assert.deepEqual(relayVSRPair(piflow, "x2"), {
    factor: "x2",
    unet: "relayvsr_x2_lightx2v_int8_convrot.safetensors",
    vae: "relayvsr_flash_vae_x2_fp32.safetensors",
  });
  assert.deepEqual(relayVSRPair(flash, "x4"), {
    factor: "x4",
    unet: "relayvsr_x4_int8_convrot.safetensors",
    vae: "relayvsr_flash_vae_x4_fp32.safetensors",
  });
  const broken = {
    ...flash,
    inputs: flash.inputs.map((input) => input.id !== "upscale" ? input : {
      ...input,
      options: input.options?.map((option) => option.value !== "x2" ? option : {
        ...option,
        sets: option.sets?.map((set) => set.field === "vae_name" ? { ...set, value: "relayvsr_flash_vae_x4_fp32.safetensors" } : set),
      }),
    }),
  };
  assert.equal(relayVSRPair(broken, "x2"), null);
  const result = resolveRenderProfile(broken, { render_profile: "production", production_megapixels: 0.4, production_upscale: "x2" });
  assert.equal(result.errors[0]?.code, "RELAY_MODEL_PAIR");
});

test("the existing workflow is reused: Build & Test bypasses RelayVSR, Production wires the paired chain", () => {
  const buildValues = resolveValues(flash, creative({ megapixels: 1.0, upscale: "x4" }));
  const buildGraph = graph(flash);
  applyInputs(flash, buildValues, buildGraph, () => null);
  assert.equal(buildGraph.json.vsr_switch, undefined, "the RelayVSR switch and its chain are pruned");
  assert.equal(buildGraph.json["29"].inputs.video[0], "30", "SaveVideo reads the native sampler output");
  assert.equal(buildGraph.json.vsr_unet, undefined);
  assert.equal(buildGraph.json.vsr_vae, undefined);

  for (const [upscale, unet, vae] of [
    ["x2", "relayvsr_x2_lightx2v_int8_convrot.safetensors", "relayvsr_flash_vae_x2_fp32.safetensors"],
    ["x4", "relayvsr_x4_int8_convrot.safetensors", "relayvsr_flash_vae_x4_fp32.safetensors"],
  ] as const) {
    const productionValues = resolveValues(flash, creative({
      render_profile: "production",
      production_megapixels: 0.4,
      production_upscale: upscale,
    }));
    const productionGraph = graph(flash);
    applyInputs(flash, productionValues, productionGraph, () => null);
    assert.equal(productionGraph.json.vsr_switch.inputs.switch, true);
    assert.equal(productionGraph.json.vsr_unet.inputs.unet_name, unet);
    assert.equal(productionGraph.json.vsr_vae.inputs.vae_name, vae);
    assert.equal(productionGraph.json["29"].inputs.video[0], "vsr_switch", "SaveVideo keeps the native video chain as its fallback");
    assert.deepEqual(productionGraph.json.vsr_video.inputs.audio, ["vsr_components", 1], "audio tracks are carried through the upscale");
    assert.deepEqual(productionGraph.json.vsr_video.inputs.fps, ["vsr_components", 2], "frame rate is carried through the upscale");
  }
});

test("the Director store keeps profile choices and production preferences durably", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-render-profile-store-"));
  try {
    const store = new DirectorStore(dir, new Map(apps.map((a) => [a.id, a])));
    store.saveValues(FLASH, {
      render_profile: "production",
      production_megapixels: 0.8,
      production_upscale: "x2",
      production_upscale_detail: 0.55,
      segment_windows: TIMELINE,
      global_prompt: "Keep this",
      seed: 11,
    }, 1234);
    const reopened = new DirectorStore(dir, new Map(apps.map((a) => [a.id, a]))).view(FLASH)!;
    assert.equal(reopened.values.render_profile, "production");
    assert.equal(reopened.values.production_megapixels, 0.8);
    assert.equal(reopened.values.production_upscale, "x2");
    assert.equal(reopened.values.production_upscale_detail, 0.55);
    assert.equal(reopened.values.segment_windows, TIMELINE);
    assert.equal(reopened.values.seed, 11);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("history records resolved render metadata and links the production job to its preview", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-render-profile-history-"));
  try {
    const history = new History(dir);
    const previewValues = resolveValues(flash, creative({ seed: 31 })) as Values;
    const preview = history.start(flash, previewValues, undefined, undefined, undefined, {
      render: renderMetadataFor(flash, previewValues)!,
      lineage: { relation: "preview" },
    });
    const production = productionRequestFromPreview(flash, previewValues, { production_megapixels: 0.4, production_upscale: "x2" });
    const productionValues = resolveValues(flash, production.values) as Values;
    const produced = history.start(flash, productionValues, undefined, undefined, undefined, {
      render: renderMetadataFor(flash, productionValues)!,
      lineage: { relation: "new_generation_from_preview", preview: preview.id },
    });
    assert.equal(history.linkProduction(preview.id, produced.id), true);

    const previewView = history.get(preview.id)!;
    const productionView = history.get(produced.id)!;
    assert.equal(previewView.render?.profile, "build");
    assert.equal(productionView.render?.profile, "production");
    assert.equal((productionView.render?.generation as any)?.requested_megapixels, 0.4);
    assert.equal(productionView.render?.upscale, "x2");
    assert.equal(productionView.render?.upscale_linear_factor, 2);
    assert.equal(productionView.render?.upscale_pixel_area_factor, 4);
    assert.deepEqual(previewView.lineage?.productions, [produced.id]);
    assert.equal(productionView.lineage?.preview, preview.id);
    assert.equal(productionView.lineage?.relation, "new_generation_from_preview");
    assert.equal(productionView.values.seed, 31, "the preview seed is preserved in the production job");
    assert.equal(productionView.values.segment_windows, previewView.values.segment_windows);
    assert.equal(history.list(FLASH).length, 2, "both outputs stay in the history");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("UI and server resolve the same execution parameters from the same profile", () => {
  const base = creative({ render_profile: "production", production_megapixels: 0.8, production_upscale: "x2", production_upscale_detail: 0.45 }) as Record<string, any>;
  const ui = switchRenderProfile(flash, base, "production");
  const server = resolveValues(flash, { ...base, ...ui.values }) as Record<string, any>;
  for (const key of ["megapixels", "upscale", "upscale_detail", "production_megapixels", "production_upscale", "production_upscale_detail"]) {
    assert.deepEqual(server[key], ui.values[key], `${key} must match between UI and server`);
  }
  assert.deepEqual(renderMetadataFor(flash, server), renderMetadata(flash, ui.values));
});

test("the Director profile controls never submit a generation", () => {
  const source = readFileSync(join(process.cwd(), "web/js/director.js"), "utf8");
  const chooser = /function chooseRenderProfile[\s\S]*?\n  \}/.exec(source)?.[0] ?? "";
  assert.ok(chooser, "chooseRenderProfile must exist");
  assert.match(chooser, /saveDirty\(\)/);
  assert.match(chooser, /draw\(\)/);
  assert.doesNotMatch(chooser, /onSubmit/, "switching profiles must not launch inference");
  const strip = /function drawRenderProfile[\s\S]*?\n  \}/.exec(source)?.[0] ?? "";
  assert.ok(strip, "drawRenderProfile must exist");
  assert.doesNotMatch(strip, /onSubmit/, "the profile strip must not launch inference");
});

test("the resolution geometry matches ComfyUI's ResolutionSelector", () => {
  assert.deepEqual(resolutionFor("16:9 (Widescreen)", 0.1, 32), { width: 416, height: 256, megapixels: 0.1015625 });
  assert.deepEqual(resolutionFor("16:9 (Widescreen)", 0.4, 32), { width: 864, height: 480, megapixels: 0.3955078125 });
  assert.deepEqual(resolutionFor("9:16 (Portrait Widescreen)", 0.4, 32), { width: 480, height: 864, megapixels: 0.3955078125 });
  assert.equal(resolutionFor("nonsense", 0.4, 32), null);
});
