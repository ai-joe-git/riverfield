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
const CATEGORY_WEIGHTS: Record<MemoryCategory, number> = { identity: 0.2, state: 0.3, episodic: 0.3, narrative: 0.2 };
const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  identity: "IDENTITY (stable facts)",
  state: "STATE (current facts at this scene)",
  episodic: "EPISODIC (canonical events before this scene)",
  narrative: "NARRATIVE (open threads, promises, running gags)",
};
const CONTINUITY_TAGS = new Set(["continuity", "constraint", "must", "critical", "essential"]);

const factLine = (fact: BibleFact, max = 500) => {
  const text = fact.text.length > max ? `${fact.text.slice(0, max)}…` : fact.text;
  return `- [${fact.id}] ${text}${fact.tags.length ? ` (${fact.tags.join(", ")})` : ""}`;
};

const isEssential = (fact: BibleFact) => fact.tags.some((tag) => CONTINUITY_TAGS.has(tag.toLowerCase()));

type Chronology = {
  season: Map<string, number>;
  episode: Map<string, { season: number; number: number }>;
  scene: (scene: Scene) => number[];
};

function chronology(snapshot: ProductionSnapshot): Chronology {
  const season = new Map(snapshot.seasons.map((item) => [item.id, item.number]));
  const episode = new Map(snapshot.episodes.map((item) => [item.id, { season: season.get(item.seasonId) ?? 0, number: item.number }]));
  const scene = (item: Scene) => {
    const ep = episode.get(item.episodeId) ?? { season: 0, number: 0 };
    return [ep.season, ep.number, item.number, Date.parse(item.createdAt) || 0];
  };
  return { season, episode, scene };
}

