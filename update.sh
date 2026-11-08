#!/usr/bin/env bash
# Update RiverField from origin; Freefield upstream is reviewed separately.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

case "${1:-}" in
  --check-upstream)
    git fetch --no-tags upstream main
    echo "Freefield's latest commits (not necessarily missing from RiverField):"
    git log -10 --format='%h %cs %s' FETCH_HEAD
    echo "No merge performed. See docs/upstream-sync.md for patch-based review."
    exit 0
    ;;
  "") ;;
  *) echo "Usage: ./update.sh [--check-upstream]" >&2; exit 2 ;;
esac

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or preserve your changes before updating." >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Switch to main before updating." >&2
  exit 1
fi
before=$(git rev-parse HEAD)
git fetch origin main
git merge --ff-only origin/main

if ! git diff --quiet "$before" HEAD -- package.json package-lock.json; then
  npm install --no-fund --no-audit
fi

# Optional machine-local overlays are absent on a fresh clone.
if [[ -f local/make-turbo-apps.py ]]; then python3 local/make-turbo-apps.py; fi
if [[ -f local/restore-comfy.sh ]]; then bash local/restore-comfy.sh; fi
npm run validate
echo "RiverField updated ($(git log -1 --format='%h %s'))."
echo "Services were not restarted. When idle: ./stop.sh && ./start.sh"
