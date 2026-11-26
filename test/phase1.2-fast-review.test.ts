import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const file = "out/observations/phase1.2-fast-review-request.json";

test("the prepared Fast Review benchmark uses the exact Velvet Moon inputs", { skip: !existsSync(file) }, () => {
  const request = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(request.profile, "fast");
  assert.equal(request.sceneId, "suite-404-s01e02-sc01");
  assert.equal(request.candidateId, "suite404-20261126-144117031-d4dc");
  assert.deepEqual(request.bindingIds, ["suite404-20261126-144117031-d4dc-b001"]);
  assert.deepEqual(request.referenceAssetIds, ["suite404-official-akari-character-sheet", "suite404-official-daichi-character-sheet"]);
  assert.equal(request.options.visualModel, "gemma4-12b-heretic-w4a8");
  assert.equal(request.options.comparisonModel, "gemma4-12b-heretic-w4a8");
  assert.equal(request.options.visualFrames, 7);
  assert.equal(request.options.nativeVideo, false);
  assert.equal(request.options.nativeAudio, false);
  assert.equal(request.approvalRequired, true);
});
