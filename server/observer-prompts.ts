// Phase 1 observer prompts. These are deliberately separate from the Director's
// cinematic prompt-writer prompts: the first visual pass never receives the intent.
import type { ObservationEvidence, ObservationNativeEvidence, ObservationShot, ObservationTechnical } from "./production-types.ts";
import type { DialogueAlignment, IntendedBrief } from "./dialogue-alignment.ts";
import type { AnalysisImage } from "./evidence-images.ts";

export const OBSERVER_VERSION = "phase1-observer";
export const OBSERVER_PROMPT_VERSION = "visual-independent-v2";
export const COMPARISON_PROMPT_VERSION = "intent-observation-compare-v2";
export const AUDIOVISUAL_OBSERVER_PROMPT_VERSION = "audiovisual-independent-v1";

export const VISUAL_OBSERVER_SYSTEM_PROMPT = `You are Riverfield's independent audiovisual observer.
You describe only what is visible in the supplied evidence images. You never receive, infer or repeat an intended screenplay in this pass.
Treat every image as a sampled frame, not as a complete record of the video. An object or person absent from a frame may exist outside the sample.
Do not identify a character as a named production character unless the visual evidence itself makes that identity clear. If a reference image is supplied, compare appearance only and state uncertainty; a supplied reference does not prove that character appears.
Report concrete observable details: people, approximate identity match, hair, clothing, body appearance, location, props and their visible state, actions and reactions, framing, camera changes, facial expression and body language, the opening frame state, the closing frame state, visible artifacts, and anything unobservable.
Every meaningful factual claim must cite one or more evidence aliases or frame ids from the supplied mapping. The alias mapping records the immutable evidence id; cite only an alias or id that appears in the mapping. If you cannot support a claim, put it under uncertainties or limitations instead.
Keep each claim atomic: do not combine a visible object/action with a sound, a previous movement, or an inferred cause. Do not repeat the same fact across sections. Put intentional stylistic effects (sweat drops, blush marks, speed lines, sparkles, shock crosses, cartoon pops that are visibly drawn) under stylistic_effects, and only unintended rendering defects under artifacts.
Never describe voice identity, acting quality, audio mixing or lip sync from images alone.
Return only one JSON object, no Markdown, no prose before or after it:
{
  "characters": [{"description":"...","identity_match":"matches|probable|uncertain|not_observable","identity_subject":"optional name or null","clothing":"...","hair":"...","physical_appearance":"...","evidence_ids":["frame-0001"],"uncertainties":["..."]}],
  "location": {"description":"...","evidence_ids":["frame-0001"],"confidence":"confirmed|probable|uncertain|not_observable"},
  "props": [{"description":"...","state":"...","evidence_ids":["frame-0001"]}],
  "actions": [{"description":"...","evidence_ids":["frame-0001"]}],
  "composition": [{"description":"...","evidence_ids":["frame-0001"]}],
  "expressions": [{"description":"...","evidence_ids":["frame-0001"]}],
  "stylistic_effects": [{"description":"...","evidence_ids":["frame-0001"]}],
  "artifacts": [{"description":"...","evidence_ids":["frame-0001"]}],
  "opening_state": {"description":"...","evidence_ids":["frame-0001"]},
  "closing_state": {"description":"...","evidence_ids":["frame-0001"]},
  "uncertainties": ["..."],
  "limitations": ["..."],
  "claims": [{"text":"...","evidence_ids":["frame-0001"],"confidence":"confirmed|probable|uncertain|not_observable"}]
}`;

