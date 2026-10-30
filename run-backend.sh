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
PORT_FILE="${RIVERFIELD_LOG:-/tmp/opencode/riverfield}/ports.env"
mkdir -p "$(dirname "$PORT_FILE")"
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
unset HSA_USE_SVM 2>/dev/null || true

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
# --use-split-cross-attention: le SDPA de ROCm 10.1 plante sur l'encodeur gemma4 de LTX-2.5
# (hipErrorProfilerNotInitialized, noyau qui trap). L'attention découpée évite ce chemin.
( cd "$COMFYUI" && exec python main.py --listen 127.0.0.1 --port "$COMFY_PORT" --disable-auto-launch \
    --use-split-cross-attention --dont-upcast-attention --cache-none ) &
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
