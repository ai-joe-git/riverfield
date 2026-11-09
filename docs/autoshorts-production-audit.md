# AutoShorts Cinema audit — 9 November 2026

## Production examined

`out/autoshorts/a63e32c2-c9c0-4805-b03d-df0d3b3ddbc4/`
— **Doña Rosa's Midnight Delivery**, six five-second Cinema scenes.
All original source files, RelayVSR results, speech and the first export are retained.
No GPU inference was launched during the audit or repair.

## Upscale: correct, not a path-selection bug

| Scene | Original video (ffprobe) | RelayVSR result (ffprobe) | Original assembly segment |
|---|---|---|---|
| scene_1 | 544×960, 5.166688 s | 1088×1920, 5.166688 s | 1080×1920, 5.000000 s |
| scene_2 | 544×960, 5.166688 s | 1088×1920, 5.166688 s | 1080×1920, 5.000000 s |
| scene_3 | 544×960, 5.166688 s | 1088×1920, 5.166688 s | 1080×1920, 5.000000 s |
| scene_4 | 544×960, 5.166688 s | 1088×1920, 5.166688 s | 1080×1920, 5.000000 s |
| scene_5 | 544×960, 5.166688 s | 1088×1920, 5.166688 s | 1080×1920, 5.000000 s |
| scene_6 | 544×960, 5.166688 s | 1088×1920, 5.166688 s | 1080×1920, 5.000000 s |

The first MP4 is 1080×1920, **30.013333 s**, including container/audio rounding.
Its export key is `1980bcbd47b42957a2729f72`.

Evidence, beyond reading the source code:

- Reconstructing the old export dependency key with the six **`state.upscale.path`**
  inputs produces exactly the saved key above.
- Re-encoding each segment from its upscaled input with the original assembly
  arguments reproduces the saved **encoded video stream SHA-256 exactly**, all six scenes.
- Every Pika history entry submitted `megapixels: 0.5` and `upscale: ""`.
  RelayVSR was a separate x2 stage, not an internally upscaled Pika result.
- Project settings: `profile: custom`, `megapixels: 0.5`, `factor: 2`.
  Each scene has `profile: auto`, so it inherits these settings. Its saved
  default `megapixels: 0.4`/`factor: 2` is **not** an active scene override.
  The planner's prose instruction mentioning 0.98 MP is not an execution parameter.

There was **no double-upscale in this film**. A preventive fix now disables Pika's
internal upscale when AutoShorts generates source footage. For existing artifacts,
the submitted history or recorded generation metadata determines the internal
factor: an internal x2 satisfies a total x2, and only needs external x2 for total x4.
An incompatible/unknown factor fails explicitly instead of blindly stacking passes.
This recovery applies to recorded AutoShorts child jobs. Arbitrary imported clips
have no recoverable pre-import processing history and are treated at their current
resolution; choose Native if they should not be enlarged further.

## Audio: confirmed assembly defect

All six original and upscaled videos contain native audio. All six scene objects
had `keepAudio: false`, supplied by the old scene default. The assembler therefore
used only TTS, padding it to five seconds. TTS lengths were **3.64, 3.07, 3.05,
2.88, 3.32 and 2.04 s**; padding alone accounts for 12 seconds, with additional
pauses in speech accounting for further near-silence.

The repair explicitly enables native audio **only in these six audited scenes**,
as requested. It does not globally rewrite other projects' mute settings.
Original JSON is backed up before this targeted change.

Native audio now comes from the original clip, even if the visual input is the
RelayVSR result. It stays at normal gain without narration; during optional TTS,
a sidechain compressor ducks it (ratio 4, 20 ms attack, 250 ms release), then
releases. Mixing no longer implicitly halves both inputs. A limiter controls peaks.
Explicit native mute and full scene mute remain supported. Missing sound is
padded, not fabricated into engines, ambience or dialogue.

