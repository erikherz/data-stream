#!/usr/bin/env bash
# Make nginx serve the player over HTTPS on 443 with the luke.moqcdn.net cert.
# (The AWS security group already allows 443; nginx just wasn't listening on it.)
set -eu

sudo tee /etc/nginx/sites-available/luke-ssl >/dev/null << 'EOS'
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name luke.moqcdn.net _;

    root /var/www/html;
    index index.html;

    ssl_certificate     /etc/letsencrypt/live/luke.moqcdn.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/luke.moqcdn.net/privkey.pem;

    location /api/ { proxy_pass http://127.0.0.1:8090; }   # control-server (start/stop)
    location / { try_files $uri $uri/ =404; }
}
EOS

sudo ln -sf /etc/nginx/sites-available/luke-ssl /etc/nginx/sites-enabled/luke-ssl
sudo nginx -t
sudo systemctl reload nginx
echo "HTTPS enabled — open https://luke.moqcdn.net/"
