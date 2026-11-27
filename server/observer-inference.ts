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
  ObservationVisual, ObservationAudiovisual, ObservationAudiovisualClaim, ObservationNativeEvidence, FactChange,
} from "./production-types.ts";
import {
  AUDIOVISUAL_OBSERVER_PROMPT_VERSION, AUDIOVISUAL_OBSERVER_SYSTEM_PROMPT,
  COMPARISON_PROMPT_VERSION, COMPARISON_SYSTEM_PROMPT, COMPARISON_SYSTEM_PROMPT_BUILD, OBSERVER_PROMPT_VERSION, OBSERVER_VERSION,
  VISUAL_OBSERVER_SYSTEM_PROMPT, audiovisualObserverPrompt, comparisonPrompt, visualObserverPrompt,
} from "./observer-prompts.ts";
import { ObservationError } from "./observation-evidence.ts";
import { validateComparisonPayload } from "./comparison-validation.ts";
import type { DialogueAlignment, IntendedBrief } from "./dialogue-alignment.ts";
import type { AnalysisImage } from "./evidence-images.ts";

export type VisualObserverResult = {
  visual: ObservationVisual;
  model: string;
  version: string;
  promptVersion: string;
  configuration: Record<string, unknown>;
  inputModalities?: { text: true; image: true; video: boolean; audio: boolean };
  observationMode?: "visual" | "audiovisual";
  audiovisual?: ObservationAudiovisual;
  analysisImages?: AnalysisImage[];
  nativeEvidence?: ObservationNativeEvidence[];
  checkpoint?: { file: string; quantization: string; clipType: string; family: string };
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
  jobId?: string;
  proposalRejections?: import("./production-types.ts").RejectedProposal[];
  model?: string;
  configuration?: Record<string, unknown>;
  inputModalities?: { text: true; image: boolean; video: boolean; audio: boolean };
  checkpoint?: { file: string; quantization: string; clipType: string; family: string };
  systemPrompt?: string;
  inputPrompt?: string;
};

export interface VisualObserver {
  observe(input: {
    technical: ObservationTechnical;
    shots: ObservationShot[];
    frames: ObservationEvidence[];
    referenceFiles?: { label: string; file: FileValue }[];
    video?: FileValue;
    audio?: FileValue;
    nativeEvidence?: ObservationNativeEvidence[];
    analysisImages?: AnalysisImage[];
    signal?: AbortSignal;
  }): Promise<VisualObserverResult>;
}

export interface SceneComparator {
  compare(input: {
    intended: string;
    canonicalOpening: string;
    observation: Pick<ObservationReport, "visual" | "audiovisual" | "nativeEvidence" | "dialogue" | "technical" | "shots" | "evidence">;
    coverage: string;
    dialogueAlignment?: DialogueAlignment;
    intendedBrief?: IntendedBrief;
    continuityConstraints?: string;
    allowCanonicalProposals?: boolean;
    onRawResponse?: (meta: { rawText: string; jobId?: string; systemPrompt: string; inputPrompt: string }) => void;
    signal?: AbortSignal;
  }): Promise<ComparisonResult>;
}

export interface AsrAdapter {
  transcribe(input: { audio: string; offsetSeconds: number; fps: number; bindingId: string; signal?: AbortSignal }): Promise<ObservationDialogue>;
}

export interface AudioUnderstandingAdapter {
  analyse(input: { audio: string; transcript: ObservationDialogue; signal?: AbortSignal }): Promise<Record<string, unknown>>;
}

const asConfidence = (value: unknown, fallback: ObservationConfidence = "uncertain", field = "confidence"): ObservationConfidence => {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value);
  if (!["confirmed", "probable", "uncertain", "not_observable"].includes(normalized)) {
    throw new ObservationError("OBSERVER_SCHEMA_INVALID", `${field} has unsupported value ${normalized}`);
  }
  return normalized as ObservationConfidence;
};

