// Campaign launch integration tests (claim → authorize → queue) against
// real Postgres. Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { findDueCampaigns, launchCampaign, LaunchableCampaign } from '../src/campaign-launch';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('campaign launch (Postgres integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeFixture(opts: {
    balance: string;
    contacts: number;
    status?: string;
    scheduledAt?: string; // SQL interval offset, e.g. "-1 hour"
  }): Promise<LaunchableCampaign> {
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('t') RETURNING workspace_id`);
    const workspaceId = ws.rows[0].workspace_id;
    await pool.query(
      `INSERT INTO account_balances (workspace_id, available_credits, hold_credits) VALUES ($1, $2, 0)`,
      [workspaceId, opts.balance],
    );
    const seg = await pool.query(
      `INSERT INTO segments (workspace_id, name) VALUES ($1, 's') RETURNING segment_id`,
      [workspaceId],
    );
    const segmentId = seg.rows[0].segment_id;

    for (let i = 0; i < opts.contacts; i++) {
      const c = await pool.query(
        `INSERT INTO contacts (workspace_id, email, status) VALUES ($1, $2, 'active') RETURNING contact_id`,
        [workspaceId, `launch${Date.now()}-${i}@example.com`],
      );
      await pool.query(`INSERT INTO contact_segment (contact_id, segment_id) VALUES ($1, $2)`, [
        c.rows[0].contact_id,
        segmentId,
      ]);
    }

    const status = opts.status ?? 'scheduled';
    const camp = await pool.query(
      `INSERT INTO campaigns (workspace_id, name, channel, template_id, segment_id, status, scheduled_at)
       VALUES ($1, 'c', 'email', gen_random_uuid(), $2, $3::campaign_status,
               ${opts.scheduledAt ? `NOW() + INTERVAL '${opts.scheduledAt}'` : 'NULL'})
       RETURNING campaign_id`,
      [workspaceId, segmentId, status],
    );

    return { campaignId: camp.rows[0].campaign_id, workspaceId, segmentId, channel: 'email', status };
  }

  async function campaignRow(campaignId: string) {
    const r = await pool.query(
      `SELECT status, estimated_cost::text FROM campaigns WHERE campaign_id = $1`,
      [campaignId],
    );
    return r.rows[0];
  }

  test('findDueCampaigns returns past-due scheduled campaigns only', async () => {
    const due = await makeFixture({ balance: '1', contacts: 1, scheduledAt: '-1 hour' });
    const future = await makeFixture({ balance: '1', contacts: 1, scheduledAt: '+1 hour' });
    const draft = await makeFixture({ balance: '1', contacts: 1, status: 'draft', scheduledAt: '-1 hour' });

    const found = await findDueCampaigns(pool, 1000);
    const ids = found.map((c) => c.campaignId);

    expect(ids).toContain(due.campaignId);
    expect(ids).not.toContain(future.campaignId);
    expect(ids).not.toContain(draft.campaignId);
  });

  test('launch claims, authorizes the hold, stamps cost, and queues once', async () => {
    const campaign = await makeFixture({ balance: '1.000000', contacts: 3, scheduledAt: '-1 hour' });
    const queued: unknown[] = [];

    const result = await launchCampaign(pool, campaign, async (p) => {
      queued.push(p);
    });

    expect(result).toEqual({ ok: true, estimatedCost: '0.030000', recipients: 3 });
    expect(queued).toEqual([{ campaignId: campaign.campaignId, workspaceId: campaign.workspaceId }]);
    expect(await campaignRow(campaign.campaignId)).toEqual({ status: 'sending', estimated_cost: '0.030000' });

    const bal = await pool.query(
      `SELECT available_credits::text AS a, hold_credits::text AS h FROM account_balances WHERE workspace_id = $1`,
      [campaign.workspaceId],
    );
    expect(bal.rows[0]).toEqual({ a: '0.970000', h: '0.030000' });
  });

  test('concurrent launches: exactly one wins the claim', async () => {
    const campaign = await makeFixture({ balance: '1', contacts: 2, scheduledAt: '-1 hour' });
    let sends = 0;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        launchCampaign(pool, campaign, async () => {
          sends++;
        }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'already_claimed')).toHaveLength(3);
    expect(sends).toBe(1);
  });

  test('insufficient funds reverts the claim and queues nothing', async () => {
    const campaign = await makeFixture({ balance: '0.010000', contacts: 5, scheduledAt: '-1 hour' });
    let sends = 0;

    const result = await launchCampaign(pool, campaign, async () => {
      sends++;
    });

    expect(result).toMatchObject({ ok: false, reason: 'insufficient_funds', recipients: 5 });
    expect(sends).toBe(0);
    expect((await campaignRow(campaign.campaignId)).status).toBe('scheduled'); // reverted
  });

  test('queue failure reverts the claim so the next tick retries', async () => {
    const campaign = await makeFixture({ balance: '1', contacts: 1, scheduledAt: '-1 hour' });

    await expect(
      launchCampaign(pool, campaign, async () => {
        throw new Error('SQS unavailable');
      }),
    ).rejects.toThrow('SQS unavailable');

    expect((await campaignRow(campaign.campaignId)).status).toBe('scheduled');
  });
});
