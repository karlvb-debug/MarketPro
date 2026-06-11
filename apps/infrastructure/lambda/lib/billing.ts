// ============================================
// Billing ledger operations — double-entry, race-safe
//
// Money model:
//   available_credits  — spendable balance (Stripe deposits land here)
//   hold_credits       — reserved for in-flight campaigns
//
// Lifecycle:
//   AUTHORIZATION (PENDING)  campaign scheduled: available -> hold
//   CAPTURE (COMPLETED)      delivery receipt:   hold is consumed
//   REFUND (COMPLETED)       bounce/complaint:   hold -> available
//   REFUND (RECONCILED)      nightly sweep:      stale remainder hold -> available
//
// All ledger rows for a campaign use reference_id = campaignId so the
// reconciliation sweep can compute the settled amount per authorization.
// ============================================

import { Pool } from 'pg';

export type Channel = 'email' | 'sms' | 'voice';

/** Platform default price per message, used when a workspace has no override. */
export const DEFAULT_CHANNEL_PRICES: Record<Channel, string> = {
  email: '0.010000',
  sms: '0.010000',
  voice: '0.010000',
};

const PRICE_COLUMNS: Record<Channel, string> = {
  email: 'price_per_email',
  sms: 'price_per_sms',
  voice: 'price_per_voice',
};

