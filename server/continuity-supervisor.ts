// Senior continuity reasoning over already-recorded observations. This module performs no
// extraction, ASR or media generation. It makes exactly one explicit text+image inference
// call through the shared Runner and records the raw response beside the validated review.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Runner, FileValue } from "./runner.ts";
import type { ProductionSnapshot, ContinuityReview } from "./production-types.ts";
import { createObserverApp } from "./observer-app.ts";
import { observerModel } from "./observer-models.ts";
import { deriveObservedState, type ObservedStateRecord } from "./observed-state.ts";
import { buildContinuityConstraints } from "./production-context.ts";
import { P6_REFERENCE_WARNING } from "./asset-audit.ts";

export type SeniorContinuityInput = {
  store: { snapshot(id: string): ProductionSnapshot; recordContinuityReview(id: string, input: any, actor: any, commandKey?: string): ProductionSnapshot };
  runner: Runner;
  outDir: string;
  productionId: string;
  preparedReviewId: string;
  actor: { kind: "agent"; id: string };
};
export type SeniorContinuityResult = {
  review: ContinuityReview;
  artifactDir: string;
  request: Record<string, unknown>;
  output: Record<string, any>;
};

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const asText = (value: unknown) => String(value ?? "").trim();
const json = (value: unknown) => JSON.stringify(value, null, 2);
const truncate = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export const SENIOR_CONTINUITY_SYSTEM_PROMPT = `You are Riverfield's senior continuity reviewer. You independently challenge an earlier deterministic continuity baseline; do not merely summarize it.

Rules:
- Use only the supplied evidence, corrected temporal state records, transcripts and baseline findings. The screenplay/candidate prompt describes intent, never proof of the rendered result.
- A sampled missing view is insufficient_evidence, not proof of absence or a dry state.
- Distinguish persistent state from intentional change. Do not infer that a late event happened at the opening.
- Dialogue findings must cite transcript/audio evidence. Visual frames cannot prove pronunciation or exact wording.
- Treat the historical P6 reference contamination as a limitation on the P6 observation.
- Do not recommend regeneration without a material, sufficiently supported contradiction. Prefer keep_existing_candidate when no material contradiction is supported.
- Do not approve candidates, create canonical proposals, modify the Bible or claim that any finding is canonical.
- Return one JSON object only, with the exact requested schema. No markdown fences, no commentary outside the JSON.`;

const OUTPUT_SCHEMA = `{
  "schemaVersion": 1,
  "textBasedOnly": false,
  "suppliedEvidence": ["P4-OPEN", "P4-CLOSE"],
  "findings": [{
    "id": "finding-001",
    "category": "bathroom_consequences|temporary_wetness|persistent_props|key_fob|reference_contamination|offscreen_transition|dialogue|state_correction|other",
    "classification": "compatible|confirmed_contradiction|probable_contradiction|accepted_deviation_candidate|plausible_offscreen_transition|insufficient_evidence",
    "scenes": ["P4", "P5"],
    "summary": "short finding",
    "rationale": "evidence-grounded rationale",
    "evidenceAliases": ["P4-CLOSE"],
    "confidence": "confirmed|probable|uncertain|not_observable",
    "baselineComparison": "confirms|challenges|adds|insufficient|not_in_baseline",
    "baselineFindingId": "optional baseline transition id",
    "dialogueEvidence": ["P4-AUDIO"]
  }],
  "correctionPlans": [{
    "id": "plan-001",
    "action": "keep_existing_candidate|accept_creative_deviation|request_targeted_evidence|request_human_audio_review|request_human_visual_review|correct_asset_association|refine_next_scene_opening|prepare_director_correction|recommend_regeneration",
    "scenes": ["P4", "P5"],
    "findingIds": ["finding-001"],
    "summary": "short recommendation",
    "rationale": "evidence-grounded rationale",
    "evidenceAliases": ["P4-CLOSE"],
    "estimatedScope": "targeted or scene-wide",
    "requiresHumanApproval": true
  }],
  "uncertainties": ["..."],
  "limitations": ["..."],
  "recommendedDisposition": "keep_existing_candidate"
}`;

