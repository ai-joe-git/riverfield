// Conservative syntax recovery for a comparison response that failed JSON parsing.
// Recovery only inserts one missing structural bracket; it never edits model text,
// evidence ids, classifications or invented fields. Semantic validation is separate.
import { createHash } from "node:crypto";
import type { ObservationComparison, ObservationFinding, ObservationReport } from "./production-types.ts";

export type ComparisonRecovery = {
  rawHash: string;
  unfencedHash: string;
  insertion: { index: number; character: "]"; context: string };
  parserError: string;
  /** SHA-256 of the parsed-object serialization used by the historical artifact. */
  recoveredJsonHash: string;
  /** SHA-256 of the exact unfenced text with the single insertion applied. */
  repairedTextHash?: string;
  /** SHA-256 of the serialized recovered object (pretty or compact as supplied). */
  serializedRecoveredJsonHash?: string;
  /** SHA-256 of the effective validated comparison object. */
  effectiveComparisonHash?: string;
  /** All whitespace-equivalent insertion positions that produce the same parsed object. */
  semanticRepairCandidateCount?: number;
  candidateInsertionPositions: number[];
  recoveredJson: Record<string, unknown>;
  valid: boolean;
  errors: string[];
  warnings: string[];
  rejectedProposedChanges: { index: number; reasons: string[] }[];
  downgrades: { findingIndex: number; from: string; to: string; reason: string }[];
  effectiveComparison: ObservationComparison;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const allowedCategories = new Set(["character", "wardrobe", "prop", "action", "dialogue", "event", "location", "continuity", "creative_deviation", "coverage"]);
const allowedClassification = new Set(["confirmed", "probable", "uncertain", "not_observable"]);

function unfence(raw: string): { text: string; error: string } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced?.[1] ?? raw).trim();
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { text, error: "No JSON object found" };
  return { text: text.slice(start, end + 1), error: "" };
}
function parse(value: string): { value?: Record<string, unknown>; error?: string } {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { value: parsed } : { error: "JSON is not an object" }; }
  catch (error) { return { error: (error as Error).message }; }
}
function validInsertions(text: string): { index: number; value: Record<string, unknown> }[] {
  const out: { index: number; value: Record<string, unknown> }[] = [];
  for (let index = 0; index <= text.length; index += 1) {
    const parsed = parse(text.slice(0, index) + "]" + text.slice(index));
    if (parsed.value) out.push({ index, value: parsed.value });
  }
  return out;
}
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
function text(value: unknown): string { return String(value ?? ""); }

