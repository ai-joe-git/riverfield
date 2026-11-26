// Durable, append-only Production Engine store. No inference, no media copying.
import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  PRODUCTION_SCHEMA_VERSION, MEMORY_CATEGORIES, hashValue, proposalFingerprint,
  rollbackFingerprint, verifyHumanApproval,
  type Actor, type ApprovalCheck, type Asset, type BibleFact, type Candidate, type CanonProposal,
  type FactChange, type HumanApproval, type Observation, type ProductionEvent, type ProductionEventType,
  type ProductionMeta, type ProductionSnapshot, type ProductionSummary, type Scene, type SceneDecision,
  type SceneRenderBinding, type Season, type Episode, type MemoryCategory, type Provenance,
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
};
export type RegisterObservationInput = {
  id?: string;
  sceneId: string;
  candidateId?: string;
  runId?: string;
  text: string;
  evidence?: Observation["evidence"];
};
export type IndexAssetInput = {
  id?: string;
  kind: Asset["kind"];
  label: string;
  sourceRunId?: string;
  path: string;
  hash?: string;
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
    observations: {},
    sceneDecisions: {},
    bible: emptyBible(),
    proposals: {},
    assets: {},
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

  constructor(outDir: string, options: StoreOptions = {}) {
    this.root = join(outDir, "productions");
    this.verifyApproval = options.approvalVerifier ?? verifyHumanApproval;
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
        case "candidate.registered": {
          const candidate = event.payload.candidate as Candidate;
          snap.candidates[candidate.id] = candidate;
          snap.bindings[candidate.id] = candidate.bindings;
          break;
        }
        case "observation.recorded": {
          const observation = event.payload.observation as Observation;
          snap.observations[observation.id] = observation;
          break;
        }
        case "asset.indexed": {
          const asset = event.payload.asset as Asset;
          snap.assets[asset.id] = asset;
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
      hit.text = change.text;
      hit.subjectIds = unique(change.subjectIds ?? hit.subjectIds);
      hit.tags = unique(change.tags ?? hit.tags);
      if (change.data !== undefined) hit.data = change.data;
      if (sceneId) hit.sceneId = sceneId;
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
        && raw.lastEventSeq === events.at(-1)?.seq && raw.lastEventHash === events.at(-1)?.hash) return raw;
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
    const existing = snap.candidates[id];
    if (existing) {
      if (commandKey) return snap;
      throw new ProductionError("CANDIDATE_EXISTS", `Candidate ${id} already exists`);
    }
    const withoutHash = {
      id, productionId, label: String(input.label ?? id).trim(), source: input.source ?? "manual",
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}), ...(input.app ? { app: input.app } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}), outputs: input.outputs ?? [], bindings,
      ...(input.render ? { render: input.render } : {}),
      createdAt: nowIso(), createdBy: actor.id ?? actor.kind,
    } satisfies Omit<Candidate, "contentHash">;
    const candidate: Candidate = { ...withoutHash, contentHash: candidateHash(withoutHash) };
    return this.append(productionId, "candidate.registered", { candidate }, actor, commandKey ?? `candidate:register:${id}`);
  }

  recordObservation(productionId: string, input: RegisterObservationInput, actor: Actor, commandKey?: string): ProductionSnapshot {
    const snap = this.snapshot(productionId);
    if (!snap.scenes.some((scene) => scene.id === input.sceneId)) throw new ProductionError("UNKNOWN_SCENE", `Unknown scene ${input.sceneId}`);
    if (input.candidateId && !snap.candidates[input.candidateId]) throw new ProductionError("UNKNOWN_CANDIDATE", `Unknown candidate ${input.candidateId}`);
    const text = String(input.text ?? "").trim();
    if (!text) throw new ProductionError("INVALID_OBSERVATION", "An observation needs text");
    const observation: Observation = {
      id: input.id ?? randomUUID(), productionId, sceneId: input.sceneId,
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      text, evidence: input.evidence ?? [], createdAt: nowIso(), createdBy: actor.id ?? actor.kind, source: actor.kind,
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
    const asset: Asset = {
      id, productionId, kind: input.kind, label: String(input.label ?? id),
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}), path,
      ...(input.hash ? { hash: input.hash } : {}), createdAt: nowIso(), createdBy: actor.id ?? actor.kind,
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
