#!/usr/bin/env bash
# Deploy this repo to the project server and install deps there.
# The Hawkeye feed only resolves from the server, and the muxers push to
# NMS/SRT on that box, so all running/testing happens server-side.
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/brian-may-2026.pem}"
# Use the DNS name, not a hardcoded IP: the box's public IP changes on stop/start.
HOST="${HOST:-ubuntu@luke.moqcdn.net}"
DEST="${DEST:-/home/ubuntu/hawkeye-data-stream}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no)

rsync -az --delete \
  --exclude node_modules --exclude .git --exclude '*.ts.tmp' --exclude 'scratch*' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "$HOST:$DEST/"

ssh "${SSH_OPTS[@]}" "$HOST" "cd '$DEST' && npm install --no-audit --no-fund"

echo "deployed to $HOST:$DEST"
