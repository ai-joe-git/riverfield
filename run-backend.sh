#!/usr/bin/env bash
# RiverField backend on the local ROCm ComfyUI.
#
#   ComfyUI :8188  (the install in /home/zardoz/comfyui-vanilla-gfx1151, started with the
#                   same venv and the same flags as 15_RUN_COMFYUI_ROCM101.sh)
#   comfy-api-proxy :8189   (Comfy API v2, no auth)
#   gateway :8000           (RIVERFIELD_TOKEN, unloads the GPU when the app changes)
#
# Ctrl+C stops the three processes. Then, in another terminal: ./run-web.sh
set -Eeuo pipefail

RIVERFIELD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMFY_ROOT="/home/zardoz/comfyui-vanilla-gfx1151"
COMFYUI="$COMFY_ROOT/ComfyUI"
VENV="$COMFY_ROOT/.venv-r101"
COMFY_PORT="${COMFY_PORT:-8189}"   # 8188 reste à ton ComfyUI de 15_RUN
GATEWAY_PORT="${GATEWAY_PORT:-8000}"

free_port() {  # le premier port libre à partir de $1 (ton ComfyUI de 15_RUN... occupe souvent 8188)
  local p="$1"
  while (echo > "/dev/tcp/127.0.0.1/$p") 2>/dev/null; do p=$((p + 1)); done
  echo "$p"
}
COMFY_PORT="$(free_port "$COMFY_PORT")"
PROXY_PORT="$(free_port $((COMFY_PORT + 1)))"
if (echo > "/dev/tcp/127.0.0.1/$GATEWAY_PORT") 2>/dev/null; then
  echo "ERROR: le port $GATEWAY_PORT du gateway est occupé (COMFY_BASE_URL dans .env pointe dessus)"
  exit 1
fi
LOG_DIR="${RIVERFIELD_LOG:-/tmp/opencode/riverfield}"
PORT_FILE="$LOG_DIR/ports.env"
mkdir -p "$LOG_DIR"
printf 'COMFY_PORT=%s\nPROXY_PORT=%s\nGATEWAY_PORT=%s\n' "$COMFY_PORT" "$PROXY_PORT" "$GATEWAY_PORT" > "$PORT_FILE"
export COMFY_PORT PROXY_PORT GATEWAY_PORT
[[ "$COMFY_PORT" != "8188" ]] && echo "== 8188 occupé (ton ComfyUI de 15_RUN ?) → RiverField démarre le sien sur :$COMFY_PORT"

set -a
# shellcheck disable=SC1091
source "$RIVERFIELD_DIR/.env"
set +a
: "${RIVERFIELD_TOKEN:?no RIVERFIELD_TOKEN in $RIVERFIELD_DIR/.env (python tools/setup_token.py --env-only)}"

[[ -x "$VENV/bin/python" ]] || { echo "ERROR: venv missing: $VENV"; exit 1; }
[[ -x "$VENV/bin/comfy-api-proxy" ]] || { echo "ERROR: comfy-api-proxy missing in $VENV (pip install comfy-api-proxy==0.1.6)"; exit 1; }
# le proxy ignore les sorties ComfyUI de type 3d : sans ce patch, les .glb n'arrivent jamais
"$VENV/bin/python" "$RIVERFIELD_DIR/local/patch-proxy.py" || true

source "$VENV/bin/activate"

# Same environment hygiene as 15_RUN_COMFYUI_ROCM101.sh.
unset PYTHONPATH 2>/dev/null || true
unset HSA_OVERRIDE_GFX_VERSION 2>/dev/null || true
unset PYTORCH_HIP_ALLOC_CONF 2>/dev/null || true
unset PYTORCH_CUDA_ALLOC_CONF 2>/dev/null || true
unset TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL 2>/dev/null || true
unset COMFY_KITCHEN_DISABLE_HIP 2>/dev/null || true
unset COMFY_KITCHEN_DISABLE_TRITON 2>/dev/null || true
unset PYTORCH_TUNABLEOP_ENABLED 2>/dev/null || true
# SVM : sur gfx1151 (Strix Halo, mémoire unifiée) le gestionnaire SVM du noyau part en
# livelock (kworker svm_range_restore_work à 100 %, visible dans journalctl) et le GPU finit
# en "ring gfx_0.0.0 timeout" + reset, ce qui tue la session graphique.
# Correctif documenté par ROCm : HSA_USE_SVM=0 (ROCm/TheRock#2684, "3x speedup on Hunyuan
# Video ... HSA_USE_SVM=0 fix" : même enchaînement svm_range_restore_work -> ring timeout ->
# reset). HSA_ENABLE_SDMA=0 évite les hang de copies SDMA.
export HSA_USE_SVM=0
export HSA_ENABLE_SDMA=0

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup INT TERM EXIT

