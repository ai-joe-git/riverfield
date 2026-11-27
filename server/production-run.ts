// Durable, resumable production orchestration. The engine owns budget reservations,
// job persistence and state transitions; generation/observation/review work is supplied
// by adapters so the same loop can use the real Riverfield services or mocks in tests.
import type { ObservationReport, ProductionRun, ProductionRunBudget, ProductionRunScene } from "./production-types.ts";
import type { ProductionStore } from "./production-store.ts";
import { deriveObservedState } from "./observed-state.ts";
import { contextHash, resolveAcceptedObservation } from "./observation-selection.ts";

export class ProductionRunError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
export type PreparedRender = { revision: number; sceneId: string; values: Record<string, unknown> };
export type RunContext = { run: ProductionRun; scene: ProductionRunScene; sceneIndex: number; requestKey: string };
export type RunHandle<T> = { jobId: string; wait(): Promise<T> };
export type RenderResult = { candidateId: string; jobId?: string };
export type ObservationResult = { observationId: string; report?: ObservationReport; evidenceReferences?: string[] };
export type ReviewResult = { reviewId: string; coverageComplete?: boolean };
export type ValidationResult = { ok: boolean; errors?: string[] };
export type RunAdapters = {
  startRender?(context: RunContext): Promise<RunHandle<RenderResult>>;
  reconcileRender?(jobId: string, context: RunContext): Promise<RenderResult | null>;
  startObservation?(context: RunContext): Promise<RunHandle<ObservationResult>>;
  reconcileObservation?(jobId: string, context: RunContext): Promise<ObservationResult | null>;
  validate?(context: RunContext): Promise<ValidationResult>;
  startReview?(context: RunContext): Promise<RunHandle<ReviewResult>>;
  reconcileReview?(jobId: string, context: RunContext): Promise<ReviewResult | null>;
  cancel?(jobId: string, context: RunContext): Promise<void>;
};

const now = () => new Date().toISOString();
const keyFor = (runId: string, sceneId: string, kind: string, revision = 0) => `run:${runId}:${sceneId}:${kind}:${revision}`;
const clone = <T>(value: T): T => structuredClone(value);
const unique = <T>(values: T[]) => [...new Set(values)];

export class ProductionRunEngine {
  private readonly store: ProductionStore;
  private readonly adapters: RunAdapters;
  private readonly actor = { kind: "agent" as const, id: "production-run-engine" };
  private readonly busy = new Map<string, Promise<ProductionRun>>();

  constructor(store: ProductionStore, adapters: RunAdapters = {}) { this.store = store; this.adapters = adapters; }

  private snapshot(productionId: string) { return this.store.snapshot(productionId); }
  private run(productionId: string, runId: string): ProductionRun {
    const run = (this.snapshot(productionId).productionRuns ?? {})[runId];
    if (!run) throw new ProductionRunError("UNKNOWN_PRODUCTION_RUN", `Unknown production run ${runId}`);
    return run;
  }
  private update(productionId: string, run: ProductionRun, patch: Partial<ProductionRun>, key: string): ProductionRun {
    const next = { ...run, ...patch, revision: run.revision + 1, updatedAt: now() };
    this.store.updateProductionRun(productionId, run.id, patch, this.actor, `${key}:${run.revision}`);
    return { ...next, productionId: run.productionId, id: run.id };
  }

