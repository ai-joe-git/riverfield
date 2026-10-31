#!/usr/bin/env bash
# The RiverField MCP server, next to the app: http://127.0.0.1:3010/mcp (HTTP, streamable).
# Needs the web app (it calls its API). Pass --stdio to speak stdio instead.
set -Eeuo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1 && [[ -d "$HOME/.nvm/versions/node" ]]; then
  newest=$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -1)
  export PATH="$HOME/.nvm/versions/node/$newest/bin:$PATH"
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: node introuvable (Node 22.6+ requis, ou nvm non chargé)"; exit 1; }

exec node --experimental-strip-types --disable-warning=ExperimentalWarning mcp/server.ts "$@"
