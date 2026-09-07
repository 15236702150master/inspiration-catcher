#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/op/apps/inspiration-catcher}"
REPORT_FILE="${REPORT_FILE:-/home/op/backups/inspiration-catcher/post-schema-v2-observation.txt}"
SINCE="${1:-2026-07-26 13:19:51}"

mkdir -p "$(dirname "$REPORT_FILE")"
{
  echo "observed_at=$(date --iso-8601=seconds)"
  echo "since=$SINCE"
  echo "service=$(systemctl --user is-active inspiration-catcher.service)"
  echo "health=$(curl -fsS http://127.0.0.1:4173/api/health)"
  echo "database_audit:"
  cd "$APP_DIR"
  node scripts/audit-workspace-db.mjs --db data/inspiration.sqlite3
  echo "error_log_matches:"
  journalctl --user -u inspiration-catcher.service --since "$SINCE" --no-pager \
    | grep -Ei "REVISION_CONFLICT|SQLITE|FOREIGN KEY|uncaught|unhandled|write.*(fail|error)|status.: ?5[0-9][0-9]" \
    || true
} > "$REPORT_FILE"

echo "$REPORT_FILE"