  private startActiveClock(budget: ProductionRunBudget): ProductionRunBudget {
    return budget.activeProductionMinutesUsed !== undefined && !budget.activeProductionStartedAt
      ? { ...budget, activeProductionStartedAt: now() } : budget;
  }
  private settleActiveClock(budget: ProductionRunBudget): ProductionRunBudget {
    if (!budget.activeProductionStartedAt) return budget;
    const elapsedMinutes = Math.max(0, Date.now() - Date.parse(budget.activeProductionStartedAt)) / 60_000;
    return {
      ...budget,
      activeProductionMinutesUsed: Number(((budget.activeProductionMinutesUsed ?? 0) + elapsedMinutes).toFixed(4)),
      activeProductionStartedAt: undefined,
    };
  }
  /** Hard reservation before an expensive call. The updated journal is durable first. */
  private reserve(run: ProductionRun, kind: "render" | "observation" | "comparison" | "senior_review", scene: ProductionRunScene): ProductionRun {
    const budget = clone(run.budget);
    const nowMs = Date.now();
    const started = budget.startedAt ? Date.parse(budget.startedAt) : nowMs;
    if (budget.activeProductionMinutesUsed !== undefined) {
      const activeStart = budget.activeProductionStartedAt ? Date.parse(budget.activeProductionStartedAt) : nowMs;
      const activeMs = budget.activeProductionMinutesUsed * 60_000 + Math.max(0, nowMs - activeStart);
      if (activeMs > budget.wallClockMinutes * 60_000) throw new ProductionRunError("RUN_ACTIVE_BUDGET_EXHAUSTED", "Production run active-production budget exhausted");
    } else if (nowMs - started > budget.wallClockMinutes * 60_000) {
      throw new ProductionRunError("RUN_WALL_CLOCK_EXHAUSTED", "Production run wall-clock budget exhausted");
    }
    if (kind === "render") {
      if (budget.rendersUsed >= budget.maxTotalRenders) throw new ProductionRunError("RUN_BUDGET_RENDER_TOTAL", "Total render budget exhausted");
      if (scene.attempts >= budget.maxRendersPerScene) throw new ProductionRunError("RUN_BUDGET_RENDER_SCENE", `Render budget exhausted for ${scene.sceneId}`);
      budget.rendersUsed += 1;
      scene.attempts += 1;
      if (scene.renderConfig.prompt_enhancer !== false) {
        if (budget.promptEnhancementsUsed >= budget.maxPromptEnhancements) throw new ProductionRunError("RUN_BUDGET_PROMPT_ENHANCER", "Prompt enhancement budget exhausted");
        budget.promptEnhancementsUsed += 1;
      }
    } else if (kind === "observation") {
      if (budget.observationJobsUsed >= budget.maxObservationJobs) throw new ProductionRunError("RUN_BUDGET_OBSERVATION", "Observation job budget exhausted");
      budget.observationJobsUsed += 1;
    } else if (kind === "comparison") {
      if (budget.comparisonCallsUsed >= budget.maxComparisonCalls) throw new ProductionRunError("RUN_BUDGET_COMPARISON", "Comparison budget exhausted");
      budget.comparisonCallsUsed += 1;
    } else {
      if (budget.seniorReviewBatchesUsed >= budget.maxSeniorReviewBatches) throw new ProductionRunError("RUN_BUDGET_SENIOR", "Senior review batch budget exhausted");
      budget.seniorReviewBatchesUsed += 1;
    }
    const reserved = { sceneId: scene.sceneId, kind, jobId: "", requestKey: keyFor(run.id, scene.sceneId, kind, scene.attempts), status: "reserved" as const, reservedAt: now() };
    return this.update(run.productionId, run, { budget, jobs: [...run.jobs, reserved], scenePlan: run.scenePlan.map((item) => item.sceneId === scene.sceneId ? scene : item) }, `run:${run.id}:reserve:${kind}:${scene.sceneId}:${scene.attempts}`);
  }
  private markJob(run: ProductionRun, sceneId: string, kind: string, status: ProductionRun["jobs"][number]["status"], jobId: string): ProductionRun {
    return this.update(run.productionId, run, { jobs: run.jobs.map((job) => job.sceneId === sceneId && job.kind === kind && job.requestKey === keyFor(run.id, sceneId, kind, job.requestKey.split(":").at(-1) ? Number(job.requestKey.split(":").at(-1)) : 0) ? { ...job, status, jobId } : job) }, `run:${run.id}:job:${kind}:${sceneId}:${status}:${jobId}`);
  }
  private findPending(run: ProductionRun, sceneId: string, kind: string) { return [...run.jobs].reverse().find((job) => job.sceneId === sceneId && job.kind === kind && (job.status === "reserved" || job.status === "submitted")); }
  private markScene(run: ProductionRun, index: number, patch: Partial<ProductionRunScene>): ProductionRun {
    const plan = run.scenePlan.map((scene, i) => i === index ? { ...scene, ...patch } : scene);
    return this.update(run.productionId, run, { scenePlan: plan }, `run:${run.id}:scene:${index}:${patch.status ?? "update"}`);
  }

