# Shared by the local start/stop scripts. Linux /proc and ss identify only this checkout.
RIVERFIELD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RIVERFIELD_LOG="${RIVERFIELD_LOG:-/tmp/opencode/riverfield}"

service_port() {
    case "$1" in
        backend) printf '%s\n' "${GATEWAY_PORT:-8000}" ;;
        web) printf '%s\n' "${PORT:-3000}" ;;
        mcp) printf '%s\n' "${RIVERFIELD_MCP_PORT:-3010}" ;;
    esac
}

service_pid_matches() {
    local service="$1" pid="$2" root executable entry arg
    [[ "$pid" =~ ^[1-9][0-9]*$ && -O "/proc/$pid" ]] || return 1
    root=$(readlink -e "/proc/$pid/cwd") || return 1
    [[ "$root" == "$RIVERFIELD_ROOT" ]] || return 1
    executable=$(readlink -e "/proc/$pid/exe") || return 1
    case "$service:${executable##*/}" in
        backend:bash) entry=run-backend.sh ;;
        gateway:python|gateway:python[0-9]*) entry=infra/gateway.py ;;
        web:node|web:nodejs) entry=server/server.ts ;;
        mcp:node|mcp:nodejs) entry=mcp/server.ts ;;
        *) return 1 ;;
    esac
    # Script tokens are compared exactly even when Node changes its process name.
    while IFS= read -r -d '' arg; do
        if [[ "$arg" == "$entry" || "$arg" == "./$entry" || "$arg" == "$RIVERFIELD_ROOT/$entry" ]]; then
            return 0
        fi
    done 2>/dev/null < "/proc/$pid/cmdline"
    return 1
}

listener_rows() {
    ss -H -ltnp "sport = :$1"
}

listener_pid() {
    local service="$1" rows="$2" pid parent kind="$1"
    [[ "$service" == backend ]] && kind=gateway
    while [[ "$rows" =~ pid=([0-9]+) ]]; do
        pid=${BASH_REMATCH[1]}
        rows=${rows#*"pid=$pid"}
        service_pid_matches "$kind" "$pid" || continue
        if [[ "$service" == backend ]]; then
            parent=$(ps -o ppid= -p "$pid") || return 1
            parent=${parent//[[:space:]]/}
            if service_pid_matches backend "$parent"; then
                pid="$parent"
            fi
        fi
        printf '%s\n' "$pid"
        return 0
    done
    return 1
}

saved_service_pid() {
    local service="$1" pid
    pid=$(cat "$RIVERFIELD_LOG/$service.pid" 2>/dev/null) || return 1
    if service_pid_matches "$service" "$pid" || { [[ "$service" == backend ]] && service_pid_matches gateway "$pid"; }; then
        printf '%s\n' "$pid"
    else
        return 1
    fi
}

service_health_path() {
    [[ "$1" == web ]] && printf '/' || printf '/health'
}

service_lock() {
    mkdir -p "$RIVERFIELD_LOG" || return 1
    exec 9>"$RIVERFIELD_LOG/services.lock"
    flock -x -w 240 9
}
