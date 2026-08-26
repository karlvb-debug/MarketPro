// Campaign creation + the dispatch-sender seam, against real Postgres.
//
// The seam matters for money: launching places an atomic authorization hold
// and flips the campaign to 'sending'. A deployment that cannot queue the
// channel must therefore not launch at all, or it strands a hold against a
// send that will never happen. Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { closePool } from '../src/db';
import type { RequestContext } from '../src/api/context';
import { createCampaign, listCampaigns } from '../src/api/campaigns';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('campaigns API (Postgres integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let segmentId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await runMigrations(pool);
  });

  beforeEach(async () => {
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('camp') RETURNING workspace_id`);
    workspaceId = ws.rows[0].workspace_id;
    const seg = await pool.query(
      `INSERT INTO segments (workspace_id, name) VALUES ($1,'All') RETURNING segment_id`,
      [workspaceId],
    );
    segmentId = seg.rows[0].segment_id;
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

  const validBody = () => ({
    name: 'Blast',
    channel: 'email',
    template_id: '11111111-1111-1111-1111-111111111111',
    segment_id: segmentId,
  });

  async function holdCount(): Promise<number> {
    const r = await pool.query(
      `SELECT count(*)::int c FROM transactions_ledger
        WHERE workspace_id = $1 AND type = 'AUTHORIZATION'`,
      [workspaceId],
    );
    return r.rows[0].c;
  }

  describe('validation', () => {
    test('viewer cannot create', async () => {
      expect((await createCampaign(ctx({ role: 'viewer' }), validBody())).status).toBe(403);
    });

    test('400s on a missing template_id instead of a NOT NULL 500', async () => {
      const { template_id, ...rest } = validBody();
      void template_id;
      const res = await createCampaign(ctx(), rest);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain('template_id');
    });

    test('400s on a missing segment_id', async () => {
      const { segment_id, ...rest } = validBody();
      void segment_id;
      expect((await createCampaign(ctx(), rest)).status).toBe(400);
    });

    test('400s on a channel outside the schema enum', async () => {
      const res = await createCampaign(ctx(), { ...validBody(), channel: 'carrier-pigeon' });
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain('channel must be one of');
    });

    test('400s on a status outside the schema enum', async () => {
      const res = await createCampaign(ctx(), { ...validBody(), status: 'definitely-not' });
      expect(res.status).toBe(400);
    });
  });

  describe('the dispatch-sender seam', () => {
    test('with no sender for the channel, the campaign is created but never launched', async () => {
      const res = await createCampaign(ctx(), validBody(), { senderFor: () => null });

      expect(res.status).toBe(201);
      expect((res.body as { status: string }).status).toBe('draft');
      // The critical assertion: no money was moved for a send that cannot happen.
      expect(await holdCount()).toBe(0);
    });

    test('omitting deps entirely behaves the same way', async () => {
      const res = await createCampaign(ctx(), validBody());
      expect((res.body as { status: string }).status).toBe('draft');
      expect(await holdCount()).toBe(0);
    });

    test('a future-dated send is left scheduled for the poller, not launched', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const sent: unknown[] = [];
      const res = await createCampaign(
        ctx(),
        { ...validBody(), scheduled_at: future },
        { senderFor: () => async (p) => { sent.push(p); } },
      );

      expect((res.body as { status: string }).status).toBe('scheduled');
      expect(sent).toHaveLength(0);
      expect(await holdCount()).toBe(0);
    });

    test('the sender is only asked for the campaign\'s own channel', async () => {
      const asked: string[] = [];
      await createCampaign(ctx(), validBody(), {
        senderFor: (channel) => { asked.push(channel); return null; },
      });
      expect(asked).toEqual(['email']);
    });
  });

  describe('list', () => {
    test('returns only this workspace\'s campaigns', async () => {
      await createCampaign(ctx(), validBody());

      const otherWs = (await pool.query(`INSERT INTO workspaces (name) VALUES ('o') RETURNING workspace_id`)).rows[0].workspace_id;
      const otherSeg = (await pool.query(
        `INSERT INTO segments (workspace_id, name) VALUES ($1,'S') RETURNING segment_id`, [otherWs],
      )).rows[0].segment_id;
      await createCampaign(ctx({ workspaceId: otherWs }), {
        ...validBody(), segment_id: otherSeg, name: 'Not yours',
      });

      const res = await listCampaigns(ctx());
      const names = (res.body as { data: { name: string }[] }).data.map((c) => c.name);
      expect(names).toEqual(['Blast']);
    });
  });
});
