// Live adapters for the durable production-run engine. They delegate to the already-running
// Riverfield HTTP service: the same app runner, prompt enhancer, History, candidate registration,
// ObservationManager and inference queue. This module never implements a second workflow.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { RunAdapters, RunContext, RunHandle, RenderResult, ObservationResult, ValidationResult } from "./production-run.ts";
import type { ObservationReport } from "./production-types.ts";
import { planH3 } from "./h3-plan.ts";
import { deriveObservedState } from "./observed-state.ts";
import { classifyContinuityTransition } from "./continuity-analysis.ts";

type Snapshot = any;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function stateFixture(map: Record<string, any[]>) {
  const all = Object.values(map).flat();
  const text = all.map((item) => String(item?.description ?? "")).join(" ");
  const wetness = /\bwet\b|damp|soaked/i.test(text) ? "wet" as const : /\bdry\b/i.test(text) ? "dry" as const : "unknown" as const;
  const props: Record<string, "present" | "absent" | "unknown"> = {};
  for (const item of [...(map.prop_presence_possession_condition ?? [])]) {
    const description = String(item?.description ?? "");
    const name = description.split(/[—:]/)[0].trim().toLowerCase();
    if (name) props[name] = /not visible|absent|missing/i.test(description) ? "absent" : "present";
  }
  const location = String((map.location_and_position ?? [])[0]?.description ?? "");
  return { characters: [], ...(location ? { location } : {}), wetness, props };
}

export type LiveRunAdapterOptions = { baseUrl: string; fetchImpl?: typeof fetch; pollMs?: number; maxWaitMs?: number };

