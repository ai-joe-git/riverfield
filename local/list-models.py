#!/usr/bin/env python3
"""Inventaire des modèles : ce que les workflows demandent, ce qui est sur le disque.

    python3 local/list-models.py            # tout
    python3 local/list-models.py --missing  # seulement ce qui manque
    python3 local/list-models.py --loras    # seulement les LoRA

Lit les workflows des apps (chargeurs et `lora_name`, options à `sets`) et compare aux
fichiers de ComfyUI/models, puis aux packs (packs/*.json) pour les fichiers qu'aucun
workflow ne nomme directement.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = Path("/home/zardoz/comfyui-vanilla-gfx1151/ComfyUI/models")

LOADERS = ("unet_name", "clip_name", "vae_name", "ckpt_name", "lora_name",
           "audio_encoder_name", "clip_vision_name", "upscale_model", "style_model_name")


def disk() -> dict[str, str]:
    return {p.name: p.relative_to(MODELS).as_posix()
            for p in MODELS.rglob("*") if p.is_file() and p.stat().st_size > 1_000_000}


def uses() -> dict[str, set[str]]:
    use: dict[str, set[str]] = defaultdict(set)
    for f in sorted((ROOT / "apps").glob("*/workflow.api.json")):
        app = f.parent.name
        for node in json.loads(f.read_text(encoding="utf-8")).values():
            for key in LOADERS:
                value = node["inputs"].get(key)
                if isinstance(value, str) and "." in value and "/" not in value:
                    use[value].add(app)
    for f in sorted((ROOT / "apps").glob("*/app.json")):
        app = f.parent.name
        for inp in json.loads(f.read_text(encoding="utf-8")).get("inputs", []):
            for option in inp.get("options") or []:
                for entry in option.get("sets") or []:
                    if entry.get("field") == "lora_name" and isinstance(entry.get("value"), str):
                        use[entry["value"]].add(app)
    return use


def packs(known: dict[str, str]) -> list[tuple[str, str, float, bool]]:
    out = []
    for f in sorted((ROOT / "packs").glob("*.json")):
        if f.name == "index.json":
            continue
        for m in json.loads(f.read_text(encoding="utf-8")).get("models", []):
            name = m.get("name") or m["file"].split("/")[-1]
            if name not in known:
                out.append((f.stem, name, m.get("gb") or 0.0, bool(m.get("gated"))))
    return out


def main() -> None:
    import sys
    known = disk()
    use = uses()
    only = sys.argv[1] if len(sys.argv) > 1 else ""

    if only in ("", "--loras"):
        print(f"== LoRA référencés par les apps ({len([u for u in use if u not in known])} manquants) ==")
        for name in sorted(use):
            state = "OK      " if name in known else "MANQUANT"
            print(f"[{state}] {name:60} {', '.join(sorted(use[name]))}")
        print()

    if only in ("", "--missing"):
        missing = sorted(n for n in use if n not in known)
        print("== Modèles nommés par un workflow mais absents ==")
        for name in missing:
            print(f"  {name:60} {', '.join(sorted(use[name]))}")
        if not missing:
            print("  (aucun)")
        print()
        print("== Fichiers déclarés dans un pack mais absents ==")
        rows = packs(known)
        for pack, name, gb, gated in rows:
            print(f"  {pack:18} {name:60} {gb:6.2f} Go {'(gated)' if gated else ''}")
        print(f"  total : {sum(r[2] for r in rows):.1f} Go")
        print()
        print(f"sur le disque : {len(known)} fichiers, {len(use)} référencés par les apps")


if __name__ == "__main__":
    main()
