#!/usr/bin/env bash
# Deploy this repo to the ORIGIN box, into its own dir (/home/ubuntu/origin-app).
# This box also runs "edge" out of /home/ubuntu/hawkeye-data-stream — we never
# touch that dir. Safe to re-run.
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/Erik-Chris-Oregon.pem}"
HOST="${HOST:-ubuntu@origin.moqcdn.net}"
DEST="${DEST:-/home/ubuntu/origin-app}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

rsync -az --delete \
  --exclude node_modules --exclude .git --exclude '*.ts.tmp' --exclude 'scratch*' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "$HOST:$DEST/"

ssh "${SSH_OPTS[@]}" "$HOST" "cd '$DEST' && npm install --no-audit --no-fund"

echo "deployed to $HOST:$DEST"
