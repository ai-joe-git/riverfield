import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionStore } from "../server/production-store.ts";
import { buildProductionSubjects, validateObservedProposals } from "../server/observer-subjects.ts";
import type { FactChange } from "../server/production-types.ts";

const actor = { kind: "agent" as const, id: "subject-test" };

function snapshot() {
  const dir = mkdtempSync(join(tmpdir(), "riverfield-subjects-"));
  const store = new ProductionStore(dir);
  store.createProduction({ id: "p", title: "Production" }, actor, "p");
  store.createSeason("p", { id: "season", number: 1, title: "S" }, actor, "s");
  store.createEpisode("p", { id: "episode", seasonId: "season", number: 1, title: "E" }, actor, "e");
  store.createScene("p", { id: "scene", episodeId: "episode", number: 1, title: "Scene", characterIds: ["akari"] }, actor, "scene");
  return { dir, snap: store.snapshot("p") };
}

test("subject registry resolves stable scene and character ids", () => {
  const { dir, snap } = snapshot();
  try {
    const subjects = buildProductionSubjects(snap, "scene");
    assert.ok(subjects.some((subject) => subject.id === "akari" && subject.type === "character"));
    assert.ok(subjects.some((subject) => subject.id === "scene" && subject.type === "scene"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("proposal validation rejects unknown subjects, invalid evidence and invalid updates", () => {
  const { dir, snap } = snapshot();
  try {
    const base = { op: "add" as const, category: "state" as const, text: "Akari stands by the bar.", evidenceIds: ["frame-0001"] };
    const valid = validateObservedProposals({ changes: [base], snapshot: snap, sceneId: "scene", allowedEvidence: new Set(["frame-0001"]) });
    assert.deepEqual(valid.changes[0]?.subjectIds, ["scene"]);
    assert.throws(() => validateObservedProposals({
      changes: [{ ...base, subjectIds: ["S1"] }], snapshot: snap, sceneId: "scene", allowedEvidence: new Set(["frame-0001"]),
    }), /Unknown production subject/);
    assert.throws(() => validateObservedProposals({
      changes: [{ ...base, evidenceIds: ["frame-9999"] }], snapshot: snap, sceneId: "scene", allowedEvidence: new Set(["frame-0001"]),
    }), /evidence not supplied/);
    assert.throws(() => validateObservedProposals({
      changes: [{ ...base, op: "update", category: "state" }], snapshot: snap, sceneId: "scene", allowedEvidence: new Set(["frame-0001"]),
    }), /no factId/);
    assert.throws(() => validateObservedProposals({
      changes: [{ ...base, op: "update", factId: "missing", category: "state" }], snapshot: snap, sceneId: "scene", allowedEvidence: new Set(["frame-0001"]),
    }), /unknown canonical fact/);
    assert.throws(() => validateObservedProposals({
      changes: [{ ...base, factId: "some-fact" } as FactChange], snapshot: snap, sceneId: "scene", allowedEvidence: new Set(["frame-0001"]),
    }), /must not carry a factId/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