| Scene | Near-silence before | Near-silence after |
|---|---|---|
| 1 | 2.065 s | 0.708 s |
| 2 | 2.483 s | 0.322 s |
| 3 | 2.608 s | 0.424 s |
| 4 | 2.239 s | 0.000 s |
| 5 | 1.799 s | 0.247 s |
| 6 | 3.079 s | 0.545 s |

Detector: `silencedetect=noise=-40dB:d=0.15`, on decoded audio. Across the **final
MP4**, near-silence falls from **14.521 s to 2.433 s**. Per-segment totals differ
slightly because concat/AAC boundaries affect silence detection. Different
thresholds explain differences from the user's approximate 13.7 s measurement;
at -50 dB the measured totals are 13.945 s and 2.324 s.

Repaired export: `exports/5afbef35f41f0155c84b1cfe/final.mp4`.
Its **final encoded video stream is byte-identical to the first export**, as are
all six segment video streams. The existing images and edit are unchanged.
`provenance.json` records selected paths, source SHA-256, actual dimensions,
factors, project/scene resolution settings, narration and native-sound sources.

## Continuity: real limitations, not repaired footage

Sampled frames show two grandmother-like women in shot 1, a different red sports
car in shot 2, an open-frame buggy with different occupants in shot 3, and daylight
in later shots despite the midnight brief. Every shot was independent text-to-video
with **no reference inputs**. Several prompts omitted the full character/car/time
descriptions. A shared seed did not prevent drift.

The implemented continuity workflow adds:

1. A **visual bible** of canonical characters, vehicles, settings and props, with
   descriptions, explicit traits, time of day, lighting and reviewed reference images.
2. Per-shot **explicit state**: entity IDs/counts, setting, time, lighting and any
   intentional transition. Validation catches unknown/duplicate IDs, duplicated
   canonical characters, unannounced time changes and obvious day/night/color conflicts.
3. Canonical-image preparation through the existing local image engine, or import.
4. A CPU reference sheet and a **local image-editing workflow** (`edit` by default)
   to compose a keyframe from the canonical identities. Keyframes must be reviewed.
5. Reference-capable generation: Pika text-to-video scenes route to **Pika Video**
   with the reviewed first frame. Other selected video engines must expose image
   references or fail with a request to select a reference-capable engine.
6. Fully expanded, self-contained shot prompts and recorded generation references.
   Changing canonical descriptions/references invalidates approval and stale footage.

New character lines live in `dialogue` and go to the video's native speech prompt;
`narration` is optional off-screen TTS. Native/mute speech modes skip TTS, and auto
mode avoids synthesizing an identical dialogue/narration string twice. This is not
ASR-based semantic speech deduplication. The repaired old film retains its existing
TTS tracks, including the closing line; it does not magically acquire lip-synced
character delivery that the original video prompt did not request.

A validated proposal is saved separately as
`audit/20261109-audio-repair/continuity-storyboard-draft.json`. It defines the cast,
car, midnight settings and revised shots, with the final line in native dialogue.
It is **not applied to the old footage**, and none of its proposed reference images
is claimed to exist or be approved. Applying it is a deliberate future regeneration.

## Verification and remaining limits

Regression tests use synthetic FFmpeg clips and mocked local workflows: source path
selection, factors/overrides, legacy internal-upscale history, disabled nested Pika
upscale, sound retention, TTS ducking/release, native/full mute, versioned export
caches/provenance, continuity validation, reference/keyframe review gates and Pika
reference routing. Existing AutoShorts synthetic export tests also run.

No new 30-second benchmark, canonical-image diffusion or reference-conditioned video
was run. Visual identity is **not guaranteed**; inspect canonical images, keyframes
and clips and use regeneration controls when needed. Existing visual drift remains.
Rule-based checks cannot understand every screenplay or detect all visual/model
contradictions. Source separation, native dialogue transcription/caption timing,
lip-sync repair and semantic duplicate-speech detection are not implemented here.

Local audit evidence (full filenames, probes, original JSON, original export-key
reconstruction, per-segment video comparisons and repair log) is retained under
`audit/20261109-audio-repair/` inside the project. Production media is not committed.
