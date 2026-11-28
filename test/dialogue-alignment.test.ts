import { test } from "node:test";
import assert from "node:assert/strict";
import { alignDialogue, extractCandidateBrief, extractIntendedBrief, extractIntendedUtterances, normalizeDialogue } from "../server/dialogue-alignment.ts";
import { comparisonPrompt } from "../server/observer-prompts.ts";
import type { Candidate, ObservationDialogue, SceneRenderBinding } from "../server/production-types.ts";

const intended = extractIntendedUtterances(`
[Shot 3] At 00:08.000, the camera cuts to a close-up. The woman (S1) says: <d>[English] You're late, Daichi. I was just about to drink this one too.</d>
[Shot 4] At 00:11.500, the man (S2) stammers: <d>[English] I— I wasn't late! I just... needed to find the right mood.</d>
[Shot 5] At 00:13.500, the woman (S1) says: <d>[English] Mmm, I like the sound of that.</d>
`, "candidate-prompt");

const dialogue: ObservationDialogue = {
  provider: "whisper-turbo", model: "large-v3-turbo",
  text: "you're late daichi i was just about to drink this one too i i wasn't late i just needed to find the right mood i like the sound of that",
  utterances: [
    { id: "utterance-001", startSeconds: 0, endSeconds: 8.56, text: "you're late daichi i was just about to drink this one too", speaker: { label: "Unattributed speaker", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"] },
    { id: "utterance-002", startSeconds: 8.56, endSeconds: 12.54, text: "i i wasn't late i just needed to find the right mood", speaker: { label: "Unattributed speaker", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"] },
    { id: "utterance-003", startSeconds: 12.54, endSeconds: 15.08, text: "i like the sound of that", speaker: { label: "Unattributed speaker", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"] },
  ],
  limitations: [], evidenceIds: ["audio-01"],
};

test("intended dialogue extraction preserves stable ids, speakers and timestamps", () => {
  assert.equal(intended.length, 3);
  assert.deepEqual(intended.map((item) => item.id), ["intended-001", "intended-002", "intended-003"]);
  assert.deepEqual(intended.map((item) => item.speakerLabel), ["S1", "S2", "S1"]);
  assert.deepEqual(intended.map((item) => item.startSeconds), [8, 11.5, 13.5]);
  assert.match(intended[0]?.text ?? "", /You're late, Daichi/);
});

test("dialogue alignment separates text, speaker, timing and audio delivery", () => {
  const alignment = alignDialogue(intended, dialogue);
  assert.equal(alignment.matches.length, 3);
  assert.equal(alignment.matches[0]?.textMatch, "exact");
  assert.equal(alignment.matches[1]?.textMatch, "exact");
  assert.equal(alignment.matches[2]?.textMatch, "partial");
  assert.deepEqual(alignment.matches[2]?.missingWords, ["mmm"]);
  assert.equal(alignment.matches[0]?.speaker.status, "unknown");
  assert.equal(alignment.matches[0]?.timing.status, "offset");
  assert.equal(alignment.matches[0]?.audioDelivery, "not_observable");
  assert.deepEqual(alignment.matches[0]?.evidenceIds, ["audio-01"]);
  assert.deepEqual(alignment.unmatchedTranscript, []);
});

test("normalization ignores case and punctuation but retains repeated words", () => {
  assert.equal(normalizeDialogue("I— I wasn't late!"), "i i wasn't late");
  const alignment = alignDialogue([
    { id: "intended-001", text: "I— I wasn't late", normalized: normalizeDialogue("I— I wasn't late"), source: "scene" },
  ], {
    ...dialogue,
    utterances: [{ id: "u", startSeconds: 0, endSeconds: 1, text: "i i wasn't late", speaker: { label: "Unattributed speaker", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"] }],
  });
  assert.equal(alignment.matches[0]?.textMatch, "exact");
  assert.equal(alignment.matches[0]?.repeatedWords.length, 1);
});

test("intended brief extracts compact shots and a scene brief deterministically", () => {
  const brief = extractIntendedBrief("[Shot 1] A woman walks. <d>Hello there.</d>\n[Shot 2] A man answers. <d>Hi.</d>", "candidate-prompt");
  assert.equal(brief.shots.length, 2);
  assert.deepEqual(brief.shots.map((shot) => shot.index), [1, 2]);
  assert.match(brief.shots[0]?.text ?? "", /\[dialogue\]/);
  assert.equal(brief.utterances.length, 2);
});

test("monotonic alignment never reuses an ASR utterance unintentionally", () => {
  const alignment = alignDialogue([
    { id: "i1", text: "You're late", normalized: "you're late", source: "scene" },
    { id: "i2", text: "I was just about to drink this too", normalized: "i was just about to drink this too", source: "scene" },
  ], {
    ...dialogue,
    utterances: [{ id: "u1", startSeconds: 0, endSeconds: 3, text: "you're late i was just about to drink this too", speaker: { label: "Unattributed speaker", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"] }],
  });
  assert.equal(alignment.matches.length, 1);
  assert.equal(alignment.matches[0]?.grouping, "merged-asr");
  assert.deepEqual(alignment.matches[0]?.intendedIds, ["i1", "i2"]);
  assert.deepEqual(alignment.matches[0]?.utteranceIds, ["u1"]);
  assert.equal(alignment.matches.flatMap((match) => match.utteranceIds).length, 1);
});

test("alignment supports an intended utterance split across consecutive ASR segments", () => {
  const alignment = alignDialogue([
    { id: "i1", text: "You're late Daichi I was just about to drink this one too", normalized: "you're late daichi i was just about to drink this one too", source: "scene" },
  ], {
    ...dialogue,
    utterances: [
      { id: "u1", startSeconds: 0, endSeconds: 1, text: "you're late daichi", speaker: { label: "Unattributed speaker", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"] },
      { id: "u2", startSeconds: 1, endSeconds: 3, text: "i was just about to drink this one too", speaker: { label: "Unattributed speaker", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"] },
    ],
  });
  assert.equal(alignment.matches.length, 1);
  assert.equal(alignment.matches[0]?.grouping, "split-asr");
  assert.deepEqual(alignment.matches[0]?.utteranceIds, ["u1", "u2"]);
  assert.equal("overlapSeconds" in (alignment.matches[0]?.timing ?? {}), false);
  assert.equal(alignment.matches[0]?.timing.precision, "coarse-asr-segment");
});

test("shot extraction ignores [Shot 1] in introductory prose and keeps soundscape/music separate", () => {
  const brief = extractIntendedBrief("At 0.00 seconds, <Picture 1> (from [Shot 1]) is referenced.\n\n[Shot 1] A wide shot. <d>Hello.</d>\n[Shot 2] A reply. <d>Hi.</d>\n\noverall_soundscape: soft jazz and a chair creak.\n\nnon_diegetic_music: slow piano.", "candidate-prompt");
  assert.deepEqual(brief.shots.map((shot) => shot.index), [1, 2]);
  assert.match(brief.soundscape ?? "", /soft jazz/);
  assert.match(brief.music ?? "", /slow piano/);
});


test("numeric equivalents such as twelve percent and 12% compare deterministically", () => {
  assert.equal(normalizeDialogue("twelve percent"), "12 percent");
  assert.equal(normalizeDialogue("12%"), "12 percent");
  const alignment = alignDialogue([
    { id: "i1", text: "The score is twelve percent", normalized: normalizeDialogue("The score is twelve percent"), source: "scene" },
  ], {
    ...dialogue,
    utterances: [{ id: "u1", startSeconds: 0, endSeconds: 2, text: "the score is 12%", speaker: { label: "Unattributed speaker", attribution: "unknown" }, unclear: false, evidenceIds: ["audio-01"] }],
  });
  assert.equal(alignment.matches[0]?.textMatch, "exact");
});

test("intended dialogue comes from all and only the selected native timeline segments", () => {
  const binding: SceneRenderBinding = { id: "binding", sceneId: "scene", candidateId: "candidate", timebase: "final-output",
    segmentIndex: 0, timelineStartFrame: 0, timelineEndFrame: 48, fps: 24 };
  const candidate: Candidate = {
    id: "candidate", productionId: "prod", label: "Candidate", source: "history", outputs: [], bindings: [binding],
    contentHash: "fixture", createdAt: "2026-11-28T00:00:00Z", createdBy: "test",
    prompt: "[Shot 1] <d>First-prompt fallback.</d>", provenance: { timebase:"final-output",
      segments: ["First recorded line", "Second recorded line", "Unselected line"].map((line, index) =>
        ({ index, images: [], audios: [], prompt: `[Shot 1] The character says <d>[English] ${line}.</d>`, startFrame: index * 24, endFrame: (index + 1) * 24 })) },
  };
  const brief = extractCandidateBrief(candidate, [binding]);
  assert.deepEqual(brief.utterances.map(u => [u.id, u.segment, u.text]), [
    ["segment-1-intended-001", 1, "First recorded line."], ["segment-2-intended-001", 2, "Second recorded line."],
  ]);
  assert.deepEqual(brief.shots.map(shot => shot.dialogueIds), brief.utterances.map(u => [u.id]));
  const transcript = { ...dialogue, provider: "halogen-npu", text: "First recorded line. Second recorded line.", utterances: [] } as ObservationDialogue;
  const prompt = comparisonPrompt({ intended: "Scene", canonicalOpening: "", coverage: "No reliable timing",
    observationJson: { dialogue: transcript }, intendedBrief: brief, dialogueAlignment: alignDialogue(brief.utterances, transcript) });
  assert.match(prompt, /INTENDED DIALOGUE.*\n.*segment-2-intended-001/);
  assert.match(prompt, /transcriptOnly/);
  assert.doesNotMatch(prompt, /First-prompt fallback|Unselected line/);
});
