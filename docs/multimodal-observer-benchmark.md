# Model-independent multimodal observer — benchmark matrix

This document prepares the controlled observer benchmarks. **No benchmark job is
started by this document or by the implementation change.** Each row requires explicit
human approval.

## Architecture

The internal observer remains one ComfyUI graph:

```text
CLIPLoader(checkpoint, CLIPLoader recipe)
  → TextGenerateV2(
       images.image1..9,
       videos.video1,       # optional, GetVideoComponents(LoadVideo)
       audios.audio1,       # optional, LoadAudio
       max_length, temperature, top_k, top_p, seed, thinking
     )
  → SaveText
```

- The selected checkpoint is written to the real `CLIPLoader.clip_name` field.
- The selected recipe is written to the real `CLIPLoader.type` field.
- Temperature, output-token budget, top-k, top-p, seed and thinking are real
  `TextGenerateV2` inputs.
- The visual and comparison passes may select different installed checkpoints.
- The app variant carries the selected model in its model key, so the gateway unloads
  the previous checkpoint before a model switch.
- Whisper Turbo remains the dedicated ASR backend. It is not replaced by a multimodal
  checkpoint.
- Native video is a scene-range MP4, not the whole source file. Native audio is the
  extracted scene WAV. The nine-image workflow is unchanged and remains the image
  evidence path.

## Installed checkpoints discovered locally

Discovery reads only the safetensors JSON header (never the weights) and records the
actual vision/audio projector tensors. The source endpoint is:

```text
GET /api/observer-models
```

Discovery reads `RIVERFIELD_TEXT_ENCODERS_DIR`, or
`$COMFYUI_ROOT/models/text_encoders`, falling back to the local ComfyUI path. Absent
files are reported as `installed: false`; the server never downloads a replacement.

| Model id | Exact filename | Quantization | Image | Video | Audio | CLIPLoader recipe |
|---|---|---|---|---|---|---|
| `qwen3.8-27b-w4a8` | `qwen3.8_27b_w4a8.safetensors` | w4a8 | yes | yes | no | `stable_diffusion` |
| `qwen3.8-27b-heretic-w4a8` | `qwen3.8_27b_uncensored_heretic_w4a8_convrot_v2.safetensors` | w4a8_convrot | yes | yes | no | `stable_diffusion` |
| `qwen3.5-9b-uncensored-w4a8` | `qwen3.5_9b_uncensored_w4a8.safetensors` | w4a8 | yes | yes | no | `stable_diffusion` |
| `qwen3.5-9b-w4a8-gptq` | `qwen3.5_9b_w4a8_gptq.safetensors` | w4a8_gptq | yes | yes | no | `stable_diffusion` |
| `gemma4-12b-heretic-w4a8` | `gemma4_12b_it_uncensored_heretic_w4a8.safetensors` | w4a8 | yes | yes | yes | `stable_diffusion` |
| `gemma4-e2b-int8-convrot` | `gemma4_e2b_it_int8_convrot.safetensors` | int8_convrot | yes | yes | yes | `stable_diffusion` |

The four benchmark rows below use one Qwen3.5 checkpoint (the uncensored w4a8 file) so
the comparison is reproducible. The GPTQ file remains selectable but is not a separate
benchmark row.

## Matrix A — controlled visual-only

Purpose: compare model behaviour on **identical image evidence**. No native video or
audio input is supplied to any row. ASR and the comparison pass may run, but every row
receives the same transcript and the same nine images.

| Row | Visual model | Comparison model | Native video | Native audio |
|---|---|---|---|---|
| A1 baseline | `qwen3.8-27b-w4a8` | same | no | no |
| A2 | `qwen3.5-9b-uncensored-w4a8` | same | no | no |
| A3 | `gemma4-12b-heretic-w4a8` | same | no | no |
| A4 | `gemma4-e2b-int8-convrot` | same | no | no |

Common request:

```json
{
  "productionId": "suite-404",
  "sceneId": "suite-404-s01e02-sc01",
  "candidateId": "suite404-20261126-144117031-d4dc",
  "bindingIds": ["suite404-20261126-144117031-d4dc-b001"],
  "referenceAssetIds": [
    "suite404-official-akari-character-sheet",
    "suite404-official-daichi-character-sheet"
  ],
  "options": {
    "maxFrames": 12,
    "visualFrames": 7,
    "sampleIntervalSeconds": 2,
    "sceneThreshold": 0.3,
    "includeAudio": true,
    "visual": true,
    "asr": true,
    "comparison": true,
    "nativeVideo": false,
    "nativeAudio": false,
    "temperature": 0.1,
    "maxOutputTokens": 4096,
    "topK": 64,
    "topP": 0.9
  }
}
```

