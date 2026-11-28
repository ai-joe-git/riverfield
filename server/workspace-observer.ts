import { readFile } from "node:fs/promises";
import { InputError } from "./input-error.ts";
import type { FileValue } from "./runner.ts";
import { validateWorkspaceWriter, workspaceChatContent, type WorkspaceWriter } from "./workspace-writer.ts";
import type { AsrAdapter } from "./observer-inference.ts";

export type WorkspaceObserver = { chat: WorkspaceWriter; asr?: WorkspaceWriter; asrError?: string; reasoningNone?: boolean };

export function validateWorkspaceObserver(value: unknown): WorkspaceObserver {
  if (!value || typeof value !== "object") throw new InputError("An active BlackRiver observer is required.");
  const { chat, asr, asrError, reasoningNone } = value as Partial<WorkspaceObserver>;
  const audio = asr ? validateWorkspaceWriter(asr) : undefined;
  if (audio && !/^qwen3-asr-(0\.6b|1\.7b)$/.test(audio.model)) throw new InputError("Select a prepared Halogen NPU ASR model.");
  return {
    chat: validateWorkspaceWriter(chat),
    ...(audio ? { asr: audio } : typeof asrError === "string" ? { asrError: asrError.slice(0, 500) } : {}),
    ...(reasoningNone === true ? { reasoningNone } : {}),
  };
}

function requestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(600_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function observeWithWorkspace(writer: WorkspaceWriter & { reasoningNone?: boolean }, values: Record<string, unknown>, signal?: AbortSignal, request = fetch) {
  const images = Array.from({ length: 9 }, (_, i) => values[`frame${i + 1}`]).filter(Boolean) as FileValue[];
  const content = workspaceChatContent(writer, String(values.prompt), images);
  const response = await request(writer.baseUrl + "/chat/completions", {
    method: "POST", redirect: "error", signal: requestSignal(signal), headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: writer.model, stream: false, temperature: values.temperature, top_p: values.top_p,
      max_tokens: values.max_output_tokens, ...(writer.reasoningNone && values.thinking === false ? { reasoning_effort: "none" } : {}), messages: [{ role: "system", content: values.system_prompt }, { role: "user", content }] }),
  });
  if (!response.ok) throw new Error(`BlackRiver observer returned HTTP ${response.status}.`);
  const choice = (await response.json() as any)?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content.replace(/^(?:\s*<think>[\s\S]*?<\/think>)+\s*/i, "").trim() : "";
  if (choice?.finish_reason === "length") throw new Error("BlackRiver reached the observation output token limit before completing its structured response.");
  if (!text || /^<think>/i.test(text)) throw new Error("BlackRiver returned no complete structured observation.");
  return { text };
}

export function workspaceAsr(asr?: WorkspaceWriter, request = fetch, unavailable?: string): AsrAdapter {
  return { async transcribe({ audio, signal }) {
    if (!asr) throw new Error(unavailable || "Enable a Qwen3-ASR checkpoint in BlackRiver’s Halogen NPU settings.");
    const bytes = await readFile(audio);
    if (bytes.byteLength > 24 * 1024 ** 2 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")
      throw new Error("The extracted WAV exceeds BlackRiver’s ASR input limit or is invalid.");
    const form = new FormData();
    form.set("file", new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }), "scene.wav");
    form.set("model", asr.model);
    form.set("response_format", "json");
    const response = await request(asr.baseUrl + "/audio/transcriptions", { method: "POST", body: form, redirect: "error", signal: requestSignal(signal) });
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(detail?.error?.message?.slice(0, 500) || `BlackRiver NPU ASR returned HTTP ${response.status}.`);
    }
    const result = await response.json() as { text?: unknown; language?: string };
    if (typeof result.text !== "string") throw new Error("BlackRiver returned an invalid transcript.");
    return { provider: "halogen-npu", model: asr.model, text: result.text, rawTranscript: result.text,
      ...(result.language ? { language: result.language } : {}), utterances: [], evidenceIds: [],
      limitations: ["NPU ASR provides a transcript without reliable utterance timestamps or speaker labels."] };
  } };
}
