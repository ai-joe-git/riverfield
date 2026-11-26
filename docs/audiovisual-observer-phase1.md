# Phase 1 — Riverfield Audiovisual Observer

**Status:** implemented, automated tests use mocked observation/ASR outputs. **No Qwen observation inference has been run for this implementation.** The first real Velvet Moon run is proposed below and requires human approval.

Phase 1 adds an evidence-only observer above the Production Engine. It never regenerates a source video, never moves or modifies candidate media, and never writes canonical memory by itself. Intent, observation and canon remain separate.

## Architecture

| Module | Responsibility |
|---|---|
| `server/observation-evidence.ts` | FFprobe/FFmpeg evidence extraction, hashing, scene-bound filtering, shot detection and deterministic cache |
| `server/observer-prompts.ts` | Dedicated independent-observer and comparison prompts, versioned separately from the cinematic prompt writer |
| `server/observer-app.ts` + `server/observer-workflow.api.json` | Internal Qwen3.8 27B multimodal ComfyUI workflow (not listed in the public app catalog) |
| `server/observer-inference.ts` | Qwen visual/comparison adapter and Whisper Turbo ASR adapter |
| `server/observation.ts` | Durable observation jobs, stage status, cancellation, report assembly and proposal handoff |
| `server/production-types.ts` | Versioned observation report and evidence contracts, extending the existing manual observation |
| `server/production-store.ts` | Appends immutable structured observations with revision/previous-revision links |
| `server/server.ts` | Observation jobs, evidence serving, scene observations and proposal routes |
| `mcp/server.ts` | Observer MCP tools |
| `web/js/productions.js` | Explicit **Analyze scene** review UI |

The observer operates on exactly the selected scene bindings of one immutable candidate. A multi-scene candidate is never analyzed as an unrelated whole: only the requested `sceneId` bindings are passed to evidence extraction.

## Pipeline

1. Resolve scene, candidate and binding ids. Reject unknown or cross-scene bindings.
2. Resolve the actual video through the production media boundary and verify the source SHA-256 and binding output hash.
3. Clamp final-output frame ranges to the actual source, then probe resolution, FPS, frame count, duration, video codec and audio streams with FFprobe.
4. Detect cinematic cuts inside each selected binding with FFmpeg `select='gt(scene,threshold)'`, separate from native Director segment boundaries.
5. Extract opening, closing, per-shot and bounded additional sample frames, plus one 16 kHz mono WAV per binding range.
6. Cache the evidence under `out/observations/evidence/<production>/<scene>/<cache-key>/` with a manifest. The cache key includes source hash, candidate content hash, binding ids and extraction configuration.
7. Run the independent Qwen visual pass with evidence frames only. It does not receive the intended scene, candidate prompt or canon.
8. Run Whisper Turbo ASR separately on the exact binding audio ranges. The transcript is never corrected against the screenplay.
9. Run the comparison pass with intended scene, actual observation and approved opening canon.
10. Record one immutable observation report revision. Failed visual or ASR stages remain explicit; extracted evidence is kept.

## Evidence contract

`manifest.json` stores:

- source path/hash and verification;
- technical metadata and exact scene frame/second range;
- native segment boundaries;
- detected shots with detector (`ffmpeg-scene` or `native-segment`);
- frames with id, timestamp, frame number, binding, shot, SHA-256 and relative file;
- audio ranges with timestamp/frame and hash;
- visual frame selection and extraction configuration.

Evidence is written separately from the source. No source file is copied, renamed, moved or modified. Audio/frames are the only derived artifacts.

## Observer model and prompt

The installed local Qwen3.8 27B multimodal model is used through ComfyUI `TextGenerateV2` with the `qwen3.8_27b_w4a8.safetensors` text encoder. The observer app is internal: it is not returned by the public app catalog. It accepts at most nine evidence/reference images and has a 6144-token output budget.

The independent pass uses `visual-independent-v1`; the comparison pass uses `intent-observation-compare-v1`. Neither reuses the Director's cinematic prompt-writer system prompt. The visual pass rejects intended prompt input by construction: only the evidence map, technical data and reference labels are supplied.

Every visual claim references frame ids. Claims with unsupported ids are reduced to uncertainty, not promoted. Reference character sheets are identity-comparison aids; their presence never proves that the character appears in the render.

## ASR

The adapter uses the local **Whisper Turbo** app (`whisper-turbo`) with `large-v3-turbo` and automatic GPU selection. The installed local node uses Transformers/PyTorch on ROCm; CPU is not exposed in the app. The ASR stage returns:

- actual transcript text;
- timestamped utterances;
- language when available (currently not emitted by this adapter);
- confidence `null` when unavailable;
- unclear markers;
- explicit limitations for speaker attribution, voice identity, acting quality, mixing and lip sync.

Speaker attribution is always `unknown` unless a future evidence-backed diarization/voice adapter establishes otherwise. ASR text is not corrected using intended dialogue.

