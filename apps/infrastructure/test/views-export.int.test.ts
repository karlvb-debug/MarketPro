// Saved views (visibility/ownership) + contact export (CSV streaming) against
// real Postgres. The export uses an in-memory sink so the streaming/CSV logic
// is exercised without S3. Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { runMigrations } from '../lambda/lib/migrate';
import { runExport, csvEscape, resolveColumns } from '../lambda/lib/export';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describe('csvEscape (pure)', () => {
  test('quotes fields with commas, quotes, and newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(42)).toBe('42');
  });
});

describeDb('saved views + export (Postgres integration)', () => {
  let pool: Pool;
  let workspaceId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await runMigrations(pool);
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('ve') RETURNING workspace_id`);
    workspaceId = ws.rows[0].workspace_id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('views visibility', () => {
    test('a user sees their own views and shared ones, not others private views', async () => {
      await pool.query(`INSERT INTO views (workspace_id, user_id, name, shared) VALUES ($1,'userA','A private',false)`, [workspaceId]);
      await pool.query(`INSERT INTO views (workspace_id, user_id, name, shared) VALUES ($1,'userA','A shared',true)`, [workspaceId]);
      await pool.query(`INSERT INTO views (workspace_id, user_id, name, shared) VALUES ($1,'userB','B private',false)`, [workspaceId]);

      const visibleToB = await pool.query(
        `SELECT name FROM views WHERE workspace_id = $1 AND (user_id = $2 OR shared = TRUE) ORDER BY name`,
        [workspaceId, 'userB'],
      );
      expect(visibleToB.rows.map((r) => r.name)).toEqual(['A shared', 'B private']);
    });
  });

  describe('contact export', () => {
    async function seedContacts(n: number, custom = false) {
      const localWs = (await pool.query(`INSERT INTO workspaces (name) VALUES ('exp') RETURNING workspace_id`)).rows[0].workspace_id;
      if (custom) {
        await pool.query(`INSERT INTO custom_field_definitions (workspace_id, name, key, type) VALUES ($1,'Plan','plan','text')`, [localWs]);
      }
      for (let i = 0; i < n; i++) {
        await pool.query(
          `INSERT INTO contacts (workspace_id, email, first_name, status, custom_fields)
           VALUES ($1, $2, $3, 'active', $4)`,
          [localWs, `e${i}@x.com`, `First${i}`, JSON.stringify(custom ? { plan: i % 2 ? 'pro' : 'free' } : {})],
        );
      }
      return localWs;
    }

    function memSink() {
      let buf = '';
      return { sink: { write: (c: string) => { buf += c; } }, get: () => buf };
    }

    test('streams a header + one row per matching contact, CSV-escaped', async () => {
      const ws = await seedContacts(3);
      const { sink, get } = memSink();
      const result = await runExport(pool, ws, { all: true }, null, sink);

      expect(result.rowCount).toBe(3);
      const lines = get().trim().split('\r\n');
      expect(lines[0]).toBe('email,phone,first_name,last_name,company,status,created_at');
      expect(lines).toHaveLength(4); // header + 3
      expect(lines.some((l) => l.startsWith('e0@x.com,'))).toBe(true);
    });

    test('honors a rule selection and requested columns incl. custom fields', async () => {
      const ws = await seedContacts(4, true);
      const { sink, get } = memSink();
      const result = await runExport(
        pool, ws,
        { rules: { combinator: 'and', conditions: [{ field: 'custom.plan', op: 'eq', value: 'pro' }] } },
        ['email', 'custom.plan'],
        sink,
      );
      expect(result.rowCount).toBe(2); // i=1,3 are 'pro'
      const lines = get().trim().split('\r\n');
      expect(lines[0]).toBe('email,custom.plan');
      expect(lines.slice(1).every((l) => l.endsWith(',pro'))).toBe(true);
    });

    test('paginates past the page size (keyset) without dropping rows', async () => {
      const ws = await seedContacts(1001);
      const { sink, get } = memSink();
      const result = await runExport(pool, ws, { all: true }, null, sink);
      expect(result.rowCount).toBe(1001);
      expect(get().trim().split('\r\n')).toHaveLength(1002); // header + 1001
    });

    test('explicit contactIds selection', async () => {
      const ws = await seedContacts(3);
      const ids = (await pool.query(`SELECT contact_id FROM contacts WHERE workspace_id = $1 LIMIT 2`, [ws])).rows.map((r) => r.contact_id);
      const { sink, get } = memSink();
      const result = await runExport(pool, ws, { contactIds: ids }, ['email'], sink);
      expect(result.rowCount).toBe(2);
      expect(get().trim().split('\r\n')[0]).toBe('email');
    });

    test('resolveColumns drops unknown columns and falls back to defaults', async () => {
      const ws = await seedContacts(1);
      const resolved = await resolveColumns(pool, ws, ['email', 'nonsense', 'custom.ghost']);
      expect(resolved.headers).toEqual(['email']);
      const dflt = await resolveColumns(pool, ws, []);
      expect(dflt.headers).toContain('email');
      expect(dflt.headers).toContain('status');
    });
  });
});
