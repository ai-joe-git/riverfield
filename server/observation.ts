// Phase 1 — Riverfield Audiovisual Observer.
// A job operates on one immutable candidate binding set, extracts cached evidence, runs
// evidence-only inference through the shared queue, records an immutable observation report,
// and proposes — never approves — canonical changes.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Inference } from "./inference-queue.ts";
import type { Runner } from "./runner.ts";
import type { App } from "./registry.ts";
import { ProductionStore } from "./production-store.ts";
import { buildProductionContext } from "./production-context.ts";
import { resolveMediaPath } from "./production-media.ts";
import type {
  Actor, Candidate, FactChange, Observation, ObservationDialogue, ObservationEvidence, ObservationFinding,
  ObservationReport, ObservationStage, ObservationStageName, ObservationVisual, Scene, SceneRenderBinding,
} from "./production-types.ts";
import {
  DEFAULT_OBSERVATION_EVIDENCE_CONFIG, ObservationError, extractObservationEvidence,
  type ObservationEvidenceBundle, type ObservationEvidenceConfig,
} from "./observation-evidence.ts";
import {
  mergeDialogue, QwenVisualObserver, WhisperTurboAsr,
  type AsrAdapter, type ComparisonResult, type SceneComparator, type VisualObserver, type VisualObserverResult,
} from "./observer-inference.ts";
import { observerApp } from "./observer-app.ts";
import { COMPARISON_PROMPT_VERSION, OBSERVER_PROMPT_VERSION, OBSERVER_VERSION } from "./observer-prompts.ts";

export type ObservationJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "lost";
export type ObservationOptions = {
  maxFrames: number;
  visualFrames: number;
  sampleIntervalSeconds: number;
  sceneThreshold: number;
  includeAudio: boolean;
  visual: boolean;
  asr: boolean;
  comparison: boolean;
  referenceAssetIds: string[];
};
export const DEFAULT_OBSERVATION_OPTIONS: ObservationOptions = {
  ...DEFAULT_OBSERVATION_EVIDENCE_CONFIG, visual: true, asr: true, comparison: true, referenceAssetIds: [],
};

export type ObservationJob = {
  id: string;
  productionId: string;
  sceneId: string;
  candidateId: string;
  bindingIds: string[];
  status: ObservationJobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  observationId?: string;
  evidenceDir?: string;
  evidenceCacheKey?: string;
  artifactDir?: string;
  options: ObservationOptions;
  stages: ObservationStage[];
  progress: { stage: ObservationStageName; percent: number };
  owner?: string;
  requestKey?: string;
};

export type StartObservationInput = {
  sceneId: string;
  candidateId: string;
  bindingIds?: string[];
  options?: Partial<ObservationOptions>;
  referenceAssetIds?: string[];
  requestKey?: string;
};

export type ObservationDeps = {
  outDir: string;
  productions: ProductionStore;
  inference: Inference;
  runner: Runner;
  whisperApp?: App;
  observer?: VisualObserver & Partial<SceneComparator>;
  asr?: AsrAdapter;
  evidence?: (input: Parameters<typeof extractObservationEvidence>[0]) => ObservationEvidenceBundle;
  mediaRoots?: string[];
  now?: () => Date;
};

const nowIso = () => new Date().toISOString();
const done = (status: ObservationJobStatus) => ["succeeded", "failed", "canceled", "lost"].includes(status);
const stageNames: ObservationStageName[] = ["resolve", "evidence", "asr", "visual", "comparison", "report"];

function stageList(): ObservationStage[] {
  return stageNames.map((name) => ({ name, status: "pending" as const }));
}

function evidenceForStore(bundle: ObservationEvidenceBundle): Observation["evidence"] {
  return [
    ...bundle.frames.map((frame) => ({ type: frame.kind, path: frame.path ?? join(bundle.dir, frame.file), startFrame: frame.frame, endFrame: frame.frame })),
    ...bundle.audio.map((clip) => ({ type: "audio", path: clip.path ?? join(bundle.dir, clip.file), startFrame: clip.frame, endFrame: clip.frame })),
  ];
}

