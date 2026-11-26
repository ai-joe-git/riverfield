// Typed, bounded retrieval of canonical memory. This module has no LLM or engine
// dependency: the same context can feed Qwen, another writer, or a UI preview.
import type { BibleFact, FactPhase, FactRevision, MemoryCategory, ProductionSnapshot, Scene } from "./production-types.ts";

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
  budget: { maxChars: number; usedChars: number; sufficient: boolean; omittedEssential: string[] };
};

const DEFAULT_MAX_CHARS = 8_000;
const DEFAULT_RECENT_SCENES = 4;
const CATEGORY_WEIGHTS: Record<MemoryCategory, number> = { identity: 0.2, state: 0.3, episodic: 0.3, narrative: 0.2 };
const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  identity: "IDENTITY (stable facts)",
  state: "STATE (current facts at this scene's opening)",
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

/** A scene's outcome is closing state; it must not become the opening of that same scene. */
function revisionVisibleAt(rev: Pick<BibleFact, "sceneId" | "phase">, targetRank: number[] | null, chrono: Chronology, scenes: Scene[]): boolean {
  if (!targetRank || !rev.sceneId) return true;
  const factScene = scenes.find((item) => item.id === rev.sceneId);
  if (!factScene) return true;
  const comparison = compareRanks(chrono.scene(factScene), targetRank);
  if (comparison < 0) return true;
  if (comparison > 0) return false;
  return (rev.phase ?? "opening") !== "closing";
}

function effectiveFactAt(fact: BibleFact, targetRank: number[] | null, chrono: Chronology, scenes: Scene[]): BibleFact | null {
  const revisions: BibleFact[] = [
    ...(fact.history ?? []).map((entry: FactRevision) => ({
      ...fact, ...entry, phase: entry.phase ?? "opening", history: [],
    })),
    fact,
  ];
  const visible = revisions.filter((entry) => revisionVisibleAt(entry, targetRank, chrono, scenes));
  if (!visible.length) return null;
  return visible.sort((a, b) => a.revision - b.revision)[0] === undefined
    ? null
    : visible.sort((a, b) => a.revision - b.revision).at(-1)!;
}

function approvedSceneSummary(snapshot: ProductionSnapshot, sceneId: string): string {
  // Only approved Episodic facts are summaries. Scene.summary is editorial draft text.
  const facts = snapshot.bible.episodic
    .filter((fact) => fact.sceneId === sceneId && fact.approvedAt && (fact.phase ?? "closing") === "closing")
    .slice()
    .sort((a, b) => a.revision - b.revision);
  return facts.map((fact) => fact.text).join(" ").trim();
}

function selectWithinBudget(items: BibleFact[], budget: number): { facts: BibleFact[]; cost: number; truncated: boolean; omittedEssential: string[] } {
  const facts: BibleFact[] = [];
  const omittedEssential: string[] = [];
  let cost = 0;
  const essential = items.filter(isEssential);
  const normal = items.filter((item) => !isEssential(item));
  for (const fact of [...essential, ...normal]) {
    const line = factLine(fact);
    if (cost + line.length + 1 > budget) {
      if (isEssential(fact)) omittedEssential.push(fact.id);
      continue;
    }
    facts.push(fact);
    cost += line.length + 1;
  }
  return { facts, cost, truncated: facts.length < items.length, omittedEssential };
}

/** Bounded selection, never an unbounded dump of the Bible. */
export function buildProductionContext(snapshot: ProductionSnapshot, query: ProductionContextQuery = {}): ProductionContext {
  const targetScene = query.sceneId ? snapshot.scenes.find((item) => item.id === query.sceneId) : undefined;
  if (query.sceneId && !targetScene) throw new Error(`Unknown scene ${query.sceneId}`);
  const maxChars = Math.max(500, Math.min(64_000, Number(query.maxChars) || DEFAULT_MAX_CHARS));
  const recentCount = Math.max(0, Math.min(20, Number(query.recentScenes) || DEFAULT_RECENT_SCENES));
  const chrono = chronology(snapshot);
  const targetRank = targetScene ? chrono.scene(targetScene) : null;

  const ids = new Set([
    ...(query.characterIds ?? []), ...(query.locationIds ?? []), ...(query.threadIds ?? []),
    ...(targetScene?.characterIds ?? []), ...(targetScene?.locationIds ?? []),
  ]);
  const eligible = {} as Record<MemoryCategory, BibleFact[]>;
  for (const category of ["identity", "state", "episodic", "narrative"] as const) {
    eligible[category] = snapshot.bible[category]
      .map((fact) => effectiveFactAt(fact, targetRank, chrono, snapshot.scenes))
      .filter((fact): fact is BibleFact => Boolean(fact))
      .filter((fact) => !ids.size || !fact.subjectIds.length || fact.subjectIds.some((id) => ids.has(id)))
      .sort((a, b) => Number(isEssential(b)) - Number(isEssential(a)) || a.revision - b.revision || a.id.localeCompare(b.id));
  }

  // Recent summaries are previous canonical scenes only; the query scene's own outcome
  // is never allowed to pose as its opening or as an approved summary.
  const canonicalScenes = snapshot.scenes
    .filter((item) => snapshot.sceneDecisions[item.id]?.status === "canon")
    .filter((item) => !targetRank || compareRanks(chrono.scene(item), targetRank) < 0)
    .sort((a, b) => compareRanks(chrono.scene(a), chrono.scene(b)));
  const recentCandidates = canonicalScenes.slice(-recentCount).map((item) => ({
    id: item.id, number: item.number, title: item.title, summary: approvedSceneSummary(snapshot, item.id), episodeId: item.episodeId,
  })).filter((item) => item.summary);

  const header = `PRODUCTION BIBLE — canonical revision ${snapshot.revision}${targetScene ? ` — scene ${targetScene.title} (opening)` : ""}`;
  const sectionOverhead = (["identity", "state", "episodic", "narrative"] as const).reduce((n, category) => n + CATEGORY_LABELS[category].length + 2, 0);
  let remaining = Math.max(0, maxChars - header.length - sectionOverhead - 2);

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
  quotas.state += remaining - allocated;

  const sections = {} as Record<MemoryCategory, ProductionContextSection>;
  const omittedEssential: string[] = [];
  for (const category of ["identity", "state", "episodic", "narrative"] as const) {
    const chosen = selectWithinBudget(eligible[category], Math.max(0, quotas[category]));
    sections[category] = { category, facts: chosen.facts, truncated: chosen.truncated };
    omittedEssential.push(...chosen.omittedEssential);
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
    if (omittedEssential.length) parts.push(`CONTEXT BUDGET INSUFFICIENT — essential continuity facts omitted: ${omittedEssential.join(", ")}`);
    return parts.join("\n");
  };

  // Enforce the budget against the complete final text. Remove non-essential facts from
  // the largest section first. Essential omissions are always explicit, never silent.
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
    // The final hard limit is a last-resort guard. The warning above is already present
    // whenever essential facts were omitted, so this cannot silently mislead the writer.
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
    budget: {
      maxChars,
      usedChars: text.length,
      sufficient: omittedEssential.length === 0,
      omittedEssential,
    },
  };
}
