# AutoShorts / Video Factory

Open `#/app/autoshorts` (Video → Create). The workspace has three steps: **Créer** (topic and production settings), **Scènes** (one selected scene, with a thumbnail rail), **Exporter** (preview and final encoding). Advanced controls are collapsed. The last project reopens automatically; errors offer a resume action without discarding completed scenes. Start RiverField normally with `./start.sh` or `npm run serve`. After installing this change, restart the **web/MCP processes**, not ComfyUI; the registry is loaded at startup. FFmpeg/ffprobe with libx264 and libass must be on PATH. No new model weights or Python runtime are installed by this feature.

## Local setup

Run a locally installed llama.cpp server, for example:

```sh
llama-server -m /path/to/instruct-model.gguf --host 127.0.0.1 --port 8080
```

Use `http://127.0.0.1:8080/v1` in the Create panel. Model may be blank for the server default. The server must support OpenAI-style chat completions with `response_format: json_schema`. There is no API key. Storyboard JSON is validated (types, scene IDs, ordering, bounds); at most two repair retries follow an invalid answer. You can instead paste a storyboard manually. `/api/autoshorts/capabilities` exposes the exact config/storyboard schemas and all registry workflows and parameters.

Launchers that assign a random port (BlackRiver, for example) are handled by **Détecter les serveurs llama.cpp actifs** under « Connexion au LLM local »: the backend reads the running `llama-server` arguments, keeps loopback URLs only, and verifies `/v1/models` before listing them. `GET /api/autoshorts/llm-servers` returns the same list. The chosen URL is saved with the project, so a restart that changes the port requires running the detection again.

Inference endpoints and `COMFY_BASE_URL` must be loopback addresses. Hosted-demo use and remote inference are rejected. llama.cpp is user-managed: if its model occupies GPU memory, configure its offload/context accordingly before running diffusion. AutoShorts does not launch or kill model servers.

## Workflow

1. Create a project, enter a topic or script, language, mode, aspect, narrator, engines and resolution profile.
2. Generate a storyboard and edit its scene narration, prompts, order, duration and engine. Add scenes for intro/outro. FAST restricts expensive video diffusion; HYBRID plans mostly stills; CINEMA uses generated clips.
3. Produce. Existing Runner/History execute child workflows sequentially. Import files or reuse history through the media library. Asset paths are scoped to the project; path imports are limited to `RIVERFIELD_OUT`.
4. Review originals. Mark a scene accepted, or regenerate it. Accepted scenes may be upscaled; rejected/pending scenes never consume upscale compute. Optional local vision review inspects one frame and reports text, never automatically accepts a scene. Without a vision server, review manually.
5. Upscale and render, or opt explicitly into automatic acceptance for one-click production.
6. Preview/download MP4/SRT. Reopen projects in the selector. Canceling preserves completed stages. After restart, interrupted tasks offer Resume/retry; recorded child history runs are reused when still available.

Narration is per scene, through Chatterbox/OmniVoice (including their cloned-voice variants). Import a reference voice for cloning. OmniVoice tags and supported speech parameters are editable. Parameters/duration limits are validated by the actual app runner; unsupported H3 durations or resolutions fail with a range/option message instead of silently changing the engine. Long narration may require splitting a scene.

The timeline is an **editing** timeline, not an H3 reference window. Scene order, trim starts and source-sound retention are editable. FFmpeg probes inputs, normalizes geometry/FPS/audio, adds Ken Burns to stills, extends short clips by holding the last frame, and uses fade-through-black transitions. Narration determines minimum shot duration. Outputs are H.264/AAC MP4; normalized segments concatenate with stream copy. Crop is centered or contain/letterbox, not face tracking. Optional music is looped, mixed with sidechain ducking and limiting. Imported sound effects may be used as a soundtrack; there is not yet a multi-track SFX editor.

## Low resolution + RelayVSR

- Native: use the engine's default generation resolution, no upscale.
- x2: **0.4 MP** source, existing `relayvsr-upscale`, x2 DiT + x2 Flash VAE.
- x4: **0.2 MP**, x4 DiT + x4 Flash VAE. Experimental; not a measured speed claim.
- Custom: supported source MP and independent upscale factor.
- Auto: choose the fastest **measured, accepted** same-engine/aspect sample with scene duration within 20%, otherwise 0.4 MP + x2. This is a simple local heuristic, not a quality guarantee or a statistically controlled benchmark.

H3 Turbo's current 0.4/0.6/0.8 MP select **does not accept 0.2 MP**; AutoShorts does not extend it. Pika/LTX options use their actual manifest ranges. x4 multiplies width and height, hence **16× pixels**. The final editor resizes/reframes to the requested output (1080×1920 portrait, 1920×1080 landscape, 1080² square).

RelayVSR's existing one-step/cfg-1 recipe is unchanged. Originals and each upscaled artifact remain separately accessible. Changing only a custom upscale factor does not regenerate source video. Runner.prepare and the existing gateway own model switching/unloading; there is no second GPU manager. A shared FIFO admission queue covers **all web/MCP workflow submissions plus AutoShorts LLM, vision and speech-alignment requests**, retaining the slot through completion, not just submission. GPU/context failures block subsequent inference until services are restarted. CPU FFmpeg editing is separate. The gateway also waits for ComfyUI's running/pending prompt queue before model preparation. `GET /api/inference` reports the active operation and waiting jobs.

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

Actions: `plan`, `produce`, `media`, `audio`, `align`, `upscale`, `evaluate`, `music`, `render`. Individual scene actions require stable scene ID. `force:true` requests fresh media/audio/upscale; normal retries use dependency caches. `align` retimes existing narration without rerunning TTS. Successful CPU scene encodes are checkpointed for interrupted render retries. Only one task runs per project; the pipeline queue serializes production across projects. Other RiverField UI jobs still use the normal backend queue.

The additional `autoshorts` MCP tool supports `list`, `capabilities`, `create`, `get`, `edit`, `import`, `task`, `cancel`, with optional `project` and JSON `payload`. Start by reading capabilities. `get` returns an absolute project directory; combine it with relative export/asset paths. Poll it for durable task state. Existing nine MCP tools are unchanged, and child history IDs work with them. AutoShorts is not a single graph and intentionally cannot be submitted through `run_app`.

## Validation / limits

`npm test` includes real FFmpeg synthetic exports (two scenes, speech, music ducking, ASS karaoke, MP4/SRT probing), mocked local structured LLM/workflow outputs, cache retries, stale narration rejection, recovery, cancellation, containment, profile calculations and RelayVSR pairing/review gates. No expensive diffusion inference is required by tests.

Not yet validated: a full real llama.cpp → actual GPU TTS/H3/LTX → RelayVSR production on this machine. No new speed or quality claims. Forced alignment, face-aware cropping, cross-dissolves, arbitrary multi-track SFX, and a graphical draggable/trim-handle timeline remain incomplete. Current controls perform real operations, not simulated previews.
