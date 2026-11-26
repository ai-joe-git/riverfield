// Phase 1 — Riverfield Audiovisual Observer.
// A job operates on one immutable candidate binding set, extracts cached evidence, runs
// evidence-only inference through the shared queue, records an immutable observation report,
// and proposes — never approves — canonical changes.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Inference } from "./inference-queue.ts";
import type { FileValue, Runner } from "./runner.ts";
import type { App } from "./registry.ts";
import { ProductionStore } from "./production-store.ts";
import { buildContinuityConstraints } from "./production-context.ts";
import { hashFile, probeMedia, resolveMediaPath } from "./production-media.ts";
import type {
  Actor, Candidate, FactChange, Observation, ObservationDialogue, ObservationEvidence, ObservationFinding,
  ObservationReport, ObservationStage, ObservationStageName, ObservationVisual, ObservationNativeEvidence, Scene, SceneRenderBinding,
} from "./production-types.ts";
import {
  DEFAULT_OBSERVATION_EVIDENCE_CONFIG, ObservationError, extractObservationEvidence,
  type ObservationEvidenceBundle, type ObservationEvidenceConfig,
} from "./observation-evidence.ts";
import {
  mergeDialogue, QwenVisualObserver, WhisperTurboAsr,
  type AsrAdapter, type ComparisonResult, type SceneComparator, type VisualObserver, type VisualObserverResult,
} from "./observer-inference.ts";
import { createObserverApp } from "./observer-app.ts";
import { ObserverProposalError, auditObservedProposals, buildProductionSubjects, normalizeObservedChange, validateObservedProposals } from "./observer-subjects.ts";
import { analysisImageManifest, createAnalysisImages, type AnalysisImage } from "./evidence-images.ts";
import { alignDialogue, dialogueAlignmentMarkdown, extractIntendedBrief, type DialogueAlignment, type IntendedBrief } from "./dialogue-alignment.ts";
import { observerProfile, profileDefaults, isObserverProfileId, type ObserverProfileId } from "./observer-profiles.ts";
import {
  DEFAULT_OBSERVER_MODEL, DEFAULT_OBSERVER_MODEL_ID, ObserverModelError,
  assertObserverModalities, observerModel, type ObserverModel,
} from "./observer-models.ts";
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
  /** Selected installed checkpoint ids; the exact filenames are resolved and recorded. */
  visualModel: string;
  comparisonModel: string;
  nativeVideo: boolean;
  nativeAudio: boolean;
  temperature: number;
  maxOutputTokens: number;
  topK: number;
  topP: number;
  seed: number;
  thinking: boolean;
  profile: ObserverProfileId;
};
export const DEFAULT_OBSERVATION_OPTIONS: ObservationOptions = {
  ...DEFAULT_OBSERVATION_EVIDENCE_CONFIG, visual: true, asr: true, comparison: true, referenceAssetIds: [],
  visualModel: DEFAULT_OBSERVER_MODEL_ID, comparisonModel: DEFAULT_OBSERVER_MODEL_ID,
  nativeVideo: false, nativeAudio: false, temperature: 0.1, maxOutputTokens: 4096,
  topK: 64, topP: 0.9, seed: 0, thinking: false, profile: "custom",
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
  modelBindings?: { visual: ObserverModel; comparison: ObserverModel };
  sourceObservationId?: string;
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
  profile?: ObserverProfileId;
  sourceObservationId?: string;
};

export type ObservationDeps = {
  outDir: string;
  productions: ProductionStore;
  inference: Inference;
  runner: Runner;
  whisperApp?: App;
  observer?: VisualObserver & Partial<SceneComparator>;
  visualObserver?: VisualObserver;
  comparator?: SceneComparator;
  asr?: AsrAdapter;
  evidence?: (input: Parameters<typeof extractObservationEvidence>[0]) => ObservationEvidenceBundle;
  mediaRoots?: string[];
  now?: () => Date;
};

const nowIso = () => new Date().toISOString();
const done = (status: ObservationJobStatus) => ["succeeded", "failed", "canceled", "lost"].includes(status);
const stageNames: ObservationStageName[] = ["resolve", "evidence", "asr", "alignment", "visual", "comparison", "report"];

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

