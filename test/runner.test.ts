import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../server/registry.ts";
import { applyInputs, explainSubmitError, InputError, renderTemplate, resolveValues, Runner, type Settable } from "../server/runner.ts";

const { apps } = loadRegistry();
const byId = (id: string) => apps.find((a) => a.id === id)!;

function recorder(): Settable & { sets: Record<string, unknown> } {
  const sets: Record<string, unknown> = {};
  return { sets, setInput: (node: string, field: string, value: unknown) => (sets[`${node}.${field}`] = value) };
}

test("defaults fill in and a -1 seed becomes a real seed", () => {
  const values = resolveValues(byId("z-image"), { prompt: "a cat" });
  assert.equal(values.prompt, "a cat");
  assert.equal(values.steps, 8);
  assert.equal(typeof values.seed, "number");
  assert.ok((values.seed as number) >= 0);
});

test("numbers are coerced and range-checked", () => {
  const app = byId("z-image");
  assert.equal(resolveValues(app, { prompt: "x", steps: "12" }).steps, 12);
  assert.throws(() => resolveValues(app, { prompt: "x", steps: 99 }), InputError);
});

test("an empty select option is a choice, not a request for the default", () => {
  const app = byId("ai-influencer");
  const values = resolveValues(app, { feature: "", hair: "" , seed: 1 });
  assert.equal(values.hair, "", "Any stays Any even though the default is long curly hair");
  assert.deepEqual(values.feature, [], "and a multiple select left empty stays empty instead of taking its default, Freckles");
  const wf = recorder();
  applyInputs(app, values, wf, () => null);
  const text = wf.sets["18:17.value"] as string;
  assert.ok(!/Freckles|curly/.test(text), text);
  assert.match(text, /^A vertical photo for social media of a made-up character: an ordinary, believable person\. A woman aged around 28 of Latin American descent\. Dark brown hair\./);
  assert.equal(resolveValues(byId("upscale"), { image: { bytes: new Uint8Array([1]), name: "a.png" }, scale: "" }).scale, 2, "a select without an empty option falls back to its default");
});

test("select values must be one of the options", () => {
  const app = byId("upscale");
  const file = { bytes: new Uint8Array([1, 2, 3]), name: "a.png" };
  assert.equal(resolveValues(app, { image: file, scale: "4" }).scale, 4);
  assert.throws(() => resolveValues(app, { image: file, scale: 3 }), InputError);
});

test("missing files are rejected", () => {
  assert.throws(() => resolveValues(byId("edit"), { instruction: "x" }), /image: required/);
});

test("cinema studio composes the prompt from every select", () => {
  const app = byId("cinema-studio");
  const values = resolveValues(app, { prompt: "a fox in snow", seed: 1 });
  const wf = recorder();
  applyInputs(app, values, wf, () => null);
  const text = wf.sets["18:17.value"] as string;
  assert.match(text, /^A cinematic film still: a fox in snow\. The look: the full-frame digital cinema look, natural and smooth; a classic anamorphic widescreen look with oval bokeh and blue streak flares; a natural 35mm perspective; aperture f\/1\.4/);
  assert.ok(!/camera|lens/i.test(text), "the options describe the look, not the gear, so no camera is drawn");
  assert.ok(!text.includes("{"), "no placeholder left behind");
});

test("a multiple select keeps the picks in order and templates get them joined", () => {
  const app = byId("cinema-video");
  const values = resolveValues(app, { prompt: "a fox in snow", moves: JSON.stringify(["slowly dollies in toward the subject", "pans left", "pans left"]), seed: 1 });
  assert.deepEqual(values.moves, ["slowly dollies in toward the subject", "pans left"], "the form's JSON list, repeats dropped, order kept");
  const wf = recorder();
  applyInputs(app, values, wf, () => null);
  const motion = wf.sets["398:376.value"] as string;
  assert.match(motion, /^The camera slowly dollies in toward the subject, then pans left\. a fox in snow\. The look of a film: /);
  assert.ok(!(wf.sets["still:18:17.value"] as string).includes("dollies"), "the first frame gets the look, not the moves");
  assert.ok(!/camera|lens/i.test(wf.sets["still:18:17.value"] as string), "and no gear words, so Klein draws no camera");
  // none picked is a choice: the moves vanish from the prompt instead of falling back to the default
  const none = resolveValues(app, { prompt: "a fox in snow", moves: "[]", seed: 1 });
  const wf2 = recorder();
  applyInputs(app, none, wf2, () => null);
  assert.match(wf2.sets["398:376.value"] as string, /^a fox in snow\. The look/);
  assert.deepEqual(resolveValues(app, { prompt: "x", seed: 1 }).moves, ["slowly dollies in toward the subject"], "no value at all takes the default list");
  assert.throws(() => resolveValues(app, { prompt: "x", moves: JSON.stringify(["flies to the moon"]) }), /not one of the options/);
  assert.throws(() => resolveValues(app, { prompt: "x", moves: JSON.stringify(["pans left", "pans right", "tilts up", "tilts down"]) }), /at most 3/);
});

