// ============================================
// DB Migration Lambda
// Applies pending versioned migrations (database/migrations/) on invoke.
// Invoked automatically on every deploy via a CDK Trigger, and can be
// invoked manually for ad-hoc runs. Idempotent and concurrency-safe
// (advisory lock + schema_migrations tracking).
// ============================================

import { getPool } from './lib/db';
import { runMigrations } from '@repo/core/migrate';
import { Logger } from '@repo/core/logger';

export const handler = async () => {
  const logger = new Logger({ handler: 'db-migrate' });
  logger.info('Starting database migration run');

  const pool = await getPool();
  const result = await runMigrations(pool);

  logger.info('Migration run complete', {
    applied: result.applied,
    skippedCount: result.skipped.length,
  });

  return {
    status: 'SUCCESS',
    applied: result.applied,
    alreadyApplied: result.skipped,
  };
};