  private async locked(productionId: string, runId: string, action: () => Promise<ProductionRun>): Promise<ProductionRun> {
    const key = `${productionId}:${runId}`;
    if (this.busy.has(key)) throw new ProductionRunError("RUN_CONCURRENT", "A start/resume operation is already active for this run");
    const operation = action();
    this.busy.set(key, operation);
    try { return await operation; } finally { this.busy.delete(key); }
  }
  previewRender(productionId: string, runId: string): RunContext | null {
    const run = this.run(productionId, runId);
    const sceneIndex = run.currentSceneIndex;
    const scene = run.scenePlan[sceneIndex];
    if (!scene || scene.status !== "planned" || scene.reuseCandidateId || this.findPending(run, scene.sceneId, "render")) return null;
    return { run, scene:{...scene,renderContext:this.renderContext(run,sceneIndex)},sceneIndex,requestKey:keyFor(runId,scene.sceneId,"render",scene.attempts+1) };
  }
  private checkPrepared(run: ProductionRun, prepared?: PreparedRender) {
    if(prepared && (run.revision!==prepared.revision || run.scenePlan[run.currentSceneIndex]?.sceneId!==prepared.sceneId))
      throw new ProductionRunError("WORKSPACE_PROMPT_STALE","The production changed after prompt preparation. Prepare the current scene again.");
  }
  async start(productionId: string, runId: string, prepared?: PreparedRender): Promise<ProductionRun> {
    return this.locked(productionId, runId, () => this.startUnlocked(productionId, runId, prepared));
  }
  private async startUnlocked(productionId: string, runId: string, prepared?: PreparedRender): Promise<ProductionRun> {
    let run = this.run(productionId, runId);
    this.checkPrepared(run, prepared);
    if (["canceled", "completed"].includes(run.status)) throw new ProductionRunError("RUN_NOT_RESUMABLE", `Run ${runId} is ${run.status}`);
    if (run.status === "prepared") run = this.update(productionId, run, { status: "running", stage: "render", budget: this.startActiveClock({ ...run.budget, startedAt: run.budget.startedAt ?? now() }) }, `run:${run.id}:start`);
    return this.advance(productionId, run.id, prepared);
  }
  async resume(productionId: string, runId: string, prepared?: PreparedRender): Promise<ProductionRun> {
    return this.locked(productionId, runId, () => this.resumeUnlocked(productionId, runId, prepared));
  }
  private async resumeUnlocked(productionId: string, runId: string, prepared?: PreparedRender): Promise<ProductionRun> {
    let run = this.run(productionId, runId);
    this.checkPrepared(run, prepared);
    if (run.status === "awaiting_human") throw new ProductionRunError("RUN_AWAITING_HUMAN", "A human decision is required before resuming");
    if (!["paused", "running", "prepared"].includes(run.status)) throw new ProductionRunError("RUN_NOT_RESUMABLE", `Run ${runId} is ${run.status}`);
    if (run.status !== "running") run = this.update(productionId, run, { status: "running", budget: this.startActiveClock(run.budget) }, `run:${run.id}:resume`);
    return this.advance(productionId, run.id, prepared);
  }
  async pause(productionId: string, runId: string): Promise<ProductionRun> {
    const run = this.run(productionId, runId);
    if (["completed", "canceled"].includes(run.status)) throw new ProductionRunError("RUN_NOT_PAUSABLE", `Run ${runId} is ${run.status}`);
    return this.update(productionId, run, { status: "paused", budget: this.settleActiveClock(run.budget) }, `run:${run.id}:pause`);
  }
  async cancel(productionId: string, runId: string): Promise<ProductionRun> {
    const run = this.run(productionId, runId);
    for (const job of run.jobs.filter((item) => ["reserved", "submitted"].includes(item.status) && item.jobId)) {
      await this.adapters.cancel?.(job.jobId, { run, scene: run.scenePlan.find((scene) => scene.sceneId === job.sceneId)!, sceneIndex: run.currentSceneIndex, requestKey: job.requestKey });
    }
    return this.update(productionId, run, { status: "canceled", stage: "awaiting_human", budget: this.settleActiveClock(run.budget) }, `run:${run.id}:cancel`);
  }
  async decide(productionId: string, runId: string, sceneId: string, decision: "approved" | "rejected" | "replace" | "reuse", note = "", observationId?: string): Promise<ProductionRun> {
    let run = this.run(productionId, runId);
    const index = run.scenePlan.findIndex((scene) => scene.sceneId === sceneId);
    if (index < 0) throw new ProductionRunError("UNKNOWN_RUN_SCENE", `Unknown scene ${sceneId}`);
    const current = run.scenePlan[index];
    if ((decision === "approved" || decision === "reuse") && !(
      current.status === "awaiting_human" && current.candidateId && current.observationIds.length &&
      current.validation?.ok && this.snapshot(productionId).candidates[current.candidateId] &&
      this.snapshot(productionId).observations[current.observationIds.at(-1)!]?.report
    )) throw new ProductionRunError("RUN_DECISION_NOT_READY", "Approval requires the current scene candidate, structured observation and completed deterministic validation at the human checkpoint");
    if (index !== run.currentSceneIndex) throw new ProductionRunError("RUN_DECISION_OUT_OF_ORDER", "Human decisions must follow the current ordered scene checkpoint");
    const accepted = decision === "approved" || decision === "reuse"
      ? resolveAcceptedObservation(this.snapshot(productionId), current, observationId) : undefined;
    if (decision === "approved" || decision === "reuse") {
      run = this.markScene(run, index, {
        status: "approved",
        acceptedObservation: {
          observationId: accepted!.observation.id, revision: accepted!.revision, sourceHash: accepted!.sourceHash,
          selection: accepted!.selection, selectedAt: now(), selectedBy: "human",
        },
      });
    } else if (decision === "rejected") run = this.markScene(run, index, { status: "rejected" });
    else run = this.markScene(run, index, { status: "planned", attempts: current.attempts + 1 });
    run = { ...run, decisions: [...run.decisions, { id: `decision-${Date.now()}`, sceneId, decision, note, actor: "human", at: now() }] };
    this.store.recordProductionRunDecision(productionId, runId, { sceneId, decision, note, actor: "human" }, this.actor, `run:${runId}:decision:${sceneId}:${decision}`);
    run = this.run(productionId, runId);
    if (decision === "approved" || decision === "reuse") {
      const state = deriveObservedState(accepted!.observation.id, accepted!.report);
      const acceptedText = Object.values(state.closing).flat().map((item) => item.description).filter(Boolean).join("; ") || "No observed closing state.";
      const acceptedEvidence = [...new Set([
        ...state.boundaryEvidence.opening.map((item) => `${accepted!.observation.id}:${item.id}`),
        ...state.boundaryEvidence.closing.map((item) => `${accepted!.observation.id}:${item.id}`),
        ...state.events.flatMap((item) => item.evidenceReferences),
      ])];
      run = this.update(productionId, run, {
        currentSceneIndex: index + 1, status: index + 1 >= run.scenePlan.length ? "completed" : "running",
        stage: index + 1 >= run.scenePlan.length ? "completed" : "next_scene",
        budget: this.startActiveClock(run.budget),
        provisionalFacts: run.provisionalFacts.map((fact) => fact.sceneId === sceneId ? {
          ...fact, status: "approved", sourceObservationId: accepted!.observation.id, sourceObservationHash: accepted!.sourceHash,
          previousSourceObservationId: fact.sourceObservationId === accepted!.observation.id ? fact.previousSourceObservationId : fact.sourceObservationId,
          revision: accepted!.revision, text: acceptedText, openingState: state.opening, closingState: state.closing,
          observedEvents: state.events.map((event) => event.description), evidenceReferences: acceptedEvidence,
          uncertainties: [...new Set([...(accepted!.report.uncertainties ?? []), ...state.unknownBoundaryConditions])],
        } : fact),
      }, `run:${run.id}:approve:${sceneId}`);
      return run;
    }
    // Rejection/replacement invalidates downstream provisional assumptions, never media.
    const invalidated = new Set(run.scenePlan.slice(index + 1).map((scene) => scene.sceneId));
    const invalidatedFacts = new Set(run.scenePlan.slice(index).map((scene) => scene.sceneId));
    run = this.update(productionId, run, {
      status: "paused", stage: "awaiting_human",
      scenePlan: run.scenePlan.map((scene, i) => i > index && invalidated.has(scene.sceneId) ? { ...scene, status: "stale" } : scene),
      provisionalFacts: run.provisionalFacts.map((fact) => invalidatedFacts.has(fact.sceneId) ? { ...fact, status: "invalidated" } : fact),
      errors: [...run.errors, ...(invalidated.size ? [`Invalidated provisional assumptions in: ${[...invalidated].join(", ")}`] : [])],
    }, `run:${run.id}:invalidate:${sceneId}`);
    return run;
  }

