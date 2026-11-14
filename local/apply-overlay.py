#!/usr/bin/env python3
"""Puts this machine's local apps in the UI: the menus and the example thumbnails.

RiverField decides where an app shows up in web/js/catalog.js, and which example each card
plays from web/examples/index.json. Both are upstream files, so instead of editing them by
hand this applies a small, idempotent overlay:

    python3 local/apply-overlay.py            # apply (safe to run before every start)
    python3 local/apply-overlay.py --revert   # put the two files back, for a git pull
    python3 local/apply-overlay.py --check    # exit 1 if an anchor moved upstream

Run it before `git pull` with --revert (./update.sh does both), and after with no argument.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "web" / "js" / "catalog.js"
EXAMPLES = ROOT / "web" / "examples" / "index.json"
LOCAL_EXAMPLES = ROOT / "local" / "examples.json"

# Exact snippets of catalog.js, each unique. A menu rule is skipped when its new ids are
# already there, and reported when upstream rewrote the line it expected.
MENU = [
    (
        '"video-t2v", "video", "h3-video", "h3-photo", "music", "sfx"]',
        '"video-t2v", "video", "h3-video", "h3-video-turbo", "h3-photo", "h3-photo-turbo",'
        ' "music", "music-yue2", "music-yue2-cover", "sfx"]',
        "cat.create",
    ),
    (
        '"camera-moves", "camera-copy", "reshoot", "reframe", "extend-video", "transitions"',
        '"camera-moves", "camera-copy", "reshoot", "reshoot-turbo", "reframe",'
        ' "extend-video", "extend-video-turbo", "transitions"',
        "cat.camera",
    ),
    (
        '"video", "cinema-video", "h3-video", "h3-photo", "effects"',
        '"video", "cinema-video", "h3-video", "h3-video-turbo", "h3-photo", "h3-photo-turbo", "effects"',
        "vtab.create",
    ),
    (
        '"recast", "mixed-media", "reframe", "extend-video", "vfx-clean-plate", "vfx-day-to-night",'
        ' "vfx-water", "sdr-hdr", "upscale-video", "smooth", "reshoot", "video-remove-bg"',
        '"recast", "mixed-media", "reframe", "extend-video", "extend-video-turbo",'
        ' "vfx-clean-plate", "vfx-day-to-night", "vfx-water", "sdr-hdr", "upscale-video",'
        ' "smooth", "reshoot", "reshoot-turbo", "video-remove-bg"',
        "vtab.edit",
    ),
    (
        '"create-image", "cinema-studio", "cinema-video", "z-image", "moss-image", "moss-turbo"',
        '"create-image", "h3-image", "cinema-studio", "cinema-video", "z-image", "moss-image", "moss-turbo"',
        "cat.create.image",
    ),
    (
        '"effects", "morph", "edit", "inpaint", "vfx-clean-plate"',
        '"effects", "morph", "edit", "h3-image-edit", "inpaint", "vfx-clean-plate"',
        "cat.vfx.image",
    ),
]


def apply_menu(check_only: bool = False) -> int:
    text = CATALOG.read_text(encoding="utf-8")
    missing = 0
    changed = False
    for old, new, name in MENU:
        if new in text:
            continue  # already applied
        count = text.count(old)
        if count != 1:
            print(f"! {name}: l'ancre a bougé upstream ({count} occurrences), règle sautée")
            missing += 1
            continue
        text = text.replace(old, new)
        changed = True
    if changed and not check_only:
        CATALOG.write_text(text, encoding="utf-8")
    return missing


def apply_examples(check_only: bool = False) -> int:
    if not LOCAL_EXAMPLES.exists():
        return 0
    wanted = json.loads(LOCAL_EXAMPLES.read_text(encoding="utf-8"))
    data = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    apps = data.setdefault("apps", {})
    todo = {k: v for k, v in wanted.items() if apps.get(k) != v}
    if not todo:
        return 0
    for app_id, entry in todo.items():
        for key in ("card", "poster", "full"):
            rel = entry.get(key)
            if rel and not (ROOT / "web" / rel).exists():
                print(f"! exemple {app_id}: {rel} manque, entrée sautée")
                todo.pop(app_id)
                break
    if not todo or check_only:
        return 0
    apps.update(todo)
    EXAMPLES.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"exemples publiés: {', '.join(sorted(todo))}")
    return 0


def revert() -> None:
    files = ["web/js/catalog.js", "web/examples/index.json"]
    dirty = subprocess.run(["git", "diff", "--name-only", "--", *files], cwd=ROOT,
                           capture_output=True, text=True).stdout.split()
    if dirty:
        subprocess.run(["git", "checkout", "--", *dirty], cwd=ROOT, check=True)
        print(f"remis à l'état upstream: {', '.join(dirty)}")
    else:
        print("rien à remettre (les fichiers sont déjà ceux d'upstream)")


def main() -> int:
    check_only = "--check" in sys.argv
    if "--revert" in sys.argv:
        revert()
        return 0
    missing = apply_menu(check_only)
    apply_examples(check_only)
    if missing:
        print("overlay: certaines règles de menu ne s'appliquent plus (les apps restent dans « More »)")
        return 1
    print("overlay appliqué")
    return 0


if __name__ == "__main__":
    sys.exit(main())
