// Internal ComfyUI app for the multimodal observer. It is not registered as a public
// app: ObservationManager calls it through the same Runner and shared inference queue.
//
// One graph serves every installed checkpoint. The selected model and CLIPLoader recipe
// are real workflow inputs, not report-only metadata; the app variant carries the chosen
// model in its model key so the gateway unloads the previous checkpoint before a switch.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { App } from "./registry.ts";
import { DEFAULT_OBSERVER_MODEL, type ObserverModel } from "./observer-models.ts";

const here = dirname(new URL(import.meta.url).pathname);
const workflowPath = join(here, "observer-workflow.api.json");
const graph = JSON.parse(readFileSync(workflowPath, "utf8"));
const slug = (value: string) => value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

export function createObserverApp(model: ObserverModel): App {
  return {
    id: `riverfield-observer-internal-${slug(model.id)}`,
    name: `Riverfield Observer (${model.label})`,
    section: "utility",
    pack: "prompt-h3",
    status: "ready",
    summary: `Internal evidence-only multimodal observer using ${model.file}; not listed in the public app catalog.`,
    workflow: "server/observer-workflow.api.json",
    dir: here,
    workflowPath,
    graph,
    inputs: [
      {
        id: "observer_model", type: "text", label: "Observer checkpoint", required: true,
        default: model.file,
        bind: [{ node: "clip", field: "clip_name" }],
      },
      {
        id: "observer_clip_type", type: "text", label: "CLIPLoader recipe", required: true,
        default: model.clipType,
        bind: [{ node: "clip", field: "type" }],
      },
      {
        id: "system_prompt", type: "textarea", label: "Observer system prompt", required: true,
        bind: [{ node: "sys", field: "value" }],
      },
      {
        id: "prompt", type: "textarea", label: "Observer evidence prompt", required: true,
        bind: [{ node: "prompt_source", field: "value" }],
      },
      {
        id: "temperature", type: "number", label: "Sampling temperature", required: true,
        default: 0.1, min: 0.01, max: 2,
        bind: [{ node: "gen", field: "sampling_mode.temperature" }],
      },
      {
        id: "max_output_tokens", type: "number", label: "Maximum output tokens", required: true,
        default: 4096, min: 1, max: 32768,
        bind: [{ node: "gen", field: "max_length" }],
      },
      {
        id: "top_k", type: "number", label: "Top-k", required: true, default: 64, min: 0, max: 1000,
        bind: [{ node: "gen", field: "sampling_mode.top_k" }],
      },
      {
        id: "top_p", type: "number", label: "Top-p", required: true, default: 0.9, min: 0, max: 1,
        bind: [{ node: "gen", field: "sampling_mode.top_p" }],
      },
      {
        id: "seed", type: "seed", label: "Sampling seed", required: true, default: 0,
        bind: [{ node: "gen", field: "sampling_mode.seed" }],
      },
      {
        id: "thinking", type: "toggle", label: "Thinking mode", required: true, default: false,
        bind: [{ node: "gen", field: "thinking" }],
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `frame${index + 1}`, type: "image" as const, label: `Evidence frame ${index + 1}`,
        required: false,
        bind: [{ node: `img${index + 1}`, field: "image" }],
        unlink: [{ node: "gen", field: `images.image${index + 1}` }],
      })),
      {
        id: "video1", type: "video", label: "Native scene video (optional)",
        required: false,
        bind: [{ node: "video", field: "file" }],
        unlink: [{ node: "gen", field: "videos.video1" }],
      },
      {
        id: "audio1", type: "audio", label: "Native scene audio (optional)",
        required: false,
        bind: [{ node: "audio", field: "audio" }],
        unlink: [{ node: "gen", field: "audios.audio1" }],
      },
    ],
    outputs: [{ node: "save", type: "text" as const, label: "Observation JSON" }],
    models: [{
      repo: model.repo, file: model.file, dir: "text_encoders",
      gb: model.sizeGb, phase: "encode" as const, license: model.license,
    }],
    credits: [`${model.label} (${model.license})`],
    notes: "Internal evidence-only multimodal observer. It receives no intended prompt during the independent pass and never writes canonical memory. Model, CLIPLoader recipe, sampling budget and native media inputs are actual graph inputs.",
  } satisfies App;
}

/** The default internal app used by callers that have not selected a model yet. */
export const observerApp = createObserverApp(DEFAULT_OBSERVER_MODEL);
