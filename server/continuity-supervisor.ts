// Production-independent senior continuity review execution. Planning, scope resolution,
// baseline integrity, evidence selection and prompt compaction live in continuity-scope.ts.
// This module only performs the explicitly requested inference batches and records the
// immutable review plus full provenance artifacts.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Runner, FileValue } from "./runner.ts";
import type { ContinuityReview, ProductionSnapshot } from "./production-types.ts";
import { createObserverApp } from "./observer-app.ts";
import { observerModel } from "./observer-models.ts";
import { buildCompactBatchPrompt, buildContinuityPlan, validateSeniorContinuityOutput, type ContinuityBatch } from "./continuity-scope.ts";

export type SeniorContinuityInput = {
  store: {
    snapshot(id: string): ProductionSnapshot;
    recordContinuityReview(id: string, input: any, actor: any, commandKey?: string): ProductionSnapshot;
  };
  runner: Runner;
  outDir: string;
  productionId: string;
  preparedReviewId: string;
  baselineReviewId: string;
  maxImages?: number;
  humanAuditFindings?: unknown[];
  actor: { kind: "agent"; id: string };
};
export type SeniorContinuityResult = { review: ContinuityReview; artifactDir: string; request: Record<string, unknown>; output: Record<string, unknown> };

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value, null, 2);
function imageValue(path: string): FileValue { return { bytes: new Uint8Array(readFileSync(path)), name: basename(path), type: "image/jpeg" }; }
function parseObject(raw: string): any {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("SENIOR_OUTPUT_NOT_JSON");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SENIOR_OUTPUT_NOT_OBJECT");
  return parsed;
}
function readImage(image: any) { return imageValue(image.derivativePath ?? image.path); }

