#!/usr/bin/env bash
# make_proxies.sh — Generate 720p H.264 proxies of the four camera videos
# for smooth 4-up web playback. Originals are kept intact for analysis.
#
# Usage:  bash scripts/make_proxies.sh         # encode missing
#         bash scripts/make_proxies.sh --force # re-encode everything
#
# Output: videos/proxies/<same-filename>.mp4

set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

mkdir -p videos/proxies

VIDEOS=(
  "AM_03-11_01_wide-inlet_no-obstacles.mp4"
  "skm_0311_01_wide_no-obs.mp4"
  "20260311_Linear Outlet_No Artifacts.mp4"
  "vmg_03-11_01.mp4"
)

for src in "${VIDEOS[@]}"; do
  in="videos/$src"
  out="videos/proxies/$src"

  if [[ ! -f "$in" ]]; then
    echo "SKIP: $in not found"
    continue
  fi
  if [[ -f "$out" && $FORCE -eq 0 ]]; then
    size=$(du -h "$out" | cut -f1)
    echo "SKIP: $out already exists ($size) — use --force to re-encode"
    continue
  fi

  src_size=$(du -h "$in" | cut -f1)
  echo "Encoding $src ($src_size)..."

  ffmpeg -hide_banner -loglevel warning -stats -y \
    -i "$in" \
    -vf "scale=-2:720" \
    -c:v libx264 -crf 26 -preset medium -pix_fmt yuv420p \
    -c:a aac -b:a 96k \
    -movflags +faststart \
    "$out"

  out_size=$(du -h "$out" | cut -f1)
  echo "  → $out ($out_size)"
done

echo ""
echo "Done. Proxies in videos/proxies/"
du -sh videos/proxies/ 2>/dev/null || true
