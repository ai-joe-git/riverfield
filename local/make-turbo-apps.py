#!/usr/bin/env python3
"""Turbo variants of the MiniMax H3 apps, built locally from the upstream graphs.

This folder is untracked and listed in .git/info/exclude: a `git pull` never touches it nor
the apps it writes under apps/. Run it again after a pull to rebuild the variants from the
refreshed upstream workflows:

    python3 local/make-turbo-apps.py

What each variant changes, and nothing else:

  h3-video-turbo      taomate_h3_3step_comfy (1.0)   3 steps, euler   (base: 20 steps, res_multistep)
  h3-photo-turbo      taomate_h3_3step_comfy (1.0)   3 steps, euler
  extend-video-turbo  taomate_h3_3step_comfy (1.0)   3 steps, euler
  reshoot-turbo       minimax_h3_ref2v_turbo_4step_v0.1 (4 steps) instead of the 8-step one,
                      euler, CrossView-Warp LoRA kept at 0.8

The LoRA node goes between the UNETLoader and the two nodes that read its MODEL output
(BasicGuider and BasicScheduler), so the scheduler sees the patched model too.
"""
from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APPS = ROOT / "apps"

FL2VA = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"

NOTE_LORA = (
    "Local turbo variant, not part of the video-h3 pack: riverfield's catalogue has no Hub entry for "
    "{lora}, so it is not downloaded with the pack. Keep the file in ComfyUI/models/loras."
)

RESOLUTIONS = [
    {"value": 0.4, "label": "0.4 MP"},
    {"value": 0.6, "label": "0.6 MP"},
    {"value": 0.8, "label": "0.8 MP"},
]

# Inputs added locally after the turbo variants were first generated. A rebuild from the
# upstream base app must not drop them: the UI, LoRA picker, SLA options and optional
# RelayVSR upscale live only in the generated turbo apps.
LOCAL_INPUT_IDS = {
    "resolution", "aspect", "duration", "steps", "sampler", "seed",
    "unet_name", "vae_name",
    "lora_name", "lora_strength", "clip_name", "sla", "sla_detail",
    "sla_block_size", "sla_min_seq_len", "sla_dense_last_steps",
    "sla_protect_audio", "sla_stabilize_motion", "sla_h3_cache",
    "sla_reference_protection", "sla_dense_steps", "sla_dense_backend",
    "sla_disable_fp16_accum", "upscale", "upscale_detail",
    "filename_prefix", "format", "codec",
}