test("the influencer takes several traits per group, and its photo mode keeps the face unless a pick changes something", () => {
  const app = byId("ai-influencer");
  const values = resolveValues(app, { trait: JSON.stringify(["A nose piercing.", "Braces on the teeth."]), accessory: "[]", seed: 1 });
  const wf = recorder();
  applyInputs(app, values, wf, () => null);
  const text = wf.sets["18:17.value"] as string;
  assert.ok(text.includes("Freckles. Dark brown") || text.includes("Freckles."), "the default facial feature is still a list of one");
  assert.ok(text.includes("A nose piercing. Braces on the teeth."), text);
  assert.ok(!/Glasses|Headphones/.test(text));
  const photo = byId("ai-influencer-photo");
  assert.deepEqual(photo.modes, ["ai-influencer", "ai-influencer-photo"]);
  const wf2 = recorder();
  applyInputs(photo, resolveValues(photo, { image: { bytes: new Uint8Array([1]), name: "a.png" }, seed: 1 }), wf2, () => null);
  const p = wf2.sets["4.text"] as string;
  assert.match(p, /^A vertical photo for social media of the same person as in <ref_image_0>, as an influencer\. Standing in a plain light-gray photo studio/);
  assert.ok(!/hair\.|Freckles/.test(p), "nothing about hair or face is written until picked");
});

test("the aspect select sizes the first frame and the video together", () => {
  const app = byId("cinema-video");
  const wf = recorder();
  applyInputs(app, resolveValues(app, { prompt: "x", aspect: "9:16 (Portrait Widescreen)", seed: 1 }), wf, () => null);
  assert.equal(wf.sets["403.aspect_ratio"], "9:16 (Portrait Widescreen)");
  assert.equal(wf.sets["still:18:6.width"], 768);
  assert.equal(wf.sets["still:18:6.height"], 1344);
});

test("file inputs go through the asset function", () => {
  const app = byId("edit");
  const file = { bytes: new Uint8Array([1]), name: "me.png" };
  const values = resolveValues(app, { image: file, instruction: "make it night" });
  const wf = recorder();
  applyInputs(app, values, wf, (f) => `asset:${f.name}`);
  assert.equal(wf.sets["11.image"], "asset:me.png");
  assert.equal(wf.sets["4.text"], "make it night");
});

test("a select option writes its extra fields (style → LoRA file)", () => {
  const app = byId("styles");
  const values = resolveValues(app, { prompt: "a fox", style: "monochrome ink wash style", seed: 1 });
  const wf = recorder();
  applyInputs(app, values, wf, () => null);
  assert.equal(wf.sets["30:27.string_b"], "monochrome ink wash style");
  assert.equal(wf.sets["30:15.lora_name"], "krea2_darkbrush.safetensors");
  assert.throws(() => resolveValues(app, { prompt: "a fox", style: "not a style" }), InputError);
});

test("an option's string values are templates: the effect's prompt is written around the subject", () => {
  const app = byId("effects");
  const file = { bytes: new Uint8Array([1]), name: "teddy.png" };
  const values = resolveValues(app, { image: file, effect: "squish", subject: "a plush teddy bear", aspect: "square", seed: 1 });
  const wf = recorder();
  applyInputs(app, values, wf, () => null);
  assert.equal(wf.sets["ff_effect.lora_name"], "squish_18.safetensors");
  const text = wf.sets["6.text"] as string;
  assert.match(text, /^In the video, a plush teddy bear is presented/);
  assert.match(text, /further showing the sq41sh squish effect\.$/, "an empty {details} leaves nothing behind");
  assert.ok(!text.includes("{"), "no placeholder left behind");
  assert.equal(wf.sets["50.width"], 624);
  assert.equal(wf.sets["50.height"], 624);
  assert.equal(wf.sets["ff_lora_fast.strength_model"], undefined, "the fast LoRA stays off without the preset");

  const extra = recorder();
  applyInputs(app, resolveValues(app, { image: file, effect: "squish", subject: "a teddy", details: "on a pink rug", seed: 1 }), extra, () => null, "fast");
  assert.match(extra.sets["6.text"] as string, /squish effect\. on a pink rug$/);
  assert.equal(extra.sets["ff_lora_fast.strength_model"], 1.0);
  assert.equal(extra.sets["3.steps"], 6);
});

