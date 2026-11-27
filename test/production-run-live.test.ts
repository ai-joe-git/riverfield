import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveProductionRunAdapters } from "../server/production-run-live.ts";
import type { RunContext } from "../server/production-run.ts";
import type { ProductionRun, ProductionRunScene } from "../server/production-types.ts";

test("live render adapter carries the full scene plan, references and Build settings into the existing app route", async () => {
  const out = mkdtempSync(join(tmpdir(), "riverfield-live-adapter-"));
  try {
    const image = join(out, "akari.png");
    writeFileSync(image, Buffer.from("89504e470d0a1a0a", "hex"));
    const hash = createHash("sha256").update(Buffer.from("89504e470d0a1a0a", "hex")).digest("hex");
    const snapshot = {
      production: { id: "live-test", style: "expressive Japanese anime romantic comedy" },
      assets: { "asset-akari": { id: "asset-akari", label: "Akari", path: image, hash } },
      candidates: {},
    };
    const scene: ProductionRunScene = {
      sceneId: "live-scene-1", title: "Toast", objective: "Akari challenges Daichi to a toast.",
      intendedEvents: ["Akari sets two glasses on the bar.", "Daichi raises a glass."], dialogueRequirements: ["Akari: You call that a toast?"],
      characterIds: [], locationIds: [], propIds: [], targetDurationSeconds: 7.3, intendedTransition: "cut",
      selectedApp: "h3-studio-director-flash", profile: "build", referenceAssetIds: ["asset-akari"],
      renderConfig: { prompt_enhancer: true }, observationIds: [], continuityReviewIds: [], status: "planned", jobIds: [], attempts: 0, errors: [],
    };
    const run = { id: "live-run", productionId: "live-test", title: "Live Test", scenePlan: [scene], budget: {}, provisionalFacts: [] } as unknown as ProductionRun;
    const context: RunContext = { run, scene, sceneIndex: 0, requestKey: "request" };
    const calls: { path: string; init?: RequestInit }[] = [];
    let form: FormData | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      const path = String(input);
      calls.push({ path, ...(init ? { init } : {}) });
      if (path.endsWith("/api/productions/live-test") && (!init || init.method === undefined)) return new Response(JSON.stringify(snapshot), { status: 200 });
      if (path.endsWith("/api/apps/h3-studio-director-flash/run")) { form = init?.body as FormData; return new Response(JSON.stringify({ id: "history-live-1" }), { status: 202 }); }
      if (path.endsWith("/api/history/history-live-1")) return new Response(JSON.stringify({ id: "history-live-1", status: "succeeded" }), { status: 200 });
      if (path.endsWith("/api/productions/live-test/candidates")) return new Response(JSON.stringify({ candidates: { "run-live-run-live-scene-1": { id: "run-live-run-live-scene-1" } } }), { status: 201 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    };
    const adapter = new LiveProductionRunAdapters({ baseUrl: "http://live.test", fetchImpl: mockFetch, pollMs: 1 });
    const handle = await adapter.startRender(context);
    const result = await handle.wait();
    assert.equal(result.candidateId, "run-live-run-live-scene-1");
    assert.ok(form);
    assert.equal(form.get("render_profile"), "build");
    assert.equal(form.get("production_megapixels"), "0.1");
    assert.equal(form.get("production_upscale"), "");
    assert.match(String(form.get("global_prompt")), /Intended events/);
    assert.match(String(form.get("global_prompt")), /Dialogue requirements/);
    assert.match(String(form.get("global_prompt")), /Transition requirement/);
    assert.ok(form.get("image1"));
    assert.equal(calls.some((call) => call.path.endsWith("/api/apps/h3-studio-director-flash/run")), true);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
