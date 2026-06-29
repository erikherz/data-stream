#!/usr/bin/env bash
# Start Node-Media-Server (stock) detached on the project server.
# RTMP :1935, http-flv :8000/<app>/<name>.flv. Logs to /tmp/nms.log.
set -u
NMS_DIR="${NMS_DIR:-$HOME/Node-Media-Server}"

pkill -f "bin/app.js" 2>/dev/null; sleep 1
cd "$NMS_DIR" || exit 1
[ -d node_modules ] || npm install --no-audit --no-fund
setsid bash -c "exec node bin/app.js > /tmp/nms.log 2>&1" < /dev/null > /dev/null 2>&1 &
sleep 3
ss -ltn | grep -E ":1935|:8000" && echo "NMS up (log: /tmp/nms.log)" || { echo "NMS failed:"; tail -20 /tmp/nms.log; exit 1; }
