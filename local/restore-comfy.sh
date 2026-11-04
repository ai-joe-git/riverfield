#!/usr/bin/env bash
# Remet dans ComfyUI tout ce qu'une mise à jour (ComfyUI-Manager, réinstallation) peut écraser.
#
#   ./local/restore-comfy.sh            # ComfyUI par défaut
#   COMFY_ROOT=/autre/ComfyUI ./local/restore-comfy.sh
#
# Ce qui est concerné :
#   - custom_nodes/riverfield-comfy-nodes : le pack source comfy-nodes/riverfield-comfy-nodes
#     (copie locale, aussi publié sur le registry, mais une réinstallation de custom_nodes
#     le supprime) ;
#   - custom_nodes/comfyui-h3-sla-attention-rocm et custom_nodes/LTX-2.5-Director : des clones
#     git que Manager met à jour ; le `git pull` écrase (ou refuse) les patchs locaux ;
#   - le patch du proxy (venv) est déjà réappliqué à chaque ./start.sh.
#
# Le script est idempotent : relancer ne casse rien.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
COMFY="${COMFY_ROOT:-/home/zardoz/comfyui-vanilla-gfx1151/ComfyUI}"

if [[ ! -d "$COMFY/custom_nodes" ]]; then
  echo "ERROR: $COMFY/custom_nodes introuvable (COMFY_ROOT ?)" >&2
  exit 1
fi

# 1. le pack RiverField (les anciens dossiers séparés sont nettoyés)
for old in riverfield-comfy-nodes riverfield-h3-planner riverfield-ltx-planner riverfield-gemma4-attn; do
  rm -rf "$COMFY/custom_nodes/$old"
done
cp -r comfy-nodes/riverfield-comfy-nodes "$COMFY/custom_nodes/riverfield-comfy-nodes"
echo "copié : riverfield-comfy-nodes"

# 2. les patchs des packs tiers (idempotents, sauvegarde .orig-riverfield)
python3 local/patch-h3-sla-solattn.py "$COMFY" || echo "h3-sla : patch non appliqué (pack absent ou modifié)"
python3 local/patch-ltx-director-iclora.py "$COMFY" || echo "ltx-director : patch non appliqué (pack absent ou modifié)"

echo
echo "redémarrer le backend pour recharger les nœuds : ./stop.sh && ./start.sh"
