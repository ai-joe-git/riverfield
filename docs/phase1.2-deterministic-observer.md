# Phase 1.2 — Deterministic Evidence Engine and Observer Profiles

No inference was launched while implementing Phase 1.2. The six-model benchmark
package and the original Phase 1 observation/package remain immutable. Canonical
revision remains 0.

## Deterministic dialogue alignment

`server/dialogue-alignment.ts` extracts intended `<d>…</d>` utterances and speaker/timing
hints mechanically from the submitted prompt. It normalizes punctuation, capitalization,
apostrophes, repeated words and common hesitations, then computes a longest-common-
subsequence alignment against Whisper Turbo utterances.

The dimensions are reported separately:

- **Text match:** exact, partial or mismatch, with missing/extra/repeated words.
- **Speaker:** same label, different label, unknown or not available.
- **Timing:** aligned/offset/not available, with intended and observed timestamps.
- **Audio delivery:** always `not_observable`; Whisper does not measure prosody, voice
  quality or acting.

The comparison prompt receives this deterministic alignment. It is not asked to perform
word-level calculations itself.

## Stable subjects and proposal validation

`server/observer-subjects.ts` derives stable subject IDs from actual production data:
Bible subject IDs, scene character/location IDs, the production ID and asset labels
(including the official character sheets). Proposals are rejected before canonical
creation when they contain:

- unknown subject IDs;
- missing or invalid evidence IDs;
- invalid `add`/`update` operations;
- updates without an existing canonical fact or with a category change;
- unsupported categories/phases;
- identity facts without a known character subject.

Clothing observed in one scene remains a scene-scoped State proposal, never permanent
identity. The registry uses stable IDs such as `akari` rather than model-invented labels.

## Chronological evidence

The visual selection now sorts selected evidence frames by timestamp and then appends
the identity references. Exact frame IDs, timestamps and hashes are preserved.
`maxFrames` remains a hard cap with mandatory shot coverage.

## Compact comparison context

The comparison prompt now receives:

- the scene brief;
- deterministically extracted intended shot actions;
- the deterministic dialogue alignment;
- compact canonical continuity constraints;
- relevant structured visual/audiovisual observations and native evidence ranges;
- coverage limitations.

It no longer receives full evidence paths/hashes, the entire ASR transcript as an
unsolved task, or verbose technical metadata.

## Schema-constrained JSON

The installed `TextGenerateV2` node exposes sampling, token budget, system prompt,
thinking/MTP and media inputs. Its `object_info` has no JSON-schema/response-format
control. Native schema-constrained generation is therefore unavailable in this
installation. Phase 1.2 retains strict parsing:

- invalid category, classification, proposal op/category/phase, or malformed JSON
  fails the stage explicitly;
- raw model text is retained with the failure;
- invalid evidence IDs are not silently converted into valid ones;
- unknown subjects and invalid updates are rejected before a canonical proposal.

No semantic repair is performed.

## Profiles

| Profile | Visual | Comparison | ASR | Native media | Behavior |
|---|---|---|---|---|---|
| Fast Review | Gemma 4 12B Heretic W4A8 | same | Whisper Turbo | no | deterministic evidence alignment |
| Detailed Review | Qwen3.8 27B W4A8 | same | Whisper Turbo | no | deterministic evidence alignment |
| Senior Review | reused | Qwen3.8 27B | reused | no | reviews an existing observation/evidence without extraction, ASR or visual rerun |
| Experimental Audiovisual | compatible Gemma | compatible Gemma | Whisper Turbo | video + audio | explicit experimental status; audio/sync/voice claims remain unverified |
| Custom | selected | selected | selected | selected | existing controls preserved |

Profiles only supply defaults. The Analyze Scene interface preserves explicit model
selection and inference controls, switching to Custom when a model is changed.

## Audio reliability

Whisper Turbo remains the only dedicated transcription backend. Gemma native-media
findings are model observations, not confirmed evidence. Music, environmental sound,
sound-effect, synchronization and voice-quality claims are marked unverified for the
Experimental Audiovisual profile. Contradictory Gemma audio claims are not promoted to
confirmed evidence.

## Regression fixture

The complete six-model benchmark remains at:

```text
out/observations/benchmark-20261126/
out/observations/velvet-moon-multimodal-benchmark.zip
```

Tests verify its six rows, 7+2 image manifests, A/B statuses, B1 recovered raw comparison
and preservation of the original Phase 1 package and canonical revision 0.

## Prepared Fast Review benchmark

Prepared, not launched:

```text
out/observations/phase1.2-fast-review-request.json
```

It uses the exact Velvet Moon candidate, binding, seven evidence frames, both official
character references and the Fast Review profile. Launch requires explicit approval.

## Invariants

- No inference during implementation.
- No media regeneration.
- No candidate approval.
- No canonical proposal records.
- No Bible changes.
- Canonical revision 0.
