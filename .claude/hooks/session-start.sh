#!/bin/bash
# SessionStart hook — make a fresh (ephemeral) web session ready to build and
# run the integration test suite with no manual setup. Idempotent; must never
# fail the session start, so risky steps are guarded with `|| true`.
set -uo pipefail

# Local devs manage their own environment; only run in the web/remote container.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# 1. Install dependencies if absent (npm install benefits from container caching).
if [ ! -d node_modules ]; then
  npm install || true
fi

# 2. Start the local PostgreSQL service (integration tests need it).
sudo service postgresql start >/dev/null 2>&1 || true

# 3. Ensure the test role + database exist (create only if a probe fails).
if ! psql postgresql://marketpro:marketpro@localhost:5432/marketpro_test -c 'select 1' >/dev/null 2>&1; then
  sudo -u postgres psql -c "CREATE USER marketpro WITH PASSWORD 'marketpro' SUPERUSER;" >/dev/null 2>&1 || true
  sudo -u postgres psql -c "CREATE DATABASE marketpro_test OWNER marketpro;" >/dev/null 2>&1 || true
fi

exit 0
