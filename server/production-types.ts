// Riverfield Production Engine — Phase 0 data contracts.
// These types are engine-independent: H3, Pika, pi-H3 and LTX are execution clients.
import { createHash } from "node:crypto";

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

export type Observation = {
  id: string;
  productionId: string;
  sceneId: string;
  candidateId?: string;
  runId?: string;
  text: string;
  evidence: { type: string; path: string; startFrame?: number; endFrame?: number }[];
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

export type ProductionSnapshot = {
  schemaVersion: typeof PRODUCTION_SCHEMA_VERSION;
  production: ProductionMeta;
  seasons: Season[];
  episodes: Episode[];
  scenes: Scene[];
  candidates: Record<string, Candidate>;
  bindings: Record<string, SceneRenderBinding[]>;
  observations: Record<string, Observation>;
  sceneDecisions: Record<string, SceneDecision>;
  bible: Record<MemoryCategory, BibleFact[]>;
  proposals: Record<string, CanonProposal>;
  assets: Record<string, Asset>;
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
  | "observation.recorded"
  | "asset.indexed"
  | "asset.updated"
  | "asset.removed"
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
