// Production-independent planning for the continuity supervisor. This module is pure:
// it resolves a review scope, validates an explicit deterministic baseline, selects
// bounded evidence and builds compact model context. It never starts inference.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  ContinuityReview, ObservationEvidence, ProductionSnapshot, SceneRenderBinding,
} from "./production-types.ts";
import { deriveObservedState, type ObservedStateRecord } from "./observed-state.ts";
import { auditAssetCatalogue } from "./asset-audit.ts";

export type ContinuityPlanOptions = {
  preparedReviewId: string;
  baselineReviewId: string;
  maxImages?: number;
  verifyFiles?: boolean;
  humanAuditFindings?: unknown[];
};
export type BaselineFinding = {
  id: string;
  summary: string;
  classification?: string;
  scenes: string[];
  evidenceReferences: string[];
  raw: Record<string, unknown>;
};
export type BaselineSelection = {
  review: ContinuityReview;
  contentHash: string;
  findings: BaselineFinding[];
  rawFindingCount: number;
};
export type SelectedScene = {
  sceneId: string;
  order: number;
  alias: string;
  sceneTitle: string;
  candidateId: string;
  candidateAlias: string;
  bindingIds: string[];
  bindingAliases: string[];
  observationId: string;
  observationRevision: number;
  sourceHash: string;
  transcriptText: string;
  transcriptUtterances: { text: string; startSeconds?: number; endSeconds?: number; evidenceIds: string[] }[];
  state: ObservedStateRecord;
};
export type EvidenceSelection = {
  alias: string;
  observationAlias: string;
  observationId: string;
  evidenceId: string;
  kind: string;
  label: string;
  path: string;
  originalHash: string;
  derivativePath?: string;
  derivativeHash?: string;
  frame?: number;
  timestampSeconds?: number;
  shotId?: string;
  reason: string;
};
export type AudioSelection = {
  alias: string;
  observationAlias: string;
  observationId: string;
  evidenceId: string;
  label: string;
  path: string;
  hash: string;
};
export type ContinuityBatch = {
  id: string;
  sceneAliases: string[];
  sceneIds: string[];
  transitionAliases: [string, string][];
  baselineFindingIds: string[];
  images: EvidenceSelection[];
  audio: AudioSelection[];
  missingEvidence: string[];
};
export type ReferenceWarning = {
  sourceSceneAlias: string;
  observationId: string;
  assetId: string;
  currentLabel: string;
  proposedLabel: string;
  reason: string;
  status: string;
};
export type ContinuityPlan = {
  productionId: string;
  prepared: ContinuityReview;
  baseline: BaselineSelection;
  scenes: SelectedScene[];
  batches: ContinuityBatch[];
  referenceWarnings: ReferenceWarning[];
  stateRecords: ObservedStateRecord[];
  maxImages: number;
  baselineFindingsCount: number;
  baselineContentHash: string;
  humanAuditFindings: unknown[];
};

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const baselineId = (finding: any, index: number) => String(finding?.id ?? `baseline-${String(index + 1).padStart(3, "0")}`);
const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const unique = <T>(values: T[]) => [...new Set(values)];

export function resolveActiveBindings(snapshot: ProductionSnapshot, candidateId: string): SceneRenderBinding[] {
  const originals = snapshot.bindings[candidateId] ?? [];
  const corrections = (snapshot.bindingCorrections ?? []).filter((item) => item.candidateId === candidateId);
  const superseded = new Set(corrections.map((item) => item.originalBindingId));
  const active = originals.filter((binding) => !superseded.has(binding.id));
  for (const correction of corrections) {
    const original = originals.find((binding) => binding.id === correction.originalBindingId);
    if (!original) continue;
    active.push({
      ...original, id: correction.correctedBindingId, sceneId: correction.correctedSceneId,
      timelineStartFrame: correction.timelineStartFrame, timelineEndFrame: correction.timelineEndFrame,
      outputHash: correction.sourceHash,
    });
  }
  return active.sort((a, b) => a.timelineStartFrame - b.timelineStartFrame || a.id.localeCompare(b.id));
}

