// Request-context resolution + the batch/settings route logic against real
// Postgres. These paths had no coverage as Lambda handlers; the port to
// transport-neutral functions is what made them testable.
// Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { closePool } from '../src/db';
import {
  GLOBAL_WORKSPACE_ID,
  resolveRequestContext,
  resolveWorkspaceRole,
  type RequestContext,
} from '../src/api/context';
import { loadBatch } from '../src/api/batch';
import { getSettings, updateSettings } from '../src/api/settings';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('request context + batch/settings (Postgres integration)', () => {
  let pool: Pool;
  let workspaceId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await runMigrations(pool);
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('ctx') RETURNING workspace_id`);
    workspaceId = ws.rows[0].workspace_id;
    await pool.query(
      `INSERT INTO users_workspaces (user_id, workspace_id, role) VALUES ($1,$2,'editor')`,
      ['user-editor', workspaceId],
    );
  });

  afterAll(async () => {
    await closePool(); // the route logic uses the shared singleton pool
    await pool?.end();
  });

  const ctxFor = (over: Partial<RequestContext> = {}): RequestContext => ({
    userId: 'user-editor',
    workspaceId,
    role: 'editor',
    isSuperAdmin: false,
    ...over,
  });

  describe('resolveWorkspaceRole', () => {
    test('returns the membership role', async () => {
      expect(await resolveWorkspaceRole('user-editor', workspaceId)).toBe('editor');
    });

    test('returns null for a non-member', async () => {
      expect(await resolveWorkspaceRole('nobody', workspaceId)).toBeNull();
    });

    test('denies gracefully on a malformed workspace id instead of throwing', async () => {
      expect(await resolveWorkspaceRole('user-editor', 'not-a-uuid')).toBeNull();
    });
  });

  describe('resolveRequestContext', () => {
    test('member gets their role in the requested workspace', async () => {
      const ctx = await resolveRequestContext({ userId: 'user-editor', isSuperAdmin: false }, workspaceId);
      expect(ctx).toEqual({ userId: 'user-editor', workspaceId, role: 'editor', isSuperAdmin: false });
    });

    test('non-member is denied', async () => {
      expect(await resolveRequestContext({ userId: 'nobody', isSuperAdmin: false }, workspaceId)).toBeNull();
    });

    test('global context yields an empty workspace and no role', async () => {
      const ctx = await resolveRequestContext({ userId: 'u', isSuperAdmin: false }, GLOBAL_WORKSPACE_ID);
      expect(ctx).toEqual({ userId: 'u', workspaceId: '', role: 'none', isSuperAdmin: false });
    });

    test('missing workspace header is treated as global context', async () => {
      const ctx = await resolveRequestContext({ userId: 'u', isSuperAdmin: false }, null);
      expect(ctx?.workspaceId).toBe('');
    });

    test('super admin reaches a workspace they are not a member of', async () => {
      const ctx = await resolveRequestContext({ userId: 'root', isSuperAdmin: true }, workspaceId);
      expect(ctx).toEqual({ userId: 'root', workspaceId, role: 'super_admin', isSuperAdmin: true });
    });

    test('super admin in global context still reads as super_admin', async () => {
      const ctx = await resolveRequestContext({ userId: 'root', isSuperAdmin: true }, null);
      expect(ctx?.role).toBe('super_admin');
    });
  });

  describe('batch', () => {
    test('400s without a workspace rather than leaking cross-tenant data', async () => {
      const res = await loadBatch(ctxFor({ workspaceId: '' }));
      expect(res.status).toBe(400);
    });

    test('returns the workspace bundle', async () => {
      await pool.query(`INSERT INTO segments (workspace_id, name) VALUES ($1,'S1')`, [workspaceId]);
      const res = await loadBatch(ctxFor());
      expect(res.status).toBe(200);
      const body = res.body as { segments: unknown[]; templates: Record<string, unknown[]>; settings: unknown };
      expect(body.segments).toHaveLength(1);
      expect(body.templates).toEqual({ email: [], sms: [], voice: [] });
      expect(body.settings).toBeNull();
    });

    test('scopes to the caller workspace only', async () => {
      const other = (await pool.query(`INSERT INTO workspaces (name) VALUES ('other') RETURNING workspace_id`)).rows[0].workspace_id;
      await pool.query(`INSERT INTO segments (workspace_id, name) VALUES ($1,'not-yours')`, [other]);
      const res = await loadBatch(ctxFor());
      const names = (res.body as { segments: { name: string }[] }).segments.map((s) => s.name);
      expect(names).not.toContain('not-yours');
    });
  });

  describe('settings', () => {
    test('viewer can read but not write', async () => {
      expect((await getSettings(ctxFor({ role: 'viewer' }))).status).toBe(200);
      const denied = await updateSettings(ctxFor({ role: 'viewer' }), { timezone: 'UTC' });
      expect(denied.status).toBe(403);
    });

    test('editor is still below the admin write bar', async () => {
      expect((await updateSettings(ctxFor(), { timezone: 'UTC' })).status).toBe(403);
    });

    test('admin upsert inserts then updates the same row', async () => {
      const admin = ctxFor({ role: 'admin' });
      expect((await updateSettings(admin, { timezone: 'America/Chicago', business_name: 'Acme' })).status).toBe(200);

      let read = await getSettings(admin);
      expect((read.body as { timezone: string; businessName: string }).timezone).toBe('America/Chicago');
      expect((read.body as { businessName: string }).businessName).toBe('Acme');

      expect((await updateSettings(admin, { timezone: 'UTC' })).status).toBe(200);
      read = await getSettings(admin);
      expect((read.body as { timezone: string }).timezone).toBe('UTC');

      const rows = await pool.query(`SELECT count(*)::int c FROM workspace_settings WHERE workspace_id = $1`, [workspaceId]);
      expect(rows.rows[0].c).toBe(1);
    });

    test('ignores non-string values from a hostile body', async () => {
      const admin = ctxFor({ role: 'admin' });
      await updateSettings(admin, { timezone: { $ne: null }, business_name: ['x'] });
      const read = await getSettings(admin);
      // timezone falls back to the column default rather than storing an object
      expect(typeof (read.body as { timezone: string }).timezone).toBe('string');
    });
  });
});