VARIANTS = [
    {
        "base": "h3-video",
        "id": "h3-video-turbo",
        "name": "H3 Video Turbo",
        "summary": "A clip with its own sound from a prompt, on MiniMax H3 with taomate's 3-step turbo "
                   "LoRA: a sixth of the steps of the plain app.",
        "lora": "taomate_h3_3step_comfy.safetensors",
        "steps": 3,
        "resolution": {"node": "115", "default": 0.4, "after": "aspect",
                       "help": "Total pixels of the clip: ComfyUI's ResolutionSelector rounds each side to 32 "
                               "(0.4 MP is 864x480 at 16:9, 0.8 MP is 1216x688). Attention grows with the "
                               "square of the frame: 0.8 MP is already about three times the denoise time of "
                               "0.4 MP on this GPU. 1.0 MP and above run out of memory (measured)."},
        "notes": "The same graph as H3 Video with taomate's 3-step LoRA (strength 1.0) on the diffusion "
                 "model and the sampler set to euler at 3 steps. Use it for drafts and batches: the denoise "
                 "phase runs 3 steps instead of 20, so a clip costs a fraction of the plain app's GPU time. "
                 "Speech and sounds still come out of the model; the text encoder, VAEs and resolution are "
                 "unchanged.",
    },
    {
        "base": "h3-photo",
        "id": "h3-photo-turbo",
        "name": "H3 Photo to Video Turbo",
        "summary": "Animates a photo into a clip with its own sound on MiniMax H3 with taomate's 3-step "
                   "turbo LoRA: a sixth of the steps.",
        "lora": "taomate_h3_3step_comfy.safetensors",
        "steps": 3,
        "resolution": {"node": "119", "default": 0.6, "after": "image",
                       "help": "Total pixels of the clip: the photo is scaled to it with lanczos and each "
                               "side rounded to 32, then the model keeps that frame. 0.6 MP is the template's "
                               "default; more is sharper and slower."},
        "notes": "The same graph as H3 Photo to Video with taomate's 3-step LoRA (strength 1.0) on the "
                 "diffusion model and the sampler set to euler at 3 steps. The clip keeps the photo's shape; "
                 "the photo, scaled to 0.6 MP in steps of 32, still sets its size.",
    },
    {
        "base": "extend-video",
        "id": "extend-video-turbo",
        "name": "Extend Video Turbo",
        "summary": "Continues a clip from its last frame with MiniMax H3 and taomate's 3-step turbo LoRA, "
                   "sound included.",
        "lora": "taomate_h3_3step_comfy.safetensors",
        "steps": 3,
        "notes": "The same graph as Extend Video with taomate's 3-step LoRA (strength 1.0) on the diffusion "
                 "model and the sampler set to euler at 3 steps. The clip's last frame starts the new part "
                 "and the frames and sound are joined after it, as upstream.",
    },
    {
        "base": "reshoot",
        "id": "reshoot-turbo",
        "name": "Re-shoot Turbo",
        "summary": "Moves the camera to a new angle on an existing clip with MiniMax H3's 4-step turbo LoRA "
                   "instead of the 8-step one (MoGe + CrossView).",
        "lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
        "steps": 4,
        "notes": "Re-shoot with minimax_h3_ref2v_turbo_4step_v0.1 in place of the 8-step turbo LoRA, at 4 "
                 "steps with euler; the CrossView-Warp LoRA stays at 0.8 and the second output (\"Warp "
                 "guide\") is unchanged.",
        "drop_models": ["minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors"],
    },
]


def load(app_id: str) -> tuple[dict, dict]:
    manifest = json.loads((APPS / app_id / "app.json").read_text(encoding="utf-8"))
    workflow = json.loads((APPS / app_id / "workflow.api.json").read_text(encoding="utf-8"))
    return manifest, workflow


def only(workflow: dict, class_type: str) -> str:
    ids = [k for k, n in workflow.items() if n["class_type"] == class_type]
    if len(ids) != 1:
        raise SystemExit(f"expected one {class_type} node, found {ids}")
    return ids[0]


def next_node_id(workflow: dict, near: str) -> str:
    """The next free id in the same namespace as `near` (140:127 -> 140:138)."""
    prefix, _, number = near.rpartition(":")
    if not number.isdigit():
        return f"{near}_lora"
    used = [int(k[len(prefix) + 1:]) for k in workflow
            if k.startswith(prefix + ":") and k[len(prefix) + 1:].isdigit()]
    return f"{prefix}:{max(used) + 1}"


def read_model(workflow: dict, node_id: str, field: str) -> str:
    value = workflow[node_id]["inputs"].get(field)
    if not isinstance(value, list):
        raise SystemExit(f"{node_id}.{field} is not a link")
    return value[0]


def add_lora(workflow: dict, unet: str, lora: str, title: str) -> str:
    """Insert LoraLoaderModelOnly after the UNETLoader and repoint everything that read it."""
    node_id = next_node_id(workflow, unet)
    workflow[node_id] = {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {"model": [unet, 0], "lora_name": lora, "strength_model": 1.0},
        "_meta": {"title": title},
    }
    for key, node in workflow.items():
        if key == node_id:
            continue
        for field, value in node["inputs"].items():
            if isinstance(value, list) and value[:2] == [unet, 0]:
                node["inputs"][field] = [node_id, 0]
    return node_id


def set_sampler(workflow: dict, name: str = "euler") -> None:
    workflow[only(workflow, "KSamplerSelect")]["inputs"]["sampler_name"] = name


