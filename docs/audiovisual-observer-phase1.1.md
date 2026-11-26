# Phase 1.1 — Observer Optimization & Reliability

The original Velvet Moon observation, its raw artifacts, evidence package and canonical revision 0 are preserved unchanged. Phase 1.1 changes the implementation for the **next** observation only. No inference was run while implementing these changes.

## Performance

Execution order is now:

```text
resolve scene + bindings
→ deterministic evidence extraction
→ Whisper Turbo ASR
→ Qwen independent visual pass
→ Qwen comparison pass
→ immutable report
```

- The independent visual pass still receives only sampled frames, compact evidence metadata and optional identity references. It never receives the transcript or intended screenplay.
- Whisper runs first; Qwen visual and comparison then run consecutively, so Qwen is not loaded, unloaded for Whisper and loaded again.
- The comparison input no longer repeats a separate candidate-prompt section: the intended scene + exact candidate prompt are passed once.
- Evidence metadata in the comparison prompt is compact: evidence IDs, timestamps, frame numbers, shot IDs, technical dimensions/FPS/duration, and ASR utterances. Full hashes and file paths remain in the evidence bundle, not in the model prompt.
- Output contracts require one fact per finding; duplicate findings/claims are removed and output length is capped at 4096 tokens.
- `profile.json` records stage times and backend prompt-execution/model-load events. Prefill, decode and vision encoding are explicitly marked unavailable where the installed ComfyUI log does not separate them.
- `QwenVisualObserver` accepts model ID, image limit, output-token budget and temperature, and the manager accepts any `VisualObserver`/`SceneComparator` backend. A smaller specialized multimodal model can be supplied without changing the observation pipeline.

## Observation reliability

- Compound visual/audio findings are split: a visible sweat drop cannot confirm a sound effect. Audio subclaims without audio evidence become `not_observable`.
- Static-frame claims about liquid contents, quantity, previous movement or approach are downgraded unless supported by multiple relevant frames or audio evidence.
- Dialogue findings use actual ASR evidence and are classified `exact`, `partial` or `mismatch`; partial matches cannot remain `confirmed`.
- Visibly intentional stylistic effects (sweat drops, blush, speed lines, sparkles, shock crosses) are separated from unintended generation artifacts.
- Evidence IDs are validated against the exact supplied evidence set. Findings without a valid visual/audio evidence ID are downgraded.
- Extracted evidence, supplied visual evidence and model-cited evidence are recorded separately in the evidence manifest and validation output.
- ASR frame conversion uses the actual media FPS.
- `maxFrames` is now a **hard total cap**. Mandatory shot coverage is explicit: each detected shot must have a representative frame, plus global opening/closing. If the cap cannot hold this minimum, extraction fails with `OBSERVATION_FRAME_BUDGET`.
- Final-output binding ranges are documented as half-open `[start, end)`; `sceneEndFrame` equals the exclusive end (for the fixture: 362, not 361).
- The evidence cache schema was bumped so older fixture evidence is never silently reused for a new extraction.

## Canonical proposals

- Clothing/wardrobe wording observed in one scene is converted from `identity` to scene-scoped `state`.
- Stable identity requires stable subject IDs and evidence IDs.
- Proposed outcomes use closing-state semantics where appropriate.
- A proposed fact without a valid evidence ID is not carried into a canonical proposal.
- No observer action approves a candidate or writes the Bible.

## Regression fixture

The immutable Phase 1 Velvet Moon package remains at:

```text
out/observations/packages/velvet-moon-first-observation.zip
```

The regression suite verifies its 15 extracted frames, 7 supplied visual frames, 2 references, 5 covered shots, zero invalid evidence IDs, audio evidence for dialogue findings, and canonical revision 0. It is never rewritten.

## Proposed second controlled benchmark

Same video, scene, candidate, binding and configuration. This is **not authorized or started** here.

```json
{
  "productionId": "suite-404",
  "sceneId": "suite-404-s01e02-sc01",
  "candidateId": "suite404-20261126-144117031-d4dc",
  "bindingIds": ["suite404-20261126-144117031-d4dc-b001"],
  "options": {
    "maxFrames": 12,
    "visualFrames": 7,
    "sampleIntervalSeconds": 2,
    "sceneThreshold": 0.3,
    "includeAudio": true,
    "visual": true,
    "asr": true,
    "comparison": true
  },
  "referenceAssetIds": [
    "suite404-official-akari-character-sheet",
    "suite404-official-daichi-character-sheet"
  ]
}
```

Expected semantics:

- exactly **12 extracted evidence frames** under the hard cap;
- at least one representative for all 5 shots plus opening and closing;
- exactly **7 evidence frames + 2 references = 9 images** sent to Qwen;
- Whisper executes before the Qwen visual and comparison passes;
- comparison input contains the intended scene once, with compact evidence metadata;
- dialogue findings are exact/partial classified; visual/audio compound findings are split;
- no canonical revision change and no proposal application.

The original observation and package remain the Phase 1 reference. A second benchmark should be a new immutable observation revision, not a replacement.
