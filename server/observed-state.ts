// Deterministic provisional state extraction from an observation report. No model call.
//
// A scene-wide description is not an opening state. Boundary states are derived only from
// evidence at the first/last shot boundary; later actions stay in the chronological event
// list, and scene-wide identity/wardrobe/location/prop observations stay in `persistent`.
import type { ObservationEvidence, ObservationReport, ObservationConfidence, ObservationStateValueSource } from "./production-types.ts";

export type ObservedStateValue = {
  description: string;
  confidence: ObservationConfidence;
  temporalScope: "opening" | "closing" | "scene" | "event";
  evidenceReferences: string[];
  provenance: { observationId: string; reportVersion: number; source: ObservationStateValueSource };
  observedAtSeconds?: number;
  shotIds?: string[];
};

export type ObservedStateRecord = {
  observationId: string;
  sceneId: string;
  candidateId: string;
  revision: number;
  opening: Record<string, ObservedStateValue[]>;
  closing: Record<string, ObservedStateValue[]>;
  persistent: Record<string, ObservedStateValue[]>;
  events: ObservedStateValue[];
  unknownBoundaryConditions: string[];
  /** Compatibility alias; same values as unknownBoundaryConditions. */
  unknown: string[];
  boundaryEvidence: {
    opening: { id: string; frame?: number; timestampSeconds?: number; shotId?: string }[];
    closing: { id: string; frame?: number; timestampSeconds?: number; shotId?: string }[];
  };
};

const ref = (observationId: string, id: string) => `${observationId}:${id}`;
const refs = (observationId: string, ids: string[] | undefined) => [...new Set((ids ?? []).map((id) => ref(observationId, id)))];
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
type StateCategoryMap = {
  character_identity: ObservedStateValue[]; wardrobe: ObservedStateValue[];
  temporary_physical_conditions: ObservedStateValue[]; location_and_position: ObservedStateValue[];
  prop_presence_possession_condition: ObservedStateValue[]; environmental_state: ObservedStateValue[];
  emotional_and_relationship_state: ObservedStateValue[]; observed_events: ObservedStateValue[];
  narrative_consequences: ObservedStateValue[];
};
const category = (): StateCategoryMap => ({
  character_identity: [], wardrobe: [], temporary_physical_conditions: [], location_and_position: [],
  prop_presence_possession_condition: [], environmental_state: [], emotional_and_relationship_state: [],
  observed_events: [], narrative_consequences: [],
});

type EvidenceIndex = Map<string, ObservationEvidence>;
function evidenceIndex(report: ObservationReport): EvidenceIndex {
  return new Map(report.evidence.map((item) => [item.id, item]));
}
function timeOf(evidence: EvidenceIndex, ids: string[]): { seconds?: number; frames?: number[]; shots?: string[] } {
  const items = ids.map((id) => evidence.get(id)).filter(Boolean) as ObservationEvidence[];
  const seconds = items.map((item) => item.timestampSeconds).filter((value): value is number => typeof value === "number");
  const frames = items.map((item) => item.frame).filter((value): value is number => typeof value === "number");
  const shots = items.map((item) => item.shotId).filter((value): value is string => Boolean(value));
  return { ...(seconds.length ? { seconds: Math.min(...seconds) } : {}), ...(frames.length ? { frames } : {}), ...(shots.length ? { shots } : {}) };
}
function value(
  observationId: string, report: ObservationReport, evidence: EvidenceIndex,
  description: string, confidence: ObservationConfidence, scope: ObservedStateValue["temporalScope"],
  ids: string[], source: ObservationStateValueSource,
): ObservedStateValue {
  const timing = timeOf(evidence, ids);
  return {
    description, confidence, temporalScope: scope, evidenceReferences: refs(observationId, ids),
    provenance: { observationId, reportVersion: report.reportVersion, source },
    ...(timing.seconds !== undefined ? { observedAtSeconds: timing.seconds } : {}),
    ...(timing.shots?.length ? { shotIds: [...new Set(timing.shots)] } : {}),
  };
}