function collectRefs(value: any, out: string[] = []): string[] {
  if (typeof value === "string" && /^[0-9a-f-]{8,}:[A-Za-z0-9._-]+$/.test(value)) out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectRefs(item, out);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (["evidence", "evidenceReferences", "closingEvidence", "openingEvidence", "evidenceIds"].includes(key)) collectRefs(item, out);
    else if (key === "evidence" && typeof item === "string") collectRefs(item, out);
  }
  return out;
}
function normalizeBaselineFinding(finding: any, index: number): BaselineFinding {
  const scenes = Array.isArray(finding?.scenes) ? finding.scenes.map(String) : [finding?.from, finding?.to].filter(Boolean).map(String);
  return {
    id: baselineId(finding, index),
    summary: String(finding?.summary ?? finding?.description ?? finding?.reason ?? finding?.note ?? `baseline finding ${index + 1}`),
    ...(finding?.classification ? { classification: String(finding.classification) } : {}),
    scenes,
    evidenceReferences: unique(collectRefs(finding)),
    raw: finding && typeof finding === "object" ? finding as Record<string, unknown> : { value: finding },
  };
}
function baselineHash(review: ContinuityReview): string {
  return sha256(json({
    id: review.id, productionId: review.productionId, seasonId: review.seasonId ?? null, episodeId: review.episodeId ?? null,
    sceneIds: review.sceneIds, bindingIds: [...review.bindingIds].sort(), candidateIds: [...review.candidateIds].sort(),
    observations: [...review.observations].sort((a, b) => a.observationId.localeCompare(b.observationId)),
    canonicalRevision: review.canonicalRevision, findings: review.findings,
  }));
}
function invalid(code: string, message: string): never { throw new Error(`${code}: ${message}`); }
function orderedScenes(snapshot: ProductionSnapshot, prepared: ContinuityReview): SelectedScene[] {
  const sceneOrder = new Map(snapshot.scenes.map((scene, index) => [scene.id, index]));
  const requested = new Set(prepared.sceneIds);
  const ordered = [...prepared.sceneIds].sort((a, b) => (sceneOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (sceneOrder.get(b) ?? Number.MAX_SAFE_INTEGER));
  if (ordered.length !== requested.size) invalid("SENIOR_SCOPE_DUPLICATE_SCENE", "Review scene list contains duplicates");
  const observations = new Map(prepared.observations.map((item) => [item.sceneId, item]));
  return ordered.map((sceneId, index) => {
    const observation = observations.get(sceneId);
    if (!observation) invalid("SENIOR_SCOPE_OBSERVATION_MISSING", `No observation selected for ${sceneId}`);
    const scene = snapshot.scenes.find((item) => item.id === sceneId);
    if (!scene) invalid("SENIOR_SCOPE_SCENE_MISSING", `Unknown scene ${sceneId}`);
    const candidates = prepared.candidateIds.filter((candidateId) => resolveActiveBindings(snapshot, candidateId).some((binding) => binding.sceneId === sceneId));
    const candidateId = candidates[0] ?? snapshot.observations[observation.observationId]?.candidateId;
    if (!candidateId) invalid("SENIOR_SCOPE_CANDIDATE_MISSING", `No active candidate for ${sceneId}`);
    const bindings = resolveActiveBindings(snapshot, candidateId).filter((binding) => binding.sceneId === sceneId);
    if (!bindings.length) invalid("SENIOR_SCOPE_BINDING_MISSING", `No active binding for ${candidateId} in ${sceneId}`);
    const source = snapshot.observations[observation.observationId];
    if (!source?.report) invalid("SENIOR_SCOPE_OBSERVATION_MISSING", `No structured observation ${observation.observationId}`);
    const report = source.report;
    if (report.reportVersion !== observation.revision || report.sourceOutputHash !== observation.sourceHash) invalid("SENIOR_SCOPE_OBSERVATION_MISMATCH", `Observation ${observation.observationId} no longer matches its recorded revision/hash`);
    if (source.sceneId !== sceneId || report.sceneId !== sceneId) invalid("SENIOR_SCOPE_OBSERVATION_SCENE_MISMATCH", `Observation ${observation.observationId} belongs to a different scene`);
    if (source.candidateId !== candidateId || report.candidateId !== candidateId) invalid("SENIOR_SCOPE_OBSERVATION_CANDIDATE_MISMATCH", `Observation ${observation.observationId} belongs to a different candidate`);
    if (!bindings.every((binding) => report.bindingIds.includes(binding.id))) invalid("SENIOR_SCOPE_OBSERVATION_BINDING_MISMATCH", `Observation ${observation.observationId} does not cover the selected active binding range`);
    return {
      sceneId, order: index + 1, alias: `S${String(index + 1).padStart(2, "0")}`, sceneTitle: scene.title,
      candidateId, candidateAlias: `C${String(index + 1).padStart(2, "0")}`,
      bindingIds: bindings.map((binding) => binding.id), bindingAliases: bindings.map((_, bindingIndex) => `AB${index + 1}.${bindingIndex + 1}`),
      observationId: observation.observationId, observationRevision: observation.revision, sourceHash: observation.sourceHash,
      transcriptText: report.dialogue?.rawTranscript ?? report.dialogue?.text ?? "",
      transcriptUtterances: (report.dialogue?.utterances ?? []).map((utterance) => ({ text: utterance.text, ...(utterance.startSeconds !== undefined ? { startSeconds: utterance.startSeconds } : {}), ...(utterance.endSeconds !== undefined ? { endSeconds: utterance.endSeconds } : {}), evidenceIds: utterance.evidenceIds })),
      state: deriveObservedState(observation.observationId, report),
    };
  });
}
function validateBaseline(snapshot: ProductionSnapshot, prepared: ContinuityReview, scenes: SelectedScene[], baseline: ContinuityReview | undefined): BaselineSelection {
  if (!baseline) invalid("SENIOR_BASELINE_MISSING", "An explicit deterministic baseline is required");
  if (baseline.reviewer.kind !== "deterministic") invalid("SENIOR_BASELINE_NOT_DETERMINISTIC", `Baseline ${baseline.id} is not deterministic`);
  if (baseline.productionId !== snapshot.production.id) invalid("SENIOR_BASELINE_PRODUCTION_MISMATCH", "Baseline belongs to another production");
  if (prepared.episodeId && baseline.episodeId !== prepared.episodeId) invalid("SENIOR_BASELINE_EPISODE_MISMATCH", "Baseline belongs to another episode");
  if (prepared.seasonId && baseline.seasonId !== prepared.seasonId) invalid("SENIOR_BASELINE_SEASON_MISMATCH", "Baseline belongs to another season");
  if (json(baseline.sceneIds) !== json(prepared.sceneIds)) invalid("SENIOR_BASELINE_SCOPE_MISMATCH", "Baseline scene range differs from the selected review");
  if (baseline.canonicalRevision !== snapshot.revision) invalid("SENIOR_BASELINE_CANONICAL_MISMATCH", "Baseline canonical revision is stale");
  const expectedCandidates = unique(scenes.map((scene) => scene.candidateId)).sort();
  if (json([...baseline.candidateIds].sort()) !== json(expectedCandidates)) invalid("SENIOR_BASELINE_CANDIDATE_MISMATCH", "Baseline candidates differ from active candidates");
  const expectedBindings = unique(scenes.flatMap((scene) => scene.bindingIds)).sort();
  if (json([...baseline.bindingIds].sort()) !== json(expectedBindings)) invalid("SENIOR_BASELINE_BINDING_MISMATCH", "Baseline bindings differ from active bindings; missing binding scope is not accepted");
  const expectedObs = scenes.map((scene) => `${scene.observationId}@${scene.observationRevision}:${scene.sourceHash}`).sort();
  const actualObs = baseline.observations.map((item) => `${item.observationId}@${item.revision}:${item.sourceHash}`).sort();
  if (json(expectedObs) !== json(actualObs)) invalid("SENIOR_BASELINE_OBSERVATION_MISMATCH", "Baseline observation revisions/hashes differ");
  const findings = baseline.findings.map(normalizeBaselineFinding);
  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) invalid("SENIOR_BASELINE_DUPLICATE_FINDING", "Baseline finding ids are not unique");
  return { review: baseline, contentHash: baselineHash(baseline), findings, rawFindingCount: baseline.findings.length };
}
export function planTransitionBatches(scenes: SelectedScene[], maxImages = 9): ContinuityBatch[] {
  if (scenes.length < 2) invalid("SENIOR_SCOPE_TOO_SMALL", "At least two ordered scenes are required for a transition review");
  if (maxImages < 4) invalid("SENIOR_IMAGE_CAPACITY", "At least four image slots are required");
  const maxScenes = Math.max(2, Math.min(4, Math.floor((maxImages - 1) / 2)));
  const batches: ContinuityBatch[] = [];
  for (let start = 0; start < scenes.length; start += maxScenes - 1) {
    const end = Math.min(scenes.length, start + maxScenes);
    if (end - start < 2) break;
    const slice = scenes.slice(start, end);
    batches.push({
      id: `batch-${String(batches.length + 1).padStart(2, "0")}`,
      sceneAliases: slice.map((scene) => scene.alias), sceneIds: slice.map((scene) => scene.sceneId),
      transitionAliases: slice.slice(0, -1).map((scene, index) => [scene.alias, slice[index + 1].alias]),
      baselineFindingIds: [], images: [], audio: [], missingEvidence: [],
    });
    if (end === scenes.length) break;
  }
  return batches;
}
function evidenceAt(snapshot: ProductionSnapshot, ref: string): Omit<EvidenceSelection, "alias" | "reason" | "observationAlias"> | undefined {
  const [observationId, evidenceId] = ref.split(":");
  const report = snapshot.observations[observationId]?.report;
  if (!report) return undefined;
  const evidence = report.evidence.find((item) => item.id === evidenceId);
  if (!evidence?.path) return undefined;
  const derivative = (report.analysisImages ?? []).find((image) => image.evidenceId === evidenceId);
  const originalHash = evidence.hash ?? sha256(readFileSync(evidence.path));
  return {
    observationId, evidenceId, kind: evidence.kind, path: evidence.path,
    originalHash,
    ...(derivative ? { derivativePath: derivative.derivativePath, derivativeHash: derivative.derivativeHash } : {}),
    ...(evidence.frame !== undefined ? { frame: evidence.frame } : {}),
    ...(evidence.timestampSeconds !== undefined ? { timestampSeconds: evidence.timestampSeconds } : {}),
    ...(evidence.shotId ? { shotId: evidence.shotId } : {}),
    label: derivative?.label ?? `${evidence.kind}:${evidenceId}`,
  };
}
function firstRef(values: any[]): string | undefined {
  for (const value of values) if (Array.isArray(value?.evidenceReferences) && value.evidenceReferences.length) return value.evidenceReferences[0];
  return undefined;
}
function selectEvidence(snapshot: ProductionSnapshot, batch: ContinuityBatch, scenes: SelectedScene[], baseline: BaselineSelection, maxImages: number, verifyFiles: boolean): void {
  const byScene = new Map(scenes.map((scene) => [scene.alias, scene]));
  const candidates: { ref: string; sceneAlias: string; reason: string; priority: number }[] = [];
  for (const scene of scenes.filter((item) => batch.sceneAliases.includes(item.alias))) {
    const openRef = firstRef(Object.values(scene.state.opening).flat());
    const closeRef = firstRef(Object.values(scene.state.closing).flat());
    if (openRef) candidates.push({ ref: openRef, sceneAlias: scene.alias, reason: "opening boundary", priority: 0 });
    if (closeRef) candidates.push({ ref: closeRef, sceneAlias: scene.alias, reason: "closing boundary", priority: 1 });
    for (const finding of baseline.findings) {
      if (!finding.scenes.length || finding.scenes.some((item) => item === scene.alias || item === scene.sceneId)) {
        for (const ref of finding.evidenceReferences) candidates.push({ ref, sceneAlias: scene.alias, reason: `unresolved baseline ${finding.id}`, priority: 2 });
      }
    }
    for (const event of scene.state.events) {
      const ref = event.evidenceReferences[0];
      if (ref) candidates.push({ ref, sceneAlias: scene.alias, reason: "observed event", priority: 3 });
    }
  }
  const selectedObservations = new Set(scenes.map((scene) => scene.observationId));
  const seen = new Set<string>();
  for (const candidate of candidates.sort((a, b) => a.priority - b.priority)) {
    if (batch.images.length >= maxImages) break;
    if (seen.has(candidate.ref)) continue;
    if (!selectedObservations.has(candidate.ref.split(":")[0])) continue;
    const evidence = evidenceAt(snapshot, candidate.ref);
    if (!evidence) { batch.missingEvidence.push(candidate.ref); continue; }
    if (evidence.kind === "audio" || evidence.kind === "video") continue;
    if (verifyFiles) {
      const file = evidence.derivativePath ?? evidence.path;
      if (!existsSync(file)) { batch.missingEvidence.push(candidate.ref); continue; }
      const actual = sha256(readFileSync(file));
      const expected = evidence.derivativeHash ?? evidence.originalHash;
      if (actual !== expected) invalid("SENIOR_EVIDENCE_HASH_MISMATCH", `Selected evidence ${candidate.ref} no longer matches its recorded hash`);
    }
    seen.add(candidate.ref);
    const scene = byScene.get(candidate.sceneAlias);
    batch.images.push({ alias: `${batch.id}-${scene?.alias ?? "S"}-${String(batch.images.length + 1).padStart(2, "0")}`, observationAlias: candidate.sceneAlias, ...evidence, reason: candidate.reason });
  }
  if (!batch.images.length) batch.missingEvidence.push("no readable selected evidence");
  for (const scene of scenes.filter((item) => batch.sceneAliases.includes(item.alias))) {
    const report = snapshot.observations[scene.observationId]?.report;
    const audio = report?.evidence.find((item) => item.kind === "audio" && item.path);
    if (!audio?.path) { batch.missingEvidence.push(`${scene.alias}:audio unavailable`); continue; }
    if (verifyFiles && !existsSync(audio.path)) { batch.missingEvidence.push(`${scene.alias}:audio file unavailable`); continue; }
    const actualHash = verifyFiles ? sha256(readFileSync(audio.path)) : (audio.hash ?? `unverified:${audio.id}`);
    if (verifyFiles && audio.hash && actualHash !== audio.hash) invalid("SENIOR_EVIDENCE_HASH_MISMATCH", `Audio evidence ${scene.alias} no longer matches its recorded hash`);
    batch.audio.push({ alias: `${batch.id}-${scene.alias}-AUDIO`, observationAlias: scene.alias, observationId: scene.observationId, evidenceId: audio.id, label: "ASR transcript provenance", path: audio.path, hash: actualHash });
  }
}
function referenceWarnings(snapshot: ProductionSnapshot, scenes: SelectedScene[]): ReferenceWarning[] {
  const audit = auditAssetCatalogue(snapshot);
  const warnings: ReferenceWarning[] = [];
  for (const scene of scenes) {
    const report = snapshot.observations[scene.observationId]?.report;
    const ids = Array.isArray(report?.observer?.configuration?.referenceAssetIds) ? report.observer.configuration.referenceAssetIds.map(String) : [];
    for (const assetId of ids) {
      const entry = audit.find((item) => item.assetId === assetId);
      if (entry && !entry.trusted) warnings.push({ sourceSceneAlias: scene.alias, observationId: scene.observationId, assetId, currentLabel: entry.currentLabel, proposedLabel: entry.proposedLabel, reason: entry.reason, status: entry.status });
    }
  }
  return warnings;
}
export function buildContinuityPlan(snapshot: ProductionSnapshot, options: ContinuityPlanOptions): ContinuityPlan {
  const prepared = snapshot.continuityReviews?.[options.preparedReviewId];
  if (!prepared) invalid("SENIOR_PREPARED_REVIEW_MISSING", `Unknown prepared review ${options.preparedReviewId}`);
  if (prepared.status !== "prepared") invalid("SENIOR_PREPARED_REVIEW_STATUS", `Review ${prepared.id} is ${prepared.status}, not prepared`);
  const scenes = orderedScenes(snapshot, prepared);
  const baselineReview = snapshot.continuityReviews?.[options.baselineReviewId];
  const baseline = validateBaseline(snapshot, prepared, scenes, baselineReview);
  const maxImages = Math.max(4, Math.min(9, options.maxImages ?? 9));
  const batches = planTransitionBatches(scenes, maxImages);
  const assigned = new Set<string>();
  for (const batch of batches) {
    const relevant = baseline.findings.filter((finding) => {
      if (!finding.scenes.length && !finding.evidenceReferences.length) return true;
      if (finding.scenes.some((scene) => batch.sceneAliases.includes(scene) || batch.sceneIds.includes(scene))) return true;
      return finding.evidenceReferences.some((ref) => batch.sceneIds.includes(ref.split(":")[0]));
    });
    batch.baselineFindingIds = relevant.map((finding) => finding.id);
    for (const id of batch.baselineFindingIds) assigned.add(id);
    selectEvidence(snapshot, batch, scenes, baseline, maxImages, options.verifyFiles ?? false);
  }
  for (const finding of baseline.findings) if (!assigned.has(finding.id)) {
    const target = batches.find((batch) => batch.sceneAliases.length) ?? batches[0];
    if (target) target.baselineFindingIds.push(finding.id);
  }
  return { productionId: snapshot.production.id, prepared, baseline, scenes, batches, referenceWarnings: referenceWarnings(snapshot, scenes), stateRecords: scenes.map((scene) => scene.state), maxImages, baselineFindingsCount: baseline.rawFindingCount, baselineContentHash: baseline.contentHash, humanAuditFindings: options.humanAuditFindings ?? [] };
}
// Compact prompt builder uses aliases only. Full provenance remains in plan/artifacts.
export function buildCompactBatchPrompt(plan: ContinuityPlan, batch: ContinuityBatch): { system: string; input: string } {
  const scenes = plan.scenes.filter((scene) => batch.sceneAliases.includes(scene.alias));
  const selected = new Set(batch.images.map((image) => `${image.observationId}:${image.evidenceId}`));
  const sceneState = scenes.map((scene) => ({
    scene: scene.alias, title: scene.sceneTitle, candidate: scene.candidateAlias,
    activeBindings: scene.bindingAliases,
    opening: compactState(scene.state.opening, selected), closing: compactState(scene.state.closing, selected),
    persistent: compactState(scene.state.persistent, selected),
    events: compactState({ events: scene.state.events }, selected).events,
    unknown: scene.state.unknownBoundaryConditions,
  }));
  const sceneIdToAlias = new Map(plan.scenes.flatMap((scene) => [[scene.sceneId, scene.alias], [scene.alias, scene.alias]]));
  const observationToAlias = new Map(plan.scenes.map((scene) => [scene.observationId, scene.alias]));
  const baseline = plan.baseline.findings.filter((finding) => batch.baselineFindingIds.includes(finding.id)).map((finding) => ({
    id: finding.id, summary: finding.summary, classification: finding.classification ?? null,
    scenes: unique([
      ...finding.scenes.map((scene) => sceneIdToAlias.get(scene)).filter((scene): scene is string => Boolean(scene)),
      ...finding.evidenceReferences.map((ref) => observationToAlias.get(ref.split(":")[0])).filter((scene): scene is string => Boolean(scene)),
    ]),
    evidence: finding.evidenceReferences.filter((ref) => selected.has(ref)).map((ref) => batch.images.find((image) => `${image.observationId}:${image.evidenceId}` === ref)?.alias).filter(Boolean),
  }));
  const warnings = plan.referenceWarnings.filter((warning) => batch.sceneAliases.includes(warning.sourceSceneAlias)).map((warning) => ({ scene: warning.sourceSceneAlias, current: warning.currentLabel, proposed: warning.proposedLabel, status: warning.status, reason: warning.reason }));
  const evidence = batch.images.map((image) => ({ alias: image.alias, scene: image.observationAlias, label: image.reason, frame: image.frame ?? null, seconds: image.timestampSeconds ?? null, sha256: image.derivativeHash ?? image.originalHash }));
  const audio = batch.audio.map((item) => ({ alias: item.alias, scene: item.observationAlias, label: item.label, sha256: item.hash, suppliedToModel: false }));
  const transcripts = scenes.map((scene) => ({ scene: scene.alias, text: scene.transcriptText, utterances: scene.transcriptUtterances }));
  const schema = `{"schemaVersion":1,"textBasedOnly":false,"findings":[{"id":"finding-001","category":"continuity|wardrobe|prop|dialogue|event|location|state_correction|reference_integrity|coverage|other","classification":"compatible|confirmed_contradiction|probable_contradiction|accepted_deviation_candidate|plausible_offscreen_transition|insufficient_evidence","scenes":["S01"],"summary":"...","rationale":"...","evidenceAliases":["B01-S01-01"],"confidence":"confirmed|probable|uncertain|not_observable"}],"baselineDispositions":[{"baselineFindingId":"baseline-001","disposition":"confirms|challenges|insufficient_evidence|not_reviewed","reason":"..."}],"correctionPlans":[{"id":"plan-001","action":"keep_existing_candidate|accept_creative_deviation|request_targeted_evidence|request_human_audio_review|request_human_visual_review|correct_asset_association|refine_next_scene_opening|prepare_director_correction|recommend_regeneration","scenes":["S01"],"findingIds":["finding-001"],"summary":"...","rationale":"...","evidenceAliases":["B01-S01-01"],"estimatedScope":"targeted","requiresHumanApproval":true}],"uncertainties":[],"limitations":[],"recommendedDisposition":"keep_existing_candidate"}`;
  return {
    system: "You are a production-independent senior continuity reviewer. Challenge the explicit deterministic baseline with supplied evidence only. A missing sampled view is insufficient evidence, never absence. Distinguish persistent state from intentional change. Dialogue findings need transcript/audio provenance. Do not approve, canonize, regenerate, or create canonical proposals. Return one JSON object only.",
    input: `Transition batch ${batch.id}. Production scope: ${plan.productionId}. Baseline ${plan.baseline.review.id} (${plan.baselineContentHash.slice(0, 16)}…), ${plan.baselineFindingsCount} finding(s) supplied.\n\nScenes and compact states:\n${json(sceneState)}\n\nBaseline findings in this batch:\n${json(baseline)}\n\nReference/asset warnings:\n${json(warnings)}\n\nEvidence aliases (actual supplied images):\n${json(evidence)}\n\nSchema:\n${schema}\n\nEvery baseline finding ID must have exactly one baselineDisposition. Do not invent a disagreement merely to appear independent. Never claim a finding is successful if coverage is missing.`,
  };
}
function compactState(map: Record<string, any[]>, selected: Set<string>): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const [key, values] of Object.entries(map)) {
    const kept = values.filter((item) => !item.evidenceReferences?.length || item.evidenceReferences.some((ref: string) => selected.has(ref)));
    if (kept.length) out[key] = kept.map((item) => ({ description: item.description, confidence: item.confidence, temporalScope: item.temporalScope, ...(item.observedAtSeconds !== undefined ? { seconds: item.observedAtSeconds } : {}) }));
  }
  return out;
}
export function validateSeniorContinuityOutput(raw: any, plan: ContinuityPlan, batch: ContinuityBatch): {
  findings: any[]; dispositions: any[]; correctionPlans: any[]; unreviewedBaselineFindings: string[]; errors: string[]; coverageComplete: boolean;
} {
  const errors: string[] = [];
  const allowedClassifications = new Set(["compatible", "confirmed_contradiction", "probable_contradiction", "accepted_deviation_candidate", "plausible_offscreen_transition", "insufficient_evidence"]);
  const allowedActions = new Set(["keep_existing_candidate", "accept_creative_deviation", "request_targeted_evidence", "request_human_audio_review", "request_human_visual_review", "correct_asset_association", "refine_next_scene_opening", "prepare_director_correction", "recommend_regeneration"]);
  const aliases = new Set([...batch.images.map((image) => image.alias), ...batch.audio.map((audio) => audio.alias)]);
  const baselineById = new Map(plan.baseline.findings.filter((finding) => batch.baselineFindingIds.includes(finding.id)).map((finding) => [finding.id, finding]));
  const findings: any[] = [];
  for (const item of Array.isArray(raw?.findings) ? raw.findings : []) {
    const classification = String(item?.classification ?? "");
    if (!allowedClassifications.has(classification)) { errors.push(`unsupported classification ${classification}`); continue; }
    const evidenceAliases = Array.isArray(item?.evidenceAliases) ? item.evidenceAliases.map(String) : [];
    const unknownAliases = evidenceAliases.filter((alias: string) => !aliases.has(alias));
    if (unknownAliases.length) errors.push(`unknown evidence alias(es): ${unknownAliases.join(", ")}`);
    if (item?.category === "dialogue" && !evidenceAliases.some((alias: string) => batch.audio.some((audio) => audio.alias === alias))) errors.push("dialogue finding without audio/transcript evidence");
    const sceneAliases = Array.isArray(item?.scenes) ? item.scenes.map(String) : [];
    if (sceneAliases.some((scene: string) => !batch.sceneAliases.includes(scene))) errors.push("finding cites a scene outside this batch");
    findings.push({ id: String(item?.id ?? `finding-${findings.length + 1}`), source: "independent_model", category: String(item?.category ?? "other"), classification, scenes: sceneAliases, summary: String(item?.summary ?? ""), rationale: String(item?.rationale ?? ""), evidenceAliases, evidenceReferences: evidenceAliases.map((alias: string) => {
      const image = batch.images.find((item) => item.alias === alias);
      if (image) return `${image.observationId}:${image.evidenceId}`;
      const audio = batch.audio.find((item) => item.alias === alias);
      return audio ? `${audio.observationId}:${audio.evidenceId}` : undefined;
    }).filter(Boolean), confidence: ["confirmed", "probable", "uncertain", "not_observable"].includes(String(item?.confidence)) ? item.confidence : "uncertain" });
  }
  const dispositions = Array.isArray(raw?.baselineDispositions) ? raw.baselineDispositions : [];
  const seen = new Set<string>();
  for (const item of dispositions) {
    const id = String(item?.baselineFindingId ?? "");
    if (!baselineById.has(id)) { errors.push(`unknown baseline finding id ${id || "(missing)"}`); continue; }
    if (seen.has(id)) { errors.push(`duplicate baseline disposition ${id}`); continue; }
    if (!["confirms", "challenges", "insufficient_evidence", "not_reviewed"].includes(String(item?.disposition))) { errors.push(`invalid disposition for ${id}`); continue; }
    if (item?.disposition === "not_reviewed" && !String(item?.reason ?? "").trim()) errors.push(`not_reviewed disposition ${id} needs a reason`);
    seen.add(id);
  }
  const unreviewed = [...baselineById.keys()].filter((id) => !seen.has(id));
  if (unreviewed.length) errors.push(`baseline findings without disposition: ${unreviewed.join(", ")}`);
  const findingIds = new Set(findings.map((finding) => finding.id));
  const correctionPlans = (Array.isArray(raw?.correctionPlans) ? raw.correctionPlans : []).map((item: any, index: number) => {
    const action = String(item?.action ?? "");
    if (!allowedActions.has(action)) errors.push(`unsupported correction action ${action}`);
    const references = Array.isArray(item?.findingIds) ? item.findingIds.map(String) : [];
    if (references.some((id: string) => !findingIds.has(id))) errors.push(`correction plan cites unknown finding`);
    return { id: String(item?.id ?? `plan-${index + 1}`), source: "independent_model", action: allowedActions.has(action) ? action : "request_human_visual_review", scenes: Array.isArray(item?.scenes) ? item.scenes.map(String) : [], findingIds: references, summary: String(item?.summary ?? ""), rationale: String(item?.rationale ?? ""), evidenceAliases: Array.isArray(item?.evidenceAliases) ? item.evidenceAliases.map(String) : [], estimatedScope: String(item?.estimatedScope ?? ""), requiresHumanApproval: true };
  });
  return { findings, dispositions, correctionPlans, unreviewedBaselineFindings: unreviewed, errors, coverageComplete: errors.length === 0 && unreviewed.length === 0 };
}
