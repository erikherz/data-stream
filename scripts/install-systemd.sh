#!/usr/bin/env bash
# Install the Hawkeye systemd units so the whole stack survives reboots/crashes.
# Idempotent: safe to re-run after a deploy. Run on the project server.
#
#   bash scripts/install-systemd.sh
#
# Units (all Restart=always unless noted):
#   hawkeye-nms            Node-Media-Server (RTMP :1935, http-flv :8000)
#   hawkeye-control        control server / Start-Stop API (:8090)
#   hawkeye-srt-snapshot   SRT snapshot loop  -> /var/www/html/srt/snapshot.json
#   hawkeye-rtmp-snapshot  RTMP snapshot loop -> /var/www/html/rtmp/snapshot.json
#   hawkeye-autostart      oneshot: POST /api/start on boot (starts all publishers)
set -u
cd "$(dirname "$0")/.."

UNITS=(hawkeye-nms hawkeye-control hawkeye-srt-snapshot hawkeye-rtmp-snapshot hawkeye-autostart)

echo "=== webroot dirs (publisher + snapshot outputs) ==="
sudo mkdir -p /var/www/html/hls /var/www/html/srt /var/www/html/rtmp
sudo chown ubuntu /var/www/html/hls /var/www/html/srt /var/www/html/rtmp

echo "=== stop any hand-started infra (systemd will own these now) ==="
pkill -f '[s]rt-snapshot-loop'   2>/dev/null
pkill -f '[r]tmp-snapshot-loop'  2>/dev/null
pkill -f '[b]in/control-server.js' 2>/dev/null
pkill -f '[b]in/app.js'          2>/dev/null
sleep 2

echo "=== install unit files ==="
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload

echo "=== enable + start ==="
sudo systemctl enable --now "${UNITS[@]}"
sleep 4

echo "=== status ==="
systemctl --no-pager --plain is-active "${UNITS[@]}" | paste <(printf '%s\n' "${UNITS[@]}") -
echo "=== control API ==="
curl -sS -m 8 http://127.0.0.1:8090/api/status || echo "(control API not answering yet)"
echo
