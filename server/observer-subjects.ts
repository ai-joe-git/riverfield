// Deterministic production subject registry and pre-proposal validation.
// Stable ids come from the production registry (Bible subject ids, scene ids, and
// character/location/prop assets), never from an LLM's free-form names.
import type { FactChange, ProductionSnapshot } from "./production-types.ts";

export type SubjectType = "character" | "location" | "prop" | "scene" | "production" | "unknown";

export type ProductionSubject = {
  id: string;
  label: string;
  type: SubjectType;
  aliases: string[];
  source: "bible" | "scene" | "asset" | "production";
};

export class ObserverProposalError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const slug = (value: string) => value
  .normalize("NFKD")
  .replace(/['’]/g, "")
  .replace(/[^a-z0-9]+/gi, "-")
  .replace(/^-+|-+$/g, "")
  .toLowerCase();

const key = (value: string) => value
  .normalize("NFKD")
  .replace(/['’]/g, "")
  .replace(/[^a-z0-9]+/gi, " ")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

const labelFromAsset = (label: string) => label
  .replace(/_(?:character|location|prop|reference|environment).*$/i, "")
  .replace(/[_-]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/** Build a deterministic registry from actual canonical/scene/asset ids. */
export function buildProductionSubjects(snapshot: ProductionSnapshot, sceneId?: string): ProductionSubject[] {
  const subjects = new Map<string, ProductionSubject>();
  const add = (subject: ProductionSubject) => {
    const previous = subjects.get(subject.id);
    if (!previous) subjects.set(subject.id, subject);
    else {
      previous.aliases = [...new Set([...previous.aliases, ...subject.aliases])];
      if (!previous.label) previous.label = subject.label;
    }
  };

  add({
    id: snapshot.production.id, label: snapshot.production.title, type: "production",
    aliases: [snapshot.production.title], source: "production",
  });

  for (const scene of snapshot.scenes) {
    add({ id: scene.id, label: scene.title, type: "scene", aliases: [scene.title, scene.id], source: "scene" });
    for (const id of [...(scene.characterIds ?? []), ...(scene.locationIds ?? [])]) {
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) continue;
      add({ id, label: id, type: scene.characterIds?.includes(id) ? "character" : "location", aliases: [id], source: "scene" });
    }
  }

  for (const category of ["identity", "state", "episodic", "narrative"] as const) {
    for (const fact of snapshot.bible[category] ?? []) {
      for (const id of fact.subjectIds ?? []) {
        if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) continue;
        add({ id, label: id, type: "unknown", aliases: [id], source: "bible" });
      }
    }
  }

  for (const asset of Object.values(snapshot.assets ?? {})) {
    const category = String(asset.category ?? "").toLowerCase();
    const type: SubjectType = category.startsWith("char") ? "character"
      : category.startsWith("env") || category.startsWith("loc") ? "location"
      : category.startsWith("prop") ? "prop" : "unknown";
    const label = labelFromAsset(asset.label);
    const id = slug(label || asset.label);
    if (!id) continue;
    add({
      id, label: label || asset.label, type,
      aliases: [...new Set([id, label, asset.label, asset.id, ...(asset.tags ?? [])].filter(Boolean))],
      source: "asset",
    });
  }

  // Canonical facts may use an id whose human label is only present on an asset.
  const byLabel = new Map<string, ProductionSubject>();
  for (const subject of subjects.values()) for (const alias of subject.aliases) byLabel.set(key(alias), subject);
  for (const subject of subjects.values()) {
    if (subject.label !== subject.id) continue;
    const match = byLabel.get(key(subject.id));
    if (match && match.id !== subject.id) subject.label = match.label;
  }

  const target = sceneId ? subjects.get(sceneId) : undefined;
  return [...subjects.values()].sort((a, b) =>
    (a.id === target?.id ? -1 : b.id === target?.id ? 1 : 0) || a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
}

export function resolveSubjectIds(values: string[] | undefined, registry: ProductionSubject[], sceneId?: string): string[] {
  const lookup = new Map<string, ProductionSubject>();
  for (const subject of registry) {
    for (const alias of [subject.id, subject.label, ...subject.aliases]) lookup.set(key(alias), subject);
  }
  const resolved: string[] = [];
  const unknown: string[] = [];
  for (const value of values ?? []) {
    const hit = lookup.get(key(value));
    if (!hit) { unknown.push(value); continue; }
    if (!resolved.includes(hit.id)) resolved.push(hit.id);
  }
  if (unknown.length) throw new ObserverProposalError("OBSERVER_UNKNOWN_SUBJECT", `Unknown production subject id(s): ${unknown.join(", ")}`, { unknown, sceneId });
  return resolved;
}

function sceneSubject(registry: ProductionSubject[], sceneId?: string): ProductionSubject | undefined {
  return registry.find((subject) => subject.id === sceneId) ?? registry.find((subject) => subject.type === "scene");
}

function requireCharacter(subjects: string[], registry: ProductionSubject[]): boolean {
  const byId = new Map(registry.map((subject) => [subject.id, subject]));
  return subjects.some((id) => byId.get(id)?.type === "character");
}

export type ValidatedProposal = {
  changes: FactChange[];
  subjects: { raw: string[]; resolved: string[]; addedFallback: boolean }[];
};

/**
 * Validate and normalize observed proposals before they can become canonical proposals.
 * Throws on unknown subjects, invalid evidence, malformed updates, or unsupported facts.
 */
export function validateObservedProposals(input: {
  changes: FactChange[];
  snapshot: ProductionSnapshot;
  sceneId: string;
  allowedEvidence: Set<string>;
}): ValidatedProposal {
  const registry = buildProductionSubjects(input.snapshot, input.sceneId);
  const scene = sceneSubject(registry, input.sceneId);
  const productionSubject = registry.find((subject) => subject.type === "production");
  const canonicalFacts = new Map<string, { category: string; sceneId?: string }>();
  for (const category of ["identity", "state", "episodic", "narrative"] as const) {
    for (const fact of input.snapshot.bible[category] ?? []) canonicalFacts.set(fact.id, { category, ...(fact.sceneId ? { sceneId: fact.sceneId } : {}) });
  }
  const output: FactChange[] = [];
  const subjectAudit: ValidatedProposal["subjects"] = [];
  for (const raw of input.changes) {
    const text = String(raw.text ?? "").trim();
    if (!text) throw new ObserverProposalError("OBSERVER_EMPTY_FACT", "A proposed fact has no text");
    if (!["identity", "state", "episodic", "narrative"].includes(String(raw.category))) {
      throw new ObserverProposalError("OBSERVER_INVALID_CATEGORY", `Unsupported proposal category ${String(raw.category)}`);
    }
    if (raw.op !== "add" && raw.op !== "update") throw new ObserverProposalError("OBSERVER_INVALID_OPERATION", `Unsupported proposal operation ${String(raw.op)}`);
    if (raw.op === "update") {
      if (!raw.factId) throw new ObserverProposalError("OBSERVER_UPDATE_WITHOUT_FACT", `Update proposal "${text}" has no factId`);
      const existing = canonicalFacts.get(raw.factId);
      if (!existing) throw new ObserverProposalError("OBSERVER_UNKNOWN_FACT", `Update proposal references unknown canonical fact ${raw.factId}`);
      if (existing.category !== raw.category) throw new ObserverProposalError("OBSERVER_UPDATE_CATEGORY", `Update ${raw.factId} changes category ${existing.category} to ${raw.category}`);
    } else if (raw.factId) {
      throw new ObserverProposalError("OBSERVER_ADD_WITH_FACT", `Add proposal "${text}" must not carry a factId`);
    }
    if (!Array.isArray(raw.evidenceIds) || !raw.evidenceIds.length) {
      throw new ObserverProposalError("OBSERVER_EVIDENCE_REQUIRED", `Proposed fact "${text}" has no evidence ids`);
    }
    const invalidEvidence = raw.evidenceIds.filter((id) => !input.allowedEvidence.has(id));
    if (invalidEvidence.length) {
      throw new ObserverProposalError("OBSERVER_INVALID_EVIDENCE", `Proposed fact "${text}" cites evidence not supplied to the model: ${invalidEvidence.join(", ")}`);
    }
    const rawSubjects = [...new Set((raw.subjectIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    let resolved = resolveSubjectIds(rawSubjects, registry, input.sceneId);
    let addedFallback = false;
    if (!resolved.length) {
      const fallback = raw.category === "narrative" ? productionSubject : scene;
      if (!fallback) throw new ObserverProposalError("OBSERVER_SUBJECT_REQUIRED", `Proposed fact "${text}" has no stable production subject`);
      resolved = [fallback.id];
      addedFallback = true;
    }
    if (raw.category === "identity" && !requireCharacter(resolved, registry)) {
      throw new ObserverProposalError("OBSERVER_IDENTITY_SUBJECT", `Identity proposal "${text}" must reference a known character subject`);
    }
    const phase = raw.phase ?? (raw.category === "episodic" ? "closing" : "opening");
    if (!["opening", "closing", "global"].includes(phase)) throw new ObserverProposalError("OBSERVER_INVALID_PHASE", `Unsupported proposal phase ${String(phase)}`);
    output.push({
      ...raw,
      text,
      category: raw.category,
      subjectIds: resolved,
      tags: [...new Set((raw.tags ?? []).filter(Boolean))],
      evidenceIds: [...new Set(raw.evidenceIds)],
      sceneId: raw.sceneId ?? input.sceneId,
      phase,
    });
    subjectAudit.push({ raw: rawSubjects, resolved, addedFallback });
  }
  return { changes: output, subjects: subjectAudit };
}
