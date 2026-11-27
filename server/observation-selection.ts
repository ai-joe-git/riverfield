// Deterministic observation selection for run-scoped Director context. No inference.
import { createHash } from "node:crypto";
import type { Observation, ProductionRunScene, ProductionSnapshot } from "./production-types.ts";

export class ObservationSelectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = "ObservationSelectionError"; }
}

export type ResolvedObservation = {
  observation: Observation;
  report: NonNullable<Observation["report"]>;
  revision: number;
  sourceHash: string;
  selection: "accepted-latest" | "human-selected";
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function contextHash(value: unknown): string { return hash(value); }

/**
 * Select the exact observation revision used for run-scoped memory.
 * The latest revision is the default. An older revision is accepted only when the
 * user explicitly selected it; otherwise a superseded revision is rejected.
 */
export function resolveAcceptedObservation(
  snapshot: ProductionSnapshot,
  scene: ProductionRunScene,
  explicitObservationId?: string,
): ResolvedObservation {
  const ids = [...scene.observationIds];
  if (!ids.length) throw new ObservationSelectionError("OBSERVATION_SELECTION_MISSING", `Scene ${scene.sceneId} has no observation to accept`);
  const explicit = explicitObservationId?.trim();
  const selectedId = explicit || scene.acceptedObservation?.observationId || ids.at(-1)!;
  if (!ids.includes(selectedId)) throw new ObservationSelectionError("OBSERVATION_SELECTION_UNKNOWN", `Observation ${selectedId} is not recorded for scene ${scene.sceneId}`);
  const observation = snapshot.observations[selectedId];
  if (!observation?.report) throw new ObservationSelectionError("OBSERVATION_SELECTION_UNREPORTED", `Observation ${selectedId} has no structured report`);
  const report = observation.report;
  if (report.reportVersion !== observation.revision) throw new ObservationSelectionError("OBSERVATION_SELECTION_REVISION_MISMATCH", `Observation ${selectedId} revision does not match its report`);
  if (report.failure) throw new ObservationSelectionError("OBSERVATION_SELECTION_INCOMPLETE", `Observation ${selectedId} is incomplete and cannot be accepted without a recovered successor`);
  if (explicit) return { observation, report, revision: report.reportVersion, sourceHash: report.sourceOutputHash, selection: "human-selected" };
  if (scene.acceptedObservation && scene.acceptedObservation.selection !== "human-selected" && selectedId !== ids.at(-1)) {
    throw new ObservationSelectionError("OBSERVATION_SELECTION_SUPERSEDED", `Observation ${selectedId} was superseded by ${ids.at(-1)}; select it explicitly to override`);
  }
  return {
    observation, report, revision: report.reportVersion, sourceHash: report.sourceOutputHash,
    selection: scene.acceptedObservation?.selection ?? (explicit ? "human-selected" : "accepted-latest"),
  };
}
