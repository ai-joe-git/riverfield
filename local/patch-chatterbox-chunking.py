#!/usr/bin/env python3
"""Re-apply RiverField's long-script chunking patch to Chatterbox's MTL node.

Chatterbox's upstream ``ChatterboxMTLTTS`` node synthesises the whole text box in
one model call. A several-thousand-character story then asks the GPU for one huge
KV/token budget and can hang the amdgpu context -- the desktop itself goes with
it. The classic ``ChatterboxTTS`` node already chunks; the multilingual node did
not, so this patch wires the same ``plan_text`` / ``combine_audio_chunks`` pair
into it.

The patch is idempotent. It is applied by ``run-backend.sh`` before ComfyUI starts
so a custom-node update cannot silently bring the crash back.

Run it by hand with:
    python local/patch-chatterbox-chunking.py
Point it at a copy for a dry run with:
    CHATTERBOX_MTL_NODE=/tmp/mtl_node.py python local/patch-chatterbox-chunking.py
"""

from __future__ import annotations

import os
import py_compile
from pathlib import Path

DEFAULT_NODE = Path(
    "/home/zardoz/comfyui-vanilla-gfx1151/ComfyUI/custom_nodes/"
    "ComfyUI-Chatterbox/nodes/mtl_node.py"
)
NODE = Path(os.environ.get("CHATTERBOX_MTL_NODE", DEFAULT_NODE))

AUDIO_UTILS_OLD = (
    "from ..modules.audio_utils import interrupt_exception_class, to_comfy_audio"
)
AUDIO_UTILS_NEW = (
    "from ..modules.audio_utils import S3GEN_SAMPLE_RATE, interrupt_exception_class, "
    "to_comfy_audio"
)

GENERATION_OLD = """from ..modules.generation import (
    FAMILY_MTL,
    generate_mtl_audio,
    load_chatterbox_entry_point,
)"""
GENERATION_NEW = """from ..modules.generation import (
    FAMILY_MTL,
    combine_audio_chunks,
    generate_mtl_audio,
    load_chatterbox_entry_point,
)"""

SCHEMA_OLD = """                io.Audio.Input(
                    "audio_prompt",
                    optional=True,
                    tooltip=(
                        "Reference audio to clone the voice from. 5-6 seconds of "
                        "clean speech is recommended. When left unconnected the "
                        "checkpoint's built-in voice is used. The multilingual "
                        "repo and the zh-cmn Single Language Pack ship one; the "
                        "other five Single Language Packs do not -- for them a "
                        "reference clip is required."
                    ),
                ),
            ],"""
SCHEMA_NEW = """                io.Audio.Input(
                    "audio_prompt",
                    optional=True,
                    tooltip=(
                        "Reference audio to clone the voice from. 5-6 seconds of "
                        "clean speech is recommended. When left unconnected the "
                        "checkpoint's built-in voice is used. The multilingual "
                        "repo and the zh-cmn Single Language Pack ship one; the "
                        "other five Single Language Packs do not -- for them a "
                        "reference clip is required."
                    ),
                ),
                io.Boolean.Input(
                    "enable_chunking",
                    default=True,
                    tooltip=(
                        "Split a long script into chunks and synthesise them "
                        "one at a time, then join them. This bounds the token "
                        "budget per model call, so a long story does not try to "
                        "generate everything in one GPU allocation."
                    ),
                ),
                io.Int.Input(
                    "max_chars_per_chunk",
                    default=400,
                    min=100,
                    max=1000,
                    step=50,
                    tooltip=(
                        "Characters per chunk. Smaller chunks use less GPU "
                        "memory and follow a long script more closely; larger "
                        "chunks sound more continuous but are riskier."
                    ),
                ),
                io.Combo.Input(
                    "chunk_combination_method",
                    options=["auto", "concatenate", "silence_padding", "crossfade"],
                    default="auto",
                    tooltip=(
                        "How chunks are joined: auto resolves by script "
                        "length, concatenate is a hard cut, silence_padding "
                        "adds a pause, crossfade overlaps the edges."
                    ),
                ),
                io.Int.Input(
                    "silence_between_chunks_ms",
                    default=100,
                    min=0,
                    max=500,
                    step=25,
                    tooltip=(
                        "Pause between chunks when using silence_padding."
                    ),
                ),
            ],"""

