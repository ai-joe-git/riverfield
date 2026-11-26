import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaSecurityError, hashFile, probeMedia, productionMediaRoots, resolveMediaPath } from "../server/production-media.ts";
import { ProductionStore, ProductionError } from "../server/production-store.ts";

const actor = { kind: "agent" as const, id: "media-test" };

test("production media rejects outside roots, symlinks, unsupported files and missing files", () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-media-"));
  const outside = mkdtempSync(join(tmpdir(), "riverfield-outside-"));
  try {
    const media = join(out, "media");
    mkdirSync(media, { recursive: true });
    const image = join(media, "safe.png");
    writeFileSync(image, Buffer.from("image"));
    const roots = productionMediaRoots(out);
    assert.equal(resolveMediaPath(image, roots), image);
    const outsideFile = join(outside, "secret.png");
    writeFileSync(outsideFile, Buffer.from("secret"));
    assert.throws(() => resolveMediaPath(outsideFile, roots), (error: unknown) => error instanceof MediaSecurityError && error.code === "MEDIA_OUTSIDE_ROOT");
    const link = join(media, "link.png");
    symlinkSync(outsideFile, link);
    assert.throws(() => resolveMediaPath(link, roots), (error: unknown) => error instanceof MediaSecurityError && (error.code === "SYMLINK_MEDIA" || error.code === "MEDIA_OUTSIDE_ROOT"));
    const text = join(media, "notes.txt");
    writeFileSync(text, "not media");
    assert.throws(() => resolveMediaPath(text, roots), (error: unknown) => error instanceof MediaSecurityError && error.code === "UNSUPPORTED_MEDIA");
    assert.throws(() => resolveMediaPath(join(media, "missing.png"), roots), (error: unknown) => error instanceof MediaSecurityError && error.code === "MISSING_MEDIA");
  } finally {
    rmSync(out, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
});

test("candidate and asset registration never trust unsafe paths or hashes", () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-media-store-"));
  const outside = mkdtempSync(join(tmpdir(), "riverfield-media-outside-"));
  try {
    const store = new ProductionStore(out);
    store.createProduction({ id: "p", title: "P" }, actor, "p");
    store.createSeason("p", { id: "s", number: 1, title: "S" }, actor, "s");
    store.createEpisode("p", { id: "e", seasonId: "s", number: 1, title: "E" }, actor, "e");
    store.createScene("p", { id: "sc", episodeId: "e", number: 1, title: "Scene" }, actor, "sc");
    const safe = join(out, "media", "safe.png");
    mkdirSync(join(out, "media"), { recursive: true });
    writeFileSync(safe, Buffer.from("safe"));
    assert.throws(() => store.indexAsset("p", { kind: "image", label: "outside", path: join(outside, "x.png") }, actor), (error: unknown) =>
      error instanceof ProductionError || error instanceof MediaSecurityError);
    const badHash = "0".repeat(64);
    assert.throws(() => store.registerCandidate("p", { id: "c1", label: "bad hash", outputs: [{ type: "image", file: "safe.png", name: "safe.png", path: safe, hash: badHash }] }, actor), (error: unknown) =>
      error instanceof ProductionError && error.code === "MEDIA_HASH_MISMATCH");
    const candidate = store.registerCandidate("p", { id: "c2", label: "safe", outputs: [{ type: "image", file: "safe.png", name: "safe.png", path: safe }] }, actor, "c2");
    assert.equal(candidate.candidates["c2"]?.outputs[0]?.hash, hashFile(safe));
    const asset = store.indexAsset("p", { id: "asset", kind: "image", label: "safe", path: safe, tags: ["character"] }, actor, "asset");
    assert.deepEqual(asset.assets["asset"]?.tags, ["character"]);
    const renamed = store.updateAsset("p", "asset", { label: "Akari", tags: ["character", "lead"], category: "characters" }, actor);
    assert.equal(renamed.assets["asset"]?.label, "Akari");
    assert.deepEqual(renamed.assets["asset"]?.tags, ["character", "lead"]);
    assert.equal(renamed.assets["asset"]?.category, "characters");
    const removed = store.removeAsset("p", "asset", actor);
    assert.equal(removed.assets["asset"], undefined);
    const build = store.createAssetBuild("p", { app: "h3-image", category: "characters", label: "Sheet", prompt: "prompt" }, actor);
    assert.equal(build.build.status, "pending");
    const completed = store.completeAssetBuild("p", build.build.id, "run-x", ["asset-x"], actor);
    assert.equal(completed.assetBuilds[build.build.id]?.status, "completed");
    assert.deepEqual(completed.assetBuilds[build.build.id]?.assetIds, ["asset-x"]);
    assert.equal(completed.revision, 0, "asset builds never change canonical revision");
  } finally {
    rmSync(out, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
});
