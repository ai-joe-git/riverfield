// Durable, append-only Production Engine store. No inference, no media copying.
import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { hashFile, mediaKind, probeMedia, productionMediaRoots, resolveMediaPath } from "./production-media.ts";
import {
  PRODUCTION_SCHEMA_VERSION, MEMORY_CATEGORIES, hashValue, proposalFingerprint,
  rollbackFingerprint, verifyHumanApproval,
  type Actor, type ApprovalCheck, type Asset, type BibleFact, type Candidate, type CanonProposal,
  type FactChange, type HumanApproval, type Observation, type ObservationReport, type ProductionEvent, type ProductionEventType,
  type ProductionMeta, type ProductionSnapshot, type ProductionSummary, type Scene, type SceneDecision,
  type SceneRenderBinding, type BindingCorrection, type ContinuityReview, type ContinuityReviewStatus, type ProductionRun, type ProductionRunDecision, type ProductionRunBudget, type ProductionRunScene, type Season, type Episode, type MemoryCategory, type Provenance, type CandidateProvenance, type AssetBuild,
} from "./production-types.ts";

export class ProductionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type CreateProductionInput = {
  id?: string;
  title: string;
  logline?: string;
  description?: string;
  style?: string;
  status?: ProductionMeta["status"];
};
export type CreateSeasonInput = { id?: string; number: number; title: string };
export type CreateEpisodeInput = { id?: string; seasonId: string; number: number; title: string; status?: Episode["status"] };
export type CreateSceneInput = {
  id?: string;
  episodeId: string;
  number: number;
  title: string;
  characterIds?: string[];
  locationIds?: string[];
  summary?: string;
};
export type RegisterCandidateInput = {
  id?: string;
  label: string;
  source?: Candidate["source"];
  sourceRunId?: string;
  app?: string;
  prompt?: string;
  outputs?: Candidate["outputs"];
  bindings?: (Omit<SceneRenderBinding, "candidateId" | "timebase"> & { timebase?: SceneRenderBinding["timebase"] })[];
  render?: Record<string, unknown>;
  provenance?: CandidateProvenance;
};
export type RegisterObservationInput = {
  id?: string;
  sceneId: string;
  candidateId?: string;
  runId?: string;
  text: string;
  evidence?: Observation["evidence"];
  kind?: Observation["kind"];
  revision?: number;
  previousRevisionId?: string;
  report?: ObservationReport;
};
export type RecordContinuityReviewInput = {
  id?: string;
  seasonId?: string;
  episodeId?: string;
  sceneIds: string[];
  bindingIds?: string[];
  candidateIds?: string[];
  observations: { observationId: string; sceneId: string; revision: number; sourceHash: string }[];
  reviewer: { model: string; kind: "qwen" | "deterministic" | "human"; configuration?: Record<string, unknown> };
  evidenceReferences?: string[];
  status?: ContinuityReviewStatus;
  findings?: unknown[];
  stateRecords?: unknown[];
  correctionPlans?: unknown[];
  limitations?: string[];
  execution?: Record<string, unknown>;
};

export type CreateProductionRunInput = {
  id?: string;
  seasonId?: string;
  episodeId?: string;
  title: string;
  brief: string;
  profile: "build" | "production";
  scenePlan: ProductionRunScene[];
  selectedApplications?: string[];
  referenceAssets?: string[];
  renderConfig?: Record<string, unknown>;
  budget?: Partial<ProductionRunBudget>;
};
export type ProductionRunPatch = Partial<Pick<ProductionRun,
  "title" | "brief" | "profile" | "status" | "stage" | "scenePlan" | "selectedApplications" | "referenceAssets" |
  "renderConfig" | "budget" | "jobs" | "provisionalFacts" | "decisions" | "errors" | "currentSceneIndex" |
  "limitations" | "closure" | "budgetDecision"
>>;

export type CreateAssetBuildInput = {
  id?: string;
  app: string;
  category?: string;
  label: string;
  prompt: string;
};
export type IndexAssetInput = {
  id?: string;
  kind: Asset["kind"];
  label: string;
  sourceRunId?: string;
  path: string;
  hash?: string;
  category?: string;
  tags?: string[];
};
export type ProposeCanonInput = {
  id?: string;
  title?: string;
  note?: string;
  expectedRevision?: number;
  sceneDecision?: CanonProposal["sceneDecision"];
  changes?: FactChange[];
};
export type StoreOptions = {
  approvalVerifier?: (approval: HumanApproval | undefined, check: ApprovalCheck) => boolean;
  mediaRoots?: string[];
};

const APPROVAL_TIMEOUT = 60 * 60 * 1000;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(sleepArray, 0, 0, ms);
const nowIso = () => new Date().toISOString();
const assertId = (id: string, field = "id") => {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) throw new ProductionError("INVALID_ID", `${field} must be a lowercase slug (a-z, 0-9, hyphen)`);
};
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const emptyBible = (): Record<MemoryCategory, BibleFact[]> => ({ identity: [], state: [], episodic: [], narrative: [] });
const clone = <T>(value: T): T => structuredClone(value);

function emptySnapshot(production: ProductionMeta, at = nowIso()): ProductionSnapshot {
  return {
    schemaVersion: PRODUCTION_SCHEMA_VERSION,
    production,
    seasons: [],
    episodes: [],
    scenes: [],
    candidates: {},
    bindings: {},
    bindingCorrections: [],
    observations: {},
    continuityReviews: {},
    productionRuns: {},
    sceneDecisions: {},
    bible: emptyBible(),
    proposals: {},
    assets: {},
    assetBuilds: {},
    revision: 0,
    lastEventSeq: 0,
    lastEventHash: null,
    updatedAt: at,
  };
}

