# AutoShorts / Video Factory

Open `#/app/autoshorts` (Video → Create). The English workspace has three steps: **Create** (topic and production settings), **Scenes** (one selected scene, with a thumbnail rail), **Export** (preview and final encoding). Advanced controls are collapsed. The last project reopens automatically; errors offer a resume action without discarding completed scenes. Start RiverField normally with `./start.sh` or `npm run serve`. After installing this change, restart the **web/MCP processes**, not ComfyUI; the registry is loaded at startup. FFmpeg/ffprobe with libx264 and libass must be on PATH. No new model weights or Python runtime are installed by this feature.

## Local setup

Run a locally installed llama.cpp server, for example:

```sh
llama-server -m /path/to/instruct-model.gguf --host 127.0.0.1 --port 8080
```

Use `http://127.0.0.1:8080/v1` in the Create panel. Model may be blank for the server default. The server must support OpenAI-style chat completions with `response_format: json_schema`. There is no API key. Storyboard JSON is validated (types, scene IDs, ordering, bounds); at most two repair retries follow an invalid answer. You can instead paste a storyboard manually. `/api/autoshorts/capabilities` exposes the exact config/storyboard schemas and all registry workflows and parameters.

Planning sends the exact JSON field structure to the model as well as a sampling
grammar; a grammar alone does not teach entity IDs, counts or reference semantics.
Cinema methods/engines are constrained to video and the chosen engine. Explicit
whole-film English directives such as “exactly two shots”, “no narrator”, “no spoken
dialogue” and “no background music” additionally constrain the plan. Hook/closing
can be visual beats and no longer force unwanted narration. These literal checks
are not a general natural-language requirements parser; review the storyboard.

Planning requests disable optional template thinking (`enable_thinking: false`)
and cap completion output at 8192 tokens. Each attempt saves its request, response
and exact validation errors locally in `planning/<task-id>/attempt-N.json`. The task
and error panel link to the last diagnostic file; do not publish it indiscriminately
because it includes the full brief and model output. Truncated completions are
rejected, and cancellation aborts the active HTTP request. A three-attempt failure
reports the actual last errors rather than only a generic rejection message.

Launchers that assign a random port (BlackRiver, for example) are handled by **Detect running llama.cpp servers** under **Local LLM connection and advanced settings**: the backend reads the running `llama-server` arguments, keeps loopback URLs only, and verifies `/v1/models` before listing them. `GET /api/autoshorts/llm-servers` returns the same list. The chosen URL is saved with the project, so a restart that changes the port requires running the detection again.

Inference endpoints and `COMFY_BASE_URL` must be loopback addresses. Hosted-demo use and remote inference are rejected. llama.cpp is user-managed: if its model occupies GPU memory, configure its offload/context accordingly before running diffusion. AutoShorts does not launch or kill model servers.

## Workflow

1. Create a project, enter a topic or script, language, mode, aspect, narrator, engines and resolution profile.
2. Generate a storyboard and edit its scene narration, prompts, order, duration and engine. Add scenes for intro/outro. FAST restricts expensive video diffusion; HYBRID plans mostly stills; CINEMA uses generated clips and plans a visual bible plus explicit per-shot continuity state.
3. Produce. Existing Runner/History execute child workflows sequentially. Import files or reuse history through the media library. Asset paths are scoped to the project; path imports are limited to `RIVERFIELD_OUT`.
4. Review originals. Mark a scene accepted, or regenerate it. Accepted scenes may be upscaled; rejected/pending scenes never consume upscale compute. Optional local vision review inspects one frame and reports text, never automatically accepts a scene. Without a vision server, review manually.
5. Upscale and render, or opt explicitly into automatic acceptance for one-click production.
6. Preview/download MP4/SRT. Reopen projects in the selector. Canceling preserves completed stages. After restart, interrupted tasks offer Resume/retry; recorded child history runs are reused when still available.

Narration is per scene, through Chatterbox/OmniVoice (including their cloned-voice variants). Import a reference voice for cloning. OmniVoice tags and supported speech parameters are editable. Parameters/duration limits are validated by the actual app runner; unsupported H3 durations or resolutions fail with a range/option message instead of silently changing the engine. Long narration may require splitting a scene.

### Native audio and dialogue

