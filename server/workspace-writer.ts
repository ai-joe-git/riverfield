import type { App } from "./registry.ts";
import { InputError } from "./input-error.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { applyInputs, resolveValues, type FileValue } from "./runner.ts";

export const writerSamplingKeys = ["temperature", "top_k", "top_p", "min_p", "repetition_penalty", "presence_penalty", "seed"] as const;
type SamplingKey = typeof writerSamplingKeys[number];
export type WorkspaceWriter = {
  baseUrl: string; model: string; vision?: boolean; reasoningNone?: boolean;
  backend?: "halogen" | "llama.cpp"; sampling?: SamplingKey[];
  enableThinking?: boolean; noStore?: boolean; tokenCap?: number; runtimeVersion?: string;
};
type NativeWriter = {
  app: string; node: string; mode: string; system: string;
  sampling: Record<SamplingKey, number>; sample: boolean; maxTokens: number; thinking: boolean; defaultTemplate: boolean;
  nativeModel: unknown;
};
export type WriterReference = { slot: string; assetId?: string; sha256: string; kind: "image" | "audio" };
export type WriterReceipt = {
  segment: number; brief: string; systemPrompt: string; systemSha256: string; userMessage: string;
  references: WriterReference[]; model: string; backend: string; runtimeVersion?: string; workflow: Omit<NativeWriter, "system">;
  requestParameters: Record<string, unknown>; differences: string[]; rawResponse: unknown; finalPrompt: string; finalPromptSha256: string;
};
export function writerHash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateWorkspaceWriter(value: unknown): WorkspaceWriter {
  const row = value as Partial<WorkspaceWriter> | undefined;
  let url: URL;
  try { url = new URL(String(row?.baseUrl || "")); }
  catch { throw new InputError("Select an active BlackRiver local writer."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash || !["/v1", "/v1/"].includes(url.pathname) ||
      typeof row?.model !== "string" || !row.model.trim() || row.model.length > 320 || /[\u0000-\u001f\u007f]/.test(row.model))
    throw new InputError("The writer must use the active local OpenAI-compatible engine and an exact model ID.");
  return { baseUrl: url.origin + "/v1", model: row.model, vision: row.vision === true,
    reasoningNone: row.reasoningNone === true,
    ...(row.backend === "halogen" || row.backend === "llama.cpp" ? { backend: row.backend } : {}),
    sampling: writerSamplingKeys.filter(key => Array.isArray(row.sampling) && row.sampling.includes(key)),
    enableThinking: row.enableThinking === true, noStore: row.noStore === true,
    ...(Number.isSafeInteger(row.tokenCap) && row.tokenCap! > 0 ? { tokenCap: row.tokenCap } : {}),
    ...(typeof row.runtimeVersion === "string" ? { runtimeVersion: row.runtimeVersion.slice(0, 120) } : {}),
  };
}

/** Apply the same installed manifest defaults, mode option and graph bindings as Runner.submit. */
export function resolveNativeWriter(app: App, mode: string): NativeWriter {
  const modeInput = app.inputs.find(field => field.id === "prompt_mode");
  if (!modeInput?.options?.some(option => option.value === mode))
    throw new InputError(`${app.id} does not have a native ${mode} prompt preset.`);
  const graph: NonNullable<App["graph"]> = app.workflowPath ? JSON.parse(readFileSync(app.workflowPath, "utf8")) : structuredClone(app.graph ?? {});
  if (Object.values(graph).filter(node => node.class_type === "TextGenerateV2").length !== 1)
    throw new InputError("Riverfield enhancer has no unambiguous system prompt binding.");
  applyInputs(app, resolveValues(app, { prompt_mode: mode, prompt: "Workspace prompt" }), {
    json: graph,
    setInput(node, field, value) {
      if (!graph[node]?.inputs) throw new InputError(`Unknown enhancer node ${node}.`);
      graph[node].inputs[field] = value;
    },
  }, file => file);
  const [node, generator] = Object.entries(graph).find(([, item]) => item.class_type === "TextGenerateV2") ?? [];
  if (!node || !generator) throw new InputError("Riverfield enhancer output is not connected to TextGenerateV2.");
  const inputs = generator.inputs;
  const link = inputs.system_prompt;
  const source = Array.isArray(link) && link[1] === 0 ? graph[String(link[0])] : undefined;
  const system = typeof link === "string" ? link
    : source && ["PrimitiveString", "PrimitiveStringMultiline"].includes(source.class_type) ? source.inputs.value : undefined;
  if (typeof system !== "string" || !system.trim()) throw new InputError("Riverfield enhancer has no supported system prompt binding.");
  if (inputs.use_default_template === false)
    throw new InputError("This enhancer disables its native template and cannot be reproduced through the Workspace chat API.");
  const sample = inputs.sampling_mode === "on";
  if (!sample && inputs.sampling_mode !== "off") throw new InputError("Unsupported native TextGenerateV2 sampling mode.");
  const seed = inputs["sampling_mode.seed"];
  const sampling = Object.fromEntries(writerSamplingKeys.map(key => {
    const value = inputs[`sampling_mode.${key}`];
    if (sample && (typeof value !== "number" || !Number.isFinite(value)))
      throw new InputError(`The installed TextGenerateV2 workflow must specify its native ${key}.`);
    return [key, value];
  })) as Record<SamplingKey, number>;
  if (sample && (!Number.isSafeInteger(seed) || Number(seed) < 0)) throw new InputError("The native seed is outside the lossless JavaScript range.");
  if (!Number.isSafeInteger(inputs.max_length) || Number(inputs.max_length) < 1) throw new InputError("Invalid native writer output limit.");
  const clip = Array.isArray(inputs.clip) ? graph[String(inputs.clip[0])] : undefined;
  return { app: app.id, node, mode, system, sampling, sample, maxTokens: Number(inputs.max_length),
    thinking: inputs.thinking === true, defaultTemplate: true, nativeModel: clip?.inputs.clip_name ?? clip?.inputs.model_name };
}

export function workspaceSystemPrompt(app: App, mode: string): string {
  return resolveNativeWriter(app, mode).system;
}

export function workspaceWriterParameters(writer: WorkspaceWriter, native: NativeWriter) {
  const differences = ["The active checkpoint, tokenizer, chat template and sampling implementation belong to the local backend. Native ComfyUI token streams and seeded output can differ."];
  const output = Math.min(native.maxTokens, writer.tokenCap ?? native.maxTokens);
  const requestParameters: Record<string, unknown> = { stream: false, max_tokens: output,
    temperature: native.sample ? native.sampling.temperature : 0 };
  if (output !== native.maxTokens) differences.push(`Runtime capped output at ${output} tokens.`);
  const supported = new Set<SamplingKey>(writer.backend === "llama.cpp" ? writerSamplingKeys : writer.sampling?.length ? writer.sampling : ["temperature", "top_p"]);
  if (native.sample) {
    for (const key of writerSamplingKeys) {
      if (supported.has(key)) requestParameters[writer.backend === "llama.cpp" && key === "repetition_penalty" ? "repeat_penalty" : key] = native.sampling[key];
      else differences.push(`${key} is not verified for this backend and was omitted.`);
    }
  }
  if (writer.backend === "llama.cpp") {
    requestParameters.cache_prompt = false;
    requestParameters.chat_template_kwargs = { enable_thinking: native.thinking };
    differences.push("The selected llama.cpp template can ignore enable_thinking. Its repetition window follows the server.");
  } else if (writer.backend === "halogen" && writer.enableThinking) {
    requestParameters.enable_thinking = native.thinking;
  }
  if (!native.thinking && writer.reasoningNone) requestParameters.reasoning_effort = "none";
  if (writer.backend === "halogen" && writer.noStore) requestParameters.prompt_cache_policy = "no_store";
  if (!("chat_template_kwargs" in requestParameters || "enable_thinking" in requestParameters || "reasoning_effort" in requestParameters))
    differences.push("Thinking follows the active backend template because no writing-specific control was verified.");
  return { requestParameters, differences };
}

function imageMime(image: FileValue): string {
  const bytes = Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new InputError("The local writer accepts PNG, JPEG and WebP reference images.");
}

export function validateWorkspaceImages(writer: WorkspaceWriter, images: FileValue[]) {
  if (images.length && !writer.vision) throw new InputError("The active BlackRiver writer needs image support to use these Riverfield references.");
  if (images.reduce((n, image) => n + image.bytes.byteLength, 0) > 24 * 1024 ** 2)
    throw new InputError("The reference images exceed the local writer's 24 MiB per-segment request limit.");
  return images.map(imageMime);
}

export function workspaceChatContent(writer: WorkspaceWriter, prompt: string, images: FileValue[]) {
  const formats = validateWorkspaceImages(writer, images);
  return images.length ? [
    { type: "text", text: prompt },
    ...images.map((image, index) => ({ type: "image_url", image_url: { url: `data:${formats[index]};base64,${Buffer.from(image.bytes).toString("base64")}` } })),
  ] : prompt;
}

export const DEFAULT_WORKSPACE_WRITER_TIMEOUT_MS = 600_000;

function normalizePrompt(content: unknown): string {
  if (typeof content !== "string") return "";
  let text = content.replace(/^(?:\s*<think>[\s\S]*?<\/think>)+\s*/i, "").trim();
  if (/^<think>/i.test(text)) return "";
  if (/^(?:`{3,}|~{3,})/.test(text)) {
    const fenced = /^(`{3,}|~{3,})[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*$/.exec(text);
    if (!fenced || /^(?:`{3,}|~{3,})[ \t]*$/m.test(fenced[2])) return "";
    text = fenced[2].trim();
  }
  return text;
}

export async function writeWorkspacePrompt(writer: WorkspaceWriter, enhancer: App, input: {
  prompt: string; mode: string; media: Record<string, unknown>; signal?: AbortSignal;
  audit?: { segment: number; brief: string; references: WriterReference[]; save: (receipt: WriterReceipt) => void };
  allowedPictures?: number;
  allowedAudios?: number;
  singleLine?: boolean;
}, request = fetch): Promise<string> {
  const { system, ...workflow } = resolveNativeWriter(enhancer, input.mode);
  const { requestParameters, differences } = workspaceWriterParameters(writer, { system, ...workflow });
  if (input.audit?.references.some(reference => reference.kind === "audio"))
    differences.push("Standalone audio is carried by the render. The text writer receives its reference description without audio bytes.");
  if (Object.keys(input.media).some(key => key.startsWith("video")))
    throw new InputError("This local writer path accepts image references. Video reference enhancement needs Riverfield's video-capable enhancer.");
  const images = Object.entries(input.media).filter(([key]) => /^image\d+$/.test(key)).sort(([a], [b]) => Number(a.slice(5)) - Number(b.slice(5))).map(([, value]) => value as FileValue);
  const content = workspaceChatContent(writer, input.prompt, images);
  const timeoutMs = Number(process.env.RIVERFIELD_WORKSPACE_WRITER_TIMEOUT_MS || DEFAULT_WORKSPACE_WRITER_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("RIVERFIELD_WORKSPACE_WRITER_TIMEOUT_MS must be a positive timeout in milliseconds.");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  let rawResponse: any;
  let choice: any;
  try {
    const response = await request(writer.baseUrl + "/chat/completions", {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ model: writer.model, ...requestParameters,
        messages: [{ role: "system", content: system }, { role: "user", content }] }),
    });
    if (!response.ok) throw new Error(`BlackRiver's local prompt writer returned HTTP ${response.status}.`);
    rawResponse = await response.json();
    choice = rawResponse?.choices?.[0];
  } catch (error) {
    if (timeout.aborted && !input.signal?.aborted)
      throw new Error(`BlackRiver's local prompt writer timed out after ${timeoutMs / 1000} seconds.`, { cause: error });
    throw error;
  }
  const normalized = normalizePrompt(choice?.message?.content);
  const text = input.singleLine ? normalized.replace(/\s*\r?\n\s*/g, " ") : normalized;
  if (choice?.finish_reason === "length" || !text || text.length > 12000)
    throw new Error("BlackRiver's local writer did not return a complete prompt within Riverfield's 12,000-character limit.");
  validateWriterReferences(text, input.allowedPictures ?? images.length, input.allowedAudios);
  const dialogue = (value: string) => [...value.matchAll(/<d>([\s\S]*?)<\/d>/gi)].map(match => match[1].trim());
  const requiredDialogue = dialogue(input.audit?.brief ?? "");
  if (requiredDialogue.length) {
    const actual = dialogue(text);
    const declaredLanguage = /^\[[^\]\r\n]+\]\s*/;
    if (actual.length !== requiredDialogue.length || requiredDialogue.some((line, i) =>
      actual[i] !== line && actual[i].replace(declaredLanguage, "") !== line))
      throw new InputError("The writer changed explicitly supplied dialogue. No render was submitted.");
  }
  input.audit?.save({ segment: input.audit.segment, brief: input.audit.brief, systemPrompt: system, systemSha256: writerHash(system),
    userMessage: input.prompt, references: input.audit.references, model: writer.model, backend: writer.backend ?? "openai-compatible",
    runtimeVersion: writer.runtimeVersion, workflow, requestParameters, differences, rawResponse,
    finalPrompt: text, finalPromptSha256: writerHash(text) });
  return text;
}

export function validateWriterReferences(text: string, pictures: number, audios?: number) {
  for (const match of text.matchAll(/<(Picture|Audio|Video)\s+(\d+)>/gi)) {
    const kind = match[1].toLowerCase();
    const limit = kind === "picture" ? pictures : kind === "audio" ? audios : 0;
    if (limit !== undefined && (Number(match[2]) < 1 || Number(match[2]) > limit))
      throw new InputError(`${match[0]} does not refer to a supplied segment reference.`);
  }
}
