// Typed, bounded retrieval of canonical memory. This module has no LLM or engine
// dependency: the same context can feed Qwen, another writer, or a UI preview.
import type { BibleFact, MemoryCategory, ProductionSnapshot, Scene } from "./production-types.ts";

export type ProductionContextQuery = {
  sceneId?: string;
  characterIds?: string[];
  locationIds?: string[];
  threadIds?: string[];
  recentScenes?: number;
  maxChars?: number;
};

export type ProductionContextSection = {
  category: MemoryCategory;
  facts: BibleFact[];
  truncated: boolean;
};

export type ProductionContext = {
  productionId: string;
  revision: number;
  sceneId: string | null;
  sections: Record<MemoryCategory, ProductionContextSection>;
  recentScenes: { id: string; number: number; title: string; summary: string; episodeId: string }[];
  text: string;
  truncated: boolean;
};

const DEFAULT_MAX_CHARS = 8_000;
const DEFAULT_RECENT_SCENES = 4;

function factMatches(fact: BibleFact, ids: Set<string>): boolean {
  return !fact.subjectIds.length || fact.subjectIds.some((id) => ids.has(id));
}

function formatFact(fact: BibleFact): string {
  return `- [${fact.id}] ${fact.text}${fact.tags.length ? ` (${fact.tags.join(", ")})` : ""}`;
}

/** Bounded selection, never an unbounded dump of the Bible. */
export function buildProductionContext(snapshot: ProductionSnapshot, query: ProductionContextQuery = {}): ProductionContext {
  const scene = query.sceneId ? snapshot.scenes.find((item) => item.id === query.sceneId) : undefined;
  if (query.sceneId && !scene) throw new Error(`Unknown scene ${query.sceneId}`);
  const maxChars = Math.max(500, Math.min(64_000, Number(query.maxChars) || DEFAULT_MAX_CHARS));
  const recentCount = Math.max(0, Math.min(20, Number(query.recentScenes) || DEFAULT_RECENT_SCENES));
  const ids = new Set([
    ...(query.characterIds ?? []), ...(query.locationIds ?? []), ...(query.threadIds ?? []),
    ...(scene?.characterIds ?? []), ...(scene?.locationIds ?? []),
  ]);
  const sections = {} as Record<MemoryCategory, ProductionContextSection>;
  let used = 0;
  let overallTruncated = false;
  for (const category of ["identity", "state", "episodic", "narrative"] as const) {
    const candidates = snapshot.bible[category].filter((fact) => !ids.size || factMatches(fact, ids));
    const facts: BibleFact[] = [];
    let truncated = false;
    for (const fact of candidates) {
      const cost = formatFact(fact).length + 1;
      if (used + cost > maxChars) { truncated = true; overallTruncated = true; break; }
      facts.push(fact);
      used += cost;
    }
    sections[category] = { category, facts, truncated };
  }

  const sceneOrder = (item: Scene) => [item.episodeId, item.number] as const;
  const canonicalScenes = snapshot.scenes
    .filter((item) => snapshot.sceneDecisions[item.id]?.status === "canon")
    .filter((item) => !query.sceneId || item.id !== query.sceneId)
    .sort((a, b) => {
      const ak = sceneOrder(a), bk = sceneOrder(b);
      return ak[0].localeCompare(bk[0]) || ak[1] - bk[1];
    });
  const recentScenes = canonicalScenes.slice(-recentCount).map((item) => ({
    id: item.id, number: item.number, title: item.title, summary: item.summary, episodeId: item.episodeId,
  }));

  const parts: string[] = [`PRODUCTION BIBLE — canonical revision ${snapshot.revision}${scene ? ` — scene ${scene.title}` : ""}`];
  const labels: Record<MemoryCategory, string> = {
    identity: "IDENTITY (stable facts)", state: "STATE (current facts)",
    episodic: "EPISODIC (past events)", narrative: "NARRATIVE (open threads, promises, running gags)",
  };
  for (const category of ["identity", "state", "episodic", "narrative"] as const) {
    parts.push(labels[category]);
    const section = sections[category];
    if (!section.facts.length) parts.push("- (none)");
    else parts.push(...section.facts.map(formatFact));
    if (section.truncated) parts.push("- (additional facts omitted by the context budget)");
  }
  parts.push("RECENT CANONICAL SCENES");
  if (!recentScenes.length) parts.push("- (none)");
  else for (const item of recentScenes) parts.push(`- ${item.title}${item.summary ? `: ${item.summary}` : ""}`);
  return {
    productionId: snapshot.production.id,
    revision: snapshot.revision,
    sceneId: scene?.id ?? null,
    sections,
    recentScenes,
    text: parts.join("\n"),
    truncated: overallTruncated,
  };
}