test("a template app writes its prompt even when Extra direction is left empty", () => {
  const app = byId("headshot");
  const file = { bytes: new Uint8Array([1]), name: "me.png" };
  const wf = recorder();
  applyInputs(app, resolveValues(app, { image: file, seed: 1 }), wf, () => null);
  const text = wf.sets["4.text"] as string;
  assert.match(text, /^A professional studio headshot of the same person as in <ref_image_0>, plain light grey backdrop, wearing a navy blazer/);
  assert.match(text, /build identical\.$/, "nothing dangles after the prompt");
  const more = recorder();
  applyInputs(app, resolveValues(app, { image: file, backdrop: "dark charcoal backdrop", details: "slight smile", seed: 1 }), more, () => null);
  assert.match(more.sets["4.text"] as string, /, dark charcoal backdrop, .*identical\. slight smile$/);
});

test("every effect writes its own LoRA and a prompt with its trigger words", () => {
  const app = byId("effects");
  const effect = app.inputs.find((i) => i.id === "effect")!;
  const files = new Set<unknown>();
  for (const o of effect.options!) {
    const lora = o.sets!.find((s) => s.field === "lora_name")!.value;
    const prompt = o.sets!.find((s) => s.node === "6")!.value as string;
    files.add(lora);
    assert.ok(app.models.some((m) => m.file.endsWith(String(lora))), `${o.value}: ${String(lora)} is not in models`);
    assert.match(prompt, /\{subject\}/, `${o.value} uses the subject`);
  }
  assert.equal(files.size, effect.options!.length, "one LoRA per effect");
});

test("validation errors name the node and, for a missing model file, the pack to download", () => {
  const app = byId("edit");
  // the shape ComfyUI returns (captured from a real /prompt rejection), relayed by comfy-api-proxy
  const nodeErrors = {
    "1": { class_type: "UNETLoader", errors: [{ type: "value_not_in_list", message: "Value not in list",
      details: "unet_name: 'flux3-image-klein-int8-convrot.safetensors' not in (list of length 74)",
      extra_info: { input_name: "unet_name", received_value: "flux3-image-klein-int8-convrot.safetensors" } }] },
    "7": { class_type: "KSampler", errors: [{ type: "value_bigger_than_max", message: "Value bigger than max", details: "steps: 999" }] },
  };
  const msg = explainSubmitError(app, { code: "invalid_workflow", message: "Prompt outputs failed validation", details: { node_errors: nodeErrors } })!;
  assert.match(msg, /UNETLoader \(node 1\): model file flux3-image-klein-int8-convrot\.safetensors is not on the backend/);
  assert.match(msg, /KSampler \(node 7\): Value bigger than max \(steps: 999\)/);
  assert.match(msg, /--pack image-flux3/);
  assert.equal(explainSubmitError(app, new Error("network down")), null);
});

test("renderTemplate tidies empty placeholders", () => {
  assert.equal(renderTemplate("{a}, {b}, {c}", { a: "x", c: "z" }), "x, z");
});

function fakeFetch(status: (url: string) => number, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    return new Response(status(url) === 200 ? JSON.stringify({ freed: true }) : "{}", { status: status(url) });
  }) as typeof fetch;
}

test("prepare: a backend without the gateway (404) is skipped, auth errors are not", async () => {
  const bare = new Runner({ baseUrl: "http://backend.test", token: "t", fetch: fakeFetch(() => 404) });
  assert.deepEqual(await bare.prepare(byId("z-image")), { freed: false, skipped: true });
  const gateway = new Runner({ baseUrl: "http://backend.test", token: "t", fetch: fakeFetch(() => 200) });
  assert.deepEqual(await gateway.prepare(byId("z-image")), { freed: true });
  const denied = new Runner({ baseUrl: "http://backend.test", token: "bad", fetch: fakeFetch(() => 401) });
  await assert.rejects(denied.prepare(byId("z-image")), /answered 401/);
});

