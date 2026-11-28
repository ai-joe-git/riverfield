import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planH3, validateH3 } from "../server/h3-plan.ts";
// @ts-ignore Browser module is plain JavaScript.
import { parseBatchPrompts, rippleH3Windows } from "../web/js/director.js";
import { loadRegistry } from "../server/registry.ts";
import { resolveValues, applyInputs } from "../server/runner.ts";

test("short and long scenes default to contiguous hard cuts without changing briefs or reference order", () => {
  for (const seconds of [5/24, .5, 5, 15, 25, 150]) {
    const prompts = ['Arrival. She says "Hello."', 'Reverse angle. He says "Welcome."', 'Exit.'];
    const plan = planH3({ seconds, prompts, segment_images: [[1,0], [0], []], segment_audios: [[0], [], []] });
    const windows = JSON.parse(plan.segment_windows).windows;
    assert.equal(plan.overlapFrames, 0);
    assert.equal(plan.frames, prompts.length * plan.segmentFrames);
    assert.deepEqual(windows.map((w: any) => w.start), [0, plan.segmentFrames, 2 * plan.segmentFrames]);
    assert.deepEqual(windows.map((w: any) => w.prompt), prompts);
    assert.deepEqual(windows.map((w: any) => w.images), [[1,0], [0], []]);
    assert.deepEqual(windows.map((w: any) => w.audios), [[0], [], []]);
  }
});

test("explicit same-camera continuation keeps a legal seam and rejects invalid overlaps", () => {
  const plan = planH3({ seconds: 10, prompts: ["Continuous take, first part", "Same camera, second part"], overlap_frames: 39 });
  const windows = JSON.parse(plan.segment_windows).windows;
  assert.equal(plan.overlapFrames, 39);
  assert.ok(plan.seconds > 15);
  assert.equal(windows[1].start, windows[0].end - 39);
  assert.doesNotThrow(() => validateH3({ segment_windows: plan.segment_windows }));
  for (const overlap_frames of [2, 243, 3592])
    assert.throws(() => planH3({ seconds: 10, prompts: ["A", "B"], overlap_frames }));
});

test("pasted GUI scenes default to hard cuts and accept only deliberately supplied overlap", () => {
  assert.deepEqual(parseBatchPrompts('Arrival\nReverse angle,10\nExit,5', 7.3), [
    {prompt: "Arrival", duration: 7.3, overlap: 0},
    {prompt: "Reverse angle", duration: 10, overlap: 0},
    {prompt: "Exit", duration: 5, overlap: 0},
  ]);
  assert.equal(parseBatchPrompts('Same camera,10,1.625', 7.3)[0].overlap, 1.625);
  assert.equal(parseBatchPrompts('Same camera,10', 7.3, 1.625)[0].overlap, 1.625);
});

test("hard-cut Flash timelines reach the native planner in both reference and first/last checkpoint modes", () => {
  const app = loadRegistry(process.cwd()).apps.find(a => a.id === "h3-studio-director-flash")!;
  const graphSource = JSON.parse(readFileSync('apps/h3-studio-director-flash/workflow.api.json', 'utf8'));
  const file = {bytes: new Uint8Array([1]), name: 'ref.png'};
  for (const flex_mode of ['ref2va', 'fl2va']) {
    const plan = planH3({ seconds: 10, prompts: ['First shot', 'Second shot'], images: flex_mode === 'ref2va' ? [0] : [] });
    const values = resolveValues(app, { flex_mode, prompt_enhancer: false, segment_windows: plan.segment_windows,
      ...(flex_mode === 'ref2va' ? {image1: file} : {}) });
    const graph = structuredClone(graphSource);
    applyInputs(app, values, {json: graph, setInput(node: string, field: string, value: unknown) { graph[node].inputs[field] = value; }}, v => v);
    const windows = JSON.parse(String(graph.rfplan.inputs.segment_windows)).windows;
    assert.equal(windows[1].start, windows[0].end);
    assert.deepEqual(windows.map((w: any) => w.prompt), ['First shot', 'Second shot']);
  }
});

test("GUI duration edits ripple hard cuts and retain a deliberately authored continuous seam", () => {
  for (const overlap of [0, 39]) {
    const before = [0, 1, 2].map(i => ({ start: i * (175 - overlap), end: i * (175 - overlap) + 175, prompt: `Shot ${i}` }));
    const windows = structuredClone(before);
    windows[0].end = 260;
    rippleH3Windows(windows, 0, before);
    assert.equal(windows[1].start, 260 - overlap);
    assert.equal(windows[2].start, windows[1].end - overlap);
    assert.deepEqual(windows.map(w => w.end - w.start), [260,175,175]);
    assert.deepEqual(windows.map(w => w.prompt), before.map(w => w.prompt));
  }
});
