#!/usr/bin/env bash
# Phase-2 verification: publish video + onHawkeye data messages to NMS over RTMP,
# then pull the relayed http-flv back and assert the data re-decodes to Frames.
# Requires NMS running (scripts/start-nms.sh). Run on the project server.
set -u
cd "$(dirname "$0")/.."

APP="${APP:-live}"
NAME="${NAME:-hawkeye}"
URL="http://127.0.0.1:8000/${APP}/${NAME}.flv"

pkill -f rtmp-publish 2>/dev/null; sleep 1
nohup node bin/rtmp-publish.js "$APP" "$NAME" >/tmp/pub2.log 2>&1 &
sleep 5

echo "=== publisher log ==="; tail -5 /tmp/pub2.log
echo "=== ffprobe http-flv (expect a data track + h264 video) ==="
timeout 8 ffprobe -hide_banner -v error -show_entries stream=index,codec_type,codec_name \
  -of compact=p=0 "$URL" 2>&1 | head -5
echo "=== flv-extract (data round-trip through NMS) ==="
node bin/flv-extract.js "$URL" 6

pkill -f rtmp-publish 2>/dev/null