SIGNATURE_OLD = """        audio_prompt: Optional[dict] = None,
        client_id: Optional[str] = None,
    ) -> io.NodeOutput:"""
SIGNATURE_NEW = """        audio_prompt: Optional[dict] = None,
        enable_chunking: bool = True,
        max_chars_per_chunk: int = 400,
        chunk_combination_method: str = "auto",
        silence_between_chunks_ms: int = 100,
        client_id: Optional[str] = None,
    ) -> io.NodeOutput:"""

PLAN_OLD = """        # Tags, then crash protection -- in that order, per segment.
        plan = plan_text(text, crash_protection_template=crash_protection_template)"""
PLAN_NEW = """        # Tags, then crash protection, then chunking -- in that order.
        plan = plan_text(
            text,
            crash_protection_template=crash_protection_template,
            enable_chunking=enable_chunking,
            max_chars_per_chunk=max_chars_per_chunk,
            chunk_combination_method=chunk_combination_method,
            silence_between_chunks_ms=silence_between_chunks_ms,
        )
        if not plan.text.strip():
            logging.info("[Chatterbox TTS] Text held only tags; returning silence.")
            return io.NodeOutput(silent_audio())"""

GENERATE_OLD = """        interrupt_error = interrupt_exception_class()
        try:
            waveform, sample_rate = generate_mtl_audio(
                model,
                plan.text,
                language,
                audio_prompt=audio_prompt,
                exaggeration=exaggeration,
                temperature=temperature,
                cfg_weight=cfg_weight,
                repetition_penalty=repetition_penalty,
                min_p=min_p,
                top_p=top_p,
                seed=seed,
                use_watermark=use_watermark,
            )
        except interrupt_error:"""
GENERATE_NEW = """        interrupt_error = interrupt_exception_class()
        try:
            chunks = plan.chunks or (plan.text,)
            logging.info(
                "[Chatterbox TTS] Synthesising %d chunk(s) of %d characters, "
                "joined with '%s'.",
                len(chunks),
                plan.char_count,
                plan.chunk_method,
            )
            waveforms = []
            sample_rate = S3GEN_SAMPLE_RATE
            for index, chunk in enumerate(chunks):
                waveform, sample_rate = generate_mtl_audio(
                    model,
                    chunk,
                    language,
                    audio_prompt=audio_prompt,
                    exaggeration=exaggeration,
                    temperature=temperature,
                    cfg_weight=cfg_weight,
                    repetition_penalty=repetition_penalty,
                    min_p=min_p,
                    top_p=top_p,
                    seed=(seed + index if seed else 0),
                    use_watermark=use_watermark,
                )
                waveforms.append(waveform)
            waveform = combine_audio_chunks(
                waveforms,
                sample_rate,
                method=plan.chunk_method,
                silence_between_chunks_ms=silence_between_chunks_ms,
            )
        except interrupt_error:"""

REPLACEMENTS = [
    (AUDIO_UTILS_OLD, AUDIO_UTILS_NEW),
    (GENERATION_OLD, GENERATION_NEW),
    (SCHEMA_OLD, SCHEMA_NEW),
    (SIGNATURE_OLD, SIGNATURE_NEW),
    (PLAN_OLD, PLAN_NEW),
    (GENERATE_OLD, GENERATE_NEW),
]


def main() -> int:
    if not NODE.exists():
        print(f"[chatterbox] {NODE} is not installed; nothing to patch.")
        return 0

    source = NODE.read_text(encoding="utf-8")
    if "enable_chunking" in source and "combine_audio_chunks" in source and "plan.chunks" in source:
        print(f"[chatterbox] {NODE} already has the chunking patch.")
        return 0

    patched = source
    for old, new in REPLACEMENTS:
        if old not in patched:
            print(
                "[chatterbox] cannot apply the chunking patch: an expected block "
                "is missing. The custom node changed upstream; inspect "
                f"{NODE} and update local/patch-chatterbox-chunking.py.",
                flush=True,
            )
            return 2
        patched = patched.replace(old, new, 1)

    NODE.write_text(patched, encoding="utf-8")
    py_compile.compile(str(NODE), doraise=True)
    print(f"[chatterbox] applied the long-script chunking patch to {NODE}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
