#!/usr/bin/env bash
# Stop this checkout's studio processes and wait for graceful shutdown.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=local/service-lifecycle.sh
source ./local/service-lifecycle.sh
if [[ -f "$RIVERFIELD_ROOT/.env" ]]; then
    source "$RIVERFIELD_ROOT/.env"
fi
mkdir -p "$RIVERFIELD_LOG"
exec > >(tee -a "$RIVERFIELD_LOG/stop.log") 2>&1
service_lock || { printf 'Une autre commande Riverfield est encore en cours.\n' >&2; exit 1; }

declare -A stopping=()
failed=0
for name in mcp web backend; do
    port=$(service_port "$name")
    rows=$(listener_rows "$port") || { failed=1; continue; }
    if pid=$(listener_pid "$name" "$rows") || pid=$(saved_service_pid "$name"); then
        stopping[$name]=$pid
        kill -TERM "$pid" 2>/dev/null || true
    elif [[ -n "$rows" ]]; then
        printf 'Le port %s appartient à un autre service.\n' "$port"
    else
        rm -f "$RIVERFIELD_LOG/$name.pid"
    fi
done

deadline=$((SECONDS + 30))
for name in mcp web backend; do
    pid=${stopping[$name]:-}
    [[ -n "$pid" ]] || continue
    while service_pid_matches "$name" "$pid" || { [[ "$name" == backend ]] && service_pid_matches gateway "$pid"; }; do
        if (( SECONDS >= deadline )); then
            printf 'Le service %s (PID %s) attend toujours son arrêt.\n' "$name" "$pid" >&2
            failed=1
            break
        fi
        sleep 0.2
    done
    if ! service_pid_matches "$name" "$pid" && { [[ "$name" != backend ]] || ! service_pid_matches gateway "$pid"; }; then
        rm -f "$RIVERFIELD_LOG/$name.pid"
        printf '%s arrêté.\n' "$name"
    fi
done
exit "$failed"
