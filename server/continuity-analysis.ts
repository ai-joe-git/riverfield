// Deterministic transition checks used by tests and as a guard against a supervisor
// that blindly reports every transition as compatible. They never replace observed
// evidence with the screenplay.
export type ContinuityClassification =
  | "compatible"
  | "confirmed_contradiction"
  | "probable_contradiction"
  | "accepted_deviation_candidate"
  | "plausible_offscreen_transition"
  | "insufficient_evidence";

export type ContinuityStateFixture = {
  characters?: string[];
  location?: string;
  wetness?: "wet" | "dry" | "unknown";
  props?: Record<string, "present" | "absent" | "unknown">;
  /** Evidence-backed prop identity -> condition/form/contents, e.g. glass -> stemmed wine glass with red liquid. */
  propStates?: Record<string, string>;
  wardrobe?: string;
};

export type ContinuityTransition = {
  classification: ContinuityClassification;
  reasons: string[];
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Compare only explicit observed states. Unknown is never converted into absence. */
export function classifyContinuityTransition(from: ContinuityStateFixture, to: ContinuityStateFixture): ContinuityTransition {
  const reasons: string[] = [];
  const fromCharacters = new Set(from.characters ?? []);
  const toCharacters = new Set(to.characters ?? []);
  if (fromCharacters.size && toCharacters.size && ![...fromCharacters].some((id) => toCharacters.has(id))) {
    reasons.push("Both scenes identify known characters, but they are disjoint.");
  }
  if (from.wetness === "wet" && to.wetness === "dry") reasons.push("Explicit wet clothing is followed by an explicit dry state.");
  for (const [name, state] of Object.entries(from.props ?? {})) {
    if (state === "present" && to.props?.[name] === "absent") reasons.push(`Prop ${name} is explicitly present then explicitly absent.`);
  }
  if (reasons.length) return { classification: "confirmed_contradiction", reasons };
  for (const [name, state] of Object.entries(from.propStates ?? {})) {
    const next = to.propStates?.[name];
    if (next && normalize(state) !== normalize(next)) reasons.push(`Prop ${name} changes condition from ${state} to ${next}; this is a possible offscreen prop transition, not a confirmed contradiction.`);
  }
  if (reasons.length) return { classification: "plausible_offscreen_transition", reasons };
  if (from.location && to.location && from.location !== to.location) {
    return { classification: "plausible_offscreen_transition", reasons: [`Location changes from ${from.location} to ${to.location}; transition is not directly observed.`] };
  }
  const unknown = (from.wetness === "unknown" || to.wetness === "unknown")
    || Object.values({ ...(from.props ?? {}), ...(to.props ?? {}) }).includes("unknown")
    || !fromCharacters.size || !toCharacters.size;
  if (unknown) return { classification: "insufficient_evidence", reasons: ["At least one relevant state is unknown in the sampled evidence."] };
  return { classification: "compatible", reasons: ["No explicit observed contradiction was found."] };
}
