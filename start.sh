#!/usr/bin/env bash
# Launch the local studio. ComfyUI opens for manual use unless --on-demand is supplied.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=local/service-lifecycle.sh
source ./local/service-lifecycle.sh
mode=${1:-}
if [[ "$#" -gt 1 || ( -n "$mode" && "$mode" != "--on-demand" ) ]]; then
    printf 'Usage: ./start.sh [--on-demand]\n' >&2
    exit 2
fi

mkdir -p "$RIVERFIELD_LOG"
exec > >(tee -a "$RIVERFIELD_LOG/start.log") 2>&1

failure() {
    printf '%s\nLog: %s/start.log\n' "$1" "$RIVERFIELD_LOG" >&2
    if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v notify-send >/dev/null; then
        notify-send "Riverfield: démarrage interrompu" "$1 — $RIVERFIELD_LOG/start.log" || true
    fi
    exit 1
}
# Load the same local configuration as run-backend.sh.
set -a
source "$RIVERFIELD_ROOT/.env" || failure "Impossible de charger la configuration locale .env."
set +a
service_lock || failure "Une autre commande Riverfield est encore en cours."

start_service() {
    local name="$1" port rows pid deadline
    port=$(service_port "$name")
    rows=$(listener_rows "$port") || failure "Impossible de vérifier le port $port."
    if ! pid=$(listener_pid "$name" "$rows"); then
        if [[ -n "$rows" ]]; then
            failure "Le port $port est occupé par un autre service. Consultez les journaux."
        fi
        if ! pid=$(saved_service_pid "$name"); then
            nohup setsid "$RIVERFIELD_ROOT/run-$name.sh" </dev/null >> "$RIVERFIELD_LOG/$name.log" 2>&1 9>&- &
            pid=$!
            printf '%s\n' "$pid" > "$RIVERFIELD_LOG/$name.pid"
            printf 'Démarrage de %s sur :%s\n' "$name" "$port"
        fi
    fi

    deadline=$((SECONDS + 120))
    while (( SECONDS < deadline )); do
        rows=$(listener_rows "$port") || failure "Impossible de vérifier le port $port."
        if pid=$(listener_pid "$name" "$rows"); then
            if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$port$(service_health_path "$name")" 2>/dev/null; then
                printf '%s\n' "$pid" > "$RIVERFIELD_LOG/$name.pid"
                printf '%s prêt sur :%s (PID %s)\n' "$name" "$port" "$pid"
                return
            fi
        elif [[ -n "$rows" ]]; then
            failure "Le port $port a été pris par un autre service."
        elif ! kill -0 "$(cat "$RIVERFIELD_LOG/$name.pid")" 2>/dev/null; then
            tail -12 "$RIVERFIELD_LOG/$name.log" 2>/dev/null || true
            failure "Le service $name s’est arrêté pendant le démarrage."
        fi
        sleep 1
    done
    tail -12 "$RIVERFIELD_LOG/$name.log" 2>/dev/null || true
    failure "Le service $name ne répond pas sur le port $port."
}

start_service backend
start_service web
start_service mcp

if [[ "$mode" != "--on-demand" ]]; then
    printf 'Démarrage de ComfyUI…\n'
    # Header via stdin: the local gateway token does not appear in the command line.
    if ! state=$(printf 'Authorization: Bearer %s\n' "${RIVERFIELD_TOKEN:-}" |
        curl -fsS --max-time 195 -X POST -H @- "http://127.0.0.1:$(service_port backend)/riverfield/workspace-comfy/wake"); then
        tail -12 "$RIVERFIELD_LOG/backend.log" 2>/dev/null || true
        failure "ComfyUI n’a pas pu démarrer."
    fi
    if ! comfy_port=$(printf '%s' "$state" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["state"]=="running"; print(int(d["port"]))'); then
        failure "Le gateway n’a pas confirmé que ComfyUI est prêt."
    fi
    printf 'ComfyUI prêt : http://127.0.0.1:%s/\n' "$comfy_port"
else
    printf 'ComfyUI démarre à la demande.\n'
fi

printf 'Riverfield : http://127.0.0.1:%s/\nMCP : http://127.0.0.1:%s/mcp\n' "$(service_port web)" "$(service_port mcp)"