  async advance(productionId: string, runId: string, prepared?: PreparedRender): Promise<ProductionRun> {
    let run = this.run(productionId, runId);
    if (run.status !== "running") return run;
    for (let guard = 0; guard < 64; guard += 1) {
      const index = run.currentSceneIndex;
      let scene = run.scenePlan[index];
      if (!scene) {
        run = this.update(productionId, run, { status: "completed", stage: "completed" }, `run:${run.id}:complete`);
        return run;
      }
      if (scene.status === "approved" || scene.status === "skipped") {
        run = this.update(productionId, run, { currentSceneIndex: index + 1, stage: "next_scene" }, `run:${run.id}:next:${index}`);
        continue;
      }
      if (scene.status === "awaiting_human") return run;
      let reservedNow = false;
      if (scene.status === "planned") {
        let renderContext: Record<string, unknown>;
        try { renderContext = this.renderContext(run, index); }
        catch (error) { return this.fail(productionId, run, error as Error); }
        run = this.markScene(run, index, {
          renderContext,
          ...(typeof renderContext.effectiveContextHash === "string" ? { renderContextHash: renderContext.effectiveContextHash } : {}),
        });
        scene = run.scenePlan[index];
        if (scene.reuseCandidateId) {
          const reused = this.snapshot(productionId).candidates[scene.reuseCandidateId];
          if (!reused) return this.fail(productionId, run, new ProductionRunError("RUN_INVALID_CANDIDATE_ADOPTION", `Candidate ${scene.reuseCandidateId} does not exist`));
          run = this.markScene(run, index, { status: scene.observationIds.length ? "observed" : "candidate_registered", candidateId: reused.id });
          continue;
        }
        const pending = this.findPending(run, scene.sceneId, "render");
        if (pending?.jobId) {
          if (!this.adapters.reconcileRender) return this.fail(productionId, run, new ProductionRunError("RUN_RECONCILE_UNAVAILABLE", "A pending render exists but no reconciliation adapter is configured"));
          const result = await this.adapters.reconcileRender(pending.jobId, { run, scene, sceneIndex: index, requestKey: pending.requestKey });
          if (!result) return this.fail(productionId, run, new ProductionRunError("RUN_JOB_NOT_FOUND", `Render job ${pending.jobId} cannot be reconciled; refusing duplicate submission`));
          run = this.markJob(run, scene.sceneId, "render", "succeeded", pending.jobId);
          run = this.markScene(run, index, { status: "candidate_registered", candidateId: result.candidateId });
          continue;
        }
        if (pending && !pending.jobId) return this.fail(productionId, run, new ProductionRunError("RUN_RESERVED_WITHOUT_JOB", "A render reservation has no durable job id; refusing to submit a duplicate"));
        try { run = this.reserve(run, "render", scene); reservedNow = true; } catch (error) { return this.fail(productionId, run, error as Error); }
      }
      if (scene.status === "rendering" || scene.status === "planned") {
        const pending = this.findPending(run, scene.sceneId, "render");
        if (pending?.jobId) {
          if (!this.adapters.reconcileRender) return this.fail(productionId, run, new ProductionRunError("RUN_RECONCILE_UNAVAILABLE", "A pending render exists but no reconciliation adapter is configured"));
          const result = await this.adapters.reconcileRender(pending.jobId, { run, scene, sceneIndex: index, requestKey: pending.requestKey });
          if (!result) return this.fail(productionId, run, new ProductionRunError("RUN_JOB_NOT_FOUND", `Render job ${pending.jobId} cannot be reconciled; refusing duplicate submission`));
          run = this.markJob(run, scene.sceneId, "render", "succeeded", pending.jobId);
          run = this.markScene(run, index, { status: "candidate_registered", candidateId: result.candidateId });
          continue;
        }
        if (pending && !pending.jobId && !reservedNow) return this.fail(productionId, run, new ProductionRunError("RUN_RESERVED_WITHOUT_JOB", "A render reservation has no durable job id; refusing to submit a duplicate"));
        if (!this.adapters.startRender) return this.fail(productionId, run, new ProductionRunError("RUN_RENDER_ADAPTER_MISSING", "No render adapter configured"));
        const renderConfig = prepared?.sceneId === scene.sceneId ? { ...scene.renderConfig, ...prepared.values } : scene.renderConfig;
        let handle; try { handle = await this.adapters.startRender({ run, scene: { ...scene, renderConfig, status: "rendering" }, sceneIndex: index, requestKey: keyFor(run.id, scene.sceneId, "render", scene.attempts) }); } catch (error) { return this.fail(productionId, run, error as Error); }
        run = this.markJob(run, scene.sceneId, "render", "submitted", handle.jobId);
        run = this.markScene(run, index, { status: "rendering", jobIds: unique([...scene.jobIds, handle.jobId]) });
        let result: RenderResult; try { result = await handle.wait(); } catch (error) { return this.fail(productionId, run, error as Error); }
        const afterRender = this.run(productionId, run.id);
        if (afterRender.status !== "running") return afterRender;
        run = this.markJob(run, scene.sceneId, "render", "succeeded", handle.jobId);
        run = this.markScene(run, index, { status: "candidate_registered", candidateId: result.candidateId });
        continue;
      }
      if (scene.status === "candidate_registered") {
        if (!scene.observationIds.length) {
          const pending = this.findPending(run, scene.sceneId, "observation");
          if (pending?.jobId) {
            if (!this.adapters.reconcileObservation) return this.fail(productionId, run, new ProductionRunError("RUN_RECONCILE_UNAVAILABLE", "A pending observation exists but no reconciliation adapter is configured"));
            const result = await this.adapters.reconcileObservation(pending.jobId, { run, scene, sceneIndex: index, requestKey: pending.requestKey });
            if (!result) return this.fail(productionId, run, new ProductionRunError("RUN_JOB_NOT_FOUND", `Observation job ${pending.jobId} cannot be reconciled; refusing duplicate submission`));
            run = this.markJob(run, scene.sceneId, "observation", "succeeded", pending.jobId);
            if (!result.report) return this.fail(productionId, run, new ProductionRunError("RUN_OBSERVATION_REPORT_MISSING", "Observation returned no structured report; provisional state is not created"));
            run = this.markScene(run, index, { status: "observed", observationIds: [result.observationId], ...(result.report.failure ? { errors: [...scene.errors, `Observation incomplete: ${result.report.failure.stage}: ${result.report.failure.message}`] } : {}) });
            run = this.addProvisional(run, scene.sceneId, result);
            continue;
          }
          if (pending && !pending.jobId) return this.fail(productionId, run, new ProductionRunError("RUN_RESERVED_WITHOUT_JOB", "An observation reservation has no durable job id; refusing to submit a duplicate"));
          const observerRefs = scene.observerReferenceAssetIds ?? scene.referenceAssetIds;
          const observerFrames = scene.observationVisualFrames ?? Math.max(1, Math.min(6, 9 - observerRefs.length));
          if (observerRefs.length + observerFrames > 9) return this.fail(productionId, run, new ProductionRunError("RUN_OBSERVATION_IMAGE_BUDGET", `${observerFrames} evidence frames plus ${observerRefs.length} observer references exceed the nine-image workflow capacity; resolve the budget before reserving the observation`));
          const comparisonAlreadyReserved = run.jobs.some((job) => job.sceneId === scene.sceneId && job.kind === "comparison" && ["reserved", "submitted", "succeeded"].includes(job.status));
          if (!comparisonAlreadyReserved) {
            try { run = this.reserve(run, "comparison", scene); } catch (error) { return this.fail(productionId, run, error as Error); }
          }
          try { run = this.reserve(run, "observation", scene); } catch (error) { return this.fail(productionId, run, error as Error); }
          if (!this.adapters.startObservation) return this.fail(productionId, run, new ProductionRunError("RUN_OBSERVATION_ADAPTER_MISSING", "No observation adapter configured"));
          const handle = await this.adapters.startObservation({ run, scene, sceneIndex: index, requestKey: keyFor(run.id, scene.sceneId, "observation", scene.attempts) });
          run = this.markJob(run, scene.sceneId, "observation", "submitted", handle.jobId);
          run = this.markScene(run, index, { jobIds: unique([...scene.jobIds, handle.jobId]) });
          const result = await handle.wait();
          const afterObservation = this.run(productionId, run.id);
          if (afterObservation.status !== "running") return afterObservation;
          run = this.markJob(run, scene.sceneId, "observation", "succeeded", handle.jobId);
          if (!result.report) return this.fail(productionId, run, new ProductionRunError("RUN_OBSERVATION_REPORT_MISSING", "Observation returned no structured report; provisional state is not created"));
          run = this.markScene(run, index, { status: "observed", observationIds: [result.observationId], ...(result.report.failure ? { errors: [...scene.errors, `Observation incomplete: ${result.report.failure.stage}: ${result.report.failure.message}`] } : {}) });
          run = this.addProvisional(run, scene.sceneId, result);
          continue;
        }
        run = this.markScene(run, index, { status: "observed" });
        continue;
      }
      if (scene.status === "observed") {
        if (!this.adapters.validate) return this.fail(productionId, run, new ProductionRunError("RUN_VALIDATION_ADAPTER_MISSING", "Deterministic validation adapter is required"));
        const validation = await this.adapters.validate({ run, scene, sceneIndex: index, requestKey: keyFor(run.id, scene.sceneId, "validation") });
        if (!validation.ok) return this.fail(productionId, run, new ProductionRunError("RUN_DETERMINISTIC_VALIDATION_FAILED", (validation.errors ?? []).join("; ") || "Deterministic validation failed"));
        run = this.markScene(run, index, { status: "validated", validation: { ok: true, errors: validation.errors ?? [], at: now() } });
        continue;
      }
      if (scene.status === "validated") {
        if (scene.seniorReview === true && run.budget.seniorReviewBatchesUsed < run.budget.maxSeniorReviewBatches && this.adapters.startReview) {
          try { run = this.reserve(run, "senior_review", scene); } catch (error) { return this.fail(productionId, run, error as Error); }
          const handle = await this.adapters.startReview({ run, scene, sceneIndex: index, requestKey: keyFor(run.id, scene.sceneId, "review", scene.attempts) });
          run = this.markJob(run, scene.sceneId, "senior_review", "submitted", handle.jobId);
          const result = await handle.wait();
          const afterReview = this.run(productionId, run.id);
          if (afterReview.status !== "running") return afterReview;
          run = this.markJob(run, scene.sceneId, "senior_review", "succeeded", handle.jobId);
          run = this.markScene(run, index, { status: "awaiting_human", continuityReviewIds: unique([...scene.continuityReviewIds, result.reviewId]), ...(result.coverageComplete === false ? { errors: [...scene.errors, "Senior review coverage is incomplete; no automatic acceptance."] } : {}) });
        } else {
          run = this.markScene(run, index, { status: "awaiting_human" });
        }
        run = this.update(productionId, run, { status: "awaiting_human", stage: "awaiting_human", budget: this.settleActiveClock(run.budget) }, `run:${run.id}:awaiting:${scene.sceneId}`);
        return run;
      }
      return run;
    }
    return this.fail(productionId, run, new ProductionRunError("RUN_LOOP_LIMIT", "Production run exceeded its transition guard"));
  }
  private renderContext(run: ProductionRun, sceneIndex: number): Record<string, unknown> {
    const prior = [...run.scenePlan.slice(0, sceneIndex)].reverse().find((scene) => scene.status === "approved");
    if (!prior) return { priorScene: null, canonical: false, note: "No accepted run-scoped closing state before this scene." };
    const accepted = resolveAcceptedObservation(this.snapshot(run.productionId), prior);
    const state = deriveObservedState(accepted.observation.id, accepted.report);
    const body = {
      priorSceneId: prior.sceneId,
      priorCandidateId: prior.candidateId ?? null,
      priorObservationId: accepted.observation.id,
      priorObservationRevision: accepted.revision,
      priorObservationSourceHash: accepted.sourceHash,
      priorObservationSelection: accepted.selection,
      status: "run-provisional-not-canonical",
      closingState: state.closing,
      persistentState: state.persistent,
      observedEvents: state.events.map((event) => event.description),
      uncertainties: [...new Set([...(accepted.report.uncertainties ?? []), ...state.unknownBoundaryConditions])],
      evidenceReferences: [...new Set([
        ...state.boundaryEvidence.opening.map((item) => `${accepted.observation.id}:${item.id}`),
        ...state.boundaryEvidence.closing.map((item) => `${accepted.observation.id}:${item.id}`),
        ...state.events.flatMap((item) => item.evidenceReferences),
      ])],
    };
    const effectiveContextHash = contextHash(body);
    return { ...body, effectiveContextHash };
  }
  private addProvisional(run: ProductionRun, sceneId: string, result: ObservationResult): ProductionRun {
    const scene = run.scenePlan.find((item) => item.sceneId === sceneId);
    if (!scene) return run;
    if (!result.report) return this.update(run.productionId, run, { errors: [...run.errors, `Observation ${result.observationId} has no structured report; provisional facts were not created.`] }, `run:${run.id}:provisional-missing:${sceneId}`);
    const state = deriveObservedState(result.observationId, result.report);
    const text = Object.values(state.closing).flat().map((item) => item.description).filter(Boolean).join("; ") || "No observed closing state.";
    const dialogue = (result.report.dialogue?.utterances ?? []).map((utterance) => utterance.text);
    const evidence = [...new Set([...state.boundaryEvidence.opening.map((item) => `${result.observationId}:${item.id}`), ...state.boundaryEvidence.closing.map((item) => `${result.observationId}:${item.id}`), ...state.events.flatMap((item) => item.evidenceReferences)])];
    return this.update(run.productionId, run, { provisionalFacts: [...run.provisionalFacts, {
      id: `provisional-${sceneId}-${result.observationId}`, sceneId, text, intent: [...scene.intendedEvents],
      openingState: state.opening, closingState: state.closing, observedEvents: state.events.map((event) => event.description),
      dialogueAlignment: dialogue, uncertainties: [...new Set([...(result.report.uncertainties ?? []), ...state.unknownBoundaryConditions])],
      sourceObservationId: result.observationId, sourceObservationHash: result.report.sourceOutputHash, evidenceReferences: evidence, revision: result.report.reportVersion, status: "provisional",
    }] }, `run:${run.id}:provisional:${sceneId}`);
  }
  private fail(productionId: string, run: ProductionRun, error: Error): ProductionRun {
    return this.update(productionId, run, { status: "paused", stage: "awaiting_human", budget: this.settleActiveClock(run.budget), errors: [...run.errors, error.message] }, `run:${run.id}:fail:${Date.now()}`);
  }
}