export async function runSeniorContinuityReview(input: SeniorContinuityInput): Promise<SeniorContinuityResult> {
  const snapshot = input.store.snapshot(input.productionId);
  const plan = buildContinuityPlan(snapshot, { preparedReviewId: input.preparedReviewId, baselineReviewId: input.baselineReviewId, ...(input.maxImages !== undefined ? { maxImages: input.maxImages } : {}), ...(input.humanAuditFindings ? { humanAuditFindings: input.humanAuditFindings } : {}), verifyFiles: true });
  const model = observerModel("qwen3.8-27b-w4a8");
  const app = createObserverApp(model);
  const config = { model: model.file, modelId: model.id, temperature: 0.1, maxOutputTokens: 4096, topK: 64, topP: 0.9, seed: 0, thinking: false, audioMode: "transcript-only", textBasedOnly: false };
  const startedAt = now(); const started = Date.now();
  const artifactDir = join(input.outDir, "observations", "senior-continuity", `${Date.now()}-${plan.prepared.id}`);
  mkdirSync(artifactDir, { recursive: true });
  const findings: any[] = []; const dispositions: any[] = []; const correctionPlans: any[] = []; const errors: string[] = []; const unreviewed: string[] = []; const batchLogs: any[] = [];
  for (const batch of plan.batches) {
    const prompt = buildCompactBatchPrompt(plan, batch);
    const values: Record<string, unknown> = {
      observer_model: model.file, observer_clip_type: model.clipType, system_prompt: prompt.system, prompt: prompt.input,
      temperature: config.temperature, max_output_tokens: config.maxOutputTokens, top_k: config.topK, top_p: config.topP, seed: config.seed, thinking: false,
    };
    batch.images.forEach((image, index) => { values[`frame${index + 1}`] = readImage(image); });
    const batchStarted = now(); const batchClock = Date.now();
    const { job, outputs } = await input.runner.runTexts(app, values);
    const raw = outputs[0]?.text ?? ""; const batchFinished = now(); const elapsedMs = Date.now() - batchClock;
    mkdirSync(join(artifactDir, batch.id), { recursive: true });
    writeFileSync(join(artifactDir, batch.id, "system-prompt.txt"), prompt.system);
    writeFileSync(join(artifactDir, batch.id, "input-prompt.txt"), prompt.input);
    writeFileSync(join(artifactDir, batch.id, "raw-output.txt"), raw);
    let parsed: any;
    try { parsed = parseObject(raw); } catch (error) { errors.push(`${batch.id}: ${(error as Error).message}`); batchLogs.push({ batchId: batch.id, jobId: job.id, status: job.status, error: (error as Error).message, rawOutputHash: sha256(raw), startedAt: batchStarted, finishedAt: batchFinished, elapsedMs, imageCount: batch.images.length }); continue; }
    const validated = validateSeniorContinuityOutput(parsed, plan, batch);
    findings.push(...validated.findings); dispositions.push(...validated.dispositions); correctionPlans.push(...validated.correctionPlans); errors.push(...validated.errors.map((error) => `${batch.id}: ${error}`)); unreviewed.push(...validated.unreviewedBaselineFindings);
    batchLogs.push({ batchId: batch.id, jobId: job.id, status: job.status, rawOutputHash: sha256(raw), startedAt: batchStarted, finishedAt: batchFinished, elapsedMs, imageCount: batch.images.length, coverageComplete: validated.coverageComplete });
    writeFileSync(join(artifactDir, batch.id, "parsed-output.json"), json(parsed));
    writeFileSync(join(artifactDir, batch.id, "validated-findings.json"), json(validated.findings));
    writeFileSync(join(artifactDir, batch.id, "baseline-dispositions.json"), json(validated.dispositions));
    writeFileSync(join(artifactDir, batch.id, "correction-plans.json"), json(validated.correctionPlans));
    writeFileSync(join(artifactDir, batch.id, "evidence-manifest.json"), json(batch.images));
  }
  const finishedAt = now(); const elapsedMs = Date.now() - started;
  const coverageComplete = errors.length === 0 && unreviewed.length === 0 && batchLogs.length === plan.batches.length && batchLogs.every((batch) => batch.coverageComplete);
  const limitations = [
    ...(coverageComplete ? [] : ["Review coverage is incomplete; missing validation or baseline coverage is recorded and must not be treated as a successful independent challenge."]),
    "Audio waveform was not supplied to the model; dialogue findings use ASR transcript provenance, not independent audio verification.",
    ...errors,
    ...(unreviewed.length ? [`Baseline findings without disposition: ${unreviewed.join(", ")}`] : []),
  ];
  const request: Record<string, unknown> = {
    schemaVersion: 1, createdAt: startedAt, productionId: input.productionId, preparedReviewId: plan.prepared.id,
    baselineReviewId: plan.baseline.review.id, baselineContentHash: plan.baselineContentHash, baselineFindingsCount: plan.baselineFindingsCount,
    model: config, batches: plan.batches.map((batch: ContinuityBatch) => ({ id: batch.id, scenes: batch.sceneAliases, images: batch.images.map(({ path, ...image }) => ({ ...image, path })), audio: batch.audio.map(({ path, ...item }) => ({ ...item, path })), missingEvidence: batch.missingEvidence })), systemPrompt: undefined, inputPrompt: undefined,
  };
  const write = (name: string, value: unknown, raw = false) => writeFileSync(join(artifactDir, name), raw && typeof value === "string" ? value : json(value));
  // Exact prompts are retained per batch; the index request points to those files.
  request.systemPrompt = plan.batches.map((batch) => `${batch.id}/system-prompt.txt`);
  request.inputPrompt = plan.batches.map((batch) => `${batch.id}/input-prompt.txt`);
  write("request.json", request);
  write("execution-log.json", { jobIds: batchLogs.map((batch) => batch.jobId), batches: batchLogs, startedAt, finishedAt, elapsedMs, model, app: app.id, baselineContentHash: plan.baselineContentHash, baselineFindingsCount: plan.baselineFindingsCount, coverageComplete });
  write("timings.json", { startedAt, finishedAt, totalSeconds: Math.round(elapsedMs / 100) / 10, inferenceMs: elapsedMs });
  write("baseline.json", { reviewId: plan.baseline.review.id, contentHash: plan.baselineContentHash, findingsCount: plan.baselineFindingsCount, findings: plan.baseline.findings });
  write("validated-findings.json", findings);
  write("baseline-dispositions.json", dispositions);
  write("correction-plans.json", correctionPlans);
  write("reference-warnings.json", plan.referenceWarnings);
  write("human-audit-findings.json", plan.humanAuditFindings);
  write("unreviewed-baseline-findings.json", unreviewed);
  write("evidence-manifest.json", { scenes: plan.scenes.map((scene) => ({ sceneId: scene.sceneId, alias: scene.alias, observationId: scene.observationId, revision: scene.observationRevision, sourceHash: scene.sourceHash, candidateId: scene.candidateId, bindingIds: scene.bindingIds })), batches: plan.batches });
  const status = "completed";
  const created = input.store.recordContinuityReview(input.productionId, {
    seasonId: plan.prepared.seasonId, episodeId: plan.prepared.episodeId, sceneIds: plan.prepared.sceneIds,
    bindingIds: [...new Set(plan.scenes.flatMap((scene) => scene.bindingIds))],
    candidateIds: [...new Set(plan.scenes.map((scene) => scene.candidateId))],
    observations: plan.prepared.observations, reviewer: { model: model.file, kind: "qwen", configuration: config },
    evidenceReferences: [...new Set(plan.batches.flatMap((batch) => batch.images.map((image) => `${image.observationId}:${image.evidenceId}`)))],
    status, findings, stateRecords: plan.stateRecords, correctionPlans, limitations,
    execution: { artifactDir, baselineReviewId: plan.baseline.review.id, baselineContentHash: plan.baselineContentHash, baselineFindingsCount: plan.baselineFindingsCount, coverageComplete, reviewOutcome: coverageComplete ? "successful" : "incomplete", unreviewedBaselineFindings: unreviewed, validationErrors: errors, humanAuditFindings: plan.humanAuditFindings, batches: batchLogs, startedAt, finishedAt, elapsedMs, suppliedImageCount: plan.batches.reduce((sum, batch) => sum + batch.images.length, 0), suppliedAudioCount: 0, audioMode: "transcript-only", textBasedOnly: false },
  }, input.actor, `continuity:senior:${plan.prepared.id}:${sha256(json(batchLogs)).slice(0, 12)}`);
  const review = Object.values(created.continuityReviews).find((item) => item.previousReviewId === plan.prepared.id && item.reviewer.kind === "qwen")!;
  return { review, artifactDir, request, output: { findings, dispositions, correctionPlans, unreviewedBaselineFindings: unreviewed, coverageComplete } };
}