def set_steps(workflow: dict, steps: int) -> None:
    scheduler = workflow[only(workflow, "BasicScheduler")]
    value = scheduler["inputs"]["steps"]
    if isinstance(value, list):
        workflow[value[0]]["inputs"]["value"] = steps
    else:
        scheduler["inputs"]["steps"] = steps


def turbo_manifest(manifest: dict, variant: dict, sampler_node: str) -> dict:
    out = deepcopy(manifest)
    out["id"] = variant["id"]
    out["name"] = variant["name"]
    out["summary"] = variant["summary"]
    out["notes"] = variant["notes"] + " " + NOTE_LORA.format(lora=variant["lora"])
    out["credits"] = list(manifest.get("credits", [])) + [f"Turbo LoRA: {variant['lora']} (local file)"]
    drop = set(variant.get("drop_models", []))
    out["models"] = [m for m in manifest.get("models", []) if Path(m["file"]).name not in drop]
    out["source"] = {
        **manifest.get("source", {}),
        "notes": f"Local turbo clone of {variant['base']} ({variant['lora']} at {variant['steps']} steps, "
                 f"euler), rebuilt by local/make-turbo-apps.py; the upstream app is untouched.",
    }
    for inp in out["inputs"]:
        if inp["id"] != "steps":
            continue
        inp["min"] = 2
        inp["default"] = variant["steps"]
        inp["help"] = (f"The turbo LoRA is trained for {variant['steps']} steps; more steps cost time and "
                       f"usually add nothing. Fewer look rougher.")
    res = variant.get("resolution")
    if res:
        at = next(i for i, inp in enumerate(out["inputs"]) if inp["id"] == res["after"]) + 1
        out["inputs"].insert(at, {
            "id": "resolution",
            "type": "select",
            "label": "Resolution",
            "default": res["default"],
            "help": res["help"],
            "options": deepcopy(RESOLUTIONS),
            "bind": [{"node": res["node"], "field": "megapixels"}],
        })
    at = next(i for i, inp in enumerate(out["inputs"]) if inp["id"] == "steps") + 1
    out["inputs"].insert(at, {
        "id": "sampler",
        "type": "select",
        "label": "Sampler",
        "default": "euler",
        "help": "euler is what the turbo LoRA was trained with; res_multistep is the plain app's "
                "sampler, smoother at equal steps but slower to settle at 3 or 4.",
        "options": [{"value": "euler", "label": "euler"},
                    {"value": "res_multistep", "label": "res_multistep"}],
        "bind": [{"node": sampler_node, "field": "sampler_name"}],
    })
    out.pop("vram", None)
    return out


def turbo_workflow(workflow: dict, variant: dict) -> dict:
    out = deepcopy(workflow)
    unet = only(out, "UNETLoader")
    if out[unet]["inputs"].get("unet_name") != FL2VA:
        raise SystemExit(f"{variant['base']}: unexpected unet {out[unet]['inputs'].get('unet_name')}")
    add_lora(out, unet, variant["lora"], f"Load LoRA ({variant['steps']}-step turbo)")
    set_sampler(out)
    set_steps(out, variant["steps"])
    return out


def turbo_reshoot(workflow: dict, variant: dict) -> dict:
    out = deepcopy(workflow)
    unet = only(out, "UNETLoader")
    loras = [k for k, n in out.items() if n["class_type"] == "LoraLoaderModelOnly"
             and read_model(out, k, "model") == unet]
    if len(loras) != 1:
        raise SystemExit(f"reshoot: expected one turbo LoRA on {unet}, found {loras}")
    out[loras[0]]["inputs"]["lora_name"] = variant["lora"]
    out[loras[0]]["_meta"] = {"title": "Turbo LoRA (4 step)"}
    set_sampler(out)
    set_steps(out, variant["steps"])
    return out


