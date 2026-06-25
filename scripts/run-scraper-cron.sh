#!/bin/bash
# Cron wrapper for the feed scraper. Loads .env via dotenv in src/index.js (cwd = repo root).
set -euo pipefail

REPO="/Users/nick/repos/roku-feed"
NODE="/Users/nick/.nvm/versions/node/v20.19.6/bin/node"
LOG_DIR="$REPO/logs"
LOG_FILE="$LOG_DIR/scraper.log"

mkdir -p "$LOG_DIR"
cd "$REPO"

{
  echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") scraper start ==="
  "$NODE" src/index.js
  echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") scraper exit $? ==="
} >> "$LOG_FILE" 2>&1
