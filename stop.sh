#!/usr/bin/env bash
# Arrête tout ce que start.sh a lancé (backend complet + interface web).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
LOG="${RIVERFIELD_LOG:-/tmp/opencode/riverfield}"

stop_tree() {
  local pid="$1"
  [[ -z "$pid" ]] && return
  kill -0 "$pid" 2>/dev/null || return
  local kids
  kids=$(pgrep -P "$pid" 2>/dev/null || true)
  for k in $kids; do stop_tree "$k"; done
  kill "$pid" 2>/dev/null || true
}

# ports réellement utilisés au dernier démarrage (run-backend.sh les choisit libres)
# shellcheck disable=SC1091
[[ -f "$LOG/ports.env" ]] && source "$LOG/ports.env"
COMFY_PORT="${COMFY_PORT:-8188}"

for name in web backend; do
  f="$LOG/$name.pid"
  if [[ -f "$f" ]]; then
    pid=$(cat "$f")
    stop_tree "$pid"
    rm -f "$f"
    echo "$name arrêté (PID $pid)"
  fi
done

# filet de sécurité : les enfants restés en vie si le parent est parti avant eux.
# On ne tue que des interpréteurs (python/node), jamais le shell qui lance ce script.
for pat in "main.py --listen 127.0.0.1 --port $COMFY_PORT" "comfy-api-proxy --comfyui http://127.0.0.1:$COMFY_PORT" "infra/gateway.py" "server/server.ts"; do
  for p in $(pgrep -f "$pat" 2>/dev/null || true); do
    [[ "$p" == "$$" ]] && continue
    case "$(ps -o comm= -p "$p" 2>/dev/null | tr -d ' ')" in
      python|python3|node) kill "$p" 2>/dev/null && echo "arrêté PID $p ($pat)" ;;
    esac
  done
done
sleep 2
echo "terminé."
