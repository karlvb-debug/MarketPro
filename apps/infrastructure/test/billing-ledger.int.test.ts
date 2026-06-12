// Integration tests for the billing ledger against a real Postgres.
// Skipped unless TEST_DATABASE_URL is set (CI provides a postgres service;
// locally: postgresql://marketpro:marketpro@localhost:5432/marketpro_test).

import { Pool } from 'pg';
import { runMigrations } from '../lambda/lib/migrate';
import {
  authorizeCampaignFunds,
  getChannelPrice,
  multiplyPrice,
  releaseStaleAuthorizations,
  settleMessageCharge,
  DEFAULT_CHANNEL_PRICES,
} from '../lambda/lib/billing';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('billing ledger (Postgres integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    await runMigrations(pool); // the real migration path
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeWorkspace(available: string): Promise<string> {
    const ws = await pool.query(
      `INSERT INTO workspaces (name) VALUES ('test') RETURNING workspace_id`,
    );
    const workspaceId = ws.rows[0].workspace_id;
    await pool.query(
      `INSERT INTO account_balances (workspace_id, available_credits, hold_credits)
       VALUES ($1, $2, 0)`,
      [workspaceId, available],
    );
    return workspaceId;
  }

  async function balanceOf(workspaceId: string): Promise<{ available: string; hold: string }> {
    const r = await pool.query(
      `SELECT available_credits::text AS available, hold_credits::text AS hold
         FROM account_balances WHERE workspace_id = $1`,
      [workspaceId],
    );
    return r.rows[0];
  }

  async function ledgerRows(workspaceId: string) {
    const r = await pool.query(
      `SELECT type, amount::text, status, reference_id FROM transactions_ledger
        WHERE workspace_id = $1 ORDER BY created_at`,
      [workspaceId],
    );
    return r.rows;
  }

  describe('pricing', () => {
    test('falls back to platform defaults without settings row', async () => {
      const ws = await makeWorkspace('10');
      expect(await getChannelPrice(pool, ws, 'email')).toBe(DEFAULT_CHANNEL_PRICES.email);
    });

    test('uses per-workspace override when set', async () => {
      const ws = await makeWorkspace('10');
      await pool.query(
        `INSERT INTO workspace_settings (workspace_id, price_per_sms) VALUES ($1, 0.025)`,
        [ws],
      );
      expect(await getChannelPrice(pool, ws, 'sms')).toBe('0.025000');
      // unset channels on the same row still fall back
      expect(await getChannelPrice(pool, ws, 'voice')).toBe(DEFAULT_CHANNEL_PRICES.voice);
    });

    test('multiplyPrice does exact numeric math', async () => {
      expect(await multiplyPrice(pool, '0.010000', 3)).toBe('0.030000');
      expect(await multiplyPrice(pool, '0.000001', 1000000)).toBe('1.000000');
    });
  });

  describe('authorization holds', () => {
    test('moves available -> hold and writes a PENDING ledger row', async () => {
      const ws = await makeWorkspace('5.000000');
      const result = await authorizeCampaignFunds(pool, ws, 'camp-a', '3.000000');

      expect(result.ok).toBe(true);
      expect(await balanceOf(ws)).toEqual({ available: '2.000000', hold: '3.000000' });
      expect(await ledgerRows(ws)).toEqual([
        { type: 'AUTHORIZATION', amount: '3.000000', status: 'PENDING', reference_id: 'camp-a' },
      ]);
    });

    test('rejects when available credits are insufficient — balance untouched', async () => {
      const ws = await makeWorkspace('1.000000');
      const result = await authorizeCampaignFunds(pool, ws, 'camp-b', '2.500000');

      expect(result).toEqual({
        ok: false,
        reason: 'insufficient_funds',
        required: '2.500000',
        available: '1.000000',
      });
      expect(await balanceOf(ws)).toEqual({ available: '1.000000', hold: '0.000000' });
      expect(await ledgerRows(ws)).toEqual([]);
    });

    test('rejects when the workspace has no balance row at all', async () => {
      const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('t') RETURNING workspace_id`);
      const result = await authorizeCampaignFunds(pool, ws.rows[0].workspace_id, 'camp-c', '0.010000');
      expect(result.ok).toBe(false);
    });

    test('concurrent authorizations can never overdraw', async () => {
      const ws = await makeWorkspace('1.000000');
      // Five concurrent holds of 0.60 against a balance of 1.00: exactly one can win.
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          authorizeCampaignFunds(pool, ws, `camp-conc-${i}`, '0.600000'),
        ),
      );

      const wins = results.filter((r) => r.ok);
      expect(wins).toHaveLength(1);
      expect(await balanceOf(ws)).toEqual({ available: '0.400000', hold: '0.600000' });
    });
  });

  describe('settlement', () => {
    test('capture consumes the hold', async () => {
      const ws = await makeWorkspace('1.000000');
      await authorizeCampaignFunds(pool, ws, 'camp-d', '0.030000');

      await settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-d', cost: '0.010000', kind: 'capture' });
      await settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-d', cost: '0.010000', kind: 'capture' });

      expect(await balanceOf(ws)).toEqual({ available: '0.970000', hold: '0.010000' });
      const rows = await ledgerRows(ws);
      expect(rows.filter((r) => r.type === 'CAPTURE')).toHaveLength(2);
    });

    test('refund returns the hold to available', async () => {
      const ws = await makeWorkspace('1.000000');
      await authorizeCampaignFunds(pool, ws, 'camp-e', '0.020000');

      await settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-e', cost: '0.010000', kind: 'refund' });

      expect(await balanceOf(ws)).toEqual({ available: '0.990000', hold: '0.010000' });
    });

    test('a late event after the hold is gone clamps at zero instead of corrupting', async () => {
      const ws = await makeWorkspace('1.000000');
      // No authorization at all — hold is 0
      await settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-f', cost: '0.010000', kind: 'capture' });
      expect(await balanceOf(ws)).toEqual({ available: '1.000000', hold: '0.000000' });
    });

    test('concurrent settlements serialize without losing updates', async () => {
      const ws = await makeWorkspace('1.000000');
      await authorizeCampaignFunds(pool, ws, 'camp-g', '0.500000');

      await Promise.all(
        Array.from({ length: 10 }, () =>
          settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-g', cost: '0.010000', kind: 'capture' }),
        ),
      );

      expect(await balanceOf(ws)).toEqual({ available: '0.500000', hold: '0.400000' });
    });
  });

  describe('reconciliation sweep', () => {
    async function backdate(workspaceId: string, campaignId: string, hours: number) {
      await pool.query(
        `UPDATE transactions_ledger SET created_at = NOW() - ($3::int * INTERVAL '1 hour')
          WHERE workspace_id = $1 AND reference_id = $2 AND type = 'AUTHORIZATION'`,
        [workspaceId, campaignId, hours],
      );
    }

    test('releases the unsettled remainder of stale holds', async () => {
      const ws = await makeWorkspace('1.000000');
      await authorizeCampaignFunds(pool, ws, 'camp-h', '0.100000');
      // 3 of 10 messages delivered; 7 receipts never arrived
      await settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-h', cost: '0.010000', kind: 'capture' });
      await settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-h', cost: '0.010000', kind: 'capture' });
      await settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-h', cost: '0.010000', kind: 'capture' });
      await backdate(ws, 'camp-h', 100);

      const summary = await releaseStaleAuthorizations(pool, 72);

      expect(summary.swept).toBeGreaterThanOrEqual(1);
      expect(await balanceOf(ws)).toEqual({ available: '0.970000', hold: '0.000000' });
      const rows = await ledgerRows(ws);
      expect(rows.find((r) => r.type === 'AUTHORIZATION')!.status).toBe('RECONCILED');
      expect(rows.find((r) => r.status === 'RECONCILED' && r.type === 'REFUND')!.amount).toBe('0.070000');
    });

    test('does not touch fresh authorizations', async () => {
      const ws = await makeWorkspace('1.000000');
      await authorizeCampaignFunds(pool, ws, 'camp-i', '0.100000');

      await releaseStaleAuthorizations(pool, 72);

      expect(await balanceOf(ws)).toEqual({ available: '0.900000', hold: '0.100000' });
      const rows = await ledgerRows(ws);
      expect(rows.find((r) => r.type === 'AUTHORIZATION')!.status).toBe('PENDING');
    });

    test('a second sweep is a no-op (RECONCILED rows are never re-released)', async () => {
      const ws = await makeWorkspace('1.000000');
      await authorizeCampaignFunds(pool, ws, 'camp-j', '0.100000');
      await backdate(ws, 'camp-j', 100);

      await releaseStaleAuthorizations(pool, 72);
      const after = await balanceOf(ws);
      await releaseStaleAuthorizations(pool, 72);

      expect(await balanceOf(ws)).toEqual(after);
      expect(after).toEqual({ available: '1.000000', hold: '0.000000' });
    });

    test('fully settled stale holds release nothing', async () => {
      const ws = await makeWorkspace('1.000000');
      await authorizeCampaignFunds(pool, ws, 'camp-k', '0.020000');
      await settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-k', cost: '0.010000', kind: 'capture' });
      await settleMessageCharge(pool, { workspaceId: ws, campaignId: 'camp-k', cost: '0.010000', kind: 'capture' });
      await backdate(ws, 'camp-k', 100);

      await releaseStaleAuthorizations(pool, 72);

      expect(await balanceOf(ws)).toEqual({ available: '0.980000', hold: '0.000000' });
      // No REFUND row created for a zero remainder
      const rows = await ledgerRows(ws);
      expect(rows.filter((r) => r.type === 'REFUND')).toHaveLength(0);
    });
  });
});
