// ============================================
// Campaign launch — the one path from 'a campaign should send now' to
// 'a dispatch message is on the channel queue', shared by the campaigns
// API (immediate sends) and the scheduled-dispatch poller.
//
// Sequence (each step safe under concurrency):
//   1. CLAIM    conditional status -> 'sending' (loser of a race gets 0 rows)
//   2. ESTIMATE eligible recipients x per-workspace channel price
//   3. AUTHORIZE hold via the billing ledger (402-style failure reverts claim)
//   4. QUEUE    SQS dispatch message (failure reverts claim, caller retries)
// ============================================

import { Pool } from 'pg';
import { authorizeCampaignFunds, getChannelPrice, multiplyPrice, Channel } from './billing';

export interface LaunchableCampaign {
  campaignId: string;
  workspaceId: string;
  segmentId: string;
  channel: Channel;
  status: string;
}

export type LaunchResult =
  | { ok: true; estimatedCost: string; recipients: number }
  | { ok: false; reason: 'already_claimed' }
  | { ok: false; reason: 'insufficient_funds'; required: string; available: string; recipients: number };

/** Contacts in the segment that are active and reachable on the channel. */
export async function countEligibleRecipients(
  pool: Pool,
  segmentId: string,
  channel: Channel,
): Promise<number> {
  const recipientColumn = channel === 'email' ? 'c.email' : 'c.phone';
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM contact_segment cs
       JOIN contacts c ON c.contact_id = cs.contact_id
      WHERE cs.segment_id = $1 AND c.status = 'active' AND ${recipientColumn} IS NOT NULL`,
    [segmentId],
  );
  return result.rows[0].count;
}

/**
 * Claim, authorize, and queue one campaign.
 * `sendToQueue` is injected so the poller/API own the SQS client and tests
 * can fake it. On any failure after the claim, the claim is reverted to the
 * campaign's previous status so callers can retry or surface the error.
 */
export async function launchCampaign(
  pool: Pool,
  campaign: LaunchableCampaign,
  sendToQueue: (payload: { campaignId: string; workspaceId: string }) => Promise<void>,
): Promise<LaunchResult> {
  // 1. CLAIM — only one caller can move the campaign into 'sending'
  const claimed = await pool.query(
    `UPDATE campaigns SET status = 'sending'
      WHERE campaign_id = $1 AND workspace_id = $2 AND status IN ('draft', 'scheduled')
      RETURNING campaign_id`,
    [campaign.campaignId, campaign.workspaceId],
  );
  if (claimed.rows.length === 0) {
    return { ok: false, reason: 'already_claimed' };
  }

  const revertClaim = () =>
    pool.query(`UPDATE campaigns SET status = $2 WHERE campaign_id = $1`, [
      campaign.campaignId,
      campaign.status,
    ]);

  try {
    // 2. ESTIMATE
    const recipients = await countEligibleRecipients(pool, campaign.segmentId, campaign.channel);
    const price = await getChannelPrice(pool, campaign.workspaceId, campaign.channel);
    const estimatedCost = await multiplyPrice(pool, price, recipients);

    // 3. AUTHORIZE (zero-cost sends skip the hold)
    if (parseFloat(estimatedCost) > 0) {
      const auth = await authorizeCampaignFunds(
        pool,
        campaign.workspaceId,
        campaign.campaignId,
        estimatedCost,
      );
      if (!auth.ok) {
        await revertClaim();
        return {
          ok: false,
          reason: 'insufficient_funds',
          required: auth.required,
          available: auth.available,
          recipients,
        };
      }
    }

    await pool.query(`UPDATE campaigns SET estimated_cost = $2 WHERE campaign_id = $1`, [
      campaign.campaignId,
      estimatedCost,
    ]);

    // 4. QUEUE
    await sendToQueue({ campaignId: campaign.campaignId, workspaceId: campaign.workspaceId });

    return { ok: true, estimatedCost, recipients };
  } catch (err) {
    // Authorization hold (if placed) is released by nightly reconciliation;
    // the claim revert lets the next attempt run.
    await revertClaim().catch(() => undefined);
    throw err;
  }
}

/** Campaigns whose schedule has come due, ready to be launched. */
export async function findDueCampaigns(pool: Pool, limit = 50): Promise<LaunchableCampaign[]> {
  const result = await pool.query(
    `SELECT campaign_id, workspace_id, segment_id, channel, status
       FROM campaigns
      WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
      ORDER BY scheduled_at
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => ({
    campaignId: r.campaign_id,
    workspaceId: r.workspace_id,
    segmentId: r.segment_id,
    channel: r.channel,
    status: r.status,
  }));
}

/** Park a campaign that cannot launch (e.g. insufficient funds) for operator attention. */
export async function pauseCampaign(pool: Pool, campaignId: string): Promise<void> {
  await pool.query(`UPDATE campaigns SET status = 'paused' WHERE campaign_id = $1`, [campaignId]);
}
