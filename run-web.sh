#!/usr/bin/env bash
# RiverField's web UI on http://127.0.0.1:3000 (reads .env: COMFY_BASE_URL, RIVERFIELD_TOKEN).
# Needs the backend: ./run-backend.sh
#
# Un shell non interactif (systemd, cron, opencode) n'a pas nvm dans son PATH : on le
# retrouve nous-mêmes, sinon `npm` est introuvable et le web ne démarre pas.
set -Eeuo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v npm >/dev/null 2>&1 && [[ -d "$HOME/.nvm/versions/node" ]]; then
  newest=$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -1)
  export PATH="$HOME/.nvm/versions/node/$newest/bin:$PATH"
fi
command -v npm >/dev/null 2>&1 || {
  echo "ERROR: npm introuvable (Node 22.6+ requis, ou nvm non chargé)"
  exit 1
}

exec npm run serve
