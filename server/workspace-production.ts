import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "./registry.ts";
import { isFileValue, type Values } from "./runner.ts";
import { InputError } from "./input-error.ts";
import { writerHash, type WriterReceipt } from "./workspace-writer.ts";
import type { planDirectorBatches } from "./h3-plan.ts";
import type { PreparedRender } from "./production-run.ts";

const PREPARATION_TTL_MS = 24 * 60 * 60 * 1000;

export type WorkspacePreparation = {
  productionId: string;
  runId: string;
  preparationId: string;
  createdAt: number;
  expiresAt: number;
  model: string;
  prepared: PreparedRender;
  segments?: WriterReceipt[];
};

export type WorkspaceDispatch = {
  requestKey: string;
  active: boolean;
  status?: "running" | "succeeded" | "failed" | "interrupted" | "timeout" | "lost";
  error?: string;
};

function readRecord<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function saveRecord(dir: string, key: string, record: unknown) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, key + ".json");
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export type WorkspaceAppPreparation = {
  preparationId: string; app: string; fingerprint: string; owner?: string; requestKey?: string;
  model: string; writerKey?: string; draftContract?: "h3-plain"; values: Values; segments: WriterReceipt[]; createdAt: number; expiresAt: number;
};

export function workspaceFingerprint(app: string, values: Values, preset?: string, assetIds: Record<string, string> = {}) {
  return writerHash(JSON.stringify([app, preset ?? null, Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
    .map(([slot, v]) => [slot, isFileValue(v) ? [v.name, writerHash(v.bytes), assetIds[slot] ?? null] : v])]));
}

export function verifyWorkspaceReferences(values: Values, segments: WriterReceipt[]) {
  const checked = new Map<string, string>();
  for (const { references } of segments) for (const ref of references) {
    const file = values[ref.slot];
    if (!isFileValue(file)) throw new InputError(`Prepared reference ${ref.slot} is missing.`);
    const hash = checked.get(ref.slot) ?? writerHash(file.bytes);
    if (hash !== ref.sha256) throw new InputError(`Prepared reference ${ref.slot} has changed.`);
    checked.set(ref.slot, hash);
  }
}

export function workspacePromptHashes(values: Values, segments: Pick<WriterReceipt, "segment" | "finalPromptSha256">[]) {
  const spec = typeof values.segment_windows === "string" && values.segment_windows ? JSON.parse(values.segment_windows) : null;
  const prompts = spec?.windows?.map((window: { prompt: string }) => window.prompt) ??
    (typeof values.segment_prompts === "string" && values.segment_prompts.trim() ? values.segment_prompts.split(/\r?\n/)
      : [values.prompt || values.global_prompt]);
  return segments.map(segment => {
    const prompt = prompts[segment.segment - 1];
    if (typeof prompt !== "string" || writerHash(prompt) !== segment.finalPromptSha256)
      throw new InputError(`Prepared segment ${segment.segment} no longer matches the prompt to be submitted.`);
    return { segment: segment.segment, finalPromptSha256: segment.finalPromptSha256 };
  });
}

export function verifyWorkspaceGraph(app: App, values: Values, graph: App["graph"], prompts: ReturnType<typeof workspacePromptHashes>) {
  if (!graph || Object.values(graph).some(node => node.class_type === "TextGenerateV2"))
    throw new InputError("The prepared render must not contain an inline prompt writer.");
  const bound: Values = {};
  for (const id of ["segment_windows", "segment_prompts", "prompt", "global_prompt"]) {
    if (typeof values[id] !== "string" || !String(values[id]).trim()) continue;
    const bind = app.inputs.find(field => field.id === id)?.bind?.[0];
    if (bind) bound[id] = graph?.[bind.node]?.inputs?.[bind.field];
  }
  workspacePromptHashes(bound, prompts);
}

export class WorkspaceProduction {
  private readonly preparations: string;
  private readonly dispatches: string;
  private readonly apps: string;
  private readonly appRequests: string;
  private readonly renders: string;
  private readonly batchPlans: string;
  private readonly preparing = new Map<string, { fingerprint: string; promise: Promise<WorkspaceAppPreparation> }>();
  private readonly active = new Set<string>();

  constructor(outDir: string) {
    this.preparations = join(outDir, "workspace-preparations");
    this.dispatches = join(outDir, "workspace-dispatch");
    this.apps = join(outDir, "workspace-app-preparations");
    this.appRequests = join(this.apps, "requests");
    this.renders = join(outDir, "workspace-render-audit");
    this.batchPlans = join(outDir, "director-batch-plans");
  }

  prepare(productionId: string, runId: string, model: string, prepared: PreparedRender, segments?: WriterReceipt[], preparationId: string = randomUUID()): WorkspacePreparation {
    const createdAt = Date.now();
    const record = { productionId, runId, preparationId, createdAt, expiresAt: createdAt + PREPARATION_TTL_MS, model,
      prepared: { ...prepared, values: { ...prepared.values, workspace_production_preparation: preparationId } }, segments };
    saveRecord(this.preparations, preparationId, record);
    return record;
  }