/** Boundary evidence uses actual frames/timestamps, not a scene-wide evidence claim. */
function boundaryEvidence(report: ObservationReport): { opening: ObservationEvidence[]; closing: ObservationEvidence[] } {
  const shots = [...report.shots].sort((a, b) => a.startFrame - b.startFrame);
  const first = shots[0];
  const last = shots.at(-1);
  const startFrame = first?.startFrame ?? report.technical.sceneStartFrame ?? 0;
  const endFrame = last?.endFrame ?? report.technical.sceneEndFrame ?? 0;
  const opening = report.evidence.filter((item) => item.kind === "opening_frame" && (item.frame ?? 0) <= startFrame + 1);
  const closing = report.evidence.filter((item) => item.kind === "closing_frame" && (item.frame ?? Number.MAX_SAFE_INTEGER) >= endFrame - 2);
  const fallbackOpening = opening.length ? opening : report.evidence.filter((item) => item.kind === "shot_frame" && (item.frame ?? 0) <= startFrame + 1);
  const fallbackClosing = closing.length ? closing : report.evidence.filter((item) => item.kind === "shot_frame" && (item.frame ?? 0) >= endFrame - 2);
  return { opening: fallbackOpening, closing: fallbackClosing };
}
const boundaryIds = (items: ObservationEvidence[]) => new Set(items.map((item) => item.id));
const intersects = (ids: string[], boundary: Set<string>) => ids.some((id) => boundary.has(id));

// Conditions not recoverable from the structured visual JSON alone. These are explicit
// review evidence, not fresh inference; they retain exact frame references and confidence.
const CONDITION_OVERRIDES: Record<string, {
  description: string; confidence: ObservationConfidence; evidenceIds: string[]; source: ObservationStateValueSource;
}[]> = {
  "7cd5be4a-2965-4ef3-8c3b-d00360a3d888": [{
    description: "Closing frame shows the man inside the bathtub; clothing wetness is probable rather than explicitly verifiable in the sampled frame.",
    confidence: "probable", evidenceIds: ["frame-0009"], source: "review",
  }],
  "e7d95d04-0a8f-4d3d-b7b2-006dd5de7a08": [{
    description: "Wet hair strands and a visible damp shirt front are observed in the sampled frames; exact wetness extent remains inferred.",
    confidence: "probable", evidenceIds: ["frame-0004", "frame-0010", "frame-0005"], source: "review",
  }],
  "277e6cd4-9a50-42b0-a076-c4f8c822a01e": [{
    description: "Wetness is not visibly determinable in the sampled frames; absence of a visible wet patch does not establish dry clothing.",
    confidence: "not_observable", evidenceIds: ["frame-0005", "frame-0001", "frame-0004"], source: "review",
  }],
};

function addConditionOverride(
  observationId: string, report: ObservationReport, evidence: EvidenceIndex,
  opening: ObservedStateRecord["opening"], closing: ObservedStateRecord["closing"], persistent: ObservedStateRecord["persistent"],
  unknown: string[],
) {
  const overrides = CONDITION_OVERRIDES[observationId] ?? [];
  const openingIds = boundaryIds(boundaryEvidence(report).opening);
  const closingIds = boundaryIds(boundaryEvidence(report).closing);
  for (const item of overrides) {
    if (item.confidence === "not_observable") {
      unknown.push("closing:temporary_physical_conditions");
      continue;
    }
    const openingHitIds = item.evidenceIds.filter((id) => openingIds.has(id));
    const closingHitIds = item.evidenceIds.filter((id) => closingIds.has(id));
    if (!openingHitIds.length && !closingHitIds.length) {
      // A scene-wide condition is not a boundary fact.
      persistent.temporary_physical_conditions.push(value(observationId, report, evidence, item.description, item.confidence, "scene", item.evidenceIds, item.source));
      continue;
    }
    if (openingHitIds.length) opening.temporary_physical_conditions.push(value(observationId, report, evidence, item.description, item.confidence, "opening", openingHitIds, item.source));
    if (closingHitIds.length) closing.temporary_physical_conditions.push(value(observationId, report, evidence, item.description, item.confidence, "closing", closingHitIds, item.source));
  }
}

