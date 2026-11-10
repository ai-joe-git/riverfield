# Managed llama.cpp Vulkan runtime

Open **Agent → Models & connections → Managed GGUF runtime · Vulkan**.
The inspector and option mapping are adapted from the BlackRiver Workspace 6.13.73
source supplied for this integration. BlackRiver configuration, credentials and
process ownership are not imported.

## Model profiles

- Choose an installed `llama-server` executable and a local GGUF. Detected binaries
  include BlackRiver's installations; using a binary does **not** adopt its running server.
- Browse a model directory or enter absolute paths. GGUF header/metadata inspection
  does not read tensor payloads or prove that a build supports the model architecture.
- Each profile has its own settings. A different GGUF requires a new profile.
  Vision projector and external draft paths are explicit: never inherited or auto-paired.
- Defaults: **32,768 context tokens, one slot, 256/64 batch/microbatch, Q8 KV,
  no speculative decoding, no auxiliary GGUF**. Context is allocated at load time;
  changing a request's output cap does not shrink an already allocated KV cache.
- 55 structured controls cover context, threads/batches, Flash Attention, load mode,
  KV placement/quantization, fit, device/tensor splits, CPU MoE, vision, MTP/draft,
  and sampling. Unadvertised non-default flags fail before launch; parameter values
  and tensor compatibility are still subject to the selected build and model.
- **Expert → Read executable help** exposes the exact build's searchable options.
  Additional flags use checked argv, not a shell. Endpoint, credential and dedicated
  parameter flags cannot be overridden through expert aliases.
- **Save profile** does not load anything. **Use for agent** creates a managed
  connection; select it in **Choose model**. Output budgets/tool protocol remain in
  the connection settings. Load-time and sampling settings come from the GGUF profile.
- **Load / reload**, **Unload**, effective argv and bounded logs are available.
  Unload can cancel an active startup; otherwise controls wait for the GPU queue.

Profiles are private JSON under `out/native-runtime/` (or `RIVERFIELD_OUT`).
The runtime binds to loopback on a free port with an ephemeral server-side API key;
the key is not persisted or returned in status, logs or effective argv.
Riverfield only signals child processes
it started and waits for their exit. SIGTERM/SIGINT shut those children down; a hard
OS kill of the web process is not a graceful shutdown.

This integration uses existing local GGUFs and binaries. It does not download models,
install/update BlackRiver, or replace a missing Vulkan binary automatically.

## GPU memory handoff

All managed local inference shares the existing FIFO studio queue:

1. Before a media job: stop the managed LLM and confirm process exit.
2. Run the media job through actual backend completion, not just submission.
3. Before reloading the LLM: ask the **local** gateway to release ComfyUI models.
4. The gateway waits for its worker release flags to clear, zero loaded models,
   zero PyTorch GPU allocator reservations and an idle queue over four observations.
5. Load the GGUF, read effective context when advertised, and replay the persisted
   conversation/project state. Reloading loses the process's KV cache, not the chat.

Restart the local backend using `./run-backend.sh` or
`python tools/local_backend.py serve …` to install the small memory-acknowledgement
bridge. For a separately managed ComfyUI, copy
`local/riverfield-memory-bridge/` into its `custom_nodes/` and restart it, along with
the updated gateway. No ComfyUI core files are patched.

Missing bridge, backend disconnection, active external work, or unconfirmed allocator
release **blocks LLM reload** rather than guessing that memory is free. Builds/plugins
that retain permanent GPU allocations may therefore require manual investigation.
Other clients can still submit work outside Riverfield's queue; there is no global
cross-application GPU lock.

External local and remote API providers remain supported. Riverfield never kills or
unloads their servers. **Unload the previous BlackRiver-managed model yourself when
migrating**, otherwise it will remain resident alongside Riverfield's workloads.
The weights-plus-OS-reserve check is only a lower bound: context, tensors and video
workspace can still exceed memory; this is not an OOM guarantee.

## Agent consistency

**Conversation settings → Project & consistency** stores a creative brief, working
summary, canonical character/location/prop assets, scene requirements and active scene.
The local `project_state` tool maintains the plan; updates respect approval/read-only
mode and cannot change the user's brief or engine locks. Actual asset IDs are required.
The compact state, available asset IDs/paths and latest job statuses survive history
trimming and are supplied on subsequent model calls.

An explicit app lock applies only to its studio, leaving other studios free to prepare
references. For example, lock video to `pika-studio-director` and
`{"flex_mode":"ref2va"}`. The server rejects substitution and missing required
canonical scene references. A matching seed is not treated as identity verification.

For H3 Director workflows, the read-only `plan_segments` tool computes legal lengths
and overlaps. Server preflight checks prompt coverage, frame geometry and supplied
reference slots **before recording or queueing a GPU job**. It does not choose a video
engine or silently rewrite the user's timeline. Lost-job retries are limited to one
per identical generation per turn, and successful jobs remain non-duplicable.

These safeguards prevent specific observed mistakes; they do not make a model's
creative choices or visual/audio claims automatically correct.

## Validation

- `npm test`, `npm run typecheck`, `npm run validate`.
- Gateway tests: `python -m unittest discover -s test -p gateway_release_test.py -v`
  in an environment with `aiohttp` (no GPU/model initialization).
- Native lifecycle tests use tiny scripted HTTP fixtures, including cancellation and
  queue order. A separate local smoke check loaded the existing Qwen3.5 0.8B GGUF
  with Vulkan, streamed `OK`, and confirmed its child exited on unload.
- Browser checks cover profile persistence, all 264 distinct option groups advertised by the tested
  binary, managed provider creation, project locks and mobile layout, without media
  generation. Full real ComfyUI ↔ LLM handoff remains to be exercised after backend restart.
