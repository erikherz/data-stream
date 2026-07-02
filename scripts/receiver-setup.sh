#!/usr/bin/env bash
# One-shot bootstrap for the jake.moqcdn.net rebroadcast station.
# Installs the runtime (node, nginx, srt-tools), publishes the view-only player
# over HTTPS with the jake cert, and installs+starts the receiver systemd unit.
# Idempotent: safe to re-run after a deploy. Run on the server from the repo dir.
#
#   bash scripts/receiver-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${DOMAIN:-jake.moqcdn.net}"
REPO="$(pwd)"

echo "=== install runtime (node, nginx, srt-tools) ==="
if ! command -v node >/dev/null;  then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y nginx srt-tools

echo "=== node deps ==="
npm install --no-audit --no-fund

echo "=== webroot: player + proto + hls dir ==="
sudo mkdir -p /var/www/html/hls
sudo chown "$USER" /var/www/html/hls
# The player is served as index.html; tracking.proto is fetched by the page.
sudo cp web/receiver.html /var/www/html/index.html
sudo cp vendor/tracking.proto /var/www/html/tracking.proto

echo "=== nginx HTTPS site ($DOMAIN) ==="
sudo tee /etc/nginx/sites-available/jake-ssl >/dev/null << EOS
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN _;

    root /var/www/html;
    index index.html;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    # HLS: live playlist + segments, never cached.
    location /hls/ {
        add_header Cache-Control "no-store" always;
        add_header Access-Control-Allow-Origin "*" always;
        types { application/vnd.apple.mpegurl m3u8; video/mp2t ts; }
    }
    location / { try_files \$uri \$uri/ =404; }
}
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN _;
    return 301 https://\$host\$request_uri;
}
EOS
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/jake-ssl /etc/nginx/sites-enabled/jake-ssl
sudo nginx -t
sudo systemctl reload nginx

echo "=== receiver systemd unit ==="
sudo cp systemd/hawkeye-receiver.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hawkeye-receiver
sleep 2

echo "=== status ==="
systemctl --no-pager --plain is-active hawkeye-receiver | sed 's/^/hawkeye-receiver: /'
echo
echo "Player:   https://$DOMAIN/"
echo "Feed it:  point an SRT sender at  srt://$DOMAIN:${SRT_PORT:-9000}?mode=caller"
echo "          (ensure UDP ${SRT_PORT:-9000} is open in the AWS security group)"
