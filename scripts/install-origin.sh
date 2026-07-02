#!/usr/bin/env bash
# Install the "origin" deployment on a box that ALREADY runs another app (edge).
# Adds an independent nginx vhost (origin.moqcdn.net), webroot (/var/www/origin),
# and systemd units (origin-*) — WITHOUT touching edge's vhost (edge-ssl), webroot
# (/var/www/html), or unit (hawkeye-receiver). Idempotent; run on the origin box:
#
#   cd /home/ubuntu/origin-app && bash scripts/install-origin.sh
#
# Ports used by origin (all free w.r.t. edge): control 8090, NMS 1935+8000, SRT
# local listener 9000. Requires Node-Media-Server at ~/Node-Media-Server.
set -u
cd "$(dirname "$0")/.."
REPO="$(pwd)"

WEBROOT=/var/www/origin
UNITS=(origin-nms origin-control origin-srt-snapshot origin-rtmp-snapshot origin-autostart)

echo "=== [1/5] webroot + player assets (origin only, never /var/www/html) ==="
sudo mkdir -p "$WEBROOT/hls" "$WEBROOT/srt" "$WEBROOT/rtmp"
sudo cp web/player.html   "$WEBROOT/index.html"
sudo cp web/ts-analyze.js "$WEBROOT/ts-analyze.js"
sudo cp vendor/tracking.proto "$WEBROOT/tracking.proto"
sudo chown -R ubuntu "$WEBROOT"

echo "=== [2/5] NMS present? ==="
if [ ! -f "$HOME/Node-Media-Server/bin/app.js" ]; then
  echo "!! ERROR: $HOME/Node-Media-Server not found. Deploy NMS first." >&2
  exit 1
fi
[ -d "$HOME/Node-Media-Server/node_modules" ] || \
  (cd "$HOME/Node-Media-Server" && npm install --no-audit --no-fund)

echo "=== [3/5] nginx vhost (explicit server_name; edge untouched) ==="
sudo cp deploy/origin-ssl.nginx /etc/nginx/sites-available/origin-ssl
sudo ln -sfn /etc/nginx/sites-available/origin-ssl /etc/nginx/sites-enabled/origin-ssl
if ! sudo nginx -t; then
  echo "!! nginx -t FAILED — NOT reloading. Removing origin symlink to be safe." >&2
  sudo rm -f /etc/nginx/sites-enabled/origin-ssl
  exit 1
fi
sudo systemctl reload nginx   # reload, not restart: never drops edge's TLS

echo "=== [4/5] systemd units (origin-*) ==="
sudo cp systemd/origin/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now "${UNITS[@]}"
sleep 5

echo "=== [5/5] verify — origin up AND edge unharmed ==="
systemctl --no-pager --plain is-active "${UNITS[@]}" | paste <(printf '%s\n' "${UNITS[@]}") -
echo -n "hawkeye-receiver (edge): "; systemctl is-active hawkeye-receiver
curl -sS -m 8 http://127.0.0.1:8090/api/status || echo "(control API not answering yet)"
echo
curl -sS -o /dev/null -w "edge   https %{http_code}\n" https://edge.moqcdn.net/   || true
curl -sS -o /dev/null -w "origin https %{http_code}\n" https://origin.moqcdn.net/ || true