An optional `AudioUnderstandingAdapter` interface is present for a future specialist model (Gemma 4 E4B or equivalent). It is not required and is not part of the current default run.

## Structured observations and revisions

Each automated report is an immutable `Observation` with `kind: "analysis"`, `revision`, `previousRevisionId`, and a versioned `report`:

- production, episode, scene, candidate, source run/output hash;
- binding ids/timebase;
- observer model, version, prompt version and configuration;
- analysis timestamps, technical metadata, native boundaries, shots;
- visual observations, dialogue, opening/closing state, observed events;
- evidence references, confidence, uncertainty, limitations;
- stage completion/failure information.

A second analysis of the same candidate creates revision 2 and preserves revision 1. Manual observations remain supported and use the same immutable store without a structured report.

## Comparison and proposals

The comparison pass receives:

A. intended scene/candidate prompt;
B. the independent observation (never altered);
C. approved canonical opening context.

Findings are classified `confirmed`, `probable`, `uncertain` or `not_observable`. Absence from sampled frames is never treated as proof of absence. Proposed State/Episodic/Narrative changes are stored in the report and can be converted to a normal canonical proposal through `propose_observed_state_changes`; they cannot be approved or canonized by an agent or HTTP route.

## Resource management

- All Qwen and Whisper inference goes through the existing `InferenceQueue`.
- Heavy video generation and observation cannot run concurrently by default.
- The same internal Qwen app serves visual and comparison passes, so the model is reused between them.
- Frames are bounded to nine visual images; total evidence frames are bounded by configuration.
- Evidence extraction is CPU-only and cached.
- Cancellation aborts the current queue work and backend job; the candidate and completed evidence remain.
- A failed visual/asr/comparison stage does not remove evidence or the candidate.

## API and MCP

```text
POST /api/productions/:id/observation-jobs
GET  /api/productions/:id/observation-jobs?sceneId=...
GET  /api/observation-jobs/:id
POST /api/observation-jobs/:id/cancel
GET  /api/observation-jobs/:id/evidence?file=frames/frame-0001.jpg
GET  /api/productions/:id/scenes/:sceneId/observations
POST /api/productions/:id/observations/:observationId/propose
```

MCP tools: `analyze_scene`, `get_observation_job`, `cancel_observation_job`, `get_scene_observations`, `get_observation_evidence`, `compare_scene`, `propose_observed_state_changes`. These reuse the existing HTTP MCP conventions and expose no approval route.

## Production Studio

Each candidate card gets an explicit **Analyze scene** action. Opening the action only opens a review modal; inference starts only after **Start analysis**. The modal exposes an optional identity-reference selector, job stage/progress, cancellation, cached evidence thumbnails with timestamps, shot timeline, actual ASR transcript, opening/closing state, intent-versus-observed findings, proposed changes, manual observation access and previous revisions. The existing Riverfield layout and design language are reused.

## SUITE 404 asset catalog

`server/suite404-assets.ts` synchronizes existing non-canonical asset labels and categories against the official `Asset_Registry.json` and `Universe_Asset_Batch_v1.json`:

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning server/suite404-assets.ts
```

It preserves asset ids and media paths, updates labels/categories in place, indexes the four official assets that were missing from the production (Akari, Daichi, Bathroom, Bedroom), and moves older duplicate masters to Drafts with a `superseded` tag. The catalog ends at 17 Locations, 15 Characters (14 official + one extra production character), 9 Props and 12 Drafts, with canonical revision 0. It never changes canonical revision.

## Proposed first real Velvet Moon observation (requires human approval)

**Do not start automatically.** Exact proposed request:

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

Observed technical facts already verified without model inference:

```text
source: out/history/20261126-144117031-d4dc/out-01.mp4
hash:   77e2f54ec72cd844995240c157500f48c57e6b18a9b0c6938de71721c237c292
range:  0–362 final frames @ 24 fps (15.083 s)
video:  1472×832, H.264
audio:  AAC 32 kHz stereo
cuts:   4 scene changes detected, 5 shots
```

The ASR stage uses `whisper-turbo`, `large-v3-turbo`, `device: auto`. The visual/comparison stage uses the internal Qwen3.8 observer. No new video is generated.

Approval is the explicit act of starting this request from a human session; no canonical decision is included in the request.

## Limitations

- The Qwen observer and comparison prompts are implemented and regression-tested with mocked outputs, but have **not** been run against Velvet Moon in this phase.
- ASR language/confidence are unavailable in the current adapter; speaker attribution is unknown.
- No diarization, voice identity, acting-quality, audio-mixing or lip-sync assessment.
- No Gemma 4 E4B audio-understanding adapter yet; the interface is reserved.
- Observation jobs are durable files but are not automatically resumed after a process restart; interrupted jobs are reported as lost/canceled with evidence retained.
- Evidence uses sampled frames; absence from a sample is not proof of absence.
- No external API or cloud inference is used.