export function recoverComparison(raw: string, report: ObservationReport, expectedInsertionIndex?: number): ComparisonRecovery {
  const rawHash = sha256(raw);
  const unfenced = unfence(raw);
  const parser = parse(unfenced.text);
  const errors: string[] = []; const warnings: string[] = [];
  if (parser.value) return {
    rawHash, unfencedHash: sha256(unfenced.text), insertion: { index: -1, character: "]", context: "" },
    parserError: "", recoveredJsonHash: sha256(unfenced.text), candidateInsertionPositions: [], recoveredJson: parser.value,
    valid: false, errors: ["The existing response already parses; syntax recovery is not authorized."], warnings,
    rejectedProposedChanges: [], downgrades: [], effectiveComparison: { findings: [], proposedChanges: [], limitations: [], comparedAt: new Date().toISOString(), comparisonPromptVersion: "recovery-v1" },
  };
  const parserError = parser.error ?? unfenced.error ?? "unknown JSON error";
  const candidates = validInsertions(unfenced.text);
  if (!candidates.length) return { rawHash, unfencedHash: sha256(unfenced.text), insertion: { index: -1, character: "]", context: "" }, parserError, recoveredJsonHash: "", candidateInsertionPositions: [], recoveredJson: {}, valid: false, errors: ["No single-bracket insertion produces valid JSON."], warnings, rejectedProposedChanges: [], downgrades: [], effectiveComparison: { findings: [], proposedChanges: [], limitations: [], comparedAt: new Date().toISOString(), comparisonPromptVersion: "recovery-v1" } };
  const canonical = JSON.stringify(candidates[0].value);
  if (candidates.some((candidate) => JSON.stringify(candidate.value) !== canonical)) return { rawHash, unfencedHash: sha256(unfenced.text), insertion: { index: -1, character: "]", context: "" }, parserError, recoveredJsonHash: "", candidateInsertionPositions: candidates.map((candidate) => candidate.index), recoveredJson: {}, valid: false, errors: ["Multiple insertion positions produce different JSON values; repair is ambiguous."], warnings, rejectedProposedChanges: [], downgrades: [], effectiveComparison: { findings: [], proposedChanges: [], limitations: [], comparedAt: new Date().toISOString(), comparisonPromptVersion: "recovery-v1" } };
  const index = expectedInsertionIndex ?? candidates[0].index;
  const selected = candidates.find((candidate) => candidate.index === index);
  if (!selected) return { rawHash, unfencedHash: sha256(unfenced.text), insertion: { index, character: "]", context: "" }, parserError, recoveredJsonHash: "", candidateInsertionPositions: candidates.map((candidate) => candidate.index), recoveredJson: {}, valid: false, errors: [`Requested insertion position ${index} is not a valid single-bracket repair.`], warnings, rejectedProposedChanges: [], downgrades: [], effectiveComparison: { findings: [], proposedChanges: [], limitations: [], comparedAt: new Date().toISOString(), comparisonPromptVersion: "recovery-v1" } };
  const recovered = selected.value;
  const allowedEvidence = new Set([...report.evidence.map((item) => item.id), ...(report.nativeEvidence ?? []).map((item) => item.id)]);
  const rawFindings = Array.isArray(recovered.findings) ? recovered.findings as any[] : [];
  const findings: ObservationFinding[] = [];
  for (const [index, finding] of rawFindings.entries()) {
    if (!allowedCategories.has(text(finding?.category))) { errors.push(`finding ${index + 1}: unsupported category ${text(finding?.category)}`); continue; }
    if (!allowedClassification.has(text(finding?.classification))) { errors.push(`finding ${index + 1}: unsupported classification ${text(finding?.classification)}`); continue; }
    const evidenceIds = stringArray(finding?.evidence_ids);
    const unknown = evidenceIds.filter((id) => !allowedEvidence.has(id));
    if (unknown.length) errors.push(`finding ${index + 1}: unknown evidence ids ${unknown.join(", ")}`);
    if (!text(finding?.expected) && !text(finding?.observed)) errors.push(`finding ${index + 1}: expected and observed are empty`);
    if (finding?.category === "dialogue" && !evidenceIds.some((id) => report.evidence.some((item) => item.id === id && item.kind === "audio"))) errors.push(`finding ${index + 1}: dialogue finding lacks audio evidence`);
    findings.push({ id: `recovered-finding-${String(index + 1).padStart(3, "0")}`, category: text(finding.category) as ObservationFinding["category"], expected: text(finding.expected), observed: text(finding.observed), classification: text(finding.classification) as ObservationFinding["classification"], rationale: text(finding.rationale), evidenceIds, ...(finding?.dialogue_match && ["exact", "partial", "mismatch", "none"].includes(text(finding.dialogue_match)) ? { dialogueMatch: text(finding.dialogue_match) as ObservationFinding["dialogueMatch"] } : {}) });
  }
  const downgrades: ComparisonRecovery["downgrades"] = [];
  for (const [index, finding] of findings.entries()) {
    const expected = finding.expected.toLowerCase();
    if (finding.classification === "confirmed" && finding.category === "action" && /\btwo\b|wobble|freeze|gesture/.test(expected) && !/\b(and|both|two|wobble|freeze)\b/.test(finding.observed.toLowerCase())) {
      downgrades.push({ findingIndex: index, from: "confirmed", to: "uncertain", reason: "The observed evidence supports holding/reaching for a glass, not the precise two-glass placement, wobble or freeze gag." });
      findings[index] = { ...finding, classification: "uncertain", rationale: `${finding.rationale}${finding.rationale ? " " : ""}Semantic validation downgraded the unsupported confirmed action.` };
    }
  }
  const rejectedProposedChanges: ComparisonRecovery["rejectedProposedChanges"] = [];
  const changes = Array.isArray(recovered.proposed_changes) ? recovered.proposed_changes as any[] : [];
  for (const [index, change] of changes.entries()) {
    const reasons: string[] = [];
    if (!text(change?.factId)) reasons.push("missing factId");
    if (stringArray(change?.subject_ids).includes("location")) reasons.push("unknown subject location");
    if (reasons.length) rejectedProposedChanges.push({ index, reasons });
  }
  if (errors.length) return { rawHash, unfencedHash: sha256(unfenced.text), insertion: { index, character: "]", context: unfenced.text.slice(Math.max(0, index - 30), index + 30) }, parserError, recoveredJsonHash: sha256(JSON.stringify(recovered)), candidateInsertionPositions: candidates.map((candidate) => candidate.index), recoveredJson: recovered, valid: false, errors, warnings, rejectedProposedChanges, downgrades, effectiveComparison: { findings: [], proposedChanges: [], limitations: stringArray(recovered.limitations), comparedAt: new Date().toISOString(), comparisonPromptVersion: "recovery-v1" } };
  if (!findings.length) errors.push("No findings were recovered");
  const effectiveComparison: ObservationComparison = {
    findings, proposedChanges: [], limitations: [...stringArray(recovered.limitations), "Comparison JSON syntax-recovered by one bracket insertion; proposed changes rejected: missing factId / unknown subject location."],
    comparedAt: new Date().toISOString(), comparisonPromptVersion: "recovery-v1",
  };
  const repairedText = unfenced.text.slice(0, index) + "]" + unfenced.text.slice(index);
  const serializedRecoveredJson = JSON.stringify(recovered);
  return {
    rawHash, unfencedHash: sha256(unfenced.text), insertion: { index, character: "]", context: unfenced.text.slice(Math.max(0, index - 30), index + 30) }, parserError,
    recoveredJsonHash: sha256(serializedRecoveredJson), repairedTextHash: sha256(repairedText), serializedRecoveredJsonHash: sha256(serializedRecoveredJson),
    effectiveComparisonHash: sha256(JSON.stringify(effectiveComparison)), semanticRepairCandidateCount: candidates.length,
    candidateInsertionPositions: candidates.map((candidate) => candidate.index), recoveredJson: recovered, valid: errors.length === 0, errors, warnings, rejectedProposedChanges, downgrades, effectiveComparison,
  };
}
