// Internal ComfyUI app for the Phase 1 observer. It is not registered as a public app:
// the ObservationManager calls it through the same Runner and shared inference queue.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { App } from "./registry.ts";

const here = dirname(new URL(import.meta.url).pathname);
const workflowPath = join(here, "observer-workflow.api.json");
const graph = JSON.parse(readFileSync(workflowPath, "utf8"));

/**
 * The observer uses the installed Qwen3.8 27B multimodal model through ComfyUI's
 * TextGenerateV2 node. The same app serves the independent visual pass and the
 * comparison pass: only the system prompt, user prompt and optional images differ.
 */
export const observerApp = {
  id: "riverfield-observer-internal",
  name: "Riverfield Observer (internal)",
  section: "utility",
  pack: "prompt-h3",
  status: "ready",
  summary: "Internal evidence-only audiovisual observer; not listed in the public app catalog.",
  workflow: "server/observer-workflow.api.json",
  dir: here,
  workflowPath,
  graph,
  inputs: [
    {
      id: "system_prompt", type: "textarea", label: "Observer system prompt", required: true,
      bind: [{ node: "sys", field: "value" }],
    },
    {
      id: "prompt", type: "textarea", label: "Observer evidence prompt", required: true,
      bind: [{ node: "prompt_source", field: "value" }],
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `frame${index + 1}`, type: "image" as const, label: `Evidence frame ${index + 1}`,
      required: false,
      bind: [{ node: `img${index + 1}`, field: "image" }],
      unlink: [{ node: "gen", field: `images.image${index + 1}` }],
    })),
  ],
  outputs: [{ node: "save", type: "text" as const, label: "Observation JSON" }],
  models: [{
    repo: "Qwen/Qwen3.8-27B", file: "qwen3.8_27b_w4a8.safetensors",
    dir: "text_encoders", gb: 17.3, phase: "encode" as const, license: "Apache-2.0",
  }],
  credits: ["Qwen3.8 27B multimodal (Apache-2.0)"],
  notes: "Internal evidence-only observer. It receives no intended prompt during the independent pass and never writes canonical memory.",
} satisfies App;