function compactState(record: ObservedStateRecord) {
  const reduce = (map: Record<string, any[]>) => Object.fromEntries(Object.entries(map)
    .filter(([, values]) => values.length)
    .map(([key, values]) => [key, values.map((item) => ({
      description: item.description, confidence: item.confidence, temporalScope: item.temporalScope,
      evidenceReferences: item.evidenceReferences, ...(item.observedAtSeconds !== undefined ? { observedAtSeconds: item.observedAtSeconds } : {}),
    }))]));
  return {
    observationId: record.observationId, sceneId: record.sceneId, revision: record.revision,
    opening: reduce(record.opening), closing: reduce(record.closing), persistent: reduce(record.persistent),
    events: record.events.map((item) => ({ description: item.description, confidence: item.confidence, evidenceReferences: item.evidenceReferences, ...(item.observedAtSeconds !== undefined ? { observedAtSeconds: item.observedAtSeconds } : {}) })),
    unknownBoundaryConditions: record.unknownBoundaryConditions, boundaryEvidence: record.boundaryEvidence,
  };
}
function evidenceRef(observationId: string, id: string) { return `${observationId}:${id}`; }
function sourceImage(report: any, id: string) {
  const evidence = report.evidence.find((item: any) => item.id === id);
  if (!evidence?.path || !existsSync(evidence.path)) throw new Error(`SENIOR_EVIDENCE_MISSING: ${id} has no readable path`);
  return evidence;
}
function readImage(path: string): FileValue { return { bytes: new Uint8Array(readFileSync(path)), name: basename(path), type: "image/jpeg" }; }

function parseObject(raw: string): any {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("SENIOR_OUTPUT_NOT_JSON");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SENIOR_OUTPUT_NOT_OBJECT");
  return parsed;
}

function buildPrompt(input: {
  snapshot: ProductionSnapshot; prepared: ContinuityReview; states: ObservedStateRecord[]; baseline: ContinuityReview;
  images: { alias: string; observationId: string; evidenceId: string; frame?: number; timestampSeconds?: number; shotId?: string; hash: string; path: string }[];
  audio: { alias: string; observationId: string; evidenceId: string; hash: string }[];
}) {
  const sceneByRole = new Map<string, any>();
  const roleByScene = new Map<string, string>();
  for (const observation of input.prepared.observations) {
    const scene = input.snapshot.scenes.find((item) => item.id === observation.sceneId);
    const candidate = input.snapshot.candidates[input.prepared.candidateIds.find((id) => input.snapshot.candidates[id]?.bindings.some((binding) => binding.sceneId === observation.sceneId)) ?? ""];
    const role = observation.sceneId.endsWith("sc04") ? "P4" : observation.sceneId.endsWith("sc05") ? "P5" : "P6";
    roleByScene.set(observation.sceneId, role);
    sceneByRole.set(role, { observationId: observation.observationId, sceneId: observation.sceneId, revision: observation.revision, sourceHash: observation.sourceHash, sceneTitle: scene?.title, candidateId: candidate?.id, candidatePrompt: truncate(candidate?.prompt ?? "", 900), canonicalConstraints: buildContinuityConstraints(input.snapshot, observation.sceneId) });
  }
  const baselineFindings = (input.baseline.findings as any[]).map((item: any, index: number) => ({
    id: item.id ?? `baseline-${index + 1}`, classification: item.classification, from: item.from, to: item.to,
    summary: item.summary ?? item.description ?? item.reason ?? item, evidence: item.evidence ?? item.closingEvidence ?? item.openingEvidence ?? [],
  }));
  const imageLines = input.images.map((image) => ({
    alias: image.alias, observationId: image.observationId, evidenceId: image.evidenceId,
    frame: image.frame, timestampSeconds: image.timestampSeconds, shotId: image.shotId, sha256: image.hash,
  }));
  const audioLines = input.audio.map((audio) => ({ alias: audio.alias, observationId: audio.observationId, evidenceId: audio.evidenceId, sha256: audio.hash, suppliedToModel: false, role: "ASR transcript provenance; waveform not attached" }));
  const dialogue = input.states.map((state) => {
    const observation = input.snapshot.observations[state.observationId];
    const role = roleByScene.get(state.sceneId);
    const d = observation?.report?.dialogue;
    return {
      role, observationId: state.observationId, provider: d?.provider, rawTranscript: d?.rawTranscript ?? d?.text ?? "",
      utterances: (d?.utterances ?? []).map((utterance: any) => ({ text: utterance.text, startSeconds: utterance.startSeconds, endSeconds: utterance.endSeconds, unclear: utterance.unclear, evidenceIds: utterance.evidenceIds })),
      limitations: d?.limitations ?? [], audioAliases: input.audio.filter((item) => item.observationId === state.observationId).map((item) => item.alias),
    };
  });
  return {
    system: SENIOR_CONTINUITY_SYSTEM_PROMPT,
    input: `Senior continuity review request. Return JSON only.\n\nProduction: ${input.snapshot.production.id} (${input.snapshot.production.title})\nEpisode: ${input.prepared.episodeId ?? "unknown"}\nCanonical revision: ${input.snapshot.revision}\nPrepared review: ${input.prepared.id} (revision ${input.prepared.revision})\nBaseline review: ${input.baseline.id}\nReviewer requested: Qwen3.8 27B W4A8, temperature 0.1, max output 4096, top-k 64, top-p 0.9.\n\nScene scope and active bindings:\n${json([...sceneByRole.entries()])}\n\nCorrected temporal observed states (boundary evidence only; later events are separate):\n${json(input.states.map(compactState))}\n\nDeterministic baseline to challenge, not to copy:\n${json(baselineFindings)}\n\nHistorical P6 reference warning:\n${json(P6_REFERENCE_WARNING)}\n\nSupplied image aliases and verified hashes:\n${json(imageLines)}\n\nSupplied audio aliases and verified hashes:\n${json(audioLines)}\n\nASR transcripts:\n${json(dialogue)}\n\nRequired JSON schema:\n${OUTPUT_SCHEMA}\n\nBefore writing, check every finding: cite at least one supplied alias where visual evidence is claimed; use only audio aliases for dialogue; do not infer absence from a missing sampled view; explicitly challenge at least one baseline conclusion or state that the baseline is supported. A finding that merely repeats the baseline must set baselineComparison to confirms.`,
  };
}

