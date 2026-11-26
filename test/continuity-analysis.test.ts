import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyContinuityTransition } from "../server/continuity-analysis.ts";

test("continuity classifier catches deliberate contradictions rather than declaring everything compatible", () => {
  assert.equal(classifyContinuityTransition({ characters: ["daichi"], wetness: "wet", props: { key: "present" } }, { characters: ["daichi"], wetness: "dry", props: { key: "present" } }).classification, "confirmed_contradiction");
  assert.equal(classifyContinuityTransition({ characters: ["daichi"], props: { heart: "present" } }, { characters: ["daichi"], props: { heart: "absent" } }).classification, "confirmed_contradiction");
  assert.equal(classifyContinuityTransition({ characters: ["daichi"], wetness: "unknown", props: { heart: "present" } }, { characters: ["daichi"], wetness: "wet", props: { heart: "present" } }).classification, "insufficient_evidence");
  assert.equal(classifyContinuityTransition({ characters: ["daichi"], location: "bathroom", wetness: "wet" }, { characters: ["daichi"], location: "bedroom", wetness: "wet" }).classification, "plausible_offscreen_transition");
  assert.equal(classifyContinuityTransition({ characters: ["daichi"], wetness: "wet", props: { heart: "present" } }, { characters: ["daichi"], wetness: "wet", props: { heart: "present" } }).classification, "compatible");
});

test("missing prop evidence is not converted into confirmed absence", () => {
  assert.equal(classifyContinuityTransition({ characters: ["daichi"], props: { key: "present" } }, { characters: ["daichi"], props: { key: "unknown" } }).classification, "insufficient_evidence");
});
