// ============================================
// Engagement rollups — denormalized per-contact counters on `contacts`,
// maintained as a campaign_messages row first reaches each state.
//
// Idempotency is structural: each increment is gated on the message's
// timestamp column being NULL (delivered_at / opened_at / clicked_at), so a
// redelivered or duplicated provider event counts exactly once — no reliance
// on the DynamoDB store. total_sent is bumped by dispatch when a recipient is
// first marked sent (claims already guarantee once-per-recipient).
// ============================================

import { Pool } from 'pg';

/** Pool or PoolClient — both expose a compatible query(). */
type Queryable = Pick<Pool, 'query'>;

type Stamp = 'delivered' | 'opened' | 'clicked';

const STAMP_COLUMN: Record<Stamp, string> = {
  delivered: 'delivered_at',
  opened: 'opened_at',
  clicked: 'clicked_at',
};

const COUNTER_COLUMN: Record<Stamp, string> = {
  delivered: 'total_delivered',
  opened: 'total_opened',
  clicked: 'total_clicked',
};

/**
 * Record a delivery/open/click against a message and, only if this is the
 * first time that state is reached for the message, bump the owning
 * contact's rollup. Opens and clicks also advance last_engaged_at.
 *
 * Returns true if the rollup was incremented (i.e. first time), false if it
 * was already recorded. Runs as a single atomic statement.
 */
export async function recordEngagement(pool: Pool, messageId: string, stamp: Stamp): Promise<boolean> {
  const tsCol = STAMP_COLUMN[stamp];
  const counterCol = COUNTER_COLUMN[stamp];
  // Engagement (open/click) advances last_engaged_at; delivery does not.
  const engagedSet = stamp === 'delivered' ? '' : ', last_engaged_at = NOW()';

  const result = await pool.query(
    `WITH claimed AS (
       UPDATE campaign_messages
          SET ${tsCol} = NOW()
        WHERE message_id = $1 AND ${tsCol} IS NULL AND contact_id IS NOT NULL
        RETURNING contact_id
     )
     UPDATE contacts c
        SET ${counterCol} = ${counterCol} + 1${engagedSet}
       FROM claimed
      WHERE c.contact_id = claimed.contact_id`,
    [messageId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Recompute a contact's engagement rollups from campaign_messages — the
 * source of truth. Used after merge repoints message rows. Uses the same
 * definition as the 0004 backfill.
 */
export async function recomputeRollups(pool: Queryable, contactId: string): Promise<void> {
  await pool.query(
    `WITH r AS (
       SELECT
         COUNT(*) FILTER (WHERE sent_at IS NOT NULL OR status IN ('sent','delivered','opened','clicked')) AS sent,
         COUNT(*) FILTER (WHERE delivered_at IS NOT NULL OR status IN ('delivered','opened','clicked')) AS delivered,
         COUNT(*) FILTER (WHERE opened_at IS NOT NULL OR status IN ('opened','clicked')) AS opened,
         COUNT(*) FILTER (WHERE clicked_at IS NOT NULL OR status = 'clicked') AS clicked,
         MAX(sent_at) AS last_sent,
         MAX(GREATEST(opened_at, clicked_at)) AS last_engaged
       FROM campaign_messages WHERE contact_id = $1
     )
     UPDATE contacts c SET
       total_sent = COALESCE(r.sent, 0),
       total_delivered = COALESCE(r.delivered, 0),
       total_opened = COALESCE(r.opened, 0),
       total_clicked = COALESCE(r.clicked, 0),
       last_sent_at = r.last_sent,
       last_engaged_at = r.last_engaged
     FROM r WHERE c.contact_id = $1`,
    [contactId],
  );
}

/**
 * Bump total_sent / last_sent_at for the contact behind a message, gated on
 * sent_at being newly set. Called by dispatch when a recipient is marked sent.
 */
export async function recordSent(pool: Pool, messageId: string): Promise<boolean> {
  const result = await pool.query(
    `WITH claimed AS (
       UPDATE campaign_messages
          SET sent_at = COALESCE(sent_at, NOW())
        WHERE message_id = $1 AND sent_at IS NULL AND contact_id IS NOT NULL
        RETURNING contact_id
     )
     UPDATE contacts c
        SET total_sent = total_sent + 1, last_sent_at = NOW()
       FROM claimed
      WHERE c.contact_id = claimed.contact_id`,
    [messageId],
  );
  return (result.rowCount ?? 0) > 0;
}
