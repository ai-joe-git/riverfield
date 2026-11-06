#!/usr/bin/env python3
"""Puts the H3 SLA Attention node in every MiniMax H3 workflow, ROCm side.

The node (H3SLAAttentionROCM, custom_nodes/comfyui-h3-sla-attention-rocm) goes right after
the last LoRA of the model chain, or right after the diffusion model when there is none:

    UNETLoader -> [LoraLoaderModelOnly ...] -> H3 SLAAttentionROCM -> BasicGuider / BasicScheduler

Settings are the ones validated on this machine (0.90 sparsity, 64-token blocks, comfy_kitchen
dense backend): about 30% faster inference on ROCM, per the node's own README.

    python3 local/apply-h3-sla.py            # apply (called by ./start.sh and ./update.sh)
    python3 local/apply-h3-sla.py --revert   # put the four upstream workflows back

The turbo clones are rebuilt from these files by local/make-turbo-apps.py, so they inherit
the node in the right place (after their turbo LoRA).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APPS = ROOT / "apps"

# The H3 apps of the catalogue. The turbo clones derive from them.
TARGETS = ["h3-video", "h3-photo", "extend-video", "reshoot", "h3-long-shot"]

CLASS = "H3SLAAttentionROCM"
TITLE = "H3 SLA Attention - ROCM"

# The widgets of the node, set as in the workflow validated on gfx1151 / ROCm 10.1.
PARAMS = {
    "sparsity_ratio": 0.9,
    "block_size": "64",
    "min_seq_len": 8192,
    "dense_last_steps": 1,
    "protect_audio": True,
    "enabled": True,
    "dense_steps": "",
    "dense_backend": "comfy_kitchen",
    "disable_fp16_accum": True,
    "stabilize_motion": False,
    "h3_cache": False,
    "reference_protection": False,
}

LORAS = ("LoraLoaderModelOnly", "LoraLoader")


def only(workflow: dict, class_type: str) -> str:
    ids = [k for k, n in workflow.items() if n["class_type"] == class_type]
    if len(ids) != 1:
        raise SystemExit(f"expected one {class_type}, found {ids}")
    return ids[0]


def next_id(workflow: dict, near: str) -> str:
    if ":" in near:
        prefix, _, number = near.rpartition(":")
        if number.isdigit():
            used = [int(k.split(":", 1)[1]) for k in workflow
                    if k.count(":") == 1 and k.split(":", 1)[0] == prefix and k.split(":", 1)[1].isdigit()]
            return f"{prefix}:{max(used) + 1}"
    used = [int(k) for k in workflow if k.isdigit()]
    return str(max(used) + 1)


def model_tail(workflow: dict) -> str:
    """The node that feeds the guider: the end of the model chain (LoRAs, shifts, backends)."""
    guider = workflow[only(workflow, "BasicGuider")]
    value = guider["inputs"].get("model")
    if not isinstance(value, list):
        raise SystemExit("BasicGuider.model n'est pas un lien")
    return value[0]


def apply_to(app_id: str) -> bool:
    path = APPS / app_id / "workflow.api.json"
    workflow = json.loads(path.read_text(encoding="utf-8"))
    if any(n["class_type"] == CLASS for n in workflow.values()):
        return False
    tail = model_tail(workflow)
    node = next_id(workflow, tail)
    workflow[node] = {"class_type": CLASS, "inputs": {"model": [tail, 0], **PARAMS},
                      "_meta": {"title": TITLE}}
    for key, n in workflow.items():
        if key == node:
            continue
        for field, value in n["inputs"].items():
            if isinstance(value, list) and value[:2] == [tail, 0]:
                n["inputs"][field] = [node, 0]
    path.write_text(json.dumps(workflow, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return True


def revert() -> None:
    files = [f"apps/{a}/workflow.api.json" for a in TARGETS]
    dirty = subprocess.run(["git", "diff", "--name-only", "--", *files], cwd=ROOT,
                           capture_output=True, text=True).stdout.split()
    if dirty:
        subprocess.run(["git", "checkout", "--", *dirty], cwd=ROOT, check=True)
        print(f"workflows H3 remis à l'état upstream: {len(dirty)}")
    else:
        print("workflows H3 déjà à l'état upstream")


def main() -> int:
    if "--revert" in sys.argv:
        revert()
        return 0
    done = [a for a in TARGETS if apply_to(a)]
    print(f"H3 SLA Attention: {', '.join(done) if done else 'déjà en place'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
