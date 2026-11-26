import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionStore } from "../server/production-store.ts";
import { createHash } from "node:crypto";

const actor = { kind: "human" as const, id: "test-human" };
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function fixture() {
  const out = mkdtempSync(join(tmpdir(), "riverfield-binding-"));
  const store = new ProductionStore(out);
  store.createProduction({ id: "p", title: "P" }, actor, "p");
  store.createSeason("p", { id: "s", number: 1, title: "S" }, actor, "s");
  store.createEpisode("p", { id: "e", seasonId: "s", number: 1, title: "E" }, actor, "e");
  store.createScene("p", { id: "sc03", episodeId: "e", number: 3, title: "3" }, actor, "s3");
  store.createScene("p", { id: "sc04", episodeId: "e", number: 4, title: "4" }, actor, "s4");
  const media = Buffer.from("fake video bytes");
  mkdirSync(join(out, "media"), { recursive: true });
  const path = join(out, "media", "candidate.mp4"); writeFileSync(path, media);
  const sourceHash = hash(media);
  store.registerCandidate("p", {
    id: "candidate", label: "V4", source: "import", outputs: [{ type: "video", file: "candidate.mp4", name: "candidate.mp4", path, hash: sourceHash }],
    bindings: [{ id: "b001", sceneId: "sc03", segmentIndex: 0, timelineStartFrame: 0, timelineEndFrame: 362 }],
  }, actor, "candidate");
  return { out, store, sourceHash };
}

test("binding correction is append-only and activeBindings suppresses the original association", () => {
  const { out, store, sourceHash } = fixture();
  try {
    const before = store.snapshot("p");
    assert.equal(before.bindings.candidate?.[0]?.sceneId, "sc03");
    const after = store.correctBinding("p", {
      candidateId: "candidate", originalBindingId: "b001", correctedSceneId: "sc04", sourceHash,
      reason: "narrative correction", sources: ["test"],
    }, actor, "correct");
    assert.equal(after.revision, 0);
    assert.equal(after.bindings.candidate?.[0]?.sceneId, "sc03", "historical binding is unchanged");
    assert.equal(after.bindingCorrections.length, 1);
    const active = store.activeBindings("p", "candidate");
    assert.equal(active.length, 1);
    assert.equal(active[0]?.sceneId, "sc04");
    assert.equal(active[0]?.timelineStartFrame, 0);
    assert.equal(active[0]?.timelineEndFrame, 362);
    assert.throws(() => store.correctBinding("p", {
      candidateId: "candidate", originalBindingId: "b001", correctedSceneId: "sc04", sourceHash, reason: "duplicate",
    }, actor, "correct-2"), /already has an active correction/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