wait_http() {  # url, timeout
  local url="$1" t0=$SECONDS
  until curl -sf -o /dev/null --max-time 2 "$url"; do
    (( SECONDS - t0 < ${2:-600} )) || { echo "ERROR: $url did not answer"; exit 1; }
    sleep 1
  done
}

echo "== ComfyUI :$COMFY_PORT (ROCm 10.1, gfx1151)"
# Attention : plus de --use-split-cross-attention global. Ce mode calcule la matrice
# d'attention complète (O(tokens²) par tête) : à 8 s de vidéo H3 il demande des centaines de
# Go et tue la machine (runs "lost" à 0.8 MP / 8 s). Le plantage SDPA de ROCm 10.1 ne concerne
# que l'encodeur gemma4 de LTX-2.5 : le nœud custom_nodes/riverfield-gemma4-attn le force sur
# l'attention découpée, et tout le reste (H3, LTX, FLUX, Wan) garde le chemin flash linéaire.
# --cache-none : aucun cache de nœuds entre deux runs.
#
# --disable-dynamic-vram : DynamicVRAM / comfy-aimdo (actif par défaut depuis ComfyUI 0.34)
# est cassé sur les GPU AMD en ROCm : runs qui meurent sans traceback, machine figée, OOM
# alors que la mémoire est libre. Voir Comfy-Org/ComfyUI#16878 et #15255 (le rapport #15255
# décrit mot pour mot notre cas : h3_ref2va_int8 + TE qwen3vl_32b nvfp4 + VAE H3 « Staged »).
# Sur un iGPU Strix Halo c'est pire : aimdo croit avoir 112 Go de VRAM *en plus* des 122 Go
# de RAM alors que c'est la même mémoire, et il « commit » tout ce qu'il peut.
# --disable-pinned-memory : la mémoire pinned n'est pas swappable, et sur un iGPU elle ne
# sert à rien (aucun transfert PCIe) : elle empêche juste le noyau de récupérer la mémoire.
export PYTORCH_HIP_ALLOC_CONF="${PYTORCH_HIP_ALLOC_CONF:-expandable_segments:True}"
( cd "$COMFYUI" && exec python main.py --listen 127.0.0.1 --port "$COMFY_PORT" --disable-auto-launch \
    --dont-upcast-attention --cache-none --disable-dynamic-vram --disable-pinned-memory ) &
COMFY_PID=$!
PIDS+=($COMFY_PID)

# Échantillonneur mémoire : si ça retombe, on saura qui consomme quoi (RAM dispo, RSS du
# backend, GTT utilisé par le GPU). Écrit toutes les 5 s dans $LOG_DIR/mem.log.
(
  GTT=/sys/class/drm/card1/device/mem_info_gtt_used
  while sleep 5; do
    ts=$(date +%H:%M:%S)
    ram=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
    rss=$(awk '/VmRSS/{print int($2/1024)}' "/proc/$COMFY_PID/status" 2>/dev/null || echo 0)
    gtt=$(awk '{print int($1/1048576)}' "$GTT" 2>/dev/null || echo 0)
    printf '%s ram_dispo=%sMB comfy_rss=%sMB gtt=%sMB\n' "$ts" "$ram" "$rss" "${gtt:-0}"
  done
) >> "$LOG_DIR/mem.log" &
PIDS+=($!)
wait_http "http://127.0.0.1:$COMFY_PORT/system_stats"
echo "== comfy-api-proxy :$PROXY_PORT"
comfy-api-proxy --comfyui "http://127.0.0.1:$COMFY_PORT" --port "$PROXY_PORT" --comfyui-base-dir "$COMFYUI" &
PIDS+=($!)
until (echo > "/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null; do sleep 1; done
echo "== gateway :$GATEWAY_PORT"
RIVERFIELD_TOKEN="$RIVERFIELD_TOKEN" \
COMFYUI_URL="http://127.0.0.1:$COMFY_PORT" \
PROXY_URL="http://127.0.0.1:$PROXY_PORT" \
GATEWAY_PORT="$GATEWAY_PORT" \
python "$RIVERFIELD_DIR/infra/gateway.py" &
PIDS+=($!)
wait_http "http://127.0.0.1:$GATEWAY_PORT/health" 120

echo
echo "backend ready → COMFY_BASE_URL=http://127.0.0.1:$GATEWAY_PORT (already in .env)"
echo "web app      → ./run-web.sh  (http://127.0.0.1:3000)"
echo
wait -n "${PIDS[@]}" || true
echo "a backend process exited; stopping the others"
