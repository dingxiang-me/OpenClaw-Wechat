#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/5] Syntax check"
npm run test:syntax

echo "[2/5] Unit tests"
npm test

echo "[3/5] WeCom selfcheck (all discovered accounts)"
npm run wecom:selfcheck -- --all-accounts "$@"

echo "[4/5] Gateway health"
openclaw gateway health

echo "[5/5] OpenClaw status (summary)"
openclaw status --all | sed -n '1,120p'

echo "Smoke check completed."
