#!/usr/bin/env bash
# Met RiverField à jour depuis le dépôt upstream (Freefield), sans perdre les ajouts locaux.
#
#   ./update.sh
#
# RiverField est un fork : `origin` = ton dépôt, `upstream` = neuregex/freefield.
# Le merge peut demander des résolutions ; rien n'est écrasé automatiquement.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

git fetch upstream
if git merge --no-edit upstream/main; then
  echo "== upstream mergé"
else
  echo
  echo "conflit : résous-les, puis : git add -A && git commit"
  exit 1
fi

if ! git diff --quiet HEAD@{1} HEAD -- package.json package-lock.json 2>/dev/null; then
  echo "== package.json a changé : npm install"
  npm install --no-fund --no-audit
fi

# les workflows H3 de base ont peut-être bougé : on réaligne les clones turbo
python3 local/make-turbo-apps.py
./local/restore-comfy.sh || true
npm run validate

echo
echo "à jour ($(git log -1 --format='%h %s'))"
echo "relancer : ./stop.sh && ./start.sh"
