#!/usr/bin/env bash
# Fails if the Drizzle schema has changes not captured in a committed migration.
set -euo pipefail
pnpm --filter @aesa/db generate
drift_status=$(git status --porcelain packages/db/migrations)
if [ -n "$drift_status" ]; then
  echo "ERROR: schema drift — 'drizzle-kit generate' produced uncommitted migration changes:" >&2
  echo "$drift_status" >&2
  git checkout -- packages/db/migrations || true
  git clean -fd packages/db/migrations >/dev/null || true
  exit 1
fi
echo "migrations in sync with schema"