New scenes preserve native clip audio by default. `keepAudio: false` explicitly mutes
the native track; saved projects are not silently migrated. `speechMode` is `auto`,
`narration`, `native` or `mute` (all scene audio). `dialogue` is character speech for
the video engine; `narration` is external TTS. Auto skips duplicate TTS when the
dialogue and narration are identical; native/mute skip TTS entirely. With narration,
native sound is ducked only while TTS is active, rather than discarded or constantly
attenuated. After speech it returns to normal gain. Native sound is read from the
original clip even when the selected visual input is a RelayVSR result.

Existing TTS remains reusable. Moving a line into native dialogue changes video
generation inputs and requires explicit regeneration, not just an audio-only render.
Native dialogue is not automatically captioned or semantically deduplicated against TTS.

### Visual continuity review

Cinema planning creates `board.visualBible`: `style`, `timeOfDay`, `lighting` and
`entities` (stable `id`, `kind`, `description`, `traits`, `reference`, `approved`).
Each scene's `continuity` lists `entityIds`, `settingId`, `timeOfDay`, `lighting`,
`counts`, `transition` and `notes`. Canonical character IDs represent individuals,
not interchangeable extras. Day/night/color contradictions and duplicate individuals
are checked conservatively; this does not replace human review.

In Scenes, expand **Visual continuity bible · canonical references**. Import references
or run `references` to generate missing ones through the local image engine. Review
each canonical image and approve it. Then run per-scene `keyframe`: the server builds
a CPU contact sheet and calls `config.keyframeEngine` (`edit` by default) to compose
one consistent shot. Review/approve it with `approve-keyframe` before footage generation.
Changing identity descriptions/references invalidates approval; re-preparing unchanged
keyframes reuses them, while the regeneration control explicitly requests a fresh image.

Pika Text to Video routes to Pika Video for these reviewed first-frame inputs. Other
chosen engines must support image references; use e.g. H3 R2V Flex instead of a
text-only H3 engine. Every independent shot prompt expands the relevant bible identities,
setting, lighting and state. All inference still uses the existing queue. Old footage
may be re-exported without a bible; new multi-shot Cinema generation cannot proceed
without it. Consistency is not guaranteed: review and regenerate bad keyframes/clips.

The timeline is an **editing** timeline, not an H3 reference window. Scene order, trim starts and source-sound retention are editable. FFmpeg probes inputs, normalizes geometry/FPS/audio, adds Ken Burns to stills, extends short clips by holding the last frame, and uses fade-through-black transitions. Narration determines minimum shot duration. Outputs are H.264/AAC MP4; normalized segments concatenate with stream copy. Crop is centered or contain/letterbox, not face tracking. Optional music is looped, mixed with sidechain ducking and limiting. Imported sound effects may be used as a soundtrack; there is not yet a multi-track SFX editor.

## Low resolution + RelayVSR

- Native: use the engine's default generation resolution, no upscale.
- x2: **0.4 MP** source, existing `relayvsr-upscale`, x2 DiT + x2 Flash VAE.
- x4: **0.2 MP**, x4 DiT + x4 Flash VAE. Experimental; not a measured speed claim.
- Custom: supported source MP and independent upscale factor.
- Auto: choose the fastest **measured, accepted** same-engine/aspect sample with scene duration within 20%, otherwise 0.4 MP + x2. This is a simple local heuristic, not a quality guarantee or a statistically controlled benchmark.

H3 Turbo's current 0.4/0.6/0.8 MP select **does not accept 0.2 MP**; AutoShorts does not extend it. Pika/LTX options use their actual manifest ranges. x4 multiplies width and height, hence **16× pixels**. The final editor resizes/reframes to the requested output (1080×1920 portrait, 1920×1080 landscape, 1080² square).

RelayVSR's existing one-step/cfg-1 recipe is unchanged. Originals and each upscaled artifact remain separately accessible. Changing only a custom upscale factor does not regenerate source video. Runner.prepare and the existing gateway own model switching/unloading; there is no second GPU manager. A shared FIFO admission queue covers **all web/MCP workflow submissions plus AutoShorts LLM, vision and speech-alignment requests**, retaining the slot through completion, not just submission. GPU/context failures block subsequent inference until services are restarted. CPU FFmpeg editing is separate. The gateway also waits for ComfyUI's running/pending prompt queue before model preparation. `GET /api/inference` reports the active operation and waiting jobs.