test("drafts run only when allowed", async () => {
  // every app is ready now, so the test marks a copy of one as a draft
  const draft = { ...byId("reshoot"), status: "draft" as const };
  const values = Object.fromEntries(draft.inputs.filter((i) => ["image", "video", "audio"].includes(i.type))
    .map((i) => [i.id, { bytes: new Uint8Array([1]), name: "x.bin" }]));
  const closed = new Runner({ baseUrl: "http://backend.test", fetch: fakeFetch(() => 500), allowDrafts: false });
  await assert.rejects(closed.submit(draft, values), (e: unknown) => e instanceof InputError && /draft/.test((e as Error).message));
  const seen: string[] = [];
  const open = new Runner({ baseUrl: "http://backend.test", fetch: fakeFetch(() => 500, seen), allowDrafts: true });
  await assert.rejects(open.submit(draft, values), (e: unknown) => !(e instanceof InputError));
  assert.ok(seen[0]?.endsWith("/riverfield/prepare"), "got past the draft gate and asked the gateway");
});

test("h3-long-shot follows the LoRA: Pika keeps its ladder, turbo LoRAs get their steps", () => {
  const app = byId("h3-long-shot");
  const file = { bytes: new Uint8Array([1]), name: "x.png" };
  const mp = app.inputs.find((i) => i.id === "megapixels")!;
  assert.equal(mp.min, 0.1);
  assert.equal(mp.max, 4);
  const lora = app.inputs.find((i) => i.id === "lora_name")!;
  assert.ok((lora.options?.length ?? 0) >= 8, "the H3 LoRA list is not Pika-only");
  assert.deepEqual(app.inputs.find((i) => i.id === "steps")!.show_if, { input: "sampling", equals: "custom" });

  const pika = resolveValues(app, { image: file, prompt: "x", lora_name: "pika_h3_flex_fl2va_v1_bf16.safetensors" });
  assert.equal(pika.sampling, "pika");
  assert.equal(pika.steps, 6);
  assert.equal(pika.sampler, "lcm");

  const turbo = resolveValues(app, { image: file, prompt: "x", lora_name: "taomate_h3_3step_comfy.safetensors" });
  assert.equal(turbo.sampling, "custom");
  assert.equal(turbo.steps, 3);
  assert.equal(turbo.sampler, "euler");

  const graph = () => ({
    json: structuredClone(app.graph!),
    setInput(node: string, field: string, value: unknown) {
      ((this.json as any)[node] ??= { class_type: "?", inputs: {} }).inputs[field] = value;
    },
  });
  const pikaWf = graph();
  applyInputs(app, pika, pikaWf as any, () => null);
  assert.deepEqual((pikaWf.json as any)["17"].inputs.sigmas, ["28", 0]);
  assert.equal((pikaWf.json as any)["36"], undefined, "the unused BasicScheduler is pruned");

  const turboWf = graph();
  applyInputs(app, turbo, turboWf as any, () => null);
  assert.deepEqual((turboWf.json as any)["17"].inputs.sigmas, ["36", 0]);
  assert.equal((turboWf.json as any)["36"].inputs.steps, 3);
  assert.equal((turboWf.json as any)["14"].inputs.sampler_name, "euler");
});

test("the extra Qwen3.8 uncensored prompt models are selectable wherever Qwen3.8-27B is", () => {
  const files = [
    "Huihui-Qwen3.8-27B-abliterated_int8_convrot.safetensors",
    "qwen3.8_27b_uncensored_heretic_w4a8_convrot_v2.safetensors",
  ];
  for (const id of ["h3-image", "h3-image-edit"]) {
    const pe = byId(id).inputs.find((i) => i.id === "pe_model")!;
    for (const file of files) assert.ok(pe.options?.some((o) => o.value === file), `${id}: pe_model lacks ${file}`);
  }
  const clip = byId("studio-director").inputs.find((i) => i.id === "clip_name")!;
  for (const file of files) assert.ok(clip.options?.some((o) => o.value === file), `studio-director: clip_name lacks ${file}`);
});

