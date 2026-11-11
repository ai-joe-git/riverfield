# Cinematic pilot: staged authorization

No inference was run for the software tests. All generation tests use mocks.

Preflight checks prompt sections, dialogue syntax/length, declared speakers, local picture bindings and H3 geometry. It does not reproduce the backend video slicer: Video/paired-Audio ordinals still require the actual planner's material manifest, not a global upload count. The pilot has only pictures.

## Stage 1 — references (awaiting authorization)

The exact two proposed MCP calls are in [cinematic-pilot-reference-calls.json](cinematic-pilot-reference-calls.json).
They create one landscape 16:9 character sheet (large detailed face portrait on the left, aligned full-body front/profile/back views on the right) and one separate empty portrait studio, both with MOSS at eight steps. The landscape sheet is an identity reference, not the video aspect.

After authorization, retrieve the real outputs and display both for review. Inspect the images before discussing identity or suitability. Do not generate a combined reference. If a correction is needed, separately propose a `qwen-image-edit-turbo` call with the actual source path and the requested edit.

## Stage 2 — one video (not yet authorized)

Concise screenplay: one nervous contestant stands at the podium. The offscreen director says “On la refait.” The contestant replies “Oui, je suis prêt.” He forces a small smile. No narrator or music; no second visible person.

Use `plan_segments` with `seconds: 5`, `total_seconds: 5`, one six-section Ref2VA prompt, and `segment_images: [[0, 1]]`. Local Picture 1 is the approved character sheet; Picture 2 is the approved empty environment. Define Subject 1 as the single contestant, Subject 2 as the environment, S1 as the visible contestant and S2 as the offscreen director. The native dialogue lines are:

```text
The offscreen director (S2) says firmly, <d>[French] On la refait.</d>
Then the candidate (S1) replies nervously, <d>[French] Oui, je suis prêt.</d>
```

The legal window is `[0,124)` at 24 fps (5.1667 seconds after H3 rounding). Do not invent a 120-frame boundary or change the requested aspect. Preserve the returned JSON string unchanged.

Before video inference, show the complete intended `run_app` arguments, including the real approved file paths. Use `pika-studio-director`, `flex_mode: ref2va`, exact `aspect: "9:16 (Portrait Widescreen)"`, `megapixels: 0.4`, `duration: 5`, `segment_count: 1`, `video_audio: true`, and a fixed seed. Keep the workflow's LCM/six-step recipe untouched. Do not fabricate paths now: the references have not been generated.

Retrieve the succeeded job's real output, verify dimensions/duration/audio presence, and stop for review. Metadata does not prove identity, dialogue correctness or lip sync. No remaining scenes or upscale are authorized. RelayVSR is unchanged and available for separately authorized utility work.