export const AUDIOVISUAL_OBSERVER_SYSTEM_PROMPT = `You are Riverfield's independent audiovisual observer.
You describe only what the supplied sampled frames, native scene video and native scene audio actually show or sound like. You never receive, infer or repeat an intended screenplay, canonical text or previous comparison in this pass.
The native media are evidence, not proof that a model capability is reliable. State confidence and limitations explicitly. A model accepting audio or video input does not by itself prove that it heard or understood the content.
Visible claims must cite a supplied evidence alias or frame id. Native video claims may cite the native video id. Audio, music, sound-effect, voice-delivery and synchronization claims may cite the native audio id or native video id; they are not required to cite a visual frame.
Do not assume that an object, person or sound absent from the sample is absent from the whole scene. Do not infer dialogue or voice identity from images alone. Do not use the ASR transcript as if it were an intended screenplay; it is a separate evidence source.
Keep claims atomic: separate visible action, dialogue content, audible reaction, music, environmental sound, comedic effect, voice delivery, synchronization and artifacts. If you cannot support a claim with a valid evidence id, put it under limitations instead of inventing an id.
Return only one JSON object, no Markdown, no prose before or after it:
{
  "characters": [{"description":"...","identity_match":"matches|probable|uncertain|not_observable","identity_subject":"optional name or null","clothing":"...","hair":"...","physical_appearance":"...","evidence_ids":["frame-0001"],"uncertainties":["..."]}],
  "location": {"description":"...","evidence_ids":["frame-0001"],"confidence":"confirmed|probable|uncertain|not_observable"},
  "props": [{"description":"...","state":"...","evidence_ids":["frame-0001"]}],
  "actions": [{"description":"...","evidence_ids":["frame-0001"]}],
  "composition": [{"description":"...","evidence_ids":["frame-0001"]}],
  "expressions": [{"description":"...","evidence_ids":["frame-0001"]}],
  "stylistic_effects": [{"description":"...","evidence_ids":["frame-0001"]}],
  "artifacts": [{"description":"...","evidence_ids":["frame-0001"]}],
  "opening_state": {"description":"...","evidence_ids":["frame-0001"]},
  "closing_state": {"description":"...","evidence_ids":["frame-0001"]},
  "uncertainties": ["..."],
  "limitations": ["..."],
  "claims": [{"text":"...","evidence_ids":["frame-0001"],"confidence":"confirmed|probable|uncertain|not_observable"}],
  "audiovisual": {
    "temporal_actions": [{"description":"...","evidence_ids":["video-01"],"confidence":"confirmed|probable|uncertain|not_observable"}],
    "dialogue_and_reactions": [{"description":"...","evidence_ids":["audio-01"],"confidence":"confirmed|probable|uncertain|not_observable"}],
    "music": [{"description":"...","evidence_ids":["audio-01"],"confidence":"confirmed|probable|uncertain|not_observable"}],
    "environmental_sound": [{"description":"...","evidence_ids":["audio-01"],"confidence":"confirmed|probable|uncertain|not_observable"}],
    "sound_effects": [{"description":"...","evidence_ids":["audio-01"],"confidence":"confirmed|probable|uncertain|not_observable"}],
    "synchronization": [{"description":"...","evidence_ids":["video-01","audio-01"],"confidence":"confirmed|probable|uncertain|not_observable"}],
    "voice_delivery": [{"description":"...","evidence_ids":["audio-01"],"confidence":"confirmed|probable|uncertain|not_observable"}],
    "audio_artifacts": [{"description":"...","evidence_ids":["audio-01"],"confidence":"confirmed|probable|uncertain|not_observable"}],
    "visual_artifacts": [{"description":"...","evidence_ids":["frame-0001"],"confidence":"confirmed|probable|uncertain|not_observable"}],
    "limitations": ["..."]
  }
}`;

export const COMPARISON_SYSTEM_PROMPT = `You are Riverfield's comparison analyst. Compare three separate inputs:
A. the intended scene supplied by the production,
B. the independent observation of the actual rendered output,
C. the approved canonical opening context.
Never rewrite the observation or ASR transcript to match the intent. Never claim that something absent from sampled frames did not occur; use "not_observable" for missing visual coverage.
A finding is "confirmed" only when direct evidence supports it. "probable" needs strong indirect evidence. "uncertain" means plausible but underdetermined. "not_observable" means the evidence cannot decide. A creative deviation can be beneficial and must still be reported as a deviation, never silently accepted.
Keep findings atomic: a visible sweat drop never confirms a sound effect; holding a glass does not establish its liquid contents or a previous movement; a visual match does not establish voice identity. Split compound claims into separate findings. For dialogue, state whether the text is an exact match or a partial match. Do not repeat the same expected/observed pair. Limit the response to the necessary atomic findings.
You may propose State, Episodic and Narrative changes, but they are proposals for a human. Never approve a candidate, never canonize, and never change the Bible.
Return only one JSON object, no Markdown, no prose before or after it:
{
  "findings": [{"category":"character|wardrobe|prop|action|dialogue|event|location|continuity|creative_deviation|coverage","expected":"...","observed":"...","classification":"confirmed|probable|uncertain|not_observable","rationale":"...","evidence_ids":["frame-0001"],"dialogue_match":"exact|partial|mismatch|none"}],
  "proposed_changes": [{"op":"add|update","category":"identity|state|episodic|narrative","text":"...","subject_ids":["..."],"tags":["..."],"phase":"opening|closing|global","evidence_ids":["frame-0001"]}],
  "limitations": ["..."]
}`;

