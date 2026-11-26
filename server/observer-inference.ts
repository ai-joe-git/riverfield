// Phase 1 model adapters. The visual observer and comparison pass share one Qwen app
// and one loaded model; ASR is a separate Whisper Turbo app. Both use Runner.runTexts,
// so every call passes through the shared inference queue in the caller.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { App } from "./registry.ts";
import type { Runner, FileValue } from "./runner.ts";
import type {
  ObservationComparison, ObservationConfidence, ObservationDialogue, ObservationEvidence,
  ObservationFinding, ObservationReport, ObservationShot, ObservationTechnical, ObservationUtterance,
  ObservationVisual, FactChange,
} from "./production-types.ts";
import {
  COMPARISON_PROMPT_VERSION, COMPARISON_SYSTEM_PROMPT, OBSERVER_PROMPT_VERSION, OBSERVER_VERSION,
  VISUAL_OBSERVER_SYSTEM_PROMPT, comparisonPrompt, visualObserverPrompt,
} from "./observer-prompts.ts";
import { ObservationError } from "./observation-evidence.ts";

export type VisualObserverResult = {
  visual: ObservationVisual;
  model: string;
  version: string;
  promptVersion: string;
  configuration: Record<string, unknown>;
  rawText: string;
  systemPrompt?: string;
  inputPrompt?: string;
  images?: {
    order: number; id: string; label: string; kind: "evidence" | "reference";
    file: string; hash?: string; timestampSeconds?: number; frame?: number; shotId?: string;
  }[];
};

export type ComparisonResult = {
  comparison: ObservationComparison;
  rawText: string;
  promptVersion: string;
  systemPrompt?: string;
  inputPrompt?: string;
};

export interface VisualObserver {
  observe(input: {
    technical: ObservationTechnical;
    shots: ObservationShot[];
    frames: ObservationEvidence[];
    referenceFiles?: { label: string; file: FileValue }[];
    signal?: AbortSignal;
  }): Promise<VisualObserverResult>;
}

export interface SceneComparator {
  compare(input: {
    intended: string;
    candidatePrompt: string;
    canonicalOpening: string;
    observation: Pick<ObservationReport, "visual" | "dialogue" | "technical" | "shots" | "evidence">;
    coverage: string;
    signal?: AbortSignal;
  }): Promise<ComparisonResult>;
}

export interface AsrAdapter {
  transcribe(input: { audio: string; offsetSeconds: number; bindingId: string; signal?: AbortSignal }): Promise<ObservationDialogue>;
}

export interface AudioUnderstandingAdapter {
  analyse(input: { audio: string; transcript: ObservationDialogue; signal?: AbortSignal }): Promise<Record<string, unknown>>;
}

const asConfidence = (value: unknown, fallback: ObservationConfidence = "uncertain"): ObservationConfidence =>
  ["confirmed", "probable", "uncertain", "not_observable"].includes(String(value)) ? String(value) as ObservationConfidence : fallback;

const strings = (value: unknown, max = 24): string[] =>
  Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, max) : [];

function jsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new ObservationError("OBSERVER_OUTPUT_INVALID", "The observer did not return a JSON object");
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ObservationError("OBSERVER_OUTPUT_INVALID", `The observer returned invalid JSON: ${(error as Error).message}`);
  }
}

function evidenceIds(value: unknown, allowed: Set<string>, limitations: string[]): string[] {
  const ids = strings(value).filter((id) => allowed.has(id));
  if (strings(value).length && !ids.length) limitations.push("The observer cited evidence ids that were not in the evidence map.");
  return ids;
}

function frameFile(frame: ObservationEvidence): FileValue {
  return { bytes: new Uint8Array(readFileSync(frame.path!)), name: basename(frame.path!), type: "image/jpeg" };
}

export class QwenVisualObserver implements VisualObserver, SceneComparator {
  readonly model = "qwen3.8_27b_w4a8.safetensors";
  readonly version = OBSERVER_VERSION;
  readonly promptVersion = OBSERVER_PROMPT_VERSION;
  private readonly runner: Runner;
  private readonly app: App;

  constructor(runner: Runner, app: App) {
    this.runner = runner;
    this.app = app;
  }

