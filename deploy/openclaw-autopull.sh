#!/bin/bash
set -e

cd /opt/openclaw/gateway

git fetch origin

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "[OpenClaw] Update detected, deploying..."
  git reset --hard origin/main
  docker-compose down
  docker-compose up -d --build --force-recreate
else
  echo "[OpenClaw] No changes"
fi
