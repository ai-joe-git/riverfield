# AutoShorts Cinema: local model recipes and preparation

Cinema is an experimental local production workflow, not a qualified DramaBox-style
episode generator. A successful storyboard or unit test does not establish visual,
acting, voice or editing quality.

## Source of the prompt formats

Reviewed on 9 November 2026 against:

- [Pika H3 Flex prompt guide](https://github.com/Pika-Labs/Pika-H3-Flex/blob/main/docs/prompt-guidance.md)
- [MiniMax H3 prompting guidance and model variants](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/README.md#prompting-guidance)
- The actual RiverField manifests/workflows and local ComfyUI conditioning nodes.

`server/autoshorts-recipes.ts` compiles these formats locally. It does not call
Pika's hosted rewriter or MiniMax's hosted Context-IR service, and does not reproduce
those proprietary orchestration systems. Samplers, LoRAs and schedules stay in the
existing app workflows; prompt formatting does not qualify a new sampling recipe.

## Prompt and input contracts

**Cinema defaults to the existing Pika Studio Director** (`pika-studio-director`):
AutoShorts is the producer, the director stays the video engine. It reuses the director's
locked LCM sampler, 6-step sigma schedule, Ref2VA model/LoRA pairing, `image1..9` /
`video1..3` / `audio1..3` inputs and the Material Planner timeline. AutoShorts builds the
`segment_windows` document automatically (geometry mirrors `h3_planner.py`: 24 fps,
`5+17n` lengths, 39-frame seams) and binds the approved canonical sheets to the slots.

| Workflow | Conditioning in AutoShorts Cinema | Compiled prompt |
|---|---|---|
| **Pika Studio Director (default)** | Ref2VA through the Material Planner: canonical sheets bound to `image1..9`, one segment per shot, batched by `cinemaSegmentsPerRun` | Per-segment `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music` |
| Pika Video (FL2VA option) | FL2VA: reviewed opening image, optionally a reviewed ending image | Endpoint alignment first; `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music` |
| H3 R2V Flex / H3 R2V | Ref2VA single-app route (still available): canonical images + composition keyframe | Same reference-role fields |
| H3 Video / Turbo | Text-only app inputs | Not reference-capable; choose the director or a Ref2VA app for Cinema |

Canonical references are **multi-view identity sheets** (consistent angles of one entity),
reused across every shot rather than regenerated per shot. Turn on **FL2VA first/last-frame
mode** only for precise endpoint conditioning; it is not the default for recurring characters.

Ref2VA no longer receives only a generic keyframe. Each supplied image has a named
role, an exact workflow input (`image1`, `image2`, ...), a real `<Picture N>` marker,
and a corresponding `<Subject N>` preservation/composition instruction. It never
invents reference numbers. Reference counts are checked against the actual app slots.
AutoShorts' compiled Cinema reference path currently supports these reviewed images,
not arbitrary extra video/audio references. Use the standalone reference app for
more complex multimodal inputs; they are not silently interpreted or dropped.

Pika endpoint prompts use the H3 frame grid for the ending timestamp: a nominal
five-second shot ends at approximately 5.17 seconds. Pika prompts over 8,000 characters
are rejected instead of silently dropping identity descriptions. Dense dialogue is
flagged for review rather than treated as guaranteed to fit.
Prompts ask for action/speech to finish before the nominal cut and hold the ending
pose through the frame-grid tail. New Cinema projects use hard cuts by default;
existing/explicit fade settings are preserved. Timing still needs actual clip review.

## What happens when you press Prepare / Produce

1. **Missing canonical sheets:** generate the multi-view identity/vehicle/location
   sheets sequentially using the configured local image app, then enter `waiting_review`.
2. **Canonical review:** approve or regenerate/import each identity, vehicle,
   location or prop in the visible **Cinema / Production checklist**.
3. **Director plan:** with the default director route, the storyboard is turned into
   `segment_windows` and the compiled Ref2VA prompts are shown for review (no per-shot
   keyframe is needed — the canonical sheets are the references). The FL2VA option
   instead composes opening/ending images through the image-editing workflow and asks
   for their approval.
4. **Video:** generate the reference-conditioned clips through the director (one run per
   shot by default; `cinemaSegmentsPerRun` groups consecutive compatible shots into a
   single multi-segment run and splits the result on the CPU), then wait for clip review
   unless automatic clip acceptance was chosen.
6. **Upscale/export:** reuse accepted clips, apply only the required RelayVSR factor,
   and export using the existing persistent pipeline and provenance manifest.

`waiting_review` is a normal terminal task status, not a failed inference or a
background process holding the GPU queue. Press Prepare/Continue after approval.
Repeated preparation reuses unchanged assets; regeneration is explicit. Real backend,
model or FFmpeg failures are still reported as failures. No stages secretly approve
canonical references or keyframes on the user's behalf.

The API `get` response includes `readiness`, missing/review counts, per-shot recipes,
image prompt previews, exact compiled video prompts and input bindings. MCP uses the
same actions and state. Existing exports remain accessible without regenerating them.

## Native dialogue, not an imposed narrator

New Cinema projects default to `cinemaAudio: native`. The planner leaves external
narration empty and generates requested character speech as `dialogueLines`:

```json
{
  "speakerId": "anna",
  "text": "Tu m'as menti.",
  "delivery": "quietly, disappointed",
  "language": "fr"
}
```

The speaker must be a canonical character referenced by the shot. Stable project
speaker labels produce native model instructions such as `(S1)` and
`<d>[French] Tu m'as menti.</d>`; delivery and identity stay outside the speech tags.
Dialogue is not copied into the ambient sound field or automatically synthesized
through TTS. Visual/action directions should be English; dialogue retains its
requested language.

External narration remains an explicit project/per-shot opt-in. Existing saved
narration files are retained, not deleted. Old API clients which omit the new policy
keep their legacy narration behavior; the UI presents the native Cinema policy
explicitly when opening an older project. Explicit native/full mutes still apply.

The optional **vertical micro-drama** direction preset asks the local planner for
a hook/conflict/reaction/reveal/cliffhanger, manageable action and short dialogue
beats, stable eyelines and explicit opening/ending states. It is a planning style,
not a guarantee of dramatic performance or professional editing.

## Image preparation is also prompt-specific

Canonical prompts distinguish a single actor/wardrobe reference, a complete vehicle,
an empty location and an isolated prop. Shot-image editing prompts ask for one exact
opening or ending pose, not a whole sequence of actions in a single still. Canonical
and shot-image prompts can be inspected/overridden in the checklist. Raw JSON is
an optional advanced tool, not the normal way to prepare assets.

## Verification and remaining work

Tests cover prompt formats, real input numbering, dialogue language/speaker tags,
image-role prompts, endpoint timing, native-default/no-TTS behavior, cached
preparation and all review gates, with synthetic files and mocked model execution.
No new image, LLM, TTS or video inference was run to qualify this revision.

Still unqualified: recurring actor/voice identity across real GPU clips, exact
lip-sync and dialogue timing, longer dramatic arcs and professional cut quality.
Native voices use prompt descriptions, not a guaranteed shared voice embedding.
Automatic transcription/caption alignment for native dialogue, source separation,
and a full episode-level continuity/editorial system remain future work. Review
actual frames and sound before spending on a full episode; do not interpret passing
software tests as a creative-quality benchmark.
