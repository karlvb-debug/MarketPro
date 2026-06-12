// ============================================
// Versioned migration runner.
// Replaces the previous "one big idempotent SQL blob" approach with
// ordered, tracked, transactional migrations (schema_migrations table).
// Safe to run concurrently: a session-level advisory lock serializes
// runners, and applied ids are never re-applied.
// ============================================

import { Pool } from 'pg';
import { MIGRATIONS } from '../../database/migrations';

// Arbitrary fixed key for pg_advisory_lock, unique to this app's migrations
const MIGRATION_LOCK_KEY = 7_421_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(pool: Pool): Promise<MigrationResult> {
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const done = await client.query('SELECT id FROM schema_migrations');
    const doneIds = new Set<string>(done.rows.map((r) => r.id));

    for (const migration of MIGRATIONS) {
      if (doneIds.has(migration.id)) {
        skipped.push(migration.id);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration '${migration.id}' failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
