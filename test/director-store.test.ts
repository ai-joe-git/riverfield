import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DirectorStore } from "../server/director-store.ts";
import { loadRegistry } from "../server/registry.ts";

const apps = new Map(loadRegistry(process.cwd()).apps.map((a) => [a.id, a]));
const APP = "h3-studio-director-flash";

test("a Director project keeps its timeline and media across a restart", () => {
  const dir = mkdtempSync("/tmp/opencode/riverfield-director-store-");
  try {
    const store = new DirectorStore(dir, apps);
    const timeline = JSON.stringify({ windows: [{ start: 0, end: 175, prompt: "first", images: [0], audios: [] }], videos: [], audios: [] });
    store.saveValues(APP, { segment_windows: timeline, global_prompt: "hello", image1: "not-a-value" }, 1234);
    const saved = store.view(APP);
    assert.equal(saved?.savedAt, 1234);
    assert.equal(saved?.values.segment_windows, timeline);
    assert.equal(saved?.values.global_prompt, "hello");
    assert.equal("image1" in (saved?.values ?? {}), false, "media slots are files, not values");

    const bytes = new Uint8Array([1, 2, 3, 4]);
    store.putMedia(APP, "image1", bytes, "still.png", "image/png");
    const withMedia = store.view(APP);
    assert.equal(withMedia?.media.image1.size, 4);
    assert.equal(withMedia?.media.image1.name, "still.png");
    assert.equal(withMedia?.media.image1.url, `/api/directors/${APP}/media/image1`);
    assert.ok(store.mediaPath(APP, "image1"));

    // A new instance reads the same files: this is the reload/restart path.
    const reopened = new DirectorStore(dir, apps);
    assert.deepEqual(reopened.view(APP)?.media.image1, withMedia?.media.image1);
    assert.ok(reopened.mediaPath(APP, "image1"));

    reopened.deleteMedia(APP, "image1");
    assert.equal(reopened.view(APP)?.media.image1, undefined);
    assert.equal(reopened.mediaPath(APP, "image1"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Director project routes refuse non-Director apps, unknown slots and traversal", () => {
  const dir = mkdtempSync("/tmp/opencode/riverfield-director-store-");
  try {
    const store = new DirectorStore(dir, apps);
    assert.throws(() => store.saveValues("h3-image-edit", {}, 1), /not a Director app/);
    assert.throws(() => store.putMedia(APP, "image1000000", new Uint8Array([1]), "x.png", "image/png"), /unknown media slot/);
    assert.throws(() => store.mediaPath(APP, "../state"), /invalid media slot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