function observedEvents(visual: ObservationVisual | undefined, dialogue: ObservationDialogue | undefined) {
  const events: { text: string; evidenceIds: string[]; confidence: "confirmed" | "probable" | "uncertain" | "not_observable" }[] = [];
  for (const action of visual?.actions ?? []) {
    events.push({ text: action.description, evidenceIds: action.evidenceIds, confidence: action.evidenceIds.length ? "confirmed" : "uncertain" });
  }
  for (const utterance of dialogue?.utterances ?? []) {
    events.push({ text: `Dialogue: ${utterance.text}`, evidenceIds: utterance.evidenceIds, confidence: "uncertain" });
  }
  return events;
}

function reportSummary(report: Omit<ObservationReport, "createdAt">): string {
  const visual = report.visual ? `${report.visual.characters.length} character observation(s)` : "visual stage incomplete";
  const speech = report.dialogue?.utterances.length ? `${report.dialogue.utterances.length} transcript segment(s)` : "ASR unavailable";
  return `Automated observation: ${report.shots.length} detected shot(s), ${report.evidence.length} evidence item(s); ${visual}; ${speech}.`;
}

function fileTail(file: string, max = 240_000): string {
  try {
    const text = readFileSync(file, "utf8");
    return text.length > max ? text.slice(-max) : text;
  } catch { return ""; }
}

function sampleMemory() {
  let memAvailable: number | null = null, memTotal: number | null = null;
  try {
    const info = readFileSync("/proc/meminfo", "utf8");
    memTotal = Number(/^MemTotal:\s+(\d+)/m.exec(info)?.[1] ?? 0) || null;
    memAvailable = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1] ?? 0) || null;
  } catch { /* non-Linux or restricted */ }
  let gttUsed: number | null = null;
  try {
    const raw = readFileSync("/sys/class/drm/card1/device/mem_info_gtt_used", "utf8").trim();
    gttUsed = Number(raw) || null;
  } catch { /* no AMD sysfs */ }
  const usage = process.memoryUsage();
  return {
    at: new Date().toISOString(),
    memTotalMb: memTotal ? Math.round(memTotal / 1024) : null,
    memAvailableMb: memAvailable ? Math.round(memAvailable / 1024) : null,
    processRssMb: Math.round(usage.rss / 1024 / 1024),
    processHeapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    gttUsedMb: gttUsed ? Math.round(gttUsed / 1024 / 1024) : null,
  };
}

export class ObservationManager {
  private readonly outDir: string;
  private readonly productions: ProductionStore;
  private readonly inference: Inference;
  private readonly runner: Runner;
  private readonly observer?: VisualObserver & Partial<SceneComparator>;
  private readonly asr?: AsrAdapter;
  private readonly evidence: (input: Parameters<typeof extractObservationEvidence>[0]) => ObservationEvidenceBundle;
  private readonly mediaRoots: string[];
  private readonly now: () => Date;
  private readonly controllers = new Map<string, AbortController>();

  constructor(deps: ObservationDeps) {
    this.outDir = deps.outDir;
    this.productions = deps.productions;
    this.inference = deps.inference;
    this.runner = deps.runner;
    this.observer = deps.observer ?? new QwenVisualObserver(deps.runner, observerApp);
    this.asr = deps.asr ?? (deps.whisperApp ? new WhisperTurboAsr(deps.runner, deps.whisperApp) : undefined);
    this.evidence = deps.evidence ?? extractObservationEvidence;
    this.mediaRoots = deps.mediaRoots ?? [];
    this.now = deps.now ?? (() => new Date());
  }

  private jobsDir() { return join(this.outDir, "observations", "jobs"); }
  private jobFile(id: string) { return join(this.jobsDir(), `${id}.json`); }