export class LiveProductionRunAdapters implements RunAdapters {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;
  constructor(options: LiveRunAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.doFetch = options.fetchImpl ?? fetch;
    this.pollMs = options.pollMs ?? 800;
    this.maxWaitMs = options.maxWaitMs ?? 60 * 60 * 1000;
  }
  private async request(path: string, init?: RequestInit): Promise<any> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`LIVE_SERVICE_${response.status}: ${body?.error || body?.message || String(text).slice(0, 300)}`);
    return body;
  }
  private async snapshot(productionId: string): Promise<Snapshot> { return this.request(`/api/productions/${encodeURIComponent(productionId)}`); }
  private async waitHistory(id: string): Promise<any> {
    const started = Date.now();
    while (Date.now() - started < this.maxWaitMs) {
      const entry = await this.request(`/api/history/${encodeURIComponent(id)}`);
      if (["succeeded", "failed", "canceled", "expired", "lost"].includes(entry.status)) return entry;
      await sleep(this.pollMs);
    }
    throw new Error(`LIVE_HISTORY_TIMEOUT: ${id}`);
  }
  private async waitObservation(id: string): Promise<any> {
    const started = Date.now();
    while (Date.now() - started < this.maxWaitMs) {
      const job = await this.request(`/api/observation-jobs/${encodeURIComponent(id)}`);
      if (["succeeded", "failed", "canceled"].includes(job.status)) return job;
      await sleep(this.pollMs);
    }
    throw new Error(`LIVE_OBSERVATION_TIMEOUT: ${id}`);
  }
  private async candidateForRun(snapshot: Snapshot, runId: string, sceneId: string): Promise<any | undefined> {
    return Object.values(snapshot.candidates ?? {}).find((candidate: any) => candidate.sourceRunId === runId && candidate.bindings?.some((binding: any) => binding.sceneId === sceneId));
  }
  private async registerCandidate(context: RunContext, historyId: string): Promise<RenderResult> {
    const snapshot = await this.snapshot(context.run.productionId);
    const existing = await this.candidateForRun(snapshot, historyId, context.scene.sceneId);
    if (existing) return { candidateId: existing.id };
    const candidateId = `run-${context.run.id}-${context.scene.sceneId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 120);
    const frames = Math.max(5, Math.round(context.scene.targetDurationSeconds * 24));
    const body = {
      id: candidateId, label: `${context.run.title} / ${context.scene.title}`, runId: historyId,
      bindings: [{ id: `${candidateId}-b001`, sceneId: context.scene.sceneId, segmentIndex: 0, timelineStartFrame: 0, timelineEndFrame: frames }],
    };
    const result = await this.request(`/api/productions/${encodeURIComponent(context.run.productionId)}/candidates`, {
      method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "production-run-live" }, body: JSON.stringify(body),
    });
    const created = result.candidates?.[candidateId] ?? Object.values(result.candidates ?? {}).find((candidate: any) => candidate.sourceRunId === historyId && candidate.bindings?.some((binding: any) => binding.sceneId === context.scene.sceneId));
    if (!created) throw new Error("LIVE_CANDIDATE_REGISTRATION_FAILED");
    return { candidateId: (created as any).id };
  }
  private scenePrompt(context: RunContext, snapshot: Snapshot): string {
    const scene = context.scene;
    const productionStyle = String(snapshot.production?.style ?? "");
    const prior = scene.renderContext ?? {};
    const priorText = prior && Object.keys(prior).length ? JSON.stringify(prior) : "No prior accepted run-scoped closing state is available.";
    return [
      `Scene objective: ${scene.objective}`,
      `Intended events (intent only, not observed facts): ${scene.intendedEvents.join(" ")}`,
      ...(scene.dialogueRequirements.length ? [`Dialogue requirements (English): ${scene.dialogueRequirements.join(" ")}`] : []),
      ...(productionStyle ? [`Visual style: ${productionStyle}`] : []),
      `Transition requirement: ${scene.intendedTransition}`,
      `Run-scoped provisional context from the preceding accepted scene (not canonical): ${priorText}`,
    ].join("\n");
  }
  async startRender(context: RunContext): Promise<RunHandle<RenderResult>> {
    const snapshot = await this.snapshot(context.run.productionId);
    const scene = context.scene;
    const refs = scene.referenceAssetIds.map((assetId) => snapshot.assets?.[assetId]).filter(Boolean);
    if (refs.length !== scene.referenceAssetIds.length) throw new Error("LIVE_REFERENCE_ASSET_MISSING");
    for (const asset of refs) {
      if (!asset.path || !existsSync(asset.path)) throw new Error(`LIVE_REFERENCE_FILE_MISSING: ${asset.id}`);
      if (asset.hash && sha256(readFileSync(asset.path)) !== asset.hash) throw new Error(`LIVE_REFERENCE_HASH_MISMATCH: ${asset.id}`);
    }
    const prompt = String(scene.renderConfig.global_prompt ?? this.scenePrompt(context, snapshot));
    const windows = scene.renderConfig.segment_windows ?? planH3({ seconds: 7.3, prompts: [prompt], images: refs.map((_, index) => index) }).segment_windows;
    const form = new FormData();
    const values: Record<string, unknown> = {
      ...scene.renderConfig,
      render_profile: scene.profile,
      production_megapixels: scene.profile === "build" ? 0.1 : 0.3,
      production_upscale: scene.profile === "build" ? "" : "x2",
      production_id: context.run.productionId,
      production_scene_id: scene.sceneId, global_prompt: prompt, prompt_enhancer: true, segment_windows: windows,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === "string" ? value : typeof value === "boolean" ? String(value) : JSON.stringify(value));
    }
    refs.forEach((asset: any, index: number) => form.append(`image${index + 1}`, new Blob([readFileSync(asset.path)], { type: "image/png" }), basename(asset.path)));
    const entry = await this.request(`/api/apps/${encodeURIComponent(scene.selectedApp)}/run`, {
      method: "POST", headers: { "x-riverfield-actor": "production-run-live" }, body: form,
    });
    return { jobId: entry.id, wait: async () => {
      const history = await this.waitHistory(entry.id);
      if (history.status !== "succeeded") throw new Error(`LIVE_RENDER_${history.status}: ${history.error || entry.id}`);
      return this.registerCandidate(context, entry.id);
    } };
  }
  async reconcileRender(jobId: string, context: RunContext): Promise<RenderResult | null> {
    const snapshot = await this.snapshot(context.run.productionId);
    const existing = await this.candidateForRun(snapshot, jobId, context.scene.sceneId);
    if (existing) return { candidateId: existing.id };
    const history = await this.waitHistory(jobId);
    if (history.status !== "succeeded") return null;
    return this.registerCandidate(context, jobId);
  }
  async startObservation(context: RunContext): Promise<RunHandle<ObservationResult>> {
    if (!context.scene.candidateId) throw new Error("LIVE_OBSERVATION_CANDIDATE_MISSING");
    const job = await this.request(`/api/productions/${encodeURIComponent(context.run.productionId)}/observation-jobs`, {
      method: "POST", headers: { "content-type": "application/json", "x-riverfield-actor": "production-run-live" },
      body: JSON.stringify({ sceneId: context.scene.sceneId, candidateId: context.scene.candidateId, profile: "fast", bindingIds: undefined, options: { visualFrames: 6 }, referenceAssetIds: context.scene.referenceAssetIds, requestKey: context.requestKey }),
    });
    return { jobId: job.id, wait: async () => {
      const done = await this.waitObservation(job.id);
      if (done.status !== "succeeded" || !done.observationId) throw new Error(`LIVE_OBSERVATION_${done.status}: ${done.error || job.id}`);
      const observations = await this.request(`/api/productions/${encodeURIComponent(context.run.productionId)}/scenes/${encodeURIComponent(context.scene.sceneId)}/observations`);
      const observation = (observations.observations ?? []).find((item: any) => item.id === done.observationId);
      if (!observation?.report) throw new Error("LIVE_OBSERVATION_REPORT_MISSING");
      return { observationId: observation.id, report: observation.report as ObservationReport };
    } };
  }
  async reconcileObservation(jobId: string, context: RunContext): Promise<ObservationResult | null> {
    const done = await this.waitObservation(jobId);
    if (done.status !== "succeeded" || !done.observationId) return null;
    const observations = await this.request(`/api/productions/${encodeURIComponent(context.run.productionId)}/scenes/${encodeURIComponent(context.scene.sceneId)}/observations`);
    const observation = (observations.observations ?? []).find((item: any) => item.id === done.observationId);
    return observation?.report ? { observationId: observation.id, report: observation.report } : null;
  }
  async validate(context: RunContext): Promise<ValidationResult> {
    if (!context.scene.observationIds.length) return { ok: false, errors: ["No observation is recorded for deterministic validation"] };
    const observations = await this.request(`/api/productions/${encodeURIComponent(context.run.productionId)}/scenes/${encodeURIComponent(context.scene.sceneId)}/observations`);
    const observation = (observations.observations ?? []).find((item: any) => item.id === context.scene.observationIds.at(-1));
    if (!observation?.report) return { ok: false, errors: ["Structured observation is missing"] };
    const state = deriveObservedState(observation.id, observation.report);
    if (!Object.values(state.opening).flat().length && !Object.values(state.closing).flat().length) return { ok: false, errors: ["Observation has no usable opening or closing evidence"] };
    const prior = context.run.provisionalFacts.filter((fact) => fact.status === "approved").at(-1);
    if (prior) {
      const transition = classifyContinuityTransition(stateFixture(prior.closingState as Record<string, any[]>), stateFixture(state.opening as Record<string, any[]>));
      if (transition.classification === "confirmed_contradiction") return { ok: false, errors: transition.reasons };
      return { ok: true, ...(transition.classification === "insufficient_evidence" ? { errors: transition.reasons.map((reason) => `uncertainty: ${reason}`) } : {}) };
    }
    return { ok: true };
  }
  async startReview(): Promise<RunHandle<any>> { throw new Error("LIVE_SENIOR_REVIEW_NOT_CONFIGURED: reconcile and budget a prepared baseline before enabling Senior Review"); }
  async cancel(jobId: string, context: RunContext): Promise<void> {
    await this.request(`/api/history/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(async () => {
      await this.request(`/api/observation-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(() => undefined);
    });
  }
}
