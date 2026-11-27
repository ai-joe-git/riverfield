import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAcceptedObservation, ObservationSelectionError } from "../server/observation-selection.ts";
import { deriveObservedState, propFamily, propState } from "../server/observed-state.ts";
import { classifyContinuityTransition } from "../server/continuity-analysis.ts";

const snapshot = JSON.parse(readFileSync("out/productions/suite-404/snapshot.json", "utf8"));
const run = snapshot.productionRuns["phase3-suite404-pilot-001"];

test("the accepted pilot observation is the recovered revision 2, not the failed original", () => {
  const scene = run.scenePlan[0];
  const selected = resolveAcceptedObservation(snapshot, scene);
  assert.equal(selected.observation.id, "7e975d52-7f9e-4b52-afa9-6acebefa5ec9-recovered-r2");
  assert.equal(selected.revision, 2);
  assert.equal(selected.sourceHash, "f97b464bc4ee9167a885f0c28d04a95440db8e69366ef591dfc82bbb7727c7b8");
});

test("a stale accepted revision is rejected unless the human explicitly selects it", () => {
  const scene = structuredClone(run.scenePlan[0]);
  scene.observationIds = [
    "7e975d52-7f9e-4b52-afa9-6acebefa5ec9",
    "7e975d52-7f9e-4b52-afa9-6acebefa5ec9-recovered-r2",
  ];
  scene.acceptedObservation = {
    observationId: "7e975d52-7f9e-4b52-afa9-6acebefa5ec9",
    revision: 1,
    sourceHash: "f97b464bc4ee9167a885f0c28d04a95440db8e69366ef591dfc82bbb7727c7b8",
    selection: "accepted-latest",
    selectedAt: new Date().toISOString(),
    selectedBy: "test",
  };
  assert.throws(() => resolveAcceptedObservation(snapshot, scene), (error: unknown) => error instanceof ObservationSelectionError && error.code === "OBSERVATION_SELECTION_INCOMPLETE");
});

test("the pilot boundary states carry evidence-backed glasses and no unrelated key-fob/heart uncertainty", () => {
  const first = snapshot.observations[run.scenePlan[0].observationIds.at(-1)];
  const second = snapshot.observations[run.scenePlan[1].observationIds.at(-1)];
  const a = deriveObservedState(first.id, first.report);
  const b = deriveObservedState(second.id, second.report);
  assert.ok(a.closing.prop_presence_possession_condition.some((item: any) => /glass/i.test(item.description) && /light-colored/i.test(item.description)));
  assert.ok(b.opening.prop_presence_possession_condition.some((item: any) => /wine glass/i.test(item.description) && /red liquid/i.test(item.description)));
  assert.equal(a.unknown.some((item) => /key_fob|heart_not_sampled/.test(item)), false);
  assert.equal(b.unknown.some((item) => /key_fob|heart_not_sampled/.test(item)), false);
  const from = { characters: [], props: { glass: "present" as const }, propStates: { glass: propState(a.closing.prop_presence_possession_condition.find((item: any) => /glass/i.test(item.description))!.description) } };
  const to = { characters: [], props: { glass: "present" as const }, propStates: { glass: propState(b.opening.prop_presence_possession_condition.find((item: any) => /wine glass/i.test(item.description))!.description) } };
  const transition = classifyContinuityTransition(from, to);
  assert.equal(propFamily("A glass containing a light-colored liquid."), "glass");
  assert.equal(transition.classification, "plausible_offscreen_transition");
  assert.match(transition.reasons.join(" "), /possible offscreen prop transition, not a confirmed contradiction/i);
});