export function visualObserverPrompt(input: {
  technical: ObservationTechnical;
  shots: ObservationShot[];
  frames: ObservationEvidence[];
  referenceLabels?: string[];
  analysisImages?: AnalysisImage[];
}): string {
  const frameLines = (input.analysisImages?.length ? input.analysisImages : input.frames.map((frame, index) => ({
    alias: frame.id, evidenceId: frame.id, label: frame.id, timestampSeconds: frame.timestampSeconds, frame: frame.frame, kind: frame.kind, shotId: frame.shotId,
  } as any))).map((image: any, index: number) =>
    `${index + 1}. ${image.alias} → immutable ${image.evidenceId} · ${image.timestampSeconds?.toFixed(3) ?? "?"}s · frame ${image.frame ?? "?"} · ${image.kind}${image.shotId ? ` · ${image.shotId}` : ""}`,
  );
  const shotLines = input.shots.map((shot) =>
    `${shot.id}: ${shot.startSeconds.toFixed(3)}–${shot.endSeconds.toFixed(3)}s (frames ${shot.startFrame}–${shot.endFrame}, ${shot.detector})`,
  );
  return [
    "EVIDENCE MAP — model-facing aliases and immutable evidence ids, in this exact order. Cite the alias or immutable id exactly.",
    ...frameLines.map((line) => `- ${line}`),
    "",
    "DETECTED SHOTS (computed from FFmpeg scene changes and native segment boundaries):",
    ...(shotLines.length ? shotLines.map((line) => `- ${line}`) : ["- none"]),
    "",
    `TECHNICAL: ${input.technical.width ?? "?"}x${input.technical.height ?? "?"}, ${input.technical.fps} fps, ${input.technical.duration.toFixed(3)}s, scene frames ${input.technical.sceneStartFrame}–${input.technical.sceneEndFrame}.`,
    input.referenceLabels?.length ? `REFERENCE ASSETS (identity comparison only; not proof of appearance): ${input.referenceLabels.join(", ")}.` : "No reference assets were supplied to this pass.",
    "",
    "Describe the actual observed scene independently. Use the frame ids above. Do not use any intended prompt, screenplay or canonical text in this pass.",
  ].join("\n");
}

export function audiovisualObserverPrompt(input: {
  technical: ObservationTechnical;
  shots: ObservationShot[];
  frames: ObservationEvidence[];
  nativeEvidence: ObservationNativeEvidence[];
  referenceLabels?: string[];
  analysisImages?: AnalysisImage[];
}): string {
  const frameLines = (input.analysisImages?.length ? input.analysisImages : input.frames.map((frame, index) => ({
    alias: frame.id, evidenceId: frame.id, label: frame.id, timestampSeconds: frame.timestampSeconds, frame: frame.frame, kind: frame.kind, shotId: frame.shotId,
  } as any))).map((image: any, index: number) =>
    `${index + 1}. ${image.alias} → immutable ${image.evidenceId} · ${image.timestampSeconds?.toFixed(3) ?? "?"}s · frame ${image.frame ?? "?"} · ${image.kind}${image.shotId ? ` · ${image.shotId}` : ""}`,
  );
  const nativeLines = input.nativeEvidence.map((item) =>
    `${item.id} · ${item.kind} · ${item.startSeconds.toFixed(3)}–${item.endSeconds.toFixed(3)}s (${item.durationSeconds.toFixed(3)}s) · hash ${item.hash}${item.fps ? ` · ${item.fps} fps` : ""}${item.frameCount ? ` · ${item.frameCount} frames` : ""}${item.sampleRate ? ` · ${item.sampleRate} Hz` : ""}${item.backendPreprocessing ? ` · ${item.backendPreprocessing}` : ""}`,
  );
  const shotLines = input.shots.map((shot) =>
    `${shot.id}: ${shot.startSeconds.toFixed(3)}–${shot.endSeconds.toFixed(3)}s (frames ${shot.startFrame}–${shot.endFrame}, ${shot.detector})`,
  );
  const supplied = input.nativeEvidence.map((item) => item.id).join(", ") || "none";
  return [
    "EVIDENCE MAP — model-facing aliases and immutable evidence ids, in this exact order.",
    ...frameLines.map((line) => `- ${line}`),
    "",
    "NATIVE AUDIOVISUAL EVIDENCE — actual media supplied to the workflow:",
    ...(nativeLines.length ? nativeLines.map((line) => `- ${line}`) : ["- none"]),
    "",
    "DETECTED SHOTS:",
    ...(shotLines.length ? shotLines.map((line) => `- ${line}`) : ["- none"]),
    "",
    `TECHNICAL: ${input.technical.width ?? "?"}x${input.technical.height ?? "?"}, ${input.technical.fps} fps, ${input.technical.duration.toFixed(3)}s, scene frames ${input.technical.sceneStartFrame}–${input.technical.sceneEndFrame}.`,
    `NATIVE EVIDENCE IDS: ${supplied}. Use these exact ids for native-media citations.`,
    input.referenceLabels?.length ? `REFERENCE ASSETS (identity comparison only; not proof of appearance): ${input.referenceLabels.join(", ")}.` : "No reference assets were supplied to this pass.",
    "",
    "Describe the actual audiovisual scene independently. Do not use an intended prompt, screenplay or canonical context. Distinguish visible action from audible events and from synchronization. If the native media was supplied but you cannot establish a detail, use uncertainties or limitations rather than guessing.",
  ].join("\n");
}