function compareRanks(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function approvedSceneSummary(snapshot: ProductionSnapshot, sceneId: string): string {
  // Only approved canonical facts are allowed here. Scene.summary is editorial draft text
  // and is deliberately ignored; an unapproved intention must never become memory.
  const facts = snapshot.bible.episodic
    .filter((fact) => fact.sceneId === sceneId && fact.approvedAt)
    .slice()
    .sort((a, b) => a.revision - b.revision);
  return facts.map((fact) => fact.text).join(" ").trim();
}

function selectWithinBudget(items: BibleFact[], budget: number): { facts: BibleFact[]; cost: number; truncated: boolean } {
  const facts: BibleFact[] = [];
  let cost = 0;
  const essential = items.filter(isEssential);
  const normal = items.filter((item) => !isEssential(item));
  for (const fact of [...essential, ...normal]) {
    const line = factLine(fact);
    if (cost + line.length + 1 > budget && !isEssential(fact)) continue;
    if (cost + line.length + 1 > budget && isEssential(fact) && facts.length > 0) continue;
    facts.push(fact);
    cost += line.length + 1;
  }
  return { facts, cost, truncated: facts.length < items.length };
}

/** Bounded selection, never an unbounded dump of the Bible. */
export function buildProductionContext(snapshot: ProductionSnapshot, query: ProductionContextQuery = {}): ProductionContext {
  const targetScene = query.sceneId ? snapshot.scenes.find((item) => item.id === query.sceneId) : undefined;
  if (query.sceneId && !targetScene) throw new Error(`Unknown scene ${query.sceneId}`);
  const maxChars = Math.max(500, Math.min(64_000, Number(query.maxChars) || DEFAULT_MAX_CHARS));
  const recentCount = Math.max(0, Math.min(20, Number(query.recentScenes) || DEFAULT_RECENT_SCENES));
  const chrono = chronology(snapshot);
  const targetRank = targetScene ? chrono.scene(targetScene) : null;
  const atOrBeforeTarget = (sceneId: string | undefined) => {
    if (!sceneId || !targetRank) return true;
    const scene = snapshot.scenes.find((item) => item.id === sceneId);
    return scene ? compareRanks(chrono.scene(scene), targetRank) <= 0 : true;
  };

  const ids = new Set([
    ...(query.characterIds ?? []), ...(query.locationIds ?? []), ...(query.threadIds ?? []),
    ...(targetScene?.characterIds ?? []), ...(targetScene?.locationIds ?? []),
  ]);
  const factMatches = (fact: BibleFact) => (!ids.size || !fact.subjectIds.length || fact.subjectIds.some((id) => ids.has(id))) && atOrBeforeTarget(fact.sceneId);

  const eligible = {} as Record<MemoryCategory, BibleFact[]>;
  for (const category of ["identity", "state", "episodic", "narrative"] as const) {
    eligible[category] = snapshot.bible[category]
      .filter(factMatches)
      .sort((a, b) => Number(isEssential(b)) - Number(isEssential(a)) || a.revision - b.revision || a.id.localeCompare(b.id));
  }

  // Recent summaries are approved Episodic facts. Draft scene summaries are never used.
  const canonicalScenes = snapshot.scenes
    .filter((item) => snapshot.sceneDecisions[item.id]?.status === "canon")
    .filter((item) => !targetRank || compareRanks(chrono.scene(item), targetRank) <= 0)
    .sort((a, b) => compareRanks(chrono.scene(a), chrono.scene(b)));
  const recentCandidates = canonicalScenes.slice(-recentCount).map((item) => ({
    id: item.id, number: item.number, title: item.title, summary: approvedSceneSummary(snapshot, item.id), episodeId: item.episodeId,
  })).filter((item) => item.summary);

  const header = `PRODUCTION BIBLE — canonical revision ${snapshot.revision}${targetScene ? ` — scene ${targetScene.title}` : ""}`;
  const sectionOverhead = (["identity", "state", "episodic", "narrative"] as const).reduce((n, category) => n + CATEGORY_LABELS[category].length + 2, 0);
  const fixedCost = header.length + sectionOverhead + 2;
  let remaining = Math.max(0, maxChars - fixedCost);

  // Reserve at most one fifth for scene summaries, then distribute the rest with weights.
  const recentBudget = Math.min(Math.max(0, Math.floor(remaining * 0.2)), recentCandidates.reduce((n, item) => n + item.summary.length + item.title.length + 32, 0));
  const recent: typeof recentCandidates = [];
  let recentCost = 0;
  for (const item of recentCandidates) {
    const cost = item.summary.length + item.title.length + 32;
    if (recentCost + cost > recentBudget) continue;
    recent.push(item);
    recentCost += cost;
  }
  remaining = Math.max(0, remaining - recentCost);
  const quotas = {} as Record<MemoryCategory, number>;
  let allocated = 0;
  for (const category of ["identity", "state", "episodic", "narrative"] as const) {
    quotas[category] = Math.floor(remaining * CATEGORY_WEIGHTS[category]);
    allocated += quotas[category];
  }
  // Any rounding remainder goes to State/Narrative continuity, never entirely to Identity.
  quotas.state += remaining - allocated;

  const sections = {} as Record<MemoryCategory, ProductionContextSection>;
  for (const category of ["identity", "state", "episodic", "narrative"] as const) {
    const chosen = selectWithinBudget(eligible[category], Math.max(0, quotas[category]));
    sections[category] = { category, facts: chosen.facts, truncated: chosen.truncated };
  }

  const render = () => {
    const parts = [header];
    for (const category of ["identity", "state", "episodic", "narrative"] as const) {
      parts.push(CATEGORY_LABELS[category]);
      const section = sections[category];
      if (!section.facts.length) parts.push("- (none)");
      else parts.push(...section.facts.map((fact) => factLine(fact)));
      if (section.truncated) parts.push("- (additional facts omitted by the context budget)");
    }
    parts.push("RECENT CANONICAL SCENES");
    if (!recent.length) parts.push("- (none)");
    else for (const item of recent) parts.push(`- ${item.title}: ${item.summary.slice(0, 300)}${item.summary.length > 300 ? "…" : ""}`);
    return parts.join("\n");
  };

  // Enforce the budget against the complete final text. Remove non-essential facts from
  // the largest section first, so continuity-tagged facts survive as long as possible.
  let text = render();
  let truncated = Object.values(sections).some((section) => section.truncated) || recent.length < recentCandidates.length;
  while (text.length > maxChars) {
    let best: MemoryCategory | null = null;
    let bestCost = 0;
    for (const category of ["identity", "state", "episodic", "narrative"] as const) {
      const removable = sections[category].facts.filter((fact) => !isEssential(fact));
      const cost = removable.reduce((n, fact) => n + factLine(fact).length + 1, 0);
      if (cost > bestCost) { best = category; bestCost = cost; }
    }
    if (!best) break;
    const fact = [...sections[best].facts].reverse().find((item) => !isEssential(item));
    if (!fact) break;
    sections[best].facts = sections[best].facts.filter((item) => item.id !== fact.id);
    sections[best].truncated = true;
    truncated = true;
    text = render();
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
    truncated = true;
  }

  return {
    productionId: snapshot.production.id,
    revision: snapshot.revision,
    sceneId: targetScene?.id ?? null,
    sections,
    recentScenes: recent,
    text,
    truncated,
  };
}