export async function runSeniorContinuityReview(input: SeniorContinuityInput): Promise<SeniorContinuityResult> {
  const snap = input.store.snapshot(input.productionId);
  const prepared = snap.continuityReviews?.[input.preparedReviewId];
  if (!prepared) throw new Error(`SENIOR_PREPARED_REVIEW_MISSING: ${input.preparedReviewId}`);
  if (prepared.status !== "prepared") throw new Error(`SENIOR_PREPARED_REVIEW_STATUS: ${prepared.status}`);
  // The immediate predecessor may be a prepared record with no findings. Walk the
  // immutable chain to the nearest deterministic baseline, never silently compare
  // against an empty prepared record.
  let cursor = prepared.previousReviewId;
  let baseline: ContinuityReview | undefined;
  while (cursor) {
    const candidate = snap.continuityReviews?.[cursor];
    if (!candidate) break;
    if (candidate.reviewer.kind === "deterministic" && candidate.findings.length) { baseline = candidate; break; }
    cursor = candidate.previousReviewId;
  }
  if (!baseline) baseline = Object.values(snap.continuityReviews ?? {}).find((review) => review.reviewer.kind === "deterministic" && review.findings.length);
  if (!baseline) throw new Error("SENIOR_BASELINE_REVIEW_MISSING");
  const states = prepared.observations.map((item) => {
    const observation = snap.observations[item.observationId];
    if (!observation?.report) throw new Error(`SENIOR_SOURCE_OBSERVATION_MISSING: ${item.observationId}`);
    return deriveObservedState(item.observationId, observation.report);
  });
  const imageSpecs = [
    ["P4-OPEN", "7cd5be4a-2965-4ef3-8c3b-d00360a3d888", "frame-0008"],
    ["P4-CLOSE", "7cd5be4a-2965-4ef3-8c3b-d00360a3d888", "frame-0009"],
    ["P5-OPEN", "e7d95d04-0a8f-4d3d-b7b2-006dd5de7a08", "frame-0004"],
    ["P5-WET-MID", "e7d95d04-0a8f-4d3d-b7b2-006dd5de7a08", "frame-0010"],
    ["P5-CLOSE", "e7d95d04-0a8f-4d3d-b7b2-006dd5de7a08", "frame-0005"],
    ["P6-OPEN", "277e6cd4-9a50-42b0-a076-c4f8c822a01e", "frame-0005"],
    ["P6-HEART", "277e6cd4-9a50-42b0-a076-c4f8c822a01e", "frame-0001"],
    ["P6-CLOSE", "277e6cd4-9a50-42b0-a076-c4f8c822a01e", "frame-0006"],
  ] as [string, string, string][];
  const images = imageSpecs.map(([alias, observationId, evidenceId]) => {
    const report = snap.observations[observationId].report!;
    const evidence = sourceImage(report, evidenceId);
    return { alias, observationId, evidenceId, ...(evidence.frame !== undefined ? { frame: evidence.frame } : {}), ...(evidence.timestampSeconds !== undefined ? { timestampSeconds: evidence.timestampSeconds } : {}), ...(evidence.shotId ? { shotId: evidence.shotId } : {}), hash: sha256(readFileSync(evidence.path!)), path: evidence.path! };
  });
  const audio = prepared.observations.map((item, index) => {
    const report = snap.observations[item.observationId].report!;
    const evidence = report.evidence.find((entry: any) => entry.kind === "audio" && entry.path);
    if (!evidence?.path) throw new Error(`SENIOR_AUDIO_EVIDENCE_MISSING: ${item.observationId}`);
    return { alias: `P${index + 4}-AUDIO`, observationId: item.observationId, evidenceId: evidence.id, hash: sha256(readFileSync(evidence.path)), path: evidence.path };
  });
  const prompt = buildPrompt({ snapshot: snap, prepared, states, baseline, images, audio });
  const config = { model: "qwen3.8_27b_w4a8.safetensors", modelId: "qwen3.8-27b-w4a8", temperature: 0.1, maxOutputTokens: 4096, topK: 64, topP: 0.9, seed: 0, thinking: false, suppliedImageCount: images.length, suppliedAudioCount: 0, audioMode: "transcript-only", textBasedOnly: false };
  const model = observerModel("qwen3.8-27b-w4a8");
  const app = createObserverApp(model);
  const values: Record<string, unknown> = {
    observer_model: model.file, observer_clip_type: model.clipType,
    system_prompt: prompt.system, prompt: prompt.input,
    temperature: config.temperature, max_output_tokens: config.maxOutputTokens, top_k: config.topK, top_p: config.topP, seed: config.seed, thinking: false,
  };
  images.forEach((image, index) => { values[`frame${index + 1}`] = readImage(image.path); });
  const artifactDir = join(input.outDir, "observations", "senior-continuity", `${Date.now()}-${prepared.id}`);
  mkdirSync(artifactDir, { recursive: true });
  const startedAt = now(); const started = Date.now();
  const { job, outputs } = await input.runner.runTexts(app, values);
  const raw = outputs[0]?.text ?? "";
  const finishedAt = now(); const elapsedMs = Date.now() - started;
  const rawHash = sha256(raw);
  // Preserve raw output even if schema validation fails; there is no automatic retry.
  if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "raw-output.txt"), raw);
  const parsed = parseObject(raw);
  const validClassifications = new Set(["compatible", "confirmed_contradiction", "probable_contradiction", "accepted_deviation_candidate", "plausible_offscreen_transition", "insufficient_evidence"]);
  const validActions = new Set(["keep_existing_candidate", "accept_creative_deviation", "request_targeted_evidence", "request_human_audio_review", "request_human_visual_review", "correct_asset_association", "refine_next_scene_opening", "prepare_director_correction", "recommend_regeneration"]);
  const aliasToRef = new Map<string, string>();
  for (const image of images) aliasToRef.set(image.alias, evidenceRef(image.observationId, image.evidenceId));
  for (const item of audio) aliasToRef.set(item.alias, evidenceRef(item.observationId, item.evidenceId));
  const allowedRefs = new Set([...aliasToRef.values()]);
  for (const state of prepared.observations) {
    for (const evidence of snap.observations[state.observationId].report!.evidence) allowedRefs.add(evidenceRef(state.observationId, evidence.id));
  }
  const limitations: string[] = ["Audio waveform was not supplied to the model; dialogue findings use ASR transcripts plus audio-file provenance, not independent audio verification."];
  const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).flatMap((finding: any, index: number) => {
    if (!validClassifications.has(String(finding?.classification))) { limitations.push(`Senior finding ${index + 1} had an unsupported classification and was not validated.`); return []; }
    const aliases: string[] = Array.isArray(finding?.evidenceAliases) ? finding.evidenceAliases.map(String) : [];
    const references: string[] = aliases.map((alias: string) => aliasToRef.get(alias)).filter((ref): ref is string => Boolean(ref));
    const unknown = aliases.filter((alias: string) => !aliasToRef.has(alias));
    if (unknown.length) limitations.push(`Senior finding ${index + 1} cited unknown evidence aliases: ${unknown.join(", ")}.`);
    const category = String(finding?.category ?? "other");
    if (category === "dialogue" && !references.some((ref: string) => ref.includes(":audio-"))) {
      limitations.push(`Senior dialogue finding ${index + 1} was dropped because it cited no transcript/audio evidence.`);
      return [];
    }
    return [{
      id: String(finding.id ?? `finding-${String(index + 1).padStart(3, "0")}`), category,
      classification: finding.classification, scenes: Array.isArray(finding.scenes) ? finding.scenes.map(String) : [],
      summary: asText(finding.summary), rationale: asText(finding.rationale), evidenceAliases: aliases,
      evidenceReferences: [...new Set(references)], confidence: ["confirmed", "probable", "uncertain", "not_observable"].includes(String(finding.confidence)) ? finding.confidence : "uncertain",
      baselineComparison: ["confirms", "challenges", "adds", "insufficient", "not_in_baseline"].includes(String(finding.baselineComparison)) ? finding.baselineComparison : "not_in_baseline",
      ...(finding.baselineFindingId ? { baselineFindingId: String(finding.baselineFindingId) } : {}),
      ...(Array.isArray(finding.dialogueEvidence) ? { dialogueEvidence: finding.dialogueEvidence.map(String) } : {}),
    }];
  });
  const correctionPlans = (Array.isArray(parsed.correctionPlans) ? parsed.correctionPlans : []).map((plan: any, index: number) => {
    const action = String(plan?.action ?? "");
    const aliases: string[] = Array.isArray(plan?.evidenceAliases) ? plan.evidenceAliases.map(String) : [];
    return { id: String(plan.id ?? `plan-${String(index + 1).padStart(3, "0")}`), action: validActions.has(action) ? action : "request_human_visual_review", scenes: Array.isArray(plan.scenes) ? plan.scenes.map(String) : [], findingIds: Array.isArray(plan.findingIds) ? plan.findingIds.map(String) : [], summary: asText(plan.summary), rationale: asText(plan.rationale), evidenceAliases: aliases, evidenceReferences: [...new Set(aliases.map((alias: string) => aliasToRef.get(alias)).filter((ref): ref is string => Boolean(ref)))], estimatedScope: asText(plan.estimatedScope), requiresHumanApproval: true };
  });
  const baselineFindings = (baseline.findings as any[]).map((item: any, index: number) => ({ id: item.id ?? `baseline-${index + 1}`, classification: item.classification, summary: item.summary ?? item.reason ?? item }));
  const comparison = {
    baselineReviewId: baseline.id, baselineFindings,
    seniorFindings: findings.map((finding: any) => ({ id: finding.id, classification: finding.classification, baselineComparison: finding.baselineComparison, baselineFindingId: finding.baselineFindingId ?? null, summary: finding.summary })),
    challenges: findings.filter((finding: any) => finding.baselineComparison === "challenges").length,
    confirmations: findings.filter((finding: any) => finding.baselineComparison === "confirms").length,
    additions: findings.filter((finding: any) => finding.baselineComparison === "adds").length,
  };
  const effectiveOutput = { ...parsed, findings, correctionPlans, uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties.map(String) : [], limitations: [...(Array.isArray(parsed.limitations) ? parsed.limitations.map(String) : []), ...limitations], recommendedDisposition: asText(parsed.recommendedDisposition) || "keep_existing_candidate", suppliedEvidence: images.map((image) => image.alias).concat(audio.map((item) => item.alias)), textBasedOnly: false };
  const request = {
    schemaVersion: 1, createdAt: startedAt, productionId: input.productionId, preparedReviewId: prepared.id, baselineReviewId: baseline.id,
    observationIds: prepared.observations, model: config, systemPrompt: prompt.system, inputPrompt: prompt.input,
    suppliedImages: images.map(({ path, ...image }) => ({ ...image, path })), suppliedAudio: audio.map(({ path, ...item }) => ({ ...item, path })),
    inputPromptHash: sha256(prompt.input), systemPromptHash: sha256(prompt.system),
  };
  mkdirSync(artifactDir, { recursive: true });
  const write = (name: string, value: unknown, rawText = false) => writeFileSync(join(artifactDir, name), rawText && typeof value === "string" ? value : json(value));
  write("request.json", request); write("system-prompt.txt", prompt.system, true); write("input-prompt.txt", prompt.input, true);
  write("raw-output.txt", raw, true); write("parsed-output.json", effectiveOutput); write("validated-findings.json", findings);
  write("correction-plans.json", correctionPlans); write("baseline-comparison.json", comparison);
  write("evidence-manifest.json", { images: images.map(({ path, ...image }) => ({ ...image, path })), audio: audio.map(({ path, ...item }) => ({ ...item, path })), aliases: Object.fromEntries(aliasToRef) });
  write("execution-log.json", { jobId: job.id, status: job.status, startedAt, finishedAt, elapsedMs, model, app: app.id, values: { ...config, imageSlots: images.length, audioSlots: 0 }, rawOutputHash: rawHash, outputIndexes: outputs.map((output) => ({ nodeId: output.nodeId, name: output.name, chars: output.text.length })) });
  write("timings.json", { startedAt, finishedAt, totalSeconds: Math.round(elapsedMs / 100) / 10, inferenceMs: elapsedMs });
  const md = `# Senior continuity review\n\nPrepared review: ${prepared.id} (revision ${prepared.revision})\nBaseline: ${baseline.id}\nCompleted: ${finishedAt}\nModel: Qwen3.8 27B W4A8 · temperature 0.1 · max output 4096\n\n## Evidence supplied\n\n${images.map((image) => `- ${image.alias}: ${image.observationId}:${image.evidenceId}, frame ${image.frame ?? "?"}, SHA-256 \`${image.hash}\``).join("\n")}\n\n## Senior findings\n\n${findings.map((finding: any) => `### ${finding.id} — ${finding.classification}\n\n${finding.summary}\n\n${finding.rationale}\n\nEvidence: ${finding.evidenceReferences.join(", ") || "none"}\n`).join("\n")}\n\n## Baseline comparison\n\n${json(comparison)}\n\n## Correction plans\n\n${json(correctionPlans)}\n\n## Limitations\n\n${effectiveOutput.limitations.map((item: string) => `- ${item}`).join("\n") || "- none recorded"}\n\n## Raw output\n\n\`\`\`text\n${raw}\n\`\`\`\n`;
  write("SENIOR_CONTINUITY_REVIEW.md", md, true);
  const created = input.store.recordContinuityReview(input.productionId, {
    seasonId: prepared.seasonId, episodeId: prepared.episodeId, sceneIds: prepared.sceneIds, bindingIds: prepared.bindingIds, candidateIds: prepared.candidateIds,
    observations: prepared.observations, reviewer: { model: "qwen3.8_27b_w4a8.safetensors", kind: "qwen", configuration: config },
    evidenceReferences: [...new Set([...images.map((image) => evidenceRef(image.observationId, image.evidenceId)), ...audio.map((item) => evidenceRef(item.observationId, item.evidenceId))])],
    status: "completed", findings, stateRecords: states, correctionPlans,
    limitations: effectiveOutput.limitations,
    execution: { artifactDir, jobId: job.id, baselineReviewId: baseline.id, rawOutputHash: rawHash, requestHash: sha256(JSON.stringify(request)), startedAt, finishedAt, elapsedMs, textBasedOnly: false, suppliedImageCount: images.length, suppliedAudioCount: 0, audioMode: "transcript-only", evidenceManifest: "evidence-manifest.json" },
  }, input.actor, `continuity:senior:${prepared.id}:${job.id}`);
  const review = Object.values(created.continuityReviews).find((item) => item.previousReviewId === prepared.id && item.reviewer.kind === "qwen")!;
  return { review, artifactDir, request, output: effectiveOutput };
}
