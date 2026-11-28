"""Add per-segment first/last-image guides to the installed native H3 Director.

Idempotent, anchor-checked extension of the current native planner/encoder. No GPU imports.
"""
from pathlib import Path
import sys

HELPER = '''

def _endpoint_image_guides(timeline, width, height, length):
    """Explicit segment endpoints are fixed guides, never Ref2VA Picture inputs."""
    guides = []
    for key, frame_index in (("firstFrame", 0), ("lastFrame", length - 1)):
        asset = timeline.get(key)
        if asset is None:
            continue
        if not isinstance(asset, dict) or not asset.get("file"):
            raise ValueError(f"Invalid {key} endpoint asset")
        image = _load_image(_safe_input_path(str(asset["file"])), width, height)
        guides.append({"image": image, "audio": None, "frame_idx": frame_index,
                       "kind": key, "source_frames": 1})
    return guides
'''
SELECT = '''    # Resolve endpoints before compacting the reference bin for this segment.
    by_image_id = {str(asset.get("id")): asset for asset in result.get("images", [])
                   if isinstance(asset, dict) and asset.get("id")}
    for key in ("firstFrame", "lastFrame"):
        endpoint_id = selected.get(key)
        result.pop(key, None)
        if endpoint_id is not None:
            if str(endpoint_id) not in by_image_id:
                raise ValueError(f"Segment {selected_index}: missing {key} image")
            result[key] = copy.deepcopy(by_image_id[str(endpoint_id)])

'''

def patched(text):
    if "def _endpoint_image_guides(" in text:
        if SELECT.strip() not in text or "guides.extend(_endpoint_image_guides(" not in text:
            raise ValueError("Incomplete native endpoint patch; inspect before updating")
        return text
    select_anchor = '    result["images"] = _ordered_segment_assets(\n'
    helper_anchor = '\ndef _apply_h3_guides('
    encode_anchor = '    conditioning = _apply_h3_guides(conditioning, latent, vae, audio_vae, guides)'
    for anchor in (select_anchor, helper_anchor, encode_anchor):
        if text.count(anchor) != 1:
            raise ValueError(f"Native H3 endpoint patch anchor changed: {anchor.strip()}")
    text = text.replace(select_anchor, SELECT + select_anchor, 1)
    text = text.replace(helper_anchor, HELPER + helper_anchor, 1)
    text = text.replace(encode_anchor, '    guides.extend(_endpoint_image_guides(timeline, target_width, target_height, length))\n' + encode_anchor, 1)
    return text

if __name__ == "__main__":
    comfy = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "comfyui-vanilla-gfx1151/ComfyUI"
    path = comfy / "custom_nodes/ComfyUI-MiniMaxH3-TimelineDirector/minimax_h3_timeline_director.py"
    if not path.is_file():
        raise SystemExit(f"Native H3 Director not installed: {path}")
    before = path.read_text()
    after = patched(before)
    if after != before:
        backup = path.with_suffix(path.suffix + ".orig-riverfield-endpoints")
        if not backup.exists():
            backup.write_text(before)
        path.write_text(after)
    print("Native H3 first/last-frame endpoint guides ready (restart backend to load).")
