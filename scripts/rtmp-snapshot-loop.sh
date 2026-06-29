#!/usr/bin/env bash
# Periodically snapshot the RTMP stream relayed by the local Node-Media-Server
# (via its http-flv output) and write a compact JSON snapshot to the nginx
# webroot so the player's "Live RTMP" card can show the FLV tracks + a peek at
# the onHawkeye AMF data. RTMP analogue of scripts/srt-snapshot-loop.sh.
#
# One-time webroot setup:
#   sudo mkdir -p /var/www/html/rtmp && sudo chown "$USER" /var/www/html/rtmp
set -uo pipefail
cd "$(dirname "$0")/.."

FLV_URL="${FLV_URL:-http://127.0.0.1:8000/live/hawkeye.flv}"
OUT="${OUT:-/var/www/html/rtmp/snapshot.json}"
INTERVAL="${INTERVAL:-5}"     # seconds between snapshots
GRAB_MS="${GRAB_MS:-2500}"    # ms of FLV to sample per snapshot

mkdir -p "$(dirname "$OUT")"
echo "rtmp-snapshot-loop: $FLV_URL -> $OUT every ${INTERVAL}s (grab ${GRAB_MS}ms)"

while true; do
  if node bin/rtmp-snapshot.js "$FLV_URL" "$GRAB_MS" > "$OUT.tmp" 2>/dev/null && [ -s "$OUT.tmp" ]; then
    mv -f "$OUT.tmp" "$OUT"
  else
    echo "{\"time\":$(date +%s)000,\"error\":\"snapshot failed\"}" > "$OUT"
  fi
  sleep "$INTERVAL"
done