test("the Flash director exposes the Flash step ladder and video VAE", () => {
  const app = byId("h3-studio-director-flash");
  const steps = app.inputs.find((i) => i.id === "steps")!;
  assert.deepEqual(steps.options?.map((o) => o.value), [4, 6, 8]);
  assert.equal(steps.default, 6);
  assert.deepEqual(steps.bind, [{ node: "50", field: "steps" }]);

  const vae = app.inputs.find((i) => i.id === "vae_name")!;
  const vaeValues = vae.options?.map((o) => o.value) ?? [];
  for (const file of [
    "minimax_h3_lynnreal_light_vae_int8_convrot.safetensors",
    "minimax_h3_video_vae_int8_convrot.safetensors",
    "minimax_h3_video_vae_fp16.safetensors",
  ]) {
    assert.ok(vaeValues.includes(file), `vae_name lacks ${file}`);
  }
  assert.deepEqual(vae.bind, [{ node: "3", field: "vae_name" }]);

  const wf = recorder();
  applyInputs(app, resolveValues(app, { global_prompt: "x", steps: 4, vae_name: "minimax_h3_video_vae_int8_convrot.safetensors" }), wf, () => null);
  assert.equal(wf.sets["50.steps"], 4);
  assert.equal(wf.sets["3.vae_name"], "minimax_h3_video_vae_int8_convrot.safetensors");
});

test("the LTX 2.5 single-shot apps expose a long duration and resolution", () => {
  for (const [id, node] of [["video", "403"], ["video-t2v", "409"]] as const) {
    const app = byId(id);
    assert.match(app.name, /^LTX 2\.5 /);
    const duration = app.inputs.find((i) => i.id === "duration")!;
    assert.equal(duration.max, 30, `${id}: duration max`);
    assert.equal(duration.step, 1, `${id}: whole seconds keep the 8n+1 frame grid at 24 fps`);
    const mp = app.inputs.find((i) => i.id === "megapixels")!;
    assert.equal(mp.default, 0.9);
    assert.deepEqual(mp.bind, [{ node, field: "megapixels" }]);
    const enhancer = app.inputs.find((i) => i.id === "enhancer_clip_name")!;
    assert.ok(enhancer.options?.some((o) => o.value === "gemma4_e2b_it_int8_convrot.safetensors"));
    const sampler = app.inputs.find((i) => i.id === "sampler")!;
    assert.ok(sampler.options?.some((o) => o.value === "euler_ancestral"));
    assert.deepEqual(sampler.bind, [
      { node: id === "video" ? "398:341" : "405:341", field: "sampler_name" },
      { node: id === "video" ? "398:352" : "405:352", field: "sampler_name" },
    ]);
    const high = app.inputs.find((i) => i.id === "steps")!;
    assert.deepEqual(high.options?.map((o) => o.value), [9, 4]);

    const values = resolveValues(app, {
      ...(id === "video" ? { image: { bytes: new Uint8Array([1]), name: "x.png" } } : {}),
      prompt: "x", duration: 15, megapixels: 1.5,
    });
    const wf = recorder();
    applyInputs(app, values, wf, () => null);
    assert.equal(wf.sets[`${id === "video" ? "398:362" : "405:362"}.value`], 15);
    assert.equal(wf.sets[`${node}.megapixels`], 1.5);
  }
});

test("the LTX 2.5 single-clip apps can skip the latent upscaler", () => {
  for (const [id, prefix] of [["video", "398"], ["video-t2v", "405"], ["cinema-video", "398"], ["lipsync", "398"]] as const) {
    const app = byId(id);
    const one = app.inputs.find((i) => i.id === "one_pass")!;
    assert.equal(one.default, false, `${id}: default keeps the two-stage pass`);
    assert.deepEqual(one.bind, [{ node: `${prefix}:onepass`, field: "value" }]);
    const graph = app.graph as Record<string, any>;
    assert.equal(graph[`${prefix}:onepass`].class_type, "PrimitiveBoolean");
    assert.equal(graph[`${prefix}:wswitch`].class_type, "ComfySwitchNode");
    assert.equal(graph[`${prefix}:dswitch`].class_type, "ComfySwitchNode");
    assert.deepEqual(graph[`${prefix}:356`].inputs.width, [`${prefix}:wswitch`, 0]);
    assert.deepEqual(graph[`${prefix}:374`].inputs.samples, [`${prefix}:dswitch`, 0]);
  }
});

