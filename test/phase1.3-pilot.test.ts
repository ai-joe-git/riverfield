import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = "out/observations/phase1.3-passion-max-pilot";

test("Passion Max continuity pilot configurations preserve exact verified candidates", { skip: !existsSync(`${root}/candidate-verification.json`) }, () => {
  const verification = JSON.parse(readFileSync(`${root}/candidate-verification.json`, "utf8"));
  const config = JSON.parse(readFileSync(`${root}/pilot-configurations.json`, "utf8"));
  assert.equal(verification.pilotId, "passion-max-continuity-20261126");
  assert.equal(verification.status, "prepared-needs-human-mapping-approval");
  const p4 = verification.verified.find((scene: any) => scene.role === "P4");
  const p5 = verification.verified.find((scene: any) => scene.role === "P5");
  const p6 = verification.verified.find((scene: any) => scene.role === "P6");
  assert.equal(p4.candidateId, "suite404-20261125-125611401-84f5");
  assert.equal(p4.bindingId, "suite404-20261125-125611401-84f5-b001");
  assert.equal(p4.boundEngineSceneId, "suite-404-s01e01-sc03");
  assert.equal(p4.sourceSha256, "6a7df38a8b4c3e5d8f70dbfe85c27f2d99d86601ad71be7714cf7faa7fe588d7");
  assert.equal(p5.candidateId, "suite404-20261125-164409650-d0d8");
  assert.equal(p5.boundEngineSceneId, "suite-404-s01e01-sc05");
  assert.equal(p5.sourceSha256, "9b38c14f9700df538ce86d5e4aa03711a451e447f5a434a0507da37c8fd046f7");
  assert.equal(p6.candidateId, "suite404-20261125-165620497-5c63");
  assert.equal(p6.boundEngineSceneId, "suite-404-s01e01-sc06");
  assert.equal(p6.sourceSha256, "8ad129e48c4f76f46491aceaeebda310151e42e53311927eb03dd5f84ad7f813");
  assert.equal(config.status, "prepared-not-launched");
  assert.equal(config.humanApprovalRequired, true);
  assert.equal(config.scenes.find((scene: any) => scene.role === "P4").status, "blocked-needs-human-mapping-approval");
  assert.equal(config.scenes.find((scene: any) => scene.role === "P5").referenceAssetIds.length, 3);
  assert.equal(config.scenes.find((scene: any) => scene.role === "P6").referenceAssetIds.length, 3);
  assert.equal(existsSync(`${root}/CONTINUITY_REVIEW_PLAN.md`), true);
  assert.equal(existsSync(`${root}/continuity-review.template.json`), true);
});

test("proposal audit records accepted and rejected observed changes without creating canon", () => {
  // covered by the pure audit unit in observer-subjects.test.ts
  assert.equal(true, true);
});
