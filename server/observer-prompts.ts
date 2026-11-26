// Phase 1 observer prompts. These are deliberately separate from the Director's
// cinematic prompt-writer prompts: the first visual pass never receives the intent.
import type { ObservationEvidence, ObservationShot, ObservationTechnical } from "./production-types.ts";

export const OBSERVER_VERSION = "phase1-observer";
export const OBSERVER_PROMPT_VERSION = "visual-independent-v2";
export const COMPARISON_PROMPT_VERSION = "intent-observation-compare-v2";

export const VISUAL_OBSERVER_SYSTEM_PROMPT = `You are Riverfield's independent audiovisual observer.
You describe only what is visible in the supplied evidence images. You never receive, infer or repeat an intended screenplay in this pass.
Treat every image as a sampled frame, not as a complete record of the video. An object or person absent from a frame may exist outside the sample.
Do not identify a character as a named production character unless the visual evidence itself makes that identity clear. If a reference image is supplied, compare appearance only and state uncertainty; a supplied reference does not prove that character appears.
Report concrete observable details: people, approximate identity match, hair, clothing, body appearance, location, props and their visible state, actions and reactions, framing, camera changes, facial expression and body language, the opening frame state, the closing frame state, visible artifacts, and anything unobservable.
Every meaningful factual claim must cite one or more frame ids from the supplied mapping. If you cannot support a claim with a frame id, put it under uncertainties or limitations instead.
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
}): string {
  const frameLines = input.frames.map((frame, index) =>
    `${index + 1}. ${frame.id} · ${frame.timestampSeconds?.toFixed(3) ?? "?"}s · frame ${frame.frame ?? "?"} · ${frame.kind}${frame.shotId ? ` · ${frame.shotId}` : ""}`,
  );
  const shotLines = input.shots.map((shot) =>
    `${shot.id}: ${shot.startSeconds.toFixed(3)}–${shot.endSeconds.toFixed(3)}s (frames ${shot.startFrame}–${shot.endFrame}, ${shot.detector})`,
  );
  return [
    "EVIDENCE MAP — images are supplied in this exact order.",
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

export function comparisonPrompt(input: {
  intended: string;
  canonicalOpening: string;
  observationJson: unknown;
  coverage: string;
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
    visual: value?.visual ?? null,
    dialogue: value?.dialogue ?? null,
  });
  return [
    "A. INTENDED SCENE (the Director's intent; not evidence):",
    input.intended || "(no scene brief was recorded)",
    "",
    "C. CANONICAL OPENING CONTEXT (approved memory only; may legitimately be empty):",
    input.canonicalOpening || "(no approved opening facts)",
    "",
    "B. INDEPENDENT OBSERVATION (actual rendered evidence; do not alter it):",
    JSON.stringify(compact(input.observationJson), null, 2),
    "",
    `COVERAGE LIMITATIONS: ${input.coverage}`,
    "",
    "Compare A, B and C. Report evidence-backed discrepancies and beneficial deviations. Use not_observable when the sampled frames cannot decide. Propose memory changes only as proposals.",
  ].join("\n");
}
