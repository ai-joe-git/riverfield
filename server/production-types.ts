// Riverfield Production Engine — Phase 0 data contracts.
// These types are engine-independent: H3, Pika, pi-H3 and LTX are execution clients.
import { createHash } from "node:crypto";
import type { DialogueAlignment } from "./dialogue-alignment.ts";
import type { AnalysisImage } from "./evidence-images.ts";

export const PRODUCTION_SCHEMA_VERSION = 1 as const;
export const MEMORY_CATEGORIES = ["identity", "state", "episodic", "narrative"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type ActorKind = "agent" | "human" | "import" | "system";
export type Actor = { kind: ActorKind; id?: string };

export type Provenance = {
  source: ActorKind;
  actorId?: string;
  sourceEventId?: string;
  sourceRunId?: string;
  note?: string;
};

export type ProductionMeta = {
  id: string;
  title: string;
  logline: string;
  description?: string;
  style?: string;
  status: "draft" | "active" | "archived";
  createdAt: string;
  createdBy: string;
};

export type Season = {
  id: string;
  productionId: string;
  number: number;
  title: string;
  createdAt: string;
};

export type EpisodeStatus = "draft" | "active" | "archived";
export type Episode = {
  id: string;
  productionId: string;
  seasonId: string;
  number: number;
  title: string;
  status: EpisodeStatus;
  createdAt: string;
};

export type Scene = {
  id: string;
  productionId: string;
  episodeId: string;
  number: number;
  title: string;
  status: "draft" | "canon" | "archived";
  characterIds: string[];
  locationIds: string[];
  summary: string;
  createdAt: string;
};

export type CandidateOutput = {
  type: "video" | "image" | "audio" | "text" | "file";
  file: string;
  name: string;
  path: string;
  hash?: string;
  fps?: number;
  frameCount?: number;
  duration?: number;
  verified?: boolean;
};

export type CandidateSegment = {
  index: number;
  prompt: string;
  images: number[];
  audios: number[];
  videos?: number[];
  startFrame?: number;
  endFrame?: number;
};

export type CandidateProvenance = {
  brief?: string;
  segments: CandidateSegment[];
  render?: Record<string, unknown>;
  output?: { fps?: number; frameCount?: number; duration?: number; verified: boolean };
  timebase: "final-output";
  overlaps?: number[];
};

export type Candidate = {
  id: string;
  productionId: string;
  label: string;
  source: "history" | "manual" | "import";
  sourceRunId?: string;
  app?: string;
  prompt?: string;
  outputs: CandidateOutput[];
  bindings: SceneRenderBinding[];
  render?: Record<string, unknown>;
  provenance?: CandidateProvenance;
  createdAt: string;
  createdBy: string;
  /** Immutable content hash; a different candidate can never reuse it silently. */
  contentHash: string;
};

export type SceneRenderBinding = {
  id: string;
  sceneId: string;
  candidateId: string;
  runId?: string;
  /** The frame coordinates below are in the final rendered output. */
  timebase: "final-output";
  timelineStartFrame: number;
  timelineEndFrame: number;
  segmentIndex: number;
  sourceStartFrame?: number;
  sourceEndFrame?: number;
  outputHash?: string;
  fps?: number;
};

export type BindingCorrection = {
  id: string;
  candidateId: string;
  originalBindingId: string;
  originalSceneId: string;
  correctedBindingId: string;
  correctedSceneId: string;
  timelineStartFrame: number;
  timelineEndFrame: number;
  sourceHash: string;
  candidateContentHash: string;
  sourceRunId?: string;
  reason: string;
  sources: string[];
  createdAt: string;
  createdBy: string;
  supersedesOriginal: true;
};

export type FactPhase = "opening" | "closing" | "global";

export type FactRevision = {
  revision: number;
  text: string;
  subjectIds: string[];
  tags: string[];
  sceneId?: string;
  phase: FactPhase;
  data?: unknown;
  provenance: Provenance;
  approvedAt: string;
  approvedBy: string;
  sourceEventId: string;
};

// Phase 1 — Audiovisual Observer contracts. These are evidence records, never canonical facts.
export const OBSERVATION_SCHEMA_VERSION = 1 as const;
export type ObservationConfidence = "confirmed" | "probable" | "uncertain" | "not_observable";
export type ObservationStateValueSource = "visual" | "comparison" | "dialogue" | "review";
export type ObservationStageName = "resolve" | "evidence" | "asr" | "alignment" | "visual" | "comparison" | "report";
export type ObservationStageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled";
export type ObservationStage = {
  name: ObservationStageName;
  status: ObservationStageStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type ObservationEvidence = {
  id: string;
  kind: "opening_frame" | "closing_frame" | "shot_frame" | "sample_frame" | "reference_frame" | "audio" | "video";
  file: string;
  path?: string;
  hash?: string;
  mime?: string;
  timestampSeconds?: number;
  frame?: number;
  bindingId?: string;
  shotId?: string;
  label?: string;
};

export type ObservationTechnical = {
  sourcePath: string;
  sourceHash: string;
  sourceVerified: boolean;
  width?: number;
  height?: number;
  fps: number;
  frameCount?: number;
  duration: number;
  videoCodec?: string;
  audioStreams: { codec?: string; sampleRate?: number; channels?: number; duration?: number }[];
  sceneStartFrame: number;
  sceneEndFrame: number;
  sceneStartSeconds: number;
  sceneEndSeconds: number;
};

export type ObservationShot = {
  id: string;
  bindingId: string;
  segmentIndex: number;
  startFrame: number;
  endFrame: number;
  startSeconds: number;
  endSeconds: number;
  detector: "ffmpeg-scene" | "native-segment";
  evidenceIds: string[];
};

export type ObservationClaim = {
  text: string;
  evidenceIds: string[];
  confidence: ObservationConfidence;
};

export type ObservationCharacter = {
  description: string;
  identityMatch: "matches" | "probable" | "uncertain" | "not_observable";
  identitySubject?: string;
  clothing?: string;
  hair?: string;
  physicalAppearance?: string;
  evidenceIds: string[];
  uncertainties?: string[];
};

export type ObservationVisual = {
  characters: ObservationCharacter[];
  location?: { description: string; evidenceIds: string[]; confidence: ObservationConfidence };
  props: { description: string; state?: string; evidenceIds: string[] }[];
  actions: { description: string; evidenceIds: string[] }[];
  composition: { description: string; evidenceIds: string[] }[];
  expressions: { description: string; evidenceIds: string[] }[];
  stylisticEffects?: { description: string; evidenceIds: string[] }[];
  artifacts: { description: string; evidenceIds: string[] }[];
  openingState?: { description: string; evidenceIds: string[] };
  closingState?: { description: string; evidenceIds: string[] };
  uncertainties: string[];
  claims: ObservationClaim[];
};

export type ObservationNativeEvidence = {
  id: string;
  kind: "video" | "audio";
  file: string;
  path?: string;
  hash: string;
  mime: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  fps?: number;
  frameCount?: number;
  sampleRate?: number;
  bindingId?: string;
  sourceHash: string;
  /** How the backend consumes the native media, where it is known. */
  backendPreprocessing?: string;
};

export type ObservationAudiovisualClaim = {
  description: string;
  evidenceIds: string[];
  confidence: ObservationConfidence;
  /** Native-media claims are model observations until independently reviewed. */
  verification?: "unverified" | "independently_supported";
};

export type ObservationAudiovisual = {
  mode: "audiovisual";
  audioVerified?: boolean;
  supplied: { videoId?: string; audioId?: string };
  temporalActions: ObservationAudiovisualClaim[];
  dialogueAndReactions: ObservationAudiovisualClaim[];
  music: ObservationAudiovisualClaim[];
  environmentalSound: ObservationAudiovisualClaim[];
  soundEffects: ObservationAudiovisualClaim[];
  synchronization: ObservationAudiovisualClaim[];
  voiceDelivery: ObservationAudiovisualClaim[];
  audioArtifacts: ObservationAudiovisualClaim[];
  visualArtifacts: ObservationAudiovisualClaim[];
  limitations: string[];
};

export type ObservationUtterance = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  startFrame?: number;
  endFrame?: number;
  text: string;
  language?: string;
  confidence?: number | null;
  speaker?: { label: string; attribution: "confirmed" | "probable" | "unknown" };
  unclear: boolean;
  evidenceIds: string[];
};

export type ObservationDialogue = {
  provider: "whisper-turbo" | "manual" | "none";
  model?: string;
  text: string;
  language?: string;
  utterances: ObservationUtterance[];
  limitations: string[];
  evidenceIds: string[];
  /** Raw adapter outputs retained for the review evidence package. */
  rawTranscript?: string;
  rawSegments?: string;
};

export type ObservationFinding = {
  id: string;
  category: "character" | "wardrobe" | "prop" | "action" | "dialogue" | "event" | "location" | "continuity" | "creative_deviation" | "coverage";
  expected: string;
  observed: string;
  classification: ObservationConfidence;
  rationale: string;
  evidenceIds: string[];
  dialogueMatch?: "exact" | "partial" | "mismatch" | "none";
  proposedChange?: FactChange;
};

export type ObservationComparison = {
  findings: ObservationFinding[];
  proposedChanges: FactChange[];
  limitations: string[];
  comparedAt: string;
  comparisonPromptVersion: string;
};

export type ObservationReport = {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  reportVersion: number;
  productionId: string;
  episodeId: string;
  sceneId: string;
  candidateId: string;
  sourceRunId?: string;
  sourceOutputHash: string;
  bindingIds: string[];
  timebase: "final-output";
  seniorReview?: {
    sourceObservationId: string;
    sourceRevision: number;
    reviewedAt: string;
    reusedEvidence: true;
    reusedVisual: boolean;
    reusedDialogue: boolean;
  };
  observer: {
    model: string;
    provider: "qwen-comfyui" | "comfyui" | "mock";
    version: string;
    promptVersion: string;
    configuration: Record<string, unknown>;
    /** Exact selected checkpoint and modality evidence for both independent passes. */
    visualCheckpoint?: {
      id: string; file: string; label: string; family: string; quantization: string; clipType: string;
    };
    comparisonCheckpoint?: {
      id: string; file: string; label: string; family: string; quantization: string; clipType: string;
    };
    inputModalities?: { text: true; image: boolean; video: boolean; audio: boolean };
    observationMode?: "visual" | "audiovisual";
    profile?: "custom" | "fast" | "detailed" | "senior" | "experimental-av";
    experimental?: boolean;
    audioClaimsUnverified?: boolean;
    effectiveConfiguration?: Record<string, unknown>;
    nativeInputs?: {
      video?: { file: string; hash: string; startSeconds: number; endSeconds: number; sourceHash: string };
      audio?: { file: string; hash: string; startSeconds: number; endSeconds: number; sourceHash: string };
    };
  };
  createdAt: string;
  technical: ObservationTechnical;
  evidenceBudget?: {
    maxFrames: number;
    extractedFrames: number;
    visualFrames: number;
    mandatoryShotCoverage: true;
    semantics: "hard-cap-with-mandatory-shot-coverage";
  };
  nativeBoundaries: { bindingId: string; segmentIndex: number; startFrame: number; endFrame: number; startSeconds: number; endSeconds: number }[];
  shots: ObservationShot[];
  visual?: ObservationVisual;
  analysisImages?: AnalysisImage[];
  intendedBrief?: import("./dialogue-alignment.ts").IntendedBrief;
  dialogueAlignment?: DialogueAlignment;
  audiovisual?: ObservationAudiovisual;
  nativeEvidence?: ObservationNativeEvidence[];
  dialogue?: ObservationDialogue;
  comparison?: ObservationComparison;
  proposalAudit?: { accepted: FactChange[]; rejected: { change: FactChange; code: string; message: string }[] };
  observedEvents: { text: string; evidenceIds: string[]; confidence: ObservationConfidence }[];
  evidence: ObservationEvidence[];
  confidence: ObservationConfidence;
  uncertainties: string[];
  limitations: string[];
  stages: ObservationStage[];
  failure?: { stage: ObservationStageName; message: string };
};

export type Observation = {
  id: string;
  productionId: string;
  sceneId: string;
  candidateId?: string;
  runId?: string;
  text: string;
  evidence: { type: string; path: string; startFrame?: number; endFrame?: number }[];
  /** Manual notes and automated reports share this immutable record. */
  kind?: "manual" | "analysis";
  revision?: number;
  previousRevisionId?: string;
  report?: ObservationReport;
  createdAt: string;
  createdBy: string;
  source: ActorKind;
};

export type BibleFact = {
  id: string;
  productionId: string;
  category: MemoryCategory;
  text: string;
  subjectIds: string[];
  tags: string[];
  data?: unknown;
  /** Scene at which this fact becomes applicable; omitted means production-global. */
  sceneId?: string;
  /** opening applies before the scene; closing is the scene outcome. */
  phase: FactPhase;
  /** Previous canonical values, retained for historical context reconstruction. */
  history: FactRevision[];
  provenance: Provenance;
  revision: number;
  approvedAt: string;
  approvedBy: string;
  sourceEventId: string;
};

export type FactChange = {
  op: "add" | "update";
  category: MemoryCategory;
  factId?: string;
  text: string;
  subjectIds?: string[];
  tags?: string[];
  data?: unknown;
  evidenceIds?: string[];
  sceneId?: string;
  phase?: FactPhase;
  provenance?: Partial<Provenance>;
};

export type SceneDecision = {
  sceneId: string;
  status: "draft" | "canon";
  canonicalCandidateId?: string;
  canonicalBindingIds: string[];
  alternateCandidateIds: string[];
  rejectedCandidateIds: string[];
  revision: number;
  approvedAt?: string;
  approvedBy?: string;
};

export type ProposedSceneDecision = {
  sceneId: string;
  candidateId: string;
  decision: "canon" | "alternate" | "reject";
  bindingIds?: string[];
};

export type CanonProposal = {
  id: string;
  productionId: string;
  title: string;
  note: string;
  expectedRevision: number;
  sceneDecision?: ProposedSceneDecision;
  changes: FactChange[];
  fingerprint: string;
  status: "proposed" | "approved" | "rejected";
  createdAt: string;
  createdBy: string;
  createdByKind: ActorKind;
  approvedAt?: string;
  approvedBy?: string;
};

export type Asset = {
  id: string;
  productionId: string;
  kind: "image" | "video" | "audio" | "file";
  label: string;
  sourceRunId?: string;
  path: string;
  hash?: string;
  category: string;
  tags: string[];
  createdAt: string;
  createdBy: string;
};

export type AssetBuild = {
  id: string;
  productionId: string;
  app: string;
  category: string;
  label: string;
  prompt: string;
  status: "pending" | "completed" | "failed";
  runId?: string;
  assetIds: string[];
  createdAt: string;
  createdBy: string;
};

export type ContinuityReviewStatus = "prepared" | "completed" | "superseded" | "rejected";

export type ContinuityReview = {
  id: string;
  productionId: string;
  seasonId?: string;
  episodeId?: string;
  sceneIds: string[];
  bindingIds: string[];
  candidateIds: string[];
  observations: { observationId: string; sceneId: string; revision: number; sourceHash: string }[];
  canonicalRevision: number;
  reviewer: { model: string; kind: "qwen" | "deterministic" | "human"; configuration: Record<string, unknown> };
  evidenceReferences: string[];
  status: ContinuityReviewStatus;
  findings: unknown[];
  stateRecords: unknown[];
  correctionPlans: unknown[];
  limitations: string[];
  /** Optional provenance for an executed reviewer; artifacts and raw output stay outside the immutable finding set. */
  execution?: Record<string, unknown>;
  revision: number;
  previousReviewId?: string;
  createdAt: string;
  createdBy: string;
};

export type ProductionRunProfile = "build" | "production";
export type ProductionRunStatus = "prepared" | "running" | "awaiting_human" | "paused" | "completed" | "canceled" | "failed";
export type ProductionRunStage =
  | "plan" | "render" | "candidate_registered" | "observation" | "deterministic_validation"
  | "continuity_review" | "awaiting_human" | "canonicalization" | "next_scene" | "completed";
export type ProductionRunBudget = {
  maxRendersPerScene: number;
  maxTotalRenders: number;
  maxPromptEnhancements: number;
  maxObservationJobs: number;
  maxComparisonCalls: number;
  maxSeniorReviewBatches: number;
  wallClockMinutes: number;
  rendersUsed: number;
  promptEnhancementsUsed: number;
  observationJobsUsed: number;
  comparisonCallsUsed: number;
  seniorReviewBatchesUsed: number;
  startedAt?: string;
};
export type ProductionRunScene = {
  sceneId: string;
  title: string;
  objective: string;
  intendedEvents: string[];
  dialogueRequirements: string[];
  characterIds: string[];
  locationIds: string[];
  propIds: string[];
  targetDurationSeconds: number;
  intendedTransition: string;
  selectedApp: string;
  profile: ProductionRunProfile;
  referenceAssetIds: string[];
  renderConfig: Record<string, unknown>;
  reuseCandidateId?: string;
  candidateId?: string;
  observationIds: string[];
  continuityReviewIds: string[];
  status: "planned" | "rendering" | "candidate_registered" | "observed" | "validated" | "awaiting_human" | "approved" | "rejected" | "stale" | "skipped";
  jobIds: string[];
  attempts: number;
  errors: string[];
};
export type ProductionRunProvisionalFact = {
  id: string;
  sceneId: string;
  text: string;
  sourceObservationId: string;
  evidenceReferences: string[];
  revision: number;
  status: "provisional" | "approved" | "invalidated";
};
export type ProductionRunDecision = {
  id: string;
  sceneId: string;
  decision: "approved" | "rejected" | "replace" | "reuse";
  note: string;
  actor: string;
  at: string;
};
export type ProductionRunJob = {
  sceneId: string;
  kind: "render" | "observation" | "comparison" | "senior_review";
  jobId: string;
  requestKey: string;
  status: "reserved" | "submitted" | "succeeded" | "failed" | "canceled";
  reservedAt: string;
};
export type ProductionRun = {
  id: string;
  productionId: string;
  seasonId?: string;
  episodeId?: string;
  title: string;
  brief: string;
  profile: ProductionRunProfile;
  status: ProductionRunStatus;
  stage: ProductionRunStage;
  scenePlan: ProductionRunScene[];
  selectedApplications: string[];
  referenceAssets: string[];
  renderConfig: Record<string, unknown>;
  budget: ProductionRunBudget;
  jobs: ProductionRunJob[];
  provisionalFacts: ProductionRunProvisionalFact[];
  decisions: ProductionRunDecision[];
  errors: string[];
  currentSceneIndex: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  canonicalRevision: number;
};

export type ProductionSnapshot = {
  schemaVersion: typeof PRODUCTION_SCHEMA_VERSION;
  production: ProductionMeta;
  seasons: Season[];
  episodes: Episode[];
  scenes: Scene[];
  candidates: Record<string, Candidate>;
  bindings: Record<string, SceneRenderBinding[]>;
  /** Append-only non-canonical binding corrections; never rewrites the historical binding. */
  bindingCorrections: BindingCorrection[];
  observations: Record<string, Observation>;
  continuityReviews: Record<string, ContinuityReview>;
  productionRuns: Record<string, ProductionRun>;
  sceneDecisions: Record<string, SceneDecision>;
  bible: Record<MemoryCategory, BibleFact[]>;
  proposals: Record<string, CanonProposal>;
  assets: Record<string, Asset>;
  assetBuilds: Record<string, AssetBuild>;
  /** Increments only for human-approved canonical mutations and rollbacks. */
  revision: number;
  lastEventSeq: number;
  lastEventHash: string | null;
  updatedAt: string;
};

export type ProductionEventType =
  | "production.created"
  | "season.created"
  | "episode.created"
  | "scene.created"
  | "scene.updated"
  | "scene.removed"
  | "candidate.registered"
  | "binding.corrected"
  | "continuity.reviewed"
  | "production.run.created"
  | "production.run.updated"
  | "production.run.decided"
  | "observation.recorded"
  | "asset.indexed"
  | "asset.updated"
  | "asset.removed"
  | "asset.build.created"
  | "asset.build.completed"
  | "canon.proposed"
  | "canon.approved"
  | "canon.rolled_back";

export type ProductionEvent = {
  schemaVersion: typeof PRODUCTION_SCHEMA_VERSION;
  id: string;
  seq: number;
  productionId: string;
  type: ProductionEventType;
  at: string;
  actor: Actor;
  commandKey?: string;
  payload: Record<string, unknown>;
  previousHash: string | null;
  hash: string;
};

export type ProductionSummary = {
  id: string;
  title: string;
  logline: string;
  description?: string;
  style?: string;
  status: ProductionMeta["status"];
  cover?: { kind: "asset" | "candidate"; id: string; outputIndex?: number; type?: "image" | "video" };
  seasons: number;
  episodes: number;
  scenes: number;
  candidates: number;
  canonicalScenes: number;
  revision: number;
  updatedAt: string;
};

export type HumanApproval = {
  method: "interactive-cli";
  human: true;
  tty: true;
  approvedBy: string;
  approvedAt: string;
  /** Exact canonical fingerprint shown to the human. */
  fingerprint: string;
  /** The human typed this challenge; it is derived from the fingerprint. */
  challenge: string;
  /** Canonical revision the human saw before approving. */
  expectedRevision: number;
};

/** Stable JSON: key order never changes a hash. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function proposalFingerprint(proposal: Pick<CanonProposal, "productionId" | "expectedRevision" | "sceneDecision" | "changes">): string {
  return hashValue({
    productionId: proposal.productionId,
    expectedRevision: proposal.expectedRevision,
    sceneDecision: proposal.sceneDecision ?? null,
    changes: proposal.changes,
  });
}

export function rollbackFingerprint(productionId: string, targetRevision: number, expectedRevision: number): string {
  return hashValue({ productionId, targetRevision, expectedRevision, operation: "canon.rollback" });
}

export function approvalChallenge(fingerprint: string): string {
  return `APPROVE ${fingerprint.slice(0, 12)}`;
}

export type ApprovalCheck = {
  fingerprint: string;
  expectedRevision: number;
  action: "proposal" | "rollback";
};

/** Default gate: only the interactive CLI can produce this proof. */
export function verifyHumanApproval(approval: HumanApproval | undefined, check: ApprovalCheck): boolean {
  if (!approval || approval.method !== "interactive-cli" || approval.human !== true || approval.tty !== true) return false;
  if (!approval.approvedBy || !approval.approvedAt) return false;
  if (approval.fingerprint !== check.fingerprint) return false;
  if (approval.expectedRevision !== check.expectedRevision) return false;
  return approval.challenge === approvalChallenge(check.fingerprint);
}
