#!/usr/bin/env bash
# Fabrique la vignette d'un exemple vidéo, comme celles de web/examples/<app>/ :
#   card.mp4   petit clip muet pour la carte
#   poster.jpg une image fixe
#   full.mp4   le clip complet, audio compris
#
#   ./local/make-example-media.sh <app-id> <video.mp4> [seconde de la vignette]
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

app="${1:?app id}"
src="${2:?video}"
at="${3:-0.5}"
dir="web/examples/$app"
mkdir -p "$dir"

ffmpeg -y -v error -ss "$at" -i "$src" -frames:v 1 -q:v 3 "$dir/poster.jpg"
ffmpeg -y -v error -i "$src" -vf "scale=432:-2" -c:v libx264 -crf 30 -pix_fmt yuv420p -an "$dir/card.mp4"
ffmpeg -y -v error -i "$src" -c:v libx264 -crf 26 -pix_fmt yuv420p -c:a aac -b:a 96k \
  -movflags +faststart "$dir/full.mp4"

ls -l "$dir"