const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const soundPattern = /\b(sound effect|pin drop|pop|clink|audio|music|soundtrack|sting|whoosh|rustle|footstep|scream|laugh track)\b/i;
const stylePattern = /\b(sweat drop|sweat drops|blush|blushing|speed line|speed lines|sparkle|sparkles|shock cross|cartoon pop|anime effect|aura|glow)\b/i;

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => { const k = key(item); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

function dialogueMatch(expected: string, observed: string, stated?: unknown): "exact" | "partial" | "mismatch" | "none" {
  const statedMatch = ["exact", "partial", "mismatch", "none"].includes(String(stated)) ? String(stated) as "exact" | "partial" | "mismatch" | "none" : null;
  const clean = (text: string) => norm(text.replace(/^s\d+\s*:\s*/i, "").replace(/^asr\s*:\s*/i, "").replace(/^["'“”]+|["'“”]+$/g, ""));
  const e = clean(expected), o = clean(observed);
  if (!e || !o) return statedMatch ?? "none";
  if (e === o) return "exact";
  if (o.includes(e) || e.includes(o)) return "partial";
  if (statedMatch) return statedMatch;
  return "mismatch";
}

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

function parseRaw(text: string): Record<string, unknown> {
  try { return jsonObject(text); }
  catch (error) {
    (error as Error & { rawText?: string }).rawText = text;
    throw error;
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

export type ObserverBackendOptions = {
  /** Exact CLIPLoader checkpoint filename and recipe, not just a report label. */
  model?: string;
  clipType?: string;
  maxImages?: number;
  /** Identity references are separate from evidence frames; total images still <= maxImages. */
  maxReferenceImages?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  seed?: number;
  thinking?: boolean;
  /** Optional immutable checkpoint identity for the report. */
  checkpoint?: { file: string; quantization: string; clipType: string; family: string };
};

export class QwenVisualObserver implements VisualObserver, SceneComparator {
  readonly model: string;
  readonly version = OBSERVER_VERSION;
  readonly promptVersion = OBSERVER_PROMPT_VERSION;
  private readonly runner: Runner;
  private readonly app: App;
  private readonly maxImages: number;
  private readonly maxReferenceImages: number;
  private readonly maxOutputTokens: number;
  private readonly temperature: number;
  private readonly clipType: string;
  private readonly topK: number;
  private readonly topP: number;
  private readonly seed: number;
  private readonly thinking: boolean;
  private readonly checkpoint?: ObserverBackendOptions["checkpoint"];

  constructor(runner: Runner, app: App, options: ObserverBackendOptions = {}) {
    this.runner = runner;
    this.app = app;
    this.model = options.model ?? "qwen3.8_27b_w4a8.safetensors";
    this.clipType = options.clipType ?? "stable_diffusion";
    this.maxImages = Math.max(1, Math.min(9, options.maxImages ?? 9));
    this.maxReferenceImages = Math.max(0, Math.min(9, options.maxReferenceImages ?? 9));
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.temperature = options.temperature ?? 0.1;
    this.topK = options.topK ?? 64;
    this.topP = options.topP ?? 0.9;
    this.seed = options.seed ?? 0;
    this.thinking = options.thinking ?? false;
    this.checkpoint = options.checkpoint;
  }

  private graphValues(): Record<string, unknown> {
    return {
      observer_model: this.model,
      observer_clip_type: this.clipType,
      temperature: this.temperature,
      max_output_tokens: this.maxOutputTokens,
      top_k: this.topK,
      top_p: this.topP,
      seed: this.seed,
      thinking: this.thinking,
    };
  }

  async observe(input: {
    technical: ObservationTechnical;
    shots: ObservationShot[];
    frames: ObservationEvidence[];
    referenceFiles?: { label: string; file: FileValue }[];
    video?: FileValue;
    audio?: FileValue;
    nativeEvidence?: ObservationNativeEvidence[];
    analysisImages?: AnalysisImage[];
    signal?: AbortSignal;
  }): Promise<VisualObserverResult> {
    const references = input.referenceFiles ?? [];
    if (input.frames.length > this.maxImages) {
      throw new ObservationError("OBSERVER_IMAGE_BUDGET", `The visual pass was given ${input.frames.length} evidence frames but the workflow has ${this.maxImages} image slots`);
    }
    if (references.length > this.maxReferenceImages) {
      throw new ObservationError("OBSERVER_REFERENCE_BUDGET", `The visual pass was given ${references.length} identity references but the configured reference budget is ${this.maxReferenceImages}`);
    }
    if (input.frames.length + references.length > this.maxImages) {
      throw new ObservationError("OBSERVER_IMAGE_BUDGET", `Evidence frames and identity references total ${input.frames.length + references.length}, over the workflow capacity of ${this.maxImages}`);
    }
    const frames = input.frames;
    const nativeEvidence = input.nativeEvidence ?? [];
    const analysisImages = input.analysisImages ?? [];
    if (analysisImages.length && analysisImages.length !== frames.length + references.length) {
      throw new ObservationError("OBSERVER_ANALYSIS_IMAGE_COUNT", `Analysis image count ${analysisImages.length} does not match ${frames.length} frames + ${references.length} references`);
    }
    const audiovisualMode = Boolean(input.video || input.audio);
    const aliases = new Map(analysisImages.filter((image) => image.kind === "evidence").map((image) => [image.alias, image.evidenceId]));
    const allowed = new Set([...frames.map((frame) => frame.id), ...aliases.keys()]);
    const audiovisualAllowed = new Set([...allowed, ...nativeEvidence.map((item) => item.id)]);
    const resolveVisualIds = (value: unknown, limitations: string[]) =>
      evidenceIds(value, allowed, limitations).map((id) => aliases.get(id) ?? id);
    const resolveAvIds = (value: unknown, limitations: string[]) =>
      evidenceIds(value, audiovisualAllowed, limitations).map((id) => aliases.get(id) ?? id);
    const prompt = audiovisualMode
      ? audiovisualObserverPrompt({
          technical: input.technical, shots: input.shots, frames, nativeEvidence,
          referenceLabels: references.map((reference) => reference.label),
          analysisImages,
        })
      : visualObserverPrompt({
          technical: input.technical, shots: input.shots, frames,
          referenceLabels: references.map((reference) => reference.label),
          analysisImages,
        });
    const systemPrompt = audiovisualMode ? AUDIOVISUAL_OBSERVER_SYSTEM_PROMPT : VISUAL_OBSERVER_SYSTEM_PROMPT;
    const values: Record<string, unknown> = {
      ...this.graphValues(),
      system_prompt: systemPrompt,
      prompt,
      ...(input.video ? { video1: input.video } : {}),
      ...(input.audio ? { audio1: input.audio } : {}),
    };
    const analysisVisualImages = analysisImages.map((image) => ({
      file: { bytes: new Uint8Array(readFileSync(image.derivativePath)), name: basename(image.derivativePath), type: "image/jpeg" } as FileValue,
      meta: {
        id: image.alias, label: image.label, kind: image.kind, file: image.derivativePath,
        evidenceId: image.evidenceId, originalHash: image.originalHash, hash: image.derivativeHash,
        ...(image.timestampSeconds !== undefined ? { timestampSeconds: image.timestampSeconds } : {}),
        ...(image.frame !== undefined ? { frame: image.frame } : {}),
        ...(image.shotId ? { shotId: image.shotId } : {}),
      },
    }));
    const visualImages = analysisVisualImages.length ? analysisVisualImages : [
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
    ];
    visualImages.forEach((image, index) => { values[`frame${index + 1}`] = image.file; });
    const { outputs } = await this.runner.runTexts(this.app, values, input.signal);
    const rawText = outputs[0]?.text ?? "";
    const parsed = parseRaw(rawText);
    const limitations = strings(parsed.limitations, 30);
    const uncertainties = strings(parsed.uncertainties, 30);
    const characters = dedupeBy((Array.isArray(parsed.characters) ? parsed.characters : []).map((entry: any) => ({
      description: String(entry?.description ?? "").trim(),
      identityMatch: ["matches", "probable", "uncertain", "not_observable"].includes(String(entry?.identity_match))
        ? String(entry.identity_match) as "matches" | "probable" | "uncertain" | "not_observable"
        : "uncertain" as const,
      ...(entry?.identity_subject ? { identitySubject: String(entry.identity_subject) } : {}),
      ...(entry?.clothing ? { clothing: String(entry.clothing) } : {}),
      ...(entry?.hair ? { hair: String(entry.hair) } : {}),
      ...(entry?.physical_appearance ? { physicalAppearance: String(entry.physical_appearance) } : {}),
      evidenceIds: resolveVisualIds(entry?.evidence_ids, limitations),
      ...(strings(entry?.uncertainties).length ? { uncertainties: strings(entry.uncertainties) } : {}),
    })).filter((entry: any) => entry.description), (entry: any) => norm(entry.description));
    const mapList = (value: unknown, keys: string[]) => (Array.isArray(value) ? value : []).map((entry: any) => {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (entry?.[key] !== undefined) out[key] = String(entry[key]);
      out.evidenceIds = resolveVisualIds(entry?.evidence_ids, limitations);
      return out;
    });
    const visual: ObservationVisual = {
      characters,
      ...(parsed.location && typeof parsed.location === "object" ? {
        location: {
          description: String((parsed.location as any).description ?? ""),
          evidenceIds: resolveVisualIds((parsed.location as any).evidence_ids, limitations),
          confidence: asConfidence((parsed.location as any).confidence),
        },
      } : {}),
      props: mapList(parsed.props, ["description", "state"]).filter((entry: any) => entry.description) as ObservationVisual["props"],
      actions: mapList(parsed.actions, ["description"]).filter((entry: any) => entry.description) as ObservationVisual["actions"],
      composition: mapList(parsed.composition, ["description"]).filter((entry: any) => entry.description) as ObservationVisual["composition"],
      expressions: mapList(parsed.expressions, ["description"]).filter((entry: any) => entry.description) as ObservationVisual["expressions"],
      stylisticEffects: [],
      artifacts: [],
      ...(parsed.opening_state && typeof parsed.opening_state === "object" ? {
        openingState: { description: String((parsed.opening_state as any).description ?? ""), evidenceIds: resolveVisualIds((parsed.opening_state as any).evidence_ids, limitations) },
      } : {}),
      ...(parsed.closing_state && typeof parsed.closing_state === "object" ? {
        closingState: { description: String((parsed.closing_state as any).description ?? ""), evidenceIds: resolveVisualIds((parsed.closing_state as any).evidence_ids, limitations) },
      } : {}),
      uncertainties,
      claims: dedupeBy((Array.isArray(parsed.claims) ? parsed.claims : []).map((claim: any) => ({
        text: String(claim?.text ?? "").trim(),
        evidenceIds: resolveVisualIds(claim?.evidence_ids, limitations),
        confidence: asConfidence(claim?.confidence),
      })).filter((claim: any) => claim.text), (claim: any) => norm(claim.text)),
    };
    visual.props = dedupeBy(visual.props, (entry) => norm(entry.description));
    visual.actions = dedupeBy(visual.actions, (entry) => norm(entry.description));
    visual.composition = dedupeBy(visual.composition, (entry) => norm(entry.description));
    visual.expressions = dedupeBy(visual.expressions, (entry) => norm(entry.description));
    const styled = mapList(parsed.stylistic_effects, ["description"]).filter((entry: any) => entry.description) as ObservationVisual["artifacts"];
    const artifacts = mapList(parsed.artifacts, ["description"]).filter((entry: any) => entry.description) as ObservationVisual["artifacts"];
    visual.stylisticEffects = dedupeBy([...styled, ...artifacts.filter((entry) => stylePattern.test(entry.description))], (entry) => norm(entry.description));
    visual.artifacts = dedupeBy(artifacts.filter((entry) => !stylePattern.test(entry.description)), (entry) => norm(entry.description));
    let audiovisual: ObservationAudiovisual | undefined;
    if (audiovisualMode) {
      const rawAv = parsed.audiovisual && typeof parsed.audiovisual === "object" && !Array.isArray(parsed.audiovisual)
        ? parsed.audiovisual as Record<string, unknown> : null;
      const avList = (value: unknown): ObservationAudiovisualClaim[] => (Array.isArray(value) ? value : []).map((entry: any) => ({
        description: String(entry?.description ?? "").trim(),
        evidenceIds: resolveAvIds(entry?.evidence_ids, limitations),
        confidence: asConfidence(entry?.confidence),
      })).filter((entry) => entry.description);
      const avLimitations = rawAv ? strings(rawAv.limitations, 30) : [];
      if (!rawAv) limitations.push("The audiovisual observer returned no audiovisual contract; audio/video findings are unavailable.");
      audiovisual = {
        mode: "audiovisual",
        supplied: {
          ...(nativeEvidence.find((item) => item.kind === "video") ? { videoId: nativeEvidence.find((item) => item.kind === "video")!.id } : {}),
          ...(nativeEvidence.find((item) => item.kind === "audio") ? { audioId: nativeEvidence.find((item) => item.kind === "audio")!.id } : {}),
        },
        temporalActions: avList(rawAv?.temporal_actions),
        dialogueAndReactions: avList(rawAv?.dialogue_and_reactions),
        music: avList(rawAv?.music),
        environmentalSound: avList(rawAv?.environmental_sound),
        soundEffects: avList(rawAv?.sound_effects),
        synchronization: avList(rawAv?.synchronization),
        voiceDelivery: avList(rawAv?.voice_delivery),
        audioArtifacts: avList(rawAv?.audio_artifacts),
        visualArtifacts: avList(rawAv?.visual_artifacts),
        limitations: avLimitations,
      };
    }
    if (!characters.length && !visual.actions.length && !visual.claims.length) {
      limitations.push("The observer returned no evidence-backed visual claims; the visual stage is inconclusive.");
    }
    return {
      visual, model: this.model, version: this.version,
      promptVersion: audiovisualMode ? AUDIOVISUAL_OBSERVER_PROMPT_VERSION : this.promptVersion,
      configuration: {
        clipType: this.clipType, maxImages: this.maxImages, maxReferenceImages: this.maxReferenceImages,
        frames: frames.length, referenceFrames: references.length,
        temperature: this.temperature, maxLength: this.maxOutputTokens, topK: this.topK, topP: this.topP, seed: this.seed, thinking: this.thinking,
        observationMode: audiovisualMode ? "audiovisual" : "visual",
        nativeEvidenceIds: nativeEvidence.map((item) => item.id),
        analysisImages: analysisImages.length,
      },
      inputModalities: { text: true, image: true, video: Boolean(input.video), audio: Boolean(input.audio) },
      observationMode: audiovisualMode ? "audiovisual" : "visual",
      ...(audiovisual ? { audiovisual } : {}),
      ...(analysisImages.length ? { analysisImages } : {}),
      nativeEvidence,
      ...(this.checkpoint ? { checkpoint: this.checkpoint } : {}),
      rawText, systemPrompt, inputPrompt: prompt,
      images: visualImages.map((image, index) => ({ order: index + 1, ...image.meta })),
    };
  }

  async compare(input: {
    intended: string;
    canonicalOpening: string;
    observation: Pick<ObservationReport, "visual" | "audiovisual" | "nativeEvidence" | "dialogue" | "technical" | "shots" | "evidence">;
    coverage: string;
    dialogueAlignment?: DialogueAlignment;
    intendedBrief?: IntendedBrief;
    continuityConstraints?: string;
    allowCanonicalProposals?: boolean;
    onRawResponse?: (meta: { rawText: string; jobId?: string; systemPrompt: string; inputPrompt: string }) => void;
    signal?: AbortSignal;
  }): Promise<ComparisonResult> {
    const allowCanonicalProposals = input.allowCanonicalProposals !== false;
    const systemPrompt = allowCanonicalProposals ? COMPARISON_SYSTEM_PROMPT : COMPARISON_SYSTEM_PROMPT_BUILD;
    const prompt = comparisonPrompt({
      ...input, observationJson: input.observation,
      dialogueAlignment: input.dialogueAlignment, intendedBrief: input.intendedBrief,
      continuityConstraints: input.continuityConstraints,
      allowCanonicalProposals,
    });
    const { job, outputs } = await this.runner.runTexts(this.app, {
      ...this.graphValues(),
      system_prompt: systemPrompt, prompt,
    }, input.signal);
    const rawText = outputs[0]?.text ?? "";
    input.onRawResponse?.({ rawText, jobId: job?.id, systemPrompt, inputPrompt: prompt });
    let validated;
    try {
      const parsed = parseRaw(rawText);
      validated = validateComparisonPayload(parsed, input.observation, {
        allowCanonicalProposals,
        comparisonPromptVersion: COMPARISON_PROMPT_VERSION,
      });
    } catch (error) {
      const enriched = error as Error & { rawText?: string; jobId?: string; systemPrompt?: string; inputPrompt?: string; proposalRejections?: unknown };
      enriched.rawText = rawText;
      enriched.jobId = job?.id;
      enriched.systemPrompt = systemPrompt;
      enriched.inputPrompt = prompt;
      throw enriched;
    }
    return {
      comparison: validated.comparison,
      proposalRejections: validated.proposalRejections,
      rawText, promptVersion: COMPARISON_PROMPT_VERSION,
      jobId: job?.id,
      model: this.model,
      configuration: {
        clipType: this.clipType, temperature: this.temperature, maxLength: this.maxOutputTokens,
        topK: this.topK, topP: this.topP, seed: this.seed, thinking: this.thinking,
      },
      inputModalities: { text: true, image: false, video: false, audio: false },
      ...(this.checkpoint ? { checkpoint: this.checkpoint } : {}),
      systemPrompt, inputPrompt: prompt,
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

  async transcribe(input: { audio: string; offsetSeconds: number; fps: number; bindingId: string; signal?: AbortSignal }): Promise<ObservationDialogue> {
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
        startFrame: Math.round(start * input.fps), endFrame: Math.round(Math.max(start, end) * input.fps),
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