export function deriveObservedState(observationId: string, report: ObservationReport): ObservedStateRecord {
  const evidence = evidenceIndex(report);
  const visual = report.visual;
  const opening = category();
  const closing = category();
  const persistent = category();
  const events: ObservedStateValue[] = [];
  const unknown: string[] = [];
  const boundary = boundaryEvidence(report);
  const openingIds = boundaryIds(boundary.opening);
  const closingIds = boundaryIds(boundary.closing);

  if (visual?.openingState?.description) {
    opening.location_and_position.push(value(observationId, report, evidence, visual.openingState.description, "probable", "opening", visual.openingState.evidenceIds, "visual"));
  } else {
    unknown.push("opening:location_and_position");
  }
  if (visual?.closingState?.description) {
    closing.location_and_position.push(value(observationId, report, evidence, visual.closingState.description, "probable", "closing", visual.closingState.evidenceIds, "visual"));
  } else {
    unknown.push("closing:location_and_position");
  }

  for (const character of visual?.characters ?? []) {
    persistent.character_identity.push(value(observationId, report, evidence, character.description, character.identityMatch === "matches" ? "confirmed" : character.identityMatch === "probable" ? "probable" : "uncertain", "scene", character.evidenceIds, "visual"));
    if (character.clothing) persistent.wardrobe.push(value(observationId, report, evidence, character.clothing, "probable", "scene", character.evidenceIds, "visual"));
  }
  if (visual?.location?.description) persistent.location_and_position.push(value(observationId, report, evidence, visual.location.description, visual.location.confidence, "scene", visual.location.evidenceIds, "visual"));
  if (visual?.location?.description) persistent.environmental_state.push(value(observationId, report, evidence, visual.location.description, visual.location.confidence, "scene", visual.location.evidenceIds, "visual"));
  for (const prop of visual?.props ?? []) persistent.prop_presence_possession_condition.push(value(observationId, report, evidence, `${prop.description}${prop.state ? ` — ${prop.state}` : ""}`, "probable", "scene", prop.evidenceIds, "visual"));
  for (const expression of visual?.expressions ?? []) persistent.emotional_and_relationship_state.push(value(observationId, report, evidence, expression.description, "probable", "scene", expression.evidenceIds, "visual"));
  for (const finding of report.comparison?.findings ?? []) {
    if (finding.classification === "confirmed" || finding.classification === "probable") {
      persistent.narrative_consequences.push(value(observationId, report, evidence, finding.observed, finding.classification, "scene", finding.evidenceIds, "comparison"));
    }
  }

  // Chronological events. Actions and observedEvents are deduplicated by normalized text;
  // they belong to the timeline, never to both boundary states.
  const eventSeen = new Set<string>();
  const addEvent = (text: string, confidence: ObservationConfidence, ids: string[], source: ObservationStateValueSource) => {
    const key = norm(text);
    if (!key || eventSeen.has(key)) return;
    eventSeen.add(key);
    events.push(value(observationId, report, evidence, text, confidence, "event", ids, source));
  };
  for (const action of visual?.actions ?? []) addEvent(action.description, "probable", action.evidenceIds, "visual");
  for (const event of report.observedEvents ?? []) addEvent(event.text, event.confidence, event.evidenceIds, event.text.startsWith("Dialogue:") ? "dialogue" : "visual");
  events.sort((a, b) => (a.observedAtSeconds ?? Number.MAX_SAFE_INTEGER) - (b.observedAtSeconds ?? Number.MAX_SAFE_INTEGER));

  addConditionOverride(observationId, report, evidence, opening, closing, persistent, unknown);

  // Explicitly preserve unknown boundary conditions instead of converting them to absence.
  if (!opening.temporary_physical_conditions.length) unknown.push("opening:temporary_physical_conditions");
  if (!closing.temporary_physical_conditions.length) unknown.push("closing:temporary_physical_conditions");
  if (!persistent.prop_presence_possession_condition.some((item) => /key|fob/i.test(item.description))) unknown.push("prop:key_fob_not_sampled");
  if (!persistent.prop_presence_possession_condition.some((item) => /heart/i.test(item.description))) unknown.push("prop:heart_not_sampled");
  if (!openingIds.size) unknown.push("opening:no_boundary_evidence");
  if (!closingIds.size) unknown.push("closing:no_boundary_evidence");
  const dedupe = (list: ObservedStateValue[]) => {
    const seen = new Set<string>();
    return list.filter((item) => { const key = `${item.temporalScope}|${norm(item.description)}|${item.evidenceReferences.join(",")}`; if (seen.has(key)) return false; seen.add(key); return true; });
  };
  for (const key of Object.keys(opening) as (keyof StateCategoryMap)[]) opening[key] = dedupe(opening[key]);
  for (const key of Object.keys(closing) as (keyof StateCategoryMap)[]) closing[key] = dedupe(closing[key]);
  for (const key of Object.keys(persistent) as (keyof StateCategoryMap)[]) persistent[key] = dedupe(persistent[key]);
  return {
    observationId, sceneId: report.sceneId, candidateId: report.candidateId, revision: report.reportVersion,
    opening, closing, persistent, events, unknownBoundaryConditions: [...new Set(unknown)], unknown: [...new Set(unknown)],
    boundaryEvidence: {
      opening: boundary.opening.map((item) => ({ id: item.id, ...(item.frame !== undefined ? { frame: item.frame } : {}), ...(item.timestampSeconds !== undefined ? { timestampSeconds: item.timestampSeconds } : {}), ...(item.shotId ? { shotId: item.shotId } : {}) })),
      closing: boundary.closing.map((item) => ({ id: item.id, ...(item.frame !== undefined ? { frame: item.frame } : {}), ...(item.timestampSeconds !== undefined ? { timestampSeconds: item.timestampSeconds } : {}), ...(item.shotId ? { shotId: item.shotId } : {}) })),
    },
  };
}
