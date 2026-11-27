// Pure comparison validation. Findings are strict and independent from optional
// canonical proposals. Invalid proposals are rejected individually and preserved.
import type {
  FactChange, ObservationComparison, ObservationConfidence, ObservationFinding,
  ObservationReport, RejectedProposal,
} from "./production-types.ts";
import { ObservationError } from "./observation-evidence.ts";

const allowedFindingCategories = new Set([
  "character", "wardrobe", "prop", "action", "dialogue", "event", "location",
  "continuity", "creative_deviation", "coverage",
]);
const allowedProposalCategories = new Set(["identity", "state", "episodic", "narrative"]);
const allowedProposalPhases = new Set(["opening", "closing", "global"]);
const allowedClassifications = new Set(["confirmed", "probable", "uncertain", "not_observable"]);
const soundPattern = /\b(sound effect|pin drop|pop|clink|audio|music|soundtrack|sting|whoosh|rustle|footstep|scream|laugh track)\b/i;

const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const strings = (value: unknown, max = 30): string[] => Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, max) : [];
const dedupeBy = <T>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => { const k = key(item); if (!k || seen.has(k)) return false; seen.add(k); return true; });
};
const asConfidence = (value: unknown, fallback: ObservationConfidence = "not_observable", field = "confidence"): ObservationConfidence => {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value);
  if (!allowedClassifications.has(normalized)) throw new ObservationError("OBSERVER_SCHEMA_INVALID", `${field} has unsupported value ${normalized}`);
  return normalized as ObservationConfidence;
};
const dialogueMatch = (expected: string, observed: string, stated?: unknown): "exact" | "partial" | "mismatch" | "none" => {
  const statedMatch = ["exact", "partial", "mismatch", "none"].includes(String(stated)) ? String(stated) as "exact" | "partial" | "mismatch" | "none" : null;
  const clean = (text: string) => norm(text.replace(/^s\d+\s*:\s*/i, "").replace(/^asr\s*:\s*/i, "").replace(/^["'“”]+|["'“”]+$/g, ""));
  const e = clean(expected), o = clean(observed);
  if (!e || !o) return statedMatch ?? "none";
  if (e === o) return "exact";
  if (o.includes(e) || e.includes(o)) return "partial";
  return statedMatch ?? "mismatch";
};
function evidenceIds(value: unknown, allowed: Set<string>, limitations: string[]): string[] {
  const requested = strings(value);
  const ids = requested.filter((id) => allowed.has(id));
  if (requested.length && !ids.length) limitations.push("The comparison cited evidence ids that were not in the evidence map.");
  return ids;
}

export type ComparisonValidationOptions = {
  /** Build mode keeps provisional observations but disables canonical proposal generation. */
  allowCanonicalProposals: boolean;
  comparisonPromptVersion: string;
  comparedAt?: string;
};

export type ComparisonValidationResult = {
  comparison: ObservationComparison;
  proposalRejections: RejectedProposal[];
  findingRejections: import("./production-types.ts").RejectedFinding[];
};

/**
 * Validate findings strictly, then validate canonical proposals independently.
 * A malformed or disabled proposal must never discard validated findings.
 */
export function validateComparisonPayload(
  payload: Record<string, unknown>,
  report: Pick<ObservationReport, "evidence" | "nativeEvidence">,
  options: ComparisonValidationOptions,
): ComparisonValidationResult {
  const allowed = new Set([
    ...report.evidence.map((entry) => entry.id),
    ...(report.nativeEvidence ?? []).map((entry) => entry.id),
  ]);
  const limitations = strings(payload.limitations, 30);
  const findings: ObservationFinding[] = [];
  const findingRejections: import("./production-types.ts").RejectedFinding[] = [];
  const rawFindings = Array.isArray(payload.findings) ? payload.findings : [];
  const seenFindings = new Set<string>();
  for (const [index, finding] of rawFindings.entries()) {
    const categoryValue = String((finding as any)?.category ?? "");
    if (!allowedFindingCategories.has(categoryValue)) {
      findingRejections.push({ original: finding, code: "OBSERVER_FINDING_CATEGORY_INVALID", message: `Comparison finding ${index + 1} has unsupported category ${categoryValue || "(missing)"}` });
      continue;
    }
    const category = categoryValue as ObservationFinding["category"];
    const classificationValue = String((finding as any)?.classification ?? "");
    if (!allowedClassifications.has(classificationValue)) {
      findingRejections.push({ original: finding, code: "OBSERVER_FINDING_CLASSIFICATION_INVALID", message: `Comparison finding ${index + 1} classification has unsupported value ${classificationValue || "(missing)"}` });
      continue;
    }
    const expected = String((finding as any)?.expected ?? "").trim();
    const observed = String((finding as any)?.observed ?? "").trim();
    if (!expected && !observed) continue;
    const key = `${category}|${norm(expected)}|${norm(observed)}`;
    if (seenFindings.has(key)) { limitations.push(`Comparison finding ${index + 1} was a duplicate and was removed.`); continue; }
    seenFindings.add(key);
    const ids = evidenceIds((finding as any)?.evidence_ids, allowed, limitations);
    let classification = classificationValue as ObservationConfidence;
    let rationale = String((finding as any)?.rationale ?? "").trim();
    const match = category === "dialogue" ? dialogueMatch(expected, observed, (finding as any)?.dialogue_match) : undefined;
    const audioIds = ids.filter((id) => id.startsWith("audio-"));
    if (category === "dialogue") {
      if (match === "partial" && classification === "confirmed") {
        classification = "probable";
        rationale = `${rationale}${rationale ? " " : ""}The transcript is a partial match, not an exact match.`.trim();
      } else if (match === "mismatch") {
        classification = "uncertain";
        rationale = `${rationale}${rationale ? " " : ""}The available transcript does not match the expected line.`.trim();
      }
      if (!audioIds.length) {
        classification = "not_observable";
        rationale = `${rationale}${rationale ? " " : ""}No audio evidence supports this dialogue finding.`.trim();
      }
    }
    if (category === "prop" && /\b(liquid|contents|full|empty|filled)\b/i.test(`${expected} ${observed}`) && !audioIds.length) {
      if (classification === "confirmed" || classification === "probable") classification = "uncertain";
      rationale = `${rationale}${rationale ? " " : ""}A static visual frame does not establish liquid contents or quantity.`.trim();
    }
    if (category === "action" && /\b(previous|earlier|before|approach(?:es|ing)?|walk(?:s|ing)?)\b/i.test(`${expected} ${observed}`)) {
      const visualIds = ids.filter((id) => id.startsWith("frame-"));
      if (visualIds.length < 2 && classification === "confirmed") {
        classification = "probable";
        rationale = `${rationale}${rationale ? " " : ""}The previous or continuing movement is inferred from a single still, not directly observed.`.trim();
      }
    }
    if (!ids.length && (classification === "confirmed" || classification === "probable")) {
      classification = "not_observable";
      rationale = `${rationale}${rationale ? " " : ""}No supplied visual or audio evidence id supports this finding; it was downgraded during validation.`.trim();
      limitations.push(`Comparison finding ${index + 1} had no valid evidence id and was downgraded from the model's stated classification.`);
    }
    findings.push({
      id: "", category, expected, observed, classification, rationale, evidenceIds: ids,
      ...(match ? { dialogueMatch: match } : {}),
    });
    if (soundPattern.test(`${expected} ${observed}`) && !audioIds.length) {
      findings.push({
        id: "", category: "event",
        expected: "Audio/sound-effect component",
        observed: "Not observable from visual evidence; the audio track was not cited for this subclaim.",
        classification: "not_observable",
        rationale: "Compound visual/audio finding split into an atomic audio claim; a visible effect does not confirm a sound.",
        evidenceIds: [], dialogueMatch: "none",
      });
    }
  }
  const numberedFindings = dedupeBy(findings, (finding) => `${finding.category}|${norm(finding.expected)}|${norm(finding.observed)}`)
    .map((finding, index) => ({ ...finding, id: `finding-${String(index + 1).padStart(3, "0")}` }));

  const proposalRejections: RejectedProposal[] = [];
  const proposedChanges: FactChange[] = [];
  for (const [index, raw] of (Array.isArray(payload.proposed_changes) ? payload.proposed_changes : []).entries()) {
    const reject = (code: string, message: string) => proposalRejections.push({ original: raw, code, message });
    if (!options.allowCanonicalProposals) {
      reject("BUILD_MODE_PROPOSALS_DISABLED", `Proposed change ${index + 1} was rejected because canonical proposals are disabled in Build mode.`);
      continue;
    }
    const change = raw as Record<string, unknown>;
    if (change?.op !== "add" && change?.op !== "update") { reject("OBSERVER_SCHEMA_INVALID", `Proposed change ${index + 1} has unsupported op ${String(change?.op)}`); continue; }
    if (!allowedProposalCategories.has(String(change?.category))) { reject("OBSERVER_SCHEMA_INVALID", `Proposed change ${index + 1} has unsupported category ${String(change?.category)}`); continue; }
    if (!allowedProposalPhases.has(String(change?.phase))) { reject("OBSERVER_SCHEMA_INVALID", `Proposed change ${index + 1} has unsupported phase ${String(change?.phase)}`); continue; }
    const text = String(change?.text ?? "").trim();
    if (!text) { reject("OBSERVER_PROPOSAL_EMPTY", `Proposed change ${index + 1} has no text`); continue; }
    const ids = evidenceIds(change?.evidence_ids, allowed, limitations);
    if (!ids.length) { reject("OBSERVER_PROPOSAL_NO_EVIDENCE", `Proposed change ${index + 1} has no valid evidence id`); continue; }
    proposedChanges.push({
      op: change.op as "add" | "update", category: String(change.category) as FactChange["category"],
      text, subjectIds: strings(change?.subject_ids).length ? strings(change.subject_ids) : undefined,
      tags: strings(change?.tags).length ? strings(change.tags) : ["observed-proposal"],
      phase: String(change.phase) as FactChange["phase"], evidenceIds: ids,
    });
  }
  if (!options.allowCanonicalProposals && (Array.isArray(payload.proposed_changes) && payload.proposed_changes.length)) {
    limitations.push("Build mode: all canonical proposals were rejected individually; validated findings remain usable.");
  }
  return {
    comparison: {
      findings: numberedFindings,
      proposedChanges,
      limitations: [...limitations, "Comparison is evidence-backed; absent evidence is never treated as proof of absence."],
      comparedAt: options.comparedAt ?? new Date().toISOString(),
      comparisonPromptVersion: options.comparisonPromptVersion,
      ...(proposalRejections.length ? { rejectedProposals: proposalRejections } : {}),
      ...(findingRejections.length ? { rejectedFindings: findingRejections } : {}),
    },
    proposalRejections,
    findingRejections,
  };
}
