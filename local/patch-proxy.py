#!/usr/bin/env python3
"""Teach comfy-api-proxy about ComfyUI's 3D outputs.

The proxy normalises ComfyUI's output keys (images, gifs, audio, text, files,
latents) and silently drops anything else — `Save3DAdvanced` reports its model
under the key `3d`, so a .glb never reached the runner or the MCP.

This adds `"3d": "file"` to that map (the contract's OutputType has no "model";
RiverField re-classifies by extension, and .glb lands as a model). It is
idempotent and runs before the proxy starts, so a reinstalled proxy is patched
again:

    python3 local/patch-proxy.py            # patch (called by run-backend.sh)
    python3 local/patch-proxy.py --check    # exit 1 if the patch is missing
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import comfy_api_proxy
except ImportError:
    sys.exit("comfy-api-proxy is not installed in this Python (run it with the ComfyUI venv)")


def target() -> Path:
    return Path(comfy_api_proxy.__file__).with_name("app.py")


def patched(text: str) -> str:
    if '"3d"' in text:
        return text
    return text.replace('    "files": "file",', '    "files": "file",\n    "3d": "file",', 1)


def main() -> int:
    p = target()
    t = p.read_text(encoding="utf-8")
    new = patched(t)
    if "--check" in sys.argv:
        print("proxy 3d patch:", "present" if new == t else "MISSING")
        return 0 if new == t else 1
    if new != t:
        p.write_text(new, encoding="utf-8")
        print(f"comfy-api-proxy: 3d outputs mapped to files ({p})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
