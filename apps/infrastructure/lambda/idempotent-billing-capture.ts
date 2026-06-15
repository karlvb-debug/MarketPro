import { SQSEvent, SQSBatchResponse } from 'aws-lambda';

// ============================================
// Idempotent Billing Capture Lambda
// Triggered by the SQS Billing Queue to process provider delivery/bounce
// events. DynamoDB provides event-level idempotency; the ledger update is
// race-safe via lambda/lib/billing.ts (row locks + clamped arithmetic).
//
// CAPTURE on delivery: the per-message cost stamped on the campaign_messages
// claim row is consumed from the campaign's authorization hold.
// REFUND on bounce/complaint/reject: the cost returns to available credits
// and the recipient is suppressed.
// 'send' events are intentionally ignored — capturing on send AND delivery
// would double-charge.
// ============================================

import { getPool } from './lib/db';
import { getChannelPrice, settleMessageCharge, Channel } from './lib/billing';
import { recordEngagement } from './lib/engagement';
import { Logger } from './lib/logger';

export interface BillingEvent {
  providerMessageId: string;
  workspaceId: string;
  eventType: string;
  recipientEmail: string | null;
}

/** Parse an SNS-wrapped provider event from the billing queue. Pure. */
export function parseBillingEvent(body: string): BillingEvent | null {
  let messageBody: { Message?: string };
  try {
    messageBody = JSON.parse(body);
  } catch {
    return null;
  }
  let details: {
    mail?: { messageId?: string; destination?: string[] };
    messageId?: string;
    tags?: { workspace_id?: string[] };
    eventType?: string;
    status?: string;
  };
  try {
    details = JSON.parse(messageBody.Message || '{}');
  } catch {
    return null;
  }

  const providerMessageId = details.mail?.messageId || details.messageId;
  const workspaceId = details.tags?.workspace_id?.[0];
  const eventType = (details.eventType || details.status || '').toLowerCase();
  if (!providerMessageId || !workspaceId || !eventType) return null;

  return {
    providerMessageId,
    workspaceId,
    eventType,
    recipientEmail: details.mail?.destination?.[0] ?? null,
  };
}

/** capture = charge sticks; refund = money back; null = not billable. */
export function settlementKindOf(eventType: string): 'capture' | 'refund' | null {
  if (eventType === 'delivery' || eventType === 'delivered') return 'capture';
  if (eventType === 'bounce' || eventType === 'complaint' || eventType === 'reject') return 'refund';
  return null;
}

/** Engagement rollup bucket for an event type, or null if not engagement. */
export function engagementKindOf(eventType: string): 'delivered' | 'opened' | 'clicked' | null {
  if (eventType === 'delivery' || eventType === 'delivered') return 'delivered';
  if (eventType === 'open' || eventType === 'opened') return 'opened';
  if (eventType === 'click' || eventType === 'clicked') return 'clicked';
  return null;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const logger = new Logger({ handler: 'idempotent-billing-capture' });
  const batchItemFailures: { itemIdentifier: string }[] = [];

  const idempotencyTable = process.env.IDEMPOTENCY_TABLE;
  const pool = await getPool();

  for (const record of event.Records) {
    try {
      const billingEvent = parseBillingEvent(record.body);
      if (!billingEvent) {
        logger.warn('Unparseable billing event, skipping', { sqsMessageId: record.messageId });
        continue;
      }

      const { providerMessageId, workspaceId, eventType, recipientEmail } = billingEvent;
      const kind = settlementKindOf(eventType);
      const engagement = engagementKindOf(eventType);
      if (!kind && !engagement) {
        logger.info(`Ignoring event type '${eventType}'`, { providerMessageId });
        continue;
      }

      const eventLogger = logger.with({ providerMessageId, workspaceId, eventType });

      // 1. Idempotency — keyed on message AND event type so a bounce that
      // follows a delivery for the same message is still processed.
      if (idempotencyTable) {
        const { DynamoDBClient, GetItemCommand, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
        const ddb = new DynamoDBClient({});
        const idempotencyKey = `${providerMessageId}:${eventType}`;

        const existing = await ddb.send(new GetItemCommand({
          TableName: idempotencyTable,
          Key: { Message_ID: { S: idempotencyKey } },
        }));
        if (existing.Item) {
          eventLogger.info('Idempotent skip: event already processed');
          continue;
        }

        const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
        await ddb.send(new PutItemCommand({
          TableName: idempotencyTable,
          Item: {
            Message_ID: { S: idempotencyKey },
            processed_at: { S: new Date().toISOString() },
            ttl: { N: String(ttl) },
          },
        }));
      }

      // 2. Resolve the dispatch claim row — source of campaign + actual cost
      const messageRow = await pool.query(
        `SELECT message_id, campaign_id, channel, cost::text AS cost
           FROM campaign_messages
          WHERE provider_message_id = $1 AND workspace_id = $2`,
        [providerMessageId, workspaceId],
      );
      if (messageRow.rows.length === 0) {
        eventLogger.warn('No campaign_messages row for provider message — skipping billing');
        continue;
      }
      const { message_id, campaign_id, channel, cost } = messageRow.rows[0];

      // 3. Settle billable events against the campaign's authorization hold
      if (kind) {
        const effectiveCost: string =
          cost ?? (await getChannelPrice(pool, workspaceId, channel as Channel));
        await settleMessageCharge(pool, {
          workspaceId,
          campaignId: campaign_id,
          cost: effectiveCost,
          kind,
        });

        if (kind === 'refund') {
          await pool.query(
            `UPDATE campaign_messages SET status = 'bounced', error_code = $2 WHERE message_id = $1`,
            [message_id, eventType],
          );
        }
        eventLogger.info(`Billing ${kind} of ${effectiveCost} processed`);
      }

      // 4. Record engagement rollup (delivered/opened/clicked). Idempotent on
      // the message's timestamp column, so duplicate events count once. Also
      // advances the message status without regressing a more-engaged state.
      if (engagement) {
        await recordEngagement(pool, message_id, engagement);
        const rank: Record<string, number> = { sent: 1, delivered: 2, opened: 3, clicked: 4 };
        const newStatus = engagement; // 'delivered' | 'opened' | 'clicked'
        await pool.query(
          `UPDATE campaign_messages
              SET status = $2
            WHERE message_id = $1
              AND COALESCE(($3::jsonb ->> status::text)::int, 0) < $4`,
          [message_id, newStatus, JSON.stringify(rank), rank[newStatus]],
        );
        eventLogger.info(`Engagement '${engagement}' recorded`);
      }

      // 5. Suppress bounced/complained recipients
      if ((eventType === 'bounce' || eventType === 'complaint') && recipientEmail) {
        const crypto = await import('crypto');
        const emailHash = crypto.createHash('sha256').update(recipientEmail.toLowerCase()).digest('hex');
        await pool.query(
          `INSERT INTO suppression_list (workspace_id, email_hash, reason)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [workspaceId, emailHash, eventType],
        );
      }
    } catch (err) {
      logger.error('Failed to process billing record — returning to queue', err, {
        sqsMessageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
