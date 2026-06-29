#!/usr/bin/env bash
# Start the control-server (the start/stop API behind the player's button),
# detached. nginx proxies /api/ -> 127.0.0.1:8090 (see enable-https.sh and the
# port-80 server block). Run on the project server.
set -u
cd "$(dirname "$0")/.."

pkill -f bin/control-server.js 2>/dev/null; sleep 1
setsid bash -c "exec node bin/control-server.js > /tmp/control.log 2>&1" </dev/null >/dev/null 2>&1 &
sleep 3
echo "control pid: $(pgrep -f bin/control-server.js | head -1)"
echo "log: $(cat /tmp/control.log 2>/dev/null)"
echo "status: $(curl -sS -m 5 http://127.0.0.1:8090/api/status)"

# Also ensure the port-80 default server proxies /api/ (idempotent):
#   sudo sed -i '/server_name _;/a\        location /api/ { proxy_pass http://127.0.0.1:8090; }' \
#     /etc/nginx/sites-available/default && sudo nginx -t && sudo systemctl reload nginx
