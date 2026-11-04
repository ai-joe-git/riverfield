#!/usr/bin/env python3
"""Ajouter une entrée STRING `ic_lora_override` au guide du LTX Director 2.5.

Pourquoi : `LTXDirectorGuideCS25.ic_lora_name` est un combo (liste des LoRA du dossier).
ComfyUI refuse qu'un lien STRING arrive dessus (« Return type mismatch »), donc une app ne
peut pas choisir le LoRA Ingredients à l'exécution : il faudrait deux apps, une par mode.
Le patch ajoute une entrée socket optionnelle, prioritaire sur le combo. RiverField y branche
la sortie du planner (`"None"` ou le LoRA Ingredients), et une seule app couvre le texte et
les feuilles de références.

Le combo reste en place (l'UI ComfyUI ne change pas) ; le patch est idempotent et laisse une
copie `ltx_director_guide.py.orig-riverfield`.

    python local/patch-ltx-director-iclora.py [chemin-du-ComfyUI]
"""
from __future__ import annotations

import sys
from pathlib import Path

DEFAULT_COMFY = Path("/home/zardoz/comfyui-vanilla-gfx1151/ComfyUI")
NODE_DIR = "custom_nodes/LTX-2.5-Director"
MARKER = "ic_lora_override"

OLD_INPUT = (
    '                "ic_lora_name": (["None"] + loras, {"default": "None", '
    '"tooltip": "Select the IC-LoRA model to use for motion guidance."}),\n'
)
NEW_INPUT = OLD_INPUT + (
    '                "ic_lora_override": ("STRING", {"forceInput": True, '
    '"tooltip": "Socket that wins over the ic_lora_name combo; RiverField wires '
    '\\"None\\" or the reference LoRA here."}),\n'
)

OLD_SIG = "retake_mode=False, msr_strength=0.0):"
NEW_SIG = 'retake_mode=False, msr_strength=0.0, ic_lora_override=""):'

OLD_BODY = """        latent_downscale_factor = 1.0
        if model is not None and ic_lora_name != "None":"""
NEW_BODY = """        latent_downscale_factor = 1.0
        if ic_lora_override:
            ic_lora_name = ic_lora_override
        if model is not None and ic_lora_name != "None":"""


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_COMFY
    guide = root / NODE_DIR / "ltx_director_guide.py"
    if not guide.is_file():
        print(f"absent : {guide}")
        return 1

    text = guide.read_text()
    if MARKER in text:
        print("déjà patché")
        return 0
    for old in (OLD_INPUT, OLD_SIG, OLD_BODY):
        if old not in text:
            print("motif introuvable — le pack a changé, patch à revoir")
            return 1

    backup = guide.with_suffix(".py.orig-riverfield")
    if not backup.exists():
        backup.write_text(text)
    text = text.replace(OLD_INPUT, NEW_INPUT, 1)
    text = text.replace(OLD_SIG, NEW_SIG, 1)
    text = text.replace(OLD_BODY, NEW_BODY, 1)
    guide.write_text(text)
    print(f"patché : {guide}")
    print(f"sauvegarde : {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