test("the LTX 2.5 single-clip apps offer RelayVSR x2/x4", () => {
  for (const id of ["video", "video-t2v", "cinema-video", "ltx-director", "mixed-media"]) {
    const app = byId(id);
    const up = app.inputs.find((i) => i.id === "upscale")!;
    const values = up.options?.map((o) => o.value) ?? [];
    assert.deepEqual(values, ["", "x2", "x4"], `${id}: upscale options`);
    assert.deepEqual(up.bypass, [{ node: "vsr_decode", field: "images" }]);
    const detail = app.inputs.find((i) => i.id === "upscale_detail")!;
    assert.deepEqual(detail.bind, [{ node: "vsr_decode", field: "detail" }]);
    const graph = app.graph as Record<string, any>;
    assert.equal(graph.vsr_decode.class_type, "VSRDecode");
    assert.equal(graph.vsr_unet.class_type, "UNETLoader");
    const create = Object.values(graph).find((n: any) => n.class_type === "CreateVideo") as any;
    assert.deepEqual(create.inputs.images, ["vsr_decode", 0]);
  }
});

test("the LTX 2.5 conv video VAE is selectable and the default", () => {
  const conv = "ltx-2.5-video-vae-conv-bf16.safetensors";
  for (const [id, node] of [["video", "398:385"], ["video-t2v", "405:385"], ["ltx-director", "3"], ["ltx-director-4seg", "3"]] as const) {
    const app = byId(id);
    const vae = app.inputs.find((i) => i.id === "vae_name")!;
    assert.equal(vae.default, conv, `${id}: default`);
    assert.ok(vae.options?.some((o) => o.value === conv), `${id}: conv option`);
    assert.ok(vae.options?.some((o) => o.value === "ltx-2.5-video-vae-bf16.safetensors"), `${id}: old option`);
    assert.equal((app.graph as Record<string, any>)[node].inputs.vae_name, conv, `${id}: workflow`);
  }
});

test("the pi-H3 DWD apps expose 2/4 steps and decode without a video VAE", () => {
  const modes = [
    ["h3-piflow-t2v", [], undefined],
    ["h3-piflow-i2v", ["image"], "101"],
    ["h3-piflow-flf2v", ["first_frame", "last_frame"], "101"],
  ] as const;
  for (const [id, files, first] of modes) {
    const app = byId(id);
    assert.match(app.name, /^pi-H3 DWD /);
    const steps = app.inputs.find((i) => i.id === "steps")!;
    assert.deepEqual(steps.options?.map((o) => o.value), [2, 4]);
    assert.deepEqual(steps.bind, [{ node: "39:36", field: "value" }]);
    const duration = app.inputs.find((i) => i.id === "duration")!;
    assert.equal(duration.max, 40);
    const mp = app.inputs.find((i) => i.id === "megapixels")!;
    assert.deepEqual(mp.bind, [{ node: "30", field: "megapixels" }]);
    for (const file of files) assert.ok(app.inputs.some((i) => i.id === file), `${id}: ${file}`);

    const graph = app.graph! as Record<string, any>;
    assert.equal(graph["12"].class_type, "DWD Decode");
    assert.ok(!Object.values(graph).some((n: any) => n.class_type === "VAEDecode"), `${id}: video VAE decode must be absent`);
    assert.equal(graph["20"].class_type, "BlockSparseAttention");
    assert.equal(graph["41"].class_type, "H3SLAAttentionROCM");
    if (first) assert.equal(graph["6"].inputs.first_frame?.[0], first);
    if (id === "h3-piflow-flf2v") assert.equal(graph["6"].inputs.last_frame?.[0], "103");
  }
});

