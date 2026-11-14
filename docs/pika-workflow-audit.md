# Audit of the actual Pika Director contract

Inspected the API graph and manifest in `apps/pika-studio-director`, the exported `/home/zardoz/Downloads/RiverField_Director_studio.json`, Riverfield's real `h3_planner.py`, its Director panel, and the installed native TimelineDirector/finite sampler implementation. The exported ComfyUI file was not modified.

## Defaults and models

| Setting | Effective stable Agent default |
| --- | --- |
| Generation | 175 frames / 24 fps, 39-frame overlap |
| Pika sampler | LCM |
| Pika sigmas | `1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0` = six steps |
| Pika LoRA strength | 1 |
| Resolution budget | 0.4 MP, multiple 32; preserve the selected aspect |
| Pika SLA sparsity | 0.85 |
| Effective text encoder | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`, from the app default |
| Video/audio VAEs | Existing Lynnreal light / H3 audio FP32 |
| Continuation | Existing `continue_audio_latent:match`, `ref_image_size:match` |
| Two-stage SelfLift | Off; do not substitute it for RelayVSR or switch Pika to Euler |
| Delivery recommendation | Existing separate RelayVSR app, x2 default, x4/off optional, normal approval |

The exported Director file contains **Euler/simple** and eight **edited, variable-length** windows. It is neither the locked LCM Pika API recipe nor a fresh uniform-default timeline. The app's effective encoder default also overrides the raw graph's NVFP4 starter value; tests check the graph after defaults and binds are actually applied, not just the JSON template.

The automated Pika path now discards model-supplied encoder/SLA/sparsity/grid/export overrides and applies real manifest defaults. The manual Director UI remains editable. The Ref2VA/FL2VA choice still switches both the installed model and its matching Pika LoRA; it does not invent endpoint inputs absent from the app.

## Actual material and prompt semantics

- Images and standalone audio are selected **per segment**, in explicit order. Local labels restart at 1. A file in the global bin is not automatically assigned to a window.
- In this native Director, standalone reference audios come **before** enabled video soundtracks. The official CLI's opposite mixed-audio ordering must not be assumed here.
- `locked` is target soundtrack, not a prompt-addressable `<Audio N>` source. The finite sampler requires exactly the same single locked audio file/source-in point across every segment. This is now rejected before dispatch if assignments differ or are partial.
- Enabled video soundtrack is preserved by the finite sampler unless explicit locked audio takes priority. With reference video, `video_audio:false` is an output-mute policy, not a request for newly invented replacement speech/music.
- To use a video visually while generating new target sound, keep the global flag true and disable that clip's `hasAudio` selection. Probed source presence and this deliberate enable/disable decision are distinct. With no video clips, the global flag is not a general audio-strip command.
- Use `media` probe for real source duration, dimensions and audio presence; populate source trims/timing/`hasAudio` from those facts, not assumed labels.
- A global prompt is reused only when **all** local prompts are empty. If any local prompt is supplied, every segment needs one. Local prompts do not append the global prompt.
- The legacy `segment_prompts` field splits on newlines; passing a complete multi-line six-section prompt there would leave only its first line in segment 1. This path is now rejected for Pika; use `global_prompt` or explicit `segment_windows`.

## RelayVSR is not inside the Pika graph

The existing `relayvsr-upscale` app supplies x2/x4, on the same shared queue and with its own history entry and approval. Pika `get_app` exposes this as a **separate delivery recommendation**, not a fictional Pika input or an automatically completed upscale. The Agent proposal must include the delivery step; a Pika-only approval or repaired standalone pilot does not silently authorize another GPU job.

Both x2 and x4 DIT/Flash VAE pairs are present locally. Their companion selections are now synchronized at the API validator, not only in the UI; explicit mismatches fail before GPU dispatch. Relay uses one-step Euler/CFG 1, and keeps source audio/fps. Its decoder `detail:1` is not Pika SLA sparsity.

An x2 model doubles both dimensions: **0.4 MP becomes approximately 1.6 MP**. x4 is approximately 6.4 MP. Actual dimensions depend on padding/grid and must be probed; 0.8 MP is not claimed. No resize or source-resolution substitution is silently added.

## Verification, without GPU inference

- **141 Node tests passed**, TypeScript and the 150-app registry passed.
- **Seven Python CPU tests passed** against the real Riverfield builder and selected pure functions extracted from the installed native Director. No torch import or model loading is needed. They verify native finite-plan geometry, local order, actual global fallback, locked soundtrack invariants, video-audio policies and native mixed-audio ordering.
- The real isolated HTTP/MCP/SDK test captures Ref2VA, empty-bin FL2VA and Ref2VA plus audio, including omitted-mode selection, as well as the separate RelayVSR app's paired x4 selection. It confirms native defaults survive attempted technical overrides and Pika's locked sampler/sigmas remain unchanged.

```sh
npm test
npm run typecheck
npm run validate
python3 -m unittest discover -s test -p h3_planner_contract_test.py -v
```

This validates the execution/planning contract, not a claim of perfect model reasoning or generated audiovisual quality. No real Pika or RelayVSR inference was started during this audit.