function atomicWrite(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function eventHash(event: Omit<ProductionEvent, "hash">): string {
  return hashValue(event);
}

function candidateHash(input: Omit<Candidate, "contentHash">): string {
  return hashValue({
    label: input.label,
    source: input.source,
    sourceRunId: input.sourceRunId ?? null,
    app: input.app ?? null,
    prompt: input.prompt ?? null,
    outputs: input.outputs,
    bindings: input.bindings,
  });
}

function factId(proposalId: string, index: number): string {
  return `${proposalId}-fact-${String(index + 1).padStart(3, "0")}`;
}

function normaliseProvenance(value: Partial<Provenance> | undefined, proposal: CanonProposal, event: ProductionEvent): Provenance {
  const actorId = value?.actorId ?? proposal.createdBy;
  return {
    source: value?.source ?? proposal.createdByKind ?? "agent",
    ...(actorId ? { actorId } : {}),
    sourceEventId: event.id,
    ...(value?.sourceRunId ? { sourceRunId: value.sourceRunId } : {}),
    ...(value?.note ? { note: value.note } : {}),
  };
}

function assertFiniteFrame(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ProductionError("INVALID_BINDING", `${field} must be a non-negative frame number`);
  return Math.trunc(n);
}

export class ProductionStore {
  private readonly root: string;
  private readonly verifyApproval: NonNullable<StoreOptions["approvalVerifier"]>;
  private readonly mediaRoots: string[];

  constructor(outDir: string, options: StoreOptions = {}) {
    this.root = join(outDir, "productions");
    this.verifyApproval = options.approvalVerifier ?? verifyHumanApproval;
    this.mediaRoots = options.mediaRoots ?? productionMediaRoots(outDir);
  }

  private dir(id: string) { return join(this.root, id); }
  private eventsDir(id: string) { return join(this.dir(id), "events"); }
  private snapshotFile(id: string) { return join(this.dir(id), "snapshot.json"); }
  private lockFile(id: string) { return join(this.dir(id), ".write.lock"); }

  private withLock<T>(id: string, action: () => T): T {
    mkdirSync(this.eventsDir(id), { recursive: true });
    const lock = this.lockFile(id);
    const started = Date.now();
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(lock, "wx", 0o600);
        writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") throw err;
        if (Date.now() - started > 30_000) throw new ProductionError("LOCK_TIMEOUT", "Production store is locked by another writer");
        try {
          const age = Date.now() - Number((readJson(lock) as { at?: string })?.at ? Date.parse(String((readJson(lock) as { at?: string }).at)) : 0);
          if (Number.isFinite(age) && age > 60_000) unlinkSync(lock);
        } catch { /* another writer may have removed it */ }
        sleep(20);
      }
    }
    try {
      return action();
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(lock); } catch { /* already removed */ }
    }
  }

  private readEvents(id: string): ProductionEvent[] {
    const dir = this.eventsDir(id);
    if (!existsSync(dir)) throw new ProductionError("UNKNOWN_PRODUCTION", `Unknown production ${id}`);
    const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
    const events: ProductionEvent[] = [];
    let previous: string | null = null;
    for (const [index, file] of files.entries()) {
      const raw = readJson(join(dir, file)) as ProductionEvent;
      if (!raw || raw.schemaVersion !== PRODUCTION_SCHEMA_VERSION || raw.productionId !== id) {
        throw new ProductionError("CORRUPT_JOURNAL", `Invalid production event ${file}`);
      }
      if (raw.seq !== index + 1 || raw.previousHash !== previous) {
        throw new ProductionError("CORRUPT_JOURNAL", `Production event chain is broken at ${file}`);
      }
      const { hash, ...withoutHash } = raw;
      if (eventHash(withoutHash) !== hash) throw new ProductionError("CORRUPT_JOURNAL", `Production event hash mismatch at ${file}`);
      previous = hash;
      events.push(raw);
    }
    return events;
  }

  private appendLocked(
    id: string,
    type: ProductionEventType,
    payload: Record<string, unknown>,
    actor: Actor,
    commandKey?: string,
  ): { event: ProductionEvent; snapshot: ProductionSnapshot } {
    const events = this.readEvents(id);
    if (commandKey) {
      const duplicate = events.find((event) => event.commandKey === commandKey);
      if (duplicate) return { event: duplicate, snapshot: this.rebuild(id) };
    }
    const previous = events.at(-1);
    const eventWithoutHash = {
      schemaVersion: PRODUCTION_SCHEMA_VERSION,
      id: randomUUID(),
      seq: (previous?.seq ?? 0) + 1,
      productionId: id,
      type,
      at: nowIso(),
      actor,
      ...(commandKey ? { commandKey } : {}),
      payload,
      previousHash: previous?.hash ?? null,
    } satisfies Omit<ProductionEvent, "hash">;
    const event: ProductionEvent = { ...eventWithoutHash, hash: eventHash(eventWithoutHash) };
    const file = join(this.eventsDir(id), `${String(event.seq).padStart(12, "0")}-${event.id}.json`);
    atomicWrite(file, event);
    const snapshot = this.rebuild(id);
    atomicWrite(this.snapshotFile(id), snapshot);
    return { event, snapshot };
  }

  private append(
    id: string,
    type: ProductionEventType,
    payload: Record<string, unknown>,
    actor: Actor,
    commandKey?: string,
  ): ProductionSnapshot {
    return this.withLock(id, () => this.appendLocked(id, type, payload, actor, commandKey).snapshot);
  }

  /** Rebuild the snapshot from the append-only journal. Never edits or removes events. */
  private rebuild(id: string): ProductionSnapshot {
    const events = this.readEvents(id);
    if (!events.length) throw new ProductionError("UNKNOWN_PRODUCTION", `Unknown production ${id}`);
    const first = events[0]?.payload.production as ProductionMeta | undefined;
    if (!first) throw new ProductionError("CORRUPT_JOURNAL", `Production ${id} has no production.created event`);
    const snap = emptySnapshot(first);
    const revisions = new Map<number, ProductionSnapshot>();
    revisions.set(0, clone(snap));
    for (const event of events) {
      switch (event.type) {
        case "production.created": {
          const production = event.payload.production as ProductionMeta;
          snap.production = production;
          revisions.set(0, clone(snap));
          break;
        }
        case "season.created": {
          const season = event.payload.season as Season;
          if (!snap.seasons.some((item) => item.id === season.id)) snap.seasons.push(season);
          break;
        }
        case "episode.created": {
          const episode = event.payload.episode as Episode;
          if (!snap.episodes.some((item) => item.id === episode.id)) snap.episodes.push(episode);
          break;
        }
        case "scene.created": {
          const scene = event.payload.scene as Scene;
          if (!snap.scenes.some((item) => item.id === scene.id)) snap.scenes.push(scene);
          if (!snap.sceneDecisions[scene.id]) snap.sceneDecisions[scene.id] = {
            sceneId: scene.id, status: "draft", canonicalBindingIds: [], alternateCandidateIds: [],
            rejectedCandidateIds: [], revision: 0,
          };
          break;
        }
        case "scene.updated": {
          const scene = event.payload.scene as Scene;
          const index = snap.scenes.findIndex((item) => item.id === scene.id);
          if (index >= 0) snap.scenes[index] = { ...snap.scenes[index], ...scene };
          break;
        }
        case "scene.removed": {
          snap.scenes = snap.scenes.filter((scene) => scene.id !== String(event.payload.sceneId));
          break;
        }
        case "candidate.registered": {
          const candidate = event.payload.candidate as Candidate;
          snap.candidates[candidate.id] = candidate;
          snap.bindings[candidate.id] = candidate.bindings;
          break;
        }
        case "binding.corrected": {
          const correction = event.payload.correction as BindingCorrection;
          snap.bindingCorrections.push(correction);
          break;
        }
        case "continuity.reviewed": {
          const review = event.payload.review as ContinuityReview;
          snap.continuityReviews[review.id] = review;
          break;
        }
        case "production.run.created":
        case "production.run.updated":
        case "production.run.decided": {
          const run = event.payload.run as ProductionRun;
          snap.productionRuns[run.id] = run;
          break;
        }
        case "observation.recorded": {
          const observation = event.payload.observation as Observation;
          snap.observations[observation.id] = observation;
          break;
        }
        case "asset.indexed": {
          const asset = event.payload.asset as Asset;
          snap.assets[asset.id] = { ...asset, category: asset.category || "references", tags: Array.isArray(asset.tags) ? asset.tags : [] };
          break;
        }
        case "asset.updated": {
          const asset = event.payload.asset as Asset;
          if (snap.assets[asset.id]) snap.assets[asset.id] = { ...snap.assets[asset.id], ...asset };
          break;
        }
        case "asset.removed": {
          delete snap.assets[String(event.payload.assetId)];
          break;
        }
        case "asset.build.created": {
          const build = event.payload.build as AssetBuild;
          snap.assetBuilds[build.id] = build;
          break;
        }
        case "asset.build.completed": {
          const build = event.payload.build as AssetBuild;
          if (snap.assetBuilds[build.id]) snap.assetBuilds[build.id] = { ...snap.assetBuilds[build.id], ...build };
          break;
        }
        case "canon.proposed": {
          const proposal = event.payload.proposal as CanonProposal;
          snap.proposals[proposal.id] = proposal;
          break;
        }
        case "canon.approved": {
          const proposal = event.payload.proposal as CanonProposal;
          const approval = event.payload.approval as HumanApproval;
          const nextRevision = snap.revision + 1;
          snap.revision = nextRevision;
          snap.proposals[proposal.id] = {
            ...proposal,
            status: "approved",
            approvedAt: approval.approvedAt,
            approvedBy: approval.approvedBy,
          };
          if (proposal.sceneDecision) this.applySceneDecision(snap, proposal.sceneDecision, approval, event, nextRevision);
          for (const [index, change] of proposal.changes.entries()) this.applyFactChange(snap, change, proposal, event, approval, nextRevision, index);
          revisions.set(nextRevision, clone(snap));
          break;
        }
        case "canon.rolled_back": {
          const targetRevision = Number(event.payload.targetRevision);
          const target = revisions.get(targetRevision);
          if (!target) throw new ProductionError("INVALID_ROLLBACK", `No canonical revision ${targetRevision} to restore`);
          const nextRevision = snap.revision + 1;
          // Restore only canonical state. Candidate evidence and proposals remain indexed.
          snap.bible = clone(target.bible);
          snap.sceneDecisions = clone(target.sceneDecisions);
          for (const scene of snap.scenes) scene.status = snap.sceneDecisions[scene.id]?.status ?? "draft";
          snap.revision = nextRevision;
          revisions.set(nextRevision, clone(snap));
          break;
        }
        default:
          throw new ProductionError("CORRUPT_JOURNAL", `Unknown production event ${String(event.type)}`);
      }
      snap.lastEventSeq = event.seq;
      snap.lastEventHash = event.hash;
      snap.updatedAt = event.at;
    }
    return snap;
  }

  private applySceneDecision(snap: ProductionSnapshot, decision: NonNullable<CanonProposal["sceneDecision"]>, approval: HumanApproval, event: ProductionEvent, revision: number) {
    const scene = snap.scenes.find((item) => item.id === decision.sceneId);
    const candidate = snap.candidates[decision.candidateId];
    if (!scene || !candidate) throw new ProductionError("INVALID_SCENE_DECISION", "Scene or candidate no longer exists");
    const candidateBindings = (snap.bindings[candidate.id] ?? []).filter((binding) => binding.sceneId === scene.id);
    const selected = decision.bindingIds?.length
      ? decision.bindingIds.map((id) => candidateBindings.find((binding) => binding.id === id)).filter((binding): binding is NonNullable<typeof binding> => Boolean(binding))
      : candidateBindings;
    if (decision.decision === "canon" && !selected.length) throw new ProductionError("INVALID_SCENE_DECISION", "A canonical scene needs at least one binding");
    if (decision.bindingIds?.length && selected.length !== decision.bindingIds.length) throw new ProductionError("INVALID_SCENE_DECISION", "Every selected binding must exist for this scene and candidate");
    const current: SceneDecision = snap.sceneDecisions[scene.id] ?? {
      sceneId: scene.id, status: "draft", canonicalBindingIds: [], alternateCandidateIds: [], rejectedCandidateIds: [], revision: 0,
    };
    if (decision.decision === "canon") {
      current.status = "canon";
      current.canonicalCandidateId = candidate.id;
      current.canonicalBindingIds = selected.map((binding) => binding.id);
      current.alternateCandidateIds = current.alternateCandidateIds.filter((id) => id !== candidate.id);
      current.rejectedCandidateIds = current.rejectedCandidateIds.filter((id) => id !== candidate.id);
    } else if (decision.decision === "alternate") {
      current.alternateCandidateIds = unique([...current.alternateCandidateIds, candidate.id]);
      current.rejectedCandidateIds = current.rejectedCandidateIds.filter((id) => id !== candidate.id);
    } else {
      current.rejectedCandidateIds = unique([...current.rejectedCandidateIds, candidate.id]);
      current.alternateCandidateIds = current.alternateCandidateIds.filter((id) => id !== candidate.id);
    }
    current.revision = revision;
    current.approvedAt = approval.approvedAt;
    current.approvedBy = approval.approvedBy;
    snap.sceneDecisions[scene.id] = current;
    scene.status = current.status;
  }

  private applyFactChange(
    snap: ProductionSnapshot,
    change: FactChange,
    proposal: CanonProposal,
    event: ProductionEvent,
    approval: HumanApproval,
    revision: number,
    index: number,
  ) {
    if (!MEMORY_CATEGORIES.includes(change.category)) throw new ProductionError("INVALID_FACT", "Unknown memory category");
    if (!change.text?.trim()) throw new ProductionError("INVALID_FACT", "A canonical fact needs text");
    const list = snap.bible[change.category];
    const sceneId = change.sceneId ?? proposal.sceneDecision?.sceneId;
    const provenance = normaliseProvenance(change.provenance, proposal, event);
    if (change.op === "update") {
      const hit = change.factId ? list.find((fact) => fact.id === change.factId) : undefined;
      if (!hit) throw new ProductionError("INVALID_FACT", `Unknown fact to update: ${change.factId ?? "(missing factId)"}`);
      const previous = {
        revision: hit.revision, text: hit.text, subjectIds: [...hit.subjectIds], tags: [...hit.tags],
        ...(hit.sceneId ? { sceneId: hit.sceneId } : {}), phase: hit.phase ?? "opening",
        ...(hit.data !== undefined ? { data: hit.data } : {}), provenance: hit.provenance,
        approvedAt: hit.approvedAt, approvedBy: hit.approvedBy, sourceEventId: hit.sourceEventId,
      };
      hit.text = change.text;
      hit.subjectIds = unique(change.subjectIds ?? hit.subjectIds);
      hit.tags = unique(change.tags ?? hit.tags);
      hit.history = [...(hit.history ?? []), previous];
      if (change.data !== undefined) hit.data = change.data;
      if (sceneId) hit.sceneId = sceneId;
      hit.phase = change.phase ?? (change.category === "episodic" ? "closing" : "opening");
      hit.provenance = { ...hit.provenance, ...provenance };
      hit.revision = revision;
      hit.approvedAt = approval.approvedAt;
      hit.approvedBy = approval.approvedBy;
      hit.sourceEventId = event.id;
      return;
    }
    const id = change.factId ?? factId(proposal.id, index);
    if (list.some((fact) => fact.id === id)) throw new ProductionError("INVALID_FACT", `Fact already exists: ${id}`);
    list.push({
      id,
      productionId: snap.production.id,
      category: change.category,
      text: change.text,
      subjectIds: unique(change.subjectIds ?? []),
      tags: unique(change.tags ?? []),
      ...(change.data !== undefined ? { data: change.data } : {}),
      ...(sceneId ? { sceneId } : {}),
      phase: change.phase ?? (change.category === "episodic" ? "closing" : "opening"),
      history: [],
      provenance,
      revision,
      approvedAt: approval.approvedAt,
      approvedBy: approval.approvedBy,
      sourceEventId: event.id,
    });
  }

  private loadFreshSnapshot(id: string): ProductionSnapshot {
    const events = this.readEvents(id);
    if (!events.length) throw new ProductionError("UNKNOWN_PRODUCTION", `Unknown production ${id}`);
    try {
      const raw = readJson(this.snapshotFile(id)) as ProductionSnapshot;
      if (raw?.schemaVersion === PRODUCTION_SCHEMA_VERSION && raw.production?.id === id
        && raw.lastEventSeq === events.at(-1)?.seq && raw.lastEventHash === events.at(-1)?.hash) return { ...raw, productionRuns: raw.productionRuns ?? {} };
    } catch { /* rebuild below */ }
    const rebuilt = this.rebuild(id);
    atomicWrite(this.snapshotFile(id), rebuilt);
    return rebuilt;
  }

  list(): ProductionSummary[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry): ProductionSummary | null => {
        try {
          const snap = this.withLock(entry.name, () => this.loadFreshSnapshot(entry.name));
          return {
            id: snap.production.id, title: snap.production.title, logline: snap.production.logline,
            ...(snap.production.description ? { description: snap.production.description } : {}),
            ...(snap.production.style ? { style: snap.production.style } : {}),
            status: snap.production.status,
            ...(() => {
              const asset = Object.values(snap.assets).find((item) => ["image", "video"].includes(item.kind));
              if (asset) return { cover: { kind: "asset" as const, id: asset.id, type: asset.kind === "video" ? "video" as const : "image" as const } };
              for (const candidate of Object.values(snap.candidates)) {
                const index = candidate.outputs.findIndex((output) => output.type === "image" || output.type === "video");
                if (index >= 0) return { cover: { kind: "candidate" as const, id: candidate.id, outputIndex: index, type: candidate.outputs[index].type === "video" ? "video" as const : "image" as const } };
              }
              return {};
            })(),
            seasons: snap.seasons.length, episodes: snap.episodes.length,
            scenes: snap.scenes.length, candidates: Object.keys(snap.candidates).length,
            canonicalScenes: Object.values(snap.sceneDecisions).filter((decision) => decision.status === "canon").length,
            revision: snap.revision, updatedAt: snap.updatedAt,
          } satisfies ProductionSummary;
        } catch { return null; }
      })
      .filter((item): item is ProductionSummary => item !== null)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  snapshot(id: string): ProductionSnapshot {
    assertId(id);
    return this.withLock(id, () => this.loadFreshSnapshot(id));
  }

  events(id: string): ProductionEvent[] {
    assertId(id);
    return this.readEvents(id);
  }

  createProduction(input: CreateProductionInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const title = String(input.title ?? "").trim();
    if (!title) throw new ProductionError("INVALID_PRODUCTION", "A production needs a title");
    const id = String(input.id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 128);
    assertId(id);
    return this.withLock(id, () => {
      if (existsSync(this.eventsDir(id)) && readdirSync(this.eventsDir(id)).some((file) => file.endsWith(".json"))) {
        if (commandKey) return this.loadFreshSnapshot(id);
        throw new ProductionError("PRODUCTION_EXISTS", `Production ${id} already exists`);
      }
      const at = nowIso();
      const production: ProductionMeta = {
        id, title, logline: String(input.logline ?? "").trim(), status: input.status ?? "draft", createdAt: at,
        createdBy: actor.id ?? actor.kind,
      };
      return this.appendLocked(id, "production.created", { production }, actor, commandKey ?? `production:create:${id}`).snapshot;
    });
  }

  createSeason(productionId: string, input: CreateSeasonInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    const number = Number(input.number);
    if (!Number.isInteger(number) || number < 1) throw new ProductionError("INVALID_SEASON", "Season number must be a positive integer");
    const id = input.id ?? `${productionId}-s${String(number).padStart(2, "0")}`;
    assertId(id, "season id");
    if (snap.seasons.some((season) => season.id === id || season.number === number)) {
      if (commandKey) return snap;
      throw new ProductionError("SEASON_EXISTS", `Season ${number} already exists`);
    }
    const season: Season = { id, productionId, number, title: String(input.title ?? `Season ${number}`).trim(), createdAt: nowIso() };
    return this.append(productionId, "season.created", { season }, actor, commandKey ?? `season:create:${id}`);
  }

  createEpisode(productionId: string, input: CreateEpisodeInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    if (!snap.seasons.some((season) => season.id === input.seasonId)) throw new ProductionError("UNKNOWN_SEASON", `Unknown season ${input.seasonId}`);
    const number = Number(input.number);
    if (!Number.isInteger(number) || number < 1) throw new ProductionError("INVALID_EPISODE", "Episode number must be a positive integer");
    const id = input.id ?? `${input.seasonId}-e${String(number).padStart(2, "0")}`;
    assertId(id, "episode id");
    if (snap.episodes.some((episode) => episode.id === id)) {
      if (commandKey) return snap;
      throw new ProductionError("EPISODE_EXISTS", `Episode ${id} already exists`);
    }
    const episode: Episode = {
      id, productionId, seasonId: input.seasonId, number, title: String(input.title ?? `Episode ${number}`).trim(),
      status: input.status ?? "draft", createdAt: nowIso(),
    };
    return this.append(productionId, "episode.created", { episode }, actor, commandKey ?? `episode:create:${id}`);
  }

  createScene(productionId: string, input: CreateSceneInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    if (!snap.episodes.some((episode) => episode.id === input.episodeId)) throw new ProductionError("UNKNOWN_EPISODE", `Unknown episode ${input.episodeId}`);
    const number = Number(input.number);
    if (!Number.isInteger(number) || number < 1) throw new ProductionError("INVALID_SCENE", "Scene number must be a positive integer");
    const id = input.id ?? `${input.episodeId}-sc${String(number).padStart(2, "0")}`;
    assertId(id, "scene id");
    if (snap.scenes.some((scene) => scene.id === id)) {
      if (commandKey) return snap;
      throw new ProductionError("SCENE_EXISTS", `Scene ${id} already exists`);
    }
    const scene: Scene = {
      id, productionId, episodeId: input.episodeId, number,
      title: String(input.title ?? `Scene ${number}`).trim(), status: "draft",
      characterIds: unique((input.characterIds ?? []).map(String)),
      locationIds: unique((input.locationIds ?? []).map(String)),
      summary: String(input.summary ?? "").trim(), createdAt: nowIso(),
    };
    return this.append(productionId, "scene.created", { scene }, actor, commandKey ?? `scene:create:${id}`);
  }

  updateScene(productionId: string, sceneId: string, input: { title?: string; summary?: string; characterIds?: string[]; locationIds?: string[]; number?: number }, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    const current = snap.scenes.find((scene) => scene.id === sceneId);
    if (!current) throw new ProductionError("UNKNOWN_SCENE", `Unknown scene ${sceneId}`);
    const scene: Scene = {
      ...current,
      ...(input.title !== undefined ? { title: String(input.title).trim() || current.title } : {}),
      ...(input.summary !== undefined ? { summary: String(input.summary).trim() } : {}),
      ...(input.characterIds ? { characterIds: unique(input.characterIds.map(String)) } : {}),
      ...(input.locationIds ? { locationIds: unique(input.locationIds.map(String)) } : {}),
      ...(input.number !== undefined ? { number: Number(input.number) } : {}),
    };
    if (!Number.isInteger(scene.number) || scene.number < 1) throw new ProductionError("INVALID_SCENE", "Scene number must be a positive integer");
    return this.append(productionId, "scene.updated", { scene }, actor, commandKey ?? `scene:update:${sceneId}:${scene.number}:${scene.title}`);
  }

  removeScene(productionId: string, sceneId: string, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    if (!snap.scenes.some((scene) => scene.id === sceneId)) throw new ProductionError("UNKNOWN_SCENE", `Unknown scene ${sceneId}`);
    const decision = snap.sceneDecisions[sceneId];
    if (decision?.status === "canon") throw new ProductionError("SCENE_CANONICAL", "A canonical scene cannot be deleted; prepare a rollback or a new canonical decision");
    if (Object.values(snap.candidates).some((candidate) => candidate.bindings.some((binding) => binding.sceneId === sceneId))) {
      throw new ProductionError("SCENE_HAS_CANDIDATES", "Remove or retain candidate bindings before deleting this scene");
    }
    if (Object.values(snap.proposals).some((proposal) => proposal.sceneDecision?.sceneId === sceneId && proposal.status === "proposed")) {
      throw new ProductionError("SCENE_HAS_PROPOSALS", "Resolve pending proposals before deleting this scene");
    }
    return this.append(productionId, "scene.removed", { sceneId }, actor, commandKey ?? `scene:remove:${sceneId}`);
  }

  createAssetBuild(productionId: string, input: CreateAssetBuildInput, actor: Actor, commandKey?: string): { build: AssetBuild; snapshot: ProductionSnapshot } {
    const snap = this.snapshot(productionId);
    const id = input.id ?? randomUUID();
    assertId(id, "asset build id");
    const build: AssetBuild = {
      id, productionId, app: String(input.app), category: String(input.category ?? "references").trim() || "references",
      label: String(input.label ?? "Asset build").trim() || "Asset build", prompt: String(input.prompt ?? "").trim(),
      status: "pending", assetIds: [], createdAt: nowIso(), createdBy: actor.id ?? actor.kind,
    };
    const snapshot = this.append(productionId, "asset.build.created", { build }, actor, commandKey ?? `asset:build:${id}`);
    return { build, snapshot };
  }

  completeAssetBuild(productionId: string, buildId: string, runId: string, assetIds: string[], actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    const current = snap.assetBuilds[buildId];
    if (!current) throw new ProductionError("UNKNOWN_ASSET_BUILD", `Unknown asset build ${buildId}`);
    const build: AssetBuild = { ...current, status: "completed", runId, assetIds: unique(assetIds) };
    return this.append(productionId, "asset.build.completed", { build }, actor, commandKey ?? `asset:build:complete:${buildId}`);
  }

  updateAsset(productionId: string, assetId: string, input: { label?: string; tags?: string[]; category?: string }, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    const current = snap.assets[assetId];
    if (!current) throw new ProductionError("UNKNOWN_ASSET", `Unknown asset ${assetId}`);
    const asset: Asset = {
      ...current,
      ...(input.label !== undefined ? { label: String(input.label).trim() || current.label } : {}),
      ...(input.tags !== undefined ? { tags: unique(input.tags.map(String)) } : {}),
      ...(input.category !== undefined ? { category: String(input.category).trim() || current.category } : {}),
    };
    return this.append(productionId, "asset.updated", { asset }, actor, commandKey ?? `asset:update:${assetId}:${asset.category}:${JSON.stringify(asset.tags)}:${asset.label}`);
  }

  removeAsset(productionId: string, assetId: string, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    if (!snap.assets[assetId]) throw new ProductionError("UNKNOWN_ASSET", `Unknown asset ${assetId}`);
    return this.append(productionId, "asset.removed", { assetId }, actor, commandKey ?? `asset:remove:${assetId}`);
  }

  registerCandidate(productionId: string, input: RegisterCandidateInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    const id = input.id ?? randomUUID();
    assertId(id, "candidate id");
    const bindings = (input.bindings ?? []).map((binding, index) => {
      if (!snap.scenes.some((scene) => scene.id === binding.sceneId)) throw new ProductionError("UNKNOWN_SCENE", `Unknown scene ${binding.sceneId}`);
      const start = assertFiniteFrame(binding.timelineStartFrame, "timelineStartFrame");
      const end = assertFiniteFrame(binding.timelineEndFrame, "timelineEndFrame");
      if (end <= start) throw new ProductionError("INVALID_BINDING", "timelineEndFrame must be greater than timelineStartFrame");
      if (binding.timebase !== undefined && binding.timebase !== "final-output") throw new ProductionError("INVALID_BINDING", "Only final-output timebases are supported in Phase 0");
      return {
        id: binding.id ?? `${id}-b${String(index + 1).padStart(3, "0")}`,
        sceneId: binding.sceneId, candidateId: id, ...(binding.runId ? { runId: binding.runId } : {}),
        timebase: "final-output" as const, timelineStartFrame: start, timelineEndFrame: end,
        segmentIndex: Number.isInteger(binding.segmentIndex) ? binding.segmentIndex : index,
        ...(binding.sourceStartFrame !== undefined ? { sourceStartFrame: assertFiniteFrame(binding.sourceStartFrame, "sourceStartFrame") } : {}),
        ...(binding.sourceEndFrame !== undefined ? { sourceEndFrame: assertFiniteFrame(binding.sourceEndFrame, "sourceEndFrame") } : {}),
        ...(binding.outputHash ? { outputHash: binding.outputHash } : {}),
        ...(binding.fps !== undefined ? { fps: Number(binding.fps) } : {}),
      } satisfies SceneRenderBinding;
    });
    const outputs = (input.outputs ?? []).map((output, index) => {
      const path = resolveMediaPath(output.path, this.mediaRoots);
      const kind = mediaKind(path);
      if (!kind) throw new ProductionError("UNSUPPORTED_MEDIA", `Unsupported media for output ${index + 1}`);
      if (!["video", "image", "audio", "text", "file"].includes(output.type)) throw new ProductionError("INVALID_CANDIDATE", `Invalid output type ${String(output.type)}`);
      const hash = hashFile(path);
      if (output.hash && hash !== output.hash) throw new ProductionError("MEDIA_HASH_MISMATCH", `Output hash does not match ${output.name}`);
      const probe = kind === "video" ? probeMedia(path) : undefined;
      return {
        ...output, path, hash,
        ...(probe?.fps ? { fps: probe.fps } : {}), ...(probe?.frameCount ? { frameCount: probe.frameCount } : {}),
        ...(probe?.duration ? { duration: probe.duration } : {}), ...(probe ? { verified: probe.verified } : {}),
      };
    });
    const provenance = input.provenance;
    const existing = snap.candidates[id];
    if (existing) {
      if (commandKey) return snap;
      throw new ProductionError("CANDIDATE_EXISTS", `Candidate ${id} already exists`);
    }
    const withoutHash = {
      id, productionId, label: String(input.label ?? id).trim(), source: input.source ?? "manual",
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}), ...(input.app ? { app: input.app } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}), outputs, bindings,
      ...(input.render ? { render: input.render } : {}), ...(provenance ? { provenance } : {}),
      createdAt: nowIso(), createdBy: actor.id ?? actor.kind,
    } satisfies Omit<Candidate, "contentHash">;
    const candidate: Candidate = { ...withoutHash, contentHash: candidateHash(withoutHash) };
    return this.append(productionId, "candidate.registered", { candidate }, actor, commandKey ?? `candidate:register:${id}`);
  }

  /**
   * Append a non-canonical binding correction. The historical binding and candidate
   * are never mutated; activeBindings() hides the superseded association from narrative
   * continuity retrieval and exposes the corrected virtual binding instead.
   */
  correctBinding(productionId: string, input: {
    candidateId: string;
    originalBindingId: string;
    correctedSceneId: string;
    sourceHash: string;
    reason: string;
    sources?: string[];
  }, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    const candidate = snap.candidates[input.candidateId];
    if (!candidate) throw new ProductionError("UNKNOWN_CANDIDATE", `Unknown candidate ${input.candidateId}`);
    const original = (snap.bindings[candidate.id] ?? []).find((binding) => binding.id === input.originalBindingId);
    if (!original) throw new ProductionError("UNKNOWN_BINDING", `Unknown original binding ${input.originalBindingId}`);
    if (!snap.scenes.some((scene) => scene.id === input.correctedSceneId)) throw new ProductionError("UNKNOWN_SCENE", `Unknown corrected scene ${input.correctedSceneId}`);
    if (input.correctedSceneId === original.sceneId) throw new ProductionError("BINDING_UNCHANGED", "Corrected scene must differ from the original binding scene");
    const output = candidate.outputs.find((item) => item.type === "video") ?? candidate.outputs[0];
    if (!output?.path || !output.hash) throw new ProductionError("CANDIDATE_SOURCE_MISSING", "Candidate has no verifiable source media");
    const actualHash = hashFile(output.path);
    if (actualHash !== output.hash) throw new ProductionError("SOURCE_HASH_MISMATCH", "Candidate source media no longer matches its recorded hash");
    if (input.sourceHash !== output.hash) throw new ProductionError("SOURCE_HASH_MISMATCH", "Correction source hash does not match the candidate source media");
    const active = (snap.bindingCorrections ?? []).find((correction) => correction.candidateId === candidate.id && correction.originalBindingId === original.id);
    if (active) throw new ProductionError("BINDING_ALREADY_CORRECTED", `Binding ${original.id} already has an active correction`);
    const correction: BindingCorrection = {
      id: `${original.id}-correction-${String((snap.bindingCorrections?.length ?? 0) + 1).padStart(3, "0")}`,
      candidateId: candidate.id, originalBindingId: original.id, originalSceneId: original.sceneId,
      correctedBindingId: `${original.id}-sc-corrected-${String((snap.bindingCorrections?.length ?? 0) + 1).padStart(3, "0")}`,
      correctedSceneId: input.correctedSceneId,
      timelineStartFrame: original.timelineStartFrame, timelineEndFrame: original.timelineEndFrame,
      sourceHash: output.hash, candidateContentHash: candidate.contentHash,
      ...(candidate.sourceRunId ? { sourceRunId: candidate.sourceRunId } : {}),
      reason: String(input.reason ?? "").trim() || "Human-authorized narrative binding correction",
      sources: [...new Set((input.sources ?? []).map(String).filter(Boolean))],
      createdAt: nowIso(), createdBy: actor.id ?? actor.kind, supersedesOriginal: true,
    };
    return this.append(productionId, "binding.corrected", { correction }, actor, commandKey ?? `binding:correct:${correction.id}`);
  }

  /** Original bindings minus active corrections, plus corrected virtual bindings. */
  activeBindings(productionId: string, candidateId: string): SceneRenderBinding[] {
    const snap = this.snapshot(productionId);
    const originals = snap.bindings[candidateId] ?? [];
    const corrections = (snap.bindingCorrections ?? []).filter((correction) => correction.candidateId === candidateId);
    const superseded = new Set(corrections.map((correction) => correction.originalBindingId));
    const active = originals.filter((binding) => !superseded.has(binding.id));
    for (const correction of corrections) {
      const original = originals.find((binding) => binding.id === correction.originalBindingId);
      if (!original) continue;
      active.push({
        ...original, id: correction.correctedBindingId, sceneId: correction.correctedSceneId,
        timelineStartFrame: correction.timelineStartFrame, timelineEndFrame: correction.timelineEndFrame,
        outputHash: correction.sourceHash,
      });
    }
    return active.sort((a, b) => a.timelineStartFrame - b.timelineStartFrame || a.id.localeCompare(b.id));
  }

  createProductionRun(productionId: string, input: CreateProductionRunInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    if (!input.title?.trim()) throw new ProductionError("INVALID_PRODUCTION_RUN", "A production run needs a title");
    if (!input.scenePlan?.length) throw new ProductionError("INVALID_PRODUCTION_RUN", "A production run needs at least one planned scene");
    const budget: ProductionRunBudget = {
      maxRendersPerScene: 1, maxTotalRenders: input.scenePlan.length, maxPromptEnhancements: input.scenePlan.length,
      maxObservationJobs: input.scenePlan.length, maxComparisonCalls: input.scenePlan.length, maxSeniorReviewBatches: 0,
      wallClockMinutes: 120, rendersUsed: 0, promptEnhancementsUsed: 0, observationJobsUsed: 0,
      comparisonCallsUsed: 0, seniorReviewBatchesUsed: 0, ...input.budget,
    };
    const run: ProductionRun = {
      id: input.id ?? `run-${randomUUID()}`, productionId,
      ...(input.seasonId ? { seasonId: input.seasonId } : {}), ...(input.episodeId ? { episodeId: input.episodeId } : {}),
      title: input.title.trim(), brief: String(input.brief ?? "").trim(), profile: input.profile,
      status: "prepared", stage: "plan", scenePlan: input.scenePlan.map((scene) => ({ ...scene, observationIds: [...scene.observationIds], continuityReviewIds: [...scene.continuityReviewIds], jobIds: [...scene.jobIds], errors: [...scene.errors] })),
      selectedApplications: [...new Set(input.selectedApplications ?? input.scenePlan.map((scene) => scene.selectedApp))],
      referenceAssets: [...new Set(input.referenceAssets ?? input.scenePlan.flatMap((scene) => scene.referenceAssetIds))],
      renderConfig: input.renderConfig ?? {}, budget, jobs: [], provisionalFacts: [], decisions: [], errors: [],
      currentSceneIndex: 0, revision: 1, createdAt: nowIso(), updatedAt: nowIso(), createdBy: actor.id ?? actor.kind, canonicalRevision: snap.revision,
    };
    return this.append(productionId, "production.run.created", { run }, actor, commandKey ?? `production-run:create:${run.id}`);
  }

  /** Append-only run update. The scope and budget are persisted before an expensive operation starts. */
  updateProductionRun(productionId: string, runId: string, patch: ProductionRunPatch, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    const current = (snap.productionRuns ?? {})[runId];
    if (!current) throw new ProductionError("UNKNOWN_PRODUCTION_RUN", `Unknown production run ${runId}`);
    const run: ProductionRun = {
      ...current, ...structuredClone(patch), productionId: current.productionId, id: current.id,
      canonicalRevision: current.canonicalRevision, revision: current.revision + 1, updatedAt: nowIso(),
    };
    return this.append(productionId, "production.run.updated", { run }, actor, commandKey ?? `production-run:update:${runId}:${run.revision}`);
  }

  recordProductionRunDecision(productionId: string, runId: string, decision: Omit<ProductionRunDecision, "id" | "at">, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    const current = (snap.productionRuns ?? {})[runId];
    if (!current) throw new ProductionError("UNKNOWN_PRODUCTION_RUN", `Unknown production run ${runId}`);
    const record: ProductionRunDecision = { ...decision, id: `decision-${randomUUID()}`, at: nowIso() };
    const run: ProductionRun = { ...current, decisions: [...current.decisions, record], revision: current.revision + 1, updatedAt: nowIso() };
    return this.append(productionId, "production.run.decided", { run }, actor, commandKey ?? `production-run:decision:${runId}:${record.id}`);
  }

  /** Immutable, append-only continuity review. It never changes canonical memory. */
  recordContinuityReview(productionId: string, input: RecordContinuityReviewInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    if (!input.sceneIds?.length) throw new ProductionError("INVALID_CONTINUITY_REVIEW", "A continuity review needs at least one scene");
    for (const sceneId of input.sceneIds) if (!snap.scenes.some((scene) => scene.id === sceneId)) throw new ProductionError("UNKNOWN_SCENE", `Unknown scene ${sceneId}`);
    const observations = input.observations.map((item) => {
      const observation = snap.observations[item.observationId];
      if (!observation?.report) throw new ProductionError("UNKNOWN_OBSERVATION", `Unknown or unstructured observation ${item.observationId}`);
      if (observation.report.reportVersion !== item.revision || observation.sceneId !== item.sceneId) {
        throw new ProductionError("OBSERVATION_REVISION_MISMATCH", `Observation ${item.observationId} revision/scene does not match the review reference`);
      }
      return { ...item, sourceHash: observation.report.sourceOutputHash };
    });
    const prior = Object.values(snap.continuityReviews ?? {})
      .filter((review) => review.sceneIds.join("|") === input.sceneIds.join("|") && review.status !== "superseded")
      .sort((a, b) => a.revision - b.revision).at(-1);
    const id = input.id ?? `continuity-${randomUUID()}`;
    if (snap.continuityReviews?.[id]) throw new ProductionError("CONTINUITY_REVIEW_EXISTS", `Continuity review ${id} already exists and is immutable`);
    const review: ContinuityReview = {
      id, productionId, ...(input.seasonId ? { seasonId: input.seasonId } : {}), ...(input.episodeId ? { episodeId: input.episodeId } : {}),
      sceneIds: [...input.sceneIds], bindingIds: [...(input.bindingIds ?? [])], candidateIds: [...(input.candidateIds ?? [])],
      observations, canonicalRevision: snap.revision,
      reviewer: { model: input.reviewer.model, kind: input.reviewer.kind, configuration: input.reviewer.configuration ?? {} },
      evidenceReferences: [...new Set(input.evidenceReferences ?? [])], status: input.status ?? "completed",
      findings: input.findings ?? [], stateRecords: input.stateRecords ?? [], correctionPlans: input.correctionPlans ?? [], limitations: input.limitations ?? [],
      ...(input.execution ? { execution: input.execution } : {}),
      revision: (prior?.revision ?? 0) + 1, ...(prior ? { previousReviewId: prior.id } : {}), createdAt: nowIso(), createdBy: actor.id ?? actor.kind,
    };
    return this.append(productionId, "continuity.reviewed", { review }, actor, commandKey ?? `continuity:review:${id}`);
  }

  recordObservation(productionId: string, input: RegisterObservationInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    if (!snap.scenes.some((scene) => scene.id === input.sceneId)) throw new ProductionError("UNKNOWN_SCENE", `Unknown scene ${input.sceneId}`);
    if (input.candidateId && !snap.candidates[input.candidateId]) throw new ProductionError("UNKNOWN_CANDIDATE", `Unknown candidate ${input.candidateId}`);
    const text = String(input.text ?? "").trim();
    if (!text) throw new ProductionError("INVALID_OBSERVATION", "An observation needs text");
    if (input.report) {
      if (input.report.productionId !== productionId || input.report.sceneId !== input.sceneId) {
        throw new ProductionError("INVALID_OBSERVATION", "The report production and scene must match the observation");
      }
      if (input.candidateId && input.report.candidateId !== input.candidateId) {
        throw new ProductionError("INVALID_OBSERVATION", "The report candidate must match the observation");
      }
    }
    const prior = Object.values(snap.observations)
      .filter((item) => item.productionId === productionId && item.sceneId === input.sceneId &&
        (input.candidateId ? item.candidateId === input.candidateId : !item.candidateId))
      .sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0) || a.createdAt.localeCompare(b.createdAt));
    const revision = input.revision ?? ((prior.at(-1)?.revision ?? 0) + 1);
    const previousRevisionId = input.previousRevisionId ?? prior.at(-1)?.id;
    const observation: Observation = {
      id: input.id ?? randomUUID(), productionId, sceneId: input.sceneId,
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      text, evidence: input.evidence ?? [], kind: input.kind ?? (input.report ? "analysis" : "manual"),
      revision, ...(previousRevisionId ? { previousRevisionId } : {}),
      ...(input.report ? { report: input.report } : {}),
      createdAt: nowIso(), createdBy: actor.id ?? actor.kind, source: actor.kind,
    };
    return this.append(productionId, "observation.recorded", { observation }, actor, commandKey ?? `observation:record:${observation.id}`);
  }

  indexAsset(productionId: string, input: IndexAssetInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    const path = String(input.path ?? "").trim();
    if (!path) throw new ProductionError("INVALID_ASSET", "An asset needs a path");
    const id = input.id ?? randomUUID();
    assertId(id, "asset id");
    if (snap.assets[id]) {
      if (commandKey) return snap;
      throw new ProductionError("ASSET_EXISTS", `Asset ${id} already exists`);
    }
    const canonical = resolveMediaPath(path, this.mediaRoots);
    const actualKind = mediaKind(canonical);
    if (!actualKind || actualKind !== input.kind) throw new ProductionError("UNSUPPORTED_MEDIA", `Asset must be a supported ${input.kind} file`);
    const hash = hashFile(canonical);
    if (input.hash && hash !== input.hash) throw new ProductionError("MEDIA_HASH_MISMATCH", "Asset hash does not match its file");
    const asset: Asset = {
      id, productionId, kind: input.kind, label: String(input.label ?? id),
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}), path: canonical,
      hash, category: String(input.category ?? "references").trim() || "references",
      tags: unique((input.tags ?? []).map(String)), createdAt: nowIso(), createdBy: actor.id ?? actor.kind,
    };
    return this.append(productionId, "asset.indexed", { asset }, actor, commandKey ?? `asset:index:${id}`);
  }

  private validateProposal(snap: ProductionSnapshot, proposal: CanonProposal) {
    const seen = new Set<string>();
    for (const [index, change] of proposal.changes.entries()) {
      if (!MEMORY_CATEGORIES.includes(change.category)) throw new ProductionError("INVALID_FACT", "Unknown memory category");
      if (!change.text?.trim()) throw new ProductionError("INVALID_FACT", "Every proposed fact needs text");
      if (change.sceneId && !snap.scenes.some((scene) => scene.id === change.sceneId)) throw new ProductionError("UNKNOWN_SCENE", `Unknown fact scene ${change.sceneId}`);
      const id = change.factId ?? factId(proposal.id, index);
      if (seen.has(id)) throw new ProductionError("INVALID_FACT", `Duplicate fact id ${id}`);
      seen.add(id);
      const list = snap.bible[change.category];
      if (change.op === "update") {
        if (!change.factId) throw new ProductionError("INVALID_FACT", "An update needs factId");
        if (!list.some((fact) => fact.id === change.factId)) throw new ProductionError("INVALID_FACT", `Unknown fact to update: ${change.factId}`);
      } else if (list.some((fact) => fact.id === id)) {
        throw new ProductionError("INVALID_FACT", `Fact already exists: ${id}`);
      }
    }
    if (proposal.sceneDecision) {
      const { sceneId, candidateId, decision } = proposal.sceneDecision;
      if (!snap.scenes.some((scene) => scene.id === sceneId)) throw new ProductionError("UNKNOWN_SCENE", `Unknown scene ${sceneId}`);
      if (!snap.candidates[candidateId]) throw new ProductionError("UNKNOWN_CANDIDATE", `Unknown candidate ${candidateId}`);
      const bindings = (snap.bindings[candidateId] ?? []).filter((binding) => binding.sceneId === sceneId);
      if (!bindings.length) throw new ProductionError("INVALID_SCENE_DECISION", "Candidate has no binding for this scene");
      if (decision === "canon" && !bindings.length) throw new ProductionError("INVALID_SCENE_DECISION", "A canonical scene needs at least one binding");
      if (proposal.sceneDecision.bindingIds?.length) {
        const known = new Set(bindings.map((binding) => binding.id));
        if (proposal.sceneDecision.bindingIds.some((id) => !known.has(id))) throw new ProductionError("INVALID_SCENE_DECISION", "Every selected binding must belong to this scene and candidate");
      }
    }
  }

  propose(productionId: string, input: ProposeCanonInput, actor: Actor, commandKey?: string): { proposal: CanonProposal; snapshot: ProductionSnapshot } {
    const snap = this.snapshot(productionId);
    const expectedRevision = input.expectedRevision ?? snap.revision;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new ProductionError("INVALID_PROPOSAL", "expectedRevision must be a non-negative integer");
    const changes = input.changes ?? [];
    for (const change of changes) {
      if (!MEMORY_CATEGORIES.includes(change.category)) throw new ProductionError("INVALID_FACT", "Unknown memory category");
      if (!change.text?.trim()) throw new ProductionError("INVALID_FACT", "Every proposed fact needs text");
      if (change.op === "update" && !change.factId) throw new ProductionError("INVALID_FACT", "An update needs factId");
    }
    if (input.sceneDecision) {
      const { sceneId, candidateId, decision } = input.sceneDecision;
      if (!snap.scenes.some((scene) => scene.id === sceneId)) throw new ProductionError("UNKNOWN_SCENE", `Unknown scene ${sceneId}`);
      if (!snap.candidates[candidateId]) throw new ProductionError("UNKNOWN_CANDIDATE", `Unknown candidate ${candidateId}`);
      const hasBinding = (snap.bindings[candidateId] ?? []).some((binding) => binding.sceneId === sceneId);
      if (!hasBinding) throw new ProductionError("INVALID_SCENE_DECISION", "Candidate has no binding for this scene");
      if (!["canon", "alternate", "reject"].includes(decision)) throw new ProductionError("INVALID_SCENE_DECISION", "Unknown scene decision");
    }
    const base = {
      productionId,
      expectedRevision,
      ...(input.sceneDecision ? { sceneDecision: input.sceneDecision } : {}),
      changes,
    };
    const proposal: CanonProposal = {
      id: input.id ?? randomUUID(), productionId, title: String(input.title ?? "Canonical proposal").trim(),
      note: String(input.note ?? "").trim(), expectedRevision,
      ...(input.sceneDecision ? { sceneDecision: input.sceneDecision } : {}), changes,
      fingerprint: proposalFingerprint(base), status: "proposed", createdAt: nowIso(),
      createdBy: actor.id ?? actor.kind, createdByKind: actor.kind,
    };
    this.validateProposal(snap, proposal);
    const next = this.append(productionId, "canon.proposed", { proposal }, actor, commandKey ?? `canon:propose:${proposal.id}`);
    return { proposal, snapshot: next };
  }

  approveProposal(productionId: string, proposalId: string, approval: HumanApproval, commandKey?: string): ProductionSnapshot {
    return this.withLock(productionId, () => {
      const snap = this.loadFreshSnapshot(productionId);
      const proposal = snap.proposals[proposalId];
      if (!proposal) throw new ProductionError("UNKNOWN_PROPOSAL", `Unknown proposal ${proposalId}`);
      if (proposal.status !== "proposed") throw new ProductionError("ALREADY_DECIDED", `Proposal ${proposalId} is already ${proposal.status}`);
      if (proposal.expectedRevision !== snap.revision) {
        throw new ProductionError("STALE_PROPOSAL", `Proposal expects revision ${proposal.expectedRevision}, current canonical revision is ${snap.revision}`);
      }
      this.validateProposal(snap, proposal);
      const check: ApprovalCheck = { fingerprint: proposal.fingerprint, expectedRevision: snap.revision, action: "proposal" };
      if (!this.verifyApproval(approval, check)) throw new ProductionError("HUMAN_APPROVAL_REQUIRED", "Canonical approval must come from the interactive human approval boundary");
      return this.appendLocked(productionId, "canon.approved", { proposal, approval }, { kind: "human", id: approval.approvedBy }, commandKey ?? `canon:approve:${proposalId}`).snapshot;
    });
  }

  rollback(productionId: string, targetRevision: number, approval: HumanApproval, commandKey?: string): ProductionSnapshot {
    return this.withLock(productionId, () => {
      const snap = this.loadFreshSnapshot(productionId);
      if (!Number.isInteger(targetRevision) || targetRevision < 0 || targetRevision > snap.revision) {
        throw new ProductionError("INVALID_ROLLBACK", `Target revision must be between 0 and ${snap.revision}`);
      }
      const fingerprint = rollbackFingerprint(productionId, targetRevision, snap.revision);
      if (!this.verifyApproval(approval, { fingerprint, expectedRevision: snap.revision, action: "rollback" })) {
        throw new ProductionError("HUMAN_APPROVAL_REQUIRED", "Rollback must come from the interactive human approval boundary");
      }
      return this.appendLocked(productionId, "canon.rolled_back", { targetRevision, expectedRevision: snap.revision, approval }, { kind: "human", id: approval.approvedBy }, commandKey ?? `canon:rollback:${targetRevision}:${snap.revision}`).snapshot;
    });
  }
}

export { proposalFingerprint, rollbackFingerprint };
