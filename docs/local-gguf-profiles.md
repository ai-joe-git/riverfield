# Choose local GGUF models in Agent

Open the model chip, then **Local GGUF library & settings**, then **Choose model** / **Change model** (or **New model profile**). The library opens automatically: no directory entry or Scan button is required. This uses the existing managed llama.cpp runtime, not another inference engine. External API connections still work.

## Model-specific profiles

- Models are grouped and naturally sorted by name. Each card contains only main-model variants in its primary selector, with separate associated projector and MTP/draft selectors. Quantization and size are displayed before the filename. Imatrix files and non-leading split parts are not offered as standalone main models.
- Local folders are discovered from the existing library location and saved profiles. Unique same-folder auxiliaries are preselected visibly; ambiguous flat-folder matches are not guessed. This is file association, not proof of runtime compatibility. **None** is always available. Search and controls stay visible while model cards scroll.
- **Use this model** starts a clean configuration for a different main GGUF, then applies the files shown on that card instead of inheriting files from the previous model. A changed draft file disables speculation until it is explicitly enabled. Existing GGUFs are scanned read-only; there are no downloads or copies.
- Raw file/executable paths are hidden under **Advanced paths & custom files**. Normal selection uses model cards, dropdowns and detected runtime builds, not hand-entered paths.
- Select the installed **llama-server executable**. Unsupported launch flags are rejected using that executable's help, not a model-name guess.
- **Model** sets context size (`0` requests the native context and can allocate a large cache).
- **Memory & KV** selects the main K/V cache precision. **MTP / Draft** selects independent draft K/V precision. New/unspecified settings default to **3 maximum draft tokens** and **Q8 draft K/V**. Existing explicit values remain unchanged. **Set main + draft KV caches to Q8** sets all four to `q8_0` without enabling speculation or changing the main weights.
- **Multimodal** selects an explicit image/audio projector GGUF and opt-in image, audio and video inputs. A projector filename is not proof of its capabilities.
- **MTP / Draft** automatically discovers modes using the selected binary's `--help` (no weights or inference). Concurrent requests share the same probe. Saved BlackRiver combinations such as **MTP + n-gram mod** appear in the dropdown when their component modes are supported. Refresh is optional, not a prerequisite for populating the menu.
- The exact matching model's draft parameters and batch/micro-batch sizes can be read from BlackRiver's local `native-runtime/state.json`. **Apply BlackRiver draft + batch settings** copies these parameters on explicit click. Batch-only copying is also available in **Performance**. It does not modify BlackRiver, copy credentials/extra argv/context settings, replace selected GGUF files, or load a model. Different models' settings are not guessed from a shared filename.
- Choose embedded `draft-mtp` when supported, or an explicit compatible MTP/draft GGUF. Draft-based modes requiring a separate model cannot be saved without one. Combined modes can also be entered explicitly; `none` cannot be mixed with an enabled mode.
- **Save & use in chat** registers/selects that profile immediately. It does not load weights or start inference. The next user request loads it through the existing shared GPU queue. **Load / reload** is a separate explicit action.

Profiles preserve auxiliary paths and settings independently. BlackRiver's existing binary can be selected; its files, profiles and running processes are not modified/adopted. Main GGUF metadata can expose embedded MTP heads; projector metadata can expose audio/vision encoders. Full architecture, tensor and main/projector/draft compatibility is ultimately checked by the selected runtime during loading.

## Inspect actual media, including sound

Select a capable profile, enable the required inputs, then attach a file or use **Use in chat** on an output. Pika chat forwards the selected attachments to its read-only responder; it does not rewrite the script or dispatch generation tools.

- Images use image input; WAV/MP3/FLAC use actual base64 `input_audio` bytes, not just filenames.
- Compatible llama.cpp video/Omni models can receive `input_video`; this can include the soundtrack. It is not supported by every OpenAI-compatible server/model.
- **Use soundtrack in chat** on a video extracts a mono 24 kHz WAV on CPU and attaches it to the next message. It does not call a model. This is suitable for speech/intonation inspection, not stereo/mastering certification. Source media is unchanged. Extraction is limited to 120 seconds; input audio/video attachments are limited to 20 MB.
- When available, loaded `/props` modalities confirm supported inputs. Known unsupported requested inputs fail before inference; unknown capability stays labelled unconfirmed. Audio-only projectors are not assumed to provide vision.
- A text-only Pika connection explicitly refuses audio/video inspection. General-agent metadata-only attachments are labelled as not sent, so they cannot legitimately be described as heard/watched.

The ability to send media does not guarantee a correct transcript, identity assessment or quality judgement. Verify the model's actual response. Model selection and media transport do not change MOSS, Qwen image-edit, Pika LCM, native timing or RelayVSR.

## Gemma 4 projector micro-batch preflight

Gemma 4 vision projectors require a minimum image token budget. In this installed runtime, a micro-batch of 64 caps that budget below the 70-token minimum and causes `image_max_pixels ... less than image_min_pixels`, before the model can serve requests. This does not establish that the projector file is corrupt.

Selecting a Gemma 4 vision projector raises an undersized default to batch 1024 / micro-batch 512. Matching BlackRiver batch settings can then be applied explicitly. Save/load preflight rejects the known invalid configuration before allocating model weights or unloading another managed model. Startup failures retain the causal projector/image-budget error rather than only the cleanup messages. Passing this preflight does not certify every other aspect of model compatibility or memory availability.
