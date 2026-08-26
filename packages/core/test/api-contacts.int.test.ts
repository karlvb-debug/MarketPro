// Contacts route logic against real Postgres. This surface had no coverage as
// a Lambda handler. Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { closePool } from '../src/db';
import type { RequestContext } from '../src/api/context';
import {
  bulkDeleteContacts,
  createContact,
  createImportUrl,
  deleteContact,
  getContact,
  importContacts,
  listContacts,
  searchContacts,
  updateContact,
} from '../src/api/contacts';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('contacts API (Postgres integration)', () => {
  let pool: Pool;
  let workspaceId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await runMigrations(pool);
  });

  beforeEach(async () => {
    // A fresh workspace per test keeps the upsert/dedupe cases isolated.
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('c') RETURNING workspace_id`);
    workspaceId = ws.rows[0].workspace_id;
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
  });

  const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
    userId: 'u1',
    workspaceId,
    role: 'editor',
    isSuperAdmin: false,
    ...over,
  });

  const body = (o: Record<string, unknown>) => o;

  describe('RBAC', () => {
    test('viewer cannot create', async () => {
      const res = await createContact(ctx({ role: 'viewer' }), body({ email: 'a@b.com' }));
      expect(res.status).toBe(403);
    });

    test('editor cannot delete; admin can', async () => {
      const made = await createContact(ctx(), body({ email: 'del@b.com' }));
      const id = (made.body as { contactId: string }).contactId;
      expect((await deleteContact(ctx(), id)).status).toBe(403);
      expect((await deleteContact(ctx({ role: 'admin' }), id)).status).toBe(204);
      expect((await getContact(ctx(), id)).status).toBe(404);
    });

    test('no workspace yields 400, not a cross-tenant read', async () => {
      expect((await listContacts(ctx({ workspaceId: '' }))).status).toBe(400);
    });
  });

  describe('create / upsert', () => {
    test('creates a new contact as 201', async () => {
      const res = await createContact(ctx(), body({ email: 'new@b.com', first_name: 'New' }));
      expect(res.status).toBe(201);
      expect((res.body as { firstName: string }).firstName).toBe('New');
    });

    test('second create on the same email upserts as 200 and keeps non-empty fields', async () => {
      await createContact(ctx(), body({ email: 'dup@b.com', first_name: 'First', company: 'Acme' }));
      const res = await createContact(ctx(), body({ email: 'dup@b.com', last_name: 'Last' }));
      expect(res.status).toBe(200);
      const row = res.body as { firstName: string; lastName: string; company: string };
      expect(row.firstName).toBe('First'); // preserved
      expect(row.lastName).toBe('Last');   // applied
      expect(row.company).toBe('Acme');    // preserved
    });

    test('an unsubscribed contact is never silently reactivated', async () => {
      const made = await createContact(ctx(), body({ email: 'sub@b.com' }));
      const id = (made.body as { contactId: string }).contactId;
      await updateContact(ctx(), id, body({ status: 'unsubscribed' }));

      const again = await createContact(ctx(), body({ email: 'sub@b.com', status: 'active' }));
      expect((again.body as { status: string }).status).toBe('unsubscribed');
    });

    test('suppression list is populated when a contact unsubscribes', async () => {
      const made = await createContact(ctx(), body({ email: 'supp@b.com' }));
      const id = (made.body as { contactId: string }).contactId;
      await updateContact(ctx(), id, body({ status: 'unsubscribed' }));

      const rows = await pool.query(
        `SELECT reason FROM suppression_list WHERE workspace_id = $1`, [workspaceId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].reason).toBe('unsubscribe');
    });

    test('rejects an unknown status instead of 500ing on the enum', async () => {
      const made = await createContact(ctx(), body({ email: 'st@b.com' }));
      const id = (made.body as { contactId: string }).contactId;
      const res = await updateContact(ctx(), id, body({ status: 'banana' }));
      expect(res.status).toBe(400);
    });

    test('ignores an unknown consent_source rather than 500ing on the enum', async () => {
      const res = await createContact(ctx(), body({ email: 'cs@b.com', consent_source: 'nonsense' }));
      expect(res.status).toBe(201);
      expect((res.body as { consentSource: string | null }).consentSource).toBeNull();
    });

    test('accepts a valid consent_source', async () => {
      const res = await createContact(ctx(), body({ email: 'cs2@b.com', consent_source: 'collected_by_us' }));
      expect((res.body as { consentSource: string }).consentSource).toBe('collected_by_us');
    });
  });

  describe('update', () => {
    test('rejects an email already used by another contact', async () => {
      await createContact(ctx(), body({ email: 'taken@b.com' }));
      const other = await createContact(ctx(), body({ email: 'other@b.com' }));
      const id = (other.body as { contactId: string }).contactId;

      const res = await updateContact(ctx(), id, body({ email: 'taken@b.com' }));
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain('already exists');
    });

    test('a partial update does not clobber untouched columns', async () => {
      const made = await createContact(ctx(), body({ email: 'p@b.com', first_name: 'Keep', company: 'Co' }));
      const id = (made.body as { contactId: string }).contactId;

      await updateContact(ctx(), id, body({ company: 'New Co' }));
      const read = await getContact(ctx(), id);
      const row = read.body as { firstName: string; company: string };
      expect(row.firstName).toBe('Keep');
      expect(row.company).toBe('New Co');
    });

    test('404s for a contact in another workspace', async () => {
      const otherWs = (await pool.query(`INSERT INTO workspaces (name) VALUES ('o') RETURNING workspace_id`)).rows[0].workspace_id;
      const foreign = await createContact(ctx({ workspaceId: otherWs }), body({ email: 'f@b.com' }));
      const foreignId = (foreign.body as { contactId: string }).contactId;

      expect((await getContact(ctx(), foreignId)).status).toBe(404);
      expect((await updateContact(ctx(), foreignId, body({ company: 'x' }))).status).toBe(404);
    });
  });

  describe('list', () => {
    test('paginates with a keyset cursor and reports the unpaginated total', async () => {
      for (let i = 0; i < 5; i++) {
        await createContact(ctx(), body({ email: `p${i}@b.com` }));
      }
      const first = await listContacts(ctx(), { pageSize: '2' });
      const meta = (first.body as { meta: { total: number; hasMore: boolean; nextCursor: string } }).meta;
      expect(meta.total).toBe(5);
      expect(meta.hasMore).toBe(true);

      const second = await listContacts(ctx(), { pageSize: '2', cursor: meta.nextCursor });
      const firstIds = (first.body as { data: { contactId: string }[] }).data.map((c) => c.contactId);
      const secondIds = (second.body as { data: { contactId: string }[] }).data.map((c) => c.contactId);
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    });

    test('filters by search across name, email and company', async () => {
      await createContact(ctx(), body({ email: 'findme@b.com', first_name: 'Zoe' }));
      await createContact(ctx(), body({ email: 'nope@b.com', first_name: 'Bob' }));

      const res = await listContacts(ctx(), { search: 'Zoe' });
      expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    });

    test('an unknown status filter is ignored rather than erroring', async () => {
      await createContact(ctx(), body({ email: 'k@b.com' }));
      const res = await listContacts(ctx(), { status: 'not-a-status' });
      expect(res.status).toBe(200);
      expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    });
  });

  describe('search (rule engine)', () => {
    test('400s on an invalid rule tree instead of leaking SQL', async () => {
      const res = await searchContacts(ctx(), body({ rules: { combinator: 'and', conditions: [{ field: 'DROP TABLE contacts', op: 'eq', value: 'x' }] } }));
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain('Invalid rules');
    });

    test('returns matching contacts for a valid rule tree', async () => {
      await createContact(ctx(), body({ email: 'match@b.com', first_name: 'Match' }));
      await createContact(ctx(), body({ email: 'skip@b.com', first_name: 'Skip' }));

      const res = await searchContacts(ctx(), body({
        rules: { combinator: 'and', conditions: [{ field: 'first_name', op: 'eq', value: 'Match' }] },
      }));
      expect(res.status).toBe(200);
      expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    });
  });

  describe('import', () => {
    test('imports valid rows and rejects those with neither email nor phone', async () => {
      const res = await importContacts(ctx(), body({
        contacts: [
          { email: 'i1@b.com', first_name: 'One' },
          { phone: '+15550001111', first_name: 'Two' },
          { first_name: 'NoContactInfo' },
        ],
      }));
      expect(res.status).toBe(200);
      const out = res.body as { imported: number; rejected: number };
      expect(out.imported).toBe(2);
      expect(out.rejected).toBe(1);
    });

    test('rejects non-object rows without throwing', async () => {
      const res = await importContacts(ctx(), body({ contacts: ['a string', 42, null, { email: 'ok@b.com' }] }));
      expect(res.status).toBe(200);
      expect((res.body as { imported: number }).imported).toBe(1);
    });

    test('400s when no contacts are provided', async () => {
      expect((await importContacts(ctx(), body({ contacts: [] }))).status).toBe(400);
    });
  });

  describe('bulk delete', () => {
    test('deletes only ids inside the caller workspace', async () => {
      const mine = await createContact(ctx(), body({ email: 'mine@b.com' }));
      const mineId = (mine.body as { contactId: string }).contactId;

      const otherWs = (await pool.query(`INSERT INTO workspaces (name) VALUES ('o2') RETURNING workspace_id`)).rows[0].workspace_id;
      const theirs = await createContact(ctx({ workspaceId: otherWs }), body({ email: 'theirs@b.com' }));
      const theirsId = (theirs.body as { contactId: string }).contactId;

      const res = await bulkDeleteContacts(ctx({ role: 'admin' }), body({ ids: [mineId, theirsId] }));
      expect((res.body as { deleted: number }).deleted).toBe(1);

      const survivor = await pool.query(`SELECT 1 FROM contacts WHERE contact_id = $1`, [theirsId]);
      expect(survivor.rows).toHaveLength(1);
    });

    test('400s when ids is absent or not an array of strings', async () => {
      expect((await bulkDeleteContacts(ctx({ role: 'admin' }), body({}))).status).toBe(400);
      expect((await bulkDeleteContacts(ctx({ role: 'admin' }), body({ ids: [1, 2] }))).status).toBe(400);
    });
  });

  describe('import-url', () => {
    test('500s when no storage is wired, and never fabricates a URL', async () => {
      const res = await createImportUrl(ctx(), {}, {});
      expect(res.status).toBe(500);
    });

    test('namespaces the upload key by workspace when storage is wired', async () => {
      let seenKey = '';
      const res = await createImportUrl(ctx(), {}, {
        presignUpload: async (key) => { seenKey = key; return `https://example.test/${key}`; },
      });
      expect(res.status).toBe(200);
      expect(seenKey.startsWith(`${workspaceId}/`)).toBe(true);
    });
  });
});
