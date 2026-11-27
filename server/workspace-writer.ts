import type { App } from "./registry.ts";
import { InputError } from "./input-error.ts";
import { setValue, type FileValue } from "./runner.ts";

export type WorkspaceWriter = { baseUrl: string; model: string; vision?: boolean };

export function validateWorkspaceWriter(value: unknown): WorkspaceWriter {
  const row = value as Partial<WorkspaceWriter> | undefined;
  let url: URL;
  try { url = new URL(String(row?.baseUrl || "")); }
  catch { throw new InputError("Select an active BlackRiver local writer."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash || !["/v1", "/v1/"].includes(url.pathname) ||
      typeof row?.model !== "string" || !row.model.trim() || row.model.length > 320 || /[\u0000-\u001f\u007f]/.test(row.model))
    throw new InputError("The writer must use the active local OpenAI-compatible engine and an exact model ID.");
  return { baseUrl: url.origin + "/v1", model: row.model, vision: row?.vision === true };
}

export function workspaceSystemPrompt(app: App, mode: string): string {
  const input = app.inputs.find(field => field.id === "prompt_mode");
  const node = app.graph?.gen?.inputs?.system_prompt;
  if (!Array.isArray(node) || node[1] !== 0) throw new Error("Riverfield enhancer has no supported system prompt binding.");
  const choice = input?.options?.find(option => option.value === mode);
  const setting = choice?.sets?.find(item => item.node === node[0] && item.field === "value")?.value;
  const base = app.graph?.[String(node[0])]?.inputs?.value;
  const system = setting ?? base;
  if (!choice || typeof system !== "string" || !system.trim()) throw new Error("Riverfield enhancer has no system prompt for " + mode);
  return String(setValue(system, { prompt_mode: mode }));
}

function imageMime(image: FileValue): string {
  const bytes = Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new InputError("The local writer accepts PNG, JPEG and WebP reference images.");
}

export async function writeWorkspacePrompt(writer: WorkspaceWriter, enhancer: App, input: {
  prompt: string; mode: string; media: Record<string, unknown>; signal?: AbortSignal;
}, request = fetch): Promise<string> {
  const system = workspaceSystemPrompt(enhancer, input.mode);
  if (Object.keys(input.media).some(key => key.startsWith("video")))
    throw new InputError("This local writer path accepts image references. Video reference enhancement needs Riverfield's video-capable enhancer.");
  const images = Object.entries(input.media).filter(([key]) => key.startsWith("image")).map(([, value]) => value as FileValue);
  if (images.length && !writer.vision) throw new InputError("The active BlackRiver writer needs image support to use these Riverfield references.");
  if (images.reduce((n, image) => n + image.bytes.byteLength, 0) > 24 * 1024 ** 2)
    throw new InputError("The reference images exceed the local writer's 24 MiB per-segment request limit.");
  const content = images.length ? [
    { type: "text", text: input.prompt },
    ...images.map(image => ({ type: "image_url", image_url: { url: `data:${imageMime(image)};base64,${Buffer.from(image.bytes).toString("base64")}` } })),
  ] : input.prompt;
  const response = await request(writer.baseUrl + "/chat/completions", {
    method: "POST", redirect: "error", headers: { "content-type": "application/json" },
    signal: AbortSignal.any([AbortSignal.timeout(180000), ...(input.signal ? [input.signal] : [])]),
    body: JSON.stringify({ model: writer.model, stream: false, temperature: 0.7, top_p: 0.95,
      max_tokens: 4096, reasoning_effort: "none", messages: [{ role: "system", content: system }, { role: "user", content }] }),
  });
  if (!response.ok) throw new Error(`BlackRiver's local prompt writer returned HTTP ${response.status}.`);
  const choice = (await response.json() as any)?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ?
    choice.message.content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "").trim() : "";
  if (choice?.finish_reason === "length" || !text || text.length > 12000)
    throw new Error("BlackRiver's local writer did not return a complete prompt within Riverfield's 12,000-character limit.");
  return text;
}
