#!/usr/bin/env bash
# Serve the HLS player + the live stream through the existing nginx (port 80).
# Drops the player at the nginx webroot and points hls-publish at /var/www/html/hls,
# so the player (same origin) can fetch /hls/hawkeye.m3u8 and /tracking.proto.
set -u
cd "$(dirname "$0")/.."

WEBROOT="${WEBROOT:-/var/www/html}"
sudo mkdir -p "$WEBROOT/hls"
sudo cp web/player.html "$WEBROOT/index.html"
sudo cp web/ts-analyze.js "$WEBROOT/ts-analyze.js"
sudo cp vendor/tracking.proto "$WEBROOT/tracking.proto"
sudo chown -R "$USER" "$WEBROOT/hls" "$WEBROOT/index.html" "$WEBROOT/ts-analyze.js" "$WEBROOT/tracking.proto"

pkill -f hls-publish 2>/dev/null; sleep 1; rm -f "$WEBROOT"/hls/*
setsid bash -c "exec node bin/hls-publish.js '$WEBROOT/hls' hawkeye >/tmp/hls.log 2>&1" </dev/null >/dev/null 2>&1 &
sleep 4

echo "publisher: $(pgrep -af hls-publish | grep -v grep | head -1)"
echo "open: http://<server-ip>/   (player) — playlist at /hls/hawkeye.m3u8"
