#!/usr/bin/env bash
# Deploy this repo to the jake.moqcdn.net rebroadcast station and install deps.
# After the first deploy, run scripts/receiver-setup.sh there once to bootstrap
# the runtime + nginx + systemd. Subsequent deploys just refresh code; re-copy
# the player and restart the unit.
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/Erik-Chris-Oregon.pem}"
HOST="${HOST:-ubuntu@jake.moqcdn.net}"
DEST="${DEST:-/home/ubuntu/hawkeye-data-stream}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no)

rsync -az --delete \
  --exclude node_modules --exclude .git --exclude '*.ts.tmp' --exclude 'scratch*' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "$HOST:$DEST/"

ssh "${SSH_OPTS[@]}" "$HOST" "cd '$DEST' && npm install --no-audit --no-fund \
  && sudo cp web/receiver.html /var/www/html/index.html 2>/dev/null || true \
  && sudo cp vendor/tracking.proto /var/www/html/tracking.proto 2>/dev/null || true \
  && sudo systemctl restart hawkeye-receiver 2>/dev/null || true"

echo "deployed to $HOST:$DEST"
