#!/usr/bin/env bash
# Phase-1 verification: publish the muxed TS (video + Hawkeye data PID) over SRT,
# pull it back as an SRT caller, and assert the data PID re-decodes to Frames.
# Run on the project server (the feed only resolves there).
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-9000}"
SECONDS_PULL="${SECONDS_PULL:-6}"
CAP="${CAP:-/tmp/cap.ts}"

pkill -f srt-publish 2>/dev/null; pkill -f srt-live-transmit 2>/dev/null; sleep 1

# Publisher -> SRT listener, detached; logs to /tmp.
nohup bash -c "node bin/srt-publish.js 2>/tmp/pub.log | \
  srt-live-transmit -q file://con \"srt://:${PORT}?mode=listener&latency=120\" 2>/tmp/srt-tx.log" \
  >/dev/null 2>&1 &
sleep 3

# Pull as an SRT caller into a file.
timeout "$SECONDS_PULL" srt-live-transmit -q "srt://127.0.0.1:${PORT}?latency=120" file://con \
  > "$CAP" 2>/tmp/srt-rx.log
echo "pull exit=$? ($(wc -c < "$CAP") bytes captured)"

pkill -f srt-publish 2>/dev/null; pkill -f srt-live-transmit 2>/dev/null

echo "=== ffprobe (streams in SRT-delivered TS) ==="
ffprobe -hide_banner -v error -show_entries stream=index,codec_type,codec_name,id \
  -of compact=p=0 "$CAP" 2>/dev/null | sort -u
echo "=== extract + verify data PID ==="
# NB: a trailing partial frame is expected when timeout cuts the capture mid-PES.
node bin/ts-extract.js "$CAP"