/** Per-workspace price for one message on a channel (numeric string, 6dp). */
export async function getChannelPrice(
  pool: Pool,
  workspaceId: string,
  channel: Channel,
): Promise<string> {
  const column = PRICE_COLUMNS[channel];
  const result = await pool.query(
    `SELECT ${column}::text AS price FROM workspace_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  return result.rows[0]?.price ?? DEFAULT_CHANNEL_PRICES[channel];
}

/** count x price with numeric (not float) arithmetic, as a 6dp string. */
export async function multiplyPrice(pool: Pool, price: string, count: number): Promise<string> {
  const result = await pool.query(
    `SELECT ROUND($1::numeric * $2::numeric, 6)::text AS amount`,
    [price, count],
  );
  return result.rows[0].amount;
}

export type AuthorizationResult =
  | { ok: true; amount: string }
  | { ok: false; reason: 'insufficient_funds'; required: string; available: string };

/**
 * Place an authorization hold for a campaign: available -> hold, plus a
 * PENDING ledger row. Atomic and race-safe: the conditional UPDATE only
 * succeeds when available_credits covers the amount, so two concurrent
 * authorizations can never overdraw.
 */
export async function authorizeCampaignFunds(
  pool: Pool,
  workspaceId: string,
  campaignId: string,
  amount: string,
): Promise<AuthorizationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const moved = await client.query(
      `UPDATE account_balances
         SET available_credits = available_credits - $2,
             hold_credits = hold_credits + $2,
             last_updated_at = NOW()
       WHERE workspace_id = $1 AND available_credits >= $2::numeric
       RETURNING available_credits::text`,
      [workspaceId, amount],
    );

    if (moved.rows.length === 0) {
      await client.query('ROLLBACK');
      const bal = await pool.query(
        'SELECT available_credits::text AS available FROM account_balances WHERE workspace_id = $1',
        [workspaceId],
      );
      return {
        ok: false,
        reason: 'insufficient_funds',
        required: amount,
        available: bal.rows[0]?.available ?? '0.000000',
      };
    }

    await client.query(
      `INSERT INTO transactions_ledger (workspace_id, type, amount, reference_id, status)
       VALUES ($1, 'AUTHORIZATION', $2, $3, 'PENDING')`,
      [workspaceId, amount, campaignId],
    );

    await client.query('COMMIT');
    return { ok: true, amount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Settle one message charge against the campaign's hold.
 * kind 'capture': delivery confirmed — the hold is consumed (revenue).
 * kind 'refund':  bounce/complaint — the hold returns to available.
 * hold_credits is clamped at 0 so an event arriving after reconciliation
 * already released the hold cannot violate the non-negative constraint.
 */
export async function settleMessageCharge(
  pool: Pool,
  opts: {
    workspaceId: string;
    campaignId: string;
    cost: string;
    kind: 'capture' | 'refund';
  },
): Promise<void> {
  const { workspaceId, campaignId, cost, kind } = opts;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialize concurrent settlements per workspace
    const locked = await client.query(
      'SELECT hold_credits FROM account_balances WHERE workspace_id = $1 FOR UPDATE',
      [workspaceId],
    );
    if (locked.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`No account_balances row for workspace ${workspaceId}`);
    }

    if (kind === 'capture') {
      await client.query(
        `UPDATE account_balances
           SET hold_credits = GREATEST(0, hold_credits - $2::numeric), last_updated_at = NOW()
         WHERE workspace_id = $1`,
        [workspaceId, cost],
      );
      await client.query(
        `INSERT INTO transactions_ledger (workspace_id, type, amount, reference_id, status)
         VALUES ($1, 'CAPTURE', $2, $3, 'COMPLETED')`,
        [workspaceId, cost, campaignId],
      );
    } else {
      await client.query(
        `UPDATE account_balances
           SET hold_credits = GREATEST(0, hold_credits - $2::numeric),
               available_credits = available_credits + $2::numeric,
               last_updated_at = NOW()
         WHERE workspace_id = $1`,
        [workspaceId, cost],
      );
      await client.query(
        `INSERT INTO transactions_ledger (workspace_id, type, amount, reference_id, status)
         VALUES ($1, 'REFUND', $2, $3, 'COMPLETED')`,
        [workspaceId, cost, campaignId],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface ReconciliationSummary {
  swept: number;
  releasedTotal: string;
}

/**
 * Nightly sweep: release the unsettled remainder of stale authorization
 * holds (default: older than 72h). For each PENDING authorization, the
 * settled amount is the sum of CAPTUREs and REFUNDs referencing the same
 * campaign; the rest goes back to available_credits and the authorization
 * is marked RECONCILED so it is never swept twice.
 */
export async function releaseStaleAuthorizations(
  pool: Pool,
  olderThanHours = 72,
): Promise<ReconciliationSummary> {
  const stale = await pool.query(
    `SELECT transaction_id, workspace_id, amount::text, reference_id
       FROM transactions_ledger
      WHERE type = 'AUTHORIZATION' AND status = 'PENDING'
        AND created_at < NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY created_at`,
    [olderThanHours],
  );

  let swept = 0;
  let releasedTotal = '0.000000';

  for (const auth of stale.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Re-check under lock so a concurrent sweep can't double-release
      const lockedAuth = await client.query(
        `SELECT amount::text FROM transactions_ledger
          WHERE transaction_id = $1 AND status = 'PENDING' FOR UPDATE`,
        [auth.transaction_id],
      );
      if (lockedAuth.rows.length === 0) {
        await client.query('ROLLBACK');
        continue;
      }

      await client.query(
        'SELECT 1 FROM account_balances WHERE workspace_id = $1 FOR UPDATE',
        [auth.workspace_id],
      );

      const settled = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::text AS settled
           FROM transactions_ledger
          WHERE reference_id = $1 AND type IN ('CAPTURE', 'REFUND') AND workspace_id = $2`,
        [auth.reference_id, auth.workspace_id],
      );

      const remaining = await client.query(
        `SELECT GREATEST(0, $1::numeric - $2::numeric)::numeric(15,6)::text AS remaining`,
        [lockedAuth.rows[0].amount, settled.rows[0].settled],
      );
      const release = remaining.rows[0].remaining;

      if (parseFloat(release) > 0) {
        await client.query(
          `UPDATE account_balances
             SET hold_credits = GREATEST(0, hold_credits - $2::numeric),
                 available_credits = available_credits + $2::numeric,
                 last_updated_at = NOW()
           WHERE workspace_id = $1`,
          [auth.workspace_id, release],
        );
        await client.query(
          `INSERT INTO transactions_ledger (workspace_id, type, amount, reference_id, status)
           VALUES ($1, 'REFUND', $2, $3, 'RECONCILED')`,
          [auth.workspace_id, release, auth.reference_id],
        );
      }

      await client.query(
        `UPDATE transactions_ledger SET status = 'RECONCILED' WHERE transaction_id = $1`,
        [auth.transaction_id],
      );

      await client.query('COMMIT');
      swept++;
      const sum = await pool.query(
        `SELECT ROUND($1::numeric + $2::numeric, 6)::text AS total`,
        [releasedTotal, release],
      );
      releasedTotal = sum.rows[0].total;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { swept, releasedTotal };
}