def add_steps_input(manifest: dict, workflow: dict, variant: dict) -> None:
    if any(i["id"] == "steps" for i in manifest["inputs"]):
        return
    scheduler = only(workflow, "BasicScheduler")
    manifest["inputs"].append({
        "id": "steps",
        "type": "slider",
        "label": "Steps",
        "min": 2,
        "max": 30,
        "step": 1,
        "default": variant["steps"],
        "help": f"The turbo LoRA is trained for {variant['steps']} steps; more steps cost time and usually "
                f"add nothing.",
        "bind": [{"node": scheduler, "field": "steps"}],
    })


def save(variant: dict, manifest: dict, workflow: dict) -> None:
    folder = APPS / variant["id"]
    folder.mkdir(exist_ok=True)
    (folder / "app.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                                     encoding="utf-8")
    (folder / "workflow.api.json").write_text(json.dumps(workflow, indent=2, ensure_ascii=False) + "\n",
                                              encoding="utf-8")


def preserve_local_controls(variant: dict, manifest: dict, workflow: dict) -> None:
    """Keep the local UI/workflow additions when rebuilding from the upstream base app."""
    folder = APPS / variant["id"]
    app_path, wf_path = folder / "app.json", folder / "workflow.api.json"
    if not app_path.exists() or not wf_path.exists():
        return
    old_manifest = json.loads(app_path.read_text(encoding="utf-8"))
    old_workflow = json.loads(wf_path.read_text(encoding="utf-8"))
    old_inputs = {i["id"]: i for i in old_manifest.get("inputs", [])}
    generated = {i["id"]: i for i in manifest["inputs"]}
    desired = [i["id"] for i in old_manifest.get("inputs", [])]
    merged, used = [], set()
    for input_id in desired:
        if input_id in LOCAL_INPUT_IDS and input_id in old_inputs:
            merged.append(old_inputs[input_id])
        elif input_id in generated:
            merged.append(generated[input_id])
        used.add(input_id)
    merged.extend(i for i in manifest["inputs"] if i["id"] not in used)
    manifest["inputs"] = merged

    # Keep the local notes and the extra models (RelayVSR, optional encoders).
    for key in ("notes", "source", "credits"):
        if key in old_manifest:
            manifest[key] = old_manifest[key]
    known = {(m["dir"], Path(m["file"]).name) for m in manifest.get("models", [])}
    for model in old_manifest.get("models", []):
        key = (model["dir"], Path(model["file"]).name)
        if key not in known:
            manifest.setdefault("models", []).append(model)
            known.add(key)

    # Keep the optional RelayVSR nodes and the CreateVideo wiring.
    if "vsr_decode" in old_workflow:
        for node_id in ("vsr_unet", "vsr_cond", "vsr_sampler", "vsr_vae", "vsr_decode"):
            if node_id in old_workflow:
                workflow[node_id] = old_workflow[node_id]
        old_create = next((k for k, n in old_workflow.items() if n.get("class_type") == "CreateVideo"), None)
        new_create = next((k for k, n in workflow.items() if n.get("class_type") == "CreateVideo"), None)
        if old_create and new_create:
            workflow[new_create]["inputs"]["images"] = old_workflow[old_create]["inputs"]["images"]


def main() -> None:
    for variant in VARIANTS:
        manifest, workflow = load(variant["base"])
        if variant["base"] == "reshoot":
            workflow = turbo_reshoot(workflow, variant)
            add_steps_input(manifest, workflow, variant)
        else:
            workflow = turbo_workflow(workflow, variant)
        manifest = turbo_manifest(manifest, variant, only(workflow, "KSamplerSelect"))
        for node in workflow.values():
            if node["class_type"] == "SaveVideo":
                prefix = node["inputs"].get("filename_prefix", "")
                if prefix.startswith("riverfield/"):
                    node["inputs"]["filename_prefix"] = prefix.replace(variant["base"], variant["id"])
        preserve_local_controls(variant, manifest, workflow)
        save(variant, manifest, workflow)
        print(f"✓ apps/{variant['id']}  ({variant['lora']}, {variant['steps']} steps, euler)")
    print("\nles apps d'origine ne sont pas touchées ; relancer ce script après un git pull.")


if __name__ == "__main__":
    main()