  async observe(input: {
    technical: ObservationTechnical;
    shots: ObservationShot[];
    frames: ObservationEvidence[];
    referenceFiles?: { label: string; file: FileValue }[];
    signal?: AbortSignal;
  }): Promise<VisualObserverResult> {
    const frames = input.frames.slice(0, 9);
    const references = (input.referenceFiles ?? []).slice(0, Math.max(0, 9 - frames.length));
    const allowed = new Set(frames.map((frame) => frame.id));
    const prompt = visualObserverPrompt({
      technical: input.technical, shots: input.shots, frames,
      referenceLabels: references.map((reference) => reference.label),
    });
    const values: Record<string, unknown> = {
      system_prompt: VISUAL_OBSERVER_SYSTEM_PROMPT,
      prompt,
    };
    const visualImages = [
      ...frames.map((frame) => ({
        file: frameFile(frame),
        meta: {
          id: frame.id, label: frame.id, kind: "evidence" as const, file: frame.file,
          ...(frame.hash ? { hash: frame.hash } : {}),
          ...(frame.timestampSeconds !== undefined ? { timestampSeconds: frame.timestampSeconds } : {}),
          ...(frame.frame !== undefined ? { frame: frame.frame } : {}),
          ...(frame.shotId ? { shotId: frame.shotId } : {}),
        },
      })),
      ...references.map((reference) => ({
        file: reference.file,
        meta: { id: reference.label, label: reference.label, kind: "reference" as const, file: reference.file.name },
      })),
    ].slice(0, 9);
    visualImages.forEach((image, index) => { values[`frame${index + 1}`] = image.file; });
    const { outputs } = await this.runner.runTexts(this.app, values, input.signal);
    const rawText = outputs[0]?.text ?? "";
    const parsed = jsonObject(rawText);
    const limitations = strings(parsed.limitations, 30);
    const uncertainties = strings(parsed.uncertainties, 30);
    const characters = (Array.isArray(parsed.characters) ? parsed.characters : []).map((entry: any) => ({
      description: String(entry?.description ?? "").trim(),
      identityMatch: ["matches", "probable", "uncertain", "not_observable"].includes(String(entry?.identity_match))
        ? String(entry.identity_match) as "matches" | "probable" | "uncertain" | "not_observable"
        : "uncertain" as const,
      ...(entry?.identity_subject ? { identitySubject: String(entry.identity_subject) } : {}),
      ...(entry?.clothing ? { clothing: String(entry.clothing) } : {}),
      ...(entry?.hair ? { hair: String(entry.hair) } : {}),
      ...(entry?.physical_appearance ? { physicalAppearance: String(entry.physical_appearance) } : {}),
      evidenceIds: evidenceIds(entry?.evidence_ids, allowed, limitations),
      ...(strings(entry?.uncertainties).length ? { uncertainties: strings(entry.uncertainties) } : {}),
    })).filter((entry: any) => entry.description);
    const mapList = (value: unknown, keys: string[]) => (Array.isArray(value) ? value : []).map((entry: any) => {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (entry?.[key] !== undefined) out[key] = String(entry[key]);
      out.evidenceIds = evidenceIds(entry?.evidence_ids, allowed, limitations);
      return out;
    });
    const visual: ObservationVisual = {
      characters,
      ...(parsed.location && typeof parsed.location === "object" ? {
        location: {
          description: String((parsed.location as any).description ?? ""),
          evidenceIds: evidenceIds((parsed.location as any).evidence_ids, allowed, limitations),
          confidence: asConfidence((parsed.location as any).confidence),
        },
      } : {}),
      props: mapList(parsed.props, ["description", "state"]).filter((entry: any) => entry.description) as ObservationVisual["props"],
      actions: mapList(parsed.actions, ["description"]).filter((entry: any) => entry.description) as ObservationVisual["actions"],
      composition: mapList(parsed.composition, ["description"]).filter((entry: any) => entry.description) as ObservationVisual["composition"],
      expressions: mapList(parsed.expressions, ["description"]).filter((entry: any) => entry.description) as ObservationVisual["expressions"],
      artifacts: mapList(parsed.artifacts, ["description"]).filter((entry: any) => entry.description) as ObservationVisual["artifacts"],
      ...(parsed.opening_state && typeof parsed.opening_state === "object" ? {
        openingState: { description: String((parsed.opening_state as any).description ?? ""), evidenceIds: evidenceIds((parsed.opening_state as any).evidence_ids, allowed, limitations) },
      } : {}),
      ...(parsed.closing_state && typeof parsed.closing_state === "object" ? {
        closingState: { description: String((parsed.closing_state as any).description ?? ""), evidenceIds: evidenceIds((parsed.closing_state as any).evidence_ids, allowed, limitations) },
      } : {}),
      uncertainties,
      claims: (Array.isArray(parsed.claims) ? parsed.claims : []).map((claim: any) => ({
        text: String(claim?.text ?? "").trim(),
        evidenceIds: evidenceIds(claim?.evidence_ids, allowed, limitations),
        confidence: asConfidence(claim?.confidence),
      })).filter((claim: any) => claim.text),
    };
    if (!characters.length && !visual.actions.length && !visual.claims.length) {
      limitations.push("The observer returned no evidence-backed visual claims; the visual stage is inconclusive.");
    }
    return {
      visual, model: this.model, version: this.version, promptVersion: this.promptVersion,
      configuration: { maxImages: 9, frames: frames.length, referenceFrames: references.length, temperature: 0.1, maxLength: 6144 },
      rawText, systemPrompt: VISUAL_OBSERVER_SYSTEM_PROMPT, inputPrompt: prompt,
      images: visualImages.map((image, index) => ({ order: index + 1, ...image.meta })),
    };
  }