function markExperimentalAudioUnverified(visual: VisualObserverResult): void {
  const av = visual.audiovisual;
  if (!av) return;
  av.audioVerified = false;
  for (const field of ["temporalActions", "dialogueAndReactions", "music", "environmentalSound", "soundEffects", "synchronization", "voiceDelivery", "audioArtifacts", "visualArtifacts"] as const) {
    av[field] = av[field].map((claim) => ({
      ...claim,
      verification: "unverified" as const,
      confidence: claim.confidence === "confirmed" ? "probable" as const : claim.confidence,
    }));
  }
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

function modelCheckpoint(model: ObserverModel) {
  return {
    id: model.id, file: model.file, label: model.label, family: model.family,
    quantization: model.quantization, clipType: model.clipType,
  };
}

function nativeSceneVideo(input: {
  source: string; startSeconds: number; endSeconds: number; output: string;
}): { path: string; hash: string } {
  const duration = input.endSeconds - input.startSeconds;
  if (!(duration > 0)) throw new ObserverModelError("OBSERVATION_NATIVE_VIDEO_EMPTY", "The scene has no positive duration for native video input");
  mkdirSync(dirname(input.output), { recursive: true });
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-ss", input.startSeconds.toFixed(6), "-i", input.source, "-t", duration.toFixed(6),
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", input.output,
  ], { encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new ObserverModelError("OBSERVATION_NATIVE_VIDEO_FAILED",
      `Could not extract the native scene video: ${String(result.error?.message ?? result.stderr ?? "ffmpeg failed").trim().slice(0, 500)}`);
  }
  return { path: input.output, hash: hashFile(input.output) };
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
  private readonly visualObserver?: VisualObserver;
  private readonly comparator?: SceneComparator;
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
    this.observer = deps.observer;
    this.visualObserver = deps.visualObserver;
    this.comparator = deps.comparator;
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
    const all = this.productions.activeBindings(productionId, candidate.id).filter((binding) => binding.sceneId === scene.id);
    const bindings = input.bindingIds?.length ? all.filter((binding) => input.bindingIds!.includes(binding.id)) : all;
    if (!bindings.length) throw new ObservationError("OBSERVATION_NO_BINDING", "This candidate has no binding for the selected scene");
    if (input.bindingIds?.length && bindings.length !== input.bindingIds.length) {
      throw new ObservationError("OBSERVATION_BINDING_SCOPE", "Every binding id must belong to this scene and candidate");
    }
    const output = candidate.outputs.find((item) => item.type === "video") ?? candidate.outputs[0];
    if (!output || output.type !== "video") throw new ObservationError("OBSERVATION_NO_VIDEO", "Audiovisual observation needs a video candidate output");
    const requestedProfile = input.profile ?? input.options?.profile;
    if (requestedProfile && !isObserverProfileId(requestedProfile)) throw new ObservationError("OBSERVER_PROFILE_UNKNOWN", `Unknown observer profile ${requestedProfile}`);
    const profile = observerProfile(requestedProfile);
    const explicitOptions = input.options ?? {};
    const rawOptions = {
      ...DEFAULT_OBSERVATION_OPTIONS,
      ...explicitOptions,
      ...(profile.id === "custom" ? {} : profileDefaults(profile)),
      profile: profile.id,
    };
    let sourceObservationId = input.sourceObservationId;
    if (profile.id === "senior") {
      const candidates = Object.values(snap.observations)
        .filter((item) => item.sceneId === scene.id && item.candidateId === candidate.id && item.report)
        .sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
      const source = sourceObservationId ? snap.observations[sourceObservationId] : candidates.at(-1);
      if (!source?.report) throw new ObservationError("OBSERVATION_SENIOR_SOURCE", "Senior Review needs an existing structured observation for this scene and candidate");
      if (source.sceneId !== scene.id || source.candidateId !== candidate.id) throw new ObservationError("OBSERVATION_SENIOR_SOURCE", "The source observation must belong to this scene and candidate");
      sourceObservationId = source.id;
      rawOptions.visual = false;
      rawOptions.asr = false;
      rawOptions.comparison = true;
      rawOptions.nativeVideo = false;
      rawOptions.nativeAudio = false;
    }
    const referenceAssetIds = [...new Set([...(rawOptions.referenceAssetIds ?? []), ...(input.referenceAssetIds ?? [])])]
      .filter((id) => snap.assets[id]?.kind === "image");
    const options: ObservationOptions = { ...rawOptions, referenceAssetIds };
    const resolveSelected = (id: string): ObserverModel => {
      try { return observerModel(id || DEFAULT_OBSERVER_MODEL_ID); }
      catch (error) {
        // Injected test backends do not need the local ComfyUI weights; production
        // resolution remains strict and never silently substitutes another checkpoint.
        if ((this.observer || this.visualObserver) && (!id || id === DEFAULT_OBSERVER_MODEL_ID)) return DEFAULT_OBSERVER_MODEL;
        throw error;
      }
    };
    const visualModel = resolveSelected(options.visualModel);
    const comparisonModel = resolveSelected(options.comparisonModel);
    assertObserverModalities(visualModel, { video: options.nativeVideo, audio: options.nativeAudio });
    if (options.visualFrames + referenceAssetIds.length > 9) {
      throw new ObservationError("OBSERVER_IMAGE_BUDGET", `${options.visualFrames} evidence frames plus ${referenceAssetIds.length} reference images exceed the nine-image workflow capacity`);
    }
    if (!comparisonModel.modalities.text) throw new ObserverModelError("OBSERVER_MODEL_INCOMPATIBLE", `${comparisonModel.label} cannot perform the text comparison pass`);
    if ((options.nativeVideo || options.nativeAudio) && bindings.length !== 1) {
      throw new ObservationError("OBSERVATION_NATIVE_MULTI_BINDING", "Native video/audio is limited to one selected scene binding; multiple or discontinuous bindings are rejected rather than assembled with hidden gaps");
    }
    const modelBindings = { visual: visualModel, comparison: comparisonModel };
    const prior = this.list(productionId, scene.id).find((job) => job.requestKey && job.requestKey === input.requestKey);
    if (input.requestKey && prior) return prior;
    const id = `obs-${this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
    const job: ObservationJob = {
      id, productionId, sceneId: scene.id, candidateId: candidate.id, bindingIds: bindings.map((binding) => binding.id),
      status: "queued", createdAt: this.now().toISOString(), options, modelBindings, stages: stageList(),
      ...(sourceObservationId ? { sourceObservationId } : {}),
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
    if (job.options.profile === "senior") return this.runSenior(job, snap, scene, candidate, bindings, actor, controller);
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
        outputHash: sourceHash, config: {
          maxFrames: job.options.maxFrames, visualFrames: job.options.visualFrames,
          sampleIntervalSeconds: job.options.sampleIntervalSeconds, sceneThreshold: job.options.sceneThreshold,
          includeAudio: job.options.includeAudio,
        },
      });
      job.evidenceDir = bundle.dir;
      job.evidenceCacheKey = bundle.cacheKey;
      this.stage(job, "evidence", "succeeded");
      artifactDir = join(this.outDir, "observations", "runs", job.id);
      mkdirSync(artifactDir, { recursive: true });
      job.artifactDir = artifactDir;
      this.save(job);
      const selectedFrames = bundle.visualFrameIds
        .map((id) => bundle.frames.find((frame) => frame.id === id))
        .filter((frame): frame is ObservationEvidence => Boolean(frame));
      let analysisImages: AnalysisImage[] = [];
      const coveredShots = new Set(selectedFrames.map((frame) => frame.shotId).filter(Boolean));
      writeArtifact("configuration.json", {
        jobId: job.id, productionId: job.productionId, sceneId: job.sceneId, candidateId: job.candidateId,
        bindingIds: job.bindingIds, options: job.options, referenceAssetIds: job.options.referenceAssetIds,
        createdAt: job.createdAt,
      });
      writeArtifact("production-subjects.json", buildProductionSubjects(snap, scene.id));
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
      let dialogueAlignment: DialogueAlignment | undefined;
      let comparison: ComparisonResult | undefined;
      const intendedBrief: IntendedBrief = extractIntendedBrief(candidate.prompt || scene.summary, candidate.prompt ? "candidate-prompt" : "scene");
      const stageErrors: string[] = [];
      const referenceFiles = job.options.referenceAssetIds
        .map((assetId) => snap.assets[assetId])
        .filter(Boolean)
        .map((asset) => ({
          label: `reference:${asset.label}`,
          file: { bytes: new Uint8Array(readFileSync(resolveMediaPath(asset.path, this.mediaRoots))), name: basename(asset.path), type: "image/png" },
        }));
      if (job.options.visual) {
        const referenceInputs = job.options.referenceAssetIds
          .map((assetId) => snap.assets[assetId])
          .filter(Boolean)
          .map((asset) => ({ id: asset.id, label: `reference:${asset.label}`, path: resolveMediaPath(asset.path, this.mediaRoots), hash: asset.hash }));
        analysisImages = createAnalysisImages({
          frames: selectedFrames, references: referenceInputs,
          outputDir: join(artifactDir, "analysis"),
        });
        writeArtifact("analysis-images.json", analysisImageManifest(analysisImages));
      }

      const visualModel = job.modelBindings?.visual ?? observerModel(job.options.visualModel || DEFAULT_OBSERVER_MODEL_ID);
      const comparisonModel = job.modelBindings?.comparison ?? observerModel(job.options.comparisonModel || DEFAULT_OBSERVER_MODEL_ID);
      const visualBackend: VisualObserver = this.visualObserver ?? this.observer ?? new QwenVisualObserver(
        this.runner, createObserverApp(visualModel), {
          model: visualModel.file, clipType: visualModel.clipType, maxImages: 9, maxReferenceImages: Math.max(0, 9 - job.options.visualFrames),
          maxOutputTokens: job.options.maxOutputTokens, temperature: job.options.temperature,
          topK: job.options.topK, topP: job.options.topP, seed: job.options.seed, thinking: job.options.thinking,
          checkpoint: { file: visualModel.file, quantization: visualModel.quantization, clipType: visualModel.clipType, family: visualModel.family },
        });
      const comparisonBackend: SceneComparator = this.comparator ??
        (this.observer?.compare ? this.observer as SceneComparator : undefined) ??
        new QwenVisualObserver(this.runner, createObserverApp(comparisonModel), {
          model: comparisonModel.file, clipType: comparisonModel.clipType, maxImages: 0,
          maxOutputTokens: job.options.maxOutputTokens, temperature: job.options.temperature,
          topK: job.options.topK, topP: job.options.topP, seed: job.options.seed, thinking: job.options.thinking,
          checkpoint: { file: comparisonModel.file, quantization: comparisonModel.quantization, clipType: comparisonModel.clipType, family: comparisonModel.family },
        });

      const nativeInputs: NonNullable<ObservationReport["observer"]["nativeInputs"]> = {};
      const nativeEvidence: ObservationNativeEvidence[] = [];
      const nativeLimitations: string[] = [];
      const selectedBoundary = bundle.nativeBoundaries[0];
      let nativeVideo: FileValue | undefined;
      let nativeAudio: FileValue | undefined;
      if (job.options.nativeVideo) {
        const clip = nativeSceneVideo({
          source: bundle.technical.sourcePath, startSeconds: bundle.technical.sceneStartSeconds, endSeconds: bundle.technical.sceneEndSeconds,
          output: join(artifactDir, "native", "scene.mp4"),
        });
        nativeVideo = { bytes: new Uint8Array(readFileSync(clip.path)), name: "scene.mp4", type: "video/mp4" };
        nativeInputs.video = { file: "native/scene.mp4", hash: clip.hash, startSeconds: bundle.technical.sceneStartSeconds, endSeconds: bundle.technical.sceneEndSeconds, sourceHash: bundle.technical.sourceHash };
        const clipProbe = probeMedia(clip.path);
        nativeEvidence.push({
          id: "video-01", kind: "video", file: "native/scene.mp4", path: clip.path, hash: clip.hash, mime: "video/mp4",
          startSeconds: selectedBoundary?.startSeconds ?? bundle.technical.sceneStartSeconds,
          endSeconds: selectedBoundary?.endSeconds ?? bundle.technical.sceneEndSeconds,
          durationSeconds: clipProbe.duration ?? ((selectedBoundary?.endSeconds ?? bundle.technical.sceneEndSeconds) - (selectedBoundary?.startSeconds ?? bundle.technical.sceneStartSeconds)),
          fps: clipProbe.fps ?? bundle.technical.fps,
          ...(clipProbe.frameCount ? { frameCount: clipProbe.frameCount } : {}),
          ...(selectedBoundary ? { bindingId: selectedBoundary.bindingId } : {}),
          sourceHash: bundle.technical.sourceHash,
          backendPreprocessing: "GetVideoComponents supplies source-rate IMAGE frames; TextGenerateV2's videos input assumes 24 fps and subsamples internally",
        });
        if (bundle.technical.fps !== 24) nativeLimitations.push(`Native video frames were extracted at ${bundle.technical.fps} fps; TextGenerateV2's video input assumes 24 fps.`);
        if (bindings.length > 1) nativeLimitations.push("Native video spans the union of the selected bindings, including any gap between them.");
      }
      if (job.options.nativeAudio) {
        const clip = bundle.audio[0];
        if (!clip?.path) throw new ObserverModelError("OBSERVATION_NATIVE_AUDIO_MISSING", "Native audio was requested but no scene audio stream was extracted");
        nativeAudio = { bytes: new Uint8Array(readFileSync(clip.path)), name: basename(clip.path), type: "audio/wav" };
        nativeInputs.audio = { file: clip.file, hash: clip.hash ?? hashFile(clip.path), startSeconds: clip.timestampSeconds ?? 0, endSeconds: selectedBoundary?.endSeconds ?? bundle.technical.sceneEndSeconds, sourceHash: bundle.technical.sourceHash };
        nativeEvidence.push({
          id: clip.id, kind: "audio", file: clip.file, path: clip.path, hash: clip.hash ?? hashFile(clip.path), mime: clip.mime ?? "audio/wav",
          startSeconds: clip.timestampSeconds ?? selectedBoundary?.startSeconds ?? 0,
          endSeconds: selectedBoundary?.endSeconds ?? bundle.technical.sceneEndSeconds,
          durationSeconds: (selectedBoundary?.endSeconds ?? bundle.technical.sceneEndSeconds) - (clip.timestampSeconds ?? selectedBoundary?.startSeconds ?? 0),
          sampleRate: 16000,
          ...(selectedBoundary ? { bindingId: selectedBoundary.bindingId } : {}),
          sourceHash: bundle.technical.sourceHash,
          backendPreprocessing: "scene WAV: mono 16 kHz PCM s16le; LoadAudio -> TextGenerateV2 audios.audio1",
        });
      }
      writeArtifact("native-inputs.json", { requested: { video: job.options.nativeVideo, audio: job.options.nativeAudio }, supplied: nativeInputs, evidence: nativeEvidence, limitations: nativeLimitations });

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

        this.stage(job, "alignment", "running");
        try {
          dialogueAlignment = alignDialogue(intendedBrief.utterances, dialogue);
          writeArtifact("intended-brief.json", intendedBrief);
          writeArtifact("dialogue-alignment.json", dialogueAlignment);
          writeArtifact("dialogue-alignment.md", dialogueAlignmentMarkdown(dialogueAlignment), true);
          this.stage(job, "alignment", "succeeded");
        } catch (error) {
          const message = (error as Error).message;
          stageErrors.push(`alignment: ${message}`);
          this.stage(job, "alignment", controller.signal.aborted ? "canceled" : "failed", message);
        }

        if (job.options.visual) {
          this.stage(job, "visual", "running");
          try {
            visual = await visualBackend.observe({
              technical: bundle.technical, shots: bundle.shots,
              frames: bundle.visualFrameIds
                .map((id) => bundle.frames.find((frame) => frame.id === id))
                .filter((frame): frame is ObservationEvidence => Boolean(frame)),
              referenceFiles, ...(nativeVideo ? { video: nativeVideo } : {}), ...(nativeAudio ? { audio: nativeAudio } : {}),
              nativeEvidence, analysisImages,
              signal: controller.signal,
            });
            if (job.options.profile === "experimental-av") markExperimentalAudioUnverified(visual);
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
            const raw = (error as Error & { rawText?: string }).rawText;
            if (raw) writeArtifact("visual-raw.txt", raw, true);
            stageErrors.push(`visual: ${message}`);
            this.stage(job, "visual", controller.signal.aborted ? "canceled" : "failed", message);
          }
        } else {
          this.stage(job, "visual", "skipped");
        }

        if (job.options.comparison) {
          this.stage(job, "comparison", "running");
          try {
            comparison = await comparisonBackend.compare({
              intended: scene.summary,
              canonicalOpening: buildContinuityConstraints(snap, scene.id),
              continuityConstraints: buildContinuityConstraints(snap, scene.id),
              intendedBrief, dialogueAlignment,
              observation: {
                visual: visual?.visual, audiovisual: visual?.audiovisual, nativeEvidence, dialogue,
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
            const raw = (error as Error & { rawText?: string }).rawText;
            if (raw) writeArtifact("comparison-raw.txt", raw, true);
            stageErrors.push(`comparison: ${message}`);
            this.stage(job, "comparison", controller.signal.aborted ? "canceled" : "failed", message);
          }
        } else {
          this.stage(job, "comparison", "skipped");
        }
      }, controller.signal);

      controller.signal.throwIfAborted();
      this.stage(job, "report", "running");
      let proposalAudit: ObservationReport["proposalAudit"];
      if (comparison) {
        const allowedEvidence = new Set([...bundle.frames, ...bundle.audio, ...nativeEvidence].map((item) => item.id));
        proposalAudit = auditObservedProposals({
          changes: comparison.comparison.proposedChanges, snapshot: snap, sceneId: scene.id, allowedEvidence,
        });
        writeArtifact("proposal-validation.json", proposalAudit);
      }
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
          model: visualModel.file,
          provider: visual ? "comfyui" : "mock",
          version: visual?.version ?? OBSERVER_VERSION,
          promptVersion: visual?.promptVersion ?? OBSERVER_PROMPT_VERSION,
          configuration: {
            ...job.options, evidenceCacheKey: bundle.cacheKey,
            comparisonPromptVersion: COMPARISON_PROMPT_VERSION,
            visualCheckpoint: modelCheckpoint(visualModel), comparisonCheckpoint: modelCheckpoint(comparisonModel),
          },
          visualCheckpoint: modelCheckpoint(visualModel), comparisonCheckpoint: modelCheckpoint(comparisonModel),
          inputModalities: visual?.inputModalities ?? { text: true, image: job.options.visual, video: Boolean(nativeVideo), audio: Boolean(nativeAudio) },
          observationMode: visual?.observationMode ?? (nativeVideo || nativeAudio ? "audiovisual" : "visual"),
          profile: job.options.profile,
          experimental: job.options.profile === "experimental-av",
          audioClaimsUnverified: job.options.profile === "experimental-av",
          effectiveConfiguration: {
            visual: { ...(visual?.configuration ?? {}), checkpoint: modelCheckpoint(visualModel) },
            comparison: { ...(comparison?.configuration ?? {}), checkpoint: modelCheckpoint(comparisonModel) },
            nativeInputs: { video: Boolean(nativeVideo), audio: Boolean(nativeAudio) },
          },
          ...(Object.keys(nativeInputs).length ? { nativeInputs } : {}),
        },
        createdAt: this.now().toISOString(), technical: bundle.technical,
        evidenceBudget: {
          maxFrames: job.options.maxFrames, extractedFrames: bundle.frames.length,
          visualFrames: bundle.visualFrameIds.length, mandatoryShotCoverage: true,
          semantics: "hard-cap-with-mandatory-shot-coverage",
        },
        nativeBoundaries: bundle.nativeBoundaries,
        shots: bundle.shots, intendedBrief, ...(dialogueAlignment ? { dialogueAlignment } : {}),
        ...(analysisImages.length ? { analysisImages } : {}),
        ...(visual ? { visual: visual.visual } : {}),
        ...(visual?.audiovisual ? { audiovisual: visual.audiovisual } : {}),
        ...(nativeEvidence.length ? { nativeEvidence } : {}),
        ...(dialogue ? { dialogue } : {}),
        ...(comparison ? { comparison: comparison.comparison } : {}),
        ...(proposalAudit ? { proposalAudit } : {}),
        observedEvents: observedEvents(visual?.visual, dialogue), evidence: [...bundle.frames, ...bundle.audio],
        confidence: visual?.visual.claims.some((claim) => claim.confidence === "confirmed") ? "confirmed" : visual ? "probable" : "not_observable",
        uncertainties: [...(visual?.visual.uncertainties ?? []), ...(dialogue?.limitations ?? [])],
        limitations: [
          "Observation is based on sampled frames, not every frame.",
          "ASR is not corrected against the screenplay and cannot verify speaker identity, voice identity, acting quality, mixing or lip sync.",
          ...nativeLimitations,
          ...(job.options.profile === "experimental-av" ? ["Experimental audiovisual observations are unverified model claims; music, sound effects, synchronization and voice quality are not confirmed evidence."] : []),
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

  /** Qwen3.8 reviews an existing observation without repeating extraction, ASR or visual inference. */
  private async runSenior(
    job: ObservationJob, snap: ReturnType<ProductionStore["snapshot"]>, scene: Scene, candidate: Candidate,
    bindings: SceneRenderBinding[], actor: Actor, controller: AbortController,
  ) {
    const source = job.sourceObservationId ? snap.observations[job.sourceObservationId] : undefined;
    const sourceReport = source?.report;
    if (!source || !sourceReport) throw new ObservationError("OBSERVATION_SENIOR_SOURCE", "No structured source observation is available for Senior Review");
    const artifactDir = join(this.outDir, "observations", "runs", job.id);
    mkdirSync(artifactDir, { recursive: true });
    job.artifactDir = artifactDir;
    const firstEvidence = sourceReport.evidence.find((item) => item.path);
    if (firstEvidence?.path) job.evidenceDir = dirname(dirname(firstEvidence.path));
    job.status = "running"; job.startedAt = this.now().toISOString();
    this.save(job);
    const writeArtifact = (name: string, value: unknown, raw = false) => {
      const target = join(artifactDir, name); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, raw && typeof value === "string" ? value : (typeof value === "string" ? value : JSON.stringify(value, null, 2)));
    };
    try {
      this.stage(job, "resolve", "running"); this.stage(job, "resolve", "succeeded");
      this.stage(job, "evidence", "skipped"); this.stage(job, "asr", "skipped"); this.stage(job, "visual", "skipped");
      const comparisonModel = job.modelBindings?.comparison ?? observerModel(job.options.comparisonModel || DEFAULT_OBSERVER_MODEL_ID);
      const comparisonBackend: SceneComparator = this.comparator ??
        (this.observer?.compare ? this.observer as SceneComparator : undefined) ??
        new QwenVisualObserver(this.runner, createObserverApp(comparisonModel), {
          model: comparisonModel.file, clipType: comparisonModel.clipType, maxImages: 0,
          maxOutputTokens: job.options.maxOutputTokens, temperature: job.options.temperature,
          topK: job.options.topK, topP: job.options.topP, seed: job.options.seed, thinking: job.options.thinking,
          checkpoint: { file: comparisonModel.file, quantization: comparisonModel.quantization, clipType: comparisonModel.clipType, family: comparisonModel.family },
        });
      const intendedBrief = extractIntendedBrief(candidate.prompt || scene.summary, candidate.prompt ? "candidate-prompt" : "scene");
      const dialogueAlignment = alignDialogue(intendedBrief.utterances, sourceReport.dialogue);
      const continuity = buildContinuityConstraints(snap, scene.id);
      writeArtifact("configuration.json", {
        jobId: job.id, profile: job.options.profile, sourceObservationId: source.id, sourceRevision: source.revision,
        productionId: job.productionId, sceneId: scene.id, candidateId: candidate.id, options: job.options, createdAt: job.createdAt,
      });
      writeArtifact("source-observation.json", source);
      writeArtifact("production-subjects.json", buildProductionSubjects(snap, scene.id));
      writeArtifact("intended-brief.json", intendedBrief);
      writeArtifact("dialogue-alignment.json", dialogueAlignment);
      writeArtifact("dialogue-alignment.md", dialogueAlignmentMarkdown(dialogueAlignment), true);
      this.stage(job, "alignment", "running"); this.stage(job, "alignment", "succeeded");
      let comparison: ComparisonResult | undefined;
      const stageErrors: string[] = [];
      this.stage(job, "comparison", "running");
      try {
        comparison = await comparisonBackend.compare({
          intended: scene.summary, canonicalOpening: continuity, continuityConstraints: continuity,
          intendedBrief, dialogueAlignment,
          observation: {
            visual: sourceReport.visual, audiovisual: sourceReport.audiovisual, nativeEvidence: sourceReport.nativeEvidence,
            dialogue: sourceReport.dialogue, technical: sourceReport.technical, shots: sourceReport.shots, evidence: sourceReport.evidence,
          },
          coverage: `Senior review reuses existing observation ${source.id} (revision ${source.revision}); no new media evidence was extracted.`,
          signal: controller.signal,
        });
        writeArtifact("comparison-system-prompt.txt", comparison.systemPrompt ?? "", true);
        writeArtifact("comparison-input-prompt.txt", comparison.inputPrompt ?? "", true);
        writeArtifact("comparison-raw.txt", comparison.rawText, true);
        writeArtifact("comparison-parsed.json", comparison.comparison);
        this.stage(job, "comparison", "succeeded");
      } catch (error) {
        const message = (error as Error).message;
        const raw = (error as Error & { rawText?: string }).rawText;
        if (raw) writeArtifact("comparison-raw.txt", raw, true);
        stageErrors.push(`comparison: ${message}`);
        this.stage(job, "comparison", controller.signal.aborted ? "canceled" : "failed", message);
      }
      controller.signal.throwIfAborted();
      this.stage(job, "report", "running");
      const revision = Math.max(0, ...Object.values(snap.observations)
        .filter((item) => item.sceneId === scene.id && item.candidateId === candidate.id)
        .map((item) => item.revision ?? 0)) + 1;
      const report: ObservationReport = {
        schemaVersion: 1, reportVersion: revision,
        productionId: job.productionId, episodeId: scene.episodeId, sceneId: scene.id, candidateId: candidate.id,
        ...(candidate.sourceRunId ? { sourceRunId: candidate.sourceRunId } : {}),
        sourceOutputHash: sourceReport.sourceOutputHash, bindingIds: bindings.map((binding) => binding.id), timebase: "final-output",
        intendedBrief, dialogueAlignment,
        seniorReview: {
          sourceObservationId: source.id, sourceRevision: source.revision ?? 1,
          reviewedAt: this.now().toISOString(), reusedEvidence: true,
          reusedVisual: Boolean(sourceReport.visual), reusedDialogue: Boolean(sourceReport.dialogue),
        },
        observer: {
          model: comparisonModel.file, provider: "comfyui", version: OBSERVER_VERSION, promptVersion: COMPARISON_PROMPT_VERSION,
          configuration: {
            profile: "senior", sourceObservationId: source.id, sourceRevision: source.revision,
            temperature: job.options.temperature, maxOutputTokens: job.options.maxOutputTokens,
            topK: job.options.topK, topP: job.options.topP, seed: job.options.seed, thinking: job.options.thinking,
            ...(typeof sourceReport.observer.configuration.evidenceCacheKey === "string" ? { evidenceCacheKey: sourceReport.observer.configuration.evidenceCacheKey } : {}),
          },
          ...(sourceReport.observer.visualCheckpoint ? { visualCheckpoint: sourceReport.observer.visualCheckpoint } : {}),
          comparisonCheckpoint: modelCheckpoint(comparisonModel),
          ...(sourceReport.observer.inputModalities ? { inputModalities: sourceReport.observer.inputModalities } : {}),
          observationMode: sourceReport.observer.observationMode ?? "visual",
          profile: "senior", experimental: false,
          effectiveConfiguration: {
            comparison: { ...(comparison?.configuration ?? {}), checkpoint: modelCheckpoint(comparisonModel) },
            reusedEvidence: true, reusedVisual: Boolean(sourceReport.visual), reusedDialogue: Boolean(sourceReport.dialogue),
          },
        },
        createdAt: this.now().toISOString(), technical: sourceReport.technical,
        nativeBoundaries: sourceReport.nativeBoundaries, shots: sourceReport.shots,
        ...(sourceReport.visual ? { visual: sourceReport.visual } : {}),
        ...(sourceReport.audiovisual ? { audiovisual: sourceReport.audiovisual } : {}),
        ...(sourceReport.nativeEvidence?.length ? { nativeEvidence: sourceReport.nativeEvidence } : {}),
        ...(sourceReport.dialogue ? { dialogue: sourceReport.dialogue } : {}),
        ...(comparison ? { comparison: comparison.comparison } : {}),
        observedEvents: sourceReport.observedEvents, evidence: sourceReport.evidence,
        confidence: sourceReport.confidence, uncertainties: sourceReport.uncertainties,
        limitations: [...sourceReport.limitations, "Senior Review reused the source observation and evidence; it did not rerun extraction, ASR or visual inference.", ...(stageErrors.length ? [`Senior comparison failed: ${stageErrors.join(" | ")}`] : [])],
        stages: job.stages,
        ...(stageErrors.length ? { failure: { stage: "comparison" as ObservationStageName, message: stageErrors.join(" | ") } } : {}),
      };
      const created = this.productions.recordObservation(job.productionId, {
        sceneId: scene.id, candidateId: candidate.id, ...(candidate.sourceRunId ? { runId: candidate.sourceRunId } : {}),
        text: `Senior review of observation ${source.id}: ${reportSummary(report)}`, evidence: sourceReport.evidence.map((item) => ({
          type: item.kind, path: item.path ?? item.file, startFrame: item.frame, endFrame: item.frame,
        })), kind: "analysis", revision, report,
      }, actor, `observation:senior:${job.id}:${source.id}`);
      const observation = Object.values(created.observations).find((item) => item.report?.reportVersion === revision && item.candidateId === candidate.id);
      job.observationId = observation?.id;
      writeArtifact("structured-report.json", report);
      writeArtifact("observation-record.json", observation ?? null);
      writeArtifact("errors.json", { stageErrors, failure: report.failure ?? null });
      this.stage(job, "report", "succeeded");
      job.status = "succeeded"; job.finishedAt = this.now().toISOString(); job.progress = { stage: "report", percent: 100 };
      this.save(job);
      const started = Date.parse(job.startedAt), finished = Date.parse(job.finishedAt);
      writeArtifact("timings.json", {
        createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
        totalSeconds: Math.round((finished - started) / 100) / 10,
        stages: job.stages.map((stage) => ({ name: stage.name, status: stage.status, startedAt: stage.startedAt ?? null, finishedAt: stage.finishedAt ?? null,
          seconds: stage.startedAt && stage.finishedAt ? Math.round((Date.parse(stage.finishedAt) - Date.parse(stage.startedAt)) / 100) / 10 : null, error: stage.error ?? null })),
        reused: { sourceObservationId: source.id, evidence: true, visual: Boolean(sourceReport.visual), dialogue: Boolean(sourceReport.dialogue) },
      });
    } catch (error) {
      job.status = controller.signal.aborted ? "canceled" : "failed";
      job.finishedAt = this.now().toISOString(); job.error = (error as Error).message;
      const running = job.stages.find((stage) => stage.status === "running")?.name ?? "report";
      this.stage(job, running, controller.signal.aborted ? "canceled" : "failed", job.error);
      writeArtifact("errors.json", { error: job.error, stages: job.stages });
      this.save(job);
    }
  }

  /** Create a proposal from a recorded comparison. The human approval boundary is untouched. */
  proposeChanges(productionId: string, observationId: string, actor: Actor, note = "Proposed from an evidence-backed observation"): { proposal: unknown; snapshot: ReturnType<ProductionStore["snapshot"]> } {
    const snap = this.productions.snapshot(productionId);
    const observation = snap.observations[observationId];
    if (!observation?.report) throw new ObservationError("UNKNOWN_OBSERVATION", "No structured observation with this id");
    const allowedEvidence = new Set([
      ...observation.report.evidence.map((item) => item.id),
      ...(observation.report.nativeEvidence ?? []).map((item) => item.id),
    ]);
    const rawChanges = observation.report.comparison?.proposedChanges ?? [];
    const normalized = rawChanges.filter((raw) => String(raw.text ?? "").trim()).map(normalizeObservedChange);
    let changes: FactChange[];
    try {
      changes = validateObservedProposals({
        changes: normalized, snapshot: snap, sceneId: observation.sceneId, allowedEvidence,
      }).changes;
    } catch (error) {
      if (error instanceof ObserverProposalError) throw new ObservationError(error.code, error.message);
      throw error;
    }
    if (!changes.length) throw new ObservationError("NO_PROPOSED_CHANGES", "This observation has no evidence-backed proposed canonical changes");
    return this.productions.propose(productionId, {
      title: "Observed change proposal", note, expectedRevision: snap.revision, changes,
    }, actor, `observation:propose:${observationId}`);
  }
}