test("the pi-H3 director and reference apps switch the 2/4-step adapters", () => {
  for (const id of ["h3-piflow-director", "h3-piflow-r2v"]) {
    const app = byId(id);
    const steps = app.inputs.find((i) => i.id === "steps")!;
    assert.deepEqual(steps.options?.map((o) => o.value), [2, 4]);
    assert.deepEqual(steps.bind, [{ node: "39:36", field: "value" }]);
    const graph = app.graph! as Record<string, any>;
    assert.equal(graph["50"].class_type, "pi-Flow Scheduler");
    assert.equal(graph["39:2"].class_type, "Load LakonLab Adapter");
    assert.equal(graph["39:34"].class_type, "Load LakonLab Adapter");
    for (const [node, spec] of Object.entries(graph)) {
      for (const [field, value] of Object.entries((spec as any).inputs ?? {})) {
        if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
          assert.ok(graph[value[0]], `${id}: ${node}.${field} points at missing node ${value[0]}`);
        }
      }
    }
  }
  const director = byId("h3-piflow-director").graph as Record<string, any>;
  assert.equal(director["30"].class_type, "MiniMaxH3FiniteSegmentVideoSampler");
  assert.ok(!Object.values(director).some((n: any) => n.class_type === "DWD Decode"), "the multi-segment sampler decodes with the VAE");
  const ref = byId("h3-piflow-r2v").graph as Record<string, any>;
  assert.equal(ref["136"].class_type, "MiniMaxH3ReferenceToVideo");
  assert.equal(ref["12"].class_type, "DWD Decode");
});

test("the base H3 video apps expose the same controls as the latest H3 apps", () => {
  for (const id of ["h3-video", "h3-photo"]) {
    const app = byId(id);
    for (const field of ["resolution", "unet_name", "vae_name", "clip_name", "sampler", "scheduler", "sla_detail", "upscale", "upscale_detail", "filename_prefix", "format", "codec"]) {
      assert.ok(app.inputs.some((i) => i.id === field), `${id}: missing ${field}`);
    }
    const sampler = app.inputs.find((i) => i.id === "sampler")!;
    assert.ok((sampler.options?.length ?? 0) >= 5);
    const unet = app.inputs.find((i) => i.id === "unet_name")!;
    assert.ok((unet.options?.length ?? 0) >= 3);
    const vae = app.inputs.find((i) => i.id === "vae_name")!;
    assert.ok((vae.options?.length ?? 0) >= 3);
  }
});

test("every H3 video app reaches 40 seconds", () => {
  const h3 = apps.filter((a) => a.pack === "video-h3" || a.pack === "video-h3-flash");
  for (const app of h3) {
    const duration = app.inputs.find((i) => i.id === "duration");
    if (!duration) continue;
    assert.ok(Number(duration.max) >= 40, `${app.id}: duration max is ${duration.max}, expected at least 40`);
  }
});

test("an optional pass-through node is bypassed when its toggle is off or the backend lacks its class", () => {
  const app = {
    id: "bypass-test", name: "Bypass", section: "video", pack: "core", status: "ready",
    inputs: [{
      id: "sla", type: "toggle", label: "SLA", default: true,
      bind: [{ node: "42", field: "enabled" }],
      bypass: [{ node: "42", field: "model" }],
    }],
    outputs: [{ node: "30", type: "video" }], models: [],
  } as any;

  const graph = () => ({
    json: {
      "1": { class_type: "UNETLoader", inputs: {} },
      "40": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0] } },
      "42": { class_type: "H3SLAAttentionROCM", inputs: { model: ["40", 0], enabled: true } },
      "30": { class_type: "Sampler", inputs: { model: ["42", 0] } },
    } as Record<string, any>,
    setInput(node: string, field: string, value: unknown) {
      const n = (this.json[node] ??= { class_type: "?", inputs: {} });
      n.inputs[field] = value;
    },
  });

  const off = graph();
  applyInputs(app, { sla: false }, off as any, () => null);
  assert.equal(off.json["42"], undefined, "toggle off removes the node");
  assert.deepEqual(off.json["30"].inputs.model, ["40", 0], "its consumer now reads the LoRA directly");

  const missing = graph();
  applyInputs(app, { sla: true }, missing as any, () => null, undefined, new Set(["H3SLAAttentionROCM"]));
  assert.equal(missing.json["42"], undefined, "a backend without the class removes it even when the toggle is on");
  assert.deepEqual(missing.json["30"].inputs.model, ["40", 0]);

  const kept = graph();
  applyInputs(app, { sla: true }, kept as any, () => null, undefined, new Set());
  assert.ok(kept.json["42"], "the node stays when the backend ships it and the toggle is on");
  assert.deepEqual(kept.json["30"].inputs.model, ["42", 0]);
});