  async compare(input: {
    intended: string;
    candidatePrompt: string;
    canonicalOpening: string;
    observation: Pick<ObservationReport, "visual" | "dialogue" | "technical" | "shots" | "evidence">;
    coverage: string;
    signal?: AbortSignal;
  }): Promise<ComparisonResult> {
    const prompt = comparisonPrompt({ ...input, observationJson: input.observation });
    const { outputs } = await this.runner.runTexts(this.app, {
      system_prompt: COMPARISON_SYSTEM_PROMPT, prompt,
    }, input.signal);
    const rawText = outputs[0]?.text ?? "";
    const parsed = jsonObject(rawText);
    const allowed = new Set(input.observation.evidence.map((entry) => entry.id));
    const limitations = strings(parsed.limitations, 30);
    const findings: ObservationFinding[] = (Array.isArray(parsed.findings) ? parsed.findings : []).map((finding: any, index: number) => {
      const ids = evidenceIds(finding?.evidence_ids, allowed, limitations);
      let classification = asConfidence(finding?.classification, "not_observable");
      let rationale = String(finding?.rationale ?? "").trim();
      if (!ids.length && (classification === "confirmed" || classification === "probable")) {
        classification = "not_observable";
        rationale = `${rationale}${rationale ? " " : ""}No supplied visual or audio evidence id supports this finding; it was downgraded during validation.`.trim();
        limitations.push(`Comparison finding ${index + 1} had no valid evidence id and was downgraded from the model's stated classification.`);
      }
      return {
        id: `finding-${String(index + 1).padStart(3, "0")}`,
        category: ["character", "wardrobe", "prop", "action", "dialogue", "event", "location", "continuity", "creative_deviation", "coverage"].includes(String(finding?.category))
          ? String(finding.category) as ObservationFinding["category"] : "coverage",
        expected: String(finding?.expected ?? "").trim(),
        observed: String(finding?.observed ?? "").trim(),
        classification,
        rationale,
        evidenceIds: ids,
      };
    }).filter((finding: ObservationFinding) => finding.expected || finding.observed);
    const proposedChanges: FactChange[] = (Array.isArray(parsed.proposed_changes) ? parsed.proposed_changes : [])
      .map((change: any) => ({
        op: change?.op === "update" ? "update" as const : "add" as const,
        category: ["identity", "state", "episodic", "narrative"].includes(String(change?.category)) ? String(change.category) as FactChange["category"] : "state" as const,
        text: String(change?.text ?? "").trim(),
        subjectIds: strings(change?.subject_ids).length ? strings(change.subject_ids) : undefined,
        tags: strings(change?.tags).length ? strings(change.tags) : ["observed-proposal"],
        phase: ["opening", "closing", "global"].includes(String(change?.phase)) ? String(change.phase) as FactChange["phase"] : "opening" as const,
      }))
      .filter((change: FactChange) => change.text);
    return {
      comparison: {
        findings, proposedChanges,
        limitations: [...limitations, "Comparison is evidence-backed; absent evidence is never treated as proof of absence."],
        comparedAt: new Date().toISOString(), comparisonPromptVersion: COMPARISON_PROMPT_VERSION,
      },
      rawText, promptVersion: COMPARISON_PROMPT_VERSION,
      systemPrompt: COMPARISON_SYSTEM_PROMPT, inputPrompt: prompt,
    };
  }
}

