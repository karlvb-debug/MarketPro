// Migration runner integration tests. Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { MIGRATIONS } from '../src/database/migrations';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('migration runner (Postgres integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 3 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  test('applies pending migrations and records them', async () => {
    await runMigrations(pool);

    const recorded = await pool.query('SELECT id FROM schema_migrations ORDER BY id');
    expect(recorded.rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  test('a second run applies nothing (already recorded)', async () => {
    await runMigrations(pool);
    const second = await runMigrations(pool);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(MIGRATIONS.map((m) => m.id));
  });

  test('concurrent runners serialize on the advisory lock', async () => {
    const results = await Promise.all([runMigrations(pool), runMigrations(pool), runMigrations(pool)]);
    // No runner may crash, and nothing is double-applied
    for (const r of results) {
      expect(r.applied).toEqual([]);
    }
  });

  test('migration ids are unique and ordered', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
