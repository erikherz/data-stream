#!/usr/bin/env bash
# Periodically pull the SRT MPEG-TS back from the gateway, run bin/srt-snapshot.js
# on the captured TS, and write a compact JSON snapshot to the nginx webroot so
# the player's "Live SRT pull" card can show the tracks + a KLV peek.
#
# Run on the project server (alongside the SRT push). One-time webroot setup:
#   sudo mkdir -p /var/www/html/srt && sudo chown "$USER" /var/www/html/srt
set -uo pipefail
cd "$(dirname "$0")/.."

PULL_URL="${PULL_URL:-srt://54.69.119.129:20888}"
OUT="${OUT:-/var/www/html/srt/snapshot.json}"
INTERVAL="${INTERVAL:-5}"     # seconds between snapshots
GRAB="${GRAB:-3}"             # seconds of TS to capture per snapshot
LATENCY="${LATENCY:-200}"
CAP="$(mktemp /tmp/srt-snap.XXXXXX.ts)"
trap 'rm -f "$CAP"' EXIT

mkdir -p "$(dirname "$OUT")"
echo "srt-snapshot-loop: $PULL_URL -> $OUT every ${INTERVAL}s (grab ${GRAB}s)"

while true; do
  : > "$CAP"
  timeout "$GRAB" srt-live-transmit -q "${PULL_URL}?latency=${LATENCY}" file://con \
    > "$CAP" 2>/dev/null
  if [ -s "$CAP" ]; then
    if node bin/srt-snapshot.js "$CAP" > "$OUT.tmp" 2>/dev/null; then
      mv -f "$OUT.tmp" "$OUT"
    else
      echo "{\"time\":$(date +%s)000,\"error\":\"snapshot decode failed\"}" > "$OUT"
    fi
  else
    echo "{\"time\":$(date +%s)000,\"error\":\"no SRT data pulled\"}" > "$OUT"
  fi
  sleep "$INTERVAL"
done