AutoShorts disables Pika's internal upscale when generating sources. Existing Pika
child-workflow artifacts record/recover their actual internal factor from history, so a total x2
does not accidentally become x4. Rendering selects `state.upscale.path` only when
an external pass is required and valid. New exports include `provenance.json` with
selected source paths, hashes, measured geometry, effective factors and audio inputs;
the export screen exposes it. Assembly-version changes invalidate old render caches.
An arbitrary imported clip is treated as a source at its current resolution; it has
no inferred pre-import upscale history. Choose Native to avoid further upscale on such a clip.

Calls made directly by an external client to llama.cpp, the CLI runner or ComfyUI bypass the web admission queue; RiverField cannot guarantee exclusivity for those independent clients. They must participate in the same orchestration or refrain from submitting concurrent inference. Models remaining loaded in RAM are not, by themselves, parallel inference.

Per-scene workflow and upscale execution seconds are recorded; separate model-loading seconds are **unknown/null**, since the backend does not expose them. Encoding and total task wall times are recorded separately.

## Captions and evaluation

Default timing is explicitly **approximate**, distributing narration text over the real generated audio duration. Optional local transcription uses `<alignUrl>/audio/transcriptions`, `verbose_json` + word timestamps (e.g. a local compatible Whisper server). This improves word timing but is **not forced alignment** to the exact script. Failure falls back to approximate timing with a visible explanation. A dedicated forced aligner remains future work. Caption override text is also approximately timed.

Captions export as SRT; burn-in uses ASS/libass with readable outlined text, fade animation and optional karaoke highlighting. Local vision evaluation uses an OpenAI-compatible loopback vision endpoint with a JPEG frame. It is a single-frame advisory check, not temporal video QA.

## Persistence / API / MCP

`out/autoshorts/<uuid>/` (or `$RIVERFIELD_OUT/autoshorts/`) contains atomic `project.json`, `storyboard.json`, `assets/`, `scenes/`, `audio/`, `upscaled/`, `subtitles/`, `exports/<dependency-hash>/`. Exports contain MP4, SRT, ASS and CPU intermediate segments. Completed artifact keys prevent repeat inference. Editing one narration invalidates that narration; subtitle/music/edit changes do not invalidate video diffusion. Older artifacts are retained, not overwritten. Child generations are ordinary RiverField history entries. Final exports belong to project history, not the single-graph History feed.

HTTP:

```text
GET   /api/autoshorts                       list projects
POST  /api/autoshorts                       create (configuration JSON)
GET   /api/autoshorts/capabilities           exact schemas + workflow registry
GET   /api/autoshorts/:id                    state, absolute directory, assets
PATCH /api/autoshorts/:id                    {config?, board?}; no edits during a task
POST  /api/autoshorts/:id/import             multipart file, or {path} inside output root
POST  /api/autoshorts/:id/tasks              {action, scene?, force?}
POST  /api/autoshorts/:id/cancel
GET   /api/autoshorts/:id/files/<path>       seekable project artifact
```

Actions: `plan`, `produce`, `media`, `audio`, `align`, `upscale`, `evaluate`, `music`, `render`, `references`, `keyframe`, `approve-keyframe`. Individual scene actions require stable scene ID. `force:true` requests fresh media/audio/upscale/keyframes; normal retries use dependency caches. `align` retimes existing narration without rerunning TTS. Successful CPU scene encodes are checkpointed for interrupted render retries. Only one task runs per project; the pipeline queue serializes production across projects. All web/MCP model calls share the same inference admission queue.

The additional `autoshorts` MCP tool supports `list`, `capabilities`, `create`, `get`, `edit`, `import`, `task`, `cancel`, with optional `project` and JSON `payload`. Start by reading capabilities. `get` returns an absolute project directory; combine it with relative export/asset paths. Poll it for durable task state. Existing nine MCP tools are unchanged, and child history IDs work with them. AutoShorts is not a single graph and intentionally cannot be submitted through `run_app`.

## Validation / limits

`npm test` includes real FFmpeg synthetic exports (two scenes, speech, music ducking, ASS karaoke, MP4/SRT probing), mocked local structured LLM/workflow outputs, cache retries, stale narration rejection, recovery, cancellation, containment, profile calculations and RelayVSR pairing/review gates. No expensive diffusion inference is required by tests.

Real local six-scene productions have completed, including generated speech/media, RelayVSR x2 video scenes and final MP4 export. This is not validation of every engine, mode or x4 combination, nor a speed or quality benchmark. Forced alignment, face-aware cropping, cross-dissolves, arbitrary multi-track SFX, and a graphical draggable/trim-handle timeline remain incomplete. Current controls perform real operations, not simulated previews.
