#!/usr/bin/env bash
# Télécharge les modèles RiverField dans l'ordre de priorité, en s'arrêtant avant de remplir le disque.
# Réutilise les fichiers déjà présents (même nom exact) et ignore le reste.
set -uo pipefail

RIVERFIELD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMFY="/home/zardoz/comfyui-vanilla-gfx1151/ComfyUI"
PY="/home/zardoz/comfyui-vanilla-gfx1151/.venv-r101/bin/python"
MIN_FREE_GB="${MIN_FREE_GB:-35}"
PACKS=("$@")
[[ ${#PACKS[@]} -eq 0 ]] && PACKS=(upscale image-krea2 image video-wan-effects video-wan audio image-qwen-edit video-scail video-h3 video-ltx25 wan-camera moss)

for pack in "${PACKS[@]}"; do
  free_gb=$(df --output=avail -BG "$COMFY" | tail -1 | tr -dc '0-9')
  if (( free_gb < MIN_FREE_GB )); then
    echo "⏭  $pack sauté : $free_gb Go libres < $MIN_FREE_GB Go"
    continue
  fi
  echo
  echo "=== $pack ($free_gb Go libres) ==="
  "$PY" "$RIVERFIELD_DIR/tools/local_backend.py" download "$COMFY" "$pack" --models "$COMFY/models"
  echo "exit=$? pour $pack"
done
echo
echo "terminé — $(df -h "$COMFY" | tail -1)"
