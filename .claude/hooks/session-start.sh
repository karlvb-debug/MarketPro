#!/bin/bash
# SessionStart hook — make a fresh (ephemeral) web session ready to build and
# run the integration test suite with no manual setup. Idempotent; must never
# fail the session start, so risky steps are guarded with `|| true`.
set -uo pipefail

TEST_DB_URL='postgresql://marketpro:marketpro@localhost:5432/marketpro_test'

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
if ! psql "$TEST_DB_URL" -c 'select 1' >/dev/null 2>&1; then
  sudo -u postgres psql -c "CREATE USER marketpro WITH PASSWORD 'marketpro' SUPERUSER;" >/dev/null 2>&1 || true
  sudo -u postgres psql -c "CREATE DATABASE marketpro_test OWNER marketpro;" >/dev/null 2>&1 || true
fi

# 4. Verify loudly. Steps above are intentionally silent about failure so they
#    can never break session start — but a *silent* failure here is dangerous:
#    the 8 `*.int.test.ts` suites SKIP without a reachable DB, so the gate still
#    reports green while the rule engine, billing, dispatch and migration tests
#    never ran. Warn rather than fail.
if ! psql "$TEST_DB_URL" -c 'select 1' >/dev/null 2>&1; then
  echo "WARNING: $TEST_DB_URL is unreachable." >&2
  echo "         The 8 *.int.test.ts suites will SKIP — a green gate does NOT" >&2
  echo "         mean the rule engine / billing / dispatch tests actually ran." >&2
  echo "         Check: sudo service postgresql start" >&2
fi

exit 0
