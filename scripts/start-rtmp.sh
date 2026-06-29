#!/usr/bin/env bash
# Start the RTMP publisher detached on the project server: pushes video +
# onHawkeye data(18) messages to the local Node-Media-Server, which relays both
# to its RTMP and http-flv subscribers. Requires NMS running (start-nms.sh).
#
#   APP=live NAME=hawkeye VIDEO=/home/ubuntu/capture_12.mp4 bash scripts/start-rtmp.sh
set -u
cd "$(dirname "$0")/.."

APP="${APP:-live}"
NAME="${NAME:-hawkeye}"
export VIDEO="${VIDEO:-/home/ubuntu/capture_12.mp4}"

pkill -f rtmp-publish 2>/dev/null; sleep 1
setsid bash -c "exec node bin/rtmp-publish.js '$APP' '$NAME' > /tmp/pub2.log 2>&1" < /dev/null > /dev/null 2>&1 &
sleep 6

if pgrep -f rtmp-publish > /dev/null; then
  echo "RTMP publisher up: rtmp://127.0.0.1:1935/${APP}/${NAME} (VIDEO=$VIDEO)"
  echo "--- log ---"; tail -4 /tmp/pub2.log
else
  echo "RTMP publisher failed:"; tail -20 /tmp/pub2.log; exit 1
fi