  preparation(productionId: string, runId: string, id: string) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return;
    const record = readRecord<WorkspacePreparation>(join(this.preparations, id + ".json"));
    if (record?.productionId === productionId && record.runId === runId) return record;
  }

  appPreparation(id: string, owner?: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return;
    const record = readRecord<WorkspaceAppPreparation>(join(this.apps, id + ".json"));
    if (record?.owner === owner && record) return record;
  }

  productionPreparation(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return;
    return readRecord<WorkspacePreparation>(join(this.preparations, id + ".json"));
  }

  async prepareApp(scope: Omit<WorkspaceAppPreparation, "createdAt" | "expiresAt" | "preparationId" | "values" | "segments">,
    prepare: (segments: WriterReceipt[], checkpoint: () => void) => Promise<Pick<WorkspaceAppPreparation, "values" | "segments">>) {
    const key = scope.requestKey ? this.key(JSON.stringify([scope.owner ?? null, scope.requestKey])) : null;
    if (key) {
      const existing = readRecord<{ id: string }>(join(this.appRequests, key + ".json"));
      const saved = existing && this.appPreparation(existing.id, scope.owner);
      if (saved) {
        if (saved.fingerprint !== scope.fingerprint) throw new InputError("This request already has a preparation for different inputs.");
        if (saved.expiresAt < Date.now()) throw new InputError("This preparation expired. Use a new request.");
        return saved;
      }
      const inflight = this.preparing.get(key);
      if (inflight) {
        if (inflight.fingerprint !== scope.fingerprint) throw new InputError("This request is preparing different inputs.");
        return inflight.promise;
      }
    }
    const draftKey = key ? key + ".draft" + (scope.draftContract ? "." + scope.draftContract : "") : undefined;
    const draft = draftKey ? readRecord<{ fingerprint: string; writerKey?: string; segments: WriterReceipt[] }>(
      join(this.appRequests, draftKey + ".json")) : undefined;
    if (draft && (draft.fingerprint !== scope.fingerprint || draft.writerKey !== scope.writerKey))
      throw new InputError("A partial preparation belongs to different inputs or writer settings. Use a new request.");
    const segments = draft?.segments ?? [];
    const promise = (async () => {
      const result = await prepare(segments, () => {
        if (draftKey) saveRecord(this.appRequests, draftKey, { fingerprint: scope.fingerprint, writerKey: scope.writerKey, segments });
      });
      const createdAt = Date.now();
      const record = { ...scope, ...result, preparationId: randomUUID(), createdAt, expiresAt: createdAt + PREPARATION_TTL_MS };
      saveRecord(this.apps, record.preparationId, record);
      if (key) saveRecord(this.appRequests, key, { id: record.preparationId });
      if (draftKey) rmSync(join(this.appRequests, draftKey + ".json"), { force: true });
      return record;
    })();
    if (!key) return promise;
    this.preparing.set(key, { fingerprint: scope.fingerprint, promise });
    try { return await promise; }
    finally { this.preparing.delete(key); }
  }

  saveBatchPlan(plan: ReturnType<typeof planDirectorBatches>) {
    const id = randomUUID();
    saveRecord(this.batchPlans, id, plan);
    return id;
  }

  batchPlan(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return;
    return readRecord<ReturnType<typeof planDirectorBatches>>(join(this.batchPlans, id + ".json"));
  }

  linkRender(jobId: string, preparationId: string, prompts: ReturnType<typeof workspacePromptHashes>, backendJobId?: string) {
    saveRecord(this.renders, jobId, { jobId, preparationId, prompts, ...(backendJobId ? { backendJobId } : {}) });
  }

  private key(scope: string, requestKey?: string) {
    // Keep the latest path compatible with receipts written by earlier versions.
    return createHash("sha256").update(requestKey === undefined ? scope : JSON.stringify([scope, requestKey])).digest("hex");
  }

  dispatch(scope: string, requestKey?: string): WorkspaceDispatch | undefined {
    const key = this.key(scope);
    let latest = readRecord<WorkspaceDispatch>(join(this.dispatches, key + ".json"));
    if (latest?.active && !this.active.has(scope)) {
      latest = { ...latest, active: false, status: "interrupted",
        error: "The production service restarted. Resume to reconcile the original job after checking the backend queue." };
      saveRecord(this.dispatches, key, latest);
    }
    if (!requestKey || latest?.requestKey === requestKey) return latest;
    return readRecord<WorkspaceDispatch>(join(this.dispatches, this.key(scope, requestKey) + ".json"));
  }

  begin(scope: string, requestKey: string, previous?: WorkspaceDispatch): WorkspaceDispatch {
    if (previous) saveRecord(this.dispatches, this.key(scope, previous.requestKey), previous);
    const receipt: WorkspaceDispatch = { requestKey, active: true, status: "running" };
    saveRecord(this.dispatches, this.key(scope), receipt);
    this.active.add(scope);
    return receipt;
  }

  finish(scope: string, receipt: WorkspaceDispatch) {
    try {
      saveRecord(this.dispatches, this.key(scope), { ...receipt, active: false });
    } finally {
      this.active.delete(scope);
    }
  }
}

export function workspacePreparationPreview(record: WorkspacePreparation) {
  const { preparationId, productionId, runId, model, createdAt, expiresAt, prepared } = record;
  const { segment_windows, segment_prompts, prompt, global_prompt } = prepared.values;
  return {
    applied: true, preparationId, productionId, runId, model, createdAt, expiresAt,
    sceneId: prepared.sceneId, revision: prepared.revision,
    prompts: {
      ...(typeof segment_windows === "string" ? { segment_windows: JSON.parse(segment_windows) } : {}),
      ...(typeof segment_prompts === "string" ? { segment_prompts } : {}),
      ...(typeof prompt === "string" ? { prompt } : {}),
      ...(typeof global_prompt === "string" ? { global_prompt } : {}),
    },
  };
}