export class WhisperTurboAsr implements AsrAdapter {
  private readonly runner: Runner;
  private readonly app: App;

  constructor(runner: Runner, app: App) {
    this.runner = runner;
    this.app = app;
  }

  async transcribe(input: { audio: string; offsetSeconds: number; bindingId: string; signal?: AbortSignal }): Promise<ObservationDialogue> {
    const audio: FileValue = { bytes: new Uint8Array(readFileSync(input.audio)), name: basename(input.audio), type: "audio/wav" };
    const { outputs } = await this.runner.runTexts(this.app, {
      audio, model: "large-v3-turbo", device: "auto", task: "transcribe",
      language: "", beam_size: 5, word_timestamps: false,
    }, input.signal);
    const transcript = outputs.find((output) => output.nodeId === "save_transcript")?.text ?? outputs[0]?.text ?? "";
    const segmentsRaw = outputs.find((output) => output.nodeId === "save_segments")?.text ?? "";
    let segments: any[] = [];
    try { segments = JSON.parse(segmentsRaw); } catch { /* a missing segments output is a limitation, not a reason to invent timestamps */ }
    const utterances: ObservationUtterance[] = (Array.isArray(segments) ? segments : []).map((segment: any, index: number) => {
      const start = Number(segment?.start ?? 0) + input.offsetSeconds;
      const end = Number(segment?.end ?? segment?.start ?? 0) + input.offsetSeconds;
      const text = String(segment?.text ?? "").trim();
      return {
        id: `utterance-${String(index + 1).padStart(3, "0")}`,
        startSeconds: +Math.max(0, start).toFixed(3), endSeconds: +Math.max(start, end).toFixed(3),
        startFrame: Math.round(start * 24), endFrame: Math.round(Math.max(start, end) * 24),
        text,
        ...(segment?.language ? { language: String(segment.language) } : {}),
        confidence: null,
        speaker: { label: "Unattributed speaker", attribution: "unknown" as const },
        unclear: !text || /\[(?:unclear|music|inaudible)\]/i.test(text),
        evidenceIds: [],
      };
    }).filter((utterance: ObservationUtterance) => utterance.text);
    return {
      provider: "whisper-turbo", model: "large-v3-turbo", text: transcript, utterances,
      limitations: [
        "ASR only: language, voice identity, acting quality, mixing and lip sync are not verified.",
        "Speaker attribution is unknown; no diarization or face/voice matching was performed.",
        "Confidence scores are unavailable from this Whisper Turbo adapter.",
        "ASR text is never corrected against the screenplay and is not evidence of intended dialogue.",
      ],
      evidenceIds: [],
      rawTranscript: transcript, rawSegments: segmentsRaw,
    };
  }
}

export function mergeDialogue(parts: ObservationDialogue[], evidenceIds: string[]): ObservationDialogue {
  const utterances = parts.flatMap((part) => part.utterances).sort((a, b) => a.startSeconds - b.startSeconds)
    .map((utterance, index) => ({ ...utterance, id: `utterance-${String(index + 1).padStart(3, "0")}`, evidenceIds }));
  return {
    provider: parts.some((part) => part.provider === "whisper-turbo") ? "whisper-turbo" : "none",
    ...(parts.find((part) => part.model)?.model ? { model: parts.find((part) => part.model)!.model } : {}),
    text: parts.map((part) => part.text).filter(Boolean).join(" ").trim(),
    ...(parts.find((part) => part.language)?.language ? { language: parts.find((part) => part.language)!.language } : {}),
    utterances,
    limitations: [...new Set(parts.flatMap((part) => part.limitations))],
    evidenceIds,
  };
}