  private save(job: ObservationJob) {
    mkdirSync(this.jobsDir(), { recursive: true });
    const file = this.jobFile(job.id);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(job, null, 2));
    renameSync(temp, file);
  }

  private load(id: string): ObservationJob | null {
    try { return JSON.parse(readFileSync(this.jobFile(id), "utf8")) as ObservationJob; } catch { return null; }
  }

  list(productionId?: string, sceneId?: string): ObservationJob[] {
    if (!existsSync(this.jobsDir())) return [];
    return readdirSync(this.jobsDir()).filter((file) => file.endsWith(".json"))
      .map((file) => this.load(file.slice(0, -5))).filter((job): job is ObservationJob => Boolean(job))
      .filter((job) => (!productionId || job.productionId === productionId) && (!sceneId || job.sceneId === sceneId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ObservationJob | null { return this.load(id); }

  cancel(id: string): ObservationJob | null {
    const job = this.load(id);
    if (!job) return null;
    if (done(job.status)) return job;
    this.controllers.get(id)?.abort(new Error("Observation canceled by the user"));
    job.status = "canceled";
    job.finishedAt = this.now().toISOString();
    job.error = "Canceled by the user; extracted evidence is retained.";
    job.stages = job.stages.map((stage) => stage.status === "running" ? { ...stage, status: "canceled", finishedAt: job.finishedAt } : stage);
    this.save(job);
    return job;
  }

  evidenceFile(id: string, file: string): string | null {
    const job = this.load(id);
    if (!job?.evidenceDir) return null;
    const root = resolve(job.evidenceDir);
    const candidate = resolve(root, file);
    if (candidate !== root && !candidate.startsWith(root + sep)) return null;
    return existsSync(candidate) ? candidate : null;
  }

  private stage(job: ObservationJob, name: ObservationStageName, status: ObservationStage["status"], error?: string) {
    job.stages = job.stages.map((stage) => stage.name === name
      ? { ...stage, status, ...(status === "running" ? { startedAt: this.now().toISOString() } : {}), ...(status !== "pending" && status !== "running" ? { finishedAt: this.now().toISOString() } : {}), ...(error ? { error } : {}) }
      : stage);
    const index = stageNames.indexOf(name);
    job.progress = { stage: name, percent: Math.round((index / stageNames.length) * 100) };
    this.save(job);
  }

  start(productionId: string, input: StartObservationInput, actor: Actor): ObservationJob {
    const snap = this.productions.snapshot(productionId);
    const scene = snap.scenes.find((item) => item.id === input.sceneId);
    if (!scene) throw new ObservationError("UNKNOWN_SCENE", `Unknown scene ${input.sceneId}`);
    const candidate = snap.candidates[input.candidateId];
    if (!candidate) throw new ObservationError("UNKNOWN_CANDIDATE", `Unknown candidate ${input.candidateId}`);
    const all = (snap.bindings[candidate.id] ?? []).filter((binding) => binding.sceneId === scene.id);
    const bindings = input.bindingIds?.length ? all.filter((binding) => input.bindingIds!.includes(binding.id)) : all;
    if (!bindings.length) throw new ObservationError("OBSERVATION_NO_BINDING", "This candidate has no binding for the selected scene");
    if (input.bindingIds?.length && bindings.length !== input.bindingIds.length) {
      throw new ObservationError("OBSERVATION_BINDING_SCOPE", "Every binding id must belong to this scene and candidate");
    }
    const output = candidate.outputs.find((item) => item.type === "video") ?? candidate.outputs[0];
    if (!output || output.type !== "video") throw new ObservationError("OBSERVATION_NO_VIDEO", "Audiovisual observation needs a video candidate output");
    const rawOptions = { ...DEFAULT_OBSERVATION_OPTIONS, ...(input.options ?? {}) };
    const referenceAssetIds = [...new Set([...(rawOptions.referenceAssetIds ?? []), ...(input.referenceAssetIds ?? [])])]
      .filter((id) => snap.assets[id]?.kind === "image");
    const options: ObservationOptions = { ...rawOptions, referenceAssetIds };
    const prior = this.list(productionId, scene.id).find((job) => job.requestKey && job.requestKey === input.requestKey);
    if (input.requestKey && prior) return prior;
    const id = `obs-${this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
    const job: ObservationJob = {
      id, productionId, sceneId: scene.id, candidateId: candidate.id, bindingIds: bindings.map((binding) => binding.id),
      status: "queued", createdAt: this.now().toISOString(), options, stages: stageList(),
      progress: { stage: "resolve", percent: 0 }, ...(actor.id ? { owner: actor.id } : {}),
      ...(input.requestKey ? { requestKey: input.requestKey } : {}),
    };
    this.save(job);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    void this.run(job, snap, scene, candidate, bindings, output.path, output.hash, actor, controller).finally(() => this.controllers.delete(job.id));
    return job;
  }

  private async run(
    job: ObservationJob, snap: ReturnType<ProductionStore["snapshot"]>, scene: Scene, candidate: Candidate,
    bindings: SceneRenderBinding[], sourcePath: string, sourceHash: string | undefined, actor: Actor, controller: AbortController,
  ) {
    let artifactDir: string | null = null;
    let memoryTimer: NodeJS.Timeout | null = null;
    const writeArtifact = (name: string, value: unknown, raw = false) => {
      if (!artifactDir) return;
      const target = join(artifactDir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, raw && typeof value === "string" ? value : (typeof value === "string" ? value : JSON.stringify(value, null, 2)));
    };
    try {
      job.status = "running"; job.startedAt = this.now().toISOString();
      this.stage(job, "resolve", "running");
      this.stage(job, "resolve", "succeeded");
      this.stage(job, "evidence", "running");
      const bundle = this.evidence({
        outDir: this.outDir, mediaRoots: this.mediaRoots,
        productionId: job.productionId, sceneId: job.sceneId, candidate, bindings, outputPath: sourcePath,
        outputHash: sourceHash, config: job.options,
      });
      job.evidenceDir = bundle.dir;
      job.evidenceCacheKey = bundle.cacheKey;
      this.stage(job, "evidence", "succeeded");
      artifactDir = join(this.outDir, "observations", "runs", job.id);
      mkdirSync(artifactDir, { recursive: true });
      job.artifactDir = artifactDir;
      this.save(job);
      const selectedFrames = bundle.frames.filter((frame) => bundle.visualFrameIds.includes(frame.id));
      const coveredShots = new Set(selectedFrames.map((frame) => frame.shotId).filter(Boolean));
      writeArtifact("configuration.json", {
        jobId: job.id, productionId: job.productionId, sceneId: job.sceneId, candidateId: job.candidateId,
        bindingIds: job.bindingIds, options: job.options, referenceAssetIds: job.options.referenceAssetIds,
        createdAt: job.createdAt,
      });
      writeArtifact("evidence-manifest.json", bundle);
      writeArtifact("visual-selection.json", {
        visualFrames: selectedFrames.map((frame) => ({
          id: frame.id, kind: frame.kind, file: frame.file, frame: frame.frame, timestampSeconds: frame.timestampSeconds,
          shotId: frame.shotId, bindingId: frame.bindingId, hash: frame.hash,
        })),
        detectedShots: bundle.shots.map((shot) => ({ id: shot.id, startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, detector: shot.detector })),
        coveredShots: [...coveredShots], allShotsCovered: coveredShots.size === bundle.shots.length,
        references: job.options.referenceAssetIds.map((id) => ({ id, label: snap.assets[id]?.label ?? null, path: snap.assets[id]?.path ?? null })),
      });
      if (job.options.visual && coveredShots.size !== bundle.shots.length) {
        throw new ObservationError("OBSERVATION_VISUAL_COVERAGE", `The ${job.options.visualFrames} selected visual frames cover ${coveredShots.size}/${bundle.shots.length} detected shots; refusing to run without complete shot coverage`);
      }
      writeArtifact("backend-log-before.txt", fileTail(process.env.RIVERFIELD_BACKEND_LOG || "/tmp/opencode/riverfield/backend.log"), true);
      const memoryFile = join(artifactDir, "memory.jsonl");
      appendFileSync(memoryFile, `${JSON.stringify(sampleMemory())}\n`);
      memoryTimer = setInterval(() => { try { appendFileSync(memoryFile, `${JSON.stringify(sampleMemory())}\n`); } catch { /* best effort */ } }, 2000);
      memoryTimer.unref?.();

      let visual: VisualObserverResult | undefined;
      let dialogue: ObservationDialogue | undefined;
      let comparison: ComparisonResult | undefined;
      const stageErrors: string[] = [];
      const referenceFiles = job.options.referenceAssetIds
        .map((assetId) => snap.assets[assetId])
        .filter(Boolean)
        .map((asset) => ({
          label: `reference:${asset.label}`,
          file: { bytes: new Uint8Array(readFileSync(resolveMediaPath(asset.path, this.mediaRoots))), name: basename(asset.path), type: "image/png" },
        }));

      await this.inference(`Observe ${scene.title}`, async () => {
        controller.signal.throwIfAborted();
        // Whisper first, then Qwen visual + comparison consecutively. The visual pass
        // still receives neither the transcript nor the intended screenplay.
        if (job.options.asr && this.asr && bundle.audio.length) {
          this.stage(job, "asr", "running");
          try {
            const parts: ObservationDialogue[] = [];
            for (const clip of bundle.audio) {
              if (controller.signal.aborted) throw new Error("Observation canceled");
              const boundary = bundle.nativeBoundaries.find((item) => item.bindingId === clip.bindingId);
              parts.push(await this.asr.transcribe({
                audio: clip.path!, offsetSeconds: boundary?.startSeconds ?? 0,
                fps: bundle.technical.fps,
                bindingId: clip.bindingId ?? "", signal: controller.signal,
              }));
            }
            dialogue = mergeDialogue(parts, bundle.audio.map((clip) => clip.id));
            writeArtifact("asr-raw-transcript.txt", parts.map((part) => part.rawTranscript ?? part.text).join("\n\n"), true);
            writeArtifact("asr-raw-segments.json", parts.map((part) => ({ part: part.rawSegments ?? null, text: part.text })));
            writeArtifact("asr-parsed.json", dialogue);
            this.stage(job, "asr", "succeeded");
          } catch (error) {
            const message = (error as Error).message;
            stageErrors.push(`asr: ${message}`);
            this.stage(job, "asr", controller.signal.aborted ? "canceled" : "failed", message);
          }
        } else {
          this.stage(job, "asr", "skipped");
        }

        if (job.options.visual && this.observer) {
          this.stage(job, "visual", "running");
          try {
            visual = await this.observer.observe({
              technical: bundle.technical, shots: bundle.shots,
              frames: bundle.frames.filter((frame) => bundle.visualFrameIds.includes(frame.id)),
              referenceFiles, signal: controller.signal,
            });
            writeArtifact("visual-system-prompt.txt", visual.systemPrompt ?? "", true);
            writeArtifact("visual-input-prompt.txt", visual.inputPrompt ?? "", true);
            writeArtifact("visual-images.json", {
              limit: 9,
              supplied: visual.images ?? [],
              evidenceFrames: bundle.visualFrameIds,
              references: job.options.referenceAssetIds,
            });
            writeArtifact("visual-raw.txt", visual.rawText, true);
            writeArtifact("visual-parsed.json", visual.visual);
            this.stage(job, "visual", "succeeded");
          } catch (error) {
            const message = (error as Error).message;
            stageErrors.push(`visual: ${message}`);
            this.stage(job, "visual", controller.signal.aborted ? "canceled" : "failed", message);
          }
        } else {
          this.stage(job, "visual", "skipped");
        }

        if (job.options.comparison && this.observer?.compare) {
          this.stage(job, "comparison", "running");
          try {
            const context = buildProductionContext(snap, { sceneId: scene.id, maxChars: 8000 });
            comparison = await this.observer.compare({
              intended: [scene.summary, candidate.prompt].filter(Boolean).join("\n\n"),
              canonicalOpening: context.text,
              observation: {
                visual: visual?.visual, dialogue,
                technical: bundle.technical, shots: bundle.shots, evidence: [...bundle.frames, ...bundle.audio],
              },
              coverage: `${bundle.frames.length} sampled frames across ${bundle.shots.length} detected shots; ${bundle.audio.length} scene audio range(s). Absence from a sample is not proof of absence.`,
              signal: controller.signal,
            });
            writeArtifact("comparison-system-prompt.txt", comparison.systemPrompt ?? "", true);
            writeArtifact("comparison-input-prompt.txt", comparison.inputPrompt ?? "", true);
            writeArtifact("comparison-raw.txt", comparison.rawText, true);
            writeArtifact("comparison-parsed.json", comparison.comparison);
            this.stage(job, "comparison", "succeeded");
          } catch (error) {
            const message = (error as Error).message;
            stageErrors.push(`comparison: ${message}`);
            this.stage(job, "comparison", controller.signal.aborted ? "canceled" : "failed", message);
          }
        } else {
          this.stage(job, "comparison", "skipped");
        }
      }, controller.signal);

      controller.signal.throwIfAborted();
      this.stage(job, "report", "running");
      const revision = Math.max(0, ...Object.values(snap.observations)
        .filter((item) => item.sceneId === scene.id && item.candidateId === candidate.id)
        .map((item) => item.revision ?? 0)) + 1;
      const report: ObservationReport = {
        schemaVersion: 1, reportVersion: revision,
        productionId: job.productionId, episodeId: scene.episodeId, sceneId: scene.id, candidateId: candidate.id,
        ...(candidate.sourceRunId ? { sourceRunId: candidate.sourceRunId } : {}),
        sourceOutputHash: sourceHash || bundle.source.hash,
        bindingIds: bindings.map((binding) => binding.id), timebase: "final-output",
        observer: {
          model: visual?.model ?? "qwen3.8_27b_w4a8.safetensors",
          provider: visual ? "qwen-comfyui" : "mock",
          version: visual?.version ?? OBSERVER_VERSION,
          promptVersion: visual?.promptVersion ?? OBSERVER_PROMPT_VERSION,
          configuration: {
            ...job.options, evidenceCacheKey: bundle.cacheKey,
            comparisonPromptVersion: COMPARISON_PROMPT_VERSION,
          },
        },
        createdAt: this.now().toISOString(), technical: bundle.technical,
        evidenceBudget: {
          maxFrames: job.options.maxFrames, extractedFrames: bundle.frames.length,
          visualFrames: bundle.visualFrameIds.length, mandatoryShotCoverage: true,
          semantics: "hard-cap-with-mandatory-shot-coverage",
        },
        nativeBoundaries: bundle.nativeBoundaries,
        shots: bundle.shots, ...(visual ? { visual: visual.visual } : {}), ...(dialogue ? { dialogue } : {}),
        ...(comparison ? { comparison: comparison.comparison } : {}),
        observedEvents: observedEvents(visual?.visual, dialogue), evidence: [...bundle.frames, ...bundle.audio],
        confidence: visual?.visual.claims.some((claim) => claim.confidence === "confirmed") ? "confirmed" : visual ? "probable" : "not_observable",
        uncertainties: [...(visual?.visual.uncertainties ?? []), ...(dialogue?.limitations ?? [])],
        limitations: [
          "Observation is based on sampled frames, not every frame.",
          "ASR is not corrected against the screenplay and cannot verify speaker identity, voice identity, acting quality, mixing or lip sync.",
          ...(stageErrors.length ? [`Some stages failed: ${stageErrors.join(" | ")}`] : []),
        ],
        stages: job.stages, ...(stageErrors.length ? { failure: { stage: (job.stages.find((stage) => stage.status === "failed")?.name ?? "report") as ObservationStageName, message: stageErrors.join(" | ") } } : {}),
      };
      const created = this.productions.recordObservation(job.productionId, {
        sceneId: scene.id, candidateId: candidate.id, ...(candidate.sourceRunId ? { runId: candidate.sourceRunId } : {}),
        text: reportSummary(report), evidence: evidenceForStore(bundle), kind: "analysis", revision,
        report,
      }, actor, `observation:analysis:${job.id}`);
      const observation = Object.values(created.observations).find((item) => item.report && item.report.reportVersion === revision && item.candidateId === candidate.id);
      job.observationId = observation?.id;
      writeArtifact("structured-report.json", report);
      writeArtifact("observation-record.json", observation ?? null);
      writeArtifact("errors.json", { stageErrors, failure: report.failure ?? null });
      this.stage(job, "report", "succeeded");
      job.status = "succeeded"; job.finishedAt = this.now().toISOString();
      job.progress = { stage: "report", percent: 100 };
      this.save(job);
    } catch (error) {
      job.status = controller.signal.aborted ? "canceled" : "failed";
      job.finishedAt = this.now().toISOString();
      job.error = controller.signal.aborted ? "Canceled by the user; extracted evidence is retained." : (error as Error).message;
      const running = job.stages.find((stage) => stage.status === "running")?.name ?? "report";
      this.stage(job, running, controller.signal.aborted ? "canceled" : "failed", job.error);
      writeArtifact("errors.json", { error: job.error, stages: job.stages });
      this.save(job);
    } finally {
      if (memoryTimer) clearInterval(memoryTimer);
      if (artifactDir) {
        try {
          appendFileSync(join(artifactDir, "memory.jsonl"), `${JSON.stringify(sampleMemory())}\n`);
          const backendLog = fileTail(process.env.RIVERFIELD_BACKEND_LOG || "/tmp/opencode/riverfield/backend.log", 400_000);
          writeArtifact("backend-log-after.txt", backendLog, true);
          const lines = backendLog.split(/\r?\n/);
          writeArtifact("profile.json", {
            stageSeconds: Object.fromEntries(job.stages.map((stage) => [stage.name,
              stage.startedAt && stage.finishedAt ? Math.round((Date.parse(stage.finishedAt) - Date.parse(stage.startedAt)) / 100) / 10 : null])),
            backend: {
              promptExecutions: [...backendLog.matchAll(/Prompt executed in ([0-9:.]+)(?: seconds)?/g)].map((match) => match[1]).slice(-8),
              modelLoads: lines.filter((line) => /Requested to load|loaded completely|CLIP\/text encoder model load/.test(line)).slice(-20),
              generationTail: lines.filter((line) => /Generating tokens:/.test(line)).slice(-3),
            },
            instrumentation: {
              prefill: "not separately exposed by the installed TextGenerateV2/ComfyUI log",
              decode: "not separately exposed; only total prompt execution and token progress are available",
              visionEncoding: "not separately exposed; vision frames are encoded inside the TextGenerateV2 prompt",
              modelLoading: "derived from backend Requested to load / loaded completely lines",
            },
            note: "Stage timings include shared-queue waiting and model startup. No timing value is presented as a prefill/decode split it does not measure.",
          });
          writeArtifact("job-final.json", job);
          const started = job.startedAt ? Date.parse(job.startedAt) : null;
          const finished = job.finishedAt ? Date.parse(job.finishedAt) : null;
          writeArtifact("timings.json", {
            createdAt: job.createdAt, startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
            totalSeconds: started && finished ? Math.round((finished - started) / 100) / 10 : null,
            stages: job.stages.map((stage) => ({
              name: stage.name, status: stage.status, startedAt: stage.startedAt ?? null, finishedAt: stage.finishedAt ?? null,
              seconds: stage.startedAt && stage.finishedAt ? Math.round((Date.parse(stage.finishedAt) - Date.parse(stage.startedAt)) / 100) / 10 : null,
              error: stage.error ?? null,
            })),
          });
        } catch { /* preserve the primary job even if a telemetry write fails */ }
      }
    }
  }

  /** Create a proposal from a recorded comparison. The human approval boundary is untouched. */
  proposeChanges(productionId: string, observationId: string, actor: Actor, note = "Proposed from an evidence-backed observation"): { proposal: unknown; snapshot: ReturnType<ProductionStore["snapshot"]> } {
    const snap = this.productions.snapshot(productionId);
    const observation = snap.observations[observationId];
    if (!observation?.report) throw new ObservationError("UNKNOWN_OBSERVATION", "No structured observation with this id");
    const allowedEvidence = new Set(observation.report.evidence.map((item) => item.id));
    const changes: FactChange[] = [];
    for (const raw of observation.report.comparison?.proposedChanges ?? []) {
      const evidenceIds = (raw.evidenceIds ?? []).filter((id) => allowedEvidence.has(id));
      if (!evidenceIds.length) continue;
      const text = String(raw.text ?? "").trim();
      if (!text) continue;
      const subjectIds = [...new Set((raw.subjectIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
      if (raw.category === "identity" && !subjectIds.length) continue;
      // Clothing, hair styling and props visible in one scene are current state, not
      // permanent identity. Keep a genuinely stable identity fact only when it has
      // no wardrobe/scene-state wording; otherwise propose a scene-scoped State fact.
      const clothingOrState = /\b(wears?|wearing|dress|shirt|trousers?|robe|suit|coat|jacket|outfit|wardrobe|gown|skirt|hat|shoes?|clothing|holding|holds?)\b/i.test(text);
      const category = raw.category === "identity" && clothingOrState ? "state" : raw.category;
      const phase = raw.phase ?? (category === "episodic" ? "closing" : "opening");
      changes.push({
        op: raw.op ?? "add",
        category,
        text,
        subjectIds,
        tags: [...new Set([...(raw.tags ?? []), ...(category !== raw.category ? ["scene-state", "wardrobe-not-identity"] : [])])],
        evidenceIds,
        sceneId: observation.sceneId,
        phase,
      });
    }
    if (!changes.length) throw new ObservationError("NO_PROPOSED_CHANGES", "This observation has no evidence-backed proposed canonical changes");
    return this.productions.propose(productionId, {
      title: "Observed change proposal", note, expectedRevision: snap.revision, changes,
    }, actor, `observation:propose:${observationId}`);
  }
}

