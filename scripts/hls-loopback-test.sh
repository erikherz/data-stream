#!/usr/bin/env bash
# Phase-3 verification: produce live HLS with an in-band ID3 metadata PID, then
# read the segments back and assert each ID3 tag re-decodes to a Frame.
# Run on the project server (the feed only resolves there).
set -u
cd "$(dirname "$0")/.."

OUT="${OUT:-/tmp/hls}"
NAME="${NAME:-hawkeye}"

pkill -f hls-publish 2>/dev/null; sleep 1; rm -rf "$OUT"
nohup node bin/hls-publish.js "$OUT" "$NAME" >/tmp/hls.log 2>&1 &
sleep 12

echo "=== publisher log ==="; tail -5 /tmp/hls.log
echo "=== playlist ==="; cat "$OUT/$NAME.m3u8" 2>/dev/null
echo "=== ffprobe a segment (expect h264 + timed_id3 'ID3 ') ==="
ffprobe -hide_banner -v error -show_entries stream=index,codec_type,codec_name,codec_tag_string,id \
  -of compact=p=0 "$(ls "$OUT/$NAME"*.ts 2>/dev/null | head -1)" 2>&1 | head
echo "=== hls-extract (ID3 round-trip) ==="
node bin/hls-extract.js "$OUT/$NAME.m3u8"

pkill -f hls-publish 2>/dev/null