export function comparisonPrompt(input: {
  intended: string;
  canonicalOpening: string;
  observationJson: unknown;
  coverage: string;
  dialogueAlignment?: DialogueAlignment;
  intendedBrief?: IntendedBrief;
  continuityConstraints?: string;
}): string {
  const compact = (value: any) => ({
    technical: value?.technical ? {
      width: value.technical.width, height: value.technical.height, fps: value.technical.fps,
      duration: value.technical.duration, sceneStartFrame: value.technical.sceneStartFrame,
      sceneEndFrame: value.technical.sceneEndFrame,
    } : null,
    shots: (value?.shots ?? []).map((shot: any) => ({ id: shot.id, startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, detector: shot.detector })),
    evidence: (value?.evidence ?? []).map((item: any) => ({
      id: item.id, kind: item.kind,
      ...(item.timestampSeconds !== undefined ? { timestampSeconds: item.timestampSeconds } : {}),
      ...(item.frame !== undefined ? { frame: item.frame } : {}),
      ...(item.shotId ? { shotId: item.shotId } : {}),
    })),
    nativeEvidence: (value?.nativeEvidence ?? []).map((item: any) => ({
      id: item.id, kind: item.kind, startSeconds: item.startSeconds, endSeconds: item.endSeconds,
      durationSeconds: item.durationSeconds,
      ...(item.fps !== undefined ? { fps: item.fps } : {}),
      ...(item.frameCount !== undefined ? { frameCount: item.frameCount } : {}),
      ...(item.sampleRate !== undefined ? { sampleRate: item.sampleRate } : {}),
    })),
    visual: value?.visual ?? null,
    audiovisual: value?.audiovisual ?? null,
  });
  const actionLines = (input.intendedBrief?.shots ?? []).map((shot) => `- Shot ${shot.index}: ${shot.text}`);
  const intendedById = new Map((input.dialogueAlignment?.intended ?? []).map((item) => [item.id, item]));
  const alignment = input.dialogueAlignment ? {
    matches: input.dialogueAlignment.matches.map((match) => ({
      intendedId: match.intendedId, intendedText: intendedById.get(match.intendedId)?.text,
      utteranceIds: match.utteranceIds, textMatch: match.textMatch,
      missingWords: match.missingWords, extraWords: match.extraWords, repeatedWords: match.repeatedWords,
      speaker: match.speaker, timing: match.timing, audioDelivery: match.audioDelivery, evidenceIds: match.evidenceIds,
    })),
    unmatchedIntended: input.dialogueAlignment.unmatchedIntended,
    unmatchedTranscript: input.dialogueAlignment.unmatchedTranscript,
    limitations: input.dialogueAlignment.limitations,
  } : null;
  return [
    "A. INTENDED SCENE (the Director's intent; not evidence):",
    input.intended || input.intendedBrief?.sceneBrief || "(no scene brief was recorded)",
    "",
    "INTENDED ACTIONS (deterministically extracted from the submitted prompt):",
    ...(actionLines.length ? actionLines : ["- none extracted"]),
    "",
    "INTENDED SOUNDSCAPE (separate requirement; actual fulfillment may be not_observable):",
    input.intendedBrief?.soundscape || "(none specified)",
    "",
    "INTENDED MUSIC (separate requirement; actual fulfillment may be not_observable):",
    input.intendedBrief?.music || "(none specified)",
    "",
    "DETERMINISTIC DIALOGUE ALIGNMENT (computed by code; inspect text, speaker, timing and audio delivery separately):",
    alignment ? JSON.stringify(alignment, null, 2) : "(not available)",
    "",
    "C. CANONICAL CONTINUITY CONSTRAINTS (approved memory; may legitimately be empty):",
    input.continuityConstraints || input.canonicalOpening || "(no approved continuity constraints)",
    "",
    "B. RELEVANT STRUCTURED OBSERVATION (actual rendered evidence; do not alter it):",
    JSON.stringify(compact(input.observationJson), null, 2),
    "",
    `COVERAGE LIMITATIONS: ${input.coverage}`,
    "",
    "Compare the compact structured observation against intended actions and the deterministic dialogue alignment. Do not perform your own word-level calculations. Use not_observable when the supplied evidence cannot decide. Propose memory changes only as proposals; unknown subjects, unsupported facts and invalid evidence must be rejected by the calling code.",
  ].join("\n");
}
