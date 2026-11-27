import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export class WorkspaceProduction {
  private readonly preparations: string;
  private readonly dispatches: string;
  private readonly active = new Set<string>();

  constructor(outDir: string) {
    this.preparations = join(outDir, "workspace-preparations");
    this.dispatches = join(outDir, "workspace-dispatch");
  }

  prepare(productionId: string, runId: string, model: string, prepared: PreparedRender): WorkspacePreparation {
    const preparationId = randomUUID();
    const createdAt = Date.now();
    const record = { productionId, runId, preparationId, createdAt, expiresAt: createdAt + PREPARATION_TTL_MS, model, prepared };
    saveRecord(this.preparations, preparationId, record);
    return record;
  }

  preparation(productionId: string, runId: string, id: string) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return;
    const record = readRecord<WorkspacePreparation>(join(this.preparations, id + ".json"));
    if (record?.productionId === productionId && record.runId === runId) return record;
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
