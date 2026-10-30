#!/usr/bin/env bash
# Démarre le backend (ComfyUI + proxy + gateway) et l'interface web, en arrière-plan.
#   ./start.sh          démarre ce qui ne tourne pas encore, et dit clairement si ça échoue
#   ./stop.sh           arrête tout
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
LOG="${RIVERFIELD_LOG:-/tmp/opencode/riverfield}"
mkdir -p "$LOG"

running() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

if running "$LOG/backend.pid"; then
  echo "backend déjà lancé (PID $(cat "$LOG/backend.pid"))"
else
  setsid nohup ./run-backend.sh > "$LOG/backend.log" 2>&1 &
  echo $! > "$LOG/backend.pid"
  echo "backend lancé (PID $!)"
fi

if running "$LOG/web.pid"; then
  echo "web déjà lancé (PID $(cat "$LOG/web.pid"))"
else
  setsid nohup ./run-web.sh > "$LOG/web.log" 2>&1 &
  echo $! > "$LOG/web.pid"
  echo "web lancé (PID $!)"
fi

wait_url() {  # url secondes libellé
  local url="$1" limit="$2" label="$3" t=0
  printf 'attente %s' "$label"
  until curl -sf -o /dev/null --max-time 2 "$url"; do
    t=$((t + 1))
    if (( t > limit )); then
      echo
      echo "ECHEC : $label ne répond pas ($url)"
      echo "--- 15 dernières lignes de $LOG/backend.log"
      tail -n 15 "$LOG/backend.log" 2>/dev/null
      echo "--- à essayer : ./stop.sh puis ./start.sh"
      exit 1
    fi
    printf '.'; sleep 2
  done
  echo " ok"
}

wait_url http://127.0.0.1:8000/health 90 "du backend"
wait_url http://127.0.0.1:3000/ 30 "de l'interface"

echo
[[ -f "$LOG/ports.env" ]] && . "$LOG/ports.env"
echo "  Interface : http://127.0.0.1:3000"
echo "  Backend   : http://127.0.0.1:${GATEWAY_PORT:-8000}   (ComfyUI derrière, :${COMFY_PORT:-8188})"
echo "  Logs      : $LOG"
echo "  Arrêt     : ./stop.sh"