test("the Chatterbox voice apps chunk long scripts before synthesis", () => {
  const voice = { bytes: new Uint8Array([1]), name: "voice.wav" };
  for (const id of ["tts", "tts-clone"]) {
    const app = byId(id);
    for (const field of ["enable_chunking", "max_chars_per_chunk", "chunk_combination_method", "silence_between_chunks_ms"]) {
      assert.ok(app.inputs.some((i) => i.id === field), `${id}: missing ${field}`);
    }
    const values = id === "tts"
      ? resolveValues(app, { text: "a long story" })
      : resolveValues(app, { text: "a long story", voice });
    assert.equal(values.enable_chunking, true, `${id}: chunking is on by default`);
    assert.equal(values.max_chars_per_chunk, 400, `${id}: the safe default chunk is 400 characters`);
    const wf = recorder();
    applyInputs(app, values, wf, () => "asset:voice.wav");
    assert.equal(wf.sets["10.enable_chunking"], true);
    assert.equal(wf.sets["10.max_chars_per_chunk"], 400);
    assert.equal(wf.sets["10.chunk_combination_method"], "auto");
    assert.equal(wf.sets["10.silence_between_chunks_ms"], 100);
    assert.throws(
      () => resolveValues(app, id === "tts" ? { text: "x", max_chars_per_chunk: 5000 } : { text: "x", voice, max_chars_per_chunk: 5000 }),
      InputError,
      `${id}: chunk size stays inside the backend limit`,
    );
  }
});

test("H3 Image Edit exposes the model's 16-picture limit and prunes empty references", () => {
  const app = byId("h3-image-edit");
  assert.equal(app.layout, "sidebar", "the picture slots use the H3 reference app's stacked sidebar, not the composer's empty-icon row");
  const source = app.inputs.find((i) => i.id === "image")!;
  assert.equal(source.required, true, "the photo to edit is still required");
  for (let n = 2; n <= 16; n += 1) {
    const ref = app.inputs.find((i) => i.id === `image_${n}`);
    assert.ok(ref, `missing reference slot ${n}`);
    assert.equal(ref!.required, false, `reference ${n} is optional`);
    const node = String(61 + n);
    assert.deepEqual(ref!.bind, [{ node, field: "image" }], `reference ${n} loads from node ${node}`);
    assert.deepEqual(ref!.unlink, [
      { node: "32", field: `images.image_${n}` },
      { node: "34", field: `images.image${n}` },
    ], `reference ${n} cuts both consumers when empty`);
  }
  assert.ok(!app.inputs.some((i) => i.id === "image_17"), "16 pictures total, not 17");
  const vae = app.inputs.find((i) => i.id === "vae_name")!;
  assert.deepEqual(vae.options?.map((o) => o.value), ["minimax_h3_image_vae_fp16.safetensors"], "multi-reference edits keep the official fp16 VAE");

  const src = { bytes: new Uint8Array([1]), name: "source.png" };
  const ref2 = { bytes: new Uint8Array([2]), name: "ref2.png" };
  const ref16 = { bytes: new Uint8Array([3]), name: "ref16.png" };
  const values = resolveValues(app, { image: src, image_2: ref2, image_16: ref16, prompt: "use both references" });
  const graph = JSON.parse(JSON.stringify(app.graph)) as Record<string, any>;
  const wf = {
    json: graph,
    setInput(node: string, field: string, value: unknown) { (graph[node].inputs ??= {})[field] = value; },
  };
  applyInputs(app, values, wf, (f) => `asset:${f.name}`);

  assert.deepEqual(graph["32"].inputs["images.image_2"], ["63", 0], "reference 2 reaches the conditioning node");
  assert.deepEqual(graph["32"].inputs["images.image_16"], ["77", 0], "reference 16 reaches the conditioning node");
  assert.deepEqual(graph["34"].inputs["images.image2"], ["63", 0], "reference 2 reaches prompt expansion");
  assert.deepEqual(graph["34"].inputs["images.image16"], ["77", 0], "reference 16 reaches prompt expansion");
  assert.equal(graph["63"].inputs.image, "asset:ref2.png");
  assert.equal(graph["77"].inputs.image, "asset:ref16.png");
  assert.equal(graph["45"].inputs.image, "asset:source.png");

  assert.equal(graph["32"].inputs["images.image_3"], undefined, "an empty slot leaves no dangling edge");
  assert.equal(graph["34"].inputs["images.image3"], undefined);
  assert.ok(!graph["64"], "the empty slot's loader is pruned");
  assert.ok(!graph["65"], "another empty slot's loader is pruned too");
});