A1 is the Phase 1.1 baseline. A2–A4 change only `visualModel` and `comparisonModel`.
The expected evidence is exactly 12 extracted frames, five covered shots, and seven
evidence images plus two references = nine images. The original 15-frame package is a
regression fixture, not a row in this matrix.

## Matrix B — audiovisual Gemma

Purpose: use actual video and audio through `TextGenerateV2`, only for checkpoints whose
headers expose both projectors. Image evidence stays identical to Matrix A.

| Row | Model | Native video | Native audio | Images |
|---|---|---|---|---|
| B1 | `gemma4-12b-heretic-w4a8` | yes | yes | same seven + two references |
| B2 | `gemma4-e2b-int8-convrot` | yes | yes | same seven + two references |

Use the same request as Matrix A with:

```json
{
  "options": {
    "visualModel": "gemma4-12b-heretic-w4a8",
    "comparisonModel": "gemma4-12b-heretic-w4a8",
    "nativeVideo": true,
    "nativeAudio": true
  }
}
```

and likewise for E2B. A native modality that the selected checkpoint does not expose is
rejected before any inference; it is never silently dropped.

## Measurements

For every row, collect from the immutable job artifacts:

| Dimension | Source |
|---|---|
| Accuracy | atomic comparison findings, dialogue exact/partial matches, shot coverage |
| Evidence grounding | valid/invalid evidence ids, supplied vs cited evidence, unsupported claims |
| Structured JSON reliability | parse success, `OBSERVER_OUTPUT_INVALID`, dedupe, 4096-token cap |
| Execution time | `timings.json`, `profile.json` prompt executions and model loads |
| Memory | `memory.jsonl` RSS/heap and GTT before, during and after |
| Continuity reasoning | opening/closing state, identity vs scene-scope separation, proposed changes |
| Modalities | `report.observer.inputModalities`, `native-inputs.json` |
| Exact checkpoint | `report.observer.visualCheckpoint` and `comparisonCheckpoint` |

Prefill, decode and vision encoding are not separately exposed by the installed
TextGenerateV2 log; the profile reports that limitation rather than inventing a split.

## Invariants

- Do not run a benchmark without explicit approval.
- Do not replace, rewrite or delete the original Velvet Moon observation, raw outputs,
  evidence package or canonical revision 0.
- Do not download new weights.
- Do not introduce another inference runtime.
- Do not treat absent evidence as proof of absence.
- Do not canonize any observation or apply any proposal.

## Preflight corrections applied before execution

- Evidence frames and identity references have separate budgets: seven evidence
  frames + two references = nine workflow images. Over-budget requests fail instead of
  silently dropping references.
- Matrix B uses a separate audiovisual prompt and structured contract; Matrix A keeps
  the visual-only prompt unchanged.
- Native video/audio is limited to one selected binding. Multiple or discontinuous
  bindings are rejected before inference.
- Native evidence ids, hashes and temporal ranges are recorded and validated against
  the media actually supplied.
- Raw model text is retained when a parser fails.
- The exact nine-image input is asserted in an integration test.

## Executed benchmark

The six authorized rows were run sequentially on 2026-11-26. Results, per-run raw
artifacts and the comparative report are in:

```text
out/observations/benchmark-20261126/
out/observations/velvet-moon-multimodal-benchmark.zip
```

Summary:

- A1 Qwen3.8 27B: best visual/comparison accuracy, 981 s, 27,992 MB peak GTT.
- A2 Qwen3.5 9B: 640 s, good visual basics, weak atomic dialogue comparison.
- A3 Gemma 4 12B: best speed/quality balance, 461 s.
- A4 Gemma 4 E2B: fastest visual row, 361 s, unreliable comparison grounding.
- B1 Gemma 4 12B AV: structured audiovisual output, comparison invalid JSON (raw
  recovered, not retried), overconfident audio claims.
- B2 Gemma 4 E2B AV: completed both stages, but hallucinated music, invented raw
  frame ids and produced no evidence-backed comparison findings.

No model was automatically retried. Canonical revision remains 0, no proposal was
created, no candidate was approved and no Bible change was applied.

## Phase 1.2

Deterministic dialogue alignment, stable production subjects, chronological image
ordering, compact comparison context, strict proposal validation and the Fast/Detailed/
Senior/Experimental Audiovisual profile architecture are documented in
[`phase1.2-deterministic-observer.md`](phase1.2-deterministic-observer.md). The prepared
Fast Review request is at `out/observations/phase1.2-fast-review-request.json` and awaits
explicit approval; it was not launched.
